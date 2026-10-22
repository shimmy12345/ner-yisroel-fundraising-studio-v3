// AI Meeting Notes trip-notes save concurrency (2026-10-21, third
// follow-up review -- defect B: "conditions follow-up creation on the
// interaction's resulting summary matching newSummary. That does not
// prove this request's UPDATE succeeded."). Calls the REAL, unmodified
// `saveConcurrentSummaryAndFollowUps` exported from
// lib/meeting-notes/concurrent-save.ts -- the exact function
// app/api/trips/[id]/prospects/[prospectId]/meeting-notes/route.ts
// uses -- against a real in-memory SQLite database built from this
// repo's own migrations (tests/helpers/d1-sqlite-adapter.mjs). Never a
// hand-copied reproduction of the SQL or a source-text assertion.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);

const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const { saveConcurrentSummaryAndFollowUps } = await import("../lib/meeting-notes/concurrent-save.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-10-21T12:00:00Z") / 1000);
const USER_ID = "u1";
const DONOR_ID = "d1";
const INTERACTION_ID = "interaction-1";

function freshDb(initialSummary) {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Jane Donor', ?, ?)").bind(DONOR_ID, USER_ID, NOW, NOW).run();
  db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, ?, 'trip:scheduled', ?, ?)")
    .bind(INTERACTION_ID, DONOR_ID, USER_ID, NOW, initialSummary, NOW, NOW).run();
  return db;
}

function summary(db) {
  return db.raw().prepare("SELECT summary FROM interactions WHERE id = ?").get(INTERACTION_ID)?.summary ?? null;
}

function recommendationRows(db) {
  return db.raw().prepare("SELECT id, action, due_at FROM recommendations WHERE donor_id = ? ORDER BY id").all(DONOR_ID)
    .map((row) => ({ id: row.id, action: row.action, due_at: row.due_at }));
}

function followUp(id, index, description, dueAtEpoch = null) {
  return { id, donorId: DONOR_ID, index, description, dueAtEpoch };
}

async function run() {
  // --- 1. An ordinary, non-stale save with follow-ups applies and
  // creates every one of them. ---
  {
    const db = freshDb("Original notes.");
    const outcome = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Updated notes.", "Original notes.", NOW, [
      followUp("fu-1-0", 0, "Send thank-you card"),
      followUp("fu-1-1", 1, "Schedule follow-up call", NOW + 86400),
    ], "save-1");
    assert.deepEqual(outcome, { status: "applied", followUpsCreated: 2 });
    assert.equal(summary(db), "Updated notes.");
    assert.deepEqual(recommendationRows(db), [
      { id: "fu-1-0", action: "Send thank-you card", due_at: null },
      { id: "fu-1-1", action: "Schedule follow-up call", due_at: NOW + 86400 },
    ]);
  }

  // --- 2. THE REPRODUCED DEFECT: current summary already equals the
  // requested newSummary (e.g. someone else wrote this exact text, or a
  // coincidental match), the client's own `expectedSummary` is stale,
  // and the follow-up ids are brand new (never created before). The
  // save must be rejected outright -- and, critically, the follow-ups
  // must NOT be created. The previous (buggy) version of this module
  // created them anyway, because its follow-up guard only checked
  // whether the row's CURRENT content matched the new value, which
  // was true here for a reason that had nothing to do with this
  // request's own write. ---
  {
    const db = freshDb("Text that happens to match.");
    const staleBaseline = "A completely different, now-stale baseline the client actually started from.";
    const outcome = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Text that happens to match.", staleBaseline, NOW, [
      followUp("fu-2-0", 0, "A follow-up that must never be created"),
    ], "save-2");
    assert.deepEqual(outcome, { status: "conflict", reason: "followup_mismatch" }, "a stale save whose new text happens to already match the row must still be rejected when fresh follow-ups are requested");
    assert.equal(summary(db), "Text that happens to match.", "the row's content is unchanged (it already held this value before the call, not because of it)");
    assert.deepEqual(recommendationRows(db), [], "the fresh follow-up must never be created by a rejected save, regardless of the coincidental text match");
  }

  // --- 2b. The same stale-with-coincidental-match shape, but with NO
  // follow-ups requested at all, and a save identity that has never
  // gone through this function before. The ledger has no record of
  // this identity ever having actually applied, so a text match here
  // is still only a coincidence, never proof -- correctly a conflict,
  // not an assumed replay (INDEPENDENT REVIEW, 2026-10-22: the previous
  // version special-cased an empty follow-up list to skip the ledger
  // check entirely and return "replayed" here). ---
  {
    const db = freshDb("Text that happens to match.");
    const staleBaseline = "A different, stale baseline.";
    const outcome = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Text that happens to match.", staleBaseline, NOW, [], "save-2b");
    assert.deepEqual(outcome, { status: "conflict", reason: "followup_mismatch" }, "a coincidental match under a save identity with no ledger record at all must never be treated as a replay, even with zero follow-ups requested");
    assert.equal(summary(db), "Text that happens to match.");
    assert.deepEqual(recommendationRows(db), []);
  }

  // --- 3. Unchanged summary TEXT with intentionally added follow-ups,
  // from a NON-stale client (its own baseline matches the current
  // row) -- explicitly defined behavior: this is a legitimate,
  // successful save. The summary UPDATE still "applies" (SQLite counts
  // a matched-and-rewritten row even when the new value equals the
  // old one), and the new follow-ups are created. ---
  {
    const db = freshDb("Notes the user did not change.");
    const outcome = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Notes the user did not change.", "Notes the user did not change.", NOW, [
      followUp("fu-3-0", 0, "A follow-up added without changing the narrative"),
    ], "save-3");
    assert.deepEqual(outcome, { status: "applied", followUpsCreated: 1 });
    assert.equal(summary(db), "Notes the user did not change.");
    assert.deepEqual(recommendationRows(db), [{ id: "fu-3-0", action: "A follow-up added without changing the narrative", due_at: null }]);
  }

  // --- 4. An identical retry (same baseline, same new text, same save
  // identity, same follow-up ids) after an already-successful save -- a
  // safe no-op replay, never a duplicate. ---
  {
    const db = freshDb("Before.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW, [followUp("fu-4-0", 0, "Task")], "save-4");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 1 });

    const retry = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW + 5, [followUp("fu-4-0", 0, "Task")], "save-4");
    assert.deepEqual(retry, { status: "replayed" }, "an identical retry (stale baseline now, but its own exact save already applied) must be a no-op");
    assert.equal(summary(db), "After.");
    assert.deepEqual(recommendationRows(db), [{ id: "fu-4-0", action: "Task", due_at: null }], "no duplicate follow-up row");
  }

  // --- 5. A changed-payload retry -- same save identity and follow-up
  // ids as an already-applied save, but DIFFERENT content this time --
  // must be rejected, never silently re-applied or reported as success. ---
  {
    const db = freshDb("Before.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW, [followUp("fu-5-0", 0, "Original task")], "save-5");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 1 });

    const changed = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "A completely different rewrite.", "Before.", NOW + 5, [followUp("fu-5-0", 0, "A different task entirely")], "save-5");
    assert.deepEqual(changed, { status: "conflict", reason: "summary_stale" });
    assert.equal(summary(db), "After.", "the changed-payload retry must never overwrite the already-applied save");
    assert.deepEqual(recommendationRows(db), [{ id: "fu-5-0", action: "Original task", due_at: null }], "the original follow-up must be untouched by the rejected changed-payload retry");
  }

  // --- 6. A changed-payload retry that reuses the SAME save identity
  // and the SAME follow-up id with different content, submitted on the
  // SAME turn the summary itself was legitimately unchanged (CAS
  // succeeds on the summary side) -- the follow-up content mismatch must
  // still be caught and rejected, never silently skipped or
  // double-counted. ---
  {
    const db = freshDb("Before.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW, [followUp("fu-6-0", 0, "Original task")], "save-6");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 1 });

    // The SAME save identity, resubmitted with its own (already-applied)
    // summary value as both its own baseline AND new value (so the
    // summary CAS trivially "succeeds" again), but DIFFERENT content for
    // the SAME follow-up id under that identity.
    const collision = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "After.", NOW + 5, [followUp("fu-6-0", 0, "A conflicting rewrite of the same task")], "save-6");
    assert.deepEqual(collision, { status: "conflict", reason: "followup_mismatch" });
    assert.deepEqual(recommendationRows(db), [{ id: "fu-6-0", action: "Original task", due_at: null }], "the original follow-up content must survive the rejected collision untouched");
  }

  // --- 7. THE EXACT 62dec37 FAILURE, reproduced precisely: the CAS
  // genuinely succeeds (a real, non-coincidental text change from a
  // correct, current baseline), but one of the requested follow-up ids
  // already holds DIFFERENT content (seeded here directly, under a save
  // identity that has never gone through this function before -- proving
  // the per-row defense-in-depth mismatch check, not just the
  // save-identity ledger, which has no prior record of this id at all).
  // The whole request must roll back -- not just the follow-up: the
  // summary UPDATE that legitimately matched its own CAS must be undone
  // too, and `updated_at` must revert with it. Checking only the
  // returned status is not enough; this asserts actual row state before
  // vs. after. ---
  {
    const db = freshDb("Before the real edit.");
    db.raw().prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
        VALUES ('fu-7-0', ?, ?, 'Pre-existing, different task', 'seed', 90, 'open', NULL, ?, ?)`).run(DONOR_ID, USER_ID, NOW - 100, NOW - 100);
    const beforeRow = db.raw().prepare("SELECT summary, updated_at FROM interactions WHERE id = ?").get(INTERACTION_ID);
    const beforeFollowUp = db.raw().prepare("SELECT action FROM recommendations WHERE id = 'fu-7-0'").get();

    const outcome = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "A genuinely new, real rewrite of the notes.", "Before the real edit.", NOW + 500, [
      followUp("fu-7-0", 0, "A conflicting rewrite of the pre-existing task"),
    ], "save-7");
    assert.deepEqual(outcome, { status: "conflict", reason: "followup_mismatch" }, "a genuine CAS success must still be rejected in full when a companion follow-up collides");

    const afterRow = db.raw().prepare("SELECT summary, updated_at FROM interactions WHERE id = ?").get(INTERACTION_ID);
    assert.deepEqual(afterRow, beforeRow, "the summary UPDATE -- even though its own CAS matched -- must be rolled back along with the rejected follow-up, including updated_at");
    const afterFollowUp = db.raw().prepare("SELECT action FROM recommendations WHERE id = 'fu-7-0'").get();
    assert.deepEqual(afterFollowUp, beforeFollowUp, "the pre-existing follow-up's content must survive completely untouched");
  }

  // --- 8. THE FIFTH FOLLOW-UP REVIEW'S DEFECT 1, reproduced precisely:
  // save unchanged summary text with one follow-up, complete that
  // follow-up through some OTHER path (simulated directly here, since
  // this module never changes `status` itself), then retry the EXACT
  // original request (same save identity, same baseline, same new text,
  // same follow-up content). The retry must preserve every bit of the
  // follow-up's existing state -- `status`, `created_at`, everything --
  // and report zero newly-created follow-ups. The previous version of
  // this module deleted and reinserted the row to make this idempotent,
  // silently reopening the completed task and resetting `created_at`. ---
  {
    const db = freshDb("Unchanged throughout.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Unchanged throughout.", "Unchanged throughout.", NOW, [followUp("fu-8-0", 0, "Send site visit invite")], "save-8");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 1 });
    const beforeComplete = db.raw().prepare("SELECT created_at FROM recommendations WHERE id = 'fu-8-0'").get();

    // The follow-up is completed through some other path entirely --
    // this module never does this itself, but must never undo it.
    db.raw().prepare("UPDATE recommendations SET status = 'completed', updated_at = ? WHERE id = 'fu-8-0'").run(NOW + 50);

    const retry = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Unchanged throughout.", "Unchanged throughout.", NOW + 100, [followUp("fu-8-0", 0, "Send site visit invite")], "save-8");
    assert.deepEqual(retry, { status: "applied", followUpsCreated: 0 }, "an identical retry of an unchanged-summary save must report zero newly-created follow-ups");

    const afterRetry = db.raw().prepare("SELECT status, created_at, updated_at FROM recommendations WHERE id = 'fu-8-0'").get();
    assert.equal(afterRetry.status, "completed", "the retry must never reopen a follow-up that was completed through some other path");
    assert.equal(afterRetry.created_at, beforeComplete.created_at, "the retry must never reset created_at -- it is not a new task");
    assert.equal(afterRetry.updated_at, NOW + 50, "the retry must not touch updated_at either -- nothing about this row's own state changed because of it");
  }

  // --- 9. THE FIFTH FOLLOW-UP REVIEW'S DEFECT 2, reproduced precisely:
  // save two follow-ups under one save identity, then retry the SAME
  // identity with only the first (the second silently dropped). This
  // must conflict, changing nothing -- never report "replayed" just
  // because the ids the retry itself happens to mention still match;
  // the complete original payload for this identity also included a
  // second follow-up this retry never mentions at all. ---
  {
    const db = freshDb("Before.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW, [
      followUp("fu-9-0", 0, "Send site visit invite"),
      followUp("fu-9-1", 1, "Follow up on pledge"),
    ], "save-9");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 2 });

    // Same save identity, same already-applied summary as both its own
    // baseline and new value (CAS trivially re-matches), but only the
    // FIRST of the two originally-saved follow-ups.
    const dropped = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "After.", NOW + 5, [
      followUp("fu-9-0", 0, "Send site visit invite"),
    ], "save-9");
    assert.deepEqual(dropped, { status: "conflict", reason: "followup_mismatch" }, "dropping a follow-up under the same save identity must conflict, never report a replay");
    assert.deepEqual(recommendationRows(db), [
      { id: "fu-9-0", action: "Send site visit invite", due_at: null },
      { id: "fu-9-1", action: "Follow up on pledge", due_at: null },
    ], "both original follow-ups must survive the rejected retry completely untouched");

    // The SAME drop, but via a genuinely stale CAS (the disambiguation
    // branch, not the trivially-re-matching-CAS branch) -- same
    // requirement, exercised through the other code path.
    const staleDrop = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW + 10, [
      followUp("fu-9-0", 0, "Send site visit invite"),
    ], "save-9");
    assert.deepEqual(staleDrop, { status: "conflict", reason: "followup_mismatch" }, "the same dropped-follow-up payload mismatch must be caught via the CAS-missed disambiguation path too");
    assert.deepEqual(recommendationRows(db), [
      { id: "fu-9-0", action: "Send site visit invite", due_at: null },
      { id: "fu-9-1", action: "Follow up on pledge", due_at: null },
    ], "both original follow-ups must still survive untouched");
  }

  // --- 10. INDEPENDENT REVIEW GAP 1, reproduced precisely: save two
  // follow-ups under one save identity, then retry the SAME identity
  // with the follow-up list now EMPTY -- every one of the original
  // follow-ups removed, not just one of several. Must conflict and
  // change nothing, exactly like dropping only one of several (test 9)
  // -- an empty list is not a special case that bypasses the payload
  // comparison. Exercised through both the trivially-re-matching-CAS
  // path and the CAS-missed disambiguation path. A follow-up completed
  // through some other path (as in test 8) must also survive, since
  // this retry never legitimately applies. ---
  {
    const db = freshDb("Before.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW, [
      followUp("fu-10-0", 0, "Send site visit invite"),
      followUp("fu-10-1", 1, "Follow up on pledge"),
    ], "save-10");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 2 });
    db.raw().prepare("UPDATE recommendations SET status = 'completed', updated_at = ? WHERE id = 'fu-10-0'").run(NOW + 1);
    const beforeRetry = recommendationRows(db);
    const beforeStatus = db.raw().prepare("SELECT status FROM recommendations WHERE id = 'fu-10-0'").get().status;

    const allRemoved = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "After.", NOW + 5, [], "save-10");
    assert.deepEqual(allRemoved, { status: "conflict", reason: "followup_mismatch" }, "retrying a save identity with every one of its original follow-ups now removed must conflict, never bypass the payload comparison just because the list is empty");
    assert.deepEqual(recommendationRows(db), beforeRetry, "both original follow-ups must survive the rejected retry completely untouched");
    assert.equal(db.raw().prepare("SELECT status FROM recommendations WHERE id = 'fu-10-0'").get().status, beforeStatus, "a follow-up already completed through some other path must stay completed");

    const staleAllRemoved = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "After.", "Before.", NOW + 10, [], "save-10");
    assert.deepEqual(staleAllRemoved, { status: "conflict", reason: "followup_mismatch" }, "the same all-removed payload mismatch must be caught via the CAS-missed disambiguation path too");
    assert.deepEqual(recommendationRows(db), beforeRetry, "both original follow-ups must still survive untouched");
  }

  // --- 11. INDEPENDENT REVIEW GAP 2a, reproduced precisely: reuse a
  // save identity with the SAME follow-up but DIFFERENT notes
  // (`newSummary`). The previous signature covered only the follow-up
  // list, so an identical follow-up set let a changed-notes reuse pass
  // the ledger check completely undetected. Exercised through the
  // trivially-re-matching-CAS path (the summary change is itself what
  // the CAS is matching against, so this reaches the ledger upsert
  // inside the successful batch, not the disambiguation branch). ---
  {
    const db = freshDb("Before.");
    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Original notes.", "Before.", NOW, [followUp("fu-11-0", 0, "Task")], "save-11");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 1 });

    // Same save identity, same follow-up, but DIFFERENT notes -- and a
    // correct, current baseline, so the primary CAS itself would
    // genuinely succeed were it not for the ledger catching the reuse.
    const differentNotes = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Completely different notes reusing the same key.", "Original notes.", NOW + 5, [followUp("fu-11-0", 0, "Task")], "save-11");
    assert.deepEqual(differentNotes, { status: "conflict", reason: "followup_mismatch" }, "reusing a save identity with different notes must be rejected even when the follow-ups are unchanged");
    assert.equal(summary(db), "Original notes.", "the summary must remain exactly what the first, legitimate save under this identity wrote");
    assert.deepEqual(recommendationRows(db), [{ id: "fu-11-0", action: "Task", due_at: null }], "the follow-up must survive the rejected reuse untouched");
  }

  // --- 12. INDEPENDENT REVIEW GAP 2b, reproduced precisely: reuse a
  // save identity against a DIFFERENT target interaction/donor, with
  // the SAME notes and follow-up. The previous signature covered only
  // the follow-up list, so an identical follow-up set let a reused key
  // aimed at an entirely different meeting pass the ledger check
  // undetected. ---
  {
    const db = freshDb("Before.");
    const otherDonorId = "d2";
    const otherInteractionId = "interaction-2";
    db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Other Donor', ?, ?)").bind(otherDonorId, USER_ID, NOW, NOW).run();
    db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, ?, 'trip:scheduled', ?, ?)")
      .bind(otherInteractionId, otherDonorId, USER_ID, NOW, "Before.", NOW, NOW).run();

    const first = await saveConcurrentSummaryAndFollowUps(db, INTERACTION_ID, DONOR_ID, USER_ID, "Shared notes text.", "Before.", NOW, [followUp("fu-12-0", 0, "Task")], "save-12");
    assert.deepEqual(first, { status: "applied", followUpsCreated: 1 });

    // Same save identity, same notes text, same follow-up -- but aimed
    // at a COMPLETELY DIFFERENT interaction/donor.
    const differentTarget = await saveConcurrentSummaryAndFollowUps(db, otherInteractionId, otherDonorId, USER_ID, "Shared notes text.", "Before.", NOW + 5, [followUp("fu-12-0", 0, "Task")], "save-12");
    assert.deepEqual(differentTarget, { status: "conflict", reason: "followup_mismatch" }, "reusing a save identity against a different target must be rejected even when the notes and follow-ups are identical");
    assert.equal(summary(db), "Shared notes text.", "the first target's own interaction must be untouched by the rejected reuse");
    const otherRow = db.raw().prepare("SELECT summary FROM interactions WHERE id = ?").get(otherInteractionId);
    assert.equal(otherRow.summary, "Before.", "the second, rejected target's own interaction must never have been changed");
    assert.deepEqual(recommendationRows(db), [{ id: "fu-12-0", action: "Task", due_at: null }], "no duplicate or second follow-up row was created for the rejected target");
  }

  console.log("meeting-notes-concurrent-save.test.mjs: all assertions passed");
}

await run();
