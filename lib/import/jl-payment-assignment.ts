import type { GivingActivity } from "./jl-donations.ts";

export const OPEN_PLEDGES_FOR_DONORS_SQL = `SELECT id, donor_id, source_fingerprint, activity_date,
  COALESCE(committed_cents, COALESCE(paid_cents, 0) + balance_cents) AS committed_cents,
  COALESCE(paid_cents, 0) AS paid_cents, balance_cents, description, source_campaign, category, source_snapshot
  FROM giving_activities
  WHERE owner_user_id = ? AND record_origin = 'live'
    AND donor_id IN (SELECT value FROM json_each(?))
    AND balance_cents > 0
  ORDER BY activity_date DESC, id`;

export type PaymentDecisionAction = "apply_to_pledge" | "new_gift" | "needs_review";
export type OverpaymentAction = "split_remainder_new_gift" | null;
export type PaymentDecisionInput = {
  fingerprint: string;
  action: PaymentDecisionAction;
  pledgeId?: string | null;
  overpaymentAction?: OverpaymentAction;
};
export type PaymentHousehold = { id: string; external_id: string; display_name?: string };
export type OpenPledge = {
  id: string;
  donor_id: string;
  source_fingerprint: string;
  activity_date: number | null;
  committed_cents: number;
  paid_cents: number;
  balance_cents: number;
  description: string | null;
  source_campaign: string | null;
  category: string;
  source_snapshot: string;
};
export type RememberedPaymentDecision = {
  payment_fingerprint: string;
  decision_type: "apply_to_pledge" | "new_gift";
  pledge_activity_id: string | null;
  applied_import_id: string;
};

export type PaymentCandidate = {
  row: number;
  fingerprint: string;
  donorId: string | null;
  donorName: string;
  paymentDate: number | null;
  amountCents: number | null;
  campaign: string;
  action: PaymentDecisionAction;
  pledgeId: string | null;
  remembered: boolean;
  alreadyApplied: boolean;
  reason: string | null;
  openPledges: OpenPledge[];
};

export function buildPaymentCandidates(
  activities: GivingActivity[],
  households: PaymentHousehold[],
  openPledges: OpenPledge[],
  remembered: RememberedPaymentDecision[],
) {
  const householdByCode = new Map(households.map((household) => [household.external_id.toLowerCase(), household]));
  const pledgesByDonor = new Map<string, OpenPledge[]>();
  for (const pledge of openPledges) {
    const list = pledgesByDonor.get(pledge.donor_id) ?? [];
    list.push(pledge);
    pledgesByDonor.set(pledge.donor_id, list);
  }
  const rememberedByFingerprint = new Map(remembered.map((decision) => [decision.payment_fingerprint, decision]));

  return activities.map<PaymentCandidate>((activity) => {
    const household = householdByCode.get(activity.externalHouseholdId.toLowerCase());
    const prior = rememberedByFingerprint.get(activity.fingerprint);
    const reason = !household
      ? "JL Code does not match an imported household"
      : activity.activityDate === null
        ? "Missing or invalid payment date"
        : activity.committedCents === null || activity.committedCents <= 0
          ? "Payment amount must be greater than zero"
          : null;
    return {
      row: activity.rowNumber,
      fingerprint: activity.fingerprint,
      donorId: household?.id ?? null,
      donorName: household?.display_name ?? (activity.sourceName || `JL ${activity.externalHouseholdId}`),
      paymentDate: activity.activityDate,
      amountCents: activity.committedCents,
      campaign: activity.sourceCampaign,
      action: reason ? "needs_review" : prior?.decision_type ?? "needs_review",
      pledgeId: reason ? null : prior?.pledge_activity_id ?? null,
      remembered: Boolean(prior),
      alreadyApplied: Boolean(prior?.applied_import_id),
      reason: reason ?? (prior ? "This identical JL payment was already processed using the saved decision" : "Choose whether this payment applies to an open pledge or is a new gift"),
      openPledges: household ? (pledgesByDonor.get(household.id) ?? []) : [],
    };
  });
}

export type PlannedPledgeUpdate = OpenPledge & {
  paymentCents: number;
  nextPaidCents: number;
  nextBalanceCents: number;
  nextCategory: "partially_paid_pledge" | "completed_gift";
  paymentFingerprints: string[];
};

export type PlannedNewGift = {
  sourceFingerprint: string;
  fingerprint: string;
  amountCents: number;
  kind: "full_payment" | "overpayment_remainder";
};

export type PlannedPaymentAssignment = {
  row: number;
  fingerprint: string;
  donorId: string;
  decisionType: "apply_to_pledge" | "new_gift";
  pledgeId: string | null;
  paymentCents: number;
  appliedCents: number;
  newGiftCents: number;
  overpaymentAction: OverpaymentAction;
  previousPaidCents: number | null;
  nextPaidCents: number | null;
  previousBalanceCents: number | null;
  nextBalanceCents: number | null;
  previousStatus: string | null;
  nextStatus: string | null;
};

export function remainderGiftFingerprint(paymentFingerprint: string) {
  return `${paymentFingerprint}:remainder`;
}

export function planPaymentAssignments(candidates: PaymentCandidate[], decisions: PaymentDecisionInput[]) {
  const inputByFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const newGifts: PlannedNewGift[] = [];
  const pledgePayments = new Map<string, { pledge: OpenPledge; total: number; fingerprints: string[] }>();
  const assignments: PlannedPaymentAssignment[] = [];
  const alreadyApplied: string[] = [];
  const errors: Array<{ row: number; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.alreadyApplied) { alreadyApplied.push(candidate.fingerprint); continue; }
    if (candidate.reason && candidate.reason !== "Choose whether this payment applies to an open pledge or is a new gift") {
      errors.push({ row: candidate.row, reason: candidate.reason });
      continue;
    }
    const decision = inputByFingerprint.get(candidate.fingerprint);
    if (!decision || decision.action === "needs_review") {
      errors.push({ row: candidate.row, reason: "Choose Apply to open pledge or Treat as new gift/payment" });
      continue;
    }
    const paymentCents = candidate.amountCents ?? 0;
    if (decision.action === "new_gift") {
      newGifts.push({ sourceFingerprint: candidate.fingerprint, fingerprint: candidate.fingerprint, amountCents: paymentCents, kind: "full_payment" });
      assignments.push({ row: candidate.row, fingerprint: candidate.fingerprint, donorId: candidate.donorId!, decisionType: "new_gift", pledgeId: null, paymentCents, appliedCents: 0, newGiftCents: paymentCents, overpaymentAction: null, previousPaidCents: null, nextPaidCents: null, previousBalanceCents: null, nextBalanceCents: null, previousStatus: null, nextStatus: null });
      continue;
    }
    const pledge = candidate.openPledges.find((item) => item.id === decision.pledgeId);
    if (!pledge) {
      errors.push({ row: candidate.row, reason: "Select an open pledge belonging to this donor" });
      continue;
    }
    const accumulated = pledgePayments.get(pledge.id) ?? { pledge, total: 0, fingerprints: [] };
    const availableCents = Math.max(0, pledge.balance_cents - accumulated.total);
    if (availableCents === 0) {
      errors.push({ row: candidate.row, reason: "The selected pledge is fully allocated by an earlier payment; choose another pledge or return this row to review" });
      continue;
    }
    const appliedCents = Math.min(paymentCents, availableCents);
    const remainderCents = paymentCents - appliedCents;
    if (remainderCents > 0 && decision.overpaymentAction !== "split_remainder_new_gift") {
      errors.push({ row: candidate.row, reason: "Payment exceeds the selected pledge balance; choose how to handle the remainder" });
      continue;
    }
    const previousPaidCents = pledge.paid_cents + accumulated.total;
    const previousBalanceCents = pledge.balance_cents - accumulated.total;
    const nextPaidCents = previousPaidCents + appliedCents;
    const nextBalanceCents = previousBalanceCents - appliedCents;
    const nextStatus = nextBalanceCents === 0 ? "completed_gift" : "partially_paid_pledge";
    accumulated.total += appliedCents;
    accumulated.fingerprints.push(candidate.fingerprint);
    pledgePayments.set(pledge.id, accumulated);
    if (remainderCents > 0) {
      newGifts.push({ sourceFingerprint: candidate.fingerprint, fingerprint: remainderGiftFingerprint(candidate.fingerprint), amountCents: remainderCents, kind: "overpayment_remainder" });
    }
    assignments.push({ row: candidate.row, fingerprint: candidate.fingerprint, donorId: candidate.donorId!, decisionType: "apply_to_pledge", pledgeId: pledge.id, paymentCents, appliedCents, newGiftCents: remainderCents, overpaymentAction: remainderCents > 0 ? "split_remainder_new_gift" : null, previousPaidCents, nextPaidCents, previousBalanceCents, nextBalanceCents, previousStatus: previousBalanceCents === 0 ? "completed_gift" : previousPaidCents > 0 ? "partially_paid_pledge" : pledge.category, nextStatus });
  }

  const pledgeUpdates: PlannedPledgeUpdate[] = [...pledgePayments.values()].map(({ pledge, total, fingerprints }) => {
    const nextPaidCents = pledge.paid_cents + total;
    const nextBalanceCents = pledge.balance_cents - total;
    return { ...pledge, paymentCents: total, nextPaidCents, nextBalanceCents, nextCategory: nextBalanceCents === 0 ? "completed_gift" : "partially_paid_pledge", paymentFingerprints: fingerprints };
  });

  return {
    newGifts,
    newGiftFingerprints: newGifts.filter((gift) => gift.kind === "full_payment").map((gift) => gift.sourceFingerprint),
    pledgeUpdates,
    assignments,
    alreadyApplied,
    errors,
  };
}
