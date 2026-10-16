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
//
// SECOND DEFECT, found by a later independent review ("Final Payment
// Accuracy and Financial Data Integrity Review", 2026-10-16) and fixed
// here: a brand-new giving_activities row's CURRENT paid_cents is only
// safe to call "verified money received this period" if that row has
// never been touched since the single import that created it. A row
// created this period but later bumped by a DIFFERENT, later reimport
// (e.g. created Oct 5 with $200 paid, bumped to $500 on Oct 20, bumped
// again to $800 on Nov 10) would otherwise have its CURRENT value
// (whatever it happens to be at query time) misattributed wholesale to
// its creation month -- overstating that month, and, worse, making a
// CLOSED month's own previously-reported total silently grow every time
// a later reimport touches an old pledge, purely because of when the
// query happened to run. updated_at is set to created_at exactly once,
// at insert, and to a LATER value by either payment-processing path on
// any subsequent touch (confirmed directly against app/api/import/
// route.ts's own UPDATE/UPSERT statements) -- so `updated_at =
// created_at` is the one available, already-populated signal that a
// row's current paid_cents is still exactly what was recorded at
// creation, with nothing added since. VERIFIED_NEW_GIVING_ROWS_SQL below
// requires this explicitly: the instant a later import touches an
// in-period row, its contribution to "verified money received" drops to
// zero (never partially estimated), and it can only re-enter a reported
// total through the dated jl_payment_assignment_audits path. This is
// deliberately conservative -- it can under-report, never over-report --
// and it is STABLE: a verified total for a closed month, once computed,
// cannot change on a later re-query, because every row that could still
// change has already been excluded. The separate, explicitly-labeled
// "recorded cumulative paid" figure below still surfaces the CURRENT
// balance on these same new rows for visibility, without ever calling it
// "received this period."

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
// inflate this figure, because that pledge's created_at never changes,
// and (unlike paid_cents/balance_cents) committed_cents itself is never
// touched by either payment-processing UPDATE/UPSERT path either.
//
// This same query also returns the CURRENT cumulative paid_cents for
// these same rows, as cumulativePaidTotal -- NOT "received this period,"
// since it is read live and can include amounts added by a LATER import
// (the exact defect VERIFIED_NEW_GIVING_ROWS_SQL below exists to keep
// out of the verified figure). Surfaced only as the separate, explicitly
// "recorded cumulative, not necessarily dated" figure the fundraiser can
// see for visibility (lib/assistant/capabilities.ts's
// recordedCumulativePaidTotal).
export const NEW_COMMITMENTS_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(committed_cents),0) AS total, COALESCE(SUM(paid_cents),0) AS cumulativePaidTotal FROM giving_activities WHERE owner_user_id = ? AND workspace_status = 'active' AND record_origin = 'live' AND category IN (${REAL_COMMITMENT_CATEGORIES_SQL}) AND created_at >= ? AND created_at < ?`;

// Candidate VERIFIED "new money" rows: every commitment-category row
// first recorded this period, whose paid_cents has NOT been touched
// since (updated_at = created_at -- see this file's header comment for
// why that is the one reliable signal available). A row created this
// period but bumped by a LATER reimport is excluded here entirely, not
// partially estimated -- its current paid_cents could include money
// added at any later time, including a future period relative to this
// one. Deliberately NOT restricted to category='completed_gift' -- a
// brand-new partially-paid pledge's initial paid amount (if still
// untouched) is just as reliably "received this period" as a brand-new
// fully-paid gift's. May overlap with PAYMENT_ASSIGNMENT_AUDITS_SQL's
// own rows (a "new_gift" reconciliation decision creates both a
// giving_activities row AND an audit row sharing the same
// source_fingerprint/payment_fingerprint) -- summarizeFundraisingProgress
// below is what reconciles that overlap, never this query.
export const VERIFIED_NEW_GIVING_ROWS_SQL = `SELECT source_fingerprint AS sourceFingerprint, COALESCE(paid_cents,0) AS paidCents FROM giving_activities WHERE owner_user_id = ? AND workspace_status = 'active' AND record_origin = 'live' AND category IN (${REAL_COMMITMENT_CATEGORIES_SQL}) AND created_at >= ? AND created_at < ? AND updated_at = created_at`;

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
  // CURRENT cumulative paid_cents across these same rows -- read live, so
  // it can include an amount added by a later import. Never treated as
  // "received this period" (see VERIFIED_NEW_GIVING_ROWS_SQL's own
  // comment); surfaced only as the separate recordedCumulativePaidCents
  // figure below.
  cumulativePaidCents: number;
};

export type FundraisingProgressInputs = {
  periodLabel: string;
  // Already filtered by the caller to: owner_user_id/record_origin='live',
  // workspace_status='active', category IN REAL_COMMITMENT_CATEGORIES,
  // created_at within [instantStartEpoch, instantEndEpoch), AND
  // updated_at = created_at -- i.e. a brand-new pledge or gift FIRST
  // RECORDED this period whose paid_cents is STILL exactly what it was
  // at that single creation event, never touched since. May still
  // overlap with auditRows (see dedupe below).
  newGivingRows: NewGivingRow[];
  // Already filtered by the caller to: user_id, payment_date (falling
  // back to created_at when payment_date is null, matching the exact
  // fallback app/api/import/route.ts itself uses when writing this row)
  // within [instantStartEpoch, instantEndEpoch).
  paymentAssignmentAuditRows: PaymentAssignmentAuditRow[];
  // Already aggregated by the caller: COUNT/SUM(committed_cents)/
  // SUM(paid_cents) for category IN REAL_COMMITMENT_CATEGORIES,
  // owner-scoped/active/live, created_at within the period -- no dedupe
  // concern here, so the caller may aggregate this one in SQL directly.
  newCommitments: NewCommitmentTotals;
  donorsContacted: number;
};

export type FundraisingProgress = {
  periodLabel: string;
  // VERIFIED money with a KNOWN, dated receipt this period -- never an
  // estimate, never a guess at a date. = newGiftsReceivedCents +
  // paymentsOnExistingPledgesCents + newGiftsViaReconciliationCents.
  // STABLE once computed for a closed period: nothing a later import
  // does can change it (see this file's header comment).
  verifiedMoneyReceivedCents: number;
  // The number of distinct giving/payment ROWS this total is built from
  // -- NEVER a count of distinct donors (one donor can have several
  // installments). Named explicitly as "transaction" so the compose
  // step can never relabel it "N donors" the way it did, live on
  // Staging (2026-10-16), with this field's earlier, more ambiguous
  // singular "Count" name -- "$X from 15 donors" when 15 was actually a
  // row count -- fixed here at the source, not by asking the model to
  // be more careful.
  verifiedMoneyReceivedTransactionCount: number;
  // Of the above, how much was a brand-new gift (never a pre-existing
  // pledge) vs. a payment applied against a pledge that could have been
  // created in an earlier period -- so the assistant can truthfully
  // answer "how much of this came from existing pledges" rather than
  // reporting one undifferentiated total. Both are already verified --
  // subsets of verifiedMoneyReceivedCents, not a separate, looser figure.
  newGiftsReceivedCents: number;
  paymentsOnExistingPledgesCents: number;
  // The CURRENT cumulative paid_cents across every commitment created
  // this period -- a superset of verifiedMoneyReceivedCents's own new-
  // row component that can include money added by a LATER, undated
  // reimport. Deliberately never called "received"; exists only so the
  // fundraiser can see a pledge's real current balance without this
  // capability pretending to know when every dollar of it arrived.
  recordedCumulativePaidCents: number;
  // New commitments -- pledges/gifts first CREATED (by created_at, never
  // by activity_date/"Due Date") this period, by committed amount,
  // regardless of whether they have been paid yet.
  newCommitmentsCents: number;
  newCommitmentsCount: number;
  donorsContacted: number;
  // Always present, never omitted, even when empty in a future version
  // of this function -- a disclosed gap is a fact about the data, not
  // conversational flavor text the AI is free to drop. Enforced in the
  // deterministic response layer too (lib/assistant/orchestrator.ts's
  // appendFinancialLimitations), not left to the prompt alone.
  limitations: string[];
};

// Rewritten (independent review, 2026-10-16) -- the prior wording said
// an omitted payment "will be reflected once that pledge is fully
// paid," which is false: this capability never retroactively attributes
// a past, undated payment to any month, no matter what later happens to
// that pledge. The revised text states plainly what IS included, what
// CANNOT be placed in a month and why, and what would actually close
// the gap (see docs/AI-HANDOFF.md's recommended payment-event-ledger
// design for the full system-wide proposal, not implemented here).
const RECONCILIATION_LIMITATION =
  "Verified dated payments above include only: (1) new pledges or gifts first recorded this period whose balance has not changed since, and (2) payments confirmed through the payment-review screen with a known date. They do NOT include a later increase to an existing pledge's paid balance that arrived through a routine data refresh with no payment-review decision -- this system has no record of which date that money arrived, cannot place it in any specific month, and will never retroactively add it to a later total even once that pledge is fully paid. The actual total received this period may be understated as a result. A payment-event ledger recording the date and amount of every individual payment, not just each pledge's current cumulative balance, would be needed to close this gap.";

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

  const verifiedMoneyReceivedCents = newGiftsReceivedCents + newGiftsViaReconciliationCents + paymentsOnExistingPledgesCents;
  const verifiedMoneyReceivedTransactionCount = newGiftsReceivedCount + reconciliationCount;

  return {
    periodLabel: inputs.periodLabel,
    verifiedMoneyReceivedCents,
    verifiedMoneyReceivedTransactionCount,
    newGiftsReceivedCents: newGiftsReceivedCents + newGiftsViaReconciliationCents,
    paymentsOnExistingPledgesCents,
    recordedCumulativePaidCents: inputs.newCommitments.cumulativePaidCents,
    newCommitmentsCents: inputs.newCommitments.committedCents,
    newCommitmentsCount: inputs.newCommitments.count,
    donorsContacted: inputs.donorsContacted,
    limitations: [RECONCILIATION_LIMITATION],
  };
}
