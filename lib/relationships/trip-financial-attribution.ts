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
  // Manually Added Prospects (2026-10-25, see docs/AI-HANDOFF.md):
  // `donorId` is null for a commitment recorded against an unlinked
  // (not-yet-in-FOS) prospect -- summarizeTripFinancials below never
  // reads this field itself (display-only everywhere it appears), so
  // widening it to nullable changes no totals math.
  donorId: string | null;
  // The owning trip_prospects row's own id -- always present, unlike
  // donorId, since it is what every UI surface filters an attribution
  // list by (a donor's own uniqueness-per-trip guarantee made donorId a
  // usable, if incidental, key before this feature; an unlinked
  // prospect has no donor at all, so prospectId is the one key that
  // always works for both cases).
  prospectId: string;
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
  // Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md).
  // Only meaningful while `category` is still `pending_gift`/
  // `pending_pledge` -- an already-real (already-JL) category ignores
  // this field entirely, since JL's own confirmation already speaks for
  // it. NULL means "an unconfirmed opportunity" -- excluded from every
  // confirmed total below, exactly like today, regardless of amount.
  // Non-null means a fundraiser has explicitly recorded that the donor
  // confirmed this pledge/donation -- it then counts immediately, before
  // any JL import, per the task's own core requirement.
  donorConfirmedAt: number | null;
  // 'preexisting_pledge_collection': this attribution's own giving_activities
  // record was NOT secured on this trip -- it is an already-real pledge
  // or gift from before the trip that a fundraiser is explicitly linking
  // (and/or reporting a collection against) during this trip. Never
  // contributes to a "new commitment" total, no matter its category or
  // amount -- the task's own "must not be presented as a new commitment
  // secured on that trip."
  commitmentKind: "new_commitment" | "preexisting_pledge_collection";
  // Only meaningful when commitmentKind is 'preexisting_pledge_collection'
  // -- a fundraiser-reported, trip-scoped cash figure, deliberately never
  // read from the underlying pledge's own lifetime paid_cents (see
  // trips-data.ts's own header comment on this field for why).
  reportedCashCollectedCents: number | null;
};

export type TripFinancialSummary = {
  // Confirmed buckets -- a real (already-JL) commitment category that
  // passes countsInGivingTotals, OR a pending_gift/pending_pledge this
  // feature's own donorConfirmedAt marks as donor-confirmed. Excludes
  // every `commitmentKind === "preexisting_pledge_collection"` record
  // unconditionally -- collecting on an old pledge is never a new
  // commitment, regardless of its own category or confirmation state.
  newPledgesSecuredCents: number;
  newDonationsSecuredCents: number;
  // = newPledgesSecuredCents + newDonationsSecuredCents. A pledge counts
  // in full the moment it is confirmed and attributed -- a later partial
  // payment against it never changes this figure (only cashCollectedCents
  // moves).
  totalNewCommitmentsCents: number;
  // Cash collected, split by where it is recorded (the task's own
  // "distinguishing amounts awaiting JL from amounts recorded in JL"),
  // plus the combined top-line figure most summary views show.
  //
  // Recorded in JL: live paidCents from an already-real `new_commitment`
  // category (a completed_gift's paidCents already equals its
  // committedCents; an open/partially-paid pledge's paidCents is
  // whatever has actually been applied so far) -- read live from
  // giving_activities, never recomputed here, and completely unaffected
  // by anything pending or donor-confirmed.
  cashCollectedRecordedInJlCents: number;
  // Awaiting JL: a confirmed pending_gift's full committed amount (a
  // "gift" has no partial-payment concept -- the donor is reported to
  // have handed it over in full, just not yet JL-recorded; a confirmed
  // pending_pledge contributes 0 here, since nothing has been paid on a
  // brand-new pledge yet) PLUS every preexisting_pledge_collection
  // attribution's own reportedCashCollectedCents (a trip-reported figure
  // for an old pledge, never the pledge's lifetime paid_cents -- see
  // AttributedGivingRecord's own doc comment on reportedCashCollectedCents).
  cashCollectedAwaitingJlCents: number;
  cashCollectedCents: number;
  // Outstanding pledge balance, split the same way, plus the combined
  // figure. Recorded in JL: live balanceCents from a real, already-JL,
  // `new_commitment` pledge. Awaiting JL: a confirmed pending_pledge's
  // full committed amount (nothing paid pre-JL, so the whole amount is
  // outstanding) -- the task's own "with any provisional amounts
  // clearly identified."
  outstandingBalanceRecordedInJlCents: number;
  outstandingBalanceAwaitingJlCents: number;
  outstandingCommittedBalanceCents: number;
  // How much of cashCollectedAwaitingJlCents came from collecting on a
  // pledge from BEFORE this trip (commitmentKind ===
  // "preexisting_pledge_collection") -- broken out so the trip interface
  // can show it as cash collected without implying it was a new
  // commitment secured on this trip.
  preexistingPledgeCollectionCashCents: number;
  // Sum of committedCents across UNCONFIRMED pending_gift/pending_pledge
  // records only (donorConfirmedAt is null) -- a confirmed-but-awaiting-
  // JL record has already moved into the counted totals above and is no
  // longer part of this bucket.
  pendingOpportunitiesCents: number;
  goalCents: number | null;
  // null when there is no goal set -- a percentage against nothing would
  // be meaningless, never silently shown as 0% or 100%.
  percentOfGoal: number | null;
  amountRemainingToGoalCents: number | null;
  pledgeCount: number;
  donationCount: number;
  pendingCount: number;
  // Confirmed pending_pledge/pending_gift records now counted above but
  // not yet reflected in a JL import -- split by category (2026-10-21
  // fix, see docs/AI-HANDOFF.md: a combined `awaitingJlCount` let a
  // donor-confirmed DONATION inflate the "New pledges secured" card's
  // own awaiting-JL count, since both categories incremented the same
  // counter). `awaitingJlPledgeCount` is always <= `pledgeCount`;
  // `awaitingJlDonationCount` is always <= `donationCount`.
  awaitingJlPledgeCount: number;
  awaitingJlDonationCount: number;
};

export function summarizeTripFinancials(records: AttributedGivingRecord[], goalCents: number | null): TripFinancialSummary {
  let newPledgesSecuredCents = 0;
  let newDonationsSecuredCents = 0;
  let cashCollectedRecordedInJlCents = 0;
  let cashCollectedAwaitingJlCents = 0;
  let outstandingBalanceRecordedInJlCents = 0;
  let outstandingBalanceAwaitingJlCents = 0;
  let preexistingPledgeCollectionCashCents = 0;
  let pendingOpportunitiesCents = 0;
  let pledgeCount = 0;
  let donationCount = 0;
  let pendingCount = 0;
  let awaitingJlPledgeCount = 0;
  let awaitingJlDonationCount = 0;

  for (const record of records) {
    const committed = record.committedCents ?? 0;
    const paid = record.paidCents ?? 0;
    const balance = record.balanceCents ?? 0;
    const isPendingCategory = record.category === "pending_gift" || record.category === "pending_pledge";

    // Collecting on a pledge from before the trip is never a new
    // commitment, regardless of its category or confirmation state --
    // only its own trip-reported cash figure is ever counted, and only
    // as cash collected.
    if (record.commitmentKind === "preexisting_pledge_collection") {
      const reported = record.reportedCashCollectedCents ?? 0;
      preexistingPledgeCollectionCashCents += reported;
      cashCollectedAwaitingJlCents += reported;
      continue;
    }

    if (isPendingCategory) {
      if (!record.donorConfirmedAt) {
        pendingOpportunitiesCents += committed;
        pendingCount += 1;
        continue;
      }
      // Donor-confirmed, awaiting JL import -- counts immediately,
      // before any JL import, per the task's own core requirement.
      if (record.category === "pending_pledge") {
        newPledgesSecuredCents += committed;
        outstandingBalanceAwaitingJlCents += committed; // nothing paid pre-JL by construction (insertPendingPledge always writes paid_cents = 0)
        pledgeCount += 1;
        awaitingJlPledgeCount += 1;
      } else {
        newDonationsSecuredCents += committed;
        cashCollectedAwaitingJlCents += committed; // a confirmed gift is reported received in full -- it has no partial-payment concept
        donationCount += 1;
        awaitingJlDonationCount += 1;
      }
      continue;
    }

    // Real, already-JL category (open_pledge / partially_paid_pledge /
    // completed_gift) -- unaffected by anything pending or donor-confirmed.
    const confirmed = countsInGivingTotals({ workspace_status: record.workspaceStatus, category: record.category });
    if (!confirmed) {
      // Defensive: e.g. needs_review/hidden -- excluded for any reason
      // falls into the same "not yet confirmed" bucket, never silently
      // dropped from every total with no visibility at all.
      pendingOpportunitiesCents += committed;
      pendingCount += 1;
      continue;
    }
    if (!REAL_COMMITMENT_CATEGORIES.has(record.category)) continue; // defensive: an unexpected confirmed category is neither counted nor pending, never guessed at
    if (PLEDGE_CATEGORIES.has(record.category)) {
      newPledgesSecuredCents += committed;
      outstandingBalanceRecordedInJlCents += balance;
      pledgeCount += 1;
    } else if (record.category === DONATION_CATEGORY) {
      newDonationsSecuredCents += committed;
      donationCount += 1;
    }
    cashCollectedRecordedInJlCents += paid;
  }

  const totalNewCommitmentsCents = newPledgesSecuredCents + newDonationsSecuredCents;
  const cashCollectedCents = cashCollectedRecordedInJlCents + cashCollectedAwaitingJlCents;
  const outstandingCommittedBalanceCents = outstandingBalanceRecordedInJlCents + outstandingBalanceAwaitingJlCents;
  const percentOfGoal = goalCents !== null && goalCents > 0 ? totalNewCommitmentsCents / goalCents : null;
  const amountRemainingToGoalCents = goalCents !== null ? Math.max(0, goalCents - totalNewCommitmentsCents) : null;

  return {
    newPledgesSecuredCents,
    newDonationsSecuredCents,
    totalNewCommitmentsCents,
    cashCollectedRecordedInJlCents,
    cashCollectedAwaitingJlCents,
    cashCollectedCents,
    outstandingBalanceRecordedInJlCents,
    outstandingBalanceAwaitingJlCents,
    outstandingCommittedBalanceCents,
    preexistingPledgeCollectionCashCents,
    pendingOpportunitiesCents,
    goalCents,
    percentOfGoal,
    amountRemainingToGoalCents,
    pledgeCount,
    donationCount,
    pendingCount,
    awaitingJlPledgeCount,
    awaitingJlDonationCount,
  };
}
