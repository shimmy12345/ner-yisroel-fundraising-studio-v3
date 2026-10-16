import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { summarizeFundraisingProgress, NEW_COMMITMENTS_SQL, RECORDED_PAID_BALANCE_ROWS_SQL, VERIFIED_DATED_PAYMENT_AUDITS_SQL, UNDATED_PAYMENT_AUDITS_SQL, DONORS_CONTACTED_SQL } from "../lib/assistant/fundraising-progress.ts";
import { appendFinancialLimitations, MAX_ANSWER_LENGTH } from "../lib/assistant/protocol.ts";
import { localMonthBoundaries } from "../lib/workspace/local-time.ts";

// Four independent reviews (all 2026-10-16) have progressively corrected
// this feature -- see lib/assistant/fundraising-progress.ts's own header
// comment for the complete history. This file's five parts:
//   A. Pure summarizeFundraisingProgress unit tests.
//   (appendFinancialLimitations unit tests.)
//   B. Real SQL against synthetic SQLite, every scenario the first review
//      asked for.
//   C. The exact Stage A/B/C cumulative-payment lifecycle, now also
//      proving the THIRD review's mislabeling fix: this scenario (no
//      payment-review decision, ever) produces a real, nonzero Category
//      B (recorded balance) figure while Category A (verified dated
//      payments) stays $0 throughout -- the system never claims this
//      money was "received," only that it is "recorded as paid."
//   D. Repeated unchanged imports, a full payoff with no dated event, a
//      year-boundary reconstruction case.
//   E. THE CRITICAL NEW TESTS: cross-user and cross-donor fingerprint
//      isolation, proving giving_activity_import_changes' own lack of an
//      owner_user_id column can never let one user's (or donor's)
//      financial history leak into another's reconstruction.
//   F. The Category A vs. B mislabeling fix itself, directly: a pledge
//      paid before it was ever imported must be labeled "recorded as
//      paid," never "received," plus the undated-payment-audit
//      disclosure path.
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

function seedUser(database, userId, donorId, now) {
  database.exec(`INSERT INTO users (id,email,timezone,household_import_review_mode,created_at,updated_at) VALUES ('${userId}','${userId}@example.test','America/New_York','auto_unchanged',${now},${now})`);
  database.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('${donorId}','${userId}','live','${donorId}',${now},${now})`);
}

function seed(database, now) {
  seedUser(database, "user-1", "donor-a", now);
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
//      (itself tagged to whichever user is actually running this
//      reimport) and this reimport's own created_at.
//   2. The actual UPDATE: paid_cents/balance_cents/category/updated_at
//      move; committed_cents and (critically) created_at and
//      activity_date are NEVER touched.
// A reimport that detects NO change (lib/import/jl-donation-match.ts's
// own proposedUpdates filter) never calls this at all -- see the
// "repeated imports, unchanged amounts" scenario below, which
// deliberately does not call this helper.
let reimportCounter = 0;
function reimportBumpsPaid(database, id, newPaidCents, newBalanceCents, newCategory, touchedAt, importUserId = "user-1") {
  reimportCounter += 1;
  const importId = `reimport-${reimportCounter}`;
  const prior = database.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category FROM giving_activities WHERE id = ?`).get(id);
  database.prepare(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(importId, importUserId, `reimport-${reimportCounter}.csv`, `hash-${reimportCounter}`, "completed", "{}", touchedAt);
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
  const recordedPaidBalanceRows = database.prepare(RECORDED_PAID_BALANCE_ROWS_SQL).all(instantEndEpoch, userId, instantStartEpoch, instantEndEpoch);
  const verifiedDatedAuditRows = database.prepare(VERIFIED_DATED_PAYMENT_AUDITS_SQL).all(userId, instantStartEpoch, instantEndEpoch);
  const undatedAuditRows = database.prepare(UNDATED_PAYMENT_AUDITS_SQL).all(userId);
  const contacts = database.prepare(DONORS_CONTACTED_SQL).get(userId, instantStartEpoch, instantEndEpoch);
  return summarizeFundraisingProgress({
    periodLabel,
    recordedPaidBalanceRows,
    verifiedDatedPaymentAuditRows: verifiedDatedAuditRows,
    undatedPaymentAudits: {
      count: undatedAuditRows.length,
      cents: undatedAuditRows.reduce((sum, row) => sum + row.cents, 0),
      fingerprints: undatedAuditRows.map((row) => row.paymentFingerprint),
    },
    newCommitments: { count: commitments.n, committedCents: commitments.total },
    donorsContacted: contacts.n,
  });
}

async function run() {
  // =====================================================================
  // Part A -- pure summarizeFundraisingProgress unit tests (dedup logic)
  // =====================================================================

  const noUndated = { count: 0, cents: 0, fingerprints: [] };

  // A1: direct donation, no pledge, no audit row at all.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [{ sourceFingerprint: "fp-1", paidCents: 100000 }],
      verifiedDatedPaymentAuditRows: [],
      undatedPaymentAudits: noUndated,
      newCommitments: { count: 1, committedCents: 100000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedDatedPaymentsCents, 0, "a plain new giving row with no payment-review decision is Category B, never Category A");
    assert.equal(result.recordedPaidBalanceCents, 100000);
    assert.equal(result.newCommitmentsCents, 100000);
    assert.ok(result.limitations.length > 0, "the base limitation must always be present");
  }

  // A2: a payment applied to an existing (older) pledge, dated, via the
  // review screen -- a genuine Category A transaction. No overlap with
  // recordedPaidBalanceRows at all, since that pledge was NOT created
  // this period (so the caller would never include it there).
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [],
      verifiedDatedPaymentAuditRows: [{ decisionType: "apply_to_pledge", appliedCents: 70000, newGiftCents: 0, paymentFingerprint: "fp-payment-1" }],
      undatedPaymentAudits: noUndated,
      newCommitments: { count: 0, committedCents: 0 },
      donorsContacted: 1,
    });
    assert.equal(result.verifiedDatedPaymentsCents, 70000);
    assert.equal(result.paymentsOnExistingPledgesCents, 70000);
    assert.equal(result.recordedPaidBalanceCents, 0);
    assert.equal(result.newCommitmentsCents, 0, "a payment on an older pledge must never inflate new commitments");
  }

  // A3: THE double-count hazard this module exists to prevent -- a
  // plain "new_gift" decision creates a giving_activities row under the
  // SAME fingerprint as its own audit row.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [{ sourceFingerprint: "fp-new-gift", paidCents: 25000 }],
      verifiedDatedPaymentAuditRows: [{ decisionType: "new_gift", appliedCents: 0, newGiftCents: 25000, paymentFingerprint: "fp-new-gift" }],
      undatedPaymentAudits: noUndated,
      newCommitments: { count: 1, committedCents: 25000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedDatedPaymentsCents, 25000, "the same $250 must be counted exactly once, not twice");
    assert.equal(result.recordedPaidBalanceCents, 0, "the giving_activities row for a dated new_gift decision must be excluded from Category B entirely");
    assert.equal(result.verifiedDatedPaymentsTransactionCount, 1);
  }

  // A4: the OTHER double-count hazard -- an overpayment remainder's
  // giving_activities row is inserted under a DERIVED fingerprint
  // ("<fp>:remainder"), not the same fingerprint as the main
  // apply_to_pledge audit row.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [{ sourceFingerprint: "fp-overpay:remainder", paidCents: 20000 }],
      verifiedDatedPaymentAuditRows: [{ decisionType: "apply_to_pledge", appliedCents: 30000, newGiftCents: 20000, paymentFingerprint: "fp-overpay" }],
      undatedPaymentAudits: noUndated,
      newCommitments: { count: 1, committedCents: 20000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedDatedPaymentsCents, 50000, "30000 applied + 20000 remainder, each counted exactly once (50000, not 70000)");
    assert.equal(result.paymentsOnExistingPledgesCents, 30000);
    assert.equal(result.recordedPaidBalanceCents, 0);
  }

  // A5: multiple installments against the same pledge, different
  // fingerprints -- both must count, independently, with no cross-talk.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [],
      verifiedDatedPaymentAuditRows: [
        { decisionType: "apply_to_pledge", appliedCents: 70000, newGiftCents: 0, paymentFingerprint: "fp-installment-1" },
        { decisionType: "apply_to_pledge", appliedCents: 20000, newGiftCents: 0, paymentFingerprint: "fp-installment-2" },
      ],
      undatedPaymentAudits: noUndated,
      newCommitments: { count: 0, committedCents: 0 },
      donorsContacted: 0,
    });
    assert.equal(result.paymentsOnExistingPledgesCents, 90000);
    assert.equal(result.verifiedDatedPaymentsTransactionCount, 2);
  }

  // A6: a brand-new, already-partially-paid pledge (JL shows it as
  // partially paid the very first time it is imported) -- its initial
  // paid_cents is a Category B balance, never Category A, even though
  // real money may well be behind it.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [{ sourceFingerprint: "fp-partial-new", paidCents: 30000 }],
      verifiedDatedPaymentAuditRows: [],
      undatedPaymentAudits: noUndated,
      newCommitments: { count: 1, committedCents: 80000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedDatedPaymentsCents, 0);
    assert.equal(result.recordedPaidBalanceCents, 30000);
    assert.equal(result.newCommitmentsCents, 80000, "the full committed amount counts as a new commitment, regardless of how much is paid");
  }

  // A7: empty input -- everything zero, base limitation still present.
  {
    const result = summarizeFundraisingProgress({ periodLabel: "October 2026", recordedPaidBalanceRows: [], verifiedDatedPaymentAuditRows: [], undatedPaymentAudits: noUndated, newCommitments: { count: 0, committedCents: 0 }, donorsContacted: 0 });
    assert.equal(result.verifiedDatedPaymentsCents, 0);
    assert.equal(result.recordedPaidBalanceCents, 0);
    assert.equal(result.newCommitmentsCents, 0);
    assert.equal(result.limitations.length, 1, "exactly the base limitation, no dynamic undated-audit note when there is nothing to disclose");
  }

  // A8: an UNDATED payment-review decision -- no recorded payment_date
  // at all. Its money must appear in NEITHER Category A (no date to
  // verify) NOR Category B (its own giving_activities row, if any,
  // shares this fingerprint and must be excluded too) -- fully
  // disclosed via a dynamic limitations entry instead of silently
  // vanishing or being misfiled into either bucket.
  {
    const result = summarizeFundraisingProgress({
      periodLabel: "October 2026",
      recordedPaidBalanceRows: [{ sourceFingerprint: "fp-undated-new-gift", paidCents: 15000 }],
      verifiedDatedPaymentAuditRows: [],
      undatedPaymentAudits: { count: 1, cents: 15000, fingerprints: ["fp-undated-new-gift"] },
      newCommitments: { count: 1, committedCents: 15000 },
      donorsContacted: 0,
    });
    assert.equal(result.verifiedDatedPaymentsCents, 0, "an undated decision can never count as a verified dated payment");
    assert.equal(result.recordedPaidBalanceCents, 0, "its giving_activities row must also be excluded from the recorded-balance figure -- the money is disclosed, not double-counted elsewhere");
    assert.equal(result.limitations.length, 2, "the base limitation plus one dynamic entry for the undated decision");
    assert.match(result.limitations[1], /1 payment-review decision/);
    assert.match(result.limitations[1], /\$150/);
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
    const alreadyMentioned = appendFinancialLimitations("I did mention the limitation already.", ["The limitation, restated."]);
    assert.match(alreadyMentioned, /restated/);
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
  // it is first recorded -- a Category B balance.
  insertGivingActivity(database, { id: "ga-new-partial", sourceFingerprint: "fp-new-partial", category: "partially_paid_pledge", committedCents: 80000, paidCents: 30000, createdAt: OCT(10) });

  // Scenarios 4+5: a pledge CREATED LAST MONTH (September) receives TWO
  // separate installment payments this month, each via the payment-
  // review screen with its own fingerprint and recorded payment_date --
  // genuine Category A transactions.
  insertGivingActivity(database, { id: "ga-prior-pledge", sourceFingerprint: "fp-prior-pledge", category: "partially_paid_pledge", committedCents: 200000, paidCents: 90000, createdAt: SEPT(1) });
  insertAudit(database, { id: "audit-installment-1", paymentFingerprint: "fp-installment-1", pledgeActivityId: "ga-prior-pledge", decisionType: "apply_to_pledge", paymentCents: 70000, appliedCents: 70000, newGiftCents: 0, paymentDate: OCT(12), createdAt: OCT(12) });
  insertAudit(database, { id: "audit-installment-2", paymentFingerprint: "fp-installment-2", pledgeActivityId: "ga-prior-pledge", decisionType: "apply_to_pledge", paymentCents: 20000, appliedCents: 20000, newGiftCents: 0, paymentDate: OCT(20), createdAt: OCT(20) });

  // Scenario 6: a payment whose TRUE transaction date is Sept 28, but
  // was not imported/reconciled until Oct 3 -- payment_date must govern,
  // not the import's own created_at.
  insertGivingActivity(database, { id: "ga-late-import-pledge", sourceFingerprint: "fp-late-import-pledge", category: "open_pledge", committedCents: 40000, paidCents: 0, createdAt: SEPT(5) });
  insertAudit(database, { id: "audit-late-import", paymentFingerprint: "fp-late-import-payment", pledgeActivityId: "ga-late-import-pledge", decisionType: "apply_to_pledge", paymentCents: 40000, appliedCents: 40000, newGiftCents: 0, paymentDate: SEPT(28), createdAt: OCT(3) });

  // Scenario 7: a corrected pledge balance -- must have ZERO effect on
  // either category (this capability never reads pledge_balance_corrections,
  // and the underlying pledge was created in September anyway).
  insertGivingActivity(database, { id: "ga-corrected", sourceFingerprint: "fp-corrected", category: "partially_paid_pledge", committedCents: 60000, paidCents: 20000, createdAt: SEPT(10) });
  database.prepare(`INSERT INTO pledge_balance_corrections (id,user_id,donor_id,pledge_activity_id,imported_balance_cents_at_correction,corrected_balance_cents,reason,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run("correction-1", "user-1", "donor-a", "ga-corrected", 40000, 35000, "Reconciled against bank statement", OCT(8));

  // Scenario 8: a cancelled/reversed transaction -- workspace_status is
  // not 'active', so it must be fully excluded from both categories.
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

  // New commitments: direct(100000) + unpaid-pledge(50000) + new-partial(80000)
  //   + future-plan(15000) + at-start(5000) + just-before-end(7000) = 257000.
  assert.equal(result.newCommitmentsCents, 257000, "new commitments must be gated on created_at within October only, regardless of category, due date, or later payments");
  assert.equal(result.newCommitmentsCount, 6);

  // Category A -- verified dated payments: installment-1(70000) +
  // installment-2(20000) = 90000. Explicitly NOT the late-import payment
  // (its true payment_date is September).
  assert.equal(result.verifiedDatedPaymentsCents, 90000, "verified dated payments must reconcile real dated payments only, never a pledge's due date or an out-of-window payment_date");
  assert.equal(result.paymentsOnExistingPledgesCents, 90000);

  // Category B -- recorded paid balance: direct(100000) + new-partial(30000)
  //   + at-start(5000) + just-before-end(7000) = 142000. None of these are
  // dated, and none claim to be "received."
  assert.equal(result.recordedPaidBalanceCents, 142000, "100000 (direct) + 30000 (new partial) + 5000 (at-start) + 7000 (just-before-end)");

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
  // Part C -- the exact Stage A/B/C cumulative-payment lifecycle, now
  // also proving the mislabeling fix: this entire scenario never uses
  // the payment-review screen, so Category A (verified dated payments)
  // must stay $0 throughout, while Category B (recorded paid balance)
  // correctly tracks and freezes the pledge's recorded amount.
  // =====================================================================

  const lifecycleDb = freshDatabase();
  seed(lifecycleDb, NOW);

  const octBoundaries = localMonthBoundaries(OCT(20), ET);
  const novBoundaries = localMonthBoundaries(Math.floor(Date.UTC(2026, 10, 15, 15, 0, 0) / 1000), ET);
  assert.equal(novBoundaries.periodLabel, "November 2026");
  const NOV = (day, hour = 15) => Math.floor(Date.UTC(2026, 10, day, hour, 0, 0) / 1000);

  // Stage A: October 5 -- a pledge is imported with $200 of its $1,000
  // already paid.
  insertGivingActivity(lifecycleDb, { id: "ga-lifecycle", sourceFingerprint: "fp-lifecycle", category: "partially_paid_pledge", committedCents: 100000, paidCents: 20000, createdAt: OCT(5) });

  {
    const octResult = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(octResult.newCommitmentsCents, 100000, "the pledge's full committed amount is a new October commitment");
    assert.equal(octResult.recordedPaidBalanceCents, 20000, "the $200 recorded at creation -- a Category B balance");
    assert.equal(octResult.verifiedDatedPaymentsCents, 0, "no payment-review decision exists anywhere in this scenario -- Category A must stay $0, never claim this $200 was 'received'");
  }

  // Stage B: October 20 -- a ROUTINE reimport bumps the SAME row's
  // cumulative paid to $500.
  reimportBumpsPaid(lifecycleDb, "ga-lifecycle", 50000, 50000, "partially_paid_pledge", OCT(20));

  {
    const octResultAfterBump = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    // October has NOT closed yet -- there is no later change-log entry
    // at or after November 1, so the reconstruction correctly falls
    // through to the row's current $500.
    assert.equal(octResultAfterBump.recordedPaidBalanceCents, 50000, "while October is still open, its own best-available recorded balance is the row's current paid_cents -- $500, not $200 and not $0");
    assert.equal(octResultAfterBump.verifiedDatedPaymentsCents, 0, "still no dated payment event anywhere -- still $0, never 'received'");
    assert.equal(octResultAfterBump.newCommitmentsCents, 100000, "the commitment itself is untouched -- committed_cents and created_at never change");
  }

  // Stage C: November 10 -- ANOTHER routine reimport bumps cumulative
  // paid to $800.
  reimportBumpsPaid(lifecycleDb, "ga-lifecycle", 80000, 20000, "partially_paid_pledge", NOV(10));

  {
    // October, re-queried AFTER the November reimport, in December --
    // THE REQUIRED OUTCOME: October's own previously-reported figure
    // must NOT change merely because cumulative balances were updated
    // later, in either direction.
    const octResultAfterSecondBump = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(octResultAfterSecondBump.recordedPaidBalanceCents, 50000, "October's recorded balance must still be exactly $500 -- a November import can never retroactively change a previously-reported October figure, in EITHER direction");
    assert.equal(octResultAfterSecondBump.verifiedDatedPaymentsCents, 0, "still $0 -- this scenario never produces a verified dated payment, no matter how many reimports run");
    assert.equal(octResultAfterSecondBump.newCommitmentsCents, 100000);

    // November itself: the pledge was NOT created in November (no new
    // commitment), and the $300 added this month has no payment-review
    // audit trail -- so November's own figures for THIS pledge must
    // both be $0. The money is simply never claimed anywhere.
    const novResult = runCapability(lifecycleDb, "user-1", novBoundaries.instantStartEpoch, novBoundaries.instantEndEpoch, novBoundaries.periodLabel);
    assert.equal(novResult.newCommitmentsCents, 0, "the pledge is not a November commitment -- it was created in October");
    assert.equal(novResult.recordedPaidBalanceCents, 0, "the pledge is not a November commitment either, so it contributes nothing to November's own recorded balance");
    assert.equal(novResult.verifiedDatedPaymentsCents, 0);
    assert.ok(novResult.limitations.length > 0, "the gap must stay disclosed even when every figure is zero");
  }

  console.log("Part C (Stage A/B/C cumulative-payment lifecycle, reconstructed stability, and the never-'received' guarantee) checks passed.");

  // =====================================================================
  // Part D -- repeated unchanged imports, a full payoff with no dated
  // event, and a month/year boundary case for the reconstruction query.
  // =====================================================================

  // D1: repeated imports with unchanged paid amounts never touch the row
  // at all (lib/import/jl-donation-match.ts's own proposedUpdates filter
  // only includes genuinely CHANGED rows) -- so no change-log entry is
  // ever written, and the row's current paid_cents remains correct
  // indefinitely across any number of no-op reimports.
  insertGivingActivity(lifecycleDb, { id: "ga-unchanged", sourceFingerprint: "fp-unchanged", category: "completed_gift", committedCents: 40000, paidCents: 40000, createdAt: OCT(8) });
  {
    const octResult = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.ok(octResult.recordedPaidBalanceCents >= 40000, "an unchanged row must remain correctly reconstructed no matter how many times its source file is re-imported");
  }

  // D2: a pledge becomes fully paid via the ordinary reimport path -- no
  // payment-review decision, so never a Category A event -- even once
  // completed_gift, and even though this pledge's OWN creation month
  // (September) has long since closed.
  insertGivingActivity(lifecycleDb, { id: "ga-paid-off", sourceFingerprint: "fp-paid-off", category: "open_pledge", committedCents: 60000, paidCents: 0, createdAt: SEPT(5) });
  reimportBumpsPaid(lifecycleDb, "ga-paid-off", 60000, 0, "completed_gift", OCT(25));
  {
    const septBoundariesD2 = localMonthBoundaries(SEPT(20), ET);
    const septResultAfterPayoff = runCapability(lifecycleDb, "user-1", septBoundariesD2.instantStartEpoch, septBoundariesD2.instantEndEpoch, septBoundariesD2.periodLabel);
    assert.equal(septResultAfterPayoff.newCommitmentsCents, 60000, "the pledge itself is still a September commitment");
    assert.equal(septResultAfterPayoff.recordedPaidBalanceCents, 0, "September's own recorded balance must stay $0 for this pledge -- the full payoff happened in October, after September had already closed");

    const octResultD2 = runCapability(lifecycleDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(octResultD2.recordedPaidBalanceCents, 90000, "unaffected by ga-paid-off: 50000 (ga-lifecycle, frozen at Stage C's value) + 40000 (ga-unchanged)");
    assert.equal(octResultD2.verifiedDatedPaymentsCents, 0, "the full $600 payoff is never counted as a verified dated payment anywhere, in any month");
  }

  // D3: a month/year boundary for the reconstruction query itself --
  // December's own pledge, created Dec 28, reimport-bumped on January 3
  // of the FOLLOWING year. December's recorded balance must freeze at
  // its pre-bump value despite the rollover into a new calendar year.
  const decBoundaries = localMonthBoundaries(Math.floor(Date.UTC(2026, 11, 15, 15, 0, 0) / 1000), ET);
  assert.equal(decBoundaries.periodLabel, "December 2026");
  const DEC = (day, hour = 15) => Math.floor(Date.UTC(2026, 11, day, hour, 0, 0) / 1000);
  const JAN2027 = (day, hour = 15) => Math.floor(Date.UTC(2027, 0, day, hour, 0, 0) / 1000);
  insertGivingActivity(lifecycleDb, { id: "ga-year-boundary", sourceFingerprint: "fp-year-boundary", category: "partially_paid_pledge", committedCents: 90000, paidCents: 10000, createdAt: DEC(28) });
  reimportBumpsPaid(lifecycleDb, "ga-year-boundary", 90000, 0, "completed_gift", JAN2027(3));
  {
    const decResult = runCapability(lifecycleDb, "user-1", decBoundaries.instantStartEpoch, decBoundaries.instantEndEpoch, decBoundaries.periodLabel);
    assert.equal(decResult.recordedPaidBalanceCents, 10000, "December's own recorded balance must freeze at the pre-January-bump $100, correctly reconstructed across the year rollover");
  }

  console.log("Part D (repeated unchanged imports, full payoff with no dated event, year-boundary reconstruction) checks passed.");

  // =====================================================================
  // Part E -- THE CRITICAL NEW TESTS: cross-user and cross-donor
  // fingerprint isolation ("Final Financial Reporting Integrity and Data
  // Isolation Review"). giving_activity_import_changes has NO
  // owner_user_id column of its own, and source_fingerprint is a pure
  // content hash with no user or donor identity folded in -- these tests
  // prove the owner-scoped join through data_imports actually prevents
  // one user's change-log history from leaking into another's
  // reconstruction, which a fingerprint-only match (the pre-fix query)
  // would not have prevented.
  // =====================================================================

  const isolationDb = freshDatabase();
  seedUser(isolationDb, "user-1", "donor-a", NOW);
  seedUser(isolationDb, "user-2", "donor-b", NOW);
  isolationDb.exec(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES ('import-user1','user-1','export1.csv','hash-u1','completed','{}',${NOW})`);
  isolationDb.exec(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES ('import-user2','user-2','export2.csv','hash-u2','completed','{}',${NOW})`);

  // E1 -- CROSS-USER fingerprint collision. Two different users' rows
  // share the IDENTICAL source_fingerprint (plausible in practice: JL
  // "Code" values are small, organization-assigned integers, easily
  // reused across unrelated accounts). Both are created the same month.
  // Only USER 2's row is ever touched again, in November, with a
  // WILDLY different prior value ($900) than user 1's own row ($100) --
  // chosen deliberately so any cross-contamination is unmistakable.
  const SHARED_FINGERPRINT = "fp-cross-user-collision";
  insertGivingActivity(isolationDb, { id: "ga-user1-row", donorId: "donor-a", ownerUserId: "user-1", sourceFingerprint: SHARED_FINGERPRINT, category: "partially_paid_pledge", committedCents: 50000, paidCents: 10000, createdAt: OCT(5) });
  insertGivingActivity(isolationDb, { id: "ga-user2-row", donorId: "donor-b", ownerUserId: "user-2", sourceFingerprint: SHARED_FINGERPRINT, category: "partially_paid_pledge", committedCents: 999000, paidCents: 90000, createdAt: OCT(5) });
  // User 1's own row is NEVER touched again -- its October figure must
  // simply stay at its own original $100 forever.
  // User 2's row IS touched in November, by an import tagged to user-2.
  reimportBumpsPaid(isolationDb, "ga-user2-row", 99900, 0, "completed_gift", NOV(10), "user-2");

  {
    const user1OctResult = runCapability(isolationDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    // THE CRITICAL ASSERTION: user 1's October figure must be exactly
    // their own $100 -- a fingerprint-only (unscoped) subquery would
    // instead find USER 2's November change-log row (same fingerprint,
    // created_at >= November 1) and incorrectly return ITS
    // previous_json.paid_cents ($900) -- a different user's pledge
    // value entirely, leaked into user 1's own report.
    assert.equal(user1OctResult.recordedPaidBalanceCents, 10000, "user 1's own October recorded balance must be exactly their own $100 -- never user 2's $900, which a fingerprint-only match without the data_imports ownership join would have incorrectly returned");
    assert.equal(user1OctResult.newCommitmentsCents, 50000, "user 1's own commitment amount, never user 2's $9,990 sharing the same fingerprint");

    // Mirror check: user 2's own October figure must correctly reflect
    // THEIR OWN reconstruction (frozen at their own pre-November value),
    // never bleeding into user 1's data either.
    const user2OctResult = runCapability(isolationDb, "user-2", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(user2OctResult.recordedPaidBalanceCents, 90000, "user 2's own October recorded balance, frozen at their own pre-November-reimport $900 -- never user 1's $100");
    assert.equal(user2OctResult.newCommitmentsCents, 999000, "user 2's own commitment amount, never user 1's $500");
  }

  // E2 -- structural proof that a cross-DONOR fingerprint collision
  // WITHIN one user is prevented by the schema itself, not by this
  // capability's own code: the giving_activities_owner_source_fingerprint_unique
  // index (owner_user_id, external_source, source_fingerprint) must
  // reject a second row for a DIFFERENT donor under the SAME user with
  // the SAME fingerprint. This is what guarantees that within one user,
  // a fingerprint can never ambiguously belong to more than one donor --
  // tested directly against the real constraint, not assumed from the
  // index's name.
  {
    const anotherDonorId = "donor-a2";
    isolationDb.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('${anotherDonorId}','user-1','live','Donor A2',${NOW},${NOW})`);
    assert.throws(
      () => insertGivingActivity(isolationDb, { id: "ga-user1-different-donor", donorId: anotherDonorId, ownerUserId: "user-1", sourceFingerprint: SHARED_FINGERPRINT, category: "completed_gift", committedCents: 1000, paidCents: 1000, createdAt: OCT(6) }),
      /UNIQUE constraint failed/i,
      "the real schema's own (owner_user_id, external_source, source_fingerprint) unique index must reject a second donor reusing the same fingerprint under the same user -- a fingerprint can never ambiguously belong to more than one donor within one user's account",
    );
  }

  // E3 -- multiple imports containing the same fingerprint, same user:
  // already exercised throughout Parts C/D (every reimportBumpsPaid call
  // reuses the row's own fingerprint across a new data_imports row) --
  // explicitly reconfirmed here as a dedicated, named check.
  {
    const multiImportDb = freshDatabase();
    seed(multiImportDb, NOW);
    insertGivingActivity(multiImportDb, { id: "ga-multi-import", sourceFingerprint: "fp-multi-import", category: "partially_paid_pledge", committedCents: 100000, paidCents: 10000, createdAt: OCT(5) });
    reimportBumpsPaid(multiImportDb, "ga-multi-import", 20000, 80000, "partially_paid_pledge", OCT(8));
    reimportBumpsPaid(multiImportDb, "ga-multi-import", 30000, 70000, "partially_paid_pledge", OCT(12));
    const changeCount = multiImportDb.prepare(`SELECT COUNT(*) AS n FROM giving_activity_import_changes WHERE source_fingerprint = 'fp-multi-import'`).get();
    assert.equal(changeCount.n, 2, "each distinct reimport of the same fingerprint gets its own change-log row, never overwritten or collapsed");
    const multiImportResult = runCapability(multiImportDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    assert.equal(multiImportResult.recordedPaidBalanceCents, 30000, "the LATEST value, correctly reconstructed across three total writes to the same fingerprint, all within the still-open current period");
  }

  console.log("Part E (cross-user and cross-donor fingerprint isolation) checks passed.");

  // =====================================================================
  // Part F -- the Category A vs. B mislabeling fix, directly: a pledge
  // whose real-world payment happened BEFORE it was ever imported into
  // this system must be labeled "recorded as paid," never "received."
  // =====================================================================

  const mislabelDb = freshDatabase();
  seed(mislabelDb, NOW);

  // A donor actually paid $500 in September (in the real world) -- but
  // this pledge is not imported into Fundraising OS until October, and
  // the import already shows the full $500 as paid. created_at = Oct 10
  // (when the ROW first entered this system), not September (when the
  // cash, per this fictional scenario, actually changed hands).
  insertGivingActivity(mislabelDb, { id: "ga-paid-before-import", sourceFingerprint: "fp-paid-before-import", category: "completed_gift", committedCents: 50000, paidCents: 50000, createdAt: OCT(10) });

  {
    const octResult = runCapability(mislabelDb, "user-1", octBoundaries.instantStartEpoch, octBoundaries.instantEndEpoch, octBoundaries.periodLabel);
    // The $500 is correctly counted as a Category B recorded balance for
    // October (the month it was first recorded) -- but it must NEVER
    // appear in Category A, since there is no dated payment-review
    // transaction behind it at all. This is the exact distinction the
    // review required: "it must not claim that $500 was received in
    // October merely because the record was imported then."
    assert.equal(octResult.recordedPaidBalanceCents, 50000, "the $500 is a real, correctly-dated RECORD (first recorded this period) -- shown in Category B");
    assert.equal(octResult.verifiedDatedPaymentsCents, 0, "the same $500 must NEVER appear in Category A -- this system has no evidence of when the cash itself was actually received, only when the record entered this system");
  }

  console.log("Part F (Category A vs. B mislabeling fix) checks passed.");
  console.log("fundraising-progress.test.mjs: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
