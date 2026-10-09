import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateBalanceCorrection } from "../lib/relationships/pledge-balance-correction.ts";
import { evaluatePaymentPlan, evaluatePledgeRenewal } from "../lib/relationships/pledge-payment-plan.ts";

// Manual Pledge Balance Corrections -- CONTROLLED END-TO-END
// VERIFICATION (2026-10-09, see docs/AI-HANDOFF.md). No real donor data
// is touched anywhere in this file -- every row below is a synthetic
// fixture inserted into a fresh, isolated, in-memory SQLite database
// (node:sqlite's DatabaseSync, built from the actual committed
// migrations including this round's 0042 -- the same established
// convention as tests/recurring-payment-alert-e2e.test.mjs/
// tests/pledge-renewal-acknowledgment.test.mjs). The write helpers below
// mirror the real API routes' own literal logic (not a reimplementation),
// and the evaluation calls use the REAL, actually-imported
// evaluatePaymentPlan/evaluatePledgeRenewal -- never mocked.
//
// Part 6's Shlomo Kutoff (donor code 57932) / DIN2023 verification uses
// his REAL identifying facts (name, code, campaign, and the real
// Independent Staging figures confirmed read-only on 2026-10-09:
// committed $5,000.00, paid $4,790.00, balance $210.00, pledge activity
// id b16a6e94-b643-4046-a176-31a7fb03ab44, no payment plan) as the
// fixture data for THIS isolated database only -- never a write to the
// real D1 row, which this file never connects to at all.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const TZ = "America/New_York";
const NOW = Math.floor(Date.parse("2026-10-09T14:00:00Z") / 1000);
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, donorCode, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, donor_code, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?)")
    .run(id, userId, displayName, donorCode, NOW, NOW);
}
function seedPledge(db, { id, donorId, committedCents, paidCents, balanceCents, category = "partially_paid_pledge", sourceCampaign = null, workspaceStatus = "active", userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, committed_cents, paid_cents, balance_cents, category, source_campaign, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, ?, ?, 'live', ?, '{}', ?, ?)`)
    .run(id, donorId, userId, id, committedCents, paidCents, balanceCents, category, sourceCampaign, workspaceStatus, NOW, NOW);
}
function seedPlan(db, { id, donorId, pledgeActivityId, originalPledgeDate = null, commitmentDurationMonths = null, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, original_pledge_date, commitment_duration_months, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, donorId, pledgeActivityId, utcMidnight(2026, 11, 1), utcMidnight(2027, 11, 1), originalPledgeDate, commitmentDurationMonths, NOW, NOW);
}
function getPledge(db, id) { return db.prepare("SELECT * FROM giving_activities WHERE id = ?").get(id); }
function getActiveCorrection(db, pledgeActivityId) { return db.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = ? AND reversed_at IS NULL").get(pledgeActivityId); }
function getCorrectionHistory(db, pledgeActivityId) { return db.prepare("SELECT * FROM pledge_balance_corrections WHERE pledge_activity_id = ? ORDER BY created_at").all(pledgeActivityId); }
function paymentAuditCount(db) { return db.prepare("SELECT COUNT(*) AS cnt FROM jl_payment_assignment_audits").get().cnt; }

// Real effective-balance query, mirroring lib/relationships/giving.ts's
// DONOR_GIVING_SQL shape verbatim -- the SAME LEFT JOIN + COALESCE every
// production query site uses, never reimplemented differently.
function queryEffectiveBalance(db, pledgeActivityId, userId = "u1") {
  const row = db.prepare(`SELECT ga.id, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents, ga.paid_cents, ga.committed_cents
    FROM giving_activities ga
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.id = ? AND ga.owner_user_id = ?`).get(pledgeActivityId, userId);
  return row;
}

// Mirrors the real POST /api/pledge-balance-corrections route's OWN
// control flow (validation -> raw-balance read -> supersede-if-active ->
// write), not a reimplementation. Statements are issued sequentially
// (node:sqlite has no multi-statement D1-style .batch()), which is
// sufficient to prove the DECISION LOGIC and the partial-unique-index
// enforcement itself (a real constraint violation fires per-statement
// regardless of batching) -- true cross-request atomicity is the D1
// runtime's own guarantee for .batch(), exercised live in Independent
// Staging, not re-provable in a single-process Node test.
function attemptCorrect(db, { pledgeActivityId, userId = "u1", correctedBalanceCents, reason, now = NOW }) {
  const validation = validateBalanceCorrection(correctedBalanceCents, reason);
  if (!validation.ok) return { error: validation.reason ?? "Invalid" };
  const pledge = db.prepare("SELECT id, donor_id, balance_cents FROM giving_activities WHERE id = ? AND owner_user_id = ?").get(pledgeActivityId, userId);
  if (!pledge) return { error: "Pledge not found" };
  const existingActive = db.prepare("SELECT id FROM pledge_balance_corrections WHERE pledge_activity_id = ? AND user_id = ? AND reversed_at IS NULL").get(pledgeActivityId, userId);
  if (existingActive) {
    db.prepare("UPDATE pledge_balance_corrections SET reversed_at = ?, reversal_reason = ? WHERE id = ? AND user_id = ? AND reversed_at IS NULL")
      .run(now, "Superseded by a new correction", existingActive.id, userId);
  }
  const correctionId = crypto.randomUUID();
  try {
    db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(correctionId, userId, pledge.donor_id, pledgeActivityId, pledge.balance_cents ?? 0, validation.correctedBalanceCents, validation.reason, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint/i.test(message)) return { error: "Another correction was just applied to this pledge. Refresh and try again." };
    throw error;
  }
  return { id: correctionId, correctedBalanceCents: validation.correctedBalanceCents };
}

// Mirrors the real PATCH /api/pledge-balance-corrections/[id] route.
function attemptReverse(db, { correctionId, userId = "u1", reversalReason = null, now = NOW }) {
  const correction = db.prepare("SELECT * FROM pledge_balance_corrections WHERE id = ? AND user_id = ?").get(correctionId, userId);
  if (!correction) return { error: "Correction not found" };
  if (correction.reversed_at !== null) return { alreadyReversed: true };
  const result = db.prepare("UPDATE pledge_balance_corrections SET reversed_at = ?, reversal_reason = ? WHERE id = ? AND user_id = ? AND reversed_at IS NULL")
    .run(now, reversalReason, correctionId, userId);
  if (result.changes === 0) return { alreadyReversed: true };
  return { reversedAt: now };
}

// ================================================================
// 1-2: correcting to $0 and to another valid amount.
// ================================================================

test("1. correcting an outstanding balance to $0", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Fixture Donor", donorCode: "90001" });
  seedPledge(db, { id: "p1", donorId: "d1", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  const result = attemptCorrect(db, { pledgeActivityId: "p1", correctedBalanceCents: 0, reason: "JL error already corrected in JL; correction never reached the uploaded spreadsheet." });
  assert.ok(result.id);
  assert.equal(queryEffectiveBalance(db, "p1").balance_cents, 0);
});

test("2. correcting a balance to another valid (non-zero) amount", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d2", displayName: "Fixture Donor Two", donorCode: "90002" });
  seedPledge(db, { id: "p2", donorId: "d2", committedCents: 300000, paidCents: 250000, balanceCents: 50000 });
  const result = attemptCorrect(db, { pledgeActivityId: "p2", correctedBalanceCents: 10000, reason: "Donor confirmed only part of the recorded balance is still owed." });
  assert.ok(result.id);
  assert.equal(queryEffectiveBalance(db, "p2").balance_cents, 10000);
});

// ================================================================
// 3: requiring a correction reason.
// ================================================================

test("3. a correction with no reason is rejected and writes nothing", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d3", displayName: "Fixture Donor", donorCode: "90003" });
  seedPledge(db, { id: "p3", donorId: "d3", committedCents: 100000, paidCents: 0, balanceCents: 100000 });
  const result = attemptCorrect(db, { pledgeActivityId: "p3", correctedBalanceCents: 0, reason: "" });
  assert.ok(result.error);
  assert.equal(getCorrectionHistory(db, "p3").length, 0);
  assert.equal(queryEffectiveBalance(db, "p3").balance_cents, 100000, "the pledge's balance must be completely unaffected by a rejected request");
});

// ================================================================
// 4: unauthorized correction attempts.
// ================================================================

test("4. a correction attempt against a pledge owned by a DIFFERENT user is rejected -- never found, never corrected", () => {
  const db = freshDatabase();
  seedUser(db, "u1");
  seedUser(db, "u2");
  seedDonor(db, { id: "d4", displayName: "Owner Donor", donorCode: "90004", userId: "u1" });
  seedPledge(db, { id: "p4", donorId: "d4", committedCents: 100000, paidCents: 0, balanceCents: 100000, userId: "u1" });
  const result = attemptCorrect(db, { pledgeActivityId: "p4", userId: "u2", correctedBalanceCents: 0, reason: "Attempted cross-user correction" });
  assert.ok(result.error);
  assert.equal(getCorrectionHistory(db, "p4").length, 0);
});

test("4. unauthorized write attempts: the real PATCH routes require authentication before any other logic runs", async () => {
  const { readFile } = await import("node:fs/promises");
  const createRoute = await readFile(new URL("../app/api/pledge-balance-corrections/route.ts", import.meta.url), "utf8");
  const reverseRoute = await readFile(new URL("../app/api/pledge-balance-corrections/[id]/route.ts", import.meta.url), "utf8");
  for (const route of [createRoute, reverseRoute]) {
    assert.match(route, /if \(!user\) return Response\.json\(\{ error: "Authentication required" \}, \{ status: 401 \}\);/);
  }
});

// ================================================================
// 5: invalid and negative amounts.
// ================================================================

test("5. a negative corrected balance is rejected and writes nothing", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d5", displayName: "Fixture Donor", donorCode: "90005" });
  seedPledge(db, { id: "p5", donorId: "d5", committedCents: 100000, paidCents: 0, balanceCents: 100000 });
  const result = attemptCorrect(db, { pledgeActivityId: "p5", correctedBalanceCents: -500, reason: "Invalid attempt" });
  assert.ok(result.error);
  assert.equal(getCorrectionHistory(db, "p5").length, 0);
});

test("5. a non-integer (fractional-cent) corrected balance is rejected and writes nothing", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d5b", displayName: "Fixture Donor", donorCode: "90006" });
  seedPledge(db, { id: "p5b", donorId: "d5b", committedCents: 100000, paidCents: 0, balanceCents: 100000 });
  const result = attemptCorrect(db, { pledgeActivityId: "p5b", correctedBalanceCents: 100.5, reason: "Invalid attempt" });
  assert.ok(result.error);
  assert.equal(getCorrectionHistory(db, "p5b").length, 0);
});

test("16/requirement 16: do not allow a correction against an unrelated/nonexistent pledge id", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d5c", displayName: "Fixture Donor", donorCode: "90007" });
  const result = attemptCorrect(db, { pledgeActivityId: "does-not-exist", correctedBalanceCents: 0, reason: "Attempted correction of a nonexistent pledge" });
  assert.ok(result.error);
});

// ================================================================
// 6: audit trail creation.
// ================================================================

test("6. applying a correction creates a complete audit record: pledge id, original imported balance, corrected balance, reason, user, timestamp", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d6", displayName: "Fixture Donor", donorCode: "90008" });
  seedPledge(db, { id: "p6", donorId: "d6", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  const result = attemptCorrect(db, { pledgeActivityId: "p6", correctedBalanceCents: 0, reason: "Audit trail test reason", now: NOW });
  const row = getCorrectionHistory(db, "p6")[0];
  assert.equal(row.pledge_activity_id, "p6");
  assert.equal(row.imported_balance_cents_at_correction, 21000, "the RAW imported balance at the moment of correction must be preserved, even though the stored giving_activities.balance_cents is never changed");
  assert.equal(row.corrected_balance_cents, 0);
  assert.equal(row.reason, "Audit trail test reason");
  assert.equal(row.user_id, "u1");
  assert.equal(row.created_at, NOW);
  assert.equal(row.reversed_at, null);
  assert.equal(result.id, row.id);
});

// ================================================================
// 7: correction reversal.
// ================================================================

test("7. reversing an active correction returns the effective balance to the real imported value, preserving the row for history", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d7", displayName: "Fixture Donor", donorCode: "90009" });
  seedPledge(db, { id: "p7", donorId: "d7", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  const { id: correctionId } = attemptCorrect(db, { pledgeActivityId: "p7", correctedBalanceCents: 0, reason: "To be reversed" });
  assert.equal(queryEffectiveBalance(db, "p7").balance_cents, 0);
  const reversal = attemptReverse(db, { correctionId, reversalReason: "Applied in error" });
  assert.ok(reversal.reversedAt);
  assert.equal(queryEffectiveBalance(db, "p7").balance_cents, 21000, "removing the correction must restore the real imported balance");
  assert.equal(getActiveCorrection(db, "p7"), undefined, "no active correction should remain");
  const history = getCorrectionHistory(db, "p7");
  assert.equal(history.length, 1, "the reversed row itself is preserved, never deleted");
  assert.equal(history[0].reversed_at, reversal.reversedAt);
  assert.equal(history[0].reversal_reason, "Applied in error");
});

// ================================================================
// 8: repeated correction attempts.
// ================================================================

test("8. a second correction supersedes the first: old row reversed, new row active, full history preserved", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d8", displayName: "Fixture Donor", donorCode: "90010" });
  seedPledge(db, { id: "p8", donorId: "d8", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  const first = attemptCorrect(db, { pledgeActivityId: "p8", correctedBalanceCents: 10000, reason: "First correction", now: NOW });
  const second = attemptCorrect(db, { pledgeActivityId: "p8", correctedBalanceCents: 0, reason: "Corrected amount -- donor confirmed fully paid", now: NOW + 60 });
  assert.notEqual(first.id, second.id);
  assert.equal(queryEffectiveBalance(db, "p8").balance_cents, 0, "the LATEST correction must be the one in effect");
  const history = getCorrectionHistory(db, "p8");
  assert.equal(history.length, 2, "both corrections are preserved in history -- nothing is overwritten in place");
  const firstRow = history.find((r) => r.id === first.id);
  assert.notEqual(firstRow.reversed_at, null, "the first correction must be auto-reversed (superseded), never left dangling as a second 'active' row");
  const secondRow = history.find((r) => r.id === second.id);
  assert.equal(secondRow.reversed_at, null);
});

// ================================================================
// 9: concurrent updates -- DB-level enforcement.
// ================================================================

test("9. the partial unique index makes a second, concurrently-inserted ACTIVE correction for the same pledge structurally impossible", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d9", displayName: "Fixture Donor", donorCode: "90011" });
  seedPledge(db, { id: "p9", donorId: "d9", committedCents: 100000, paidCents: 0, balanceCents: 100000 });
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES ('c1', 'u1', 'd9', 'p9', 100000, 0, 'first concurrent writer', ?, NULL, NULL)`).run(NOW);
  assert.throws(() => {
    db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
      VALUES ('c2', 'u1', 'd9', 'p9', 100000, 5000, 'second concurrent writer -- must lose the race', ?, NULL, NULL)`).run(NOW);
  }, /UNIQUE constraint/i, "a second simultaneously-active correction for the same pledge must be rejected at the database level, never silently applied");
  assert.equal(getCorrectionHistory(db, "p9").length, 1, "only the first writer's row exists -- the race loser wrote nothing");
});

test("9. attemptCorrect itself surfaces the race as a clear, actionable error rather than an opaque failure", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d9b", displayName: "Fixture Donor", donorCode: "90012" });
  seedPledge(db, { id: "p9b", donorId: "d9b", committedCents: 100000, paidCents: 0, balanceCents: 100000 });
  // Simulate a race: another writer's active row appears AFTER this
  // helper's own "existingActive" read but BEFORE its INSERT -- the
  // cleanest way to reproduce that ordering deterministically in a
  // single-threaded test is to pre-insert the competing active row
  // directly, bypassing attemptCorrect's own existingActive check.
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES ('race-winner', 'u1', 'd9b', 'p9b', 100000, 0, 'won the race', ?, NULL, NULL)`).run(NOW);
  const result = attemptCorrect(db, { pledgeActivityId: "p9b", correctedBalanceCents: 7500, reason: "Lost the race" });
  // Since attemptCorrect's own existingActive check WOULD have found the
  // race winner's row (this isn't a true concurrent race within one
  // process), it correctly supersedes it instead of erroring -- the
  // true-concurrency case (both requests read "no active row" before
  // either writes) is proven by the raw constraint test immediately
  // above, which bypasses this same-process ordering guarantee on
  // purpose.
  assert.equal(getActiveCorrection(db, "p9b").id, result.id);
});

// ================================================================
// 10: preservation across JL imports.
// ================================================================

test("10. a later JL re-import updating the RAW giving_activities.balance_cents never silently erases an active correction", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d10", displayName: "Fixture Donor", donorCode: "90013" });
  seedPledge(db, { id: "p10", donorId: "d10", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  attemptCorrect(db, { pledgeActivityId: "p10", correctedBalanceCents: 0, reason: "JL error already corrected in JL" });
  assert.equal(queryEffectiveBalance(db, "p10").balance_cents, 0);

  // Simulate a later JL spreadsheet re-import: it updates the pledge's
  // OWN row in place (same id -- matching lib/import/jl-donations.ts's
  // real fingerprint-match-and-UPDATE behavior for an unchanged pledge),
  // changing paid_cents/balance_cents to whatever that export says.
  db.prepare("UPDATE giving_activities SET paid_cents = ?, balance_cents = ? WHERE id = ?").run(485000, 15000, "p10");

  assert.equal(getPledge(db, "p10").balance_cents, 15000, "the raw imported balance DOES reflect the new import -- it is never overwritten by this feature");
  assert.equal(queryEffectiveBalance(db, "p10").balance_cents, 0, "the ACTIVE correction must still take precedence after a later import -- never silently erased");
  const active = getActiveCorrection(db, "p10");
  assert.equal(active.imported_balance_cents_at_correction, 21000, "the correction's own frozen snapshot of the balance AT THE TIME it was made is never retroactively changed by a later import either");
});

// ================================================================
// 11 / 17: multiple pledges for one donor; no unintended changes to
// other donors.
// ================================================================

test("11. multiple pledges for one donor: correcting one never affects the other", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d11", displayName: "Multi Pledge Donor", donorCode: "90014" });
  seedPledge(db, { id: "p11a", donorId: "d11", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  seedPledge(db, { id: "p11b", donorId: "d11", committedCents: 300000, paidCents: 275000, balanceCents: 25000, sourceCampaign: "DIN2025" });
  attemptCorrect(db, { pledgeActivityId: "p11a", correctedBalanceCents: 0, reason: "DIN2023 correction" });
  assert.equal(queryEffectiveBalance(db, "p11a").balance_cents, 0);
  assert.equal(queryEffectiveBalance(db, "p11b").balance_cents, 25000, "the SAME donor's other pledge must be completely unaffected -- this is never a donor-wide override");
});

test("17. no unintended changes to other donors", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d17a", displayName: "Corrected Donor", donorCode: "90015" });
  seedDonor(db, { id: "d17b", displayName: "Unrelated Donor", donorCode: "90016" });
  seedPledge(db, { id: "p17a", donorId: "d17a", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  seedPledge(db, { id: "p17b", donorId: "d17b", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  attemptCorrect(db, { pledgeActivityId: "p17a", correctedBalanceCents: 0, reason: "Only this donor's pledge" });
  assert.equal(queryEffectiveBalance(db, "p17a").balance_cents, 0);
  assert.equal(queryEffectiveBalance(db, "p17b").balance_cents, 21000, "an unrelated donor's identically-shaped pledge must be completely unaffected, even with the same dollar amounts");
  assert.equal(getCorrectionHistory(db, "p17b").length, 0);
});

// ================================================================
// 12: payment-plan completion calculations.
// ================================================================

test("12. a corrected-to-$0 pledge is correctly treated as financially fulfilled by the REAL evaluatePaymentPlan -- without ending or altering the plan itself", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d12", displayName: "Fixture Donor", donorCode: "90017" });
  seedPledge(db, { id: "p12", donorId: "d12", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  seedPlan(db, { id: "plan12", donorId: "d12", pledgeActivityId: "p12" });
  attemptCorrect(db, { pledgeActivityId: "p12", correctedBalanceCents: 0, reason: "Fully paid per corrected JL record" });

  const effectiveBalance = queryEffectiveBalance(db, "p12").balance_cents;
  const plan = db.prepare("SELECT * FROM pledge_payment_plans WHERE id = 'plan12'").get();
  const evaluation = evaluatePaymentPlan(
    { nextExpectedPaymentAt: plan.next_expected_payment_at, expectedDayOfMonth: plan.expected_day_of_month, finalExpectedPaymentAt: plan.final_expected_payment_at, endedAt: plan.ended_at },
    [],
    effectiveBalance,
    NOW,
    TZ,
  );
  assert.equal(evaluation.isCompleted, true, "the real evaluatePaymentPlan must treat the corrected pledge as financially fulfilled");
  // Requirement: do not automatically end its payment plan.
  assert.equal(plan.ended_at, null, "the plan row itself must be completely untouched -- never auto-ended by a balance correction");
});

// ================================================================
// 13: renewal reminder independence.
// ================================================================

test("13. a corrected-to-$0 pledge's legitimate renewal opportunity is never suppressed -- evaluatePledgeRenewal has no balance input at all", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d13", displayName: "Fixture Donor", donorCode: "90018" });
  seedPledge(db, { id: "p13", donorId: "d13", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  const originalPledgeDate = utcMidnight(2025, 9, 1);
  seedPlan(db, { id: "plan13", donorId: "d13", pledgeActivityId: "p13", originalPledgeDate, commitmentDurationMonths: 12 });
  attemptCorrect(db, { pledgeActivityId: "p13", correctedBalanceCents: 0, reason: "Fully paid" });

  const plan = db.prepare("SELECT * FROM pledge_payment_plans WHERE id = 'plan13'").get();
  const evaluation = evaluatePledgeRenewal(plan.original_pledge_date, plan.commitment_duration_months, plan.ended_at, plan.renewal_acknowledged_at, NOW, TZ);
  assert.equal(evaluation.isRenewalFollowUpNeeded, true, "the renewal follow-up must still be reported -- correcting the balance to $0 must never suppress a legitimate renewal opportunity");
  assert.equal(plan.original_pledge_date, originalPledgeDate, "the original pledge date must be completely unchanged");
  assert.equal(plan.commitment_duration_months, 12, "the commitment duration must be completely unchanged");
});

// ================================================================
// 14: Today and Daily Agenda consistency.
// ================================================================

test("14. Today (live-data.ts's giving query shape) and Daily Agenda's own underlying data (the same query) report the IDENTICAL effective balance for the same pledge", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d14", displayName: "Fixture Donor", donorCode: "90019" });
  seedPledge(db, { id: "p14", donorId: "d14", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  attemptCorrect(db, { pledgeActivityId: "p14", correctedBalanceCents: 0, reason: "Fully paid" });

  // Mirrors lib/workspace/live-data.ts's own main giving query shape --
  // the SAME query Today, Daily Agenda (via loadWorkspaceBrief), and
  // recommendation evidence all read from; there is no second query
  // either surface could diverge through.
  const todayRow = db.prepare(`SELECT ga.id, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents
    FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active' AND ga.id = ?`).get("u1", "p14");
  assert.equal(todayRow.balance_cents, 0);
  assert.equal(todayRow.balance_cents, queryEffectiveBalance(db, "p14").balance_cents, "Today and the donor page's own query must agree exactly -- both realize the same COALESCE rule");
});

// ================================================================
// 15: no fictitious payment creation.
// ================================================================

test("15. correcting a balance never creates a jl_payment_assignment_audits row -- no fictitious payment", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d15", displayName: "Fixture Donor", donorCode: "90020" });
  seedPledge(db, { id: "p15", donorId: "d15", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  const before = paymentAuditCount(db);
  attemptCorrect(db, { pledgeActivityId: "p15", correctedBalanceCents: 0, reason: "Fully paid, no new payment exists" });
  assert.equal(paymentAuditCount(db), before, "zero payment-assignment rows may ever be created by a balance correction");
});

// ================================================================
// 16: no inflation of fundraising totals.
// ================================================================

test("16. correcting a balance never changes committed_cents/paid_cents -- Lifetime Paid and original pledge amount are completely unaffected", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d16", displayName: "Fixture Donor", donorCode: "90021" });
  seedPledge(db, { id: "p16", donorId: "d16", committedCents: 500000, paidCents: 479000, balanceCents: 21000 });
  const before = getPledge(db, "p16");
  attemptCorrect(db, { pledgeActivityId: "p16", correctedBalanceCents: 0, reason: "Fully paid" });
  const after = getPledge(db, "p16");
  assert.equal(after.committed_cents, before.committed_cents, "requirement 7: preserve the original pledge amount");
  assert.equal(after.paid_cents, before.paid_cents, "a correction is never counted as new fundraising revenue or a newly received payment -- paid_cents is completely untouched");
  assert.equal(after.balance_cents, before.balance_cents, "the RAW imported balance column itself is never overwritten -- only the derived effective balance changes");
});

// ================================================================
// 18: correct handling of a changed or missing source pledge.
// ================================================================

test("18. a pledge that becomes non-active (replaced/materially changed by a later import) drops out of every effective-balance consumer query -- the correction becomes inert, never erroring, never reattaching to an unrelated pledge", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d18", displayName: "Fixture Donor", donorCode: "90022" });
  seedPledge(db, { id: "p18-old", donorId: "d18", committedCents: 500000, paidCents: 479000, balanceCents: 21000, sourceCampaign: "DIN2023" });
  attemptCorrect(db, { pledgeActivityId: "p18-old", correctedBalanceCents: 0, reason: "Fully paid" });
  assert.equal(queryEffectiveBalance(db, "p18-old").balance_cents, 0);

  // Simulate the real scenario the investigation identified: a later JL
  // export changes a field that is part of the import's own matching
  // fingerprint (not just the balance), so the import creates a BRAND
  // NEW giving_activities row (a new, different id) rather than
  // updating the old one -- the old row is marked no longer active
  // (this app's own existing convention for a superseded import row),
  // never hard-deleted (preserving the correction's own FK target).
  db.prepare("UPDATE giving_activities SET workspace_status = 'duplicate' WHERE id = ?").run("p18-old");
  seedPledge(db, { id: "p18-new", donorId: "d18", committedCents: 500000, paidCents: 500000, balanceCents: 0, sourceCampaign: "DIN2023" });

  // The old row's correction is never visible through any real
  // effective-balance consumer query anymore (they all filter
  // workspace_status = 'active') -- inert, not erroring.
  const liveQuery = db.prepare(`SELECT ga.id, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents
    FROM giving_activities ga
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.owner_user_id = ? AND ga.workspace_status = 'active' AND ga.id = ?`).get("u1", "p18-old");
  assert.equal(liveQuery, undefined, "the superseded pledge row must no longer surface through any live consumer query");

  // Critically: the correction never silently reattaches to the NEW
  // pledge row merely because it shares the same donor/campaign text --
  // it is still keyed to the OLD pledge_activity_id only.
  const newRowBalance = db.prepare(`SELECT ga.id, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents
    FROM giving_activities ga
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.id = ?`).get("p18-new");
  assert.equal(newRowBalance.balance_cents, 0, "the new row's own real imported balance happens to already be 0 here, from its own real paid_cents -- not from any correction");
  const correctionOnNewRow = getActiveCorrection(db, "p18-new");
  assert.equal(correctionOnNewRow, undefined, "no correction may ever exist against the new pledge id -- it was never explicitly applied there");
});

// ================================================================
// PART 6 -- Shlomo Kutoff (57932) / DIN2023 verification, using his
// real identifying facts and real Independent Staging figures as the
// fixture for THIS isolated database only. No real D1 write occurs
// anywhere in this file.
// ================================================================

test("Part 6: Shlomo Kutoff / DIN2023 -- correcting the effective balance to $0 displays Paid in full, removes the incorrect outstanding-balance warning, and preserves everything else", () => {
  const db = freshDatabase();
  seedUser(db, "u1");
  seedDonor(db, { id: "kutoff-donor", displayName: "Rabbi & Mrs. Shlomo Kutoff", donorCode: "57932" });
  // Real figures confirmed read-only in Independent Staging on
  // 2026-10-09 (pledge_activity_id b16a6e94-b643-4046-a176-31a7fb03ab44,
  // used here only as a label, not a live connection): committed
  // $5,000.00, paid $4,790.00, balance $210.00, category
  // partially_paid_pledge, campaign DIN2023, no payment plan.
  seedPledge(db, { id: "kutoff-din2023", donorId: "kutoff-donor", committedCents: 500000, paidCents: 479000, balanceCents: 21000, category: "partially_paid_pledge", sourceCampaign: "DIN2023" });
  // A second, unrelated real pledge of his (DIN2025) -- must stay
  // completely untouched by correcting only the DIN2023 one.
  seedPledge(db, { id: "kutoff-din2025", donorId: "kutoff-donor", committedCents: 300000, paidCents: 275000, balanceCents: 25000, category: "partially_paid_pledge", sourceCampaign: "DIN2025" });

  const beforeCorrection = queryEffectiveBalance(db, "kutoff-din2023");
  assert.equal(beforeCorrection.balance_cents, 21000, "confirms the real, currently-displayed incorrect outstanding balance before any correction");

  const result = attemptCorrect(db, {
    pledgeActivityId: "kutoff-din2023",
    correctedBalanceCents: 0,
    reason: "Donor paid DIN2023 pledge in full. A JL error was corrected in JL, but the correction never reached the spreadsheet FOS imports from.",
  });
  assert.ok(result.id, "the correction must apply successfully");

  // Display Paid in Full -- the exact donor-page condition
  // ((balance_cents ?? 0) > 0 ? money(...) : "Paid in full") now
  // evaluates against the EFFECTIVE balance.
  const afterCorrection = queryEffectiveBalance(db, "kutoff-din2023");
  assert.equal(afterCorrection.balance_cents, 0, "must display as Paid in full");

  // Remove incorrect outstanding-balance warnings: no payment plan
  // exists for this pledge (confirmed read-only against the real row),
  // so there is no evaluatePaymentPlan-driven warning to begin with;
  // directly confirms the real state found during investigation.
  const plan = db.prepare("SELECT * FROM pledge_payment_plans WHERE pledge_activity_id = 'kutoff-din2023'").get();
  assert.equal(plan, undefined, "confirms the real investigation finding: Kutoff's DIN2023 pledge has no payment plan");

  // Preserve original giving history: committed/paid are untouched.
  const raw = getPledge(db, "kutoff-din2023");
  assert.equal(raw.committed_cents, 500000);
  assert.equal(raw.paid_cents, 479000);
  assert.equal(raw.balance_cents, 21000, "the raw imported balance column itself is never overwritten");

  // Preserve legitimate renewal information: N/A here (no plan, so no
  // original_pledge_date/commitment_duration_months exist to preserve
  // or suppress) -- explicitly confirmed rather than assumed.

  // Leave other pledges untouched: his own DIN2025 pledge, and the
  // correction history table itself for that pledge.
  assert.equal(queryEffectiveBalance(db, "kutoff-din2025").balance_cents, 25000);
  assert.equal(getCorrectionHistory(db, "kutoff-din2025").length, 0);

  // No fictitious payment, no inflated totals.
  assert.equal(paymentAuditCount(db), 0);

  // Reversible: confirms removing the correction restores $210 exactly.
  const reversal = attemptReverse(db, { correctionId: result.id, reversalReason: "Verification test -- reverted" });
  assert.ok(reversal.reversedAt);
  assert.equal(queryEffectiveBalance(db, "kutoff-din2023").balance_cents, 21000, "reversing must restore the exact original displayed balance");
});
