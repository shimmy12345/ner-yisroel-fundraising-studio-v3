import assert from "node:assert/strict";
import {
  advanceOneCalendarMonth,
  enumerateExpectedCycles,
  matchPaymentsToCycles,
  evaluatePaymentPlan,
  dayOfMonthFromDateOnlyEpoch,
  MONTHLY_PAYMENT_PLAN_GRACE_DAYS,
} from "../lib/relationships/pledge-payment-plan.ts";

const DAY = 86400;
const epoch = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
const iso = (e) => new Date(e * 1000).toISOString().slice(0, 10);

function run() {
  // --- dayOfMonthFromDateOnlyEpoch: auto-derivation, no separate form field needed. ---
  assert.equal(dayOfMonthFromDateOnlyEpoch(epoch(2026, 9, 18)), 18);
  assert.equal(dayOfMonthFromDateOnlyEpoch(epoch(2026, 1, 31)), 31);

  // --- advanceOneCalendarMonth: the month-end/31st-anchor requirement,
  // the exact sequence the task specifies. ---
  {
    const jan31 = epoch(2026, 1, 31);
    const feb = advanceOneCalendarMonth(jan31, 31);
    assert.equal(iso(feb), "2026-02-28", "Jan 31 anchored to 31 must advance to Feb 28 in a non-leap year");
    const mar = advanceOneCalendarMonth(feb, 31);
    assert.equal(iso(mar), "2026-03-31", "Feb 28 must return to Mar 31, NOT drift to Mar 28 -- the core month-end requirement");
    const apr = advanceOneCalendarMonth(mar, 31);
    assert.equal(iso(apr), "2026-04-30", "Mar 31 -> Apr 30 (April has no 31st)");
    const may = advanceOneCalendarMonth(apr, 31);
    assert.equal(iso(may), "2026-05-31", "Apr 30 must return to May 31, not stay pinned at 30");
  }

  // --- Leap year Feb 29 behavior. ---
  {
    const jan31_2028 = epoch(2028, 1, 31); // 2028 is a leap year
    const feb = advanceOneCalendarMonth(jan31_2028, 31);
    assert.equal(iso(feb), "2028-02-29", "leap year: Jan 31 anchored to 31 advances to Feb 29");
    const mar = advanceOneCalendarMonth(feb, 31);
    assert.equal(iso(mar), "2028-03-31", "leap year: Feb 29 must still return to Mar 31");
  }

  // --- Ordinary anchor (18th), the KOLX2026 shape: no clamping ever needed. ---
  {
    const sep18 = epoch(2026, 9, 18);
    assert.equal(iso(advanceOneCalendarMonth(sep18, 18)), "2026-10-18");
  }

  // --- THE CRITICAL CORRECTION: actual payment date must NEVER become
  // the seed for the next expected cycle. A Sep 22 payment must still
  // produce Oct 18 as the next cycle, never Oct 22. ---
  {
    const sep18 = epoch(2026, 9, 18);
    // advanceOneCalendarMonth only ever takes the ANCHOR day (18), never
    // an actual payment's own day (22) -- proven by construction: the
    // function signature has no payment-date parameter at all. This
    // assertion documents the guarantee directly.
    assert.equal(iso(advanceOneCalendarMonth(sep18, 18)), "2026-10-18", "advancing from the Sep 18 anchor must produce Oct 18, never Oct 22, regardless of when any actual payment landed");
  }

  console.log("advanceOneCalendarMonth checks passed.");

  // --- enumerateExpectedCycles: ascending, includes the anchor, stops
  // once throughAt is reached. ---
  {
    const anchor = epoch(2026, 9, 18);
    const cycles = enumerateExpectedCycles(anchor, 18, epoch(2027, 1, 1));
    assert.deepEqual(cycles.map(iso), ["2026-09-18", "2026-10-18", "2026-11-18", "2026-12-18", "2027-01-18"]);
  }

  // --- matchPaymentsToCycles: THE CRITICAL CORRECTNESS TEST. Expected
  // Jan 15 / Feb 15 / Mar 15, only ONE actual payment (Mar 16). Must NOT
  // satisfy all three -- must satisfy Mar only, leaving Jan/Feb
  // unsatisfied. This is exactly the flaw the task asked to be audited
  // and fixed before implementation. ---
  {
    const cycles = [epoch(2026, 1, 15), epoch(2026, 2, 15), epoch(2026, 3, 15)];
    const payments = [epoch(2026, 3, 16)];
    const satisfied = matchPaymentsToCycles(cycles, payments);
    assert.deepEqual(satisfied, [false, false, true], "a single late payment must satisfy ONLY the one cycle whose window it actually falls in -- Jan and Feb must remain unsatisfied, never silently erased by a later payment");
  }

  // --- The counterpart: three cycles, three genuinely corresponding
  // payments (each within its own cycle's window) -- all three must be
  // satisfied individually. ---
  {
    const cycles = [epoch(2026, 1, 15), epoch(2026, 2, 15), epoch(2026, 3, 15)];
    const payments = [epoch(2026, 1, 14), epoch(2026, 2, 17), epoch(2026, 3, 16)];
    const satisfied = matchPaymentsToCycles(cycles, payments);
    assert.deepEqual(satisfied, [true, true, true], "three genuinely separate, individually-timely payments must satisfy all three cycles independently");
  }

  // --- One payment can never satisfy two cycles even if it happens to
  // fall in the mathematical midpoint -- windows are proven non-
  // overlapping for any monthly cadence, so this is structurally
  // impossible, verified directly regardless. ---
  {
    const cycles = [epoch(2026, 1, 15), epoch(2026, 2, 15)];
    const payments = [epoch(2026, 1, 22)]; // right at the edge of Jan's grace window (15+7)
    const satisfied = matchPaymentsToCycles(cycles, payments);
    assert.deepEqual(satisfied, [true, false], "a payment at the edge of one cycle's grace window must satisfy only that cycle");
  }

  // --- Multiple payments in one month: MAX-equivalent behavior at the
  // matching level -- the later one is used if the earlier one doesn't
  // fall in any cycle's window, but a single cycle is still only ever
  // satisfied once. ---
  {
    const cycles = [epoch(2026, 3, 15)];
    const payments = [epoch(2026, 3, 10), epoch(2026, 3, 20)]; // both within +/-7 of Mar 15
    const satisfied = matchPaymentsToCycles(cycles, payments);
    assert.deepEqual(satisfied, [true], "two payments both falling in the same cycle's window must still satisfy it only once (not an error, not double-counted)");
  }

  // --- Catch-up: two DISTINCT payments, each independently within a
  // DIFFERENT outstanding cycle's window, correctly satisfy both. ---
  {
    const cycles = [epoch(2026, 2, 15), epoch(2026, 3, 15)];
    const payments = [epoch(2026, 2, 20), epoch(2026, 3, 14)]; // each within its own cycle's window
    const satisfied = matchPaymentsToCycles(cycles, payments);
    assert.deepEqual(satisfied, [true, true], "two distinct payments each within their own cycle's window must satisfy both cycles independently");
  }

  // --- Grace boundary: exactly at grace is satisfied; one day beyond is not. ---
  {
    const cycle = epoch(2026, 9, 18);
    const exactlyAtGrace = cycle + MONTHLY_PAYMENT_PLAN_GRACE_DAYS * DAY;
    const oneDayBeyond = exactlyAtGrace + DAY;
    assert.deepEqual(matchPaymentsToCycles([cycle], [exactlyAtGrace]), [true], "a payment exactly at the 7-day grace boundary must still satisfy the cycle (inclusive)");
    assert.deepEqual(matchPaymentsToCycles([cycle], [oneDayBeyond]), [false], "a payment one day beyond the grace boundary must not satisfy that specific cycle via this window check");
  }

  console.log("matchPaymentsToCycles checks passed (including the critical multi-cycle correction).");

  // --- evaluatePaymentPlan: the full worked KOLX2026 scenarios. ---
  const kolxPlan = { nextExpectedPaymentAt: epoch(2026, 9, 18), expectedDayOfMonth: 18, finalExpectedPaymentAt: epoch(2027, 5, 18), endedAt: null };

  // Aug 19 (day after the real Aug 18 payment) -- on track.
  {
    const now = epoch(2026, 8, 19);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 1350000, now);
    assert.equal(evalResult.isOnTrack, true, "Aug 19 after the Aug 18 payment must be on track");
    assert.equal(evalResult.isLate, false);
    assert.equal(evalResult.daysLate, 0);
    assert.equal(iso(evalResult.nextUnsatisfiedExpectedPaymentAt), "2026-09-18");
    assert.equal(iso(evalResult.latestActualPaymentAt), "2026-08-18");
    assert.equal(evalResult.balanceRemainingCents, 1350000);
  }

  // Sep 17 -- one day before expected -- still on track.
  {
    const now = epoch(2026, 9, 17);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 1350000, now);
    assert.equal(evalResult.isOnTrack, true);
  }

  // Sep 18 -- exactly on the expected date, no September payment yet -- on track.
  {
    const now = epoch(2026, 9, 18);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 1350000, now);
    assert.equal(evalResult.isOnTrack, true);
    assert.equal(evalResult.daysLate, 0);
  }

  // Sep 25 -- exactly 7 days after expected, no September payment -- still on track (grace inclusive).
  {
    const now = epoch(2026, 9, 25);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 1350000, now);
    assert.equal(evalResult.isOnTrack, true, "exactly at the grace boundary must still be on track");
    assert.equal(evalResult.daysLate, 0);
  }

  // Sep 26 -- 8 days after expected, no September payment -- LATE.
  {
    const now = epoch(2026, 9, 26);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 1350000, now);
    assert.equal(evalResult.isLate, true, "one day past the grace boundary must be late");
    assert.equal(evalResult.daysLate, 1);
    assert.equal(evalResult.isOnTrack, false);
  }

  // Sep 22 -- a payment arrives that day, within grace -- on track, next cycle becomes Oct 18.
  {
    const now = epoch(2026, 9, 22);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18), epoch(2026, 9, 22)], 1350000, now);
    assert.equal(evalResult.isOnTrack, true, "a within-grace September payment must be on track");
    assert.equal(iso(evalResult.nextUnsatisfiedExpectedPaymentAt), "2026-10-18", "the next cycle must be Oct 18, computed from the fixed anchor day, not Sep 22 + ~1 month (which would be Oct 22)");
  }

  // October, after that Sep 22 payment: proves no drift at a later date too.
  {
    const now = epoch(2026, 10, 1);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18), epoch(2026, 9, 22)], 1350000, now);
    assert.equal(iso(evalResult.nextUnsatisfiedExpectedPaymentAt), "2026-10-18", "October's expected date must remain the 18th, never drift toward the 22nd because of when the September payment actually landed");
    assert.equal(evalResult.isOnTrack, true, "not yet due for October, still on track");
  }

  // Final date (May 18, 2027) with $0 balance -- completed.
  {
    const now = epoch(2027, 6, 1);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 0, now);
    assert.equal(evalResult.isCompleted, true);
    assert.equal(evalResult.isPlanEndedWithBalance, false, "a fully-paid pledge must never also read as ended-with-balance");
  }

  // Final date (May 18, 2027) with $3,000 remaining -- plan ended with balance.
  {
    const now = epoch(2027, 6, 1);
    const evalResult = evaluatePaymentPlan(kolxPlan, [epoch(2026, 8, 18)], 300000, now);
    assert.equal(evalResult.finalDatePassed, true);
    assert.equal(evalResult.isPlanEndedWithBalance, true);
    assert.equal(evalResult.isOnTrack, false, "past the final date, on-track suppression must never apply regardless of otherwise-current cycle satisfaction");
  }

  console.log("evaluatePaymentPlan KOLX2026 worked-example checks passed.");

  // --- THE CRITICAL MULTIPLE-MISSED-CYCLE TEST, at the full
  // evaluatePaymentPlan level (not just matchPaymentsToCycles). Expected
  // Jan 15 / Feb 15 / Mar 15, only one payment (Mar 16). ---
  {
    const plan = { nextExpectedPaymentAt: epoch(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: epoch(2027, 1, 15), endedAt: null };
    const now = epoch(2026, 4, 1);
    const evalResult = evaluatePaymentPlan(plan, [epoch(2026, 3, 16)], 500000, now);
    assert.equal(iso(evalResult.nextUnsatisfiedExpectedPaymentAt), "2026-01-15", "the FIRST unsatisfied cycle must be January -- the single March payment must not have silently satisfied it");
    assert.equal(evalResult.isLate, true, "with January still unsatisfied and well past grace, the plan must read as late");
    assert.ok(evalResult.daysLate > 60, "days late must be measured from the earliest missed cycle (January), not reset by the March payment");
  }

  // --- Counterpart: three cycles, three individually-timely payments --
  // all satisfied, on track. ---
  {
    const plan = { nextExpectedPaymentAt: epoch(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: epoch(2027, 1, 15), endedAt: null };
    const now = epoch(2026, 4, 1);
    const evalResult = evaluatePaymentPlan(plan, [epoch(2026, 1, 14), epoch(2026, 2, 17), epoch(2026, 3, 16)], 500000, now);
    assert.equal(evalResult.isOnTrack, true, "three genuinely separate, individually-timely payments must read as fully on track");
    assert.equal(evalResult.isLate, false);
  }

  console.log("Multiple-missed-cycle correctness checks passed.");

  // --- Payments preceding plan creation still count normally -- no
  // special handling needed, confirmed directly. ---
  {
    const plan = { nextExpectedPaymentAt: epoch(2026, 9, 18), expectedDayOfMonth: 18, finalExpectedPaymentAt: epoch(2027, 5, 18), endedAt: null };
    const now = epoch(2026, 8, 19);
    // A payment from months before the plan's own anchor is simply
    // irrelevant to any enumerated cycle (all enumerated cycles start at
    // the anchor) -- it neither helps nor hurts.
    const evalResult = evaluatePaymentPlan(plan, [epoch(2026, 1, 5)], 1350000, now);
    assert.equal(evalResult.isOnTrack, true, "a historical payment predating the plan's anchor must not cause incorrect behavior");
  }

  // --- Ended plan: never on track, never late -- evaluation is inert
  // once ended_at is set (regardless of cycle math). ---
  {
    const plan = { nextExpectedPaymentAt: epoch(2026, 9, 18), expectedDayOfMonth: 18, finalExpectedPaymentAt: epoch(2027, 5, 18), endedAt: epoch(2026, 10, 1) };
    const now = epoch(2026, 11, 1);
    const evalResult = evaluatePaymentPlan(plan, [], 1350000, now);
    assert.equal(evalResult.isOnTrack, false, "an ended plan must never read as on track");
    assert.equal(evalResult.isLate, false, "an ended plan must never read as late either -- it simply stops mattering");
    assert.equal(evalResult.isPlanEndedWithBalance, false);
  }

  // --- Payment amount is never inspected -- evaluatePaymentPlan doesn't
  // even accept an amount parameter for payments, only dates. Confirmed
  // structurally: the function signature itself has no amount input. ---
  assert.equal(evaluatePaymentPlan.length, 4, "evaluatePaymentPlan must accept exactly (plan, paymentDates, balanceCents, now) -- no payment-amount parameter exists to be inspected");

  console.log("Edge-case checks passed.");
}

run();
