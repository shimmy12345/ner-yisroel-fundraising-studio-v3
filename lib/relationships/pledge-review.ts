// Pure logic for the one-time "pledge payment-plan cleanup review" list
// (see docs/PLEDGE-PAYMENT-PLAN-CLEANUP-AUDIT.md). This is NOT part of
// the payment-plan feature itself (lib/relationships/pledge-payment-plan.ts)
// -- it is a narrow, temporary review workflow for manually triaging the
// open/partially-paid pledges that predate that feature and currently
// have no payment plan, before the planned "ending soon" alert ships.
// No row from this module's output is ever written anywhere; D1 access
// (the three read-only queries this is built from) lives in
// app/pledge-review/page.tsx, deliberately kept out of this file so the
// classification/sort logic here stays pure and unit-testable without a
// D1 binding.
//
// "Does not have a payment plan" uses the exact same definition as the
// completed audit: no pledge_payment_plans row for this pledge's
// giving_activities.id with ended_at IS NULL. A pledge with an ended
// (inactive) plan still counts as having "no current plan" and is
// included, with planStatus 'old_inactive_plan' rather than 'none'.

export const PLEDGE_REVIEW_WINDOW_YEARS = 2;

/** 2 years before `nowEpochSeconds`, UTC date-only -- same cutoff the audit used. */
export function pledgeReviewCutoffEpoch(nowEpochSeconds: number): number {
  const d = new Date(nowEpochSeconds * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear() - PLEDGE_REVIEW_WINDOW_YEARS, d.getUTCMonth(), d.getUTCDate()) / 1000);
}

export type PledgeReviewSourceRow = {
  id: string;
  donor_id: string;
  activity_date: number | null;
  committed_cents: number | null;
  paid_cents: number | null;
  balance_cents: number | null;
  description: string | null;
  source_campaign: string | null;
  category: string; // 'open_pledge' | 'partially_paid_pledge' (caller already filtered)
  donor_code: string | null;
  display_name: string;
};

export type PledgePlanSourceRow = {
  pledge_activity_id: string;
  ended_at: number | null;
};

export type PaymentSourceRow = {
  pledge_activity_id: string;
  payment_date: number | null;
  applied_cents: number;
};

export type PledgeReviewItem = {
  pledgeId: string;
  donorId: string;
  donorCode: string | null;
  donorName: string;
  campaign: string | null;
  description: string | null;
  // JL's own recorded date for this row -- may be a future due date for
  // installment/multi-year pledges, never guaranteed to be the literal
  // day the donor committed. See docs/PLEDGE-PAYMENT-PLAN-DESIGN.md §1.
  activityDate: number;
  isFutureDated: boolean;
  originalCents: number;
  paidCents: number;
  balanceCents: number;
  paidStatus: "partially_paid" | "unpaid";
  planStatus: "none" | "old_inactive_plan";
  // Real payment evidence from jl_payment_assignment_audits, scoped to
  // this exact pledge -- never inferred from paid_cents. `hasReliableHistory`
  // is false when paid_cents > 0 but no matching audit row exists (the
  // audit's §5.2 finding) -- the caller must show an explicit
  // "payment recorded; detailed history unavailable" state, never a
  // guessed date.
  lastPaymentDate: number | null;
  lastPaymentAmountCents: number | null;
  hasReliableHistory: boolean;
};

/**
 * Builds the review queue from already-fetched, already-scoped rows.
 * Mirrors the completed audit's qualifying definition exactly:
 *   category IN ('open_pledge','partially_paid_pledge') [caller-filtered]
 *   AND balance_cents > 0
 *   AND activity_date >= cutoff
 *   AND no pledge_payment_plans row with ended_at IS NULL
 * Sort: partially-paid pledges before unpaid pledges; within each group,
 * oldest activityDate first. Never sorted by the prior A/B/C audit
 * classification -- that classification does not exist in this module.
 */
export function buildPledgeReviewQueue(
  rows: PledgeReviewSourceRow[],
  plans: PledgePlanSourceRow[],
  payments: PaymentSourceRow[],
  nowEpochSeconds: number,
): PledgeReviewItem[] {
  const cutoff = pledgeReviewCutoffEpoch(nowEpochSeconds);

  const plansByPledge = new Map<string, PledgePlanSourceRow[]>();
  for (const p of plans) {
    if (!plansByPledge.has(p.pledge_activity_id)) plansByPledge.set(p.pledge_activity_id, []);
    plansByPledge.get(p.pledge_activity_id)!.push(p);
  }
  const paymentsByPledge = new Map<string, PaymentSourceRow[]>();
  for (const p of payments) {
    if (!paymentsByPledge.has(p.pledge_activity_id)) paymentsByPledge.set(p.pledge_activity_id, []);
    paymentsByPledge.get(p.pledge_activity_id)!.push(p);
  }
  for (const list of paymentsByPledge.values()) list.sort((a, b) => (a.payment_date ?? 0) - (b.payment_date ?? 0));

  const items: PledgeReviewItem[] = [];
  for (const row of rows) {
    const balance = row.balance_cents ?? 0;
    if (balance <= 0) continue;
    if (row.activity_date === null || row.activity_date < cutoff) continue;

    const plansForThis = plansByPledge.get(row.id) ?? [];
    const hasActivePlan = plansForThis.some((p) => p.ended_at === null);
    if (hasActivePlan) continue;

    const paid = row.paid_cents ?? 0;
    const paymentsForThis = paymentsByPledge.get(row.id) ?? [];
    const lastPayment = paymentsForThis.length > 0 ? paymentsForThis[paymentsForThis.length - 1] : null;

    items.push({
      pledgeId: row.id,
      donorId: row.donor_id,
      donorCode: row.donor_code,
      donorName: row.display_name,
      campaign: row.source_campaign,
      description: row.description,
      activityDate: row.activity_date,
      isFutureDated: row.activity_date > nowEpochSeconds,
      originalCents: row.committed_cents ?? 0,
      paidCents: paid,
      balanceCents: balance,
      paidStatus: paid > 0 ? "partially_paid" : "unpaid",
      planStatus: plansForThis.length > 0 ? "old_inactive_plan" : "none",
      lastPaymentDate: lastPayment?.payment_date ?? null,
      lastPaymentAmountCents: lastPayment?.applied_cents ?? null,
      hasReliableHistory: paid === 0 || lastPayment !== null,
    });
  }

  items.sort((a, b) => {
    const groupA = a.paidStatus === "partially_paid" ? 0 : 1;
    const groupB = b.paidStatus === "partially_paid" ? 0 : 1;
    if (groupA !== groupB) return groupA - groupB;
    return a.activityDate - b.activityDate; // oldest first within the group
  });

  return items;
}

export type PledgeReviewChoice = "needs_plan" | "no_plan_needed" | "investigate";
export const PLEDGE_REVIEW_CHOICES: { value: PledgeReviewChoice; label: string }[] = [
  { value: "needs_plan", label: "Needs payment plan" },
  { value: "no_plan_needed", label: "No payment plan needed" },
  { value: "investigate", label: "Need to investigate" },
];
