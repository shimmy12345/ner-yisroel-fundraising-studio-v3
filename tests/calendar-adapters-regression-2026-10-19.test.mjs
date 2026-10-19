import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InMemoryCalendarStore } from "../lib/calendar/testing/in-memory-calendar-store.ts";
import { SqliteCalendarStore } from "../lib/calendar/testing/sqlite-calendar-store.ts";
import { ScriptedCalendarClient, ok201, err404, createDeferred } from "../lib/calendar/testing/scripted-calendar-client.ts";
import { createGoogleCalendarClient } from "../lib/calendar/google-calendar-client.ts";
import { MockHttpTransport, jsonResponse, tokenResponse } from "../lib/calendar/testing/mock-http-transport.ts";
import { enrollMeetingForSync, recordCancel, recordReschedule, reconcilePresentAbsent, runReconciliationSweep } from "../lib/calendar/calendar-sync-reconciler.ts";
import { deriveGoogleEventId } from "../lib/calendar/calendar-event-id.ts";

// Independent review (2026-10-19) of the D1/Google-client implementation
// phase found three classes of issue, each reproduced here against the
// PUBLIC entry points (never an internal helper), before this file's own
// fix: (1) a successful-status but malformed/mismatched Google response
// could be treated as a confirmed success; (2) a permanent rejection
// (invalid content, a real Google 400) was indistinguishable from a
// transient timeout, retried forever; (3) updateLinkAsLeaseHolder/
// revalidateBeforeMutation checked lease OWNERSHIP but never EXPIRY, so
// an expired worker could still write bookkeeping or send a mutating
// call as long as no one else had yet re-acquired the lease.

function makeFields(interactionId, overrides = {}) {
  return { interactionId, donorDisplayName: "Test Donor", allDay: true, allDayDate: "2026-03-05", occurredAt: null, endAt: null, timezone: null, location: null, fosUrl: "https://shimmydonors.org/donors/d1/meeting-brief", ...overrides };
}

const migrationDir = path.join(path.resolve(import.meta.dirname, ".."), "drizzle");
const migrations = fs.readdirSync(migrationDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshSqliteStore(interactionId) {
  const db = new DatabaseSync(":memory:");
  for (const migration of migrations) db.exec(fs.readFileSync(path.join(migrationDir, migration), "utf8"));
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'u1@example.test', 1000, 1000)").run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES ('d1', 'u1', 'live', 'Test Donor', 1000, 1000)").run();
  db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, 'd1', 'u1', 'meeting', 86400, 'Meeting', 1000, 1000)").run(interactionId);
  return new SqliteCalendarStore(db);
}

const CREDENTIALS = { clientId: "c", clientSecret: "s", refreshToken: "r" };

async function run() {
  // =========================================================================
  // ISSUE 1: a successful-status, malformed/mismatched Google response
  // must never be treated as a confirmed sync -- tested through the FULL
  // STACK (reconciler + real google-calendar-client.ts + mocked
  // transport), against the in-memory store.
  // =========================================================================
  {
    const interactionId = "int-issue1-insert";
    const store = new InMemoryCalendarStore();
    const transport = new MockHttpTransport();
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const getFields = async () => makeFields(interactionId);

    await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(404, {}));
    transport.enqueue(jsonResponse(200, {})); // pre-fix reproduction: an empty {} on a 200
    const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
    assert.notEqual(outcome.kind, "synced", "an empty/malformed INSERT response must never be reported as synced, through the full reconciler+client stack");
    const link = await store.getLinkByInteraction(interactionId);
    assert.notEqual(link.syncStatus, "synced");
    const history = await store.getHistory(link.id, 0);
    assert.equal(history.createStatus, "in_flight", "an ambiguous (malformed-response) creation must be preserved as in_flight, never confirmed and never a definitive failure that would trigger a blind replacement insert");
  }
  {
    // GET requested eventId X, but a DIFFERENT real event Y (its own,
    // self-matching ownership tag) came back -- through the reconciler's
    // own "event exists -> update" path.
    const interactionId = "int-issue1-get-mismatch";
    const store = new InMemoryCalendarStore();
    const transport = new MockHttpTransport();
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const getFields = async () => makeFields(interactionId);

    await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, { id: "a-totally-different-event-id", summary: "x", description: "y", start: { date: "2026-01-01" }, end: { date: "2026-01-02" }, extendedProperties: { private: { fosManagedEventId: "a-totally-different-event-id" } } }));
    const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
    assert.notEqual(outcome.kind, "synced", "a GET returning a different event than the one requested must never be reported as synced");
    assert.notEqual(outcome.kind, "missing_remotely"); // the GET itself returned a (wrong) 200 -- it was never a 404
  }

  // =========================================================================
  // ISSUE 2: permanent rejection vs. retryable failure vs. auth/config
  // problem vs. genuine ambiguity -- all four, against BOTH stores.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", async () => new InMemoryCalendarStore()], ["sqlite", async (interactionId) => freshSqliteStore(interactionId)]]) {
    // --- Pre-mutation validation: invalid content never even reaches
    // the network, and is recorded as a permanent, non-retried rejection. ---
    {
      const interactionId = "int-issue2-invalid";
      const store = await makeStore(interactionId);
      const client = new ScriptedCalendarClient(); // nothing enqueued -- a call would throw
      const occurredAt = 2_000_000;
      const getFields = async () => makeFields(interactionId, { allDay: false, allDayDate: null, occurredAt, endAt: occurredAt - 60, timezone: "America/Chicago" }); // endAt before occurredAt

      await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
      assert.equal(outcome.kind, "invalid", `[${label}] invalid content must be rejected before any network call`);
      assert.equal(client.calls.length, 0, `[${label}] Google must never be contacted for permanently invalid content`);
      const link = await store.getLinkByInteraction(interactionId);
      assert.equal(link.syncStatus, "invalid");

      // "Stop automatic retries for permanent invalid requests": a sweep
      // must never pick this link up again on its own.
      const sweep = await runReconciliationSweep(store, client, getFields, "sweep", 1002);
      assert.equal(sweep.reconciled.length, 0, `[${label}] an 'invalid' link must be excluded from the automatic reconciliation sweep entirely`);

      // "Allow corrected meeting details... to resume appropriately":
      // recordReschedule resets it back to pending.
      await recordReschedule(store, 1003, interactionId);
      const afterReschedule = await store.getLinkByInteraction(interactionId);
      assert.equal(afterReschedule.syncStatus, "pending", `[${label}] a reschedule must resume a link out of 'invalid'`);
    }

    // --- A real Google 400 (content accepted by local validation, but
    // Google itself rejects it) -- same permanent, non-retried treatment. ---
    {
      const interactionId = "int-issue2-google400";
      const store = await makeStore(interactionId);
      const client = new ScriptedCalendarClient();
      const eventId = deriveGoogleEventId(interactionId, 0);
      const getFields = async () => makeFields(interactionId);

      await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, { ok: false, status: 400 });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
      assert.equal(outcome.kind, "invalid", `[${label}] a real Google 400 must be a definitive, permanent rejection, never the same bucket as a timeout`);
      const link = await store.getLinkByInteraction(interactionId);
      const history = await store.getHistory(link.id, 0);
      assert.equal(history.createStatus, "invalid", `[${label}] the generation's own history must record the permanent rejection`);

      // A later GET-404 (nothing was ever created) must not silently retry.
      client.enqueueValue("get", eventId, err404());
      const secondAttempt = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1002);
      assert.equal(secondAttempt.kind, "invalid", `[${label}] a generation already marked 'invalid' must not be silently retried just because the event still doesn't exist`);
    }

    // --- 401/403: authentication/configuration problem, not a content
    // or timeout issue -- also excluded from automatic retry. ---
    {
      const interactionId = "int-issue2-auth";
      const store = await makeStore(interactionId);
      const client = new ScriptedCalendarClient();
      const eventId = deriveGoogleEventId(interactionId, 0);
      const getFields = async () => makeFields(interactionId);

      await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, { ok: false, status: "error", errorClass: "unauthorized" });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
      assert.equal(outcome.kind, "auth_required", `[${label}] a 401/403 must be its own distinct category, never conflated with a content rejection or a transient failure`);
      const link = await store.getLinkByInteraction(interactionId);
      assert.equal(link.syncStatus, "auth_required");

      const sweep = await runReconciliationSweep(store, client, getFields, "sweep", 1002);
      assert.equal(sweep.reconciled.length, 0, `[${label}] an 'auth_required' link must be excluded from the automatic sweep -- retrying the same broken credentials on a timer cannot succeed`);

      await recordReschedule(store, 1003, interactionId);
      const afterReschedule = await store.getLinkByInteraction(interactionId);
      assert.equal(afterReschedule.syncStatus, "pending", `[${label}] an explicit retry (recordReschedule) must still be able to resume an 'auth_required' link once credentials are fixed`);
    }

    // --- 429/5xx: a confirmed, non-ambiguous failure -- retryable, with
    // BOUNDED BACKOFF (never hammered every sweep tick). ---
    {
      const interactionId = "int-issue2-backoff";
      const store = await makeStore(interactionId);
      const client = new ScriptedCalendarClient();
      const eventId = deriveGoogleEventId(interactionId, 0);
      const getFields = async () => makeFields(interactionId);

      await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, { ok: false, status: "error", errorClass: "server_error" });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
      assert.equal(outcome.kind, "failed");
      const link = await store.getLinkByInteraction(interactionId);
      assert.equal(link.syncStatus, "failed");
      assert.ok(link.nextRetryAt !== null && link.nextRetryAt > 1001, `[${label}] a transient failure must schedule a future backoff retry time, not retry immediately`);

      // A sweep run BEFORE nextRetryAt must skip this link entirely
      // ("avoid retry storms").
      const tooSoon = await runReconciliationSweep(store, client, getFields, "sweep", link.nextRetryAt - 1);
      assert.equal(tooSoon.reconciled.length, 0, `[${label}] a sweep run before nextRetryAt must not retry a 'failed' link`);

      // A sweep run AT/AFTER nextRetryAt retries it.
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, ok201({ id: eventId }));
      const afterBackoff = await runReconciliationSweep(store, client, getFields, "sweep", link.nextRetryAt);
      assert.equal(afterBackoff.reconciled.length, 1, `[${label}] a sweep run at/after nextRetryAt must retry a 'failed' link`);
      assert.equal(afterBackoff.reconciled[0].kind, "synced");

      // Confirmed non-ambiguous failure must have reset createStatus off
      // "in_flight" (Google definitively responded before this generation
      // was created) -- never left in the SAME bucket a genuine timeout
      // leaves it in.
    }

    // --- A genuine timeout/network ambiguity must still be preserved
    // exactly as before -- createStatus stays "in_flight". ---
    {
      const interactionId = "int-issue2-ambiguous";
      const store = await makeStore(interactionId);
      const client = new ScriptedCalendarClient();
      const eventId = deriveGoogleEventId(interactionId, 0);
      const getFields = async () => makeFields(interactionId);

      await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, { ok: false, status: "error", errorClass: "network_error" });
      const outcome = await reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1001);
      assert.equal(outcome.kind, "failed", `[${label}] a genuine ambiguity is still reported as a retryable failure at the link level`);
      const link = await store.getLinkByInteraction(interactionId);
      const history = await store.getHistory(link.id, 0);
      assert.equal(history.createStatus, "in_flight", `[${label}] PRESERVE GENUINE TIMEOUT/NETWORK AMBIGUITY -- createStatus must stay in_flight, never resolved to 'failed' or 'invalid', since Google's own processing of the request is genuinely unknown`);
    }
  }

  // =========================================================================
  // ISSUE 3: lease expiry enforcement at every protected operation, not
  // only at acquisition -- against BOTH stores, using deferred-promise
  // control (ScriptedCalendarClient.createDeferred) to pause a reconcile
  // attempt exactly at its GET call, so the test can deliberately let
  // this attempt's own lease expire (with and without a takeover) before
  // resuming it.
  // =========================================================================
  for (const [label, makeStore] of [["in-memory", async () => new InMemoryCalendarStore()], ["sqlite", async (interactionId) => freshSqliteStore(interactionId)]]) {
    // --- Expiry WITHOUT takeover: nobody else acquired the lease, but
    // it has still expired -- the stale worker's write must still be
    // rejected (pre-fix: updateLinkAsLeaseHolder checked ownership only). ---
    {
      const interactionId = "int-issue3-expiry-no-takeover";
      const store = await makeStore(interactionId);
      const link = await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      await store.acquireLease(link.id, "worker-A", 1000, 60); // expires at 1060

      // Pre-fix reproduction: a write attempted AFTER expiry, by the
      // SAME owner, with NO replacement having acquired the lease.
      const staleWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-A", 1061, { syncStatus: "synced" });
      assert.equal(staleWrite, false, `[${label}] an EXPIRED lease holder's write must be rejected even when no one else has acquired the lease yet`);
      const unchanged = await store.getLinkById(link.id);
      assert.equal(unchanged.syncStatus, "pending", `[${label}] the rejected write must not have landed`);
    }

    // --- Expiry WITH takeover: a second worker acquires the lease after
    // expiry; the first (stale) worker's write must still be rejected,
    // and the new holder's own write must succeed. ---
    {
      const interactionId = "int-issue3-expiry-takeover";
      const store = await makeStore(interactionId);
      const link = await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      await store.acquireLease(link.id, "worker-A", 1000, 60); // expires at 1060
      const acquiredB = await store.acquireLease(link.id, "worker-B", 1070, 60); // after A's expiry
      assert.equal(acquiredB, true);

      const staleWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-A", 1071, { syncStatus: "synced" });
      assert.equal(staleWrite, false, `[${label}] a stale worker's write must be rejected once a new holder has taken over, exactly as before`);

      const newHolderWrite = await store.updateLinkAsLeaseHolder(link.id, "worker-B", 1071, { syncStatus: "synced", syncedRevision: link.desiredRevision });
      assert.equal(newHolderWrite, true, `[${label}] the current, non-expired holder's own write must still succeed`);
    }

    // --- A delayed response arriving AFTER a takeover: attempt 1 (w1)
    // acquires the lease and its INSERT is held open via a deferred
    // promise; attempt 1's OWN lease then genuinely expires (in wall-
    // clock terms a later, independent worker's `now` reflects) and
    // worker w2 legitimately takes over and completes the sync; ONLY
    // THEN does attempt 1's abandoned INSERT finally resolve. Two
    // distinct guarantees, both load-bearing:
    //  (a) attempt 1's own LINK-level bookkeeping write (finishSynced's
    //      updateLinkAsLeaseHolder) must be rejected -- its lease is
    //      gone, a newer generation's sync must never be clobbered by a
    //      stale, late-arriving attempt.
    //  (b) attempt 1's HISTORY-level write (createStatus -- "a fact
    //      about what actually happened over the wire, never gated by
    //      lease ownership") must still land -- "preserve knowledge of
    //      uncertain requests already sent; lease expiration cannot
    //      undo a remote operation." Google really did create that
    //      event; the durable history record must say so regardless of
    //      which worker's lease is current by the time the response
    //      finally arrives.
    // ---
    {
      const interactionId = "int-issue3-delayed-after-takeover";
      const store = await makeStore(interactionId);
      await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      const client = new ScriptedCalendarClient();
      const eventId = deriveGoogleEventId(interactionId, 0);
      const getFields = async () => makeFields(interactionId);

      client.enqueueValue("get", eventId, err404());
      const deferredInsert = createDeferred();
      // `insertCallStarted` is a pure SIGNAL, independent of the actual
      // response -- resolved the instant attempt 1 genuinely CALLS
      // insert() (not merely "would eventually call it"). This is load-
      // bearing for correct sequencing: revalidateBeforeMutation runs
      // IMMEDIATELY after attempt 1's own GET, before the 404 branch is
      // even entered -- if worker 2 took over before attempt 1 reaches
      // that revalidation, attempt 1 is rejected there and NEVER calls
      // insert() at all, leaving this deferred permanently unconsumed
      // and worker 2 wrongly consuming it instead (a real deadlock this
      // test's own first draft hit). Awaiting this signal guarantees
      // attempt 1 has truly reached and is now suspended inside
      // insert() before worker 2 is ever allowed to start.
      const insertCallStarted = createDeferred();
      client.enqueue("insert", eventId, () => {
        insertCallStarted.resolve();
        return deferredInsert.promise;
      });
      // ttlSeconds=5 -- attempt 1's lease (acquired at now=1000) expires
      // at 1005, well before worker 2's later `now` below.
      const pending = reconcilePresentAbsent(store, client, getFields, interactionId, "w1", 1000, 5);
      await insertCallStarted.promise;

      // Worker 2 arrives much later (its own fresh `now`), after
      // attempt 1's lease has genuinely expired with no release --
      // reconcilePresentAbsent's own acquireLease call succeeding here
      // (rather than reporting lease_contended) IS the "expiry without
      // takeover, followed by a real takeover" proof: at now=2001, the
      // lease attempt 1 took at now=1000 with ttlSeconds=5 (expiring at
      // 1005) is long past, with no explicit release.
      const linkBefore = await store.getLinkByInteraction(interactionId);
      client.enqueueValue("get", eventId, err404());
      client.enqueueValue("insert", eventId, ok201({ id: eventId }));
      const w2Result = await reconcilePresentAbsent(store, client, getFields, interactionId, "w2", 2001);
      assert.equal(w2Result.kind, "synced", `[${label}] worker 2 must be able to acquire the genuinely-expired lease and complete its own, independent sync`);

      // NOW attempt 1's long-abandoned INSERT finally resolves.
      deferredInsert.resolve(ok201({ id: eventId }));
      const w1Result = await pending;
      assert.equal(w1Result.kind, "lease_contended", `[${label}] (a) attempt 1's own stale bookkeeping write must be rejected -- its lease is long gone, and w2's newer sync must never be clobbered`);
      const historyAfter = await store.getHistory(linkBefore.id, 0);
      assert.equal(historyAfter.createStatus, "succeeded", `[${label}] (b) attempt 1's HISTORY-level write must still land, unconditionally -- Google really did create the event; lease expiration cannot undo that remote fact`);
    }

    // --- Cancellation/reopen must still be unaffected by lease-expiry
    // enforcement -- recordCancel/recordReopen are UNCONDITIONAL
    // (writeIntent/apply*), never lease-gated, exactly as before. ---
    {
      const interactionId = "int-issue3-cancel-reopen";
      const store = await makeStore(interactionId);
      const link = await enrollMeetingForSync(store, 1000, { interactionId, userId: "u1", googleCalendarId: "primary" });
      await store.acquireLease(link.id, "worker-A", 1000, 60); // a reconcile attempt holds a lease
      const cancelled = await recordCancel(store, 1001, interactionId);
      assert.equal(cancelled, true, `[${label}] a cancel must succeed regardless of lease state, exactly as before -- never gated by lease expiry/ownership`);
      const afterCancel = await store.getLinkByInteraction(interactionId);
      assert.equal(afterCancel.desiredState, "absent");
    }
  }

  process.stdout.write("calendar-adapters-regression-2026-10-19.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
