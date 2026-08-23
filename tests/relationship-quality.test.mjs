import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { actionableRelationshipSnapshot, relationshipSnapshotDetails } from "../lib/capture/interaction.ts";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";

// Live-observed relationship-intelligence quality bugs: the snapshot
// extractor misclassifying a channel verb as a person ("People mentioned:
// Messaged."), the Relationship Snapshot/capture preview/Suggested Action
// all surfacing low-value machine-generated boilerplate (generic category
// labels, a manufactured "review this note" action, raw internal field
// names like "relationship_summary/institutional_memory:" and
// "Confidence: medium"), instead of only surfacing specific,
// donor-relevant facts that actually earn their place. Fixed at the single
// generation source (lib/capture/interaction.ts's specificFacts) so every
// downstream consumer (donor page, Meeting Brief, Assistant, capture
// preview, recommendation engine) inherits the same quality gate.

const NOW = Math.floor(Date.parse("2026-08-19T12:00:00Z") / 1000);
const DAY = 86400;
const daysAgo = (n) => NOW - n * DAY;
const TIMEZONE = "America/New_York";
const emptyInput = {
  donorId: "donor-empty", mostRecentPaidGift: null, openPledge: null, lastCompletedInteraction: null,
  lastContactAt: null, lastSubstantiveContactAt: null, openReminder: null, relationshipSummary: null,
  institutionalMemory: null, historicalContext: [], yahrtzeits: [], importantDates: [],
};

async function run() {
  // --- 1: "Messaged" -- the exact live failure -- is never a person. ---
  assert.deepEqual(relationshipSnapshotDetails("Messaged about the building fund update.", "text").people, []);
  assert.deepEqual(relationshipSnapshotDetails("Messaged him about the pledge.", "text").people, []);

  // --- 2: "Solicited" (the earlier, already-fixed regression) stays excluded. ---
  assert.deepEqual(relationshipSnapshotDetails("Solicited for a plaque ($5k)", "note").people, []);

  // --- 3: genuine person names still extract correctly, including inside
  // a sentence that also carries a real fact (not just in isolation). ---
  assert.deepEqual(relationshipSnapshotDetails("Coffee with Elena and Maya.", "meeting").people, ["Elena", "Maya"]);
  const davidDetails = relationshipSnapshotDetails("David Cohen mentioned that his daughter is starting seminary in Israel this fall.", "note");
  assert.ok(davidDetails.people.includes("David Cohen"), "a genuine two-word name must survive quality filtering");

  // --- 4: a note that only matches the generic "personal update" category
  // (no real signal) must not promote that bare category as if it were a
  // fact -- the snapshot must be null, not "Personal update.". ---
  assert.equal(actionableRelationshipSnapshot("Nice catching up, all is well.", "personal"), null);

  // --- 5: "Yeshiva" alone (no qualifying name) is not a valuable
  // organization insight -- filtered from organizations, and alone
  // contributes nothing to the snapshot. A real yeshiva NAME survives. ---
  assert.deepEqual(relationshipSnapshotDetails("Visited the Yeshiva today.", "visit").organizations, []);
  assert.equal(actionableRelationshipSnapshot("Visited the Yeshiva today.", "visit"), null);
  assert.deepEqual(relationshipSnapshotDetails("Discussed pledge balance with Rabbi Weiss at Yeshivas Ner Yisroel.", "note").organizations, ["Yeshivas Ner Yisroel"]);

  // --- 6: a specific donor fact survives quality filtering and renders as
  // plain natural language -- the task's own worked example. ---
  const davidNote = "David Cohen mentioned that his daughter is starting seminary in Israel this fall.";
  assert.equal(actionableRelationshipSnapshot(davidNote, "note"), "David Cohen mentioned that his daughter is starting seminary in Israel this fall.");

  // --- 7: concrete next-action / commitment language survives. ---
  const commitmentDetails = relationshipSnapshotDetails("Will send the updated pledge form by Friday.", "note");
  assert.equal(commitmentDetails.recommendedNextAction, "send the updated pledge form by Friday");
  assert.match(actionableRelationshipSnapshot("Will send the updated pledge form by Friday.", "note"), /send the updated pledge form by Friday/);

  // --- 8: the old boilerplate "Review this note before the next
  // interaction" is never generated without real action evidence -- for
  // any note with no commitment language, recommendedNextAction is null,
  // not a manufactured placeholder. ---
  for (const note of ["Messaged about the building fund update.", "Sent building-progress photo update.", "Visited the Yeshiva today.", "Called to check in."]) {
    const details = relationshipSnapshotDetails(note, "text");
    assert.equal(details.recommendedNextAction, null, `"${note}" has no real commitment -- recommendedNextAction must be null, never a manufactured placeholder`);
    assert.doesNotMatch(actionableRelationshipSnapshot(note, "text") ?? "", /Review this note before the next interaction/);
  }

  // --- 9/10: the snapshot never renders a field-label dump (empty or
  // otherwise) -- it's either null, or plain natural-language sentences. ---
  assert.equal(actionableRelationshipSnapshot("Called to check in.", "call"), null, "weak/absent fields must be omitted entirely, never forced empty headings");
  const snapshot = actionableRelationshipSnapshot(davidNote, "note");
  for (const label of ["Latest discussion topics:", "People mentioned:", "Organizations mentioned:", "Commitments:", "Open follow-ups:", "Relationship changes:", "Recommended next action:"]) {
    assert.doesNotMatch(snapshot, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `the snapshot must never contain the raw field label "${label}"`);
  }
  assert.doesNotMatch(snapshot, /\n/, "a one-fact snapshot should read as a single natural-language line, not a multi-section dump");

  // --- 11: Suggested Action (relationship_opportunity) no longer echoes a
  // field-label dump wholesale, and never leaks the raw DB field name --
  // this is exactly the live-observed "Reach out and reference what's
  // already known: Latest discussion topics: ..." bug. With the extraction
  // fix in place, relationship_summary is always a clean fact by the time
  // it reaches here, so the action stays a short, direct sentence. ---
  const opportunityEvidence = buildRecommendationEvidence({ ...emptyInput, relationshipSummary: davidNote }, NOW, TIMEZONE);
  const opportunityCandidate = generateCandidates(opportunityEvidence).find((c) => c.kind === "relationship_opportunity");
  assert.ok(opportunityCandidate);
  assert.doesNotMatch(opportunityCandidate.action, /Latest discussion topics:|People mentioned:|Recommended next action:/, "Suggested Action must never echo a field-label dump");
  assert.doesNotMatch(opportunityCandidate.evidence.join(" "), /relationship_summary\/institutional_memory:/, "Suggested Action evidence must never expose the raw DB field name");
  assert.ok(opportunityCandidate.action.length < 200, "the action should read as a short, direct sentence, not a multi-paragraph echo");

  // --- 12: no suggested action appears when nothing specific is
  // supported -- the exact live bug (a generic Text Message with note
  // "Text message") produces no candidate and no recommendation at all. ---
  const genericTextEvidence = buildRecommendationEvidence({ ...emptyInput, lastCompletedInteraction: { type: "text", summary: "Text message\nJust checking in, nothing to report.", occurredAt: daysAgo(1) }, lastContactAt: daysAgo(1), lastSubstantiveContactAt: daysAgo(1) }, NOW, TIMEZONE);
  assert.equal(buildDonorRecommendation(genericTextEvidence), null, "with nothing specific on file, the recommendation must honestly be null");

  // --- 13: a real commitment/follow-up recommendation still appears end
  // to end (evidence -> candidates -> ranked winner). ---
  const specificTextEvidence = buildRecommendationEvidence({ ...emptyInput, lastCompletedInteraction: { type: "text", summary: "Building update\nWill send the updated pledge form by Friday.", occurredAt: daysAgo(1) }, lastContactAt: daysAgo(1), lastSubstantiveContactAt: daysAgo(1) }, NOW, TIMEZONE);
  const specificWinner = buildDonorRecommendation(specificTextEvidence);
  assert.equal(specificWinner?.kind, "continue_conversation");
  assert.match(specificWinner.action, /send the updated pledge form by Friday/i);

  // --- 14: debug/internal provenance labels are absent from donor-facing
  // Suggested Action UI (both the donor page and Meeting Brief), while
  // timing (a legitimate, allowed piece of context) is still shown when
  // present. ---
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const meetingBriefPage = await readFile(new URL("../app/donors/[id]/meeting-brief/page.tsx", import.meta.url), "utf8");
  for (const [label, source] of [["donor page", donorPage], ["Meeting Brief", meetingBriefPage]]) {
    assert.doesNotMatch(source, /Confidence: \{/, `${label} must never render the internal "Confidence:" label in normal donor UI`);
  }
  assert.match(donorPage, /\{recommendation\?\.timing && <p className="recommendation-meta">\{recommendation\.timing\}<\/p>\}/, "timing must still render when present, just without the confidence label");
  assert.match(meetingBriefPage, /\{brief\.recommendation\.timing && <p className="recommendation-meta">\{brief\.recommendation\.timing\}<\/p>\}/, "Meeting Brief must still render timing when present, just without the confidence label");

  // --- 15/16: the capture preview only ever offers a real fact to opt
  // into. When nothing meaningful was extracted, it shows an honest
  // message instead of asking the user to manually reject boilerplate;
  // when something meaningful WAS extracted, the existing opt-in checkbox
  // still works exactly as before ("nothing generated is saved unless you
  // check this box" is unchanged). ---
  const captureExperience = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");
  assert.match(captureExperience, /preview\.relationshipSummary\s*\?\s*<div className="relationship-snapshot-preview">/, "a meaningful preview must still offer the existing opt-in checkbox");
  assert.match(captureExperience, /Nothing generated is saved unless you check this box\./, "the opt-in guarantee copy must be unchanged");
  assert.match(captureExperience, /No new relationship details to save\. This interaction is still recorded as stewardship activity\./, "an empty extraction must show an honest message, not silently offer nothing or force a checkbox on garbage -- and must never imply the interaction itself was meaningless");
  assert.match(captureExperience, /acceptRelationshipSnapshot: acceptRelationshipSnapshot && preview\.relationshipSummary !== null,/, "the submitted flag must be gated on the CURRENT preview actually being meaningful, not just the checkbox's own stale state");

  console.log("Relationship-intelligence quality checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
