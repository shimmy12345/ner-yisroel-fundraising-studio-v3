import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";

const NOW = Math.floor(Date.parse("2026-08-12T00:00:00Z") / 1000);
const DAY = 86400;
const daysAgo = (n) => NOW - n * DAY;

const emptyInput = {
  donorId: "donor-empty",
  mostRecentPaidGift: null,
  openPledge: null,
  lastCompletedInteraction: null,
  lastContactAt: null,
  openReminder: null,
  relationshipSummary: null,
  institutionalMemory: null,
  historicalContext: [],
};

async function run() {
  // --- evidence builder: derived fields ---
  const withGift = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: { amountCents: 5000, occurredAt: daysAgo(10), campaign: "Fund", description: null }, lastContactAt: daysAgo(3) }, NOW);
  assert.equal(withGift.giving.acknowledgedSinceGift, true, "contact after the gift date must count as acknowledged");
  const withUnacknowledgedGift = buildRecommendationEvidence({ ...emptyInput, mostRecentPaidGift: { amountCents: 5000, occurredAt: daysAgo(3), campaign: "Fund", description: null }, lastContactAt: daysAgo(10) }, NOW);
  assert.equal(withUnacknowledgedGift.giving.acknowledgedSinceGift, false, "contact before the gift date must not count as acknowledged");
  const withPledge = buildRecommendationEvidence({ ...emptyInput, openPledge: { balanceCents: 1000, campaign: null, description: null, activityDate: daysAgo(45) } }, NOW);
  assert.equal(withPledge.giving.openPledge.ageDays, 45);
  const withReminder = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: daysAgo(2) } }, NOW);
  assert.equal(withReminder.reminder.isOverdue, true, "a due date in the past must be overdue");
  const withFutureReminder = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: NOW + 5 * DAY } }, NOW);
  assert.equal(withFutureReminder.reminder.isOverdue, false);
  const noContactEver = buildRecommendationEvidence(emptyInput, NOW);
  assert.equal(noContactEver.contact.daysSinceLastContact, null);

  // --- candidate generators: only fire on their own precondition ---
  assert.equal(generateCandidates(buildRecommendationEvidence(emptyInput, NOW)).find((c) => c.kind === "honor_reminder"), undefined);
  assert.ok(generateCandidates(withReminder).find((c) => c.kind === "honor_reminder"), "an open reminder must generate honor_reminder");
  assert.ok(generateCandidates(withUnacknowledgedGift).find((c) => c.kind === "acknowledge_gift"), "an unacknowledged paid gift must generate acknowledge_gift");
  assert.equal(generateCandidates(withGift).find((c) => c.kind === "acknowledge_gift"), undefined, "an already-acknowledged gift must not generate acknowledge_gift");
  assert.ok(generateCandidates(withPledge).find((c) => c.kind === "follow_up_pledge"));
  const gapEvidence = buildRecommendationEvidence({ ...emptyInput, lastContactAt: daysAgo(120) }, NOW);
  assert.ok(generateCandidates(gapEvidence).find((c) => c.kind === "reconnect_contact_gap"));
  const noGapEvidence = buildRecommendationEvidence({ ...emptyInput, lastContactAt: daysAgo(10) }, NOW);
  assert.equal(generateCandidates(noGapEvidence).find((c) => c.kind === "reconnect_contact_gap"), undefined, "a recent contact must not generate a contact-gap candidate");
  const narrativeEvidence = buildRecommendationEvidence({ ...emptyInput, relationshipSummary: "Loves the annual gala" }, NOW);
  assert.ok(generateCandidates(narrativeEvidence).find((c) => c.kind === "relationship_opportunity"));
  // No data at all (donor never contacted, nothing else on file) still
  // honestly falls back to reconnect_contact_gap -- "no contact ever
  // recorded" is itself real evidence, not a fabricated suggestion.
  const trulyEmpty = generateCandidates(buildRecommendationEvidence(emptyInput, NOW));
  assert.deepEqual(trulyEmpty.map((c) => c.kind), ["reconnect_contact_gap"]);
  // A donor contacted recently, with nothing else on file at all, has
  // genuinely nothing to suggest.
  assert.equal(generateCandidates(noGapEvidence).length, 0, "a recently-contacted donor with no other signal must generate zero candidates");

  // --- hard constraint 1: reminder suppresses the next-touchpoint family,
  // never the money-stewardship family ---
  const reminderPlusGift = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: null }, mostRecentPaidGift: { amountCents: 1000, occurredAt: daysAgo(3), campaign: null, description: null }, lastContactAt: daysAgo(10) }, NOW);
  const reminderPlusGap = buildRecommendationEvidence({ ...emptyInput, openReminder: { action: "Call", reason: "r", dueAt: null }, lastContactAt: daysAgo(200) }, NOW);
  const afterReminderWithGift = buildDonorRecommendation(reminderPlusGift);
  assert.ok(["honor_reminder", "acknowledge_gift"].includes(afterReminderWithGift.kind), "a reminder must not eliminate a competing gift-acknowledgment candidate");
  const afterReminderWithGap = buildDonorRecommendation(reminderPlusGap);
  assert.equal(afterReminderWithGap.kind, "honor_reminder", "a reminder must suppress a competing contact-gap candidate, not just outscore it");

  // --- hard constraint 2: open pledge vetoes solicit unless evidence postdates it ---
  const solicitBlockedByPledge = buildRecommendationEvidence({
    ...emptyInput,
    openPledge: { balanceCents: 3000, campaign: "Building Fund", description: null, activityDate: daysAgo(90) },
    historicalContext: [{ text: "Solicit for $18k -- corporate sponsorship", source: "import-monday", sourceDate: daysAgo(120) }],
  }, NOW);
  const blockedCandidates = generateCandidates(solicitBlockedByPledge);
  assert.ok(blockedCandidates.find((c) => c.kind === "solicit"), "sanity: the raw candidate must exist before the veto is applied");
  const blockedResult = buildDonorRecommendation(solicitBlockedByPledge);
  assert.equal(blockedResult.kind, "follow_up_pledge", "an unconfirmed solicitation note predating the pledge must be vetoed entirely, not merely outranked");

  // Pledge activity is recent here (low urgency for follow_up_pledge) so
  // this isolates "did the veto lift" from "did it also win on score" --
  // both must be true for this assertion to hold.
  const solicitAllowedAfterPledge = buildRecommendationEvidence({
    ...emptyInput,
    openPledge: { balanceCents: 3000, campaign: "Building Fund", description: null, activityDate: daysAgo(20) },
    relationshipSummary: "Solicit for a new corporate sponsorship opportunity that came up after the pledge",
  }, NOW);
  const allowedResult = buildDonorRecommendation(solicitAllowedAfterPledge);
  assert.equal(allowedResult.kind, "solicit", "solicitation evidence postdating the pledge must survive the veto and be free to compete");

  // --- hard constraint 3: unconfirmed-historical evidence is capped, never "high" ---
  const historicalOnly = buildRecommendationEvidence({ ...emptyInput, historicalContext: [{ text: "Solicit for $10k", source: "import-monday", sourceDate: daysAgo(30) }] }, NOW);
  const historicalWinner = buildDonorRecommendation(historicalOnly);
  assert.equal(historicalWinner.kind, "solicit");
  assert.notEqual(historicalWinner.confidence, "high", "a candidate sourced only from unconfirmed historical context must never be high confidence");
  assert.match(historicalWinner.evidence.join(" "), /never confirmed/i, "unconfirmed historical evidence must carry explicit uncertainty language");

  // Confirmed evidence must outrank an unconfirmed-historical candidate
  // describing a similar opportunity when both are present.
  const confirmedBeatsHistorical = buildRecommendationEvidence({
    ...emptyInput,
    mostRecentPaidGift: { amountCents: 1000, occurredAt: daysAgo(2), campaign: null, description: null },
    lastContactAt: daysAgo(20),
    historicalContext: [{ text: "Solicit for $10k", source: "import-monday", sourceDate: daysAgo(300) }],
  }, NOW);
  assert.equal(buildDonorRecommendation(confirmedBeatsHistorical).kind, "acknowledge_gift", "a confirmed recent gift must outrank an unconfirmed historical solicitation note");

  // --- the three documented competing cases ---
  // Case 1: recent gift vs. aging pledge -- recency+specificity wins over raw staleness.
  const case1 = buildRecommendationEvidence({
    ...emptyInput,
    mostRecentPaidGift: { amountCents: 200000, occurredAt: daysAgo(5), campaign: "Annual Campaign", description: null },
    openPledge: { balanceCents: 800000, campaign: "Annual Campaign", description: null, activityDate: daysAgo(200) },
    lastContactAt: daysAgo(200),
  }, NOW);
  assert.equal(buildDonorRecommendation(case1).kind, "acknowledge_gift");

  // Case 2: unconfirmed historical solicitation predating an open pledge -- vetoed.
  const case2 = buildRecommendationEvidence({
    ...emptyInput,
    openPledge: { balanceCents: 300000, campaign: "Building Fund", description: null, activityDate: daysAgo(90) },
    lastContactAt: daysAgo(90),
    historicalContext: [{ text: "Solicit for $18k -- corporate sponsorship", source: "import-monday", sourceDate: daysAgo(120) }],
  }, NOW);
  assert.equal(buildDonorRecommendation(case2).kind, "follow_up_pledge");

  // Case 3: long contact gap vs. specific relationship narrative -- specificity wins over raw urgency.
  const case3 = buildRecommendationEvidence({
    ...emptyInput,
    lastContactAt: daysAgo(150),
    relationshipSummary: "Interested in funding a new scholarship track; wants to discuss after his daughter's wedding in September.",
  }, NOW);
  assert.equal(buildDonorRecommendation(case3).kind, "relationship_opportunity");
  // With no narrative at all, the same contact gap must fall back honestly.
  const case3NoNarrative = buildRecommendationEvidence({ ...emptyInput, lastContactAt: daysAgo(150) }, NOW);
  assert.equal(buildDonorRecommendation(case3NoNarrative).kind, "reconnect_contact_gap");

  // --- output shape: every winning recommendation has the 5 required fields ---
  for (const evidence of [case1, case2, case3]) {
    const result = buildDonorRecommendation(evidence);
    assert.equal(typeof result.action, "string");
    assert.equal(typeof result.why, "string");
    assert.ok(Array.isArray(result.evidence) && result.evidence.length > 0);
    assert.ok(["high", "medium", "low"].includes(result.confidence));
    assert.ok(result.timing === null || typeof result.timing === "string");
  }

  // --- never invents facts: action/evidence text only ever echoes fields
  // that were actually present in the input, never a placeholder like
  // "some campaign" or a guessed amount. ---
  assert.doesNotMatch(JSON.stringify(buildDonorRecommendation(case1)), /some campaign|approximately|around \$|TBD/i);

  // --- cross-surface consistency: the donor page, Meeting Brief,
  // Assistant, and the homepage/Today queue must all resolve a donor's
  // suggested action through this exact same engine -- never a
  // surface-local re-derivation that could disagree with the others.
  // (D1-backed code can't run outside a Workers runtime -- this checks
  // the actual wiring at the source level, matching the convention
  // already established in tests/monday-import-safety.test.mjs.) ---
  const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
  const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
  const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
  const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  const ruleBased = await readFile(new URL("../lib/ai/rule-based.ts", import.meta.url), "utf8");
  for (const [name, source] of [["donor page", donorPage], ["Meeting Brief", meetingBrief], ["homepage/Today queue", liveData]]) {
    assert.match(source, /buildRecommendationEvidence\(/, `${name} must build evidence through the shared engine`);
    assert.match(source, /buildDonorRecommendation\(/, `${name} must rank through the shared engine`);
  }
  // Assistant reuses Meeting Brief's own loader for the primary donor
  // rather than re-deriving evidence itself -- so it can never diverge
  // from what the Meeting Brief page shows for that same donor.
  assert.match(assistantRoute, /loadMeetingBrief\(/, "Assistant must reuse the Meeting Brief loader for the primary donor, not a separate evidence path");
  // rule-based.ts must format s.donor.recommendation as-is, never
  // reconstruct next-action text from raw recommendations/reasons itself.
  assert.match(ruleBased, /s\.donor\.recommendation/);
  assert.doesNotMatch(ruleBased, /s\.recommendations\[0\]\.action/, "the meeting-brief task must not fall back to re-deriving text from the raw recommendations list");

  console.log("Recommendation engine checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
