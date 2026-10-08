import assert from "node:assert/strict";
import { evaluatePaymentPlan, adjustNewPlanAnchorForPastDate, deriveFulfilledCultivationByDonor } from "../lib/relationships/pledge-payment-plan.ts";
import { aggregatePortfolioFocusInputs } from "../lib/portfolio-focus/aggregate.ts";

// Timezone-normalization fix regression suite (2026-10-08, see
// docs/AI-HANDOFF.md's "Timezone/Off-By-One Fix" entry). Root cause: every
// date-only field this module works with (final_expected_payment_at, every
// enumerated cycle) is stored as UTC midnight of the intended Eastern
// calendar date (lib/financial-date.ts's own convention), but `now` was
// previously compared against those fields as a raw, continuously-
// advancing instant -- never normalized to the fundraiser's own Eastern
// calendar date first. Because America/New_York trails UTC by 4-5 hours,
// a UTC-midnight date-only value falls in the Eastern EVENING of the
// PRECEDING calendar day, so every comparison flipped about 4-5 hours too
// early -- which, for any normal daytime use, landed every transition on
// the wrong Eastern calendar day entirely (one day early). The fix:
// normalize `now` via lib/workspace/local-time.ts's localDateOnlyEpoch()
// exactly once, inside every function here that compares `now` against a
// date-only field, before any comparison happens.

const DAY = 86400;
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
// A daytime Eastern instant -- noon EDT / 11am EST, either way safely
// inside Eastern calendar date `d` regardless of which DST regime is in
// effect -- the one correct way to pin down "now, on this exact Eastern
// calendar date" for these tests. A bare UTC-midnight epoch is NOT a safe
// stand-in post-fix (see the file header): it represents the Eastern
// evening of the day before.
const et = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);
const TZ = "America/New_York";
const BASE_PLAN = (overrides) => ({ nextExpectedPaymentAt: utcMidnight(2026, 1, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2026, 1, 1), endedAt: null, ...overrides });

function run() {
  // ============================================================
  // Exact 15/10/5-day reminder dates, as specified in the task: Benjy
  // Weil (final Oct 24, 2026) and Mordechai Y. Goldman (final Oct 28,
  // 2026). Each milestone must fire on EXACTLY the one given Eastern
  // calendar date and no other -- confirmed by also checking the day
  // immediately before and after each milestone date fires null.
  // ============================================================
  {
    const weilPlan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 24), expectedDayOfMonth: 24, finalExpectedPaymentAt: utcMidnight(2026, 10, 24) });
    const weilPaid = [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)]; // both cycles satisfied -- genuinely on track
    const weilCases = [[10, 8, null], [10, 9, 15], [10, 10, null], [10, 13, null], [10, 14, 10], [10, 15, null], [10, 18, null], [10, 19, 5], [10, 20, null]];
    for (const [month, day, expected] of weilCases) {
      const result = evaluatePaymentPlan(weilPlan, weilPaid, 2000, et(2026, month, day), TZ);
      assert.equal(result.milestoneDaysBefore, expected, `Weil on 2026-${month}-${day}: milestoneDaysBefore must be ${expected}`);
    }

    const goldmanPlan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 28), expectedDayOfMonth: 28, finalExpectedPaymentAt: utcMidnight(2026, 10, 28) });
    const goldmanPaid = [utcMidnight(2026, 8, 25), utcMidnight(2026, 9, 28)];
    const goldmanCases = [[10, 12, null], [10, 13, 15], [10, 14, null], [10, 17, null], [10, 18, 10], [10, 19, null], [10, 22, null], [10, 23, 5], [10, 24, null]];
    for (const [month, day, expected] of goldmanCases) {
      const result = evaluatePaymentPlan(goldmanPlan, goldmanPaid, 10000, et(2026, month, day), TZ);
      assert.equal(result.milestoneDaysBefore, expected, `Goldman on 2026-${month}-${day}: milestoneDaysBefore must be ${expected}`);
    }
  }

  // ============================================================
  // Early morning / afternoon / late evening Eastern -- the normalized
  // value must be STABLE across an entire Eastern calendar day (the whole
  // point of normalizing once at the top, rather than comparing a raw
  // instant that drifts hour to hour). Weil's real 15-day date (Oct 9).
  // ============================================================
  {
    const weilPlan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 24), expectedDayOfMonth: 24, finalExpectedPaymentAt: utcMidnight(2026, 10, 24) });
    const weilPaid = [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)];
    const hours = [
      ["00:30 ET", Math.floor(Date.UTC(2026, 9, 9, 4, 30, 0) / 1000)], // 00:30 EDT = 04:30 UTC
      ["06:00 ET", Math.floor(Date.UTC(2026, 9, 9, 10, 0, 0) / 1000)],
      ["09:00 ET (Daily Agenda send time)", Math.floor(Date.UTC(2026, 9, 9, 13, 0, 0) / 1000)],
      ["12:00 ET", Math.floor(Date.UTC(2026, 9, 9, 16, 0, 0) / 1000)],
      ["17:00 ET", Math.floor(Date.UTC(2026, 9, 9, 21, 0, 0) / 1000)],
      ["23:30 ET", Math.floor(Date.UTC(2026, 9, 10, 3, 30, 0) / 1000)], // 23:30 EDT Oct 9 = 03:30 UTC Oct 10
    ];
    for (const [label, now] of hours) {
      const result = evaluatePaymentPlan(weilPlan, weilPaid, 2000, now, TZ);
      assert.equal(result.milestoneDaysBefore, 15, `at ${label} on Oct 9, Weil's milestone must still read 15 -- no intra-day drift`);
      assert.equal(result.daysUntilFinal, 15, `at ${label}, daysUntilFinal must be the stable whole-day count 15`);
    }
  }

  // ============================================================
  // UTC midnight boundary -- an instant at EXACTLY UTC midnight must
  // resolve to the Eastern calendar date it actually falls on (the
  // PRECEDING UTC date, since UTC midnight is 20:00 Eastern the day
  // before), never silently treated as if it were Eastern midnight too.
  // ============================================================
  {
    const plan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 24), expectedDayOfMonth: 24, finalExpectedPaymentAt: utcMidnight(2026, 10, 24) });
    const paid = [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)];
    // 2026-10-10T00:00:00Z is 2026-10-09, 20:00 EDT -- still Eastern Oct 9.
    const exactUtcMidnight = utcMidnight(2026, 10, 10);
    const result = evaluatePaymentPlan(plan, paid, 2000, exactUtcMidnight, TZ);
    assert.equal(result.milestoneDaysBefore, 15, "2026-10-10T00:00:00Z is still Eastern Oct 9 (20:00 EDT) -- must read as the Oct 9 milestone, not Oct 10");
  }

  // ============================================================
  // Eastern DST transition -- 2026 falls back from EDT to EST between
  // 2026-10-31 (EDT) and 2026-11-01 (EST) (verified directly against the
  // real IANA data via Intl, not assumed). A plan whose 15-day milestone
  // lands exactly ON the fall-back date, and one whose final date is
  // reached the day after, must both resolve correctly -- no day
  // skipped or double-counted across the transition.
  // ============================================================
  {
    // Final Nov 16 -> 15 days before is Nov 1, the fall-back day itself.
    const plan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 10, 12), expectedDayOfMonth: 12, finalExpectedPaymentAt: utcMidnight(2026, 11, 16) });
    const paid = [utcMidnight(2026, 9, 12), utcMidnight(2026, 10, 12)];
    // Nov 1, 2026 noon UTC is 07:00 EST (already fallen back) -- still a
    // safe, unambiguous daytime instant on the correct Eastern date.
    const fallBackDayNoon = Math.floor(Date.UTC(2026, 10, 1, 16, 0, 0) / 1000);
    const resultOnFallBackDay = evaluatePaymentPlan(plan, paid, 2500, fallBackDayNoon, TZ);
    assert.equal(resultOnFallBackDay.milestoneDaysBefore, 15, "the 15-day milestone must fire correctly on Nov 1, the DST fall-back day itself");
    // Day before (Oct 31, still EDT) and day after (Nov 2, EST) must both
    // read null -- no duplicate/skipped day across the transition.
    const dayBefore = evaluatePaymentPlan(plan, paid, 2500, et(2026, 10, 31), TZ);
    assert.equal(dayBefore.milestoneDaysBefore, null, "Oct 31 (last EDT day) must not also report the milestone");
    const dayAfter = evaluatePaymentPlan(plan, paid, 2500, et(2026, 11, 2), TZ);
    assert.equal(dayAfter.milestoneDaysBefore, null, "Nov 2 (first full EST day) must not also report the milestone");
  }

  // ============================================================
  // Standard time vs. daylight time -- the fix must work correctly in
  // BOTH regimes via the real IANA timezone database, never a hardcoded
  // UTC offset (which would only be correct for half the year). Same
  // relative "final date and 3 days before" shape, once entirely in EDT
  // (October) and once entirely in EST (December).
  // ============================================================
  {
    const edtPlan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: utcMidnight(2026, 10, 15) });
    const edtResult = evaluatePaymentPlan(edtPlan, [utcMidnight(2026, 9, 15)], 100, et(2026, 10, 12), TZ);
    assert.equal(edtResult.daysUntilFinal, 3, "EDT period: 3 days before Oct 15 must read as exactly 3");

    const estPlan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 11, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: utcMidnight(2026, 12, 15) });
    const estResult = evaluatePaymentPlan(estPlan, [utcMidnight(2026, 11, 15)], 100, et(2026, 12, 12), TZ);
    assert.equal(estResult.daysUntilFinal, 3, "EST period: 3 days before Dec 15 must read as exactly 3 -- same shape, different DST regime");
  }

  // ============================================================
  // Final date itself / day before / day after.
  // ============================================================
  {
    const plan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 10), expectedDayOfMonth: 10, finalExpectedPaymentAt: utcMidnight(2026, 10, 10) });
    const paid = [utcMidnight(2026, 9, 10)];

    const dayBefore = evaluatePaymentPlan(plan, paid, 500, et(2026, 10, 9), TZ);
    assert.equal(dayBefore.daysUntilFinal, 1);
    assert.equal(dayBefore.finalDatePassed, false, "the day immediately before the final date must not read as passed");

    const onTheDay = evaluatePaymentPlan(plan, paid, 500, et(2026, 10, 10), TZ);
    assert.equal(onTheDay.daysUntilFinal, 0);
    assert.equal(onTheDay.finalDatePassed, false, "the final date ITSELF must not yet read as passed (strict >, not >=)");
    assert.equal(onTheDay.isPlanEndedWithBalance, false, "a balance-remaining plan on its own final date is not yet ended-with-balance");
    const onTheDayPaidOff = evaluatePaymentPlan(plan, paid, 0, et(2026, 10, 10), TZ);
    assert.equal(onTheDayPaidOff.isFulfilledAfterFinal, true, "a pledge paid off BY its own final date qualifies immediately (>=), not one day later");

    const dayAfter = evaluatePaymentPlan(plan, paid, 500, et(2026, 10, 11), TZ);
    assert.equal(dayAfter.daysUntilFinal, -1, "the day immediately after must read as -1, not clamped to 0");
    assert.equal(dayAfter.finalDatePassed, true);
    assert.equal(dayAfter.isPlanEndedWithBalance, true, "a balance-remaining plan the day after its final date must read as ended-with-balance");
    assert.equal(dayAfter.isLate, false, "an ended-with-balance plan must never ALSO read as late -- isLate stops being evaluated once finalDatePassed");
  }

  // ============================================================
  // Payment-cycle grace-window boundaries -- unaffected by the timezone
  // fix (matchPaymentsToCycles compares two already-date-only values, no
  // `now` involved), but explicitly re-confirmed here since the task
  // requires it: the existing 7-day grace window must still work exactly
  // as before.
  // ============================================================
  {
    const plan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 10), expectedDayOfMonth: 10, finalExpectedPaymentAt: utcMidnight(2026, 11, 10) });
    const now = et(2026, 10, 15);
    const exactlyAtGrace = evaluatePaymentPlan(plan, [utcMidnight(2026, 9, 10) + 7 * DAY], 100, now, TZ);
    assert.equal(exactlyAtGrace.isLate, false, "a payment exactly 7 days after the cycle (the grace boundary) must still satisfy it");
    const oneOverGrace = evaluatePaymentPlan(plan, [utcMidnight(2026, 9, 10) + 8 * DAY], 100, now, TZ);
    assert.equal(oneOverGrace.isLate, true, "a payment 8 days after the cycle (one past grace) must not satisfy it");
    const exactlyAtEarlyGrace = evaluatePaymentPlan(plan, [utcMidnight(2026, 9, 10) - 7 * DAY], 100, now, TZ);
    assert.equal(exactlyAtEarlyGrace.isLate, false, "a payment exactly 7 days BEFORE the cycle must still satisfy it");
  }

  // ============================================================
  // Fully paid vs. outstanding balance, cultivation gating, and no false
  // overdue/cultivation signals -- using deriveFulfilledCultivationByDonor
  // directly, same normalization as evaluatePaymentPlan's own
  // isFulfilledAfterFinal (must never disagree about the same plan).
  // ============================================================
  {
    const givingRows = [{ id: "pledge-1", donor_id: "donor-1", balance_cents: 0, activity_date: utcMidnight(2026, 9, 1), description: null, item_type: null, category: "completed_gift" }];
    const plans = new Map([["pledge-1", { pledge_activity_id: "pledge-1", final_expected_payment_at: utcMidnight(2026, 10, 24) }]]);

    // Day before the final date, even though already paid off -- must NOT
    // yet surface the cultivation opportunity (matches evaluatePaymentPlan's
    // own isFulfilledAfterFinal, which requires >=).
    const tooEarly = deriveFulfilledCultivationByDonor(givingRows, plans, et(2026, 10, 23), TZ);
    assert.equal(tooEarly.size, 0, "paid off the day BEFORE the final date must not yet surface cultivation");

    // On the final date itself -- must surface (>= semantics).
    const onDate = deriveFulfilledCultivationByDonor(givingRows, plans, et(2026, 10, 24), TZ);
    assert.equal(onDate.size, 1, "paid off ON the final date must surface cultivation immediately");

    // Outstanding balance -- must never surface regardless of date.
    const outstandingRows = [{ ...givingRows[0], balance_cents: 500 }];
    const outstanding = deriveFulfilledCultivationByDonor(outstandingRows, plans, et(2026, 11, 1), TZ);
    assert.equal(outstanding.size, 0, "a pledge with any balance remaining must never surface cultivation, however long after the final date");
  }

  // ============================================================
  // No duplicate milestones across a full calendar sweep -- for a single
  // plan, walking every Eastern calendar date from well before to well
  // after the final date, each of 15/10/5 must appear on EXACTLY ONE day,
  // never two days, never skipped, and no other day count ever reports
  // non-null.
  // ============================================================
  {
    const plan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2026, 11, 1) });
    const paid = [utcMidnight(2026, 9, 1), utcMidnight(2026, 10, 1)];
    const seenDays = { 15: [], 10: [], 5: [] };
    for (let day = 10; day <= 30; day++) {
      const result = evaluatePaymentPlan(plan, paid, 100, et(2026, 10, day), TZ);
      if (result.milestoneDaysBefore !== null) seenDays[result.milestoneDaysBefore].push(day);
    }
    assert.deepEqual(seenDays[15], [17], "the 15-day milestone must fire on exactly one day (Oct 17)");
    assert.deepEqual(seenDays[10], [22], "the 10-day milestone must fire on exactly one day (Oct 22)");
    assert.deepEqual(seenDays[5], [27], "the 5-day milestone must fire on exactly one day (Oct 27)");
  }

  // ============================================================
  // Cross-surface consistency -- evaluatePaymentPlan called directly and
  // the SAME plan evaluated through aggregatePortfolioFocusInputs (the
  // Portfolio Focus / Fundraising Intelligence entry point) must agree
  // exactly, proving there is one authoritative evaluation, not separate
  // per-surface date math.
  // ============================================================
  {
    const now = et(2026, 10, 9); // Weil's real 15-day date
    const plan = BASE_PLAN({ nextExpectedPaymentAt: utcMidnight(2026, 9, 24), expectedDayOfMonth: 24, finalExpectedPaymentAt: utcMidnight(2026, 10, 24) });
    const paid = [utcMidnight(2026, 8, 19), utcMidnight(2026, 9, 24)];
    const direct = evaluatePaymentPlan(plan, paid, 2000, now, TZ);

    const raw = {
      donors: [{ id: "donor-weil", display_name: "Mr. & Mrs. Benjy Weil", donor_code: "78188", relationship_summary: null, institutional_memory: null }],
      giving: [{ id: "pledge-weil", donor_id: "donor-weil", paid_cents: 22000, balance_cents: 2000, activity_date: utcMidnight(2026, 8, 19), category: "partially_paid_pledge", item_type: null, description: null }],
      asks: [], interactions: [], reminders: [], yahrtzeits: [], importantDates: [],
      pledgePayments: [{ pledge_activity_id: "pledge-weil", payment_date: utcMidnight(2026, 8, 19), applied_cents: 2000 }, { pledge_activity_id: "pledge-weil", payment_date: utcMidnight(2026, 9, 24), applied_cents: 2000 }],
      paymentPlans: [{ donor_id: "donor-weil", pledge_activity_id: "pledge-weil", installment_amount_cents: 2000, expected_day_of_month: 24, next_expected_payment_at: utcMidnight(2026, 9, 24), final_expected_payment_at: utcMidnight(2026, 10, 24) }],
      relationshipFacts: [], acknowledgments: [], historicalContext: [],
    };
    const aggregated = aggregatePortfolioFocusInputs(raw, now, TZ);
    const donor = aggregated.donorInputs.find((d) => d.donorId === "donor-weil");
    assert.equal(donor.pledgePlanOnTrack, direct.isOnTrack, "Portfolio Focus/Fundraising Intelligence's pledgePlanOnTrack must agree exactly with the direct evaluatePaymentPlan call -- one authoritative evaluation, never a second one");
    assert.equal(donor.pledgePlanMilestoneDaysBefore, direct.milestoneDaysBefore, "milestoneDaysBefore must agree exactly across both call paths");
  }

  // ============================================================
  // adjustNewPlanAnchorForPastDate -- same normalization, "today" means
  // the fundraiser's own Eastern calendar date.
  // ============================================================
  {
    // Entered anchor is the 24th of a past month; "now" is Eastern Oct 9,
    // 2026 (a UTC-midnight `now` one day later, Oct 10 00:00 UTC, would be
    // Eastern Oct 9 evening -- same calendar date either way here, but
    // using et() keeps this test's intent unambiguous).
    const entered = utcMidnight(2026, 8, 24);
    const corrected = adjustNewPlanAnchorForPastDate(entered, et(2026, 10, 9), TZ);
    assert.equal(corrected, utcMidnight(2026, 10, 24), "a past anchor must advance to the first occurrence of its own day-of-month on or after the fundraiser's real Eastern 'today'");

    // An anchor dated exactly "today" (Eastern) must not be advanced.
    const notAdvanced = adjustNewPlanAnchorForPastDate(utcMidnight(2026, 10, 9), et(2026, 10, 9), TZ);
    assert.equal(notAdvanced, utcMidnight(2026, 10, 9), "an anchor matching the fundraiser's real Eastern today must be returned unchanged");
  }

  console.log("pledge-payment-plan-timezone: ok");
}

run();
