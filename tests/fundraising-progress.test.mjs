import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { summarizeFundraisingProgress, NEW_COMMITMENTS_SQL, VERIFIED_NEW_GIVING_ROWS_SQL, PAYMENT_ASSIGNMENT_AUDITS_SQL, DONORS_CONTACTED_SQL } from "../lib/assistant/fundraising-progress.ts";
import { appendFinancialLimitations, MAX_ANSWER_LENGTH } from "../lib/assistant/protocol.ts";
import { localMonthBoundaries } from "../lib/workspace/local-time.ts";

// Final Financial Accuracy Fix for Ask Fundraising OS (independent code
// review, 2026-10-16), and the follow-up "Final Payment Accuracy and
// Financial Data Integrity Review" (also 2026-10-16) that found the
// first round's fix could still misattribute a LATER, undated reimport's
// payment to a pledge's ORIGINAL creation month, purely because that
// pledge's created_at fell in-period and its CURRENT paid_cents was read
// live at query time. Three layers of regression coverage:
//   - Part A exercises summarizeFundraisingProgress -- the pure dedup/
//     reconciliation arithmetic -- directly with synthetic row objects.
//   - Part B runs the EXACT, literal SQL constants this feature's own
//     capabilities.ts uses (imported from lib/assistant/fundraising-
//     progress.ts, never re-typed here) against a real in-memory SQLite
//     database built from this repo's own migrations, covering every
//     scenario the first review asked for.
//   - Part C is the cumulative-payment lifecycle this second review
//     specifically asked to be traced: a pledge imported partially paid,
//     then bumped by a LATER ordinary reimport within the same month,
//     then bumped again by a reimport in the FOLLOWING month -- checked
//     at each stage, including re-querying a CLOSED month after a later
//     import to prove its own previously-reported total never changes.
// Same harness convention as tests/asks.test.mjs/tests/data-health.test.mjs
// (node:sqlite's DatabaseSync + the real drizzle/*.sql migration files).

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const ET = "America/New_York";

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(read(`drizzle/${file}`));
  }
  return database;
}

function seed(database, now) {
  database.exec(`INSERT INTO users (id,email,timezone,household_import_review_mode,created_at,updated_at) VALUES ('user-1','owner@example.test','America/New_York','auto_unchanged',${now},${now})`);
  database.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('donor-a','user-1','live','Donor A',${now},${now})`);
  database.exec(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES ('import-1','user-1','export.csv','hash-1','completed','{}',${now})`);
}

function insertGivingActivity(database, row) {
  database.prepare(`INSERT INTO giving_activities
    (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.donorId ?? "donor-a", row.ownerUserId ?? "user-1", "JL Solutions", "CODE1", row.sourceFingerprint,
    row.activityDate ?? row.createdAt, row.committedCents, row.paidCents, row.committedCents - row.paidCents,
    row.category, row.recordOrigin ?? "live", row.workspaceStatus ?? "active", "{}", row.createdAt, row.createdAt,
  );
}

// Simulates exactly what app/api/import/route.ts's own pledgeUpdateStatements/
// activityStatements ON CONFLICT DO UPDATE actually does on a reimport that
// detects a genuine change, as ONE atomic batch (confirmed directly against
// that file's own env.DB.batch(statements) call, never two separate
// writes that could drift apart):
//   1. A giving_activity_import_changes row recording the row's PRIOR
//      state (critically, its prior paid_cents) under a fresh import_id
//      and this reimport's own created_at.
//   2. The actual UPDATE: paid_cents/balance_cents/category/updated_at
//      move; committed_cents and (critically) created_at and
//      activity_date are NEVER touched.
// A reimport that detects NO change (lib/import/jl-donation-match.ts's
// own proposedUpdates filter) never calls this at all -- see the
// "repeated imports, unchanged amounts" scenario below, which
// deliberately does not call this helper.
let reimportCounter = 0;
function reimportBumpsPaid(database, id, newPaidCents, newBalanceCents, newCategory, touchedAt) {
  reimportCounter += 1;
  const importId = `reimport-${reimportCounter}`;
  const prior = database.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category FROM giving_activities WHERE id = ?`).get(id);
  database.prepare(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(importId, "user-1", `reimport-${reimportCounter}.csv`, `hash-${reimportCounter}`, "completed", "{}", touchedAt);
  database.prepare(`INSERT INTO giving_activity_import_changes (import_id, source_fingerprint, change_type, previous_json, created_at) VALUES (?,?,?,?,?)`)
    .run(importId, prior.source_fingerprint, "update", JSON.stringify({ paid_cents: prior.paid_cents, balance_cents: prior.balance_cents, category: prior.category }), touchedAt);
  database.prepare(`UPDATE giving_activities SET paid_cents = ?, balance_cents = ?, category = ?, updated_at = ? WHERE id = ?`)
    .run(newPaidCents, newBalanceCents, newCategory, touchedAt, id);
}

function insertAudit(database, row) {
  database.prepare(`INSERT INTO jl_payment_assignment_audits
    (id, user_id, import_id, payment_fingerprint, donor_id, pledge_activity_id, decision_type, payment_cents, applied_cents, new_gift_cents, payment_date, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.userId ?? "user-1", row.importId ?? "import-1", row.paymentFingerprint, row.donorId ?? "donor-a",
    row.pledgeActivityId ?? null, row.decisionType, row.paymentCents, row.appliedCents, row.newGiftCents,
    row.paymentDate ?? null, row.createdAt,
  );
}

function runCapability(database, userId, instantStartEpoch, instantEndEpoch, periodLabel) {
  const commitments = database.prepare(NEW_COMMITMENTS_SQL).get(userId, instantStartEpoch, instantEndEpoch);
  // Bind order: periodEnd (subquery threshold) first, then userId, then
  // periodStart, then periodEnd again -- matches the SQL's own `?` order.
  const newGivingRows = database.prepare(VERIFIED_NEW_GIVING_ROWS_SQL).all(instantEndEpoch, userId, instantStartEpoch, instantEndEpoch);
  const auditRows = database.prepare(PAYMENT_ASSIGNMENT_AUDITS_SQL).all(userId, instantStartEpoch, instantEndEpoch);
  const contacts = database.prepare(DONORS_CONTACTED_SQL).get(userId, instantStartEpoch, instantEndEpoch);
  return summarizeFundraisingProgress({
    periodLabel,
    newGivingRows,
    paymentAssignmentAuditRows: auditRows,
    newCommitments: { count: commitments.n, committedCents: commitments.total, cumulativePaidCents: commitments.cumulativePaidTotal },
    donorsContacted: contacts.n,
  });
}

async function run() {
  // =====================================================================
  // Part A -- pure summarizeFundraisingProgress unit tests (dedup logic)
  // =====================================================================

  // A1: direct donation, no pledge, no audit row at all.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [{ sourceFingerprint: "fp-1", paidCents: 100000 }],
      paymentAssignmentAuditRows: [],
      newCommitments: { count: 1, committedCents: 100000, cumulativePaidCents: 100000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedMoneyReceivedCents, 100000);
    assert.equal(result.newGiftsReceivedCents, 100000);
    assert.equal(result.paymentsOnExistingPledgesCents, 0);
    assert.equal(result.newCommitmentsCents, 100000);
    assert.equal(result.recordedCumulativePaidCents, 100000);
    assert.ok(result.limitations.length > 0, "the disclosed limitation must always be present");
  }

  // A2: a payment applied to an existing (older) pledge -- no overlap
  // with newGivingRows at all, since that pledge was NOT created this
  // period (so the caller would never include it in newGivingRows).
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [],
      paymentAssignmentAuditRows: [{ decisionType: "apply_to_pledge", appliedCents: 70000, newGiftCents: 0, paymentFingerprint: "fp-payment-1" }],
      newCommitments: { count: 0, committedCents: 0, cumulativePaidCents: 0 },
      donorsContacted: 1,
    });
    assert.equal(result.verifiedMoneyReceivedCents, 70000);
    assert.equal(result.paymentsOnExistingPledgesCents, 70000);
    assert.equal(result.newGiftsReceivedCents, 0);
    assert.equal(result.newCommitmentsCents, 0, "a payment on an older pledge must never inflate new commitments");
  }

  // A3: THE double-count hazard this module exists to prevent -- a
  // plain "new_gift" decision creates a giving_activities row under the
  // SAME fingerprint as its own audit row.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [{ sourceFingerprint: "fp-new-gift", paidCents: 25000 }],
      paymentAssignmentAuditRows: [{ decisionType: "new_gift", appliedCents: 0, newGiftCents: 25000, paymentFingerprint: "fp-new-gift" }],
      newCommitments: { count: 1, committedCents: 25000, cumulativePaidCents: 25000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedMoneyReceivedCents, 25000, "the same $250 must be counted exactly once, not twice");
    assert.equal(result.verifiedMoneyReceivedTransactionCount, 1);
  }

  // A4: the OTHER double-count hazard -- an overpayment remainder's
  // giving_activities row is inserted under a DERIVED fingerprint
  // ("<fp>:remainder"), not the same fingerprint as the main
  // apply_to_pledge audit row.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [{ sourceFingerprint: "fp-overpay:remainder", paidCents: 20000 }],
      paymentAssignmentAuditRows: [{ decisionType: "apply_to_pledge", appliedCents: 30000, newGiftCents: 20000, paymentFingerprint: "fp-overpay" }],
      newCommitments: { count: 1, committedCents: 20000, cumulativePaidCents: 20000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedMoneyReceivedCents, 50000, "30000 applied + 20000 remainder, each counted exactly once (50000, not 70000)");
    assert.equal(result.paymentsOnExistingPledgesCents, 30000);
  }

  // A5: multiple installments against the same pledge, different
  // fingerprints -- both must count, independently, with no cross-talk.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [],
      paymentAssignmentAuditRows: [
        { decisionType: "apply_to_pledge", appliedCents: 70000, newGiftCents: 0, paymentFingerprint: "fp-installment-1" },
        { decisionType: "apply_to_pledge", appliedCents: 20000, newGiftCents: 0, paymentFingerprint: "fp-installment-2" },
      ],
      newCommitments: { count: 0, committedCents: 0, cumulativePaidCents: 0 },
      donorsContacted: 0,
    });
    assert.equal(result.paymentsOnExistingPledgesCents, 90000);
    assert.equal(result.verifiedMoneyReceivedTransactionCount, 2);
  }

  // A6: a brand-new, already-partially-paid pledge (JL shows it as
  // partially paid the very first time it is imported) -- its initial
  // paid_cents must count as received, even though its category is not
  // completed_gift. recordedCumulativePaidCents may legitimately exceed
  // the verified figure (e.g. a different, untouched-since-creation row
  // elsewhere in the same period contributed to one but not the other in
  // a more complex real dataset) -- here they simply agree, since there
  // is only one row and it has not been touched since creation.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [{ sourceFingerprint: "fp-partial-new", paidCents: 30000 }],
      paymentAssignmentAuditRows: [],
      newCommitments: { count: 1, committedCents: 80000, cumulativePaidCents: 30000 },
      donorsContacted: 0,
    });
    assert.equal(result.newGiftsReceivedCents, 30000);
    assert.equal(result.newCommitmentsCents, 80000, "the full committed amount counts as a new commitment, regardless of how much is paid");
    assert.equal(result.recordedCumulativePaidCents, 30000);
  }

  // A7: empty input -- everything zero, limitation still present (never
  // conditionally omitted).
  {
    const result = summarizeFundraisingProgress({ periodLabel: "October 2026", newGivingRows: [], paymentAssignmentAuditRows: [], newCommitments: { count: 0, committedCents: 0, cumulativePaidCents: 0 }, donorsContacted: 0 });
    assert.equal(result.verifiedMoneyReceivedCents, 0);
    assert.equal(result.newCommitmentsCents, 0);
    assert.equal(result.recordedCumulativePaidCents, 0);
    assert.ok(result.limitations.length > 0);
  }

  // A8: the recordedCumulativePaidCents figure can legitimately EXCEED
  // the verified figure -- this is the whole point of keeping them
  // separate. The pure function itself has no notion of "touched since
  // creation" at all (that reconstruction lives entirely in
  // VERIFIED_NEW_GIVING_ROWS_SQL -- see Part C below for the real,
  // SQL-level proof) -- this test only confirms the pure arithmetic
  // correctly reports two independently-supplied figures as independent,
  // never silently reconciling one against the other.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [{ sourceFingerprint: "fp-reconstructed", paidCents: 50000 }], // the caller's own reconstructed, as-of-period-end value
      paymentAssignmentAuditRows: [],
      newCommitments: { count: 1, committedCents: 100000, cumulativePaidCents: 80000 }, // the live, current balance -- has since moved further
      donorsContacted: 0,
    });
    assert.equal(result.verifiedMoneyReceivedCents, 50000, "the verified figure reflects exactly what the caller reconstructed for this period, never the live balance");
    assert.equal(result.recordedCumulativePaidCents, 80000, "the live current balance is still visible as its own, separately-labeled figure, and may legitimately differ from verified");
  }

  console.log("Part A (pure summarizeFundraisingProgress) checks passed.");

  // =====================================================================
  // appendFinancialLimitations -- the deterministic-layer enforcement of
  // the financial disclosure, independent of whether the model's own
  // answer mentioned it.
  // =====================================================================
  {
    assert.equal(appendFinancialLimitations("Answer text.", []), "Answer text.", "no limitations -- answer passes through unchanged");
    const withLimitation = appendFinancialLimitations("Answer text.", ["Disclosure one."]);
    assert.match(withLimitation, /Answer text\./);
    assert.match(withLimitation, /Disclosure one\./, "the limitation must be present even though the model's own text never mentioned it");
    const withTwo = appendFinancialLimitations("Answer.", ["First.", "Second."]);
    assert.match(withTwo, /First\./);
    assert.match(withTwo, /Second\./);
    // Enforced even when the model's own answer ALREADY mentions the
    // substance -- redundancy is accepted on purpose (this file's own
    // header comment / lib/assistant/protocol.ts's own doc comment).
    const alreadyMentioned = appendFinancialLimitations("I did mention the limitation already.", ["The limitation, restated."]);
    assert.match(alreadyMentioned, /restated/);
    // Never allowed to grow unbounded.
    const longAnswer = "x".repeat(MAX_ANSWER_LENGTH - 10);
    const truncated = appendFinancialLimitations(longAnswer, ["A fairly long disclosure sentence that will not fully fit."]);
    assert.ok(truncated.length <= MAX_ANSWER_LENGTH);
  }
  console.log("appendFinancialLimitations checks passed.");

  // =====================================================================
  // Part B -- the real exported SQL against a real synthetic SQLite
  // database, covering every scenario the first review asked for. "This
  // month" = October 2026, America/New_York.
  // =====================================================================

  const NOW = Math.floor(Date.UTC(2026, 9, 20, 15, 0, 0) / 1000); // Oct 20 2026, midday UTC
  const { instantStartEpoch, instantEndEpoch, periodLabel } = localMonthBoundaries(NOW, ET);
  assert.equal(periodLabel, "October 2026");

  const OCT = (day, hour = 15) => Math.floor(Date.UTC(2026, 9, day, hour, 0, 0) / 1000);
  const SEPT = (day, hour = 15) => Math.floor(Date.UTC(2026, 8, day, hour, 0, 0) / 1000);

  const database = freshDatabase();
  seed(database, NOW);

  // Scenario 1: a direct donation, no pledge involved.
  insertGivingActivity(database, { id: "ga-direct", sourceFingerprint: "fp-direct", category: "completed_gift", committedCents: 100000, paidCents: 100000, createdAt: OCT(15) });

  // Scenario 2: a new, entirely unpaid pledge, with a due date far in
  // the FUTURE -- proves activity_date is never consulted and a future
  // due date is never mistaken for money already received.
  insertGivingActivity(database, { id: "ga-unpaid-pledge", sourceFingerprint: "fp-unpaid", category: "open_pledge", committedCents: 50000, paidCents: 0, createdAt: OCT(5), activityDate: Math.floor(Date.UTC(2028, 0, 1) / 1000) });

  // Scenario 3: a new pledge that is already partially paid the moment
  // it is first recorded.
  insertGivingActivity(database, { id: "ga-new-partial", sourceFingerprint: "fp-new-partial", category: "partially_paid_pledge", committedCents: 80000, paidCents: 30000, createdAt: OCT(10) });

  // Scenarios 4+5: a pledge CREATED LAST MONTH (September) receives TWO
  // separate installment payments this month, each via the payment-
  // review screen with its own fingerprint and recorded payment_date.
  insertGivingActivity(database, { id: "ga-prior-pledge", sourceFingerprint: "fp-prior-pledge", category: "partially_paid_pledge", committedCents: 200000, paidCents: 90000, createdAt: SEPT(1) });
  insertAudit(database, { id: "audit-installment-1", paymentFingerprint: "fp-installment-1", pledgeActivityId: "ga-prior-pledge", decisionType: "apply_to_pledge", paymentCents: 70000, appliedCents: 70000, newGiftCents: 0, paymentDate: OCT(12), createdAt: OCT(12) });
  insertAudit(database, { id: "audit-installment-2", paymentFingerprint: "fp-installment-2", pledgeActivityId: "ga-prior-pledge", decisionType: "apply_to_pledge", paymentCents: 20000, appliedCents: 20000, newGiftCents: 0, paymentDate: OCT(20), createdAt: OCT(20) });

  // Scenario 6: a payment whose TRUE transaction date is Sept 28, but
  // was not imported/reconciled until Oct 3 -- payment_date must govern,
  // not the import's own created_at.
  insertGivingActivity(database, { id: "ga-late-import-pledge", sourceFingerprint: "fp-late-import-pledge", category: "open_pledge", committedCents: 40000, paidCents: 0, createdAt: SEPT(5) });
  insertAudit(database, { id: "audit-late-import", paymentFingerprint: "fp-late-import-payment", pledgeActivityId: "ga-late-import-pledge", decisionType: "apply_to_pledge", paymentCents: 40000, appliedCents: 40000, newGiftCents: 0, paymentDate: SEPT(28), createdAt: OCT(3) });

  // Scenario 7: a corrected pledge balance -- must have ZERO effect on
  // either figure (this capability never reads pledge_balance_corrections,
  // and the underlying pledge was created in September anyway).
  insertGivingActivity(database, { id: "ga-corrected", sourceFingerprint: "fp-corrected", category: "partially_paid_pledge", committedCents: 60000, paidCents: 20000, createdAt: SEPT(10) });
  database.prepare(`INSERT INTO pledge_balance_corrections (id,user_id,donor_id,pledge_activity_id,imported_balance_cents_at_correction,corrected_balance_cents,reason,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run("correction-1", "user-1", "donor-a", "ga-corrected", 40000, 35000, "Reconciled against bank statement", OCT(8));

  // Scenario 8: a cancelled/reversed transaction -- workspace_status is
  // not 'active', so it must be fully excluded from both totals.
  insertGivingActivity(database, { id: "ga-reversed", sourceFingerprint: "fp-reversed", category: "completed_gift", committedCents: 90000, paidCents: 90000, createdAt: OCT(18), workspaceStatus: "invalid" });

  // Scenario 9: a brand-new pledge created this month with a payment
  // plan reaching two years into the future -- a future-dated balance
  // must count as a new commitment, never as money already received.
  insertGivingActivity(database, { id: "ga-future-plan", sourceFingerprint: "fp-future-plan", category: "open_pledge", committedCents: 15000, paidCents: 0, createdAt: OCT(22), activityDate: Math.floor(Date.UTC(2028, 0, 1) / 1000) });

  // Scenario 10: boundary rows -- exactly at the inclusive start, exactly
  // at the exclusive end, and one second before the exclusive end.
  insertGivingActivity(database, { id: "ga-at-start", sourceFingerprint: "fp-at-start", category: "completed_gift", committedCents: 5000, paidCents: 5000, createdAt: instantStartEpoch });
  insertGivingActivity(database, { id: "ga-at-end", sourceFingerprint: "fp-at-end", category: "completed_gift", committedCents: 6000, paidCents: 6000, createdAt: instantEndEpoch });
  insertGivingActivity(database, { id: "ga-just-before-end", sourceFingerprint: "fp-just-before-end", category: "completed_gift", committedCents: 7000, paidCents: 7000, createdAt: instantEndEpoch - 1 });

  // Donor contact this month.
  database.exec(`INSERT INTO interactions (id,donor_id,user_id,type,occurred_at,summary,source,created_at,updated_at) VALUES ('int-1','donor-a','user-1','call',${OCT(14)},'Checked in','manual',${OCT(14)},${OCT(14)})`);

  const result = runCapability(database, "user-1", instantStartEpoch, instantEndEpoch, periodLabel);

  // --- Assertions against the real, computed result ---

  // New commitments: direct(100000) + unpaid-pledge(50000) + new-partial(80000)
  //   + future-plan(15000) + at-start(5000) + just-before-end(7000) = 257000.
  // Explicitly NOT included: the September-created pledges (prior-pledge,
  // late-import-pledge, corrected), the reversed row, and at-end (belongs
  // to November).
  assert.equal(result.newCommitmentsCents, 257000, "new commitments must be gated on created_at within October only, regardless of category, due date, or later payments");
  assert.equal(result.newCommitmentsCount, 6);

  // Verified money received: direct(100000) + new-partial(30000) +
  //   at-start(5000) + just-before-end(7000) [all from newGivingRows,
  //   none audited, none touched since creation] + installment-1(70000)
  //   + installment-2(20000) [from audits] = 232000.
  // Explicitly NOT included: unpaid-pledge (paid=0), the late-import
  // payment (its true payment_date is September), the reversed row, and
  // at-end (November).
  assert.equal(result.verifiedMoneyReceivedCents, 232000, "verified money received must reconcile real dated payments only, never a pledge's due date or an out-of-window payment_date");
  assert.equal(result.paymentsOnExistingPledgesCents, 90000, "both October installments against the September pledge must be counted, summed");
  assert.equal(result.newGiftsReceivedCents, 142000, "100000 (direct) + 30000 (new partial) + 5000 (at-start) + 7000 (just-before-end)");
  // Every row created this period is still untouched since creation, so
  // the cumulative figure agrees with the new-gifts component exactly --
  // Part C below is where they diverge.
  assert.equal(result.recordedCumulativePaidCents, 142000);

  assert.equal(result.donorsContacted, 1);
  assert.ok(result.limitations.length > 0);

  // Explicitly re-run for SEPTEMBER's own window to prove the late-
  // imported payment (scenario 6) IS correctly attributed there instead
  // -- it was never simply dropped, only placed in the correct month.
  const septemberBoundaries = localMonthBoundaries(SEPT(15), ET);
  const septemberResult = runCapability(database, "user-1", septemberBoundaries.instantStartEpoch, septemberBoundaries.instantEndEpoch, septemberBoundaries.periodLabel);
  assert.equal(septemberResult.paymentsOnExistingPledgesCents, 40000, "the Sept 28 payment_date must place this payment in September, not October, even though it was imported on Oct 3");

  console.log("Part B (real SQLite, every reconciliation scenario) checks passed.");

  // =====================================================================
  // Part C -- the EXACT Stage A/B/C lifecycle the third independent
  // review asked to be traced ("Resolve Historical Payment Totals
  // Before Production"), using a FRESH database so Part B's own rows
  // never interfere. This is the review that found the SECOND round's
  // own fix (require updated_at = created_at) could retroactively
  // DEFLATE a previously-reported total to $0 the instant any later
  // reimport touched the row -- just as wrong, in the opposite
  // direction, as the FIRST round's fix inflating it. The THIRD fix
  // (reconstructing paid_cents "as of period end" from
  // giving_activity_import_changes -- see fundraising-progress.ts's own
  // header comment) is what this Part actually proves.
  // =====================================================================

  const lifecycleDb = freshDatabase();
  seed(lifecycleDb, NOW);

  const octBoundaries = localMonthBoundaries(OCT(20), ET);
  const novBoundaries = localMonthBoundaries(Math.floor(Date.UTC(2026, 10, 15, 15, 0, 0) / 1000), ET);
  assert.equal(novBoundaries.periodLabel, "November 2026");
  const NOV = (day, hour = 15) => Math.floor(Date.UTC(2026, 10, day, hour, 0, 0) / 1000);

  // Stage A: October 5 -- a pledge is imported with $200 of its $1,000
  // already paid. created_at = updated_at = Oct 5 (a brand-new row, no
  // change-log history yet).
  insertGivingActivity(lifecycleDb, { id: "ga-lifecycle", sourceFingerprint: "fp-lifecycle", category: "partially_paid_pledge", committedCents: 100000, paidCents: 20000, createdAt: OCT(5) });

  {
    const octResult = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(octResult.newCommitmentsCents, 100000, "the pledge's full committed amount is a new October commitment");
    assert.equal(octResult.verifiedMoneyReceivedCents, 20000, "the $200 recorded at creation is verified -- no later change exists yet, so current paid_cents already IS the as-of-period-end value");
    assert.equal(octResult.recordedCumulativePaidCents, 20000, "cumulative agrees with verified at this stage -- nothing has diverged yet");
  }

  // Stage B: October 20 -- a ROUTINE reimport (no payment-review
  // decision -- exactly lib/import/jl-refresh.ts's own "ordinary
  // reimport" path) bumps the SAME row's cumulative paid to $500, and
  // (atomically, in the same batch as the real import route) writes a
  // giving_activity_import_changes row recording the PRIOR $200.
  reimportBumpsPaid(lifecycleDb, "ga-lifecycle", 50000, 50000, "partially_paid_pledge", OCT(20));

  {
    const octResultAfterBump = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    // October has NOT closed yet (this update happened WITHIN October) --
    // there is no later change-log entry at or after November 1, so the
    // reconstruction correctly falls through to the row's current $500.
    // This is NOT the "$0" the second round's fix would have produced,
    // and it is NOT wrong: the extra $300 genuinely did arrive within
    // October, by the only evidence this system has.
    assert.equal(octResultAfterBump.verifiedMoneyReceivedCents, 50000, "while October is still open, its own best-available verified total is the row's current paid_cents -- $500, not $200 and not $0");
    assert.equal(octResultAfterBump.newCommitmentsCents, 100000, "the commitment itself is untouched -- committed_cents and created_at never change");
    assert.equal(octResultAfterBump.recordedCumulativePaidCents, 50000, "cumulative still agrees with verified -- nothing has diverged, because no update has happened in a LATER period yet");
  }

  // Stage C: November 10 -- ANOTHER routine reimport bumps cumulative
  // paid to $800 (still no audit row), atomically logging the PRIOR
  // $500 to giving_activity_import_changes under this reimport's own
  // created_at (November 10 -- critically, AFTER October has ended).
  reimportBumpsPaid(lifecycleDb, "ga-lifecycle", 80000, 20000, "partially_paid_pledge", NOV(10));

  {
    // October, re-queried AFTER the November reimport, in December --
    // THE REQUIRED OUTCOME: October's own previously-verified total must
    // NOT change merely because cumulative balances were updated later.
    // Because the Nov 10 change happened AFTER October's own end, its
    // own previous_json.paid_cents ($500) is exactly "what was true for
    // the rest of October" -- reconstructed, not recomputed from scratch,
    // and BYTE-IDENTICAL to what Stage B already reported.
    const octResultAfterSecondBump = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(octResultAfterSecondBump.verifiedMoneyReceivedCents, 50000, "October's verified figure must still be exactly $500 -- a November import can never retroactively change a previously-reported October total, in EITHER direction");
    assert.equal(octResultAfterSecondBump.newCommitmentsCents, 100000);
    // Cumulative, by contrast, is explicitly a live snapshot and is
    // EXPECTED to keep moving -- it now correctly diverges from the
    // frozen verified figure, which is exactly why the two are kept
    // separate and neither is ever called the other's name.
    assert.equal(octResultAfterSecondBump.recordedCumulativePaidCents, 80000, "cumulative keeps moving to the live $800 while verified stays frozen at $500");

    // November itself: the pledge was NOT created in November (no new
    // commitment -- created_at is still October), and the $300 added
    // this month has no payment-review audit trail (no dated event) --
    // so November's own verified total for THIS pledge must be $0, not
    // $300. This is the concrete, disclosed under-count: the $300 is
    // never claimed as received anywhere, by either month.
    const novResult = runCapability(lifecycleDb, "user-1", novBoundaries.instantStartEpoch, novBoundaries.instantEndEpoch, novBoundaries.periodLabel);
    assert.equal(novResult.newCommitmentsCents, 0, "the pledge is not a November commitment -- it was created in October");
    assert.equal(novResult.verifiedMoneyReceivedCents, 0, "the $300 added in November has no recorded payment date and must never be guessed into November's total");
    assert.ok(novResult.limitations.length > 0, "the gap must stay disclosed even when the verified total is zero");
  }

  console.log("Part C (Stage A/B/C cumulative-payment lifecycle, reconstructed as-of-period-end stability) checks passed.");

  // =====================================================================
  // Part D -- the remaining named scenarios from the reviews not already
  // covered above: repeated imports with UNCHANGED amounts, a pledge
  // becoming fully paid with no dated event at all, and a month/year
  // boundary case for the reconstruction query itself.
  // =====================================================================

  // D1: repeated imports with unchanged paid amounts never touch the row
  // at all (lib/import/jl-donation-match.ts's own proposedUpdates filter
  // only includes genuinely CHANGED rows -- confirmed directly against
  // that source file, not assumed) -- so no change-log entry is ever
  // written, and the row's current paid_cents remains correct and
  // verified indefinitely across any number of no-op reimports.
  insertGivingActivity(lifecycleDb, { id: "ga-unchanged", sourceFingerprint: "fp-unchanged", category: "completed_gift", committedCents: 40000, paidCents: 40000, createdAt: OCT(8) });
  // Deliberately NOT calling reimportBumpsPaid here -- a reimport whose
  // file shows the exact same Paid/Balance Due values this row already
  // has produces no write at all in the real import route.
  {
    const octResult = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.ok(octResult.verifiedMoneyReceivedCents >= 40000, "an unchanged row must remain verified no matter how many times its source file is re-imported");
  }

  // D2: a pledge becomes fully paid via the ordinary reimport path (no
  // payment-review decision, so no dated event anywhere) -- even once
  // completed_gift, and even though this pledge's OWN creation month
  // (September) has long since closed, the payoff itself must never be
  // retroactively counted as "received" in any month -- not September
  // (nothing changed within September), and not October (no commitment,
  // no audit trail).
  insertGivingActivity(lifecycleDb, { id: "ga-paid-off", sourceFingerprint: "fp-paid-off", category: "open_pledge", committedCents: 60000, paidCents: 0, createdAt: SEPT(5) });
  reimportBumpsPaid(lifecycleDb, "ga-paid-off", 60000, 0, "completed_gift", OCT(25));
  {
    const septBoundariesD2 = localMonthBoundaries(SEPT(20), ET);
    const septResultAfterPayoff = runCapability(lifecycleDb, "user-1", septBoundariesD2.instantStartEpoch, septBoundariesD2.instantEndEpoch, septBoundariesD2.periodLabel);
    // September closed before the October 25 payoff happened, so the
    // reconstruction correctly freezes September's own value at $0 paid
    // (the previous_json recorded by the October 25 change) -- not the
    // now-current $600.
    assert.equal(septResultAfterPayoff.newCommitmentsCents, 60000, "the pledge itself is still a September commitment");
    assert.equal(septResultAfterPayoff.verifiedMoneyReceivedCents, 0, "September's own verified total must stay $0 for this pledge -- the full payoff happened in October, after September had already closed");

    const octResultD2 = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    // October gets no credit either: the pledge is not an October
    // commitment (created in September), and the payoff has no
    // payment-review audit trail. October's own total is unaffected by
    // ga-paid-off -- still exactly Stage C's $500 (ga-lifecycle, frozen)
    // plus D1's $400 (ga-unchanged), both already established earlier in
    // this Part, with nothing from ga-paid-off added in.
    assert.equal(octResultD2.verifiedMoneyReceivedCents, 90000, "unaffected by ga-paid-off: 50000 (ga-lifecycle, frozen at Stage C's value) + 40000 (ga-unchanged)");
  }

  // D3: a month/year boundary for the reconstruction query itself --
  // December's own pledge, created Dec 28, reimport-bumped on January 3
  // of the FOLLOWING year. December's verified total must freeze at its
  // pre-bump value despite the rollover into a new calendar year.
  const decBoundaries = localMonthBoundaries(Math.floor(Date.UTC(2026, 11, 15, 15, 0, 0) / 1000), ET);
  assert.equal(decBoundaries.periodLabel, "December 2026");
  const DEC = (day, hour = 15) => Math.floor(Date.UTC(2026, 11, day, hour, 0, 0) / 1000);
  const JAN2027 = (day, hour = 15) => Math.floor(Date.UTC(2027, 0, day, hour, 0, 0) / 1000);
  insertGivingActivity(lifecycleDb, { id: "ga-year-boundary", sourceFingerprint: "fp-year-boundary", category: "partially_paid_pledge", committedCents: 90000, paidCents: 10000, createdAt: DEC(28) });
  reimportBumpsPaid(lifecycleDb, "ga-year-boundary", 90000, 0, "completed_gift", JAN2027(3));
  {
    const decResult = runCapability(lifecycleDb, "user-1", decBoundaries.instantStartEpoch, decBoundaries.instantEndEpoch, decBoundaries.periodLabel);
    assert.equal(decResult.verifiedMoneyReceivedCents, 10000, "December's own verified total must freeze at the pre-January-bump $100, correctly reconstructed across the year rollover");
  }

  console.log("Part D (repeated unchanged imports, full payoff with no dated event, year-boundary reconstruction) checks passed.");
  console.log("fundraising-progress.test.mjs: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
