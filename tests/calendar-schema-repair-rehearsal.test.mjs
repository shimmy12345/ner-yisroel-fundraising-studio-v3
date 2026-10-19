import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalD1Database, splitSqlStatements } from "../lib/calendar/testing/local-d1.ts";
import { PRODUCTION_BASELINE_HASH, normalizeSchemaSql } from "../lib/data-health/production-baseline.ts";
import { buildSchemaOnlyBackup } from "../lib/operations/schema-backup.ts";

// Rehearses drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql
// (NOT part of the applied migration sequence -- see that file's own
// header) against a REAL local Workers/D1 runtime, before that repair is
// ever proposed for Staging. Linux-CI-only, same convention as
// tests/calendar-d1-store.test.mjs (see that file's own header for why:
// getPlatformProxy() needs a working local `workerd` binary, which this
// project's Windows sandbox cannot run).
//
// What this proves, each against the REAL D1 engine, never a simulation:
//   1. The pre-fix defect is real: migration 0048's ORIGINAL buggy
//      `CREATE TABLE` text (reconstructed byte-for-byte from
//      `git show bf8a8ed:drizzle/0048_google_calendar_sync.sql`, the
//      parent of fix commit d153259) stores a comment inside the column
//      list; once collapsed by the real normalizeSchemaSql() the actual
//      production schema-backup path uses, it reproduces a genuine SQL
//      syntax error on restore.
//   2. The repair is a correct, D1-supported, single db.batch() rebuild
//      that never drops a table while anything else's declared FOREIGN
//      KEY still points at it -- an EARLIER draft instead relied on
//      `PRAGMA defer_foreign_keys = on` (after `PRAGMA foreign_keys=OFF`
//      was confirmed to have no effect on D1 at all), modeled on
//      ordinary SQLite's own documented procedure for this exact
//      scenario, but this rehearsal's own first real-D1 run proved THAT
//      version unreliable: D1 rejected the batch with "Durable Object
//      was reset ... FOREIGN KEY constraint failed" at the DROP TABLE
//      step, a confirmed, currently open/unresolved upstream limitation
//      (cloudflare/workerd#7657, cloudflare/workers-sdk#16071) --
//      `defer_foreign_keys`'s SQL-level deferral window is not reliably
//      honored by D1's own commit-time consistency check. The current
//      draft instead rebuilds calendar_event_link_history WITHOUT its
//      FK first (removing the only reference to calendar_event_links),
//      rebuilds calendar_event_links, then rebuilds
//      calendar_event_link_history a second time WITH the FK restored
//      -- every individual statement is valid the instant it runs, so
//      no deferred-constraint behavior of any kind is ever relied upon.
//   3. Every row and column survives the rebuild unchanged, every index
//      and constraint is correct afterward, `PRAGMA foreign_key_check`
//      and `PRAGMA integrity_check` both pass, and the REAL
//      buildSchemaOnlyBackup()-based schema-backup/restore path (the
//      same function production-backup-readiness.test.mjs exercises)
//      now succeeds against the repaired schema.
//   4. A rejected/interrupted repair-shaped batch leaves ZERO partial
//      state: no stray rebuild-named table, no row lost or changed.
//
// NOT run as part of `pnpm test` / scripts/run-tests.mjs -- run explicitly
// via `pnpm run test:calendar-d1`, which this repo's CI runs on an Ubuntu
// runner (.github/workflows/calendar-d1-adapter-test.yml). Never applies
// anything to any remote database: `createLocalD1Database()` is
// `persist: false` + `remoteBindings: false`, a fresh in-process-only
// database every run.

const root = path.resolve(import.meta.dirname, "..");
const REPAIR_MIGRATION_PATH = path.join(root, "drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql");
const CURRENT_MIGRATION_0048_PATH = path.join(root, "drizzle/0048_google_calendar_sync.sql");

const NOW = 1_000_000;

// Byte-for-byte the two CREATE TABLE statements migration 0048 actually
// shipped with before the fix (git show bf8a8ed:drizzle/0048_google_calendar_sync.sql,
// the parent of fix commit d153259) -- a comment sits INSIDE each column
// list, violating this migration file's own documented convention
// ("every comment belongs BEFORE the whole CREATE statement"). This is
// what Staging's real tables were actually created from.
const BUGGY_CALENDAR_EVENT_LINKS_SQL = `CREATE TABLE \`calendar_event_links\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`interaction_id\` text NOT NULL REFERENCES \`interactions\`(\`id\`),
  \`user_id\` text NOT NULL REFERENCES \`users\`(\`id\`),
  \`google_calendar_id\` text DEFAULT 'primary' NOT NULL,
  \`generation\` integer DEFAULT 0 NOT NULL,
  \`google_event_id\` text,
  \`google_etag\` text,
  \`desired_state\` text DEFAULT 'present' NOT NULL,
  \`desired_revision\` integer DEFAULT 1 NOT NULL,
  \`synced_revision\` integer DEFAULT 0 NOT NULL,
  \`sync_status\` text DEFAULT 'pending' NOT NULL,
  \`last_error\` text,
  \`attempt_count\` integer DEFAULT 0 NOT NULL,
  \`lease_owner\` text,
  \`lease_expires_at\` integer,
  -- 2026-10-19 review, issue 2: bounded-backoff scheduling for a
  -- 'failed' link -- null means eligible now (no backoff in effect).
  -- Never consulted for 'invalid'/'auth_required', which are excluded
  -- from automatic reconciliation entirely regardless of this value.
  \`next_retry_at\` integer,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL,
  CHECK (\`desired_state\` IN ('present','absent')),
  -- 2026-10-19 review, issue 2: 'invalid' (a definitive, permanent
  -- rejection -- this app's own pre-mutation validation or a real
  -- Google 400 -- never auto-retried) and 'auth_required' (a 401/403,
  -- an authentication/configuration problem, also never auto-retried)
  -- added -- see calendar-sync-types.ts's own SyncStatus doc comment.
  CHECK (\`sync_status\` IN ('pending','synced','failed','invalid','auth_required','missing_remotely'))
)`;

const BUGGY_CALENDAR_EVENT_LINK_HISTORY_SQL = `CREATE TABLE \`calendar_event_link_history\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`link_id\` text NOT NULL REFERENCES \`calendar_event_links\`(\`id\`),
  \`generation\` integer NOT NULL,
  \`google_event_id\` text NOT NULL,
  \`create_status\` text DEFAULT 'not_attempted' NOT NULL,
  \`cleanup_needed\` integer DEFAULT 0 NOT NULL,
  \`cleanup_status\` text DEFAULT 'not_needed' NOT NULL,
  \`cleanup_attempts\` integer DEFAULT 0 NOT NULL,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL,
  -- 2026-10-19 review, issue 2: 'invalid' added -- a DEFINITIVE,
  -- PERMANENT rejection of this generation's create attempt (a real
  -- Google 400), distinct from 'in_flight' (genuinely ambiguous --
  -- timeout/network/malformed response) -- see
  -- calendar-sync-types.ts's own CreateStatus doc comment.
  CHECK (\`create_status\` IN ('not_attempted','in_flight','succeeded','failed','invalid')),
  CHECK (\`cleanup_status\` IN ('not_needed','pending','uncertain','done'))
)`;

function readMigrationBatchStatements(filePath) {
  return splitSqlStatements(fs.readFileSync(filePath, "utf8"));
}

// Reproduces "the affected Staging schema" in place: drops the two
// calendar tables createLocalD1Database() just created from the CURRENT,
// already-fixed migration 0048, and recreates them from the ORIGINAL
// buggy text instead -- same columns, same indexes, same constraints,
// only the broken comment placement differs. Both tables are still
// empty at this point, so dropping the parent while the (empty) child
// still exists is not itself a foreign-key violation.
async function applyPreFixBuggySchema(db) {
  await db.prepare("DROP TABLE `calendar_event_link_history`").run();
  await db.prepare("DROP TABLE `calendar_event_links`").run();
  await db.prepare(BUGGY_CALENDAR_EVENT_LINKS_SQL).run();
  await db.prepare("CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`)").run();
  await db.prepare("CREATE INDEX `calendar_event_links_sync_status_idx` ON `calendar_event_links` (`sync_status`)").run();
  await db.prepare(BUGGY_CALENDAR_EVENT_LINK_HISTORY_SQL).run();
  await db.prepare("CREATE UNIQUE INDEX `calendar_event_link_history_link_generation_uidx` ON `calendar_event_link_history` (`link_id`,`generation`)").run();
  await db.prepare("CREATE INDEX `calendar_event_link_history_cleanup_idx` ON `calendar_event_link_history` (`cleanup_needed`,`cleanup_status`)").run();
}

async function seedBaseEntities(db, { userId, donorId }) {
  await db.prepare("INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(userId, `${userId}@example.test`, NOW, NOW).run();
  await db.prepare("INSERT OR IGNORE INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Test Donor', ?, ?)").bind(donorId, userId, NOW, NOW).run();
}

async function seedInteraction(db, { interactionId, userId, donorId }) {
  await db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, created_at, updated_at) VALUES (?, ?, ?, 'meeting', ?, 'Meeting', ?, ?)").bind(interactionId, donorId, userId, NOW + 86400, NOW, NOW).run();
}

async function insertLink(db, link) {
  await db
    .prepare(
      "INSERT INTO calendar_event_links (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, next_retry_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      link.id, link.interactionId, link.userId, "primary", link.generation, link.googleEventId ?? null, null,
      "present", 1, link.generation + 1, link.syncStatus, null, 0, null, null, null, NOW, NOW,
    )
    .run();
}

async function insertHistory(db, history) {
  await db
    .prepare(
      "INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(history.id, history.linkId, history.generation, history.googleEventId, history.createStatus, history.cleanupNeeded ? 1 : 0, history.cleanupStatus, 0, NOW, NOW)
    .run();
}

// Six links covering every SyncStatus value, three of them spanning
// multiple generations (a cancel-then-reopen cycle), with history rows
// covering every CleanupStatus value including two genuinely PENDING
// cleanups (cleanup_status 'pending' and 'uncertain') that must survive
// the rebuild untouched.
async function seedSyntheticRecords(db) {
  await seedBaseEntities(db, { userId: "u1", donorId: "d1" });

  const links = [
    { id: "link-pending", interactionId: "int-pending", generation: 0, syncStatus: "pending" },
    { id: "link-synced", interactionId: "int-synced", generation: 0, syncStatus: "synced", googleEventId: "evt-synced-0" },
    { id: "link-failed", interactionId: "int-failed", generation: 2, syncStatus: "failed" },
    { id: "link-invalid", interactionId: "int-invalid", generation: 1, syncStatus: "invalid" },
    { id: "link-auth", interactionId: "int-auth", generation: 0, syncStatus: "auth_required" },
    { id: "link-missing", interactionId: "int-missing", generation: 1, syncStatus: "missing_remotely" },
  ];
  for (const link of links) {
    await seedInteraction(db, { interactionId: link.interactionId, userId: "u1", donorId: "d1" });
    await insertLink(db, { ...link, userId: "u1" });
  }

  const history = [
    { id: "hist-pending-0", linkId: "link-pending", generation: 0, googleEventId: "evt-pending-0", createStatus: "not_attempted", cleanupNeeded: false, cleanupStatus: "not_needed" },
    { id: "hist-synced-0", linkId: "link-synced", generation: 0, googleEventId: "evt-synced-0", createStatus: "succeeded", cleanupNeeded: false, cleanupStatus: "not_needed" },
    // link-failed: three generations -- an old, already-cleaned-up
    // generation, a PENDING cleanup generation, and the current failed one.
    { id: "hist-failed-0", linkId: "link-failed", generation: 0, googleEventId: "evt-failed-0", createStatus: "succeeded", cleanupNeeded: true, cleanupStatus: "done" },
    { id: "hist-failed-1", linkId: "link-failed", generation: 1, googleEventId: "evt-failed-1", createStatus: "succeeded", cleanupNeeded: true, cleanupStatus: "pending" },
    { id: "hist-failed-2", linkId: "link-failed", generation: 2, googleEventId: "evt-failed-2", createStatus: "failed", cleanupNeeded: false, cleanupStatus: "not_needed" },
    { id: "hist-invalid-0", linkId: "link-invalid", generation: 0, googleEventId: "evt-invalid-0", createStatus: "invalid", cleanupNeeded: false, cleanupStatus: "not_needed" },
    { id: "hist-invalid-1", linkId: "link-invalid", generation: 1, googleEventId: "evt-invalid-1", createStatus: "in_flight", cleanupNeeded: false, cleanupStatus: "not_needed" },
    { id: "hist-auth-0", linkId: "link-auth", generation: 0, googleEventId: "evt-auth-0", createStatus: "in_flight", cleanupNeeded: false, cleanupStatus: "not_needed" },
    // link-missing: an UNCERTAIN pending cleanup on the old generation
    // (a 404/410 delete while create_status was still in flight -- must
    // never be silently treated as 'done').
    { id: "hist-missing-0", linkId: "link-missing", generation: 0, googleEventId: "evt-missing-0", createStatus: "succeeded", cleanupNeeded: true, cleanupStatus: "uncertain" },
    { id: "hist-missing-1", linkId: "link-missing", generation: 1, googleEventId: "evt-missing-1", createStatus: "succeeded", cleanupNeeded: false, cleanupStatus: "not_needed" },
  ];
  for (const row of history) await insertHistory(db, row);

  return { linkCount: links.length, historyCount: history.length };
}

async function snapshot(db) {
  const links = (await db.prepare("SELECT * FROM calendar_event_links ORDER BY id").all()).results;
  const history = (await db.prepare("SELECT * FROM calendar_event_link_history ORDER BY id").all()).results;
  return { links, history };
}

async function tableSql(db, name) {
  const row = (await db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").bind(name).all()).results[0];
  return row ? String(row.sql) : null;
}

// Proves the restore defect directly, using the SAME normalizeSchemaSql()
// the real production schema-backup path (lib/operations/schema-backup.ts)
// uses: collapse the stored CREATE TABLE text to one line, then try to
// actually execute it as a fresh CREATE TABLE. The embedded `--` comment,
// once there is no newline left to end it, swallows the rest of the
// statement (including its own closing paren/semicolon), so the very
// next statement's text gets parsed as a continuation -- a genuine syntax
// error, not a theoretical one.
function assertRestoreSyntaxError(createTableSql, nextStatementSql) {
  const normalized = normalizeSchemaSql(createTableSql);
  const restoreAttempt = new DatabaseSync(":memory:");
  try {
    assert.throws(
      () => restoreAttempt.exec(`${normalized};\n${nextStatementSql};`),
      /syntax error/i,
      "the pre-fix buggy stored schema text must reproduce a genuine SQL syntax error once normalized, the same way the real schema-backup/restore path does",
    );
  } finally {
    restoreAttempt.close();
  }
}

function assertRestoreSucceeds(createTableSql) {
  const normalized = normalizeSchemaSql(createTableSql);
  const restoreAttempt = new DatabaseSync(":memory:");
  try {
    assert.doesNotThrow(() => restoreAttempt.exec(`${normalized};`), "the repaired stored schema text must restore cleanly with no syntax error");
  } finally {
    restoreAttempt.close();
  }
}

async function run() {
  const { db, dispose } = await createLocalD1Database();
  try {
    // =======================================================================
    // Phase 1: reproduce the affected (pre-fix) Staging schema, then seed
    // synthetic records -- multiple links, multiple generations, pending
    // cleanup, every representative sync/cleanup state.
    // =======================================================================
    await applyPreFixBuggySchema(db);
    const { linkCount, historyCount } = await seedSyntheticRecords(db);
    assert.equal(linkCount, 6);
    assert.equal(historyCount, 10);

    const before = await snapshot(db);
    assert.equal(before.links.length, 6, "setup sanity: all six synthetic links must exist before the repair");
    assert.equal(before.history.length, 10, "setup sanity: all ten synthetic history rows must exist before the repair");

    // =======================================================================
    // Phase 2: the pre-fix defect is real against this exact stored schema
    // text, via the REAL normalizeSchemaSql() the production backup path
    // uses -- not assumed, not merely re-asserted from a prior round.
    // =======================================================================
    const buggyLinksSql = await tableSql(db, "calendar_event_links");
    const buggyHistorySql = await tableSql(db, "calendar_event_link_history");
    assert.match(buggyLinksSql, /next_retry_at/, "sanity: this must be the real stored schema, not an empty result");
    assertRestoreSyntaxError(buggyLinksSql, "CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`)");
    assertRestoreSyntaxError(buggyHistorySql, "CREATE UNIQUE INDEX `calendar_event_link_history_link_generation_uidx` ON `calendar_event_link_history` (`link_id`,`generation`)");

    // =======================================================================
    // Phase 3: apply the repair -- EXACTLY the mechanism proposed for
    // Staging, a single db.batch() call built from the real migration
    // file's own statements (PRAGMA defer_foreign_keys = on; two
    // create-rebuild-drop-rename sequences; four index recreations).
    // This is the empirical confirmation this round's instruction asked
    // for: does D1 actually support `defer_foreign_keys` and DDL mixed
    // with DML inside one db.batch()?
    // =======================================================================
    const repairStatements = readMigrationBatchStatements(REPAIR_MIGRATION_PATH);
    assert.ok(repairStatements.length >= 14, "sanity: the repair migration must parse into its full set of statements (two rebuild passes over calendar_event_link_history plus one over calendar_event_links)");
    await db.batch(repairStatements.map((statement) => db.prepare(statement)));

    // =======================================================================
    // Phase 4: every row and column survived, every index/constraint is
    // correct, and real D1's own foreign_key_check/integrity_check both
    // pass against the repaired schema.
    // =======================================================================
    const after = await snapshot(db);
    assert.deepEqual(after.links, before.links, "every calendar_event_links row/column must be byte-identical after the rebuild");
    assert.deepEqual(after.history, before.history, "every calendar_event_link_history row/column must be byte-identical after the rebuild");

    const { results: fkViolations } = await db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(fkViolations, [], "PRAGMA foreign_key_check must be clean against real D1 after the repair");
    const integrity = await db.prepare("PRAGMA integrity_check").all();
    assert.equal(integrity.results[0].integrity_check, "ok");

    const { results: linkIndexes } = await db.prepare("PRAGMA index_list(calendar_event_links)").all();
    assert.ok(linkIndexes.some((i) => i.unique && i.name === "calendar_event_links_interaction_uidx"));
    assert.ok(linkIndexes.some((i) => !i.unique && i.name === "calendar_event_links_sync_status_idx"));
    const { results: historyIndexes } = await db.prepare("PRAGMA index_list(calendar_event_link_history)").all();
    assert.ok(historyIndexes.some((i) => i.unique && i.name === "calendar_event_link_history_link_generation_uidx"));
    assert.ok(historyIndexes.some((i) => !i.unique && i.name === "calendar_event_link_history_cleanup_idx"));

    // calendar_event_link_history was rebuilt WITHOUT its FK first (to
    // let calendar_event_links be dropped safely) and then a second time
    // WITH it restored -- confirm the FK genuinely came back, not just
    // that the column still exists.
    const { results: historyForeignKeys } = await db.prepare("PRAGMA foreign_key_list(calendar_event_link_history)").all();
    assert.ok(
      historyForeignKeys.some((fk) => fk.table === "calendar_event_links" && fk.from === "link_id" && fk.to === "id"),
      "calendar_event_link_history.link_id's FOREIGN KEY to calendar_event_links must be restored after the repair, not left off from the intermediate FK-less rebuild",
    );

    // The repaired tables' own stored CREATE TABLE text must now be
    // byte-identical (once normalized) to what today's already-corrected
    // migration 0048 itself produces -- full parity with a brand-new
    // environment, not merely "no longer broken".
    const fixedMigrationSql = fs.readFileSync(CURRENT_MIGRATION_0048_PATH, "utf8");
    const expectedLinksSql = /CREATE TABLE `calendar_event_links` \([\s\S]*?\n\);/.exec(fixedMigrationSql)[0].replace(/;$/, "");
    const expectedHistorySql = /CREATE TABLE `calendar_event_link_history` \([\s\S]*?\n\);/.exec(fixedMigrationSql)[0].replace(/;$/, "");
    const repairedLinksSql = await tableSql(db, "calendar_event_links");
    const repairedHistorySql = await tableSql(db, "calendar_event_link_history");
    assert.equal(normalizeSchemaSql(repairedLinksSql), normalizeSchemaSql(expectedLinksSql), "the repaired calendar_event_links table text must match today's already-corrected migration exactly");
    assert.equal(normalizeSchemaSql(repairedHistorySql), normalizeSchemaSql(expectedHistorySql), "the repaired calendar_event_link_history table text must match today's already-corrected migration exactly");

    // =======================================================================
    // Phase 5: the restore defect is gone -- each repaired table's own
    // stored text now restores cleanly, via the same real
    // normalizeSchemaSql() helper.
    // =======================================================================
    assertRestoreSucceeds(repairedLinksSql);
    assertRestoreSucceeds(repairedHistorySql);

    // =======================================================================
    // Phase 6: the actual, real production schema-backup/restore path --
    // buildSchemaOnlyBackup(), the exact function
    // tests/production-backup-readiness.test.mjs exercises -- now succeeds
    // against this repaired, REAL D1 database's own full schema (every
    // migration, not just the calendar tables), and the resulting backup
    // SQL restores cleanly into a fresh database with a clean integrity
    // check, no foreign-key violations, and zero business rows (schema-only).
    // =======================================================================
    const schemaHash = PRODUCTION_BASELINE_HASH;
    const markerCreatedAt = NOW;
    await db.prepare("CREATE TABLE `production_schema_baseline` (`id` text PRIMARY KEY NOT NULL CHECK (`id` = '0019'), `schema_hash` text NOT NULL, `created_at` integer NOT NULL)").run();
    await db.prepare("INSERT INTO production_schema_baseline (id, schema_hash, created_at) VALUES ('0019', ?, ?)").bind(schemaHash, markerCreatedAt).run();

    const { results: liveSchemaRows } = await db
      .prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name")
      .all();
    const marker = { schema_hash: schemaHash, created_at: markerCreatedAt };
    const backupSql = buildSchemaOnlyBackup(liveSchemaRows, marker);

    const restored = new DatabaseSync(":memory:");
    try {
      restored.exec(backupSql);
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(restored.prepare("SELECT schema_hash FROM production_schema_baseline WHERE id='0019'").get().schema_hash, schemaHash);
      assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM calendar_event_links").get().n, 0, "a schema-only backup must restore with zero business rows, never the real synthetic data");
    } finally {
      restored.close();
    }

    // =======================================================================
    // Phase 7: failure handling -- a rejected/interrupted repair-shaped
    // batch must leave ZERO partial state. Re-attempt a rebuild of
    // calendar_event_links with a deliberately-failing statement spliced
    // in (a NULL primary key, guaranteed to violate NOT NULL) and confirm
    // the WHOLE batch rolls back: no stray rebuild-named table left
    // behind, and the table's real data completely unchanged.
    // =======================================================================
    const beforeFailureAttempt = await snapshot(db);
    const doomedBatch = [
      db.prepare(
        "CREATE TABLE `calendar_event_links_rebuild_0049_doomed` (`id` text PRIMARY KEY NOT NULL, `interaction_id` text NOT NULL, `user_id` text NOT NULL, `google_calendar_id` text NOT NULL, `generation` integer NOT NULL, `google_event_id` text, `google_etag` text, `desired_state` text NOT NULL, `desired_revision` integer NOT NULL, `synced_revision` integer NOT NULL, `sync_status` text NOT NULL, `last_error` text, `attempt_count` integer NOT NULL, `lease_owner` text, `lease_expires_at` integer, `next_retry_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
      ),
      db.prepare(
        "INSERT INTO calendar_event_links_rebuild_0049_doomed (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, next_retry_at, created_at, updated_at) SELECT id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, next_retry_at, created_at, updated_at FROM calendar_event_links",
      ),
      // Deliberately doomed: a NULL primary key violates NOT NULL and
      // must fail this statement, and therefore the whole batch.
      db.prepare("INSERT INTO calendar_event_links_rebuild_0049_doomed (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, next_retry_at, created_at, updated_at) VALUES (NULL,'x','x','primary',0,NULL,NULL,'present',1,0,'pending',NULL,0,NULL,NULL,NULL,0,0)"),
      db.prepare("DROP TABLE `calendar_event_links`"),
      db.prepare("ALTER TABLE `calendar_event_links_rebuild_0049_doomed` RENAME TO `calendar_event_links`"),
    ];
    let doomedBatchThrew = false;
    try {
      await db.batch(doomedBatch);
    } catch {
      doomedBatchThrew = true;
    }
    assert.ok(doomedBatchThrew, "a batch containing a guaranteed-to-fail statement must throw, never silently partially apply");

    const { results: strayRebuildTable } = await db.prepare("SELECT name FROM sqlite_schema WHERE name='calendar_event_links_rebuild_0049_doomed'").all();
    assert.deepEqual(strayRebuildTable, [], "the whole doomed batch must roll back together -- no stray rebuild table left behind, even though its CREATE and first INSERT would have succeeded on their own");

    const afterFailureAttempt = await snapshot(db);
    assert.deepEqual(afterFailureAttempt, beforeFailureAttempt, "a rejected/interrupted repair-shaped batch must leave the real table completely unchanged -- zero partial state, zero lost data");

    process.stdout.write("calendar-schema-repair-rehearsal.test.mjs: all assertions passed against a REAL local D1 binding\n");
  } finally {
    await dispose();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
