import assert from "node:assert/strict";
import { derivePaymentPlanDisplayStatus, buildInstallmentTimeline } from "../lib/relationships/payment-plan-display.ts";
import { evaluatePaymentPlan, enumerateExpectedCycles, MONTHLY_PAYMENT_PLAN_GRACE_DAYS } from "../lib/relationships/pledge-payment-plan.ts";

const TZ = "America/New_York";
const anchor = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

// --- derivePaymentPlanDisplayStatus: every status, derived strictly from
// evaluatePaymentPlan's own output, never a second calculation. ---

// Completed: balance fully paid.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 6, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 3, 1);
  const payments = [anchor(2026, 1, 15), anchor(2026, 2, 15)];
  const evaluation = evaluatePaymentPlan(plan, payments, 0, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, 0), "completed");
}

// Needs Review: plan's own final date passed with balance still open.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 2, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 4, 1);
  const evaluation = evaluatePaymentPlan(plan, [anchor(2026, 1, 15)], 10_000_00, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, 10_000_00), "needs_review");
}

// Needs Review (defensive): an inconsistent record -- negative balance --
// must never be dressed up as a confident status.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 6, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 2, 1);
  const evaluation = evaluatePaymentPlan(plan, [anchor(2026, 1, 15)], -500, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, -500), "needs_review");
}

// Overdue: a genuinely missed cycle, past its grace window.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 6, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 2, 1); // Jan 15 cycle, grace through Jan 22 -- now Feb 1 is well past grace, no payment ever made
  const evaluation = evaluatePaymentPlan(plan, [], 50_000_00, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, 50_000_00), "overdue");
}

// Payment Due: the cycle date has arrived but the grace window hasn't
// expired yet -- due, not late.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 1, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 6, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 1, 16); // one day after the cycle date, well within the 7-day grace
  const evaluation = evaluatePaymentPlan(plan, [], 50_000_00, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, 50_000_00), "payment_due");
}

// Upcoming Payment: next cycle is within the display window but not yet
// due.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 2, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 6, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 2, 5); // 10 days before the Feb 15 cycle
  const evaluation = evaluatePaymentPlan(plan, [], 50_000_00, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, 50_000_00), "upcoming_payment");
}

// On Track: next cycle is far enough out.
{
  const plan = { nextExpectedPaymentAt: anchor(2026, 4, 15), expectedDayOfMonth: 15, finalExpectedPaymentAt: anchor(2026, 12, 15), endedAt: null, installmentAmountCents: 10_000_00 };
  const now = anchor(2026, 2, 1);
  const evaluation = evaluatePaymentPlan(plan, [], 100_000_00, now, TZ);
  assert.equal(derivePaymentPlanDisplayStatus(evaluation, 100_000_00), "on_track");
}

// --- buildInstallmentTimeline: future installments are never marked
// overdue, unsatisfied cycles are never trimmed, long plans stay capped. ---

{
  const cycles = enumerateExpectedCycles(anchor(2026, 1, 15), 15, anchor(2026, 12, 15));
  const satisfied = cycles.map((c) => c <= anchor(2026, 3, 15)); // first three cycles paid, rest not yet due
  const nowDateOnly = anchor(2026, 3, 20);
  const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
  const future = entries.filter((e) => e.dueAt > nowDateOnly);
  assert.ok(future.every((e) => e.state === "upcoming" || e.state === "future"), "a future cycle must never be marked overdue");
  assert.equal(entries.filter((e) => e.state === "upcoming").length, 1, "exactly one cycle is 'the next upcoming' one");
  assert.ok(!entries.some((e) => e.state === "overdue"), "nothing is actually overdue in this scenario");
}

// A genuinely missed cycle (due, unsatisfied) must show as overdue, never
// silently hidden or recategorized as upcoming.
{
  const cycles = enumerateExpectedCycles(anchor(2026, 1, 15), 15, anchor(2026, 6, 15));
  const satisfied = cycles.map(() => false);
  const nowDateOnly = anchor(2026, 3, 1); // Jan 15 and Feb 15 cycles are both past-due and unpaid
  const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
  const overdue = entries.filter((e) => e.state === "overdue");
  assert.equal(overdue.length, 2, "both missed cycles must show as overdue, never merged into one or dropped");
}

// Grace-period consistency fix (2026-10-15, independent review): an
// unsatisfied installment must never be labeled "overdue" in the timeline
// while it is still within MONTHLY_PAYMENT_PLAN_GRACE_DAYS of its own due
// date -- the exact same boundary evaluation.isLate/daysLate uses. On the
// due date itself and through every day of the grace window, the tick
// must read "due," never "overdue"; only once the grace period has
// genuinely elapsed does it flip to "overdue."
{
  const cycles = [anchor(2026, 1, 15)];
  const satisfied = [false];

  // The due date itself.
  {
    const nowDateOnly = anchor(2026, 1, 15);
    const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
    assert.equal(entries[0].state, "due", "on the due date itself, an unsatisfied installment must read 'due,' not 'overdue'");
  }

  // Every single day of the grace period (day 1 through
  // MONTHLY_PAYMENT_PLAN_GRACE_DAYS, inclusive) must still read "due."
  for (let daysAfterDue = 1; daysAfterDue <= MONTHLY_PAYMENT_PLAN_GRACE_DAYS; daysAfterDue++) {
    const nowDateOnly = cycles[0] + daysAfterDue * 86400;
    const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
    assert.equal(entries[0].state, "due", `day ${daysAfterDue} of the grace period must still read 'due,' not 'overdue'`);
  }

  // The day immediately after the grace period expires: genuinely late.
  {
    const nowDateOnly = cycles[0] + (MONTHLY_PAYMENT_PLAN_GRACE_DAYS + 1) * 86400;
    const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
    assert.equal(entries[0].state, "overdue", "the day after the grace period expires, an unsatisfied installment must read 'overdue'");
  }

  // Well past the grace period: still overdue, never reverts.
  {
    const nowDateOnly = cycles[0] + 30 * 86400;
    const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
    assert.equal(entries[0].state, "overdue", "well past the grace period, the installment must remain 'overdue'");
  }
}

// The grace-period fix must never relabel an already-satisfied cycle, and
// must never affect a cycle that is not yet due at all.
{
  const cycles = [anchor(2026, 1, 15), anchor(2026, 2, 15)];
  const satisfied = [true, false];
  const nowDateOnly = anchor(2026, 1, 16); // one day after Jan 15 (paid); Feb 15 not yet due
  const { entries } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
  assert.equal(entries[0].state, "paid");
  assert.equal(entries[1].state, "upcoming");
}

// Long plan (60-cycle cap): the timeline stays capped, but no unsatisfied
// cycle is ever the one trimmed away.
{
  const cycles = enumerateExpectedCycles(anchor(2021, 1, 15), 15, anchor(2026, 12, 15)); // ~5 years, hits the enumeration cap
  const satisfied = cycles.map((c, i) => i < cycles.length - 3); // all paid except the last 3
  const nowDateOnly = anchor(2026, 10, 1);
  const { entries, hiddenBeforeCount } = buildInstallmentTimeline({ cycles, satisfied }, nowDateOnly, 6);
  assert.ok(entries.length < cycles.length, "a long plan's timeline must be trimmed, not rendered in full");
  assert.ok(hiddenBeforeCount > 0);
  assert.equal(entries.filter((e) => e.state !== "paid").length, cycles.filter((_, i) => !satisfied[i]).length, "every unsatisfied cycle must survive the trim -- only satisfied/paid cycles are ever trimmed");
}

process.stdout.write("payment-plan-display.test.mjs: all assertions passed\n");
