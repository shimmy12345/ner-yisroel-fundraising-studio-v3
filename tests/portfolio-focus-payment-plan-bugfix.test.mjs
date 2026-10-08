import assert from "node:assert/strict";
import { aggregatePortfolioFocusInputs } from "../lib/portfolio-focus/aggregate.ts";

// Regression for the payment-plan-intelligence bug fix (see
// docs/AI-HANDOFF.md): aggregate.ts used to compute
// `pledgePlanOnTrack = !evaluation.isLate`, which reads as "on track"
// the moment a plan's final expected date has passed (evaluatePaymentPlan
// deliberately forces isLate back to false once finalDatePassed is true).
// This exercises aggregatePortfolioFocusInputs directly (a pure function,
// no D1) with a fixture shaped exactly like the real donor 68231 (Baruch
// Katz) case -- active plan, final expected date already passed, balance
// still open.

const epoch = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
// A daytime Eastern instant (noon EDT / 11am EST -- either way, safely
// inside the Eastern calendar date `d`, regardless of DST) -- used instead
// of a bare UTC-midnight `epoch()` wherever a test needs to pin down
// EXACTLY which Eastern calendar date `now` falls on. A UTC-midnight `now`
// is itself ambiguous for this purpose post-fix: it falls in the Eastern
// EVENING of the PRECEDING calendar date (see the 2026-10-08 timezone fix
// in docs/AI-HANDOFF.md), so using one here would silently test the wrong
// day for anything date-boundary-sensitive like an exact 15-day milestone.
const easternDaytime = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);

function emptyRaw(overrides) {
  return {
    donors: [], giving: [], asks: [], interactions: [], reminders: [],
    yahrtzeits: [], importantDates: [], pledgePayments: [], paymentPlans: [],
    relationshipFacts: [], acknowledgments: [], historicalContext: [],
    ...overrides,
  };
}

function run() {
  const now = epoch(2026, 10, 8); // 5 days after the plan's final expected date

  // --- The real Baruch Katz shape: final expected date passed, $18 (1800
  // cents) balance remains, plan never ended. ---
  {
    const raw = emptyRaw({
      donors: [{ id: "donor-katz", display_name: "Mr. & Mrs. Baruch Katz", donor_code: "68231", relationship_summary: null, institutional_memory: null }],
      giving: [{ id: "pledge-katz", donor_id: "donor-katz", paid_cents: 1620000, balance_cents: 1800, activity_date: epoch(2026, 6, 3), category: "partially_paid_pledge", item_type: null, description: null }],
      pledgePayments: [{ pledge_activity_id: "pledge-katz", payment_date: epoch(2026, 9, 7), applied_cents: 150000 }],
      paymentPlans: [{ donor_id: "donor-katz", pledge_activity_id: "pledge-katz", installment_amount_cents: 150000, expected_day_of_month: 3, next_expected_payment_at: epoch(2026, 9, 3), final_expected_payment_at: epoch(2026, 10, 3) }],
    });
    const result = aggregatePortfolioFocusInputs(raw, now, "America/New_York");
    const katz = result.donorInputs.find((d) => d.donorId === "donor-katz");
    assert.ok(katz, "fixture donor must be present in the aggregation output");
    assert.equal(katz.pledgePlanOnTrack, false, "BUG FIX: a plan whose final expected date has passed with balance remaining must never read as on-track");
    assert.equal(katz.pledgePlanMilestoneDaysBefore, null, "an ended-with-balance plan must never also report a milestone");
  }

  // --- Same shape, but the final date is still 15 days away and every
  // cycle so far is satisfied -- this must correctly read as on-track
  // AND report the 15-day milestone (proves the fix doesn't overcorrect
  // into always reporting false). ---
  {
    const finalAt = epoch(2026, 10, 23);
    const nowOnTrack = easternDaytime(2026, 10, 8); // exactly 15 Eastern calendar days before Oct 23
    const raw = emptyRaw({
      donors: [{ id: "donor-ontrack", display_name: "Test Donor", donor_code: "99999", relationship_summary: null, institutional_memory: null }],
      giving: [{ id: "pledge-ontrack", donor_id: "donor-ontrack", paid_cents: 500, balance_cents: 1000, activity_date: epoch(2026, 8, 3), category: "partially_paid_pledge", item_type: null, description: null }],
      pledgePayments: [{ pledge_activity_id: "pledge-ontrack", payment_date: epoch(2026, 9, 3), applied_cents: 500 }],
      paymentPlans: [{ donor_id: "donor-ontrack", pledge_activity_id: "pledge-ontrack", installment_amount_cents: 500, expected_day_of_month: 3, next_expected_payment_at: epoch(2026, 9, 3), final_expected_payment_at: finalAt }],
    });
    const result = aggregatePortfolioFocusInputs(raw, nowOnTrack, "America/New_York");
    const donor = result.donorInputs.find((d) => d.donorId === "donor-ontrack");
    assert.equal(donor.pledgePlanOnTrack, true, "a genuinely on-track plan must still read as on-track after the fix");
    assert.equal(donor.pledgePlanMilestoneDaysBefore, 15, "an on-track plan exactly 15 days from its final date must report the milestone");
  }

  console.log("Portfolio Focus payment-plan bug-fix regression checks passed.");
}

run();
