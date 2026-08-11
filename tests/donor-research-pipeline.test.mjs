import assert from "node:assert/strict";
import { extractDomain, normalizeUrl } from "../lib/research/url-normalize.ts";
import { assertFetchAllowed, isNeverFetchDomain, NEVER_FETCH_DOMAINS, suggestSourceTier } from "../lib/research/source-tier.ts";
import { computeFindingFingerprint } from "../lib/research/fingerprint.ts";
import { normalizeOrganizationName } from "../lib/research/organization.ts";
import { classifyEvidenceCategory } from "../lib/research/classification.ts";
import { planFinding, planSharedAffiliations, resolveFindingStatus } from "../lib/research/pipeline.ts";

// ---- URL normalization: same page, different noise, must dedupe. ----
assert.equal(normalizeUrl("https://Example.org/Page/?utm_source=x&b=2&a=1"), normalizeUrl("https://example.org/Page?b=2&a=1"));
assert.notEqual(normalizeUrl("https://example.org/Page"), normalizeUrl("https://example.org/page"), "path case is preserved -- only host is case-folded");
assert.equal(extractDomain("https://WWW.Example.org/x"), "www.example.org");

// ---- LinkedIn safety: NEVER_FETCH_DOMAINS blocks the exact domains plus subdomains, nothing else. ----
assert.deepEqual(NEVER_FETCH_DOMAINS, ["linkedin.com", "www.linkedin.com"]);
for (const domain of ["linkedin.com", "www.linkedin.com", "mobile.linkedin.com", "LINKEDIN.COM"]) assert.equal(isNeverFetchDomain(domain), true, domain);
assert.equal(isNeverFetchDomain("example.org"), false);
assert.equal(isNeverFetchDomain("notlinkedin.com"), false, "must not match on substring, only exact host or subdomain");
assert.throws(() => assertFetchAllowed("https://www.linkedin.com/in/example"), /Refusing to fetch/);
assert.throws(() => assertFetchAllowed("https://linkedin.com/company/example"), /Refusing to fetch/);
assert.doesNotThrow(() => assertFetchAllowed("https://example.org/leadership"));
assert.equal(suggestSourceTier("linkedin.com"), "public_search_result");
assert.equal(suggestSourceTier("example.org"), undefined, "unknown domains get no tier suggestion -- the fundraiser must choose");

// ---- Organization normalization: exact-match only, no fuzzy matching. ----
assert.equal(normalizeOrganizationName("The Example Foundation, Inc."), normalizeOrganizationName("example foundation inc"));
assert.notEqual(normalizeOrganizationName("Example Foundation"), normalizeOrganizationName("Example Foundation of New York"), "genuinely different names never collapse into the same key");

// ---- Rule-based classification: no LLM, deterministic keyword rules, unsupported/unclear claims fall to notes_ambiguities rather than being guessed into a section. ----
assert.equal(classifyEvidenceCategory("Jane Doe Named CEO of Example Holdings", ""), "professional");
assert.equal(classifyEvidenceCategory("Jane Doe joins board of Example Foundation as trustee", ""), "boards_affiliations");
assert.equal(classifyEvidenceCategory("Jane Doe honored as gala sponsor", ""), "public_philanthropy");
assert.equal(classifyEvidenceCategory("Local news profile: Jane Doe", ""), "recent_mentions");
assert.equal(classifyEvidenceCategory("Jane Doe's favorite recipe for pie", ""), "notes_ambiguities", "an unsupported/unclear claim is never forced into a confident category");

// ---- Fingerprint: deterministic, and recomputable from a finding's own stored columns alone (category, claim, relatedDonorId) -- required by donor-merge reconciliation, which has no source to look up. ----
const fpA = computeFindingFingerprint({ category: "professional", claim: "CEO, Example Holdings" });
const fpB = computeFindingFingerprint({ category: "professional", claim: "CEO, Example Holdings" });
assert.equal(fpA, fpB);
assert.notEqual(fpA, computeFindingFingerprint({ category: "boards_affiliations", claim: "CEO, Example Holdings" }), "category is part of identity");
assert.notEqual(
  computeFindingFingerprint({ category: "possible_connections", claim: "Shared public affiliation with Example Foundation", relatedDonorId: "donor-b" }),
  computeFindingFingerprint({ category: "possible_connections", claim: "Shared public affiliation with Example Foundation", relatedDonorId: "donor-c" }),
  "relatedDonorId distinguishes otherwise-identical connection claims",
);

// ---- Tier gating: Professional/Boards claims cannot become "current" on Tier 5 (search-result-only) evidence -- Public Philanthropy and Recent Mentions are not gated the same way. ----
assert.equal(resolveFindingStatus("professional", "public_search_result"), "unverified");
assert.equal(resolveFindingStatus("boards_affiliations", "public_search_result"), "unverified");
assert.equal(resolveFindingStatus("professional", "primary_institutional"), "current");
assert.equal(resolveFindingStatus("public_philanthropy", "public_search_result"), "current");

// ---- planFinding: dedupe identical, supersede same-org role changes, never collapse unrelated facts in the same category, never guess a supersession without an organization signal. ----
{
  const existing = [];
  const first = planFinding({ category: "professional", claim: "CEO, Example Holdings", sourceTier: "primary_institutional", organizationNormalized: "example holdings", existingActiveFindings: existing });
  assert.equal(first.action, "insert");
  existing.push({ id: "f1", fingerprint: first.fingerprint, category: "professional", organizationNormalized: "example holdings" });

  const reused = planFinding({ category: "professional", claim: "CEO, Example Holdings", sourceTier: "primary_institutional", organizationNormalized: "example holdings", existingActiveFindings: existing });
  assert.deepEqual(reused, { action: "reuse", fingerprint: first.fingerprint, status: "current", existingFindingId: "f1" });

  const changed = planFinding({ category: "professional", claim: "Chairman, Example Holdings", sourceTier: "primary_institutional", organizationNormalized: "example holdings", existingActiveFindings: existing });
  assert.equal(changed.action, "supersede-and-insert");
  assert.equal(changed.supersedesFindingId, "f1");

  const independent = planFinding({ category: "professional", claim: "Advisor, Other Company", sourceTier: "primary_institutional", organizationNormalized: "other company", existingActiveFindings: existing });
  assert.equal(independent.action, "insert", "a second, unrelated professional role never supersedes the first");

  const noOrgSignal = planFinding({ category: "professional", claim: "Something new", sourceTier: "primary_institutional", organizationNormalized: null, existingActiveFindings: existing });
  assert.equal(noOrgSignal.action, "insert", "without an organization to match on, never guess a supersession");
}

// ---- Shared Public Affiliations: exact-match organization overlap produces a symmetric pair, wording never implies friendship/relationship/influence/closeness. ----
{
  const connections = planSharedAffiliations({ donorId: "A", organizationDisplayName: "Example Foundation", organizationNormalized: "example foundation", otherDonorIds: ["B"] });
  assert.equal(connections.length, 2);
  const forbidden = /\b(friend|friendship|relationship|close|closeness|influence|influential|know each other|acquainted)\b/i;
  for (const connection of connections) {
    assert.doesNotMatch(connection.claim, forbidden);
    assert.match(connection.claim, /shared public affiliation/i);
  }
  assert.deepEqual(connections.map((c) => [c.donorId, c.relatedDonorId]), [["A", "B"], ["B", "A"]]);
}

process.stdout.write("Donor research pipeline checks passed.\n");
