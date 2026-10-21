// Reconciliation Concurrency Fix (2026-10-21, see docs/AI-HANDOFF.md).
//
// Every other trip-financial-attribution test in this codebase exercises
// either a pure function directly, or a hand-copied reproduction of the
// real SQL/source text (documented, repeatedly, as the only option
// available, since every D1-touching module imports "cloudflare:workers"
// and "cannot run outside a Workers runtime at all"). This file exists
// because a hand-copied reproduction cannot prove a CONCURRENCY fix is
// real -- it can only prove that the copy, re-typed by hand, behaves the
// way the person typing it expected, which is exactly the blind spot a
// race condition hides in. This file instead calls the REAL, unmodified
// `attributeGivingActivityToTrip`/`listReconcilableTripAttributions`
// exported from lib/relationships/trips-data.ts, by intercepting the
// "cloudflare:workers" specifier with a Node module customization hook
// (helpers/cloudflare-workers-shim-loader.mjs) and supplying `env.DB` as
// a small adapter over a real, in-memory node:sqlite database built from
// every real, committed migration in this repo (helpers/d1-sqlite-adapter.mjs)
// -- same "real schema, real migrations" rigor as
// trip-financial-attribution-schema.test.mjs, but calling the actual
// production functions instead of reproducing their SQL.
//
// What this DOES prove: the real write path's own logic is correct
// against SQLite's real transaction/constraint semantics -- the ambiguous-
// match guard, the atomic insert-and-retire, the new partial UNIQUE index
// (drizzle/0051), and the EXISTS-conditional INSERT all behave exactly as
// designed when exercised end to end, including genuinely interleaved
// "concurrent" requests (see the note on Promise.all below).
//
// What this does NOT prove: D1's own actual distributed-write behavior
// under real network-level concurrent requests against a live Cloudflare
// account. node:sqlite's DatabaseSync is a real, single-process SQLite
// engine with real transaction semantics (BEGIN IMMEDIATE/COMMIT/ROLLBACK,
// real UNIQUE constraint enforcement) -- but it is not literally D1, and
// no local tool here can submit two genuinely simultaneous network
// requests to the real fundraising-os-staging-db and observe the exact
// same interleaving. The Staging verification round (see
// docs/AI-HANDOFF.md) exercises the real HTTP route/API against real D1
// instead, sequentially -- this file is what proves the race itself is
// closed at the write boundary, not merely that a sequential call works.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);

const { env } = await import("./helpers/cloudflare-workers-shim.mjs");
const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const {
  attributeGivingActivityToTrip,
  listReconcilableTripAttributions,
  listTripFinancialAttributions,
  removeTripFinancialAttribution,
} = await import("../lib/relationships/trips-data.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
const USER_ID = "u1";
const DONOR_ID = "d1";
const TRIP_ID = "trip-1";
const PROSPECT_ID = "prospect-1";

// Sanity check, once: the new concurrency-guard index from drizzle/0051
// is really present in a database built the same way every test below
// builds one -- if this ever fails, every test below would be exercising
// a database state that doesn't match what Staging/Production will
// actually run.
{
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  const index = db.raw().prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = ?").get("trip_financial_attributions_active_reconciled_pending_uidx");
  assert.ok(index, "drizzle/0051's new concurrency-guard index must exist in a freshly-built database");
  assert.match(index.sql, /UNIQUE/i);
  assert.match(index.sql, /removed_at.*IS NULL/is);
}

function freshDatabaseWithBaseFixture() {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Jane Donor', ?, ?)").bind(DONOR_ID, USER_ID, NOW, NOW).run();
  db.prepare("INSERT INTO trips (id, owner_user_id, name, start_date, end_date, status, created_at, updated_at) VALUES (?, ?, 'Baltimore Trip', ?, ?, 'planning', ?, ?)").bind(TRIP_ID, USER_ID, NOW, NOW + 7 * 86400, NOW, NOW).run();
  db.prepare("INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, created_at, updated_at) VALUES (?, ?, ?, 'manual', 'meeting_completed', ?, ?)").bind(PROSPECT_ID, TRIP_ID, DONOR_ID, NOW, NOW).run();
  return db;
}

function seedPendingPledge(db, { id, committedCents }) {
  db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, 'Fundraising OS', ?, ?, ?, ?, 0, ?, 'Pending pledge', 'pending_pledge', 'live', 'active', '{}', ?, ?)`)
    .bind(id, USER_ID, DONOR_ID, id, id, NOW, committedCents, committedCents, NOW, NOW).run();
  const attributionId = `attr-${id}`;
  db.prepare("INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(attributionId, USER_ID, TRIP_ID, DONOR_ID, id, NOW).run();
  return attributionId;
}

function seedRealPledge(db, { id, committedCents, paidCents = 0, balanceCents }) {
  db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, ?, 'Pledge', 'open_pledge', 'live', 'active', '{}', ?, ?)`)
    .bind(id, USER_ID, DONOR_ID, id, NOW, committedCents, paidCents, balanceCents ?? committedCents - paidCents, NOW, NOW).run();
}

function activeAttributionRows(db) {
  return db.raw().prepare("SELECT id, giving_activity_id, removed_at, removed_reason, reconciled_pending_attribution_id FROM trip_financial_attributions WHERE trip_id = ? AND removed_at IS NULL ORDER BY giving_activity_id").all(TRIP_ID);
}

async function run() {
  // --- Two competing real records claiming the same pending entry. ---
  // Promise.all starts both calls together; each is an async function
  // with several `await` points (ownedProspect, the giving-activity
  // lookup, the shadow-of-attributed-pending check, the reconciliation-
  // candidates read) before it reaches its own write, so the two calls'
  // reads and writes genuinely interleave through the microtask queue
  // rather than one call simply finishing before the other starts. The
  // assertions below do not depend on which one happens to win --
  // exactly one of them must, and the resulting database state must
  // show the commitment counted exactly once either way, which is the
  // actual invariant this fix exists to guarantee regardless of timing.
  {
    const db = freshDatabaseWithBaseFixture();
    env.DB = db;
    const pendingAttrId = seedPendingPledge(db, { id: "pending-1", committedCents: 15_000_00 });
    seedRealPledge(db, { id: "real-a", committedCents: 15_000_00, balanceCents: 15_000_00 });
    seedRealPledge(db, { id: "real-b", committedCents: 15_000_00, balanceCents: 15_000_00 });

    const [resultA, resultB] = await Promise.all([
      attributeGivingActivityToTrip(USER_ID, TRIP_ID, PROSPECT_ID, "real-a", null, NOW, { reconcilesAttributionId: pendingAttrId }),
      attributeGivingActivityToTrip(USER_ID, TRIP_ID, PROSPECT_ID, "real-b", null, NOW, { reconcilesAttributionId: pendingAttrId }),
    ]);

    const results = [resultA, resultB];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    assert.equal(succeeded.length, 1, "exactly one of the two competing requests must succeed");
    assert.equal(failed.length, 1, "the other must fail, never silently succeed as a second, separate attribution");
    assert.equal(failed[0].reason, "reconciliation_target_not_found", "a losing competitor must report the target as no longer valid -- never 'already_attributed' (that reason means the GIVING ACTIVITY id collided, a different, unrelated case) and never a bare throw");

    // The real, decisive proof: query the actual resulting database
    // state, not the two function calls' own return values alone.
    const active = activeAttributionRows(db);
    assert.equal(active.length, 1, "exactly one active attribution must exist -- the pending entry was retired by exactly one winner, never left double-active or both-removed");
    assert.ok(active[0].giving_activity_id === "real-a" || active[0].giving_activity_id === "real-b", "the single surviving attribution must be one of the two real records, not some other state");
    assert.equal(active[0].reconciled_pending_attribution_id, pendingAttrId);

    const retired = db.raw().prepare("SELECT removed_at, removed_reason FROM trip_financial_attributions WHERE id = ?").get(pendingAttrId);
    assert.ok(retired.removed_at !== null, "the pending entry must be retired exactly once");
    assert.equal(retired.removed_reason, "Reconciled with JL-imported record");

    // The commitment counts EXACTLY once -- $15,000, never $0 and never
    // $30,000 -- read via the real listTripFinancialAttributions query.
    const attributions = await listTripFinancialAttributions(USER_ID, TRIP_ID);
    assert.equal(attributions.length, 1);
    assert.equal(attributions[0].committedCents, 15_000_00);

    // The loser's own real giving_activities row was never touched, and
    // no orphaned attribution row for it exists at all (the conditional
    // INSERT's EXISTS check means the loser's insert affected zero rows
    // -- nothing to clean up, nothing left dangling).
    const loserId = active[0].giving_activity_id === "real-a" ? "real-b" : "real-a";
    const loserAttribution = db.raw().prepare("SELECT COUNT(*) AS cnt FROM trip_financial_attributions WHERE giving_activity_id = ?").get(loserId);
    assert.equal(loserAttribution.cnt, 0, "the losing request must leave behind no attribution row of any kind, active or removed");
  }

  // --- A repeated request (e.g. a client retry of the exact same call)
  // must never duplicate the attribution or re-reconcile. ---
  {
    const db = freshDatabaseWithBaseFixture();
    env.DB = db;
    const pendingAttrId = seedPendingPledge(db, { id: "pending-2", committedCents: 8_000_00 });
    seedRealPledge(db, { id: "real-c", committedCents: 8_000_00, balanceCents: 8_000_00 });

    const first = await attributeGivingActivityToTrip(USER_ID, TRIP_ID, PROSPECT_ID, "real-c", null, NOW, { reconcilesAttributionId: pendingAttrId });
    assert.ok(first.ok, "the original request must succeed");
    const stateAfterFirst = activeAttributionRows(db);

    const second = await attributeGivingActivityToTrip(USER_ID, TRIP_ID, PROSPECT_ID, "real-c", null, NOW, { reconcilesAttributionId: pendingAttrId });
    assert.equal(second.ok, false, "a repeated/retried request must never succeed a second time");
    assert.equal(second.reason, "reconciliation_target_not_found", "retrying with the now-already-reconciled target must be rejected as a stale target, never silently re-processed");

    const stateAfterSecond = activeAttributionRows(db);
    assert.deepEqual(stateAfterSecond, stateAfterFirst, "the repeated request must leave attribution state byte-for-byte unchanged -- no duplicate row, no second retirement");
    const attributions = await listTripFinancialAttributions(USER_ID, TRIP_ID);
    assert.equal(attributions.length, 1, "totals must still reflect exactly one commitment after the repeated request");
    assert.equal(attributions[0].committedCents, 8_000_00);
  }

  // --- A stale reconciliation target: the caller explicitly names a
  // pending entry that has ALREADY disappeared (removed for an ordinary,
  // unrelated reason, not a competing reconciliation) by the time the
  // write runs. Candidates is now genuinely EMPTY for this donor+trip --
  // the call must still be rejected, never silently reinterpreted as "no
  // candidates, so this must be a separate commitment." ---
  {
    const db = freshDatabaseWithBaseFixture();
    env.DB = db;
    const pendingAttrId = seedPendingPledge(db, { id: "pending-3", committedCents: 4_000_00 });
    seedRealPledge(db, { id: "real-d", committedCents: 4_000_00, balanceCents: 4_000_00 });

    // An ordinary, unrelated removal (the ordinary "Remove attribution"
    // action) -- nothing to do with reconciliation at all.
    const removed = await removeTripFinancialAttribution(USER_ID, TRIP_ID, pendingAttrId, "Attributed by mistake", NOW);
    assert.ok(removed);

    const candidatesNow = await listReconcilableTripAttributions(USER_ID, TRIP_ID, DONOR_ID);
    assert.equal(candidatesNow.length, 0, "candidates must genuinely be empty now -- this test is only meaningful if that precondition holds");

    const stateBefore = activeAttributionRows(db);
    const result = await attributeGivingActivityToTrip(USER_ID, TRIP_ID, PROSPECT_ID, "real-d", null, NOW, { reconcilesAttributionId: pendingAttrId });
    assert.equal(result.ok, false, "an explicitly-named target that has disappeared must be rejected");
    assert.equal(result.reason, "reconciliation_target_not_found", "must never silently fall through to treating this as a separate, additional commitment just because the candidate list is now empty");

    const stateAfter = activeAttributionRows(db);
    assert.deepEqual(stateAfter, stateBefore, "a rejected stale-target request must leave attribution state completely unchanged");
    const attributions = await listTripFinancialAttributions(USER_ID, TRIP_ID);
    assert.equal(attributions.length, 0, "nothing must be attributed/counted as a result of the rejected call");
  }

  // --- A legitimate, explicitly separate commitment must still work
  // correctly even while an unrelated pending entry for the SAME donor
  // on the SAME trip remains active. ---
  {
    const db = freshDatabaseWithBaseFixture();
    env.DB = db;
    const pendingAttrId = seedPendingPledge(db, { id: "pending-4", committedCents: 6_000_00 });
    seedRealPledge(db, { id: "real-e", committedCents: 9_000_00, balanceCents: 9_000_00 });

    const result = await attributeGivingActivityToTrip(USER_ID, TRIP_ID, PROSPECT_ID, "real-e", null, NOW, { reconcilesAttributionId: "none" });
    assert.ok(result.ok, "an explicit, separate commitment must succeed even while a reconcilable candidate exists");

    const active = activeAttributionRows(db);
    assert.equal(active.length, 2, "both the untouched pending entry and the new, separate real attribution must be active");
    const newAttribution = active.find((row) => row.giving_activity_id === "real-e");
    assert.ok(newAttribution, "the new attribution must exist");
    assert.equal(newAttribution.reconciled_pending_attribution_id, null, "a deliberately separate commitment must never be recorded as reconciling anything");
    const pendingStillThere = active.find((row) => row.id === pendingAttrId);
    assert.ok(pendingStillThere, "the pre-existing pending entry must remain completely untouched -- still active, never retired");

    // Totals: the real $9,000 attribution counts; the still-pending
    // $6,000 one is reported separately as an unconfirmed opportunity by
    // summarizeTripFinancials (exercised directly here too, on the real
    // listTripFinancialAttributions output, for full-stack confidence).
    const { summarizeTripFinancials } = await import("../lib/relationships/trip-financial-attribution.ts");
    const attributions = await listTripFinancialAttributions(USER_ID, TRIP_ID);
    assert.equal(attributions.length, 2);
    const summary = summarizeTripFinancials(attributions, null);
    assert.equal(summary.newPledgesSecuredCents, 9_000_00, "only the real, separate pledge counts as a new commitment");
    assert.equal(summary.pendingOpportunitiesCents, 6_000_00, "the untouched pending entry remains excluded, exactly as before");
  }

  console.log("trip-reconciliation-concurrency.test.mjs: all assertions passed");
}

await run();
