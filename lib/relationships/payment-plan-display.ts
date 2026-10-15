// Payment-Plan Progress Dashboard (2026-10-16, see docs/AI-HANDOFF.md) --
// pure presentation layer over lib/relationships/pledge-payment-plan.ts's
// OWN output. Deliberately NOT a second financial evaluation: every
// function here only labels/buckets fields evaluatePaymentPlan() already
// computed (isOnTrack, isLate, isCompleted, isPlanEndedWithBalance,
// nextUnsatisfiedExpectedPaymentAt, daysUntilNextUnsatisfiedPayment,
// cycles/satisfied). This mirrors evaluateRecurringPaymentAlert's own
// "pure derivation over evaluatePaymentPlan's OWN output" discipline in
// that same file.

import type { PaymentPlanEvaluation } from "./pledge-payment-plan.ts";

export const PAYMENT_PLAN_DISPLAY_STATUSES = ["on_track", "upcoming_payment", "payment_due", "overdue", "completed", "needs_review"] as const;
export type PaymentPlanDisplayStatus = typeof PAYMENT_PLAN_DISPLAY_STATUSES[number];

// How many days out a not-yet-due next cycle counts as "Upcoming Payment"
// rather than plain "On Track" -- a display threshold only, never
// consulted by evaluatePaymentPlan's own lateness/status logic.
export const UPCOMING_PAYMENT_WINDOW_DAYS = 14;

// Status labels, derived strictly from the engine's own output, in this
// priority order:
//   1. Completed       -- evaluation.isCompleted (balance fully paid).
//   2. Needs Review     -- evaluation.isPlanEndedWithBalance (the plan's
//      own final date has passed with balance still open) OR the record
//      itself is internally inconsistent (balanceCents negative, or a
//      plan with no enumerable cycles at all) -- never silently shown as
//      any of the other, more confident statuses.
//   3. Overdue          -- evaluation.isLate.
//   4. Payment Due       -- the next unsatisfied cycle's date has arrived
//      (daysUntilNextUnsatisfiedPayment <= 0) but the grace period hasn't
//      expired yet (isLate is still false) -- genuinely due, not yet late.
//   5. Upcoming Payment -- the next unsatisfied cycle is within
//      UPCOMING_PAYMENT_WINDOW_DAYS.
//   6. On Track          -- anything else evaluable (isOnTrack, cycle
//      further out than the upcoming window).
export function derivePaymentPlanDisplayStatus(
  evaluation: PaymentPlanEvaluation,
  balanceCents: number,
  upcomingWindowDays: number = UPCOMING_PAYMENT_WINDOW_DAYS,
): PaymentPlanDisplayStatus {
  // Defensive, checked FIRST: a negative balance or an evaluation with no
  // enumerable cycles is an inconsistent record this function must never
  // dress up as a confident status. This must run before the isCompleted
  // check below -- the engine's own isCompleted is `balanceCents <= 0`,
  // which is also (incorrectly) true for a negative balance, so checking
  // isCompleted first would silently relabel a corrupted record as
  // "Completed" instead of flagging it.
  if (balanceCents < 0 || evaluation.cycles.length === 0) return "needs_review";
  if (evaluation.isCompleted) return "completed";
  if (evaluation.isPlanEndedWithBalance) return "needs_review";
  if (evaluation.isLate) return "overdue";
  if (evaluation.daysUntilNextUnsatisfiedPayment !== null && evaluation.daysUntilNextUnsatisfiedPayment <= 0) return "payment_due";
  if (evaluation.daysUntilNextUnsatisfiedPayment !== null && evaluation.daysUntilNextUnsatisfiedPayment <= upcomingWindowDays) return "upcoming_payment";
  return "on_track";
}

export const PAYMENT_PLAN_DISPLAY_STATUS_LABELS: Record<PaymentPlanDisplayStatus, string> = {
  on_track: "On Track",
  upcoming_payment: "Upcoming Payment",
  payment_due: "Payment Due",
  overdue: "Overdue",
  completed: "Completed",
  needs_review: "Needs Review",
};

export type InstallmentTimelineEntry = {
  dueAt: number;
  state: "paid" | "overdue" | "upcoming" | "future";
};

export type InstallmentTimelineSummary = {
  entries: InstallmentTimelineEntry[];
  // Counts of real cycles trimmed off each end so the rendered strip
  // never grows unbounded for a long-running plan -- the full, untrimmed
  // cycles/satisfied arrays remain the source of truth on
  // PaymentPlanEvaluation; this is purely a display cap.
  hiddenBeforeCount: number;
  hiddenAfterCount: number;
};

// Caps a potentially long (up to PLEDGE_PAYMENT_CYCLE_ENUMERATION_CAP = 60)
// cycle list down to a visually manageable strip: every unsatisfied cycle
// (overdue or upcoming/future) is always kept -- a real missed or pending
// installment must never be the one trimmed away -- and satisfied (paid)
// cycles are trimmed from the earliest end first, keeping at most
// `maxPaidToShow` of the most recent paid cycles. Order is preserved
// (ascending by date, matching cycles/satisfied's own order).
export function buildInstallmentTimeline(
  evaluation: Pick<PaymentPlanEvaluation, "cycles" | "satisfied">,
  nowDateOnly: number,
  maxPaidToShow: number = 6,
): InstallmentTimelineSummary {
  const { cycles, satisfied } = evaluation;
  // The single next unsatisfied cycle still in the future (if any) is
  // "upcoming"; every other not-yet-due, unsatisfied cycle further out is
  // "future" -- purely a presentational distinction between "the very
  // next one" and "later ones," never a financial-status difference.
  const firstFutureUnsatisfiedIndex = cycles.findIndex((cycle, index) => !satisfied[index] && cycle > nowDateOnly);

  const all: InstallmentTimelineEntry[] = cycles.map((dueAt, index) => {
    if (satisfied[index]) return { dueAt, state: "paid" as const };
    if (dueAt <= nowDateOnly) return { dueAt, state: "overdue" as const };
    return { dueAt, state: index === firstFutureUnsatisfiedIndex ? ("upcoming" as const) : ("future" as const) };
  });

  const paidIndexes = all.flatMap((entry, index) => (entry.state === "paid" ? [index] : []));
  const hiddenPaidIndexes = new Set(paidIndexes.length > maxPaidToShow ? paidIndexes.slice(0, paidIndexes.length - maxPaidToShow) : []);

  const entries = all.filter((_, index) => !hiddenPaidIndexes.has(index));
  return { entries, hiddenBeforeCount: hiddenPaidIndexes.size, hiddenAfterCount: 0 };
}
