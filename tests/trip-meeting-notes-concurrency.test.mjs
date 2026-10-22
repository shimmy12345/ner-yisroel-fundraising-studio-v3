// AI Meeting Notes concurrency safety (2026-10-21, second and third
// follow-up reviews -- "prevent lost notes during concurrent saves";
// "do not treat matching final text as proof that a particular request
// succeeded"). Calls the REAL, unmodified
// `completeProspectMeeting`/`scheduleProspectMeeting`
// (lib/relationships/trips-data.ts) and the real, shared
// `saveConcurrentSummaryAndFollowUps` (lib/meeting-notes/concurrent-save.ts)
// that the trip AI-notes save route also uses -- against a real
// in-memory SQLite database built from this repo's own migrations, same
// "real schema, intercept cloudflare:workers" rigor as
// tests/trip-reconciliation-concurrency.test.mjs and
// tests/trip-meeting-notes-preservation.test.mjs. Interleaving is
// produced two ways: `interceptFirstWrite` (same technique
// tests/trip-entrypoints-atomicity.test.mjs already uses for `.batch()`,
// extended here to also cover a standalone `.run()`) runs a
// side-effecting write between a function's own read and its write for
// a deterministic "something else changed it in between" reproduction;
// `Promise.all` produces genuine microtask-level interleaving for the
// "two truly concurrent requests" case.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);
globalThis.__FUNDRAISING_OS_ENVIRONMENT__ = "production-independent";

const { env } = await import("./helpers/cloudflare-workers-shim.mjs");
const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const {
  scheduleProspectMeeting,
  completeProspectMeeting,
} = await import("../lib/relationships/trips-data.ts");
const { tripMeetingInteractionId } = await import("../lib/relationships/trip-model.ts");
const { saveConcurrentSummaryAndFollowUps } = await import("../lib/meeting-notes/concurrent-save.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
const PAST_MEETING_AT = "2026-10-20T09:00";
const FUTURE_MEETING_AT = "2026-10-25T14:00";
const USER_ID = "u1";
const DONOR_ID = "d1";

function freshDb() {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, timezone, created_at, updated_at) VALUES (?, ?, 'America/Chicago', ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, state, created_at, updated_at) VALUES (?, ?, 'live', 'Jane Donor', 'IL', ?, ?)").bind(DONOR_ID, USER_ID, NOW, NOW).run();
  return db;
}

function seedTripProspect(db, { tripId, prospectId }) {
  db.prepare("INSERT INTO trips (id, owner_user_id, name, start_date, end_date, created_at, updated_at) VALUES (?, ?, 'Test Trip', ?, ?, ?, ?)").bind(tripId, USER_ID, NOW, NOW + 7 * 86400, NOW, NOW).run();
  db.prepare("INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, created_at, updated_at) VALUES (?, ?, ?, 'manual', 'not_contacted', ?, ?)").bind(prospectId, tripId, DONOR_ID, NOW, NOW).run();
}

function interactionSummary(db, interactionId) {
  return db.raw().prepare("SELECT summary FROM interactions WHERE id = ?").get(interactionId)?.summary ?? null;
}

// Same technique as tests/trip-entrypoints-atomicity.test.mjs, extended
// to also cover a standalone `.run()` call (completeProspectMeeting's
// compare-and-swap interactions UPDATE is now its own direct `.run()`,
// not part of a `.batch()` -- see the third follow-up review's own
// "do not treat matching final text as proof a particular request
// succeeded" fix): wraps a real D1SqliteAdapter so the FIRST write of
// EITHER kind -- a `.batch()` call or a bound statement's own `.run()`
// -- runs `onFirstWrite()` (awaited) before forwarding to the real
// write, i.e. after whatever read already happened to build it, but
// before it lands.
function interceptFirstWrite(realDb, onFirstWrite) {
  let intercepted = false;
  async function maybeIntercept() {
    if (!intercepted) {
      intercepted = true;
      await onFirstWrite();
    }
  }
  return {
    raw: () => realDb.raw(),
    prepare: (sql) => {
      const realStatement = realDb.prepare(sql);
      return {
        bind: (...args) => {
          const bound = realStatement.bind(...args);
          return {
            run: async () => { await maybeIntercept(); return bound.run(); },
            first: (...a) => bound.first(...a),
            all: (...a) => bound.all(...a),
            _runRaw: () => bound._runRaw(),
          };
        },
      };
    },
    batch: async (statements) => {
      await maybeIntercept();
      return realDb.batch(statements);
    },
  };
}

async function run() {
  // --- 1. Completion reads the current notes, another save lands in
  // the gap, THEN completion writes -- the earlier save must survive,
  // and completion's own note must still be appended on top of it
  // (never the stale pre-read value silently restored). ---
  {
    const realDb = freshDb();
    const tripId = "trip-1";
    const prospectId = "prospect-1";
    seedTripProspect(realDb, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);
    env.DB = realDb;
    await scheduleProspectMeeting(USER_ID, tripId, prospectId, FUTURE_MEETING_AT, null, 30, true, "America/Chicago", NOW);
    realDb.raw().prepare("UPDATE interactions SET summary = ? WHERE id = ?").run("AI-organized: original notes.", interactionId);

    env.DB = interceptFirstWrite(realDb, async () => {
      // A donor-profile edit (or a trip AI-notes save) lands in the gap
      // between completeProspectMeeting's own read and its write.
      realDb.raw().prepare("UPDATE interactions SET summary = ? WHERE id = ?").run("AI-organized: edited concurrently.", interactionId);
    });
    const result = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Met and discussed next steps.", true, "America/Chicago", NOW);
    env.DB = realDb;

    assert.ok(result.ok, `completion must still succeed after retrying against the newer value (got ${JSON.stringify(result)})`);
    const summary = interactionSummary(realDb, interactionId);
    assert.ok(summary.includes("edited concurrently"), "the concurrent edit that landed in the gap must survive");
    assert.ok(summary.includes("Met and discussed next steps."), "completion's own note must still be appended");
    assert.ok(!summary.includes("original notes"), "the value completion's FIRST (losing) read saw must not reappear -- it was superseded before completion's write ever landed");
    const prospect = realDb.raw().prepare("SELECT status FROM trip_prospects WHERE id = ?").get(prospectId);
    assert.equal(prospect.status, "meeting_completed");
  }

  // --- 2. A stale notes editor (its own baseline is the PRE-completion
  // summary) saves AFTER completion has already appended its own note --
  // the stale save must be rejected outright, never silently overwriting
  // the completion note. ---
  {
    const db = freshDb();
    const tripId = "trip-2";
    const prospectId = "prospect-2";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);
    env.DB = db;
    await scheduleProspectMeeting(USER_ID, tripId, prospectId, FUTURE_MEETING_AT, null, 30, true, "America/Chicago", NOW);
    const staleBaseline = "AI-organized: before completion.";
    db.raw().prepare("UPDATE interactions SET summary = ? WHERE id = ?").run(staleBaseline, interactionId);

    // The editor "loaded" staleBaseline into its form here, then sat
    // open while the meeting was completed elsewhere.
    const completion = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Completion note.", true, "America/Chicago", NOW);
    assert.ok(completion.ok);
    const afterCompletion = interactionSummary(db, interactionId);
    assert.ok(afterCompletion.includes("Completion note."));

    // The stale editor now submits its own save, still believing
    // `staleBaseline` is current.
    const outcome = await saveConcurrentSummaryAndFollowUps(db, interactionId, DONOR_ID, USER_ID, "AI-organized: stale rewrite, ignorant of the completion note.", staleBaseline, NOW, []);
    assert.deepEqual(outcome, { status: "conflict", reason: "summary_stale" }, "a stale save (its baseline no longer matches the current row, and the row does not already hold the requested new value either) must be rejected");
    const afterStaleSave = interactionSummary(db, interactionId);
    assert.equal(afterStaleSave, afterCompletion, "the completion note must survive completely untouched by the rejected stale save");
  }

  // --- 3. Two genuinely competing completions (Promise.all, real
  // microtask interleaving -- same technique as tests/trip-
  // reconciliation-concurrency.test.mjs's own "two competing real
  // records" case) -- both must succeed, both notes must survive. ---
  {
    const db = freshDb();
    const tripId = "trip-3";
    const prospectId = "prospect-3";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);
    env.DB = db;
    await scheduleProspectMeeting(USER_ID, tripId, prospectId, FUTURE_MEETING_AT, null, 30, true, "America/Chicago", NOW);

    const [resultA, resultB] = await Promise.all([
      completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Completion note A.", true, "America/Chicago", NOW),
      completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Completion note B.", true, "America/Chicago", NOW),
    ]);
    assert.ok(resultA.ok, `completion A must succeed (got ${JSON.stringify(resultA)})`);
    assert.ok(resultB.ok, `completion B must succeed (got ${JSON.stringify(resultB)})`);
    const summary = interactionSummary(db, interactionId);
    assert.ok(summary.includes("Completion note A."), "A's note must survive the race");
    assert.ok(summary.includes("Completion note B."), "B's note must survive the race -- never silently discarded by A's write or vice versa");
    const prospect = db.raw().prepare("SELECT status FROM trip_prospects WHERE id = ?").get(prospectId);
    assert.equal(prospect.status, "meeting_completed");
  }

  // --- 4. An identical retry (the exact same completion request,
  // resubmitted) must never append a second, duplicate block. ---
  {
    const db = freshDb();
    const tripId = "trip-4";
    const prospectId = "prospect-4";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);
    env.DB = db;
    await scheduleProspectMeeting(USER_ID, tripId, prospectId, FUTURE_MEETING_AT, null, 30, true, "America/Chicago", NOW);

    const notes = "Completion note, submitted twice.";
    const first = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, notes, true, "America/Chicago", NOW);
    assert.ok(first.ok);
    const afterFirst = interactionSummary(db, interactionId);

    const retry = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, notes, true, "America/Chicago", NOW + 30);
    assert.ok(retry.ok, "an identical retry must still report success, not a conflict");
    const afterRetry = interactionSummary(db, interactionId);
    assert.equal(afterRetry, afterFirst, "an identical retry must be a no-op on the summary");
    assert.equal(afterRetry.split(notes).length - 1, 1, "the notes text must appear exactly once, never duplicated by the retry");
  }

  // --- 5. Two genuinely concurrent FIRST-TIME completions (impromptu
  // meetings -- `scheduleProspectMeeting` was never called, so there is
  // no `linked_interaction_id` yet and both calls take the "no existing
  // interaction" INSERT branch). Fourth follow-up review fix: the loser
  // of the INSERT race must re-read by the stable deterministic
  // interaction id on its very next attempt -- not by its own stale,
  // still-null pre-loop snapshot -- so it correctly switches to the
  // append branch instead of repeating the same failing INSERT until it
  // runs out of attempts and silently drops its own notes. Both
  // completions must succeed, and both distinct notes must survive. ---
  {
    const db = freshDb();
    const tripId = "trip-5";
    const prospectId = "prospect-5";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);
    env.DB = db;

    const [resultA, resultB] = await Promise.all([
      completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Impromptu completion note A.", true, "America/Chicago", NOW),
      completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Impromptu completion note B.", true, "America/Chicago", NOW),
    ]);
    assert.ok(resultA.ok, `first-time completion A must succeed (got ${JSON.stringify(resultA)})`);
    assert.ok(resultB.ok, `first-time completion B must succeed (got ${JSON.stringify(resultB)})`);
    const summary = interactionSummary(db, interactionId);
    assert.ok(summary.includes("Impromptu completion note A."), "A's note must survive -- never lost to a retry that kept re-checking a stale null linkedInteractionId");
    assert.ok(summary.includes("Impromptu completion note B."), "B's note must survive alongside A's, never silently discarded");
    const prospect = db.raw().prepare("SELECT status, linked_interaction_id FROM trip_prospects WHERE id = ?").get(prospectId);
    assert.equal(prospect.status, "meeting_completed");
    assert.equal(prospect.linked_interaction_id, interactionId);
  }

  // --- 6. THE EXACT 62dec37-SHAPE FAILURE for completion: force the
  // trip_prospects companion write to be impossible to apply (the
  // prospect row itself deleted out from under the attempt) after the
  // interactions CAS would otherwise succeed. The notes UPDATE must roll
  // back in full -- never leave the interaction's new summary committed
  // while the prospect's own status silently fails to advance. Checking
  // only the returned status is not enough; this asserts actual
  // interaction row state before vs. after. ---
  {
    const db = freshDb();
    const tripId = "trip-6";
    const prospectId = "prospect-6";
    seedTripProspect(db, { tripId, prospectId });
    const interactionId = tripMeetingInteractionId(prospectId);
    env.DB = db;
    await scheduleProspectMeeting(USER_ID, tripId, prospectId, FUTURE_MEETING_AT, null, 30, true, "America/Chicago", NOW);
    const beforeRow = db.raw().prepare("SELECT summary, updated_at FROM interactions WHERE id = ?").get(interactionId);

    // The prospect row itself is gone by the time the batch runs (e.g. a
    // concurrent trip-prospect removal) -- the trip_prospects UPDATE's
    // own `WHERE id = ?` can now never match, regardless of the gate.
    env.DB = interceptFirstWrite(db, async () => {
      db.raw().prepare("DELETE FROM trip_prospects WHERE id = ?").run(prospectId);
    });
    const result = await completeProspectMeeting(USER_ID, tripId, prospectId, PAST_MEETING_AT, "Note that must not partially save.", true, "America/Chicago", NOW + 10);
    env.DB = db;

    assert.equal(result.ok, false, "completion must report failure when its companion prospect-status write cannot apply");
    const afterRow = db.raw().prepare("SELECT summary, updated_at FROM interactions WHERE id = ?").get(interactionId);
    assert.deepEqual(afterRow, beforeRow, "the interactions UPDATE -- even though its own CAS would have matched -- must never be left committed when the companion trip_prospects write cannot apply");
  }

  console.log("trip-meeting-notes-concurrency.test.mjs: all assertions passed");
}

await run();
