import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { summarizeFundraisingProgress, NEW_COMMITMENTS_SQL, NEW_GIVING_ROWS_SQL, PAYMENT_ASSIGNMENT_AUDITS_SQL, DONORS_CONTACTED_SQL } from "../lib/assistant/fundraising-progress.ts";
import { localMonthBoundaries } from "../lib/workspace/local-time.ts";

// Final Financial Accuracy Fix for Ask Fundraising OS (independent code
// review, 2026-10-16). Two layers of regression coverage:
//   - Part A exercises summarizeFundraisingProgress -- the pure dedup/
//     reconciliation arithmetic -- directly with synthetic row objects.
//   - Part B runs the EXACT, literal SQL constants this feature's own
//     capabilities.ts uses (imported from lib/assistant/fundraising-
//     progress.ts, never re-typed here) against a real in-memory SQLite
//     database built from this repo's own migrations, seeded with every
//     scenario the review asked for, and checks the real computed
//     result -- not merely that the source code contains certain
//     strings. Same harness convention as tests/asks.test.mjs/
//     tests/data-health.test.mjs (node:sqlite's DatabaseSync + the real
//     drizzle/*.sql migration files).

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
  const newGivingRows = database.prepare(NEW_GIVING_ROWS_SQL).all(userId, instantStartEpoch, instantEndEpoch);
  const auditRows = database.prepare(PAYMENT_ASSIGNMENT_AUDITS_SQL).all(userId, instantStartEpoch, instantEndEpoch);
  const contacts = database.prepare(DONORS_CONTACTED_SQL).get(userId, instantStartEpoch, instantEndEpoch);
  return summarizeFundraisingProgress({
    periodLabel,
    newGivingRows,
    paymentAssignmentAuditRows: auditRows,
    newCommitments: { count: commitments.n, committedCents: commitments.total },
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
      newCommitments: { count: 1, committedCents: 100000 },
      donorsContacted: 0,
    });
    assert.equal(result.moneyReceivedCents, 100000);
    assert.equal(result.newGiftsReceivedCents, 100000);
    assert.equal(result.paymentsOnExistingPledgesCents, 0);
    assert.equal(result.newCommitmentsCents, 100000);
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
      newCommitments: { count: 0, committedCents: 0 },
      donorsContacted: 1,
    });
    assert.equal(result.moneyReceivedCents, 70000);
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
      newCommitments: { count: 1, committedCents: 25000 },
      donorsContacted: 0,
    });
    assert.equal(result.moneyReceivedCents, 25000, "the same $250 must be counted exactly once, not twice");
    assert.equal(result.moneyReceivedTransactionCount, 1);
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
      newCommitments: { count: 1, committedCents: 20000 },
      donorsContacted: 0,
    });
    assert.equal(result.moneyReceivedCents, 50000, "30000 applied + 20000 remainder, each counted exactly once (50000, not 70000)");
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
      newCommitments: { count: 0, committedCents: 0 },
      donorsContacted: 0,
    });
    assert.equal(result.paymentsOnExistingPledgesCents, 90000);
    assert.equal(result.moneyReceivedTransactionCount, 2);
  }

  // A6: a brand-new, already-partially-paid pledge (JL shows it as
  // partially paid the very first time it is imported) -- its initial
  // paid_cents must count as received, even though its category is not
  // completed_gift.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      newGivingRows: [{ sourceFingerprint: "fp-partial-new", paidCents: 30000 }],
      paymentAssignmentAuditRows: [],
      newCommitments: { count: 1, committedCents: 80000 },
      donorsContacted: 0,
    });
    assert.equal(result.newGiftsReceivedCents, 30000);
    assert.equal(result.newCommitmentsCents, 80000, "the full committed amount counts as a new commitment, regardless of how much is paid");
  }

  // A7: empty input -- everything zero, limitation still present (never
  // conditionally omitted).
  {
    const result = summarizeFundraisingProgress({ periodLabel: "October 2026", newGivingRows: [], paymentAssignmentAuditRows: [], newCommitments: { count: 0, committedCents: 0 }, donorsContacted: 0 });
    assert.equal(result.moneyReceivedCents, 0);
    assert.equal(result.newCommitmentsCents, 0);
    assert.ok(result.limitations.length > 0);
  }

  console.log("Part A (pure summarizeFundraisingProgress) checks passed.");

  // =====================================================================
  // Part B -- the real exported SQL against a real synthetic SQLite
  // database, covering every scenario the review asked for. "This
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

  // Money received: direct(100000) + new-partial(30000) + at-start(5000)
  //   + just-before-end(7000) [all from newGivingRows, none audited]
  //   + installment-1(70000) + installment-2(20000) [from audits] = 232000.
  // Explicitly NOT included: unpaid-pledge (paid=0), the late-import
  // payment (its true payment_date is September), the reversed row, and
  // at-end (November).
  assert.equal(result.moneyReceivedCents, 232000, "money received must reconcile real dated payments only, never a pledge's due date or an out-of-window payment_date");
  assert.equal(result.paymentsOnExistingPledgesCents, 90000, "both October installments against the September pledge must be counted, summed");
  assert.equal(result.newGiftsReceivedCents, 142000, "100000 (direct) + 30000 (new partial) + 5000 (at-start) + 7000 (just-before-end)");

  assert.equal(result.donorsContacted, 1);
  assert.ok(result.limitations.length > 0);

  // Explicitly re-run for SEPTEMBER's own window to prove the late-
  // imported payment (scenario 6) IS correctly attributed there instead
  // -- it was never simply dropped, only placed in the correct month.
  const septemberBoundaries = localMonthBoundaries(SEPT(15), ET);
  const septemberResult = runCapability(database, "user-1", septemberBoundaries.instantStartEpoch, septemberBoundaries.instantEndEpoch, septemberBoundaries.periodLabel);
  assert.equal(septemberResult.paymentsOnExistingPledgesCents, 40000, "the Sept 28 payment_date must place this payment in September, not October, even though it was imported on Oct 3");

  console.log("Part B (real SQLite, every reconciliation scenario) checks passed.");
  console.log("fundraising-progress.test.mjs: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
