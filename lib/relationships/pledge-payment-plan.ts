// Pure, testable calendar-month arithmetic and expected-vs-actual
// evaluation for the pledge payment-plan feature. No D1 access. See
// docs/PLEDGE-PAYMENT-PLAN-DESIGN.md for the full design and reasoning.
//
// CRITICAL CORRECTNESS PROPERTY, audited and proven before implementation
// (see docs/AI-HANDOFF.md): a single actual payment must satisfy AT MOST
// ONE expected cycle, never several missed cycles at once merely because
// its date is later than all of them (e.g. expected Jan 15/Feb 15/Mar 15
// with only one real payment on Mar 16 must leave Jan and Feb
// unsatisfied/late -- it must not "erase" them). This is enforced
// structurally, not by convention: matchPaymentsToCycles() below assigns
// each payment to at most one cycle and each cycle to at most one
// payment, using a deterministic, unambiguous greedy match --
// unambiguous because monthly cycles are always >=28 days apart (the
// shortest possible gap, Jan 31 -> Feb 28) and the grace window is only
// +/-7 days (14 days wide, well under 28), so two cycles' windows can
// never overlap. There is only ever one possible valid assignment for
// any given payment, never a choice this code could get wrong.

import { isLeapYear, maxPossibleDaysInMonth } from "../calendar/gregorian-recurring-date.ts";

export const MONTHLY_PAYMENT_PLAN_GRACE_DAYS = 7;
// Defensive bound on how many monthly cycles to enumerate from a plan's
// anchor -- not a normal-operation limit (a real plan paying monthly for
// 5 years just enumerates 60 cheap steps, computationally trivial);
// guards only against corrupted or absurd anchor data.
export const PLEDGE_PAYMENT_CYCLE_ENUMERATION_CAP = 60;

const DAY_SECONDS = 86400;
const daysBetween = (laterEpoch: number, earlierEpoch: number) => Math.max(0, Math.floor((laterEpoch - earlierEpoch) / DAY_SECONDS));

function daysInSpecificMonth(year: number, month: number): number {
  // maxPossibleDaysInMonth(2) always returns 29 (the widest possible
  // February across any year) -- correct for validating a stored (month,
  // day) independent of year, but wrong for clamping into one SPECIFIC
  // target year's February, which is why isLeapYear() decides Feb here.
  // Every other month's real day count never varies by year, so
  // maxPossibleDaysInMonth is already exact for them.
  return month === 2 ? (isLeapYear(year) ? 29 : 28) : maxPossibleDaysInMonth(month);
}

function utcDateParts(dateOnlyEpoch: number): { year: number; month: number; day: number } {
  const d = new Date(dateOnlyEpoch * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function toDateOnlyEpoch(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000);
}

// The day-of-month component of a date-only epoch -- the ONLY place a
// caller should derive expected_day_of_month from, and only from the
// fundraiser's own freshly-entered next-expected-payment date, never
// re-derived later from a value that may already have been
// calendar-clamped (see docs/PLEDGE-PAYMENT-PLAN-DESIGN.md §4/§8 for why
// that would be lossy once a February has passed).
export function dayOfMonthFromDateOnlyEpoch(dateOnlyEpochValue: number): number {
  return utcDateParts(dateOnlyEpochValue).day;
}

// Advances a date-only epoch by exactly one calendar month, clamping to
// the FIXED anchorDay -- never to fromDateOnlyEpoch's own (possibly
// already-clamped) day. This is the entire mechanism that makes
// Feb 28 -> Mar 31 correct instead of permanently drifting to
// Feb 28 -> Mar 28: every step re-targets the true anchor day, never the
// previous step's clamped result.
export function advanceOneCalendarMonth(fromDateOnlyEpoch: number, anchorDay: number): number {
  const { year, month } = utcDateParts(fromDateOnlyEpoch);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const clampedDay = Math.min(anchorDay, daysInSpecificMonth(nextYear, nextMonth));
  return toDateOnlyEpoch(nextYear, nextMonth, clampedDay);
}

// Enumerates expected cycle dates starting at anchorAt (inclusive),
// advancing by advanceOneCalendarMonth each step, stopping once a cycle
// reaches or passes throughAt or the enumeration cap is hit. Ascending
// order; always includes at least one entry (anchorAt itself).
export function enumerateExpectedCycles(anchorAt: number, anchorDay: number, throughAt: number): number[] {
  const cycles: number[] = [anchorAt];
  let cycle = anchorAt;
  let iterations = 0;
  while (cycle < throughAt && iterations < PLEDGE_PAYMENT_CYCLE_ENUMERATION_CAP) {
    cycle = advanceOneCalendarMonth(cycle, anchorDay);
    cycles.push(cycle);
    iterations += 1;
  }
  return cycles;
}

// Matches actual payment dates to expected cycles: each payment
// satisfies at most one cycle, each cycle is satisfied by at most one
// payment. Cycles are processed in the given (ascending) order; for each
// one, the earliest not-yet-used payment falling within
// [cycle - graceDays, cycle + graceDays] satisfies it. Returns a
// boolean per cycle, same order/length as `cycles`. See the file header
// for why this greedy match is provably unambiguous for a monthly
// cadence -- there is no scenario where a different assignment order
// changes the result.
export function matchPaymentsToCycles(cycles: number[], payments: number[], graceDays: number = MONTHLY_PAYMENT_PLAN_GRACE_DAYS): boolean[] {
  const graceSeconds = graceDays * DAY_SECONDS;
  const sortedPayments = [...payments].sort((a, b) => a - b);
  const used = new Array<boolean>(sortedPayments.length).fill(false);
  return cycles.map((cycle) => {
    for (let i = 0; i < sortedPayments.length; i++) {
      if (used[i]) continue;
      const payment = sortedPayments[i];
      if (payment >= cycle - graceSeconds && payment <= cycle + graceSeconds) {
        used[i] = true;
        return true;
      }
    }
    return false;
  });
}

export type PaymentPlanFields = {
  nextExpectedPaymentAt: number;
  expectedDayOfMonth: number;
  finalExpectedPaymentAt: number;
  endedAt: number | null;
};

export type PaymentPlanEvaluation = {
  // The earliest cycle still due and unsatisfied, if any; otherwise the
  // next upcoming (not-yet-due) cycle, for display ("Next expected: ...").
  nextUnsatisfiedExpectedPaymentAt: number | null;
  latestActualPaymentAt: number | null;
  isOnTrack: boolean;
  isLate: boolean;
  daysLate: number;
  finalDatePassed: boolean;
  isPlanEndedWithBalance: boolean;
  isCompleted: boolean;
  balanceRemainingCents: number;
};

// The single entry point every caller (Today, donor page, Meeting Brief)
// should use. Pure -- takes already-fetched facts (the plan's own
// stored fields, every linked-payment date for THIS pledge, the
// pledge's real JL balance, and now), returns derived facts. Never
// accesses D1, never persists anything -- matches the design's own
// "prefer deriving over storing computed state" discipline.
export function evaluatePaymentPlan(plan: PaymentPlanFields, linkedPaymentDates: number[], balanceCents: number, now: number): PaymentPlanEvaluation {
  const isActive = plan.endedAt === null;
  // Derived directly from the live JL balance -- never from the plan's
  // own stored state. A fully-paid pledge is "complete" regardless of
  // whether ended_at was ever set (see the paid-off behavior decision:
  // ended_at is only ever an explicit fundraiser action).
  const isCompleted = balanceCents <= 0;
  const finalDatePassed = now > plan.finalExpectedPaymentAt;
  const latestActualPaymentAt = linkedPaymentDates.length > 0 ? Math.max(...linkedPaymentDates) : null;

  const cycles = enumerateExpectedCycles(plan.nextExpectedPaymentAt, plan.expectedDayOfMonth, Math.max(now, plan.finalExpectedPaymentAt));
  const satisfied = matchPaymentsToCycles(cycles, linkedPaymentDates);
  const firstUnsatisfiedDueIndex = cycles.findIndex((cycle, index) => cycle <= now && !satisfied[index]);
  const nextUnsatisfiedExpectedPaymentAt = firstUnsatisfiedDueIndex !== -1
    ? cycles[firstUnsatisfiedDueIndex]
    : (cycles.find((cycle) => cycle > now) ?? null);

  const evaluableForLateness = isActive && !isCompleted && !finalDatePassed;
  const daysLate = evaluableForLateness && firstUnsatisfiedDueIndex !== -1
    ? Math.max(0, daysBetween(now, cycles[firstUnsatisfiedDueIndex]) - MONTHLY_PAYMENT_PLAN_GRACE_DAYS)
    : 0;
  const isLate = daysLate > 0;
  const isOnTrack = evaluableForLateness && !isLate;
  const isPlanEndedWithBalance = isActive && finalDatePassed && !isCompleted;

  return {
    nextUnsatisfiedExpectedPaymentAt,
    latestActualPaymentAt,
    isOnTrack,
    isLate,
    daysLate,
    finalDatePassed,
    isPlanEndedWithBalance,
    isCompleted,
    balanceRemainingCents: balanceCents,
  };
}
