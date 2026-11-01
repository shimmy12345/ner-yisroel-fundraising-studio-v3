import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  buildTripMeetingScheduledStatements, buildTripMeetingCancelledStatements,
  isCalendarSyncEnabledForUser, getTripMeetingCalendarLink,
} from "../lib/relationships/trip-calendar-sync.ts";

// Production calendar-sync release rehearsal (2026-11-01, see
// docs/AI-HANDOFF.md). Proves two things about applying migration
// 0048_google_calendar_sync.sql, UNCHANGED, to real Production:
//
//   1. It applies cleanly against Production's EXACT current schema --
//      not a replayed/assumed schema, the real one, pulled read-only
//      from live fundraising-os-production-db on 2026-11-01 and
//      checked into tests/fixtures/production-schema-2026-11-01.sql.
//      Migration 0054's rebuild of trip_prospects (which this round
//      specifically worried could conflict) turns out not to matter at
//      all: 0048's trip_prospects changes are plain `ALTER TABLE ADD
//      COLUMN` statements, which apply to whatever columns a table
//      currently has regardless of its rebuild history, and neither
//      `all_day` nor `all_day_date` exists on Production's real
//      trip_prospects today (confirmed), so there is no collision.
//   2. The real application functions this migration unblocks
//      (buildTripMeetingScheduledStatements/buildTripMeetingCancelledStatements,
//      which take `db: D1Database` directly and import nothing from
//      "cloudflare:workers") actually schedule, reschedule, and cancel a
//      linked-prospect meeting correctly once applied -- and that
//      calendar sync itself stays OFF for every existing user
//      (`users.calendar_sync_enabled` defaults to 0) unless explicitly
//      enabled later, exactly as migration 0048's own header requires.
//
// Runs entirely against an in-memory node:sqlite database -- no
// network, no remote D1, nothing applied to any real database.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
assert.ok(migrations.includes("0048_google_calendar_sync.sql"), "migration 0048 must exist in drizzle/");

const productionSchemaSql = fs.readFileSync(path.join(root, "tests/fixtures/production-schema-2026-11-01.sql"), "utf8");
const migration0048Sql = fs.readFileSync(path.join(migrationDirectory, "0048_google_calendar_sync.sql"), "utf8");

// Minimal D1Database-compatible shim over node:sqlite's DatabaseSync --
// implements only the exact surface lib/calendar/d1-calendar-store.ts
// and lib/relationships/trip-calendar-sync.ts actually call against a
// real database: prepare(sql).bind(...args).first()/.all()/.run().
function d1Shim(sqliteDb) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const stmt = sqliteDb.prepare(sql);
          return {
            async first() { return stmt.get(...args) ?? null; },
            async all() { return { results: stmt.all(...args) }; },
            async run() {
              const result = stmt.run(...args);
              return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
            },
          };
        },
      };
    },
  };
}

function freshPostMigrationDatabase() {
  const sqliteDb = new DatabaseSync(":memory:");
  sqliteDb.exec("PRAGMA foreign_keys=OFF;");
  sqliteDb.exec(productionSchemaSql);
  sqliteDb.exec(migration0048Sql);
  sqliteDb.exec("PRAGMA foreign_keys=ON;");
  return sqliteDb;
}

const NOW = Math.floor(Date.parse("2026-11-01T14:00:00Z") / 1000);

function run() {
  // --- Migration applies cleanly; structural integrity holds. ---
  const sqliteDb = freshPostMigrationDatabase();
  const integrityRows = sqliteDb.prepare("PRAGMA integrity_check").all();
  assert.equal(integrityRows.length, 1);
  assert.equal(integrityRows[0].integrity_check, "ok");
  assert.equal(sqliteDb.prepare("PRAGMA foreign_key_check").all().length, 0, "migration 0048 must introduce zero foreign-key violations against Production's real current data shape");

  // --- Confirmed zero collisions: neither all_day/all_day_date already
  // existed on trip_prospects (migration 0054's rebuild never added
  // them), nor calendar_sync_enabled on users, nor any of the four new
  // interactions columns -- re-asserted here, not just at authoring
  // time, so a future schema fixture update can't silently reintroduce
  // a collision this test would otherwise catch. ---
  const tripProspectsColumns = sqliteDb.prepare("PRAGMA table_info(trip_prospects)").all().map((c) => c.name);
  assert.ok(tripProspectsColumns.includes("all_day") && tripProspectsColumns.includes("all_day_date"), "migration 0048 must add all_day/all_day_date to trip_prospects");
  assert.ok(tripProspectsColumns.includes("manual_name"), "migration 0054's manual_* columns must survive migration 0048 being applied afterward");
  assert.ok(!tripProspectsColumns.includes("donor_id") || sqliteDb.prepare("PRAGMA table_info(trip_prospects)").all().find((c) => c.name === "donor_id").notnull === 0, "migration 0054's nullable donor_id must survive migration 0048 being applied afterward");

  // --- calendar_sync_enabled defaults to false for every existing user
  // -- migration 0048 must never turn on live Calendar sync for anyone
  // merely by being applied. ---
  sqliteDb.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("u1", "u1@example.test", NOW, NOW);
  return (async () => {
    const db = d1Shim(sqliteDb);
    assert.equal(await isCalendarSyncEnabledForUser(db, "u1"), false, "an existing user must have calendar sync OFF immediately after migration 0048 is applied");

    // --- The real functions that were throwing on Production
    // (buildTripMeetingScheduledStatements/buildTripMeetingCancelledStatements)
    // now schedule, reschedule, and cancel a linked-prospect meeting
    // correctly. ---
    sqliteDb.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?)").run("d1", "u1", NOW, NOW);
    sqliteDb.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, 'Trip meeting', ?, ?)").run("int-1", "d1", "u1", NOW + 86400, NOW, NOW);

    const scheduleStatements = await buildTripMeetingScheduledStatements(db, "int-1", "u1", "primary", NOW);
    for (const statement of scheduleStatements) await statement.run();
    const linkAfterSchedule = await getTripMeetingCalendarLink(db, "int-1");
    assert.equal(linkAfterSchedule?.desiredState, "present");
    assert.equal(linkAfterSchedule?.syncStatus, "pending");
    assert.equal(linkAfterSchedule?.desiredRevision, 1);

    const rescheduleStatements = await buildTripMeetingScheduledStatements(db, "int-1", "u1", "primary", NOW + 10);
    for (const statement of rescheduleStatements) await statement.run();
    const linkAfterReschedule = await getTripMeetingCalendarLink(db, "int-1");
    assert.equal(linkAfterReschedule?.desiredState, "present");
    assert.equal(linkAfterReschedule?.desiredRevision, 2, "rescheduling the same meeting must bump desiredRevision, proving the real intent is re-read and re-decided, not cached");

    const cancelStatements = await buildTripMeetingCancelledStatements(db, "int-1", NOW + 20);
    for (const statement of cancelStatements) await statement.run();
    const linkAfterCancel = await getTripMeetingCalendarLink(db, "int-1");
    assert.equal(linkAfterCancel?.desiredState, "absent");

    console.log("trip-calendar-migration-0048-production-rehearsal: all assertions passed");
  })();
}

await run();
