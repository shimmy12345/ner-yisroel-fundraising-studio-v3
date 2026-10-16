// Ask Fundraising OS -- the real, period-bounded fundraising-progress
// calculation. Deliberately split out as a PURE function (no
// `cloudflare:workers` import, no D1 access) exactly like
// lib/relationships/trip-financial-attribution.ts's own
// summarizeTripFinancials -- so the actual arithmetic (not just the SQL
// that feeds it) is directly, cheaply unit-testable with synthetic rows,
// and so capabilities.ts's env-touching wrapper stays a thin "fetch rows,
// call this" shim.
//
// FOUR independent reviews have progressively corrected this module
// (all 2026-10-16). The full history matters -- each later round found a
// real defect in the previous one's own fix, not a cosmetic nit -- so it
// is kept here rather than summarized away:
//
// 1. ORIGINAL BUG: filtered by giving_activities.activity_date, which
//    lib/import/jl-refresh.ts's own doc comment establishes is the JL
//    export's "Due Date" -- a forward-looking commitment date, never
//    updated once a payment is applied to that row. Fixed by switching
//    to created_at (immutable, set once at insert) for "what was first
//    recorded this period," and by reconciling against
//    jl_payment_assignment_audits for payments on pre-existing pledges.
// 2. CUMULATIVE-READ BUG: a new row's CURRENT paid_cents was read live
//    at query time for any row whose created_at fell in the requested
//    period -- so a LATER, unrelated reimport against an old-but-in-
//    period row could retroactively change a previously-reported closed
//    month's own total. Attempted fix: require `updated_at = created_at`
//    (exclude the row entirely once touched).
// 3. THAT FIX'S OWN DEFECT: excluding the whole row once touched could
//    retroactively DEFLATE a previously-reported total to $0 -- just as
//    wrong, in the other direction, as the original bug. Correct fix:
//    reconstruct what paid_cents actually WAS "as of this period's own
//    end" from giving_activity_import_changes -- a change-log table that
//    already exists (since the very first migration that created
//    giving_activities itself, drizzle/0003_jl_donation_import.sql) and
//    is written, atomically, in the SAME D1 batch as every single UPDATE
//    this app makes to a giving_activities row. Its `previous_json`
//    column is the row's own prior state immediately before that update.
//    A correlated subquery finds the EARLIEST later update and reads
//    paid_cents from its previous_json -- the value true for the rest of
//    the period -- which is genuinely, provably stable once a period has
//    closed (a change-log entry's created_at is real wall-clock time and
//    can never retroactively become earlier).
// 4. TWO DEFECTS IN THAT FIX, found by "Final Financial Reporting
//    Integrity and Data Isolation Review":
//    a. MISLABELING: a reconstructed "balance as of period end" was
//       being presented as "verified money received" -- but reconciling
//       WHICH ROW/PERIOD a snapshot belongs to is not the same as
//       proving WHEN the underlying cash was received. A pledge paid in
//       full in September but not imported into this app until October
//       would have its entire $500 counted as "received in October,"
//       which is simply false -- it was recorded in October, not
//       received then. Fixed by renaming this figure to
//       recordedPaidBalanceCents (Category B below) and reserving
//       "verified"/"received" language strictly for Category A.
//    b. CROSS-OWNER ISOLATION GAP: the correlated subquery against
//       giving_activity_import_changes matched only on source_fingerprint,
//       with NO owner/user scoping at all -- giving_activity_import_changes
//       has no owner_user_id column of its own (confirmed directly
//       against drizzle/0003_jl_donation_import.sql, not assumed), and
//       source_fingerprint is a pure SHA-256 hash of row CONTENT (JL
//       code, date, item, description, campaign, amount, company --
//       lib/import/jl-donations.ts's canonicalFingerprint), with no user
//       or donor identity folded in at all. giving_activities itself is
//       safe (drizzle/0004_personalization_live_data.sql replaced the
//       original 2-column unique index with a 3-column
//       (owner_user_id, external_source, source_fingerprint) one,
//       specifically to allow two different users to coincidentally
//       share a fingerprint without colliding) -- but
//       giving_activity_import_changes was never given the same
//       protection, so two different users whose JL exports happen to
//       produce an identical fingerprint (very plausible: JL "Code"
//       values are small, organization-assigned integers, easily
//       reused across unrelated accounts) could have one user's
//       reconstruction silently read a change-log row written by a
//       completely different user's import. Fixed by joining the
//       subquery through data_imports (which DOES have user_id) and
//       requiring that import's own user_id to match the row being
//       reconstructed's owner_user_id.
//
// THE THREE HONEST CATEGORIES this module now reports, never conflated:
//   A. Verified dated payments -- a real, individually-dated transaction
//      (jl_payment_assignment_audits, payment_date IS NOT NULL -- never
//      the created_at/processing-time fallback some earlier code used,
//      which this round also removed; see VERIFIED_DATED_PAYMENT_AUDITS_SQL).
//   B. Recorded paid balance -- what a commitment-category row first
//      recorded THIS period shows as paid, reconstructed to its value
//      "as of this period's own end" when later touched. A real,
//      stable, reconstructable FACT ABOUT THE RECORD -- never a claim
//      about when the underlying cash arrived, because import date and
//      receipt date are not the same thing.
//   C. New commitments -- committed_cents of a row first recorded this
//      period, regardless of payment status. Never confused with money
//      received of any kind.
// A payment applied to a PRE-EXISTING pledge (created in an earlier
// period) through an ordinary reimport refresh, with no payment-review
// decision, remains the one gap nothing here can verify -- disclosed as
// `limitations`, never guessed at, never silently folded into A, B, or C.

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

// Category C -- "new commitments this period": every pledge/gift FIRST
// RECORDED this period, by committed amount, regardless of payment
// status -- gated on created_at (immutable) rather than activity_date (a
// due date, see this file's header). A later payment against an older
// pledge can never inflate this figure, because that pledge's created_at
// never changes, and (unlike paid_cents/balance_cents) committed_cents
// itself is never touched by either payment-processing UPDATE/UPSERT
// path either.
export const NEW_COMMITMENTS_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(committed_cents),0) AS total FROM giving_activities WHERE owner_user_id = ? AND workspace_status = 'active' AND record_origin = 'live' AND category IN (${REAL_COMMITMENT_CATEGORIES_SQL}) AND created_at >= ? AND created_at < ?`;

// Category B -- "recorded paid balance": every commitment-category row
// first recorded this period, with its paid_cents reconstructed to "as
// of this period's own end" (see this file's header, item 3) rather than
// its possibly-later-touched current value. This is a RECORD-KEEPING
// fact (what the row showed as paid by a given date), never a claim
// about when the underlying cash was physically received -- a pledge
// paid in full before it was ever imported would have its initial
// paid_cents counted here too, correctly, as a balance recorded this
// period, and NEVER relabeled "received this period" (see this file's
// header, item 4a).
//
// The correlated subquery finds the EARLIEST update to this row (by
// source_fingerprint) that happened ON OR AFTER periodEnd, and reads
// that update's own previous_json.paid_cents -- the value this row held
// immediately before that later update, i.e. for the entire remainder of
// this period. When no such later update exists (untouched since
// creation, or this period has not ended yet), COALESCE falls through to
// the row's own CURRENT paid_cents, which at that point already IS the
// correct value.
//
// CRITICAL: the subquery is scoped to the SAME OWNER via a join through
// data_imports (this file's header, item 4b) -- giving_activity_import_changes
// has no owner_user_id column of its own, and source_fingerprint is a
// pure content hash with no user or donor identity folded in, so two
// different users whose JL exports happen to produce an identical
// fingerprint must never have one user's reconstruction read the
// other's change-log row. di.user_id = ga.owner_user_id is what
// prevents that.
//
// Bind order matters -- periodEnd is bound FIRST (it is the first `?`
// in the SQL text, inside the subquery), then userId, then periodStart,
// then periodEnd again for the outer created_at < periodEnd bound.
//
// Deliberately NOT restricted to category='completed_gift' -- a
// brand-new partially-paid pledge's initial paid amount is just as
// reliably "recorded this period" as a brand-new fully-paid gift's. May
// overlap with VERIFIED_DATED_PAYMENT_AUDITS_SQL's own rows (a "new_gift"
// reconciliation decision creates both a giving_activities row AND an
// audit row sharing the same source_fingerprint/payment_fingerprint) --
// summarizeFundraisingProgress below is what reconciles that overlap,
// never this query.
export const RECORDED_PAID_BALANCE_ROWS_SQL = `
  SELECT ga.source_fingerprint AS sourceFingerprint,
    COALESCE(
      (SELECT json_extract(c.previous_json, '$.paid_cents')
         FROM giving_activity_import_changes c
         JOIN data_imports di ON di.id = c.import_id
         WHERE c.source_fingerprint = ga.source_fingerprint
           AND di.user_id = ga.owner_user_id
           AND c.change_type = 'update'
           AND c.created_at >= ?
         ORDER BY c.created_at ASC
         LIMIT 1),
      ga.paid_cents
    ) AS paidCents
  FROM giving_activities ga
  WHERE ga.owner_user_id = ? AND ga.workspace_status = 'active' AND ga.record_origin = 'live'
    AND ga.category IN (${REAL_COMMITMENT_CATEGORIES_SQL})
    AND ga.created_at >= ? AND ga.created_at < ?
`;

// Category A -- "verified dated payments": the one place a payment
// applied to a PRE-EXISTING pledge has an actual recorded date. Requires
// payment_date IS NOT NULL explicitly -- an earlier version of this
// query used COALESCE(payment_date, created_at), silently treating the
// IMPORT/PROCESSING timestamp as if it were a verified payment date when
// no real one was on file. That fallback is removed: a row with no
// recorded payment_date is never counted here (see
// UNDATED_PAYMENT_AUDITS_SQL below for how it is instead surfaced,
// honestly, as a disclosed data-quality gap). In practice this should be
// rare to nonexistent -- lib/import/jl-payment-assignment.ts's own
// buildPaymentCandidates blocks (never commits) a payment row with no
// parseable date before it can ever reach this table -- but this query
// no longer ASSUMES that invariant holds; it verifies payment_date
// itself, every time.
export const VERIFIED_DATED_PAYMENT_AUDITS_SQL = `SELECT decision_type AS decisionType, applied_cents AS appliedCents, new_gift_cents AS newGiftCents, payment_fingerprint AS paymentFingerprint FROM jl_payment_assignment_audits WHERE user_id = ? AND payment_date IS NOT NULL AND payment_date >= ? AND payment_date < ?`;

// The other half of VERIFIED_DATED_PAYMENT_AUDITS_SQL's own fix: every
// payment-review decision this user has EVER made that has NO recorded
// payment_date at all (not period-bound -- a missing date is a data-
// quality fact about the record itself, not something to search for
// within one month). One row per matching audit entry -- deliberately
// NOT pre-aggregated in SQL (mixing COUNT/SUM with a per-row fingerprint
// in one un-grouped SELECT would silently return only one arbitrary
// row's fingerprint); the caller/pure layer derives both the full
// fingerprint list (for excluding these from Category B, so an undated
// reconciliation decision is never silently re-presented as an ordinary
// "new commitment balance" instead) and the disclosed count/total from
// this same row set.
export const UNDATED_PAYMENT_AUDITS_SQL = `SELECT (applied_cents + new_gift_cents) AS cents, payment_fingerprint AS paymentFingerprint FROM jl_payment_assignment_audits WHERE user_id = ? AND payment_date IS NULL`;

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

export type UndatedPaymentAuditTotals = {
  count: number;
  cents: number;
  // One row per distinct fingerprint found -- UNDATED_PAYMENT_AUDITS_SQL
  // returns one result row per matching audit row (GROUP BY is not
  // needed; each payment_fingerprint is already unique per
  // jl_payment_assignment_audits' own (import_id, payment_fingerprint)
  // index in practice, and duplicate exclusion from Category B is safe
  // either way via the Set this module builds).
  fingerprints: string[];
};

export type FundraisingProgressInputs = {
  periodLabel: string;
  // Category B candidates: RECORDED_PAID_BALANCE_ROWS_SQL's own output,
  // already filtered and owner-isolated by the caller. May overlap with
  // the audit rows below (see dedupe in summarizeFundraisingProgress).
  recordedPaidBalanceRows: NewGivingRow[];
  // Category A: VERIFIED_DATED_PAYMENT_AUDITS_SQL's own output -- already
  // filtered to payment_date IS NOT NULL and within this period.
  verifiedDatedPaymentAuditRows: PaymentAssignmentAuditRow[];
  // Every payment-review decision this user has ever made with NO
  // recorded payment_date -- not period-bound (see
  // UNDATED_PAYMENT_AUDITS_SQL's own comment).
  undatedPaymentAudits: UndatedPaymentAuditTotals;
  // Category C, already aggregated by the caller in SQL (no dedupe
  // concern for a simple COUNT/SUM).
  newCommitments: NewCommitmentTotals;
  donorsContacted: number;
};

export type FundraisingProgress = {
  periodLabel: string;
  // Category A -- a real, individually-dated payment transaction. Never
  // an estimate, never a guess at a date, never the import/processing
  // timestamp standing in for a missing one.
  verifiedDatedPaymentsCents: number;
  // The number of distinct payment-review decisions this total is built
  // from -- NEVER a count of distinct donors (one donor can make more
  // than one payment). Named explicitly as "transaction" so the compose
  // step can never relabel it "N donors" the way it did, live on
  // Staging (2026-10-16), with this field's earlier, more ambiguous
  // singular "Count" name -- "$X from 15 donors" when 15 was actually a
  // row count -- fixed here at the source, not by asking the model to
  // be more careful.
  verifiedDatedPaymentsTransactionCount: number;
  // Of Category A, how much was a brand-new gift created through the
  // payment-review screen vs. a dated payment applied against a
  // pre-existing pledge -- both already individually dated, both
  // subsets of verifiedDatedPaymentsCents, never a separate, looser
  // figure.
  newGiftsViaReviewCents: number;
  paymentsOnExistingPledgesCents: number;
  // Category B -- what a commitment-category row first recorded THIS
  // period shows as paid, reconstructed to its value as of this
  // period's own end. A fact about the RECORD, reconstructable and
  // stable once the period has closed -- never a claim about when the
  // underlying cash was actually received, and never labeled "verified"
  // or "received" anywhere in this module or its callers (see this
  // file's header, item 4a).
  recordedPaidBalanceCents: number;
  // Category C -- pledges/gifts first CREATED (by created_at, never by
  // activity_date/"Due Date") this period, by committed amount,
  // regardless of whether they have been paid yet.
  newCommitmentsCents: number;
  newCommitmentsCount: number;
  donorsContacted: number;
  // Always present, never omitted, even when the dynamic entries below
  // are empty -- a disclosed gap is a fact about the data, not
  // conversational flavor text the AI is free to drop. Enforced in the
  // deterministic response layer too (lib/assistant/orchestrator.ts's
  // appendFinancialLimitations), not left to the prompt alone.
  limitations: string[];
};

const BASE_LIMITATION =
  "Verified dated payments (Category A) are real, individually-dated transactions confirmed through the payment-review screen -- never a guess, and never the import date standing in for a missing payment date. Recorded paid balance (Category B) is a DIFFERENT thing: what a pledge or gift first recorded this period shows as paid, as of this period's own end -- a fact about the record, not a claim about when that cash was actually received (a pledge could have been paid in full before it was ever imported into this system). Neither figure includes a payment applied to a PRE-EXISTING pledge (one created in an earlier period) through a routine data refresh with no payment-review decision -- this system has no record of which specific date that money arrived, cannot place it in any specific month, and will never retroactively add it to a later total even once that pledge is fully paid. A payment-event ledger recording the date and amount of every individual payment, not just each pledge's current cumulative balance, would be needed to report a single, fully complete, dated monthly total.";

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

// The core reconciliation: a "new_gift" decision from the payment-review
// screen inserts its own new giving_activities row under the SAME
// fingerprint as its jl_payment_assignment_audits row -- but an
// "apply_to_pledge" decision with an overpayment remainder inserts its
// remainder gift under a DIFFERENT, derived fingerprint
// (remainderGiftFingerprint(paymentFingerprint), imported from the exact
// same lib/import/jl-payment-assignment.ts function the real import route
// uses to build that fingerprint -- never a separately re-implemented
// string convention that could drift from it). Counting a giving_activities
// row in Category B AND its own audit row in Category A would double the
// same dollar under two different labels, so every fingerprint behind a
// Category A row (dated or not -- an UNDATED decision is excluded from B
// too, so its money is never silently re-presented as an ordinary new
// commitment balance instead) is excluded from Category B's own total.
export function summarizeFundraisingProgress(inputs: FundraisingProgressInputs): FundraisingProgress {
  const excludedFingerprints = new Set<string>();
  for (const row of inputs.verifiedDatedPaymentAuditRows) {
    excludedFingerprints.add(row.paymentFingerprint);
    if (row.newGiftCents > 0) excludedFingerprints.add(remainderGiftFingerprint(row.paymentFingerprint));
  }
  for (const fingerprint of inputs.undatedPaymentAudits.fingerprints) {
    excludedFingerprints.add(fingerprint);
  }

  let recordedPaidBalanceCents = 0;
  for (const row of inputs.recordedPaidBalanceRows) {
    if (excludedFingerprints.has(row.sourceFingerprint)) continue;
    recordedPaidBalanceCents += row.paidCents;
  }

  let paymentsOnExistingPledgesCents = 0;
  let newGiftsViaReviewCents = 0;
  let verifiedDatedPaymentsTransactionCount = 0;
  for (const row of inputs.verifiedDatedPaymentAuditRows) {
    paymentsOnExistingPledgesCents += row.appliedCents;
    newGiftsViaReviewCents += row.newGiftCents;
    verifiedDatedPaymentsTransactionCount += 1;
  }

  const limitations = [BASE_LIMITATION];
  if (inputs.undatedPaymentAudits.count > 0) {
    limitations.push(
      `${inputs.undatedPaymentAudits.count} payment-review decision(s) totaling ${formatCents(inputs.undatedPaymentAudits.cents)} have no recorded payment date at all and could not be placed in any period -- flagged as a data-quality gap for manual review, never guessed at or assigned to this or any other month.`,
    );
  }

  return {
    periodLabel: inputs.periodLabel,
    verifiedDatedPaymentsCents: paymentsOnExistingPledgesCents + newGiftsViaReviewCents,
    verifiedDatedPaymentsTransactionCount,
    newGiftsViaReviewCents,
    paymentsOnExistingPledgesCents,
    recordedPaidBalanceCents,
    newCommitmentsCents: inputs.newCommitments.committedCents,
    newCommitmentsCount: inputs.newCommitments.count,
    donorsContacted: inputs.donorsContacted,
    limitations,
  };
}
