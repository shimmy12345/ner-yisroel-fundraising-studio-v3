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
// Accuracy and Financial Data Integrity Review", 2026-10-16): the fix
// that round shipped required `updated_at = created_at` -- a row
// touched by ANY later reimport dropped OUT of the verified figure
// entirely, for every period, forever. That stopped the figure from
// ever INFLATING, but introduced the opposite problem: it could DEFLATE
// a previously-reported total back to zero. A pledge created Oct 5 with
// $200 already paid, reported honestly as $200 on Oct 20, would report
// **$0** for October if asked again on Dec 1, merely because a Nov 10
// reimport had since touched the same row -- even though the original
// $200 was never contradicted, reduced, or shown to be wrong. A figure
// that can retroactively DROP is not meaningfully more "stable" than
// one that can retroactively RISE; both change a previously-reported
// number for a reason that has nothing to do with October.
//
// THIRD, CORRECT FIX (a later independent review, "Resolve Historical
// Payment Totals Before Production", 2026-10-16): rather than treating
// a touched row as all-trustworthy or all-untrustworthy, reconstruct
// what paid_cents actually WAS at the end of the requested period, from
// data this app already records on every single update --
// giving_activity_import_changes. That table exists since the very
// first migration that created giving_activities itself (drizzle/
// 0003_jl_donation_import.sql -- confirmed directly, not assumed, so
// there is no historical gap to worry about for any row this app has
// ever stored) and is written, atomically, in the SAME D1 batch as
// every single UPDATE this app ever makes to a giving_activities row
// (both the ordinary reimport upsert and the payment-review pledge
// update -- confirmed against app/api/import/route.ts's own statements
// array, never two separate writes that could drift apart). Its
// `previous_json` column is the row's own prior state -- including
// paid_cents -- immediately BEFORE that specific update was applied.
//
// This means: for any row, "what was paid_cents at the end of period P"
// is well-defined and fully reconstructable: find the EARLIEST update
// to that row whose own created_at falls ON OR AFTER period P's end,
// and read paid_cents from THAT update's own previous_json (the value
// that was true immediately before that later update happened, which
// is exactly the value that was true for the entire remainder of period
// P). If no such later update exists yet (the row has never been
// touched since, or period P itself has not ended yet), the row's
// CURRENT paid_cents already IS that value.
//
// Critically, this is genuinely, provably STABLE once period P has
// closed: a change-log row's created_at is always the real wall-clock
// time it was written, which can never retroactively become earlier --
// so no future import can ever insert a NEW change-log entry timestamped
// before period P's own end. Every entry that could ever affect "what
// was true as of P's end" already exists the moment P ends, and never
// changes again. Re-querying October in December therefore reconstructs
// exactly the same $500 -- not $200 (the first fix's inflation bug) and
// not $0 (the second fix's deflation bug) -- because the Oct 20 update
// (which happened BEFORE November started) already fixed "$500 as of
// Oct 31" as a permanent historical fact the moment October ended.
//
// This is still not a true PAYMENT date (Section 4 of docs/AI-HANDOFF.md
// still applies: the exact calendar day within the period that money was
// actually received remains unknown for this path) -- it is the
// CORRECT cumulative balance AS OF A SPECIFIC PERIOD BOUNDARY, reusing
// only data this app already writes on every update, with no backfill,
// no new table, and no import-pipeline change. The separate, explicitly
// -labeled "recorded cumulative paid" figure still surfaces the row's
// CURRENT (live, today) balance for visibility, which is a different,
// still-moving number whenever the period being asked about is the
// current, still-open one.

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
// first recorded this period, with its paid_cents reconstructed to
// "as of this period's own end" (see this file's header comment) rather
// than its possibly-later-touched current value. The correlated
// subquery finds the EARLIEST update to this row (by source_fingerprint)
// that happened ON OR AFTER periodEnd, and reads that update's own
// previous_json.paid_cents -- the value this row held immediately before
// that later update, i.e. for the entire remainder of this period. When
// no such later update exists (untouched since creation, or this period
// has not ended yet), COALESCE falls through to the row's own CURRENT
// paid_cents, which at that point already IS the correct value.
//
// Bind order matters -- periodEnd is bound FIRST (it is the first `?`
// in the SQL text, inside the subquery), then userId, then periodStart,
// then periodEnd again for the outer created_at < periodEnd bound.
//
// Deliberately NOT restricted to category='completed_gift' -- a
// brand-new partially-paid pledge's initial paid amount is just as
// reliably "received this period" as a brand-new fully-paid gift's. May
// overlap with PAYMENT_ASSIGNMENT_AUDITS_SQL's own rows (a "new_gift"
// reconciliation decision creates both a giving_activities row AND an
// audit row sharing the same source_fingerprint/payment_fingerprint) --
// summarizeFundraisingProgress below is what reconciles that overlap,
// never this query.
export const VERIFIED_NEW_GIVING_ROWS_SQL = `
  SELECT ga.source_fingerprint AS sourceFingerprint,
    COALESCE(
      (SELECT json_extract(c.previous_json, '$.paid_cents')
         FROM giving_activity_import_changes c
         WHERE c.source_fingerprint = ga.source_fingerprint
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
// Updated once more (independent review, "Resolve Historical Payment
// Totals Before Production", 2026-10-16) to stop describing new rows as
// "whose balance has not changed since" -- that was true of the SECOND
// round's fix, not the current one, which reconstructs a new row's
// value as of this period's own end rather than excluding it the moment
// it is ever touched. The remaining, still-real gap is narrower and
// specifically about PRE-EXISTING (older) pledges' payments that arrive
// via the ordinary reimport path, not newly-created ones.
const RECONCILIATION_LIMITATION =
  "Verified dated payments above include only: (1) new pledges or gifts first recorded this period, each correctly reflecting every change recorded for it BY THE END of this period, and (2) payments confirmed through the payment-review screen with a known date. They do NOT include a payment applied to a PRE-EXISTING pledge (one created in an earlier period) through a routine data refresh with no payment-review decision -- this system has no record of which specific date that money arrived, cannot place it in any specific month, and will never retroactively add it to a later total even once that pledge is fully paid. The actual total received this period may be understated as a result. A payment-event ledger recording the date and amount of every individual payment, not just each pledge's current cumulative balance, would be needed to close this gap.";

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
