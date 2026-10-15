// Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
// This module is deliberately split in two:
//   - A PURE summarization function (summarizeTripFinancials) that takes
//     already-fetched giving_activities rows and does nothing but sum
//     and bucket fields that already exist on them -- no D1 access, no
//     new financial calculation, fully unit-testable.
//   - A small set of D1 functions that read/write ONLY the new
//     trip_financial_attributions link table (drizzle/0046). They never
//     write to giving_activities, pledge_payment_plans, or any other
//     existing financial table -- attributing/removing an attribution
//     changes only which trip a record is linked to, never the
//     financial record itself (the task's own "view and correct trip
//     attribution without modifying the underlying financial
//     transaction" requirement).
//
// Env import is deferred into each D1 function's own module via the
// caller (matching this codebase's convention of importing `env` from
// "cloudflare:workers" at the call site, e.g. app/api/trips/**), kept
// out of this file so the pure summarizeTripFinancials function stays
// trivially testable with zero Workers runtime.

import { countsInGivingTotals } from "../giving/management.ts";
import { REAL_COMMITMENT_CATEGORIES } from "./pledge-payment-plan.ts";

const PLEDGE_CATEGORIES = new Set(["open_pledge", "partially_paid_pledge"]);
const DONATION_CATEGORY = "completed_gift";

export type AttributedGivingRecord = {
  attributionId: string;
  givingActivityId: string;
  donorId: string;
  donorDisplayName: string;
  category: string;
  workspaceStatus: string;
  committedCents: number | null;
  paidCents: number | null;
  balanceCents: number | null;
  note: string | null;
  createdAt: number;
  // See lib/relationships/trips-data.ts's listTripFinancialAttributions --
  // category/workspaceStatus/*Cents above are already resolved to the
  // confirmed donation's own live figures when this is true. Never read
  // by summarizeTripFinancials itself; presentation-only.
  resolvedViaImportMatch: boolean;
};

export type TripFinancialSummary = {
  // Confirmed (countsInGivingTotals-passing) buckets only -- a
  // pending_gift/pending_pledge/needs_review/hidden/etc. record attributed
  // to the trip never contributes to any of these, no matter its amount.
  newPledgesSecuredCents: number;
  newDonationsSecuredCents: number;
  // = newPledgesSecuredCents + newDonationsSecuredCents. A pledge counts
  // in full the moment it is confirmed and attributed -- a later partial
  // payment against it never changes this figure (only cashCollectedCents
  // moves).
  totalNewCommitmentsCents: number;
  // Sum of paidCents across every confirmed attributed record (a
  // completed_gift's paidCents already equals its committedCents; an
  // open/partially-paid pledge's paidCents is whatever has actually been
  // applied so far -- both read live from giving_activities, never
  // recomputed here).
  cashCollectedCents: number;
  // = totalNewCommitmentsCents - cashCollectedCents, but read directly as
  // the sum of each confirmed record's own balanceCents (the CRM's own
  // figure, never re-derived by subtraction here, so a manual pledge
  // balance correction is automatically reflected with zero extra code).
  outstandingCommittedBalanceCents: number;
  // Sum of committedCents across attributed records that do NOT pass
  // countsInGivingTotals (pending_gift/pending_pledge, or any other
  // excluded category/workspace_status) -- tracked separately, never
  // added into any of the confirmed figures above.
  pendingOpportunitiesCents: number;
  goalCents: number | null;
  // null when there is no goal set -- a percentage against nothing would
  // be meaningless, never silently shown as 0% or 100%.
  percentOfGoal: number | null;
  amountRemainingToGoalCents: number | null;
  pledgeCount: number;
  donationCount: number;
  pendingCount: number;
};

export function summarizeTripFinancials(records: AttributedGivingRecord[], goalCents: number | null): TripFinancialSummary {
  let newPledgesSecuredCents = 0;
  let newDonationsSecuredCents = 0;
  let cashCollectedCents = 0;
  let outstandingCommittedBalanceCents = 0;
  let pendingOpportunitiesCents = 0;
  let pledgeCount = 0;
  let donationCount = 0;
  let pendingCount = 0;

  for (const record of records) {
    const committed = record.committedCents ?? 0;
    const paid = record.paidCents ?? 0;
    const balance = record.balanceCents ?? 0;
    const confirmed = countsInGivingTotals({ workspace_status: record.workspaceStatus, category: record.category });

    if (!confirmed) {
      pendingOpportunitiesCents += committed;
      pendingCount += 1;
      continue;
    }
    if (!REAL_COMMITMENT_CATEGORIES.has(record.category)) continue; // defensive: an unexpected confirmed category is neither counted nor pending, never guessed at
    if (PLEDGE_CATEGORIES.has(record.category)) {
      newPledgesSecuredCents += committed;
      outstandingCommittedBalanceCents += balance;
      pledgeCount += 1;
    } else if (record.category === DONATION_CATEGORY) {
      newDonationsSecuredCents += committed;
      donationCount += 1;
    }
    cashCollectedCents += paid;
  }

  const totalNewCommitmentsCents = newPledgesSecuredCents + newDonationsSecuredCents;
  const percentOfGoal = goalCents !== null && goalCents > 0 ? totalNewCommitmentsCents / goalCents : null;
  const amountRemainingToGoalCents = goalCents !== null ? Math.max(0, goalCents - totalNewCommitmentsCents) : null;

  return {
    newPledgesSecuredCents,
    newDonationsSecuredCents,
    totalNewCommitmentsCents,
    cashCollectedCents,
    outstandingCommittedBalanceCents,
    pendingOpportunitiesCents,
    goalCents,
    percentOfGoal,
    amountRemainingToGoalCents,
    pledgeCount,
    donationCount,
    pendingCount,
  };
}
