// Pending-Match Reconciliation Transactional Safety (2026-10-21, second
// follow-up review -- "enforce pending-pledge reconciliation success
// inside the import transaction"). Calls the REAL, unmodified
// `buildPendingReconciliationStatements`/`resolvePendingReconciliationOutcomes`
// exported from lib/giving/pending-reconciliation.ts -- the exact shared
// module app/api/import/route.ts uses for both the pending-gift and
// pending-pledge paths -- against a real in-memory SQLite database built
// from this repo's own committed migrations, with `.batch()` emulating
// D1's real one-transaction, statements-see-earlier-writes semantics
// (tests/helpers/d1-sqlite-adapter.mjs). Never a hand-copied
// reproduction of the SQL; never a source-text-only assertion for the
// behavioral checks below (two narrow structural assertions on
// app/api/import/route.ts itself close the file, confirming the route
// actually wires this shared module in, same convention as
// tests/pending-pledge.test.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);

const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const {
  buildPendingReconciliationStatements,
  resolvePendingReconciliationOutcomes,
} = await import("../lib/giving/pending-reconciliation.ts");
const { CONFIRM_PENDING_GIFT_SQL, CONFIRM_PENDING_PLEDGE_SQL } = await import("../lib/giving/management.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
const USER_ID = "u1";
const DONOR_ID = "d1";

function freshDb() {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Jane Donor', ?, ?)").bind(DONOR_ID, USER_ID, NOW, NOW).run();
  return db;
}

function seedPending(db, { id, category, committedCents }) {
  db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, 'Fundraising OS', ?, ?, ?, ?, 0, ?, ?, 'live', 'active', '{}', ?, ?)`)
    .bind(id, USER_ID, DONOR_ID, id, id, NOW, committedCents, committedCents, category, NOW, NOW).run();
}

function seedRealActivity(db, { id, category, committedCents, paidCents = 0, balanceCents }) {
  db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, 'JL Solutions', 'hh-1', ?, ?, ?, ?, ?, 'Item', ?, 'live', 'active', '{}', ?, ?)`)
    .bind(id, USER_ID, DONOR_ID, id, NOW, committedCents, paidCents, balanceCents ?? committedCents - paidCents, category, NOW, NOW).run();
}

function pendingRow(db, id) {
  return db.raw().prepare("SELECT workspace_status, confirmed_by_activity_id FROM giving_activities WHERE id = ?").get(id);
}

function auditRowsFor(db, activityId) {
  return db.raw().prepare("SELECT action, next_status FROM giving_activity_management_audits WHERE activity_id = ?").all(activityId)
    .map((row) => ({ action: row.action, next_status: row.next_status }));
}

async function run() {
  // --- 1. Two independent import attempts claim the same pending
  // pledge. Only one must actually confirm it; the loser's own real
  // import still succeeds, with no audit row and no double count. ---
  {
    const db = freshDb();
    seedPending(db, { id: "pending-1", category: "pending_pledge", committedCents: 15_000_00 });
    seedRealActivity(db, { id: "real-winner", category: "open_pledge", committedCents: 15_000_00, balanceCents: 15_000_00 });
    seedRealActivity(db, { id: "real-loser", category: "open_pledge", committedCents: 15_000_00, balanceCents: 15_000_00 });
    const pendingCandidate = { id: "pending-1", donor_id: DONOR_ID, activity_date: NOW, committed_cents: 15_000_00, description: null, private_note: null, workspace_status: "active", category: "pending_pledge", confirmed_by_activity_id: null };
    const match = { fingerprint: "fp-shared", candidates: [pendingCandidate] };
    const decisions = new Map([["fp-shared", { action: "merge", pendingId: "pending-1" }]]);

    // Attempt A (its own batch, its own statements) runs first and wins.
    const planA = buildPendingReconciliationStatements(db, CONFIRM_PENDING_PLEDGE_SQL, [match], decisions, new Map([["fp-shared", "real-winner"]]), USER_ID, "import-a", NOW);
    const resultsA = db.batch(planA.statements);
    const outcomeA = resolvePendingReconciliationOutcomes(resultsA, planA, 0);
    assert.deepEqual(outcomeA.confirmedCandidateIds, ["pending-1"]);
    assert.deepEqual(outcomeA.staleCandidateIds, []);

    // Attempt B (a SEPARATE, independent import -- its own statements,
    // its own batch) targets the SAME pending entry, now already
    // claimed by A.
    const planB = buildPendingReconciliationStatements(db, CONFIRM_PENDING_PLEDGE_SQL, [match], decisions, new Map([["fp-shared", "real-loser"]]), USER_ID, "import-b", NOW);
    const resultsB = db.batch(planB.statements);
    const outcomeB = resolvePendingReconciliationOutcomes(resultsB, planB, 0);
    assert.deepEqual(outcomeB.confirmedCandidateIds, [], "the loser's own claim must never be reported confirmed");
    assert.deepEqual(outcomeB.staleCandidateIds, ["pending-1"]);

    const row = pendingRow(db, "pending-1");
    assert.equal(row.workspace_status, "merged");
    assert.equal(row.confirmed_by_activity_id, "real-winner", "the pending entry must point at the WINNER only, never the loser");
    assert.deepEqual(auditRowsFor(db, "pending-1"), [{ action: "pending_matched", next_status: "merged" }], "exactly one audit row -- the loser's own conditional INSERT must have been a true no-op, never a second, misleading audit entry");
    // The loser's own real pledge import is NOT rolled back or
    // invalidated by losing the reconciliation race -- it still exists
    // as a normal, unmatched real pledge, exactly as a valid import
    // that simply didn't reconcile anything would.
    assert.ok(db.raw().prepare("SELECT 1 FROM giving_activities WHERE id = 'real-loser'").get(), "the loser's own real activity row must still exist -- a lost reconciliation claim never undoes a valid import");
  }

  // --- 2. The target becomes unavailable AFTER this request's own
  // validation read but BEFORE its write -- simulated by mutating the
  // row behind the plan's back, between building it and running its
  // batch. ---
  {
    const db = freshDb();
    seedPending(db, { id: "pending-2", category: "pending_pledge", committedCents: 9_000_00 });
    seedRealActivity(db, { id: "real-2", category: "open_pledge", committedCents: 9_000_00, balanceCents: 9_000_00 });
    const candidate = { id: "pending-2", donor_id: DONOR_ID, activity_date: NOW, committed_cents: 9_000_00, description: null, private_note: null, workspace_status: "active", category: "pending_pledge", confirmed_by_activity_id: null };
    const match = { fingerprint: "fp-2", candidates: [candidate] };
    const decisions = new Map([["fp-2", { action: "merge", pendingId: "pending-2" }]]);
    const plan = buildPendingReconciliationStatements(db, CONFIRM_PENDING_PLEDGE_SQL, [match], decisions, new Map([["fp-2", "real-2"]]), USER_ID, "import-2", NOW);

    // Someone else reconciles this exact pending entry between this
    // request's own validation and this write.
    db.raw().prepare("UPDATE giving_activities SET workspace_status = 'merged', confirmed_by_activity_id = 'someone-else' WHERE id = 'pending-2'").run();

    const results = db.batch(plan.statements);
    const outcome = resolvePendingReconciliationOutcomes(results, plan, 0);
    assert.deepEqual(outcome.confirmedCandidateIds, []);
    assert.deepEqual(outcome.staleCandidateIds, ["pending-2"]);
    const row = pendingRow(db, "pending-2");
    assert.equal(row.confirmed_by_activity_id, "someone-else", "the stale request must never overwrite the entry someone else already claimed");
    assert.equal(auditRowsFor(db, "pending-2").length, 0, "no audit row for a claim that never actually applied");
  }

  // --- 3. An identical import retry (the exact same decision, the
  // exact same target, run twice) must never double-apply or double-
  // audit the second time. ---
  {
    const db = freshDb();
    seedPending(db, { id: "pending-3", category: "pending_gift", committedCents: 5_000_00 });
    seedRealActivity(db, { id: "real-3", category: "completed_gift", committedCents: 5_000_00, paidCents: 5_000_00, balanceCents: 0 });
    const candidate = { id: "pending-3", donor_id: DONOR_ID, activity_date: NOW, committed_cents: 5_000_00, description: null, private_note: null, workspace_status: "active", category: "pending_gift", confirmed_by_activity_id: null };
    const match = { fingerprint: "fp-3", candidates: [candidate] };
    const decisions = new Map([["fp-3", { action: "merge", pendingId: "pending-3" }]]);
    const activityIds = new Map([["fp-3", "real-3"]]);

    const firstPlan = buildPendingReconciliationStatements(db, CONFIRM_PENDING_GIFT_SQL, [match], decisions, activityIds, USER_ID, "import-3", NOW);
    const firstResults = db.batch(firstPlan.statements);
    const firstOutcome = resolvePendingReconciliationOutcomes(firstResults, firstPlan, 0);
    assert.deepEqual(firstOutcome.confirmedCandidateIds, ["pending-3"]);

    // A retry builds the IDENTICAL plan again (the candidate is still
    // the same `pending.results` row a naive retry would see if it
    // re-read before this exact moment) and runs it a second time.
    const retryPlan = buildPendingReconciliationStatements(db, CONFIRM_PENDING_GIFT_SQL, [match], decisions, activityIds, USER_ID, "import-3-retry", NOW);
    const retryResults = db.batch(retryPlan.statements);
    const retryOutcome = resolvePendingReconciliationOutcomes(retryResults, retryPlan, 0);
    assert.deepEqual(retryOutcome.confirmedCandidateIds, [], "a retry's own CONFIRM must find the guard already closed (confirmed_by_activity_id is no longer NULL) and affect zero rows");
    assert.deepEqual(retryOutcome.staleCandidateIds, ["pending-3"]);
    assert.equal(auditRowsFor(db, "pending-3").length, 1, "exactly one audit row survives the retry -- never a second, duplicate entry");
  }

  // --- 4. A valid explicit "keep separate" decision builds no
  // statements at all -- nothing is attempted, nothing is touched. ---
  {
    const db = freshDb();
    seedPending(db, { id: "pending-4", category: "pending_pledge", committedCents: 2_000_00 });
    seedRealActivity(db, { id: "real-4", category: "open_pledge", committedCents: 2_000_00, balanceCents: 2_000_00 });
    const candidate = { id: "pending-4", donor_id: DONOR_ID, activity_date: NOW, committed_cents: 2_000_00, description: null, private_note: null, workspace_status: "active", category: "pending_pledge", confirmed_by_activity_id: null };
    const match = { fingerprint: "fp-4", candidates: [candidate] };
    const decisions = new Map([["fp-4", { action: "keep_separate", pendingId: null }]]);
    const plan = buildPendingReconciliationStatements(db, CONFIRM_PENDING_PLEDGE_SQL, [match], decisions, new Map([["fp-4", "real-4"]]), USER_ID, "import-4", NOW);
    assert.deepEqual(plan.statements, [], "keep-separate must build zero statements");
    const results = db.batch(plan.statements);
    const outcome = resolvePendingReconciliationOutcomes(results, plan, 0);
    assert.deepEqual(outcome.confirmedCandidateIds, []);
    assert.deepEqual(outcome.staleCandidateIds, []);
    const row = pendingRow(db, "pending-4");
    assert.equal(row.workspace_status, "active", "a kept-separate pending entry must remain completely untouched");
  }

  // --- 5. Existing pending-GIFT reconciliation still works through the
  // SAME shared module -- confirms the extraction did not regress the
  // original, narrower behavior. ---
  {
    const db = freshDb();
    seedPending(db, { id: "pending-5", category: "pending_gift", committedCents: 1_000_00 });
    seedRealActivity(db, { id: "real-5", category: "completed_gift", committedCents: 1_000_00, paidCents: 1_000_00, balanceCents: 0 });
    const candidate = { id: "pending-5", donor_id: DONOR_ID, activity_date: NOW, committed_cents: 1_000_00, description: "Annual gift", private_note: "note", workspace_status: "active", category: "pending_gift", confirmed_by_activity_id: null };
    const match = { fingerprint: "fp-5", candidates: [candidate] };
    const decisions = new Map([["fp-5", { action: "merge", pendingId: "pending-5" }]]);
    const plan = buildPendingReconciliationStatements(db, CONFIRM_PENDING_GIFT_SQL, [match], decisions, new Map([["fp-5", "real-5"]]), USER_ID, "import-5", NOW);
    const results = db.batch(plan.statements);
    const outcome = resolvePendingReconciliationOutcomes(results, plan, 0);
    assert.deepEqual(outcome.confirmedCandidateIds, ["pending-5"]);
    const row = pendingRow(db, "pending-5");
    assert.equal(row.workspace_status, "merged");
    assert.equal(row.confirmed_by_activity_id, "real-5");
  }

  // --- Structural coverage: the real import route actually wires this
  // shared module in (never a copy), and never reports the import's own
  // success/failure from the merge decision alone. ---
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  assert.match(importRoute, /buildPendingReconciliationStatements/);
  assert.match(importRoute, /resolvePendingReconciliationOutcomes/);
  assert.match(importRoute, /staleCandidateIds/);

  console.log("pending-reconciliation-transaction.test.mjs: all assertions passed");
}

await run();
