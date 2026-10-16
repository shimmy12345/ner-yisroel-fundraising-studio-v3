// Ask Fundraising OS -- the real, period-bounded fundraising-progress
// calculation (independent code review, "Final Financial Accuracy Fix for
// Ask Fundraising OS", 2026-10-16). Deliberately split out as a PURE
// function (no `cloudflare:workers` import, no D1 access) exactly like
// lib/relationships/trip-financial-attribution.ts's own
// summarizeTripFinancials -- so the actual arithmetic (not just the SQL
// that feeds it) is directly, cheaply unit-testable with synthetic rows,
// and so capabilities.ts's env-touching wrapper stays a thin "fetch rows,
// call this" shim.
//
// THE CENTRAL DATA-MODEL FACT this whole module is built around (verified
// directly against lib/import/jl-refresh.ts's own doc comment and the
// exact UPDATE/UPSERT statements in app/api/import/route.ts, not assumed):
// giving_activities.activity_date is the JL export's "Due Date" -- a
// forward-looking commitment/obligation date, not a record of when money
// was actually received -- and it is NEVER updated when a payment is
// later applied to that same row (only paid_cents/balance_cents/category/
// updated_at change). It is therefore unusable, on its own, as "the date
// this money came in." created_at, by contrast, is set once at INSERT and
// never touched by any payment-processing path -- it reliably means "when
// this specific giving_activities row first entered the system," which is
// exactly what "new commitments CREATED this month" needs, regardless of
// how its balance later changes.
//
// For a payment applied to a PRE-EXISTING pledge, the one place a real,
// dated payment event is recorded at all is jl_payment_assignment_audits
// (payment_date + applied_cents/new_gift_cents), populated only when the
// incoming payment went through the explicit "apply to pledge / new
// gift" reconciliation review (lib/import/jl-payment-assignment.ts). A
// payment that instead arrives via an ordinary JL reimport refresh (the
// same pledge's Paid/Balance Due columns simply reflect a higher
// cumulative value on re-export, matched by source_fingerprint and
// silently upserted) leaves NO record of which calendar date that
// increase happened on -- only that it had happened by the time of this
// particular import. This module does not estimate or guess at that date
// -- it is disclosed as `limitations` on every result, never silently
// absorbed into a total.

import { REAL_COMMITMENT_CATEGORIES } from "../relationships/pledge-payment-plan.ts";
import { remainderGiftFingerprint } from "../import/jl-payment-assignment.ts";

// The exact SQL this capability runs, defined here (not in capabilities.ts)
// specifically so a Node test can import and execute these literal query
// strings against a real synthetic SQLite database without pulling in
// `cloudflare:workers` (which capabilities.ts itself must import, and
// which has no Node-resolvable module specifier -- see this codebase's
// established constraint, documented in tests/ask-followup-and-meeting-
// brief.test.mjs). Built from REAL_COMMITMENT_CATEGORIES, the same set
// the Trip Fundraising Results Dashboard already uses, rather than a
// separately hand-maintained category list.
const REAL_COMMITMENT_CATEGORIES_SQL = Array.from(REAL_COMMITMENT_CATEGORIES).map((c) => `'${c}'`).join(",");

// "New commitments this month": every pledge/gift FIRST RECORDED this
// period, by committed amount, regardless of payment status -- gated on
// created_at (immutable) rather than activity_date (a due date, see this
// file's header). A later payment against an older pledge can never
// inflate this figure, because that pledge's created_at never changes.
export const NEW_COMMITMENTS_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(committed_cents),0) AS total FROM giving_activities WHERE owner_user_id = ? AND workspace_status = 'active' AND record_origin = 'live' AND category IN (${REAL_COMMITMENT_CATEGORIES_SQL}) AND created_at >= ? AND created_at < ?`;

// Candidate "new money" rows: every commitment-category row first
// recorded this period, with whatever paid_cents it had AT THAT MOMENT
// (e.g. a pledge JL already shows as partially paid the very first time
// it is imported). Deliberately NOT restricted to category='completed_gift'
// -- a brand-new partially-paid pledge's initial paid amount is just as
// reliably "received this period" as a brand-new fully-paid gift's,
// since both are read from the SAME immutable created_at. May overlap
// with PAYMENT_ASSIGNMENT_AUDITS_SQL's own rows (a "new_gift" reconciliation
// decision creates both a giving_activities row AND an audit row sharing
// the same source_fingerprint/payment_fingerprint) -- summarizeFundraisingProgress
// below is what reconciles that overlap, never this query.
export const NEW_GIVING_ROWS_SQL = `SELECT source_fingerprint AS sourceFingerprint, COALESCE(paid_cents,0) AS paidCents FROM giving_activities WHERE owner_user_id = ? AND workspace_status = 'active' AND record_origin = 'live' AND category IN (${REAL_COMMITMENT_CATEGORIES_SQL}) AND created_at >= ? AND created_at < ?`;

// The one place a payment applied to a PRE-EXISTING pledge has an actual
// recorded date (this file's header comment). COALESCE(payment_date,
// created_at) matches the exact fallback app/api/import/route.ts itself
// uses when first writing this row (`candidate.paymentDate ?? now`), so a
// row that somehow has no payment_date is still placed by the best
// available date rather than silently dropped from every period.
export const PAYMENT_ASSIGNMENT_AUDITS_SQL = `SELECT decision_type AS decisionType, applied_cents AS appliedCents, new_gift_cents AS newGiftCents, payment_fingerprint AS paymentFingerprint FROM jl_payment_assignment_audits WHERE user_id = ? AND COALESCE(payment_date, created_at) >= ? AND COALESCE(payment_date, created_at) < ?`;

export const DONORS_CONTACTED_SQL = `SELECT COUNT(DISTINCT donor_id) AS n FROM interactions WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%'`;

export type NewGivingRow = {
  // The row's own primary key is not needed here; sourceFingerprint is
  // the join key against PaymentAssignmentAuditRow.paymentFingerprint.
  sourceFingerprint: string;
  paidCents: number;
};

export type PaymentAssignmentAuditRow = {
  decisionType: "apply_to_pledge" | "new_gift";
  appliedCents: number;
  newGiftCents: number;
  paymentFingerprint: string;
};

export type NewCommitmentTotals = {
  count: number;
  committedCents: number;
};

export type FundraisingProgressInputs = {
  periodLabel: string;
  // Already filtered by the caller to: owner_user_id/record_origin='live',
  // workspace_status='active', category IN REAL_COMMITMENT_CATEGORIES,
  // created_at within [instantStartEpoch, instantEndEpoch) -- i.e. any
  // brand-new pledge or gift FIRST RECORDED this period, with whatever
  // paid_cents it had at that moment. May still overlap with auditRows
  // (see dedupe below).
  newGivingRows: NewGivingRow[];
  // Already filtered by the caller to: user_id, payment_date (falling
  // back to created_at when payment_date is null, matching the exact
  // fallback app/api/import/route.ts itself uses when writing this row)
  // within [instantStartEpoch, instantEndEpoch).
  paymentAssignmentAuditRows: PaymentAssignmentAuditRow[];
  // Already aggregated by the caller: COUNT/SUM(committed_cents) for
  // category IN ('open_pledge','partially_paid_pledge','completed_gift'),
  // owner-scoped/active/live, created_at within the period -- no dedupe
  // concern here, so the caller may aggregate this one in SQL directly.
  newCommitments: NewCommitmentTotals;
  donorsContacted: number;
};

export type FundraisingProgress = {
  periodLabel: string;
  // Money with a KNOWN, dated receipt this period -- never an estimate.
  // = newGiftsReceivedCents + paymentsOnExistingPledgesCents +
  //   newGiftsViaReconciliationCents.
  moneyReceivedCents: number;
  // The number of distinct giving/payment ROWS this total is built from
  // -- NEVER a count of distinct donors (one donor can have several
  // installments). Named explicitly as "transaction" so the compose
  // step can never relabel it "N donors" the way it did, live on
  // Staging (2026-10-16), with this field's earlier, more ambiguous
  // singular "Count" name -- "$X from 15 donors" when 15 was actually a
  // row count -- fixed here at the source, not by asking the model to
  // be more careful.
  moneyReceivedTransactionCount: number;
  // Of the above, how much was a brand-new gift (never a pre-existing
  // pledge) vs. a payment applied against a pledge that could have been
  // created in an earlier period -- so the assistant can truthfully
  // answer "how much of this came from existing pledges" rather than
  // reporting one undifferentiated total.
  newGiftsReceivedCents: number;
  paymentsOnExistingPledgesCents: number;
  // New commitments -- pledges/gifts first CREATED (by created_at, never
  // by activity_date/"Due Date") this period, by committed amount,
  // regardless of whether they have been paid yet.
  newCommitmentsCents: number;
  newCommitmentsCount: number;
  donorsContacted: number;
  // Always present, never omitted, even when empty in a future version
  // of this function -- a disclosed gap is a fact about the data, not
  // conversational flavor text the AI is free to drop.
  limitations: string[];
};

const RECONCILIATION_LIMITATION =
  "A payment applied to an existing pledge through a routine data refresh (rather than the explicit payment-review screen) has no recorded payment date in this system, so it cannot be reliably placed in a specific month. Such payments are not included in this total; they will be reflected once that pledge is fully paid or its payment is processed through the review screen.";

// The core reconciliation: a "new_gift" decision from the payment-review
// screen inserts its own new giving_activities row under the SAME
// fingerprint as its jl_payment_assignment_audits row -- but an
// "apply_to_pledge" decision with an overpayment remainder inserts its
// remainder gift under a DIFFERENT, derived fingerprint
// (remainderGiftFingerprint(paymentFingerprint), imported from the exact
// same lib/import/jl-payment-assignment.ts function the real import route
// uses to build that fingerprint -- never a separately re-implemented
// string convention that could drift from it). Counting either of these
// giving_activities rows AND their audit row's appliedCents/newGiftCents
// would double the same dollar, so both of a single audit row's possible
// fingerprints are excluded from newGivingRows' own total whenever that
// audit row reports any newGiftCents at all.
export function summarizeFundraisingProgress(inputs: FundraisingProgressInputs): FundraisingProgress {
  const auditedFingerprints = new Set<string>();
  for (const row of inputs.paymentAssignmentAuditRows) {
    auditedFingerprints.add(row.paymentFingerprint);
    if (row.newGiftCents > 0) auditedFingerprints.add(remainderGiftFingerprint(row.paymentFingerprint));
  }

  let newGiftsReceivedCents = 0;
  let newGiftsReceivedCount = 0;
  for (const row of inputs.newGivingRows) {
    if (auditedFingerprints.has(row.sourceFingerprint)) continue;
    newGiftsReceivedCents += row.paidCents;
    newGiftsReceivedCount += 1;
  }

  let paymentsOnExistingPledgesCents = 0;
  let newGiftsViaReconciliationCents = 0;
  let reconciliationCount = 0;
  for (const row of inputs.paymentAssignmentAuditRows) {
    paymentsOnExistingPledgesCents += row.appliedCents;
    newGiftsViaReconciliationCents += row.newGiftCents;
    reconciliationCount += 1;
  }

  const moneyReceivedCents = newGiftsReceivedCents + newGiftsViaReconciliationCents + paymentsOnExistingPledgesCents;
  const moneyReceivedTransactionCount = newGiftsReceivedCount + reconciliationCount;

  return {
    periodLabel: inputs.periodLabel,
    moneyReceivedCents,
    moneyReceivedTransactionCount,
    newGiftsReceivedCents: newGiftsReceivedCents + newGiftsViaReconciliationCents,
    paymentsOnExistingPledgesCents,
    newCommitmentsCents: inputs.newCommitments.committedCents,
    newCommitmentsCount: inputs.newCommitments.count,
    donorsContacted: inputs.donorsContacted,
    limitations: [RECONCILIATION_LIMITATION],
  };
}
