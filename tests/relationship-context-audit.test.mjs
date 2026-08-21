import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyFieldText, auditDonors, traceSource } from "../scripts/relationship-context-audit.mjs";

// Regression for the 2026-08-20 comprehensive historical audit: proves
// the audit script's classification is deterministic and correctly
// separates real donor-relevant text from pre-1487a8b field-label-dump
// scaffolding, using synthetic fixtures (no live D1 needed for the
// classification logic itself -- matches this repo's existing convention
// for testing pure decision logic, e.g. tests/relationship-summary-apply.test.mjs).

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function donor(overrides) {
  return { id: "donor-1", donor_code: "0", display_name: "Test Donor", relationship_summary: null, institutional_memory: null, ...overrides };
}

async function run() {
  // ---- classifyFieldText: deterministic, and repeated calls agree ----
  assert.equal(classifyFieldText(null), "NULL");
  assert.equal(classifyFieldText(undefined), "NULL");
  const malformed = "Latest discussion topics: Text message follow-up.\nPeople mentioned: Texted, Zman.\nRecommended next action: Review this note before the next interaction.";
  assert.equal(classifyFieldText(malformed), "MALFORMED");
  assert.equal(classifyFieldText(malformed), classifyFieldText(malformed), "classification must be deterministic across repeated calls");

  // ---- clearly malformed template text is caught, including partial/
  // isolated scaffolding fragments, not just the exact full dump ----
  for (const fragment of [
    "Latest discussion topics: Personal update.",
    "People mentioned: Sent, Yahrtzeit.",
    "Organizations mentioned: Ford Foundation.",
    "Recommended next action: Review this note before the next interaction.",
    "Some note.\nCommitments: follow up",
    "Some note.\nOpen follow-ups: call back",
    "Some note.\nRelationship changes: reconnected",
  ]) {
    assert.equal(classifyFieldText(fragment), "MALFORMED", `expected "${fragment}" to be classified MALFORMED`);
  }

  // ---- legitimate family-context examples must NOT be falsely flagged ----
  for (const good of [
    "called to wish mazel tov on grandson's bar mitzvah this shabbos.",
    "Dropped off bottle of schnaps for son's bar mitzvah.",
    "Discussed Kollel donation and said to follow up after succos.",
    "Sent him an email with photo of his son.",
    "Personal invite to Teaneck event.",
    "Call context: Discussed Kollel donation and said to follow up after succos",
    "Note context: Solicited for a plaque in memory of his wife ($5k)",
  ]) {
    assert.equal(classifyFieldText(good), "GOOD", `expected "${good}" to be classified GOOD, not falsely flagged as malformed`);
  }

  // ---- mixed records (one field malformed, one good) are surfaced as
  // MIXED, never silently auto-cleared/deleted by the classifier ----
  const mixedDonor = donor({
    id: "donor-mixed",
    relationship_summary: malformed,
    institutional_memory: "Text Message context: Texted video from first day of Zman and thanked him for his support that makes it happen",
  });
  const [mixedResult] = auditDonors([mixedDonor], new Map());
  assert.equal(mixedResult.overall, "C_MIXED");
  assert.equal(mixedResult.rsClass, "MALFORMED");
  assert.equal(mixedResult.imClass, "GOOD");
  // The classifier only ever reports a classification -- auditDonors has
  // no return value or side channel that clears/deletes anything.
  assert.equal(mixedDonor.relationship_summary, malformed, "auditing must never mutate the donor's stored value");
  assert.equal(mixedDonor.institutional_memory, "Text Message context: Texted video from first day of Zman and thanked him for his support that makes it happen");

  // ---- both fields good -> A; both malformed/one-null-one-malformed -> B; one null one good -> A ----
  const goodDonor = donor({ id: "donor-good", relationship_summary: "Personal invite to Teaneck event.", institutional_memory: "Note context: Personal invite to Teaneck event" });
  assert.equal(auditDonors([goodDonor], new Map())[0].overall, "A_CLEARLY_GOOD");

  const nullSummaryGoodMemory = donor({ id: "donor-null-rs", relationship_summary: null, institutional_memory: "Note context: Solicited for a plaque ($5k)" });
  assert.equal(auditDonors([nullSummaryGoodMemory], new Map())[0].overall, "A_CLEARLY_GOOD");

  const bothMalformed = donor({ id: "donor-both-bad", relationship_summary: malformed, institutional_memory: "People mentioned: Texted, Zman." });
  assert.equal(auditDonors([bothMalformed], new Map())[0].overall, "B_CLEARLY_MALFORMED");

  // ---- Suggested Action impact matches relationshipOpportunityCandidate's
  // exact fallback chain (relationship_summary wins over institutional_memory
  // when non-null, regardless of its own quality) ----
  assert.equal(mixedResult.suggestedActionAffected, true, "a non-null malformed relationship_summary must be reported as currently affecting Suggested Action, since it wins the narrative fallback even over a good institutional_memory");
  const nullRsMalformedIm = donor({ id: "donor-im-only-bad", relationship_summary: null, institutional_memory: malformed });
  assert.equal(auditDonors([nullRsMalformedIm], new Map())[0].suggestedActionAffected, true, "when relationship_summary is null, a malformed institutional_memory becomes the effective narrative text and must be reported as affecting Suggested Action");
  assert.equal(auditDonors([goodDonor], new Map())[0].suggestedActionAffected, false);

  // ---- source tracing: proven only when a candidate interaction's note
  // reproduces the exact stored value under the OLD generator; never a guess ----
  const sourceInteraction = { id: "int-1", type: "text", occurred_at: 0, summary: "Text message\nTexted video from first day of Zman and thanked him for his support that makes it happen" };
  const traced = traceSource(malformed, [sourceInteraction]);
  assert.ok(traced, "expected the source interaction to be found by exact reproduction under the old generator");
  assert.equal(traced.interaction.id, "int-1");
  assert.equal(traceSource(malformed, []), null, "no interactions on file -> no provenance claimed, not a guess");
  assert.equal(traceSource(malformed, [{ id: "int-2", type: "note", occurred_at: 0, summary: "Unrelated note\nnothing to do with this" }]), null, "an interaction whose note does not reproduce the exact stored value must not be claimed as the source");

  // ---- no write path anywhere in the audit script's own source ----
  const scriptSource = await read("scripts/relationship-context-audit.mjs");
  assert.doesNotMatch(scriptSource, /\bUPDATE\s+donors\b/i, "the audit script must contain no UPDATE statement");
  assert.doesNotMatch(scriptSource, /\bINSERT\s+INTO\b/i, "the audit script must contain no INSERT statement");
  assert.doesNotMatch(scriptSource, /\bDELETE\s+FROM\b/i, "the audit script must contain no DELETE statement");
  assert.doesNotMatch(scriptSource, /process\.argv\.indexOf\(["']--apply["']\)/, "the audit script must not parse an --apply flag, unlike the general-purpose cleanup tool it deliberately does not extend");

  console.log("relationship-context-audit: ok");
}

await run();
