import assert from "node:assert/strict";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { buildSuggestionSnapshot } from "../lib/relationships/trip-model.ts";

// Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md).
// Proves Section B's central safeguard end to end, through the REAL,
// unmodified recommendation engine (buildRecommendationEvidence ->
// buildDonorRecommendation -- the exact functions lib/relationships/
// meeting-brief.ts already calls, which is what trips-data.ts's own
// createTrip()/addManualProspect() call via loadMeetingBrief()) -- never
// a reimplementation of payment-plan, ask, or completed-outreach logic
// for trip prioritization specifically. A fixture that fakes the final
// DonorRecommendation shape would not actually prove this; these go
// through the real evidence-to-recommendation pipeline.

const NOW = 1760400000;
const DAY = 86400;
const daysAgo = (days) => NOW - days * DAY;

const BASE_INPUT = {
  donorId: "donor-1",
  mostRecentPaidGift: null,
  openPledge: null,
  lastCompletedInteraction: null,
  lastContactAt: null,
  lastSubstantiveContactAt: null,
  openReminder: null,
  openAsk: null,
  relationshipSummary: null,
  institutionalMemory: null,
  historicalContext: [],
  yahrtzeits: [],
  importantDates: [],
};

function evidenceFor(overrides) {
  return buildRecommendationEvidence({ ...BASE_INPUT, ...overrides }, NOW, "America/New_York");
}

async function run() {
  // --- Payment-plan correctness: a payment plan that is genuinely ON
  // TRACK (next expected cycle still in the future) must never be
  // suggested as a trip-meeting reason implying it's overdue -- reusing
  // the exact same evaluatePaymentPlan()-derived evidence Today's page
  // and Portfolio Focus already rely on, via buildRecommendationEvidence,
  // never a separate trip-side re-evaluation. ---
  {
    const onTrackEvidence = evidenceFor({
      openPledge: {
        balanceCents: 120000, campaign: "Annual Campaign", description: null, activityDate: daysAgo(10),
        activePaymentPlan: { nextExpectedPaymentAt: NOW + 20 * DAY, expectedDayOfMonth: 15, finalExpectedPaymentAt: NOW + 180 * DAY, endedAt: null, installmentAmountCents: 10000, linkedPaymentDates: [daysAgo(10)] },
      },
    });
    const recommendation = buildDonorRecommendation(onTrackEvidence);
    const snapshot = buildSuggestionSnapshot(recommendation, NOW);
    if (snapshot.reason) assert.doesNotMatch(snapshot.reason, /overdue/i, "an on-track payment plan must never be described as overdue in a trip's suggested reason");
  }

  // --- The same pledge, but genuinely late past its real grace period,
  // DOES surface as a legitimate, evidence-backed reason to prioritize
  // this donor for an in-person visit. ---
  {
    const lateEvidence = evidenceFor({
      openPledge: {
        balanceCents: 120000, campaign: "Annual Campaign", description: null, activityDate: daysAgo(70),
        activePaymentPlan: { nextExpectedPaymentAt: daysAgo(70), expectedDayOfMonth: 15, finalExpectedPaymentAt: NOW + 90 * DAY, endedAt: null, installmentAmountCents: 10000, linkedPaymentDates: [] },
      },
    });
    const recommendation = buildDonorRecommendation(lateEvidence);
    assert.ok(recommendation, "a genuinely late payment plan must still produce a real recommendation to carry into a trip's suggested reason");
    const snapshot = buildSuggestionSnapshot(recommendation, NOW);
    assert.match(snapshot.reason, /overdue/i);
    assert.equal(typeof snapshot.score, "number");
  }

  // --- Completed-outreach suppression: a fact that is itself an
  // unambiguous completed-action report must never resurface as a trip
  // meeting's suggested reason -- the exact same protection the Daily
  // Fundraising Agenda already relies on (isUnambiguousCompletedOutreachAction,
  // applied inside recommendation-evidence.ts's factActionability via
  // fact-synthesis.ts's scoreFact(), reused here automatically, never
  // reimplemented for trips). Recent, non-stale contact is supplied so
  // reconnect_contact_gap (an independent candidate keyed only on contact
  // age, unrelated to this fact) does not mask the result -- isolating
  // exactly the suppression this test exists to prove. ---
  {
    const completedOutreachEvidence = evidenceFor({
      lastContactAt: daysAgo(10),
      lastSubstantiveContactAt: daysAgo(10),
      relationshipFacts: [{
        factText: "Texted video from first day of Zman and thanked him for his support that makes it happen.",
        category: "engagement", lifecycle: "durable", status: "current",
        sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(54),
      }],
      pendingAskSourceInteractionIds: [],
    });
    const recommendation = buildDonorRecommendation(completedOutreachEvidence);
    assert.equal(recommendation, null, "a completed-outreach-only fact, with no other open evidence and recent contact, must not produce a recommendation to carry into a trip, exactly as it must not on the Daily Agenda");
    const snapshot = buildSuggestionSnapshot(recommendation, NOW);
    assert.ok(snapshot.reason, "the donor is still a legitimate trip prospect (being in the region is reason enough) -- just with a neutral, honest reason");
    assert.doesNotMatch(snapshot.reason, /zman|thanked/i, "the stale completed-action text must never leak into the trip's own suggested reason");
  }

  // --- Evidence-based ranking: a donor with a real open ask produces a
  // higher-confidence, concretely-scored suggestion than a donor with no
  // open evidence at all (recent contact, nothing outstanding) -- proving
  // suggestions are ordered by the SAME real score() the rest of the CRM
  // uses, never a separate trip ranking. ---
  {
    const openAskEvidence = evidenceFor({ openAsk: { id: "ask-1", amountCents: 500000, purpose: "capital campaign", askedAt: daysAgo(10), activeFollowUpDueAt: null } });
    const askRecommendation = buildDonorRecommendation(openAskEvidence);
    const askSnapshot = buildSuggestionSnapshot(askRecommendation, NOW);
    const noEvidenceSnapshot = buildSuggestionSnapshot(buildDonorRecommendation(evidenceFor({ lastContactAt: daysAgo(10), lastSubstantiveContactAt: daysAgo(10) })), NOW);
    assert.equal(typeof askSnapshot.score, "number");
    assert.equal(noEvidenceSnapshot.score, null, "a donor with recent contact and nothing outstanding gets no recommendation at all, not an invented score");
    assert.ok(askSnapshot.score > 0, "a real open-ask recommendation must carry a real, positive evidence score for ranking");
  }

  // --- The snapshot is generated once, at a known time, and is never
  // re-derived from a DIFFERENT "now" later -- the whole point of
  // labeling it with its own generation date rather than presenting it
  // as a live fact. ---
  {
    const recommendation = buildDonorRecommendation(evidenceFor({ openAsk: { id: "ask-2", amountCents: 10000, purpose: "annual gift", askedAt: daysAgo(5), activeFollowUpDueAt: null } }));
    const snapshotAtCreation = buildSuggestionSnapshot(recommendation, NOW);
    const muchLater = NOW + 90 * DAY;
    const snapshotIfRegeneratedLater = buildSuggestionSnapshot(recommendation, muchLater);
    assert.equal(snapshotAtCreation.generatedAt, NOW);
    assert.equal(snapshotIfRegeneratedLater.generatedAt, muchLater, "the generation timestamp always reflects when buildSuggestionSnapshot was actually called -- trips-data.ts calls this exactly once, at add time, and never again for the same prospect, which is what keeps the stored snapshot honest");
  }

  console.log("trip-suggestion-evidence: ok");
}

await run();
