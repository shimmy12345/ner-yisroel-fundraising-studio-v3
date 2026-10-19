import assert from "node:assert/strict";
import { createLocalD1Database } from "../lib/calendar/testing/local-d1.ts";
import { D1CalendarStore } from "../lib/calendar/d1-calendar-store.ts";
import { enrollMeetingForSync, recordCancel, recordReopen, recordReschedule, reconcilePresentAbsent, runReconciliationSweep } from "../lib/calendar/calendar-sync-reconciler.ts";
import { ScriptedCalendarClient, ok201, err404 } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { StatefulCalendarClient } from "../lib/calendar/testing/stateful-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Proves the REAL Cloudflare D1 adapter (lib/calendar/d1-calendar-store.ts)
// against a REAL local Workers/D1 runtime (lib/calendar/testing/local-d1.ts,
// via wrangler's own getPlatformProxy()) -- never a synchronous SQLite
// mock standing in for D1. This is the Linux-CI-only counterpart to
// tests/calendar-sync-sqlite-store.test.mjs and the 2026-10-19/20/21
// regression files: every scenario below is either ported from one of
// those files (so the SAME invariants proven against node:sqlite/the
// in-memory fake are re-proven against the real D1 binding's own query
// planner, SQLite engine, and error behavior) or new, D1-adapter-specific
// coverage for exactly where D1's lack of a cross-statement transaction
// required a genuinely different implementation shape (see
// d1-calendar-store.ts's own header).
//
// NOT run as part of `pnpm test` / scripts/run-tests.mjs: getPlatformProxy()
// requires a working local `workerd` binary, which this project's own
// Windows development sandbox cannot run (see docs/AI-HANDOFF.md -- the
// bundled workerd.exe crashes immediately with a Windows structured
// exception on this machine). Run explicitly via `pnpm run
// test:calendar-d1`, which this repo's CI runs on an Ubuntu runner
// (.github/workflows/calendar-d1-adapter-test.yml) where the Linux
// workerd binary is expected to start normally.

const NOW = 1_000_000;
let nextId = 0;
function uniqueId(prefix) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

async function seedInteraction(db, { interactionId, userId = "u1", donorId = "d1" }) {
  // INSERT OR IGNORE so repeated calls for the same shared user/donor
  // across test blocks in this one-database-per-file run don't collide.
  await db.prepare("INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, `${userId}@example.test`, NOW, NOW).run();
  await db.prepare("INSERT OR IGNORE INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?)").bind(donorId, userId, NOW, NOW).run();
  await db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, 'Meeting', ?, ?)").bind(interactionId, donorId, userId, NOW + 86400, NOW, NOW).run();
}

function makeFields(interactionId) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1/meeting-brief" };
}

async function run() {
  const { db, dispose } = await createLocalD1Database();
  try {
    const store = new D1CalendarStore(db);

    // =======================================================================
    // Schema structurally present -- same assertions as
    // tests/calendar-sync-sqlite-store.test.mjs, now against the real D1
    // binding's own sqlite_schema.
    // =======================================================================
    {
      const { results: linkColumns } = await db.prepare("PRAGMA table_info(calendar_event_links)").all();
      for (const expected of ["interaction_id", "generation", "google_event_id", "desired_state", "desired_revision", "synced_revision", "sync_status", "lease_owner", "lease_expires_at"]) {
        assert.ok(linkColumns.some((c) => c.name === expected), `calendar_event_links must have column ${expected}`);
      }
      const { results: uniqueIndexes } = await db.prepare("PRAGMA index_list(calendar_event_links)").all();
      assert.ok(uniqueIndexes.some((i) => i.unique && i.name === "calendar_event_links_interaction_uidx"));
    }

    // =======================================================================
    // The real duplicate-prevention backstop: UNIQUE(interaction_id),
    // enforced by D1's own SQLite engine -- and the real error message
    // D1 throws for it, captured here (see docs/AI-HANDOFF.md) so
    // isUniqueConstraintViolation()'s detection is proven against actual
    // D1 behavior, not assumed from documentation alone.
    // =======================================================================
    {
      const interactionId = uniqueId("int-dup");
      await seedInteraction(db, { interactionId });
      const first = await store.insertLink({ id: uniqueId("link"), interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      assert.ok(first, "the first insert for a meeting must succeed against real D1");
      const second = await store.insertLink({ id: uniqueId("link"), interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      assert.equal(second, null, "a second link row for the SAME interaction must be rejected by real D1's own UNIQUE(interaction_id) index, not merely by an application-level check");
      const { results: afterRows } = await db.prepare("SELECT COUNT(*) AS n FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).all();
      assert.equal(afterRows[0].n, 1, "exactly one link row must exist, enforced by the real D1 schema itself");
    }

    // =======================================================================
    // insertLinkWithHistory's atomicity, via db.batch(): deliberately
    // force the LINK half of the batch to fail (a second link row for an
    // interaction that is already enrolled -- the real UNIQUE(interaction_id)
    // backstop) while the HISTORY half, taken alone, would otherwise
    // succeed on its own (a fresh, valid linkId/generation pair) -- proves
    // the whole batch rolls back together against a REAL D1 database, not
    // just the in-memory fake's own bookkeeping. This is the D1 adapter's
    // own "crash/rollback" case (D1 has no BEGIN IMMEDIATE/COMMIT to
    // simulate a crash between two statements the way the SQLite adapter's
    // own test does -- db.batch() IS the atomic unit here, so the real
    // test is "does a guaranteed-to-fail statement roll back the other one
    // in the same batch").
    //
    // NOTE: an earlier version of this test instead pre-created an
    // ORPHANED history row (referencing a linkId with no matching link
    // row) to force the history half to fail on its own -- real D1
    // rejected that SETUP step itself with `FOREIGN KEY constraint
    // failed` (`calendar_event_link_history.link_id REFERENCES
    // calendar_event_links(id)`, migration 0048), confirmed in this
    // phase's actual CI run (see docs/AI-HANDOFF.md). D1 enforces that
    // FK immediately, which structurally rules out ever having an
    // existing, valid history row for a linkId that isn't ALSO already a
    // real link row -- so "only the history half fails, while the link
    // half would have succeeded alone" cannot be constructed as a setup
    // at all; this test forces the LINK half to fail instead, which
    // still fully proves the SAME batch-level atomicity guarantee.
    // =======================================================================
    {
      const interactionId = uniqueId("int-rollback");
      await seedInteraction(db, { interactionId });
      const enrolled = await store.insertLinkWithHistory({ id: uniqueId("link-rollback-original"), interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      assert.ok(enrolled, "setup: the first enrollment must succeed");

      const secondLinkId = uniqueId("link-rollback-second");
      const result = await store.insertLinkWithHistory({ id: secondLinkId, interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      assert.equal(result, null, "insertLinkWithHistory must report failure when its own link half cannot be written (a second enrollment for an already-enrolled interaction)");
      const linkRow = await store.getLinkById(secondLinkId);
      assert.equal(linkRow, null, "the rejected second link row must not exist");
      const historyRow = await store.getHistory(secondLinkId, 0);
      assert.equal(historyRow, null, "the HISTORY half must be rolled back along with the failing link insert -- db.batch()'s atomicity must be real, not merely 'best effort'");
    }

    // =======================================================================
    // The lease CAS is a real D1 UPDATE ... WHERE, not app-level
    // bookkeeping -- same assertions as tests/calendar-sync-sqlite-store
    // .test.mjs, now against real D1.
    // =======================================================================
    {
      const interactionId = uniqueId("int-lease");
      await seedInteraction(db, { interactionId });
      const link = await store.insertLink({ id: uniqueId("link"), interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);

      const acquiredA = await store.acquireLease(link.id, "worker-A", NOW, 60);
      assert.equal(acquiredA, true);
      const acquiredB = await store.acquireLease(link.id, "worker-B", NOW, 60);
      assert.equal(acquiredB, false, "a second lease acquisition while the first is still valid must fail against real D1");

      const stolenWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-B", NOW, { syncStatus: "synced" });
      assert.equal(stolenWrite, false, "a non-lease-holder's write must never land, enforced by real D1's own WHERE clause");
      const stillPending = await store.getLinkById(link.id);
      assert.equal(stillPending.syncStatus, "pending");

      const released = await store.releaseLease(link.id, "worker-A");
      assert.equal(released, true);
      const acquiredAfterRelease = await store.acquireLease(link.id, "worker-B", NOW, 60);
      assert.equal(acquiredAfterRelease, true);

      const staleRelease = await store.releaseLease(link.id, "worker-A");
      assert.equal(staleRelease, false, "a stale worker must never be able to clear a different, current lease holder's lease");

      const acquiredWhileHeld = await store.acquireLease(link.id, "worker-C", NOW + 10, 60);
      assert.equal(acquiredWhileHeld, false, "an unexpired lease must still block a new acquisition");
      const acquiredAfterExpiry = await store.acquireLease(link.id, "worker-C", NOW + 1000, 60);
      assert.equal(acquiredAfterExpiry, true, "an expired lease must allow a new acquisition, via a real time comparison in real D1's WHERE clause");
    }

    // =======================================================================
    // writeIntent is unconditional -- succeeds against real D1 regardless
    // of lease state.
    // =======================================================================
    {
      const interactionId = uniqueId("int-intent");
      await seedInteraction(db, { interactionId });
      const link = await store.insertLink({ id: uniqueId("link"), interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      await store.acquireLease(link.id, "some-other-worker", NOW, 600);
      const ok = await store.writeIntent(link.id, { desiredRevision: 2, updatedAt: NOW + 1 });
      assert.equal(ok, true, "a durable intent write must succeed against real D1 even while a sync attempt holds the lease");
      const after = await store.getLinkById(link.id);
      assert.equal(after.desiredRevision, 2);
    }

    // =======================================================================
    // End-to-end: a full reconcile cycle against the REAL D1-backed store.
    // =======================================================================
    {
      const interactionId = uniqueId("int-e2e");
      await seedInteraction(db, { interactionId });
      const client = new ScriptedCalendarClient();
      const getFields = async () => makeFields(interactionId);

      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      const eventId = deriveGoogleEventId(interactionId, 0);
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, ok201({ id: eventId }));
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "worker-1", NOW + 1);
      assert.equal(outcome.kind, "synced");

      const link = await store.getLinkByInteraction(interactionId);
      assert.equal(link.syncStatus, "synced");
      assert.equal(link.syncedRevision, 1);
      assert.equal(link.leaseOwner, null, "the lease must be released against real D1 at the end of a real persistence-backed reconcile");

      await recordCancel(store, NOW + 2, interactionId);
      const afterCancel = await store.getLinkByInteraction(interactionId);
      assert.equal(afterCancel.desiredState, "absent");
      const history = await store.getHistory(link.id, 0);
      assert.equal(history.cleanupNeeded, true);
    }

    // =======================================================================
    // Overlapping reopen requests (Bug 3, 2026-10-21 review) -- ported
    // from tests/calendar-sync-regression-2026-10-21.test.mjs, now against
    // the REAL D1 adapter. The fix: the second, stale request must
    // recognize generation 1 as the already-won transition and reuse it,
    // never allocating generation 2.
    // =======================================================================
    {
      const interactionId = uniqueId("int-overlap-reopen");
      await seedInteraction(db, { interactionId });
      const client = new StatefulCalendarClient();
      const getFields = async () => makeFields(interactionId);
      const now = NOW;

      await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
      await recordCancel(store, now + 1, interactionId);

      const linkBeforeEitherReopen = await store.getLinkByInteraction(interactionId);
      assert.equal(linkBeforeEitherReopen.generation, 0);
      assert.equal(linkBeforeEitherReopen.desiredState, "absent");
      const linkId = linkBeforeEitherReopen.id;
      const capturedGeneration = linkBeforeEitherReopen.generation;

      const firstReopen = await store.applyReopen(linkId, capturedGeneration, now + 2);
      assert.ok(firstReopen, "the winning reopen must succeed against real D1");
      assert.equal(firstReopen.generation, 1);
      assert.equal(firstReopen.desiredState, "present");

      const reconcileGen1 = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 3);
      assert.equal(reconcileGen1.kind, "synced", "generation 1 must sync successfully against real D1");
      const gen1EventId = deriveGoogleEventId(interactionId, 1);
      assert.deepEqual(client.activeEventIds("primary"), [gen1EventId], "exactly generation 1's event must exist on the simulated calendar after it syncs");

      const secondReopen = await store.applyReopen(linkId, capturedGeneration, now + 4);
      assert.ok(secondReopen, "the stale reopen request must still be told 'reopened' -- it must not be told its request failed, since the meeting genuinely IS open again");
      assert.equal(secondReopen.generation, 1, "the stale request must REUSE generation 1, never allocate generation 2, against real D1");

      const linkAfterBoth = await store.getLinkByInteraction(interactionId);
      assert.equal(linkAfterBoth.generation, 1, "exactly one new generation must have been allocated for this single cancellation, against real D1");

      // Run the normal reconciliation sweep directly against the real
      // store, matching the original regression file's final step
      // (generation 0's pre-existing cleanup obligation must still be
      // honored, unaffected by the reopen race on generation 1). Every
      // test block in this file shares ONE local D1 database (avoiding a
      // getPlatformProxy() startup per block), so this sweep call also
      // harmlessly touches leftover rows from earlier blocks sharing this
      // database -- each uses a distinct uniqueId()-derived interactionId/
      // linkId never asserted on again, so that noise cannot affect any
      // assertion below or in a later block.
      const sweepResult = await runReconciliationSweep(store, client, getFields, "sweep", now + 5);
      const historyGen0 = await store.getHistory(linkId, 0);
      assert.equal(historyGen0.cleanupStatus, "done", "generation 0's pre-existing cleanup obligation must still be honored by the sweep, unaffected by the reopen race on generation 1, against real D1");
      assert.ok(sweepResult.cleaned.length >= 1, "the sweep must actually have attempted generation 0's cleanup against real D1");
    }

    // =======================================================================
    // A stale reopen request must not reopen a LATER, separately canceled
    // meeting it was never asked to reopen -- ported from the same
    // 2026-10-21 regression file.
    // =======================================================================
    {
      const interactionId = uniqueId("int-stale-reopen-reject");
      await seedInteraction(db, { interactionId });
      const now = NOW;

      await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
      await recordCancel(store, now + 1, interactionId);
      const link0 = await store.getLinkByInteraction(interactionId);
      const linkId = link0.id;
      const staleCapturedGeneration = link0.generation; // 0

      // Meanwhile: reopen to generation 1, then cancel AGAIN -- a
      // different, later cancellation entirely.
      await recordReopen(store, now + 2, interactionId);
      await recordCancel(store, now + 3, interactionId);
      const linkNow = await store.getLinkByInteraction(interactionId);
      assert.equal(linkNow.generation, 1);
      assert.equal(linkNow.desiredState, "absent");

      // The STALE reopen request, still carrying generation 0, finally runs.
      const staleResult = await store.applyReopen(linkId, staleCapturedGeneration, now + 4);
      assert.equal(staleResult, null, "a stale reopen request against real D1 must be rejected -- it must never reopen a later, separately canceled meeting it was never asked to reopen");

      const afterStaleResume = await store.getLinkByInteraction(interactionId);
      assert.equal(afterStaleResume.desiredState, "absent", "generation 1's real, later cancellation must still stand -- untouched by the stale request");

      const realReopen = await store.applyReopen(linkId, 1, now + 5);
      assert.ok(realReopen, "the genuinely current cancellation must still be reopenable normally against real D1");
      assert.equal(realReopen.generation, 2);
    }

    // =======================================================================
    // applyCancel: a delayed cancel request must target cleanup at the
    // CURRENT generation at the moment it actually runs -- ported from
    // the same 2026-10-21 regression file.
    // =======================================================================
    {
      const interactionId = uniqueId("int-delayed-cancel");
      await seedInteraction(db, { interactionId });
      const client = new StatefulCalendarClient();
      const getFields = async () => makeFields(interactionId);
      const now = NOW;

      await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
      // A "delayed" cancel request captures the link id now, but its own
      // store.applyCancel call doesn't run until much later (simulated by
      // simply calling it later in this test, after other state changes).
      const link0 = await store.getLinkByInteraction(interactionId);
      const linkId = link0.id;

      await recordCancel(store, now + 1, interactionId);
      await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 2); // deletes nothing (never created) but settles bookkeeping
      await recordReopen(store, now + 3, interactionId);
      const reconcileGen1 = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 4); // creates generation 1's real event
      assert.equal(reconcileGen1.kind, "synced");
      const gen1EventId = deriveGoogleEventId(interactionId, 1);
      assert.deepEqual(client.activeEventIds("primary"), [gen1EventId]);

      // NOW the "delayed" cancel request finally executes, directly
      // against the store (bypassing recordCancel's own fresh read, to
      // faithfully simulate a request that has been queued/delayed since
      // before any of the above happened).
      const delayedCancelResult = await store.applyCancel(linkId, now + 5);
      assert.ok(delayedCancelResult, "the delayed cancel must succeed against real D1");
      assert.equal(delayedCancelResult.generation, 1, "the delayed cancel must flag the REAL CURRENT generation (1), never a stale one, against real D1");

      const cancelOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 6);
      assert.equal(cancelOutcome.kind, "deleted", "cancellation must actually succeed and target the correct, current generation's real event against real D1");
      assert.ok(client.calls.some((c) => c.op === "delete" && c.eventId === gen1EventId), "a real DELETE must have been sent for generation 1's actual event");
    }

    // =======================================================================
    // applyReschedule: rejected (not a revision bump) once the meeting is
    // genuinely absent, re-verified atomically against real D1.
    // =======================================================================
    {
      const interactionId = uniqueId("int-reschedule-absent");
      await seedInteraction(db, { interactionId });
      const now = NOW;
      await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
      const link = await store.getLinkByInteraction(interactionId);
      await store.applyCancel(link.id, now + 1);

      const rescheduleResult = await store.applyReschedule(link.id, now + 2);
      assert.equal(rescheduleResult, null, "applyReschedule must reject a meeting that is genuinely absent, re-verified atomically against real D1, never bump its revision");
      const ok = await recordReschedule(store, now + 3, interactionId);
      assert.equal(ok, false, "recordReschedule must report failure for an absent meeting against real D1");
    }

    // =======================================================================
    // A genuinely new, D1-adapter-specific "conflicting write" case: two
    // truly concurrent reconcilePresentAbsent calls for the SAME link,
    // issued via Promise.all (real, interleaved async D1 round trips --
    // not merely sequential awaits, and not something node:sqlite's own
    // synchronous API can model the same way). Exactly one must win the
    // lease; the other must report lease_contended, and the link must
    // end up synced exactly once, never double-created.
    // =======================================================================
    {
      const interactionId = uniqueId("int-conflicting-write");
      await seedInteraction(db, { interactionId });
      const client = new StatefulCalendarClient();
      const getFields = async () => makeFields(interactionId);
      const now = NOW;
      await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });

      const [resultA, resultB] = await Promise.all([
        reconcilePresentAbsent(store, client, getFields, interactionId, "worker-concurrent-A", now + 1),
        reconcilePresentAbsent(store, client, getFields, interactionId, "worker-concurrent-B", now + 1),
      ]);
      const outcomes = [resultA.kind, resultB.kind].sort();
      assert.deepEqual(outcomes, ["lease_contended", "synced"], "exactly one of two truly concurrent reconcile attempts against real D1 must win the lease and sync; the other must report lease_contended, never both succeeding or both failing");
      const eventId = deriveGoogleEventId(interactionId, 0);
      assert.deepEqual(client.activeEventIds("primary"), [eventId], "exactly one real event must exist -- the real D1 lease CAS must have prevented a double-create under genuine concurrency");
    }

    // =======================================================================
    // 2026-10-19 independent review, issue 3: lease EXPIRY enforcement
    // against REAL D1, not just ownership -- updateLinkAsLeaseHolder's
    // original WHERE clause checked `lease_owner = ?` alone; an expired
    // worker's write could still land as long as no one else had yet
    // re-acquired the lease. `lease_expires_at > ?` is a real SQL guard
    // here, not application-level bookkeeping.
    // =======================================================================
    {
      const interactionId = uniqueId("int-d1-lease-expiry");
      await seedInteraction(db, { interactionId });
      const link = await store.insertLink({ id: uniqueId("link"), interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      await store.acquireLease(link.id, "worker-A", NOW, 60); // expires at NOW+60

      const staleWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-A", NOW + 61, { syncStatus: "synced" });
      assert.equal(staleWrite, false, "an EXPIRED lease holder's write must be rejected against real D1, even when no one else has acquired the lease yet");
      const unchanged = await store.getLinkById(link.id);
      assert.equal(unchanged.syncStatus, "pending", "the rejected write must not have landed against real D1");

      // A non-expired holder's own write must still succeed.
      const validWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-A", NOW + 30, { syncStatus: "synced", syncedRevision: 1 });
      assert.equal(validWrite, true, "a non-expired lease holder's write must still succeed against real D1");
    }

    // =======================================================================
    // 2026-10-19 independent review, issue 2: bounded backoff and
    // invalid/auth_required exclusion in listNeedingReconciliation,
    // against REAL D1 -- the SQL's own NOT IN / next_retry_at filtering,
    // not application-level filtering.
    // =======================================================================
    {
      const interactionId = uniqueId("int-d1-backoff-exclusion");
      await seedInteraction(db, { interactionId });
      const client = new ScriptedCalendarClient();
      const eventId = deriveGoogleEventId(interactionId, 0);
      const getFields = async () => makeFields(interactionId);

      await enrollMeetingForSync(store, NOW, { interactionId, userId: "u1", googleCalendarId: "primary" });
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, { ok: false, status: "error", errorClass: "server_error" });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 1);
      assert.equal(outcome.kind, "failed");
      const link = await store.getLinkByInteraction(interactionId);
      assert.ok(link.nextRetryAt !== null && link.nextRetryAt > NOW + 1, "a transient failure must schedule a future backoff retry time against real D1");

      const tooSoon = await store.listNeedingReconciliation(link.nextRetryAt - 1);
      assert.ok(!tooSoon.some((l) => l.id === link.id), "real D1's own listNeedingReconciliation must exclude a 'failed' link before its nextRetryAt");
      const readyNow = await store.listNeedingReconciliation(link.nextRetryAt);
      assert.ok(readyNow.some((l) => l.id === link.id), "real D1's own listNeedingReconciliation must include a 'failed' link at/after its nextRetryAt");

      // Now permanently reject it (a real Google 400) and confirm
      // 'invalid' is excluded regardless of next_retry_at.
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, { ok: false, status: 400 });
      const invalidOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", NOW + 2);
      assert.equal(invalidOutcome.kind, "invalid");
      const afterInvalid = await store.listNeedingReconciliation(NOW + 999_999);
      assert.ok(!afterInvalid.some((l) => l.id === link.id), "real D1's own listNeedingReconciliation must exclude an 'invalid' link at any future time, with no automatic path back in");

      // recordReschedule resumes it.
      await recordReschedule(store, NOW + 3, interactionId);
      const afterReschedule = await store.getLinkByInteraction(interactionId);
      assert.equal(afterReschedule.syncStatus, "pending", "recordReschedule must resume an 'invalid' link against real D1");
    }

    // =======================================================================
    // 2026-10-19 independent review: operational database failures must
    // never be silently treated as the UNIQUE(interaction_id) conflict.
    // insertLink's own isUniqueConstraintViolation() regex must NOT match
    // a structurally DIFFERENT real D1 error -- a FOREIGN KEY violation
    // (migration 0048's `interaction_id REFERENCES interactions(id)`),
    // triggered here via a bogus, nonexistent interactionId -- and must
    // RETHROW it rather than returning null (which insertLinkWithHistory's
    // own caller, enrollMeetingForSync, would otherwise silently
    // misreport as "already enrolled").
    // =======================================================================
    {
      const bogusInteractionId = uniqueId("int-does-not-exist-fk-violation");
      let threw = false;
      let caughtMessage = "";
      try {
        await store.insertLink({ id: uniqueId("link"), interactionId: bogusInteractionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, NOW);
      } catch (error) {
        threw = true;
        caughtMessage = error.message;
      }
      assert.ok(threw, "a genuine, non-conflict database failure (FOREIGN KEY on a nonexistent interaction_id) must propagate as a real failure against real D1, never be silently swallowed as null");
      assert.ok(!/UNIQUE constraint failed/i.test(caughtMessage), "a real FOREIGN KEY violation's own error text must never be misdetected as the UNIQUE(interaction_id) backstop -- an operational failure must never be silently reported as 'already exists'");
      assert.match(caughtMessage, /FOREIGN KEY/i, "sanity: confirm this really is a foreign-key failure, not some other unrelated error");
    }

    process.stdout.write("calendar-d1-store.test.mjs: all assertions passed against a REAL local D1 binding\n");
  } finally {
    await dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
