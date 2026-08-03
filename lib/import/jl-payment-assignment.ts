import type { GivingActivity } from "./jl-donations.ts";

export type PaymentDecisionAction = "apply_to_pledge" | "new_gift" | "needs_review";
export type PaymentDecisionInput = { fingerprint: string; action: PaymentDecisionAction; pledgeId?: string | null };
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

export type PlannedPledgeUpdate = OpenPledge & { paymentCents: number; nextPaidCents: number; nextBalanceCents: number; nextCategory: "partially_paid_pledge" | "completed_gift"; paymentFingerprints: string[] };

export function planPaymentAssignments(candidates: PaymentCandidate[], decisions: PaymentDecisionInput[]) {
  const inputByFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const newGiftFingerprints: string[] = [];
  const pledgePayments = new Map<string, { pledge: OpenPledge; total: number; fingerprints: string[] }>();
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
      errors.push({ row: candidate.row, reason: "Choose Apply to open pledge or New gift/payment" });
      continue;
    }
    if (decision.action === "new_gift") {
      newGiftFingerprints.push(candidate.fingerprint);
      continue;
    }
    const pledge = candidate.openPledges.find((item) => item.id === decision.pledgeId);
    if (!pledge) {
      errors.push({ row: candidate.row, reason: "Select an open pledge belonging to this donor" });
      continue;
    }
    const amount = candidate.amountCents ?? 0;
    const accumulated = pledgePayments.get(pledge.id) ?? { pledge, total: 0, fingerprints: [] };
    if (accumulated.total + amount > pledge.balance_cents) {
      errors.push({ row: candidate.row, reason: "Payment exceeds the selected pledge balance" });
      continue;
    }
    accumulated.total += amount;
    accumulated.fingerprints.push(candidate.fingerprint);
    pledgePayments.set(pledge.id, accumulated);
  }

  const pledgeUpdates: PlannedPledgeUpdate[] = [...pledgePayments.values()].map(({ pledge, total, fingerprints }) => {
    const nextPaidCents = pledge.paid_cents + total;
    const nextBalanceCents = pledge.balance_cents - total;
    return { ...pledge, paymentCents: total, nextPaidCents, nextBalanceCents, nextCategory: nextBalanceCents === 0 ? "completed_gift" : "partially_paid_pledge", paymentFingerprints: fingerprints };
  });

  return { newGiftFingerprints, pledgeUpdates, alreadyApplied, errors };
}
