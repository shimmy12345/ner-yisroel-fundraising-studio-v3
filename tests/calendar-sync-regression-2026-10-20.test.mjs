import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enrollMeetingForSync, recordCancel, recordReopen, reconcilePresentAbsent, reconcileGenerationCleanup } from "../lib/calendar/calendar-sync-reconciler.ts";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { SqliteCalendarStore } from "../lib/calendar/testing/sqlite-calendar-store.ts";
import { ScriptedCalendarClient, ok201, ok204, err404 } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Regression tests for Bug 2 of the 2026-10-20 independent review of
// commit 1fdba7d: "a crash between link creation and history creation
// leaves an unrecoverable enrollment." Reproduced against the PUBLIC
// store primitives (insertLink/insertHistory remain separate methods on
// the interface for exactly this reason -- to let a test simulate a
// pre-existing inconsistency from any cause, not only this module's own
// code path) and the public reconciler entry points, never by manually
// calling an internal helper to force the fix's own effect.

function makeFields(interactionId) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1/meeting-brief" };
}

const migrationDir = path.join(path.resolve(import.meta.dirname, ".."), "drizzle");
const migrations = fs.readdirSync(migrationDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshSqliteStore(interactionId) {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(fs.readFileSync(path.join(migrationDir, migration), "utf8"));
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', 1000, 1000)").run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Test Donor', 1000, 1000)").run();
  db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, 'd1', 'u1', 'meeting', 86400, 'Meeting', 1000, 1000)").run(interactionId);
  return { store: new SqliteCalendarStore(db), db };
}

// Simulates "a crash/error in insertHistory before generation 0's history
// exists" by calling the store's own lower-level insertLink primitive
// directly and deliberately skipping insertHistory -- this is pre-
// existing-inconsistency SETUP, not a call into any code path under test.
async function simulateCrashedEnrollment(store, now, { id, interactionId, userId = "u1", googleCalendarId = "primary" }) {
  const link = await store.insertLink({ id, interactionId, userId, googleCalendarId, generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, now);
  assert.ok(link, "setup: the link insert itself must succeed");
  const historyBeforeRepair = await store.getHistory(id, 0);
  assert.equal(historyBeforeRepair, null, "setup: confirm the simulated crash genuinely left no history row");
  return link;
}

async function run() {
  // =========================================================================
  // Exact reproduction, via retry-enrollment's own repair path, through to
  // eventual cancellation -- proven against BOTH stores.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", async () => ({ store: new InMemoryCalendarStore() })], ["sqlite", async () => freshSqliteStore("int-crash-enroll")]]) {
    const { store } = await makeStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    const interactionId = "int-crash-enroll";
    const linkId = "link-crash-enroll";
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);

    // 1. "enrollMeetingForSync inserts calendar_event_links." 2. "Simulate
    // a crash/error in insertHistory before generation 0's history
    // exists."
    await simulateCrashedEnrollment(store, now, { id: linkId, interactionId });

    // 3. "Retry enrollment: the existing link makes it return null,
    // without repairing history" -- THE FIX: it still returns null (the
    // interaction really was already enrolled), but now repairs history
    // as a side effect before returning.
    const retryResult = await enrollMeetingForSync(store, now + 1, { interactionId, userId: "u1", googleCalendarId: "primary" });
    assert.equal(retryResult, null, `[${label}] retrying enrollment for an already-enrolled interaction must still report "already enrolled"`);
    const historyAfterRetry = await store.getHistory(linkId, 0);
    assert.ok(historyAfterRetry, `[${label}] the missing history row must be repaired by the retry, not left missing`);
    assert.equal(historyAfterRetry.createStatus, "not_attempted");
    assert.equal(historyAfterRetry.cleanupNeeded, false);

    // 4. "Reconcile: GET returns 404, INSERT succeeds." THE FIX: history
    // updates must no longer silently affect nothing.
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const reconcileOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "worker-1", now + 2);
    assert.equal(reconcileOutcome.kind, "synced");
    const historyAfterCreate = await store.getHistory(linkId, 0);
    assert.equal(historyAfterCreate.createStatus, "succeeded", `[${label}] creation must now be durably tracked in history, not silently lost`);

    // 5. "Cancel and reconcile again." 6. Independent execution (pre-fix)
    // produced only GET -> INSERT, despite cancellation -- i.e. cleanup
    // never sent any Google DELETE at all.
    await recordCancel(store, now + 3, interactionId);
    const historyAfterCancel = await store.getHistory(linkId, 0);
    assert.equal(historyAfterCancel.cleanupNeeded, true, `[${label}] cancellation must correctly mark cleanup needed now that history exists to record it on`);

    client.enqueueValue("delete", eventId, ok204());
    const cancelOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "worker-2", now + 4);
    assert.equal(cancelOutcome.kind, "deleted", `[${label}] cancellation must actually succeed, not report "delete failed" without ever trying`);

    // Verify SIMULATED REMOTE EVENT EXISTENCE, not only the returned
    // status: a real DELETE call must actually have been sent to Google.
    const deleteCalls = client.calls.filter((c) => c.op === "delete");
    assert.equal(deleteCalls.length, 1, `[${label}] independent execution of the pre-fix code produced only GET -> INSERT; the fix must actually send a DELETE`);
    assert.equal(deleteCalls[0].eventId, eventId);
    const historyAfterDelete = await store.getHistory(linkId, 0);
    assert.equal(historyAfterDelete.cleanupStatus, "done");
  }

  // =========================================================================
  // The SAME corrupted state, but reconciled WITHOUT ever retrying
  // enrollment first -- proving the backstop inside reconcilePresentAbsent
  // itself repairs it, independent of which entry point a caller uses
  // (e.g. a sweep picking up the link via listNeedingReconciliation,
  // never having gone through enrollMeetingForSync's own repair branch).
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", async () => ({ store: new InMemoryCalendarStore() })], ["sqlite", async () => freshSqliteStore("int-crash-no-retry")]]) {
    const { store } = await makeStore();
    const client = new ScriptedCalendarClient();
    const now = 1000;
    const interactionId = "int-crash-no-retry";
    const linkId = "link-crash-no-retry";
    const eventId = deriveGoogleEventId(interactionId, 0);
    const getFields = async () => makeFields(interactionId);

    await simulateCrashedEnrollment(store, now, { id: linkId, interactionId });
    // Deliberately skip calling enrollMeetingForSync again -- go straight
    // to reconcile, as a sweep would.
    client.enqueueValue("get", eventId, err404());
    client.enqueueValue("insert", eventId, ok201({ id: eventId }));
    const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "worker-1", now + 1);
    assert.equal(outcome.kind, "synced", `[${label}] reconcile itself must self-heal the missing history row, with no enrollment retry in between`);
    const history = await store.getHistory(linkId, 0);
    assert.equal(history.createStatus, "succeeded");

    await recordCancel(store, now + 2, interactionId);
    client.enqueueValue("delete", eventId, ok204());
    const cancelOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "worker-2", now + 3);
    assert.equal(cancelOutcome.kind, "deleted");
    assert.ok(client.calls.some((c) => c.op === "delete" && c.eventId === eventId), `[${label}] a real DELETE must be sent even when the backstop (not the enrollment-retry repair) is what fixed the missing history`);
  }

  // =========================================================================
  // insertLinkWithHistory is genuinely atomic: a failed enrollment
  // (interaction already linked) must leave no orphaned history row --
  // nothing partially committed.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", async () => ({ store: new InMemoryCalendarStore() })], ["sqlite", async () => freshSqliteStore("int-atomic-enroll")]]) {
    const { store } = await makeStore();
    const now = 1000;
    const interactionId = "int-atomic-enroll";
    const first = await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    assert.ok(first, `[${label}] the first enrollment must succeed`);
    const historyCountBefore = (await store.getHistory(first.id, 0)) ? 1 : 0;
    assert.equal(historyCountBefore, 1);

    // A second, truly fresh attempt to insert a NEW link row for the SAME
    // interaction (bypassing enrollMeetingForSync's own "already exists"
    // check, to exercise insertLinkWithHistory's own UNIQUE-collision
    // failure path directly) must fail cleanly, with no stray history
    // row left for the rejected attempt's own id.
    const rejectedLinkId = "link-should-never-exist";
    const rejected = await store.insertLinkWithHistory({ id: rejectedLinkId, interactionId, userId: "u1", googleCalendarId: "primary", generation: 0, googleEventId: null, googleEtag: null, desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null, attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null }, now + 1);
    assert.equal(rejected, null, `[${label}] a second link for an already-enrolled interaction must be rejected`);
    const strayHistory = await store.getHistory(rejectedLinkId, 0);
    assert.equal(strayHistory, null, `[${label}] a rejected insertLinkWithHistory call must leave NO orphaned history row for the link id it failed to create`);
  }

  // =========================================================================
  // applyReopen's own atomicity: every successful reopen's new generation
  // has its history row immediately, with no separate step to lose a
  // crash in -- proven across several sequential reopens.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", async () => ({ store: new InMemoryCalendarStore() })], ["sqlite", async () => freshSqliteStore("int-reopen-atomic")]]) {
    const { store } = await makeStore();
    const now = 1000;
    const interactionId = "int-reopen-atomic";
    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    for (let i = 0; i < 4; i++) {
      await recordCancel(store, now + 1, interactionId);
      const ok = await recordReopen(store, now + 2, interactionId);
      assert.ok(ok, `[${label}] reopen ${i} must succeed`);
      const link = await store.getLinkByInteraction(interactionId);
      const history = await store.getHistory(link.id, link.generation);
      assert.ok(history, `[${label}] generation ${link.generation}'s history row must exist immediately after reopen -- no separate step for a crash to land between`);
      assert.equal(history.googleEventId, deriveGoogleEventId(interactionId, link.generation));
    }
  }

  // =========================================================================
  // Preserve cleanup obligations for every previous generation, even when
  // an OLDER generation's history is separately found missing (simulating
  // data corruption unrelated to the CURRENT generation) -- self-heal
  // must never let an old generation's cleanup be silently skipped, and
  // must never touch the current generation while repairing an old one.
  // =========================================================================
  {
    const { store, db } = freshSqliteStore("int-multi-gen-repair");
    const client = new ScriptedCalendarClient();
    const now = 1000;
    const interactionId = "int-multi-gen-repair";
    const getFields = async () => makeFields(interactionId);
    const genZeroId = deriveGoogleEventId(interactionId, 0);

    await enrollMeetingForSync(store, now, { interactionId, userId: "u1", googleCalendarId: "primary" });
    client.enqueueValue("get", genZeroId, err404());
    client.enqueueValue("insert", genZeroId, ok201({ id: genZeroId }));
    await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", now + 1);

    await recordCancel(store, now + 2, interactionId);
    const link = await store.getLinkByInteraction(interactionId);

    // Simulate generation 0's history row being lost AFTER it already
    // tracked a real create (an unrelated corruption, not the enrollment-
    // crash scenario) -- directly via raw SQL, modeling "any cause", not
    // a call into code under test.
    db.prepare("DELETE FROM calendar_event_link_history WHERE link_id = ? AND generation = 0").run(link.id);
    assert.equal(await store.getHistory(link.id, 0), null, "setup: confirm generation 0's history is gone");

    await recordReopen(store, now + 3, interactionId);
    const afterReopen = await store.getLinkByInteraction(interactionId);
    assert.equal(afterReopen.generation, 1);
    const genOneHistory = await store.getHistory(link.id, 1);
    assert.ok(genOneHistory, "generation 1's own history must exist (applyReopen is unaffected by generation 0's separate corruption)");

    // Create the new generation's event.
    const genOneId = deriveGoogleEventId(interactionId, 1);
    client.enqueueValue("get", genOneId, err404());
    client.enqueueValue("insert", genOneId, ok201({ id: genOneId }));
    const reopenedOutcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w2", now + 4);
    assert.equal(reopenedOutcome.kind, "synced");

    // Generation 0 still genuinely needs cleanup (it was cancelled
    // before this corruption), even though its history row is gone --
    // the sweep can't find it via listPendingCleanup (the row doesn't
    // exist to list), so this models the owner/sweep eventually noticing
    // via some other means and explicitly asking cleanup to check this
    // specific (link, generation, eventId) -- which must self-heal and
    // actually attempt the real DELETE, not silently no-op.
    client.enqueueValue("delete", genZeroId, ok204());
    const cleanupResult = await reconcileGenerationCleanup(store, client, "primary", link.id, 0, genZeroId, now + 5, "cleanup-worker");
    assert.equal(cleanupResult.kind, "done", "generation 0's cleanup must self-heal and actually complete, even after its history was separately lost");
    const deleteCalls = client.calls.filter((c) => c.op === "delete");
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0].eventId, genZeroId, "cleanup must target ONLY generation 0's event -- generation 1's real, just-created event must never be touched");

    // Generation 1 remains completely untouched and still synced.
    const finalLink = await store.getLinkByInteraction(interactionId);
    assert.equal(finalLink.syncStatus, "synced");
    assert.equal(finalLink.googleEventId, genOneId);
  }

  process.stdout.write("calendar-sync-regression-2026-10-20.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
