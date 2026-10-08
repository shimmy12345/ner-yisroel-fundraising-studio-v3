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
import { localDateOnlyEpoch } from "../workspace/local-time.ts";

// Timezone normalization (2026-10-08, see docs/AI-HANDOFF.md's "Verification
// of User-Applied Final-Date Corrections" entry for the full investigation
// that found this). Every date this module compares `now` against --
// `finalExpectedPaymentAt`, every enumerated cycle, a newly-entered plan
// anchor -- is a DATE-ONLY value, always encoded as UTC midnight of the
// intended calendar date (lib/financial-date.ts's own convention). `now`
// itself, when passed in raw (`Math.floor(Date.now() / 1000)`, as every
// real caller ultimately sources it), is a continuously-advancing instant
// with a real time-of-day component. Comparing those two directly is
// exactly the anti-pattern lib/workspace/local-time.ts's own
// localDateOnlyEpoch() doc comment warns against: because the fundraiser's
// business timezone (America/New_York) is 4-5 hours behind UTC, a date-only
// value's UTC-midnight boundary falls in the Eastern EVENING of the
// PRECEDING calendar day -- so any daysUntilFinal/milestone/lateness
// transition computed from the raw instant flips about 4-5 hours too early,
// which for any normal daytime use (including the Daily Agenda's own 9 AM
// Eastern send) lands the transition on the wrong Eastern calendar day
// entirely (one day early). Every function below that compares `now`
// against a date-only field first normalizes it via this one helper --
// never a second, ad hoc normalization, and never comparing a raw instant
// to a date-only value directly.
function today(now: number, timezone: string): number {
  return localDateOnlyEpoch(now, timezone);
}

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
  // Signed day count to the final expected date (negative = already
  // past). Exposed so callers building milestone/"ending soon" signals
  // never recompute this from the raw field themselves.
  daysUntilFinal: number;
  // Fires on the EXACT day count only (15, 10, or 5 days before the
  // final expected date) -- deliberately not "within 15 days," per the
  // product decision that these are discrete milestones, not a repeating
  // window. Only meaningful while the plan is still genuinely open
  // (active, not completed, final date not yet passed) -- null
  // otherwise, so a caller never has to separately re-check those
  // conditions. Checked in descending order (15 before 10 before 5) but
  // the three day counts can never coincide for one plan, so order is
  // cosmetic.
  milestoneDaysBefore: 15 | 10 | 5 | null;
  // The plan's final expected date has been reached or passed AND the
  // pledge is fully paid (balanceCents <= 0) -- the "existing commitment
  // fulfilled, consider the next one" signal. Deliberately independent
  // of `endedAt`/`isActive`: per the product decision, this must not
  // fail merely because the fundraiser never clicked "End plan" (see
  // docs/AI-HANDOFF.md's payment-plan-intelligence entries). Mutually
  // exclusive with isPlanEndedWithBalance by construction -- one
  // requires balanceCents > 0, the other balanceCents <= 0.
  isFulfilledAfterFinal: boolean;
};

// The single entry point every caller (Today, donor page, Meeting Brief,
// Portfolio Focus, Fundraising Intelligence, Daily Agenda) should use.
// Pure -- takes already-fetched facts (the plan's own stored fields, every
// linked-payment date for THIS pledge, the pledge's real JL balance, now,
// and the fundraiser's business timezone), returns derived facts. Never
// accesses D1, never persists anything -- matches the design's own
// "prefer deriving over storing computed state" discipline. `now` is
// normalized to the fundraiser's own Eastern calendar date exactly once,
// at the top, via today() -- every comparison below uses that normalized
// value, never the raw `now` directly (see today()'s own doc comment for
// why).
export function evaluatePaymentPlan(plan: PaymentPlanFields, linkedPaymentDates: number[], balanceCents: number, now: number, timezone: string): PaymentPlanEvaluation {
  const nowDateOnly = today(now, timezone);
  const isActive = plan.endedAt === null;
  // Derived directly from the live JL balance -- never from the plan's
  // own stored state. A fully-paid pledge is "complete" regardless of
  // whether ended_at was ever set (see the paid-off behavior decision:
  // ended_at is only ever an explicit fundraiser action).
  const isCompleted = balanceCents <= 0;
  const finalDatePassed = nowDateOnly > plan.finalExpectedPaymentAt;
  const latestActualPaymentAt = linkedPaymentDates.length > 0 ? Math.max(...linkedPaymentDates) : null;

  const cycles = enumerateExpectedCycles(plan.nextExpectedPaymentAt, plan.expectedDayOfMonth, Math.max(nowDateOnly, plan.finalExpectedPaymentAt));
  const satisfied = matchPaymentsToCycles(cycles, linkedPaymentDates);
  const firstUnsatisfiedDueIndex = cycles.findIndex((cycle, index) => cycle <= nowDateOnly && !satisfied[index]);
  const nextUnsatisfiedExpectedPaymentAt = firstUnsatisfiedDueIndex !== -1
    ? cycles[firstUnsatisfiedDueIndex]
    : (cycles.find((cycle) => cycle > nowDateOnly) ?? null);

  const evaluableForLateness = isActive && !isCompleted && !finalDatePassed;
  const daysLate = evaluableForLateness && firstUnsatisfiedDueIndex !== -1
    ? Math.max(0, daysBetween(nowDateOnly, cycles[firstUnsatisfiedDueIndex]) - MONTHLY_PAYMENT_PLAN_GRACE_DAYS)
    : 0;
  const isLate = daysLate > 0;
  const isOnTrack = evaluableForLateness && !isLate;
  const isPlanEndedWithBalance = isActive && finalDatePassed && !isCompleted;

  // Signed -- negative once the final date has passed. Deliberately NOT
  // daysBetween() (which clamps to >=0): callers need to tell "15 days
  // before" from "15 days after," and this is the one place that
  // distinction is computed, so no caller re-derives it independently.
  // Both operands are now UTC-midnight date-only values (nowDateOnly and
  // finalExpectedPaymentAt), so this is always an exact whole-day count --
  // Math.floor is defensive, not load-bearing, now that there is no
  // fractional time-of-day component left to round away.
  const daysUntilFinal = Math.floor((plan.finalExpectedPaymentAt - nowDateOnly) / DAY_SECONDS);
  // Milestones only fire on the exact day, and only while the plan is
  // genuinely ON TRACK (not merely "not yet past final") -- a plan that
  // is already late, completed, ended, or past its final date never also
  // reports a milestone; a KNOW-tier "ending in 5 days" alongside an
  // already-overdue DO item would be redundant and confusing. See
  // isPlanEndedWithBalance/isFulfilledAfterFinal for those other states.
  const milestoneDaysBefore: 15 | 10 | 5 | null = isOnTrack && (daysUntilFinal === 15 || daysUntilFinal === 10 || daysUntilFinal === 5)
    ? (daysUntilFinal as 15 | 10 | 5)
    : null;
  // "Reached/passed" -- >=, not the strict > finalDatePassed uses -- so a
  // pledge that's already fully paid by its own final day qualifies
  // immediately, not one day later. Independent of isActive/endedAt by
  // design (see the type's own doc comment).
  const isFulfilledAfterFinal = nowDateOnly >= plan.finalExpectedPaymentAt && isCompleted;

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
    daysUntilFinal,
    milestoneDaysBefore,
    isFulfilledAfterFinal,
  };
}

// Corrects a newly-entered next-expected-payment anchor that is already
// in the past relative to `now` -- the "born late" problem: a plan
// created today with a fundraiser-entered anchor from weeks earlier
// would otherwise evaluate as immediately overdue the moment it's
// saved, before the fundraiser has had any chance to receive a payment
// against the new schedule. Only ever called at CREATION time, never on
// edit (an explicit edit may legitimately re-anchor into the past -- see
// docs/AI-HANDOFF.md). Advances by real calendar months, preserving the
// fundraiser's own entered day-of-month as the fixed anchor (via
// advanceOneCalendarMonth, never drifting to a clamped day) until the
// cycle is today or later -- so "the 24th of every month" stays the
// 24th, it just starts from the first 24th that hasn't happened yet.
// Never invents a date out of nothing -- if the entered date is already
// today or in the future, it is returned completely unchanged. `now` is
// normalized to the fundraiser's own Eastern calendar date via today()
// before comparison -- see that function's own doc comment -- so "today"
// here means the fundraiser's real Eastern calendar date, not a raw UTC
// instant.
export function adjustNewPlanAnchorForPastDate(enteredNextExpectedPaymentAt: number, now: number, timezone: string): number {
  const nowDateOnly = today(now, timezone);
  const anchorDay = dayOfMonthFromDateOnlyEpoch(enteredNextExpectedPaymentAt);
  let cycle = enteredNextExpectedPaymentAt;
  let iterations = 0;
  while (cycle < nowDateOnly && iterations < PLEDGE_PAYMENT_CYCLE_ENUMERATION_CAP) {
    cycle = advanceOneCalendarMonth(cycle, anchorDay);
    iterations += 1;
  }
  return cycle;
}

export type PledgeRenewalEvaluation = {
  // The plan's own renewal date -- originalPledgeDate advanced by
  // EXACTLY commitmentDurationMonths calendar months (never a hardcoded
  // 12 -- see this function's own doc comment below for why). Null
  // whenever not eligible at all (see below). Always the FIRST renewal
  // opportunity; this module deliberately has no concept of a second/
  // third recurrence (no perpetual renewal without a separately approved
  // recurrence policy).
  renewalDate: number | null;
  fiveDayReminderDate: number | null;
  isFiveDayReminder: boolean;
  isRenewalDateReminder: boolean;
};

// Pledge Renewal Reminders (2026-10-08, corrected 2026-10-08 to depend on
// a verified COMMITMENT DURATION rather than assuming every commitment
// lasts 12 months -- see docs/AI-HANDOFF.md). Eligible ONLY when ALL
// THREE hold: the plan is active (`endedAt === null` -- an explicitly
// ended plan generates no new reminders, matching evaluatePaymentPlan's
// own `isActive` convention), has a fundraiser-VERIFIED
// `originalPledgeDate`, AND has a fundraiser-VERIFIED
// `commitmentDurationMonths` (see lib/capture/pledge-payment-plan.ts's
// validateOriginalPledgeDate/validateCommitmentDurationMonths and docs/
// AI-HANDOFF.md's Phase 1 investigation for why neither is ever
// inferred). Deliberately independent of balance/isCompleted/
// isFulfilledAfterFinal -- a plan that reached its final date naturally,
// fully paid, is NOT "ended" (ended_at is only ever an explicit
// fundraiser action) and remains eligible for its renewal date exactly
// like any other active plan.
//
// CRITICAL: commitmentDurationMonths is the length of the DONOR'S
// COMMITMENT, never the length of the COLLECTION SCHEDULE -- a 12-month
// commitment can be paid over 18 months of installments, or a 6-month
// commitment collected in 3 bimonthly payments. This function never
// looks at installmentAmountCents, expectedDayOfMonth,
// nextExpectedPaymentAt, or finalExpectedPaymentAt at all -- the renewal
// date depends ONLY on originalPledgeDate + commitmentDurationMonths,
// never on anything about how the money is actually collected.
//
// Computes ONLY the first renewal -- commitmentDurationMonths calendar-
// month advances from originalPledgeDate, reusing advanceOneCalendarMonth
// (the SAME anti-drift/clamp mechanism next_expected_payment_at cycling
// already uses), which gives this module's explicit, tested February 29/
// month-end-clamping convention for free regardless of duration -- not a
// new rule, the SAME clamp a 31st-anchored monthly cycle already applies
// in a 30-day month, reused unchanged.
//
// `now` is normalized via today() exactly like every other comparison in
// this module -- "five days before" and "on the renewal date" both mean
// the fundraiser's real Eastern calendar date, matching the 2026-10-08
// timezone fix. The five-day/renewal dates themselves are pure date-only
// subtraction (fiveDayReminderDate = renewalDate - 5*86400), never
// timezone-sensitive on their own -- both operands are already
// UTC-midnight date-only values, so this is always an exact 5-calendar-
// day offset regardless of daylight saving.
export function evaluatePledgeRenewal(originalPledgeDate: number | null, commitmentDurationMonths: number | null, endedAt: number | null, now: number, timezone: string): PledgeRenewalEvaluation {
  if (originalPledgeDate === null || commitmentDurationMonths === null || endedAt !== null) {
    return { renewalDate: null, fiveDayReminderDate: null, isFiveDayReminder: false, isRenewalDateReminder: false };
  }
  const anchorDay = dayOfMonthFromDateOnlyEpoch(originalPledgeDate);
  let renewalDate = originalPledgeDate;
  for (let i = 0; i < commitmentDurationMonths; i++) renewalDate = advanceOneCalendarMonth(renewalDate, anchorDay);
  const fiveDayReminderDate = renewalDate - 5 * DAY_SECONDS;
  const nowDateOnly = today(now, timezone);
  return {
    renewalDate,
    fiveDayReminderDate,
    isFiveDayReminder: nowDateOnly === fiveDayReminderDate,
    isRenewalDateReminder: nowDateOnly === renewalDate,
  };
}

export type FulfilledCultivationSourceRow = {
  id: string;
  donor_id: string;
  balance_cents: number | null;
  activity_date: number | null;
  description: string | null;
  item_type: string | null;
  category: string;
};
export type FulfilledCultivationPlanRow = { pledge_activity_id: string; final_expected_payment_at: number };
export type FulfilledCultivationOpportunity = { pledgeActivityId: string; campaign: string | null; description: string | null; finalExpectedPaymentAt: number };

const REAL_COMMITMENT_CATEGORIES = new Set(["open_pledge", "partially_paid_pledge", "completed_gift"]);

// "Existing commitment fulfilled, consider the next one" -- pure derivation,
// no D1 access (the caller, lib/workspace/live-data.ts, already has both
// inputs fetched for other purposes). See
// recommendation-evidence.ts's fulfilledPledgeCultivationOpportunity doc
// comment for the full product reasoning. Candidates: a pledge with
// balance<=0 whose linked plan's final expected date has been
// reached/passed. One slot per donor (the most recently dated such
// pledge) -- suppressed entirely if a newer real commitment (any
// open_pledge/partially_paid_pledge/completed_gift) already exists for
// that donor, so recording a new pledge naturally makes this opportunity
// obsolete without anything needing to track or dismiss it.
export function deriveFulfilledCultivationByDonor(
  givingRows: FulfilledCultivationSourceRow[],
  paymentPlanByPledge: Map<string, FulfilledCultivationPlanRow>,
  now: number,
  timezone: string,
): Map<string, FulfilledCultivationOpportunity> {
  // Same normalization as evaluatePaymentPlan's own isFulfilledAfterFinal
  // (today(), see its doc comment) -- "has the final date arrived" must
  // mean the fundraiser's Eastern calendar date, not a raw UTC instant,
  // or this signal would fire about 4-5 hours (in practice, one Eastern
  // calendar day) earlier than evaluatePaymentPlan's own isFulfilledAfterFinal
  // agrees it should -- the two must never disagree about the same plan.
  const nowDateOnly = today(now, timezone);
  const candidatesByDonor = new Map<string, FulfilledCultivationSourceRow[]>();
  for (const item of givingRows) {
    if ((item.balance_cents ?? 0) > 0) continue;
    const plan = paymentPlanByPledge.get(item.id);
    if (!plan || plan.final_expected_payment_at > nowDateOnly) continue;
    if (!candidatesByDonor.has(item.donor_id)) candidatesByDonor.set(item.donor_id, []);
    candidatesByDonor.get(item.donor_id)!.push(item);
  }
  const result = new Map<string, FulfilledCultivationOpportunity>();
  for (const [donorId, candidates] of candidatesByDonor) {
    const mostRecent = candidates.sort((a, b) => (b.activity_date ?? 0) - (a.activity_date ?? 0))[0];
    const supersededByNewerPledge = givingRows.some((item) => item.donor_id === donorId && REAL_COMMITMENT_CATEGORIES.has(item.category) && (item.activity_date ?? 0) > (mostRecent.activity_date ?? 0));
    if (supersededByNewerPledge) continue;
    const plan = paymentPlanByPledge.get(mostRecent.id)!;
    result.set(donorId, { pledgeActivityId: mostRecent.id, campaign: null, description: mostRecent.description || mostRecent.item_type, finalExpectedPaymentAt: plan.final_expected_payment_at });
  }
  return result;
}
