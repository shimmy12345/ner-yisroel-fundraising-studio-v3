import type { GivingActivity } from "./jl-donations.ts";
import { stableTransactionId } from "./jl-donations.ts";
import { findPaymentDuplicateMatch, type ExistingCompletedGiftRow, type PaymentDuplicateMatch } from "./jl-payment-duplicate-match.ts";

export const OPEN_PLEDGES_FOR_DONORS_SQL = `SELECT id, donor_id, source_fingerprint, activity_date,
  COALESCE(committed_cents, COALESCE(paid_cents, 0) + balance_cents) AS committed_cents,
  COALESCE(paid_cents, 0) AS paid_cents, balance_cents, description, source_campaign, category, source_snapshot
  FROM giving_activities
  WHERE owner_user_id = ? AND record_origin = 'live'
    AND workspace_status = 'active'
    AND donor_id IN (SELECT value FROM json_each(?))
    AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift') AND balance_cents > 0
  ORDER BY activity_date DESC, id`;

export type PaymentDecisionAction = "apply_to_pledge" | "new_gift" | "needs_review" | "skip_duplicate";
// "leave_unresolved": the user explicitly acknowledges the remainder after
// allocation(s) is not being resolved right now -- a deliberate, visible
// terminal choice (see planPaymentAssignments), distinct from simply never
// deciding (which still blocks commit as an error).
export type OverpaymentAction = "split_remainder_new_gift" | "leave_unresolved" | null;
export type PledgeAllocationInput = { pledgeId: string; amountCents: number };
export type PaymentDecisionInput = {
  fingerprint: string;
  action: PaymentDecisionAction;
  // Single-pledge convenience path (unchanged shape from before multi-
  // pledge allocation existed) -- still the common case. When `allocations`
  // is also provided and non-empty, it takes precedence.
  pledgeId?: string | null;
  // Explicit multi-pledge allocation: one entry per pledge this single
  // source payment is being split across. A one-entry array behaves
  // identically to the equivalent `pledgeId` decision.
  allocations?: PledgeAllocationInput[];
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
  // True only for a structural reason with no decision UI at all (missing
  // JL Code match, missing/invalid date, non-positive amount) -- distinct
  // from `reason` being merely informational (e.g. a duplicate-match hint
  // or the generic "choose a classification" prompt), which still leaves
  // the row fully decidable. planPaymentAssignments checks this flag
  // directly instead of pattern-matching `reason`'s text, so a new
  // non-blocking reason (like a duplicate-match hint) can never be
  // mistaken for a hard block merely because its wording differs from the
  // one previously-hardcoded generic string.
  blocked: boolean;
  openPledges: OpenPledge[];
  // Confidence-aware match against an existing completed gift -- see
  // lib/import/jl-payment-duplicate-match.ts. Null when no meaningful
  // evidence was found. Never used to silently skip anything on its own;
  // it only ever informs the default `action` above and what the review
  // UI shows -- the user must still submit an explicit decision.
  duplicateMatch: PaymentDuplicateMatch | null;
};

export function buildPaymentCandidates(
  activities: GivingActivity[],
  households: PaymentHousehold[],
  openPledges: OpenPledge[],
  remembered: RememberedPaymentDecision[],
  existingCompletedGifts: ExistingCompletedGiftRow[] = [],
) {
  const householdByCode = new Map(households.map((household) => [household.external_id.toLowerCase(), household]));
  const pledgesByDonor = new Map<string, OpenPledge[]>();
  for (const pledge of openPledges) {
    const list = pledgesByDonor.get(pledge.donor_id) ?? [];
    list.push(pledge);
    pledgesByDonor.set(pledge.donor_id, list);
  }
  const rememberedByFingerprint = new Map(remembered.map((decision) => [decision.payment_fingerprint, decision]));
  const existingGiftsByDonor = new Map<string, ExistingCompletedGiftRow[]>();
  for (const gift of existingCompletedGifts) {
    const list = existingGiftsByDonor.get(gift.donor_id) ?? [];
    list.push(gift);
    existingGiftsByDonor.set(gift.donor_id, list);
  }

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
    const duplicateMatch = !reason && household
      ? findPaymentDuplicateMatch(stableTransactionId(activity.sourceValues), household.id, activity.activityDate, activity.committedCents, activity.sourceCampaign, existingGiftsByDonor)
      : null;
    // A "possible" match is genuinely ambiguous (see the doc comment on
    // findPaymentDuplicateMatch) -- it is surfaced via `duplicateMatch` and
    // `reason` for the user to see, but never preselects Skip the way
    // "confirmed"/"likely" do. Preselecting is still just a default value
    // the user submits (or changes) explicitly; it never applies itself.
    const suggestSkip = duplicateMatch !== null && duplicateMatch.confidence !== "possible";
    return {
      row: activity.rowNumber,
      fingerprint: activity.fingerprint,
      donorId: household?.id ?? null,
      donorName: household?.display_name ?? (activity.sourceName || `JL ${activity.externalHouseholdId}`),
      paymentDate: activity.activityDate,
      amountCents: activity.committedCents,
      campaign: activity.sourceCampaign,
      action: reason ? "needs_review" : prior?.decision_type ?? (suggestSkip ? "skip_duplicate" : "needs_review"),
      pledgeId: reason ? null : prior?.pledge_activity_id ?? null,
      remembered: Boolean(prior),
      alreadyApplied: Boolean(prior?.applied_import_id),
      reason: reason ?? (prior ? "This identical JL payment was already processed using the saved decision" : duplicateMatch ? duplicateMatch.reason : "Choose whether this payment applies to an open pledge or is a new gift"),
      blocked: Boolean(reason),
      openPledges: household ? (pledgesByDonor.get(household.id) ?? []) : [],
      duplicateMatch,
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

export type PlannedSkippedDuplicate = {
  row: number;
  fingerprint: string;
  donorId: string;
  matchedActivityId: string | null;
  matchConfidence: "confirmed" | "likely" | "possible" | null;
};

export function remainderGiftFingerprint(paymentFingerprint: string) {
  return `${paymentFingerprint}:remainder`;
}

// Deterministic per-allocation identity for a multi-pledge split, derived
// from the pledge id rather than array position -- so re-rendering the
// same decision with its allocations in a different order (or removing
// and re-adding one) never changes which synthetic fingerprint a given
// {payment, pledge} pair gets, and so selecting the same pledge twice in
// one decision collides on this key rather than silently double-applying
// (guarded explicitly below regardless).
export function pledgeAllocationFingerprint(paymentFingerprint: string, pledgeId: string) {
  return `${paymentFingerprint}:alloc:${pledgeId}`;
}

// A single pledge's share of ONE incoming payment plan, resolved against
// the shared cross-candidate ledger (pledgePayments) exactly like the
// single-pledge path always has -- multi-pledge allocation reuses the same
// accumulator so two different payments can never jointly over-allocate
// the same pledge.
function resolvePledgeAllocation(
  pledgePayments: Map<string, { pledge: OpenPledge; total: number; fingerprints: string[] }>,
  pledge: OpenPledge,
  requestedCents: number,
): { availableCents: number; accumulated: { pledge: OpenPledge; total: number; fingerprints: string[] } } {
  const accumulated = pledgePayments.get(pledge.id) ?? { pledge, total: 0, fingerprints: [] };
  const availableCents = Math.max(0, pledge.balance_cents - accumulated.total);
  return { availableCents, accumulated };
}

export function planPaymentAssignments(candidates: PaymentCandidate[], decisions: PaymentDecisionInput[]) {
  const inputByFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const newGifts: PlannedNewGift[] = [];
  const pledgePayments = new Map<string, { pledge: OpenPledge; total: number; fingerprints: string[] }>();
  const assignments: PlannedPaymentAssignment[] = [];
  const skippedDuplicates: PlannedSkippedDuplicate[] = [];
  const alreadyApplied: string[] = [];
  const errors: Array<{ row: number; reason: string }> = [];

  for (const candidate of candidates) {
    if (candidate.alreadyApplied) { alreadyApplied.push(candidate.fingerprint); continue; }
    if (candidate.blocked) {
      errors.push({ row: candidate.row, reason: candidate.reason! });
      continue;
    }
    const decision = inputByFingerprint.get(candidate.fingerprint);
    if (!decision || decision.action === "needs_review") {
      errors.push({ row: candidate.row, reason: "Choose Apply to open pledge, New gift/payment, or Skip -- already recorded" });
      continue;
    }
    const paymentCents = candidate.amountCents ?? 0;

    if (decision.action === "skip_duplicate") {
      // No pledge is touched, no gift is created -- this is the one
      // action guaranteed to make zero financial writes. Recording the
      // matched existing record (if any) here, rather than only in
      // rendered UI text, is what lets the commit route preserve
      // provenance in giving_activity_import_changes (see route.ts).
      skippedDuplicates.push({ row: candidate.row, fingerprint: candidate.fingerprint, donorId: candidate.donorId!, matchedActivityId: candidate.duplicateMatch?.existingActivityId ?? null, matchConfidence: candidate.duplicateMatch?.confidence ?? null });
      continue;
    }

    if (decision.action === "new_gift") {
      newGifts.push({ sourceFingerprint: candidate.fingerprint, fingerprint: candidate.fingerprint, amountCents: paymentCents, kind: "full_payment" });
      assignments.push({ row: candidate.row, fingerprint: candidate.fingerprint, donorId: candidate.donorId!, decisionType: "new_gift", pledgeId: null, paymentCents, appliedCents: 0, newGiftCents: paymentCents, overpaymentAction: null, previousPaidCents: null, nextPaidCents: null, previousBalanceCents: null, nextBalanceCents: null, previousStatus: null, nextStatus: null });
      continue;
    }

    // action === "apply_to_pledge" from here on. `allocations` (explicit,
    // exact amounts -- the caller/UI already computed how much to apply,
    // typically the obvious maximum) and the bare `pledgeId` convenience
    // path (auto-capped to the pledge's own outstanding balance, exactly
    // as this single-pledge path has always behaved) are validated
    // slightly differently: only the auto-cap path silently reduces a
    // requested amount down to what's available; an explicit allocation
    // that asks for more than is available is always a rejected decision
    // (Section 11: "no single pledge allocation may exceed that pledge's
    // outstanding balance"), never silently capped.
    let requestedAllocations: PledgeAllocationInput[];
    if (decision.allocations && decision.allocations.length > 0) {
      requestedAllocations = decision.allocations;
    } else if (decision.pledgeId) {
      const pledge = candidate.openPledges.find((item) => item.id === decision.pledgeId);
      if (!pledge) {
        errors.push({ row: candidate.row, reason: "Select an open pledge belonging to this donor" });
        continue;
      }
      const { availableCents } = resolvePledgeAllocation(pledgePayments, pledge, paymentCents);
      if (availableCents === 0) {
        errors.push({ row: candidate.row, reason: "The selected pledge is fully allocated by an earlier payment; choose another pledge or return this row to review" });
        continue;
      }
      requestedAllocations = [{ pledgeId: decision.pledgeId, amountCents: Math.min(paymentCents, availableCents) }];
    } else {
      requestedAllocations = [];
    }
    if (requestedAllocations.length === 0) {
      errors.push({ row: candidate.row, reason: "Select an open pledge belonging to this donor" });
      continue;
    }

    // Section 11 invariants, validated up front so a bad decision never
    // partially applies before failing.
    const seenPledgeIds = new Set<string>();
    let allocationError: string | null = null;
    let allocatedTotalCents = 0;
    const resolved: Array<{ pledge: OpenPledge; amountCents: number }> = [];
    for (const allocation of requestedAllocations) {
      if (!Number.isInteger(allocation.amountCents) || allocation.amountCents <= 0) { allocationError = "Each pledge allocation must be a positive whole number of cents"; break; }
      if (seenPledgeIds.has(allocation.pledgeId)) { allocationError = "The same pledge cannot receive two allocations from one payment"; break; }
      seenPledgeIds.add(allocation.pledgeId);
      const pledge = candidate.openPledges.find((item) => item.id === allocation.pledgeId);
      if (!pledge) { allocationError = "Select an open pledge belonging to this donor"; break; }
      const { availableCents } = resolvePledgeAllocation(pledgePayments, pledge, allocation.amountCents);
      if (allocation.amountCents > availableCents) { allocationError = availableCents === 0 ? "The selected pledge is fully allocated by an earlier payment; choose another pledge or return this row to review" : "An allocation cannot exceed the selected pledge's outstanding balance"; break; }
      allocatedTotalCents += allocation.amountCents;
      resolved.push({ pledge, amountCents: allocation.amountCents });
    }
    if (allocationError) { errors.push({ row: candidate.row, reason: allocationError }); continue; }
    if (allocatedTotalCents > paymentCents) { errors.push({ row: candidate.row, reason: "Pledge allocations cannot exceed the incoming payment amount" }); continue; }

    const remainderCents = paymentCents - allocatedTotalCents;
    if (remainderCents > 0 && decision.overpaymentAction !== "split_remainder_new_gift" && decision.overpaymentAction !== "leave_unresolved") {
      errors.push({ row: candidate.row, reason: "Payment exceeds the selected pledge balance; choose how to handle the remainder" });
      continue;
    }

    // All validated -- now actually apply, in the same single pass, so a
    // later error in this loop iteration can never leave a partial
    // allocation behind (the loop above already fully validated before
    // this point is ever reached).
    const isSingleAllocation = resolved.length === 1;
    // The remainder's disposition (its own newGiftCents/overpaymentAction)
    // is recorded on exactly one row: the sole allocation's own row for a
    // single-pledge decision (matching this codebase's pre-existing
    // convention, verified by tests/payment-assignment.test.mjs), or the
    // multi-pledge "parent marker" row appended after this loop otherwise
    // -- never duplicated across rows, so summing appliedCents+newGiftCents
    // across a candidate's own assignment rows always equals paymentCents
    // exactly once.
    resolved.forEach(({ pledge, amountCents: appliedCents }, index) => {
      const accumulated = pledgePayments.get(pledge.id) ?? { pledge, total: 0, fingerprints: [] };
      const previousPaidCents = pledge.paid_cents + accumulated.total;
      const previousBalanceCents = pledge.balance_cents - accumulated.total;
      const nextPaidCents = previousPaidCents + appliedCents;
      const nextBalanceCents = previousBalanceCents - appliedCents;
      const nextStatus = nextBalanceCents === 0 ? "completed_gift" : "partially_paid_pledge";
      // A single-allocation decision keeps using the ORIGINAL payment
      // fingerprint for its own audit/remembered row, exactly as before
      // multi-pledge allocation existed -- this is what preserves byte-
      // identical behavior (and existing test coverage) for the common
      // single-pledge case. Only a genuine 2+-pledge split needs a
      // distinct fingerprint per allocation (jl_payment_assignment_audits
      // has a UNIQUE(import_id, payment_fingerprint) index, so two
      // allocations from the same payment cannot share one audit row).
      const allocationFingerprint = isSingleAllocation ? candidate.fingerprint : pledgeAllocationFingerprint(candidate.fingerprint, pledge.id);
      accumulated.total += appliedCents;
      accumulated.fingerprints.push(allocationFingerprint);
      pledgePayments.set(pledge.id, accumulated);
      const carriesRemainder = isSingleAllocation && index === resolved.length - 1;
      assignments.push({
        row: candidate.row,
        fingerprint: allocationFingerprint,
        donorId: candidate.donorId!,
        decisionType: "apply_to_pledge",
        pledgeId: pledge.id,
        // paymentCents intentionally always reflects the FULL incoming
        // payment amount, not just this allocation's own slice -- matching
        // the pre-existing single-pledge convention (see the overpayment
        // test in tests/payment-assignment.test.mjs), so a human reading
        // jl_payment_assignment_audits can always see what the original
        // source payment was, alongside appliedCents for this one slice.
        paymentCents,
        appliedCents,
        newGiftCents: carriesRemainder ? remainderCents : 0,
        overpaymentAction: carriesRemainder && remainderCents > 0 ? (decision.overpaymentAction ?? null) : null,
        previousPaidCents,
        nextPaidCents,
        previousBalanceCents,
        nextBalanceCents,
        previousStatus: previousBalanceCents === 0 ? "completed_gift" : previousPaidCents > 0 ? "partially_paid_pledge" : pledge.category,
        nextStatus,
      });
    });

    if (!isSingleAllocation) {
      // Section 16 idempotency for a genuine multi-pledge split: a single
      // "parent" remembered row keyed by the ORIGINAL payment fingerprint
      // (pledgeActivityId left null -- there is no one specific pledge to
      // name) so a later re-upload of the exact same source file
      // recognizes this payment as already resolved via its own
      // `alreadyApplied` check, the same way a single-pledge decision's
      // remembered row already does under its own fingerprint. Each
      // individual allocation's OWN remembered/audit rows (written by the
      // caller from `assignments` above) are keyed by their synthetic
      // per-pledge fingerprint and exist purely for that allocation's own
      // audit trail, not for this idempotency check.
      assignments.push({ row: candidate.row, fingerprint: candidate.fingerprint, donorId: candidate.donorId!, decisionType: "apply_to_pledge", pledgeId: null, paymentCents, appliedCents: 0, newGiftCents: remainderCents, overpaymentAction: remainderCents > 0 ? (decision.overpaymentAction ?? null) : null, previousPaidCents: null, nextPaidCents: null, previousBalanceCents: null, nextBalanceCents: null, previousStatus: null, nextStatus: null });
    }

    if (remainderCents > 0 && decision.overpaymentAction === "split_remainder_new_gift") {
      newGifts.push({ sourceFingerprint: candidate.fingerprint, fingerprint: remainderGiftFingerprint(candidate.fingerprint), amountCents: remainderCents, kind: "overpayment_remainder" });
    }
    // decision.overpaymentAction === "leave_unresolved": the remainder is
    // deliberately left unaccounted -- no gift, no error, no further
    // write. This is a valid, visible terminal state (Section 9/15), not
    // a silent gap: the review UI's own "Remaining: $X" line is what makes
    // it obvious, and the assignment record above still carries the full
    // paymentCents alongside each allocation's own appliedCents so the
    // shortfall is always reconstructable from the audit trail.
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
    skippedDuplicates,
    alreadyApplied,
    errors,
  };
}
