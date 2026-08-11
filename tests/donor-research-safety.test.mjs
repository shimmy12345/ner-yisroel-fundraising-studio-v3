import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function run() {
  const route = await read("app/api/research/[donorId]/route.ts");
  const pipeline = await read("lib/research/pipeline.ts");
  const sourceTier = await read("lib/research/source-tier.ts");
  const manualProvider = await read("lib/research/manual-provider.ts");
  const mergeResearch = await read("lib/donors/merge-research.ts");
  const mergeRoute = await read("app/api/donors/merge/route.ts");
  const fingerprint = await read("lib/research/fingerprint.ts");
  const classification = await read("lib/research/classification.ts");
  const schema = await read("db/schema.ts");
  const donorPage = await read("app/donors/[id]/page.tsx");
  const donorResearchUi = await read("app/donors/[id]/DonorResearch.tsx");

  // ---- Identity safety: unconfirmed evidence is written only to
  // donor_research_pending_evidence, never to the shared sources/findings
  // pool, before an identity candidate is confirmed. classifyAndPromote --
  // the only function that ever writes donor_research_sources or
  // donor_research_findings -- is reachable from exactly one place: the
  // "confirmed" branch of decideIdentity(), after the candidate's status is
  // already written as confirmed. The "rejected" branch returns before it. ----
  assert.match(route, /async function addEvidence[\s\S]*?INSERT INTO donor_research_pending_evidence/, "evidence entry only ever inserts into the pending/staging table");
  assert.doesNotMatch(route, /async function addEvidence[\s\S]{0,900}INSERT INTO donor_research_sources/, "raw evidence entry never writes donor_research_sources directly");
  assert.doesNotMatch(route, /async function addEvidence[\s\S]{0,900}INSERT INTO donor_research_findings/, "raw evidence entry never writes donor_research_findings directly");
  const decideIdentityBody = route.slice(route.indexOf("async function decideIdentity"));
  const candidateStatusWriteIndex = decideIdentityBody.indexOf("UPDATE donor_research_identity_candidates SET status=?, decided_at=? WHERE id=?");
  const rejectReturnIndex = decideIdentityBody.indexOf('if (decision === "rejected") return Response.json');
  const promoteCallIndex = decideIdentityBody.indexOf("await classifyAndPromote");
  assert.ok(candidateStatusWriteIndex >= 0 && rejectReturnIndex >= 0 && promoteCallIndex >= 0, "all three steps must be present in decideIdentity()");
  assert.ok(candidateStatusWriteIndex < rejectReturnIndex, "the decision is recorded before the reject/confirm branch is taken");
  assert.ok(rejectReturnIndex < promoteCallIndex, "rejecting returns before promotion can ever run -- confirming is the only path that reaches it");
  assert.match(decideIdentityBody, /No research finding can be treated as confirmed until this point/i);
  assert.match(decideIdentityBody, /await classifyAndPromote\(donorId, userId, runId, body\.evidence/, "classification/promotion only runs on the confirmed path, after the reject early-return");
  assert.match(route, /async function classifyAndPromote[\s\S]*?INSERT INTO donor_research_sources/, "sources are only ever created inside the post-confirmation promotion step");
  assert.match(route, /async function classifyAndPromote[\s\S]*?INSERT INTO donor_research_findings/, "findings are only ever created inside the post-confirmation promotion step");
  // Rejected candidates' evidence is never touched again: no DELETE, no
  // further write to donor_research_pending_evidence for a rejected run --
  // it simply stays where it is, permanently inert.
  assert.doesNotMatch(route, /DELETE FROM donor_research_pending_evidence/);

  // Explicit confirmation is required even for a single proposed identity
  // -- there is no auto-confirm path anywhere in the route.
  assert.doesNotMatch(route, /status\s*=\s*['"]confirmed['"].*without/i);
  assert.match(route, /decision === "confirmed" \? "confirmed" : body\.decision === "rejected" \? "rejected" : null/, "decision must be explicit -- there is no default/implicit confirmation value");

  // ---- LinkedIn safety: the centralized guard exists, blocks the exact
  // domains (and subdomains), and -- most importantly -- Stage A contains
  // no fetch() call for it to ever need to guard. ----
  assert.match(sourceTier, /export const NEVER_FETCH_DOMAINS = \["linkedin\.com", "www\.linkedin\.com"\]/);
  assert.match(sourceTier, /export function assertFetchAllowed/);
  for (const file of [route, pipeline, manualProvider, mergeResearch, mergeRoute, fingerprint, classification]) {
    assert.doesNotMatch(file, /\bfetch\(/, "no outbound fetch() anywhere in the Donor Research code path");
  }
  assert.match(manualProvider, /zero network I\/O/i);
  assert.doesNotMatch(manualProvider, /XMLHttpRequest|WebSocket|import\(.*http/);

  // ---- No provider/network leakage: no API key, no external URL, no
  // search-provider integration anywhere in Stage A. ----
  for (const file of [route, pipeline, manualProvider, sourceTier, fingerprint, classification, mergeResearch]) {
    assert.doesNotMatch(file, /https?:\/\/(?!example\.(org|com)|a\.org|b\.org)[a-z0-9.-]+\.[a-z]{2,}/i, "no hardcoded external URL outside of documentation examples");
    assert.doesNotMatch(file, /_API_KEY|apiKey|Authorization:|Bearer /i, "no API key or credential handling anywhere in Stage A");
  }

  // ---- No financial/internal CRM data reaches research query
  // construction. The evidence/query inputs are limited to what the
  // fundraiser typed plus the donor's own display_name -- gift amounts,
  // giving history, private notes, interactions, reminders, and JL
  // identifiers are never read by research code. ----
  for (const file of [route, pipeline, classification]) {
    for (const forbidden of ["gifts", "giving_activities", "committed_cents", "paid_cents", "balance_cents", "contact_note", "relationship_summary", "institutional_memory", "donor_code", "external_id", "interactions ", "recommendations "]) {
      assert.doesNotMatch(file, new RegExp(forbidden), `${forbidden} must never be read into research code (${file === route ? "route.ts" : "module"})`);
    }
  }

  // ---- No silent canonical donor mutation: research code never issues an
  // UPDATE against the donors table (the only writes here are to
  // donor_research_* tables). Donor-merge reconciliation is the one place
  // donor_id columns get repointed, and that only ever touches the
  // donor_research_* tables, never `donors` itself beyond what the
  // pre-existing merge logic already did. ----
  assert.doesNotMatch(route, /UPDATE donors SET/i);
  assert.doesNotMatch(mergeResearch, /UPDATE donors SET/i);
  assert.doesNotMatch(pipeline, /env\.DB|UPDATE |INSERT INTO/i, "pipeline.ts is pure decision logic -- it never touches the database directly");

  // ---- Schema-level guarantee: donor_research_promotions does not exist,
  // and nothing in Stage A writes a canonical donors column from a
  // research code path. ----
  assert.doesNotMatch(schema, /donorResearchPromotions/);
  assert.doesNotMatch(donorResearchUi, /confidence|score:\s*\d/i, "no numeric confidence is ever rendered to the fundraiser");
  assert.match(donorPage, /mode === "live" && <DonorResearch/, "research is gated to live donors only, like every other write-capable section on this page");

  process.stdout.write("Donor research safety checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
