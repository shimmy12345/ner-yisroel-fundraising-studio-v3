import assert from "node:assert/strict";
import { deriveFulfilledCultivationByDonor } from "../lib/relationships/pledge-payment-plan.ts";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { detectSituations } from "../lib/fundraising-intelligence/situations.ts";

const epoch = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
const NOW = epoch(2026, 10, 8);

function emptyEvidenceInput(overrides) {
  return {
    donorId: "donor-1", mostRecentPaidGift: null, openPledge: null, fulfilledPledgeCultivationOpportunity: null,
    lastCompletedInteraction: null, lastContactAt: null, lastSubstantiveContactAt: null, openReminder: null,
    openAsk: null, relationshipSummary: null, institutionalMemory: null, historicalContext: [], yahrtzeits: [], importantDates: [],
    ...overrides,
  };
}

function run() {
  // ============================================================
  // deriveFulfilledCultivationByDonor -- pure derivation
  // ============================================================

  // --- fires for a fulfilled pledge (balance<=0) whose plan's final date has passed ---
  {
    const giving = [
      { id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: "Dinner", item_type: null, category: "completed_gift" },
    ];
    const plans = new Map([["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 10, 3) }]]);
    const result = deriveFulfilledCultivationByDonor(giving, plans, NOW);
    assert.ok(result.has("d1"));
    assert.deepEqual(result.get("d1"), { pledgeActivityId: "p1", campaign: null, description: "Dinner", finalExpectedPaymentAt: epoch(2026, 10, 3) });
  }

  // --- does NOT fire: balance still > 0 (the real Baruch Katz case must never produce this) ---
  {
    const giving = [{ id: "p1", donor_id: "d1", balance_cents: 1800, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "partially_paid_pledge" }];
    const plans = new Map([["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 10, 3) }]]);
    assert.equal(deriveFulfilledCultivationByDonor(giving, plans, NOW).size, 0, "a pledge with balance remaining must never produce a cultivation opportunity, regardless of the final date");
  }

  // --- does NOT fire: final date not yet reached, even if balance is already 0 ---
  {
    const giving = [{ id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "completed_gift" }];
    const plans = new Map([["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 12, 1) }]]);
    assert.equal(deriveFulfilledCultivationByDonor(giving, plans, NOW).size, 0, "paying off before the final date must not yet surface the next-pledge opportunity");
  }

  // --- does NOT fire: no payment plan at all on the fulfilled pledge ---
  {
    const giving = [{ id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "completed_gift" }];
    assert.equal(deriveFulfilledCultivationByDonor(giving, new Map(), NOW).size, 0);
  }

  // --- SUPERSESSION: a newer real pledge for the same donor suppresses the opportunity entirely ---
  {
    const giving = [
      { id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "completed_gift" },
      { id: "p2", donor_id: "d1", balance_cents: 50000, activity_date: epoch(2026, 9, 1), description: null, item_type: null, category: "open_pledge" },
    ];
    const plans = new Map([["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 10, 3) }]]);
    assert.equal(deriveFulfilledCultivationByDonor(giving, plans, NOW).size, 0, "a newer real pledge must naturally supersede the cultivation opportunity -- no manual dismissal needed");
  }

  // --- An OLDER row does NOT supersede -- only a row dated AFTER the fulfilled pledge counts. ---
  {
    const giving = [
      { id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "completed_gift" },
      { id: "p0", donor_id: "d1", balance_cents: 0, activity_date: epoch(2025, 1, 1), description: null, item_type: null, category: "completed_gift" },
    ];
    const plans = new Map([["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 10, 3) }]]);
    assert.equal(deriveFulfilledCultivationByDonor(giving, plans, NOW).size, 1, "an OLDER unrelated row must never suppress the opportunity");
  }

  // --- Multiple donors, isolated from each other. ---
  {
    const giving = [
      { id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "completed_gift" },
      { id: "p2", donor_id: "d2", balance_cents: 1, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "partially_paid_pledge" },
    ];
    const plans = new Map([
      ["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 10, 3) }],
      ["p2", { pledge_activity_id: "p2", final_expected_payment_at: epoch(2026, 10, 3) }],
    ]);
    const result = deriveFulfilledCultivationByDonor(giving, plans, NOW);
    assert.equal(result.size, 1, "d2 still has a balance -- must never appear");
    assert.ok(result.has("d1"));
  }

  console.log("deriveFulfilledCultivationByDonor checks passed.");

  // ============================================================
  // cultivateNextPledgeCandidate (via generateCandidates) + mutual exclusivity
  // ============================================================

  // --- fires when a cultivation opportunity exists and there is no open pledge ---
  {
    const evidence = buildRecommendationEvidence(emptyEvidenceInput({
      fulfilledPledgeCultivationOpportunity: { pledgeActivityId: "p1", campaign: "DIN2025", description: null, finalExpectedPaymentAt: epoch(2026, 10, 3) },
    }), NOW, "America/New_York");
    const candidates = generateCandidates(evidence);
    const cultivate = candidates.find((c) => c.kind === "cultivate_next_pledge");
    assert.ok(cultivate, "cultivate_next_pledge must fire when a cultivation opportunity exists and there is no open pledge");
    assert.equal(cultivate.confidence, "low");
  }

  // --- does NOT fire when there is no opportunity ---
  {
    const evidence = buildRecommendationEvidence(emptyEvidenceInput({}), NOW, "America/New_York");
    assert.equal(generateCandidates(evidence).some((c) => c.kind === "cultivate_next_pledge"), false);
  }

  // --- MUTUAL EXCLUSIVITY (the task's own explicit semantic rule): an
  // open pledge always wins -- cultivate_next_pledge must never fire
  // alongside follow_up_pledge for the same donor, even if (hypothetically)
  // both pieces of evidence were somehow present at once. ---
  {
    const evidence = buildRecommendationEvidence(emptyEvidenceInput({
      openPledge: { balanceCents: 5000, campaign: null, description: null, activityDate: epoch(2026, 6, 1), activePaymentPlan: null },
      fulfilledPledgeCultivationOpportunity: { pledgeActivityId: "p-old", campaign: null, description: null, finalExpectedPaymentAt: epoch(2026, 10, 3) },
    }), NOW, "America/New_York");
    const candidates = generateCandidates(evidence);
    assert.equal(candidates.some((c) => c.kind === "cultivate_next_pledge"), false, "an open pledge must veto cultivate_next_pledge regardless of any fulfilled-pledge evidence");
    assert.ok(candidates.some((c) => c.kind === "follow_up_pledge"), "the open pledge's own follow-up candidate must still fire normally");
  }

  // --- Structural proof: deriveFulfilledCultivationByDonor + openPledgeByDonor
  // (balance>0 filter) can never both select the SAME pledge for the same
  // donor, since one requires balance<=0 and the other balance>0. This is
  // the real-data mechanism that makes the two evidence fields mutually
  // exclusive, not merely the candidate-level veto above. ---
  {
    const giving = [{ id: "p1", donor_id: "d1", balance_cents: 0, activity_date: epoch(2026, 6, 1), description: null, item_type: null, category: "completed_gift" }];
    const plans = new Map([["p1", { pledge_activity_id: "p1", final_expected_payment_at: epoch(2026, 10, 3) }]]);
    const cultivation = deriveFulfilledCultivationByDonor(giving, plans, NOW);
    const wouldBeOpenPledge = giving.filter((g) => (g.balance_cents ?? 0) > 0);
    assert.equal(wouldBeOpenPledge.length, 0, "a fulfilled pledge (balance<=0) can never simultaneously populate openPledgeByDonor's balance>0 filter");
    assert.equal(cultivation.size, 1);
  }

  console.log("cultivateNextPledgeCandidate + mutual-exclusivity checks passed.");

  // ============================================================
  // Fundraising Intelligence: payment_plan_milestone situation
  // ============================================================

  function donorFixture(overrides) {
    return {
      donorId: "donor-1", lifetimeCents: 0, last365Cents: 0, prior365Cents: 0, distinctActivityYears: 0,
      daysSinceLastGift: null, historicalPeakGiftCents: null, historicalPeakCommitmentCents: null,
      mostRecentCashKind: null, mostRecentCashCents: null, openPledgeBalanceCents: null, openPledgeTotalCents: null,
      openPledgeCategory: null, pledgeAgeDays: null, pledgeCommitmentAgeDays: null, pledgePlanOnTrack: null,
      pledgePlanMilestoneDaysBefore: null, askHistoryCount: 0, hasOpenReminder: false, openReminderAction: null,
      lastInteractionDaysAgo: null, daysSinceSubstantiveContact: null, hasCurrentFact: false, hasActionableFact: false,
      hasUnconfirmedHistoricalContext: false, currentSnapshotSummary: null, upcomingDateDescription: null,
      ...overrides,
    };
  }
  const minimalResult = { components: { financialSignificance: 0 }, pledgeStaleClass: null, momentumLabel: null };

  {
    const donor = donorFixture({ openPledgeBalanceCents: 16800, pledgePlanOnTrack: true, pledgePlanMilestoneDaysBefore: 15 });
    const signals = detectSituations(donor, minimalResult, [], [], NOW);
    const milestone = signals.find((s) => s.situationType === "payment_plan_milestone");
    assert.ok(milestone, "a 15-day milestone must produce a payment_plan_milestone situation");
    assert.equal(milestone.disposition, "KNOW", "a milestone must always be KNOW, never DO");
    assert.equal(milestone.possibleAction, null, "KNOW situations must never carry a possibleAction");
    assert.match(milestone.headline, /15 days/);
  }
  {
    const donor = donorFixture({ pledgePlanMilestoneDaysBefore: null });
    assert.equal(detectSituations(donor, minimalResult, [], [], NOW).some((s) => s.situationType === "payment_plan_milestone"), false);
  }

  console.log("Fundraising Intelligence payment_plan_milestone checks passed.");
}

run();
