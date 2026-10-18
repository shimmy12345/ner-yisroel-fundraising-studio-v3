import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCalendarStore } from "../lib/calendar/testing/sqlite-calendar-store.ts";
import { enrollMeetingForSync, recordCancel, reconcilePresentAbsent } from "../lib/calendar/calendar-sync-reconciler.ts";
import { ScriptedCalendarClient, ok201, err404 } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Proves migration 0048's actual SQL schema -- not just the in-memory
// fake's own bookkeeping -- enforces the invariants the reconciler
// depends on: the UNIQUE(interaction_id) duplicate-prevention backstop,
// and the lease compare-and-swap via a real UPDATE ... WHERE clause. Runs
// against an isolated, in-memory node:sqlite database built from every
// real committed migration in order (same convention as
// tests/trip-prospect-selection-schema.test.mjs) -- no network, no
// Workers runtime, nothing applied to any remote D1 database.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
assert.ok(migrations.includes("0048_google_calendar_sync.sql"), "migration 0048 must exist in drizzle/");

function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return db;
}

const NOW = Math.floor(Date.parse("2026-10-18T14:00:00Z") / 1000);

function seedInteraction(db, { id = "int-1", userId = "u1", donorId = "d1" } = {}) {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?)").run(donorId, userId, NOW, NOW);
  db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, 'Meeting', ?, ?)").run(id, donorId, userId, NOW + 86400, NOW, NOW);
  return { id, userId, donorId };
}

async function run() {
  // --- Schema structurally present, matching the design doc exactly ---
  {
    const db = freshDatabase();
    const linkColumns = db.prepare("PRAGMA table_info(calendar_event_links)").all().map((c) => c.name);
    for (const expected of ["interaction_id", "generation", "google_event_id", "desired_state", "desired_revision", "synced_revision", "sync_status", "lease_owner", "lease_expires_at"]) {
      assert.ok(linkColumns.includes(expected), `calendar_event_links must have column ${expected}`);
    }
    const uniqueIndexes = db.prepare("PRAGMA index_list(calendar_event_links)").all().filter((i) => i.unique).map((i) => i.name);
    assert.ok(uniqueIndexes.includes("calendar_event_links_interaction_uidx"));
    const interactionColumns = db.prepare("PRAGMA table_info(interactions)").all().map((c) => c.name);
    for (const expected of ["all_day", "all_day_date", "end_at", "location"]) assert.ok(interactionColumns.includes(expected), `interactions must have new column ${expected}`);
    const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    assert.ok(userColumns.includes("calendar_sync_enabled"));
  }

  // --- The real duplicate-prevention backstop: UNIQUE(interaction_id) ---
  {
    const db = freshDatabase();
    const { id: interactionId, userId } = seedInteraction(db);
    const store = new SqliteCalendarStore(db);
    const first = await store.insertLink({ id: "link-1", interactionId, userId, googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null }, NOW);
    assert.ok(first, "the first insert for a meeting must succeed");
    const second = await store.insertLink({ id: "link-2", interactionId, userId, googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null }, NOW);
    assert.equal(second, null, "a second link row for the SAME interaction must be rejected by the real UNIQUE(interaction_id) index, not merely by an application-level check");
    const rowCount = db.prepare("SELECT COUNT(*) AS n FROM calendar_event_links WHERE interaction_id = ?").get(interactionId).n;
    assert.equal(rowCount, 1, "exactly one link row must exist, enforced by the schema itself");
  }

  // --- The lease CAS is a real SQL UPDATE ... WHERE, not app-level bookkeeping ---
  {
    const db = freshDatabase();
    const { id: interactionId, userId } = seedInteraction(db);
    const store = new SqliteCalendarStore(db);
    const link = await store.insertLink({ id: "link-1", interactionId, userId, googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null }, NOW);

    const acquiredA = await store.acquireLease(link.id, "worker-A", NOW, 60);
    assert.equal(acquiredA, true);
    const acquiredB = await store.acquireLease(link.id, "worker-B", NOW, 60);
    assert.equal(acquiredB, false, "a second lease acquisition while the first is still valid must fail -- the real SQL WHERE clause, not a race-prone read-then-write in application code");

    // Worker B's write (which never held the lease) must be rejected by
    // the real WHERE lease_owner = ? clause.
    const stolenWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-B", { syncStatus: "synced" });
    assert.equal(stolenWrite, false);
    const stillPending = await store.getLinkById(link.id);
    assert.equal(stillPending.syncStatus, "pending", "a non-lease-holder's write must never land, enforced by the SQL itself");

    // The real lease holder's release and a subsequent acquisition by a
    // new worker both work correctly via real SQL.
    const released = await store.releaseLease(link.id, "worker-A");
    assert.equal(released, true);
    const acquiredAfterRelease = await store.acquireLease(link.id, "worker-B", NOW, 60);
    assert.equal(acquiredAfterRelease, true);

    // A STALE worker (A, which already released) must not be able to
    // clear B's now-active lease.
    const staleRelease = await store.releaseLease(link.id, "worker-A");
    assert.equal(staleRelease, false, "a stale worker must never be able to clear a different, current lease holder's lease");
    const stillHeldByB = await store.getLinkById(link.id);
    assert.equal(stillHeldByB.leaseOwner, "worker-B");

    // Lease expiry via real time comparison in SQL.
    const acquiredWhileHeld = await store.acquireLease(link.id, "worker-C", NOW + 10, 60);
    assert.equal(acquiredWhileHeld, false, "an unexpired lease must still block a new acquisition");
    const acquiredAfterExpiry = await store.acquireLease(link.id, "worker-C", NOW + 1000, 60);
    assert.equal(acquiredAfterExpiry, true, "an expired lease must allow a new acquisition, via a real time comparison in the WHERE clause");
  }

  // --- writeIntent is unconditional -- succeeds regardless of lease state ---
  {
    const db = freshDatabase();
    const { id: interactionId, userId } = seedInteraction(db);
    const store = new SqliteCalendarStore(db);
    const link = await store.insertLink({ id: "link-1", interactionId, userId, googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null }, NOW);
    await store.acquireLease(link.id, "some-other-worker", NOW, 600); // long-held lease by someone else
    const ok = await store.writeIntent(link.id, { desiredRevision: 2, updatedAt: NOW + 1 });
    assert.equal(ok, true, "a durable intent write (reschedule/cancel) must succeed even while a sync attempt holds the lease");
    const after = await store.getLinkById(link.id);
    assert.equal(after.desiredRevision, 2);
  }

  // --- End-to-end: a full reconcile cycle against the REAL sqlite-backed store ---
  {
    const db = freshDatabase();
    const { id: interactionId, userId } = seedInteraction(db);
    const store = new SqliteCalendarStore(db);
    const client = new ScriptedCalendarClient();
    const getFields = async () => ({ interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1" });

    await enrollMeetingForSync(store, NOW, { interactionId, userId, googleCalendarId: "primary" });
    const eventId = deriveGoogleEventId(interactionId, 0);
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "worker-1", NOW + 1);
    assert.equal(outcome.kind, "synced");

    const link = await store.getLinkByInteraction(interactionId);
    assert.equal(link.syncStatus, "synced");
    assert.equal(link.syncedRevision, 1);
    assert.equal(link.leaseOwner, null, "the lease must be released in real SQL at the end of a real persistence-backed reconcile");

    // Cancel, and confirm it's durably recorded even against the real store.
    await recordCancel(store, NOW + 2, interactionId);
    const afterCancel = await store.getLinkByInteraction(interactionId);
    assert.equal(afterCancel.desiredState, "absent");
    const history = await store.getHistory(link.id, 0);
    assert.equal(history.cleanupNeeded, true);
  }

  process.stdout.write("calendar-sync-sqlite-store.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
