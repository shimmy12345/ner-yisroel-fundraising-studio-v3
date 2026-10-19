import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLocalD1Database, splitSqlStatements } from "../lib/calendar/testing/local-d1.ts";
import { PRODUCTION_BASELINE_HASH, normalizeSchemaSql } from "../lib/data-health/production-baseline.ts";
import { buildSchemaOnlyBackup } from "../lib/operations/schema-backup.ts";
import { buildCalendarTablesRecoveryStatements } from "../lib/operations/calendar-schema-repair-recovery.ts";

// Rehearses drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql
// (NOT part of the applied migration sequence -- see that file's own
// header) against a REAL local Workers/D1 runtime, before that repair is
// ever proposed for Staging. Linux-CI-only, same convention as
// tests/calendar-d1-store.test.mjs (see that file's own header for why:
// getPlatformProxy() needs a working local `workerd` binary, which this
// project's Windows sandbox cannot run).
//
// What this proves, each against the REAL D1 engine, never a simulation:
//   1. The pre-fix defect is real (Phase 2).
//   2. The repair applies cleanly via a single db.batch(), with every
//      row/column/index/FK preserved and byte-for-byte parity with
//      today's already-corrected migration text (Phases 3-4).
//   3. The restore defect is gone, and the REAL production schema-
//      backup/restore path now succeeds (Phases 5-6).
//   4. The recovery procedure (lib/operations/calendar-schema-repair-
//      recovery.ts, used by scripts/apply-0049-calendar-schema-repair-
//      staging.mjs's own recovery path) actually restores a backup's
//      exact data against a real D1 database in a DIFFERENT state
//      (Phase 7).
//   5. A batch containing a guaranteed failure injected into the REAL
//      parsed repair statements -- at an early point, a point right
//      after a real DROP TABLE has already executed, and a point late
//      in the second rebuild pass -- rolls back EVERY statement in that
//      batch, leaves no stray quarantine table, and the corrected
//      (unmodified) repair still applies successfully afterward on the
//      very same, untouched database (Phase 8).
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

// A fresh, real local D1 database already reproducing "the affected
// Staging schema" with the full synthetic dataset seeded -- the common
// starting point for the main rehearsal AND every failure-injection case
// below, each of which needs its OWN untouched database.
async function createRehearsalDatabase() {
  const { db, dispose } = await createLocalD1Database();
  await applyPreFixBuggySchema(db);
  const { linkCount, historyCount } = await seedSyntheticRecords(db);
  assert.equal(linkCount, 6);
  assert.equal(historyCount, 10);
  return { db, dispose };
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

// Shared verification that the repair was fully and correctly applied --
// used both for the main rehearsal run and after each failure-injection
// case's own retry, so a retry following a rejected attempt is held to
// the EXACT same standard as a clean first attempt.
async function assertRepairAppliedCorrectly(db, before, label) {
  const after = await snapshot(db);
  assert.deepEqual(after.links, before.links, `[${label}] every calendar_event_links row/column must be byte-identical after the rebuild`);
  assert.deepEqual(after.history, before.history, `[${label}] every calendar_event_link_history row/column must be byte-identical after the rebuild`);

  const { results: fkViolations } = await db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(fkViolations, [], `[${label}] PRAGMA foreign_key_check must be clean against real D1 after the repair`);

  const { results: linkIndexes } = await db.prepare("PRAGMA index_list(calendar_event_links)").all();
  assert.ok(linkIndexes.some((i) => i.unique && i.name === "calendar_event_links_interaction_uidx"), `[${label}] missing links interaction uidx`);
  assert.ok(linkIndexes.some((i) => !i.unique && i.name === "calendar_event_links_sync_status_idx"), `[${label}] missing links sync_status idx`);
  const { results: historyIndexes } = await db.prepare("PRAGMA index_list(calendar_event_link_history)").all();
  assert.ok(historyIndexes.some((i) => i.unique && i.name === "calendar_event_link_history_link_generation_uidx"), `[${label}] missing history link/generation uidx`);
  assert.ok(historyIndexes.some((i) => !i.unique && i.name === "calendar_event_link_history_cleanup_idx"), `[${label}] missing history cleanup idx`);

  const { results: historyForeignKeys } = await db.prepare("PRAGMA foreign_key_list(calendar_event_link_history)").all();
  assert.ok(
    historyForeignKeys.some((fk) => fk.table === "calendar_event_links" && fk.from === "link_id" && fk.to === "id"),
    `[${label}] calendar_event_link_history.link_id's FOREIGN KEY to calendar_event_links must be restored, not left off from the intermediate FK-less rebuild`,
  );

  const fixedMigrationSql = fs.readFileSync(CURRENT_MIGRATION_0048_PATH, "utf8");
  const expectedLinksSql = /CREATE TABLE `calendar_event_links` \([\s\S]*?\n\);/.exec(fixedMigrationSql)[0].replace(/;$/, "");
  const expectedHistorySql = /CREATE TABLE `calendar_event_link_history` \([\s\S]*?\n\);/.exec(fixedMigrationSql)[0].replace(/;$/, "");
  const repairedLinksSql = await tableSql(db, "calendar_event_links");
  const repairedHistorySql = await tableSql(db, "calendar_event_link_history");
  assert.equal(normalizeSchemaSql(repairedLinksSql), normalizeSchemaSql(expectedLinksSql), `[${label}] repaired calendar_event_links table text must match today's already-corrected migration exactly`);
  assert.equal(normalizeSchemaSql(repairedHistorySql), normalizeSchemaSql(expectedHistorySql), `[${label}] repaired calendar_event_link_history table text must match today's already-corrected migration exactly`);

  assertRestoreSucceeds(repairedLinksSql);
  assertRestoreSucceeds(repairedHistorySql);
}

async function assertNoStrayQuarantineTables(db, label) {
  const { results: tables } = await db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
  const strays = tables.filter((t) => /_old2?_0049$/.test(t.name));
  assert.deepEqual(strays, [], `[${label}] no stray quarantine table must remain: ${strays.map((t) => t.name).join(", ")}`);
}

// A statement guaranteed to fail (references a table that can never
// exist) regardless of WHERE in the batch it is spliced in -- state-
// independent by construction, so the same injected statement is valid
// at every injection point below.
const GUARANTEED_FAILURE_STATEMENT = "INSERT INTO this_table_absolutely_does_not_exist_0049 (id) VALUES ('x')";

// Injects GUARANTEED_FAILURE_STATEMENT immediately after the given
// (0-indexed) statement in the REAL parsed repair sequence, runs the
// resulting batch against a FRESH real local D1 database with the full
// synthetic dataset, and proves: the whole batch fails; the original
// schema/indexes/foreign keys/every data value are completely
// unchanged; no stray quarantine table remains; and the corrected,
// UNMODIFIED repair can then run successfully on that same database.
async function runFailureInjectionCase(label, repairStatements, injectAfterIndex) {
  const { db, dispose } = await createRehearsalDatabase();
  try {
    const before = await snapshot(db);
    const beforeLinksSql = await tableSql(db, "calendar_event_links");
    const beforeHistorySql = await tableSql(db, "calendar_event_link_history");

    const doomedStatements = [
      ...repairStatements.slice(0, injectAfterIndex + 1),
      GUARANTEED_FAILURE_STATEMENT,
      ...repairStatements.slice(injectAfterIndex + 1),
    ];
    let threw = false;
    try {
      await db.batch(doomedStatements.map((statement) => db.prepare(statement)));
    } catch {
      threw = true;
    }
    assert.ok(threw, `[${label}] injecting a guaranteed failure after statement ${injectAfterIndex} of ${repairStatements.length} must cause the WHOLE batch to fail`);

    // Original state completely unchanged -- including the tables' own
    // stored schema TEXT (not just row data), since several injection
    // points are deliberately placed AFTER a real DROP TABLE of an
    // original table has already executed within the failed attempt.
    const afterFailure = await snapshot(db);
    assert.deepEqual(afterFailure, before, `[${label}] every row/column must be unchanged after the rejected batch -- zero partial state`);
    assert.equal(await tableSql(db, "calendar_event_links"), beforeLinksSql, `[${label}] calendar_event_links' own stored schema text must be unchanged after the rejected batch`);
    assert.equal(await tableSql(db, "calendar_event_link_history"), beforeHistorySql, `[${label}] calendar_event_link_history's own stored schema text must be unchanged after the rejected batch`);
    const { results: fkViolationsAfterFailure } = await db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(fkViolationsAfterFailure, [], `[${label}] foreign_key_check must still be clean after the rejected batch`);
    await assertNoStrayQuarantineTables(db, label);

    // The corrected (unmodified) repair must still succeed afterward, on
    // this SAME, now-confirmed-untouched database.
    await db.batch(repairStatements.map((statement) => db.prepare(statement)));
    await assertRepairAppliedCorrectly(db, before, `${label} (retry after a prior failed attempt)`);
    await assertNoStrayQuarantineTables(db, `${label} (after successful retry)`);
  } finally {
    await dispose();
  }
}

// A representative sample "backup" text in the SAME format `wrangler d1
// export` produces (double-quoted identifiers, one statement per line
// ending in `;`) -- used to rehearse the ACTUAL recovery procedure
// (lib/operations/calendar-schema-repair-recovery.ts) against a real
// local D1 database that is in a DIFFERENT state (the full 6-link/
// 10-history synthetic dataset) than the backup itself (a smaller,
// distinct 2-link/2-history dataset) -- proving recovery replaces
// whatever is currently there with exactly the backup's own content,
// not merely that it runs without error.
function buildSampleRecoveryBackupText() {
  return [
    `CREATE TABLE "calendar_event_links" (`,
    `  \`id\` text PRIMARY KEY NOT NULL,`,
    `  \`interaction_id\` text NOT NULL REFERENCES \`interactions\`(\`id\`),`,
    `  \`user_id\` text NOT NULL REFERENCES \`users\`(\`id\`),`,
    `  \`google_calendar_id\` text DEFAULT 'primary' NOT NULL,`,
    `  \`generation\` integer DEFAULT 0 NOT NULL,`,
    `  \`google_event_id\` text,`,
    `  \`google_etag\` text,`,
    `  \`desired_state\` text DEFAULT 'present' NOT NULL,`,
    `  \`desired_revision\` integer DEFAULT 1 NOT NULL,`,
    `  \`synced_revision\` integer DEFAULT 0 NOT NULL,`,
    `  \`sync_status\` text DEFAULT 'pending' NOT NULL,`,
    `  \`last_error\` text,`,
    `  \`attempt_count\` integer DEFAULT 0 NOT NULL,`,
    `  \`lease_owner\` text,`,
    `  \`lease_expires_at\` integer,`,
    `  \`next_retry_at\` integer,`,
    `  \`created_at\` integer NOT NULL,`,
    `  \`updated_at\` integer NOT NULL,`,
    `  CHECK (\`desired_state\` IN ('present','absent')),`,
    `  CHECK (\`sync_status\` IN ('pending','synced','failed','invalid','auth_required','missing_remotely'))`,
    `);`,
    // Reuses interaction_id values ALREADY seeded by createRehearsalDatabase()
    // (int-pending, int-synced -- see seedSyntheticRecords) -- a backup's
    // own INSERTs are subject to IMMEDIATE foreign-key checking just like
    // any other write, so calendar_event_links.interaction_id's own FK to
    // `interactions` must resolve to a row that actually exists; inventing
    // a fresh, never-seeded interaction id here would (correctly) be
    // rejected by real D1, same as it would on real Staging.
    `INSERT INTO "calendar_event_links" (id,interaction_id,user_id,google_calendar_id,generation,google_event_id,google_etag,desired_state,desired_revision,synced_revision,sync_status,last_error,attempt_count,lease_owner,lease_expires_at,next_retry_at,created_at,updated_at) VALUES('backup-link-1','int-pending','u1','primary',0,NULL,NULL,'present',1,0,'pending',NULL,0,NULL,NULL,NULL,${NOW},${NOW});`,
    `INSERT INTO "calendar_event_links" (id,interaction_id,user_id,google_calendar_id,generation,google_event_id,google_etag,desired_state,desired_revision,synced_revision,sync_status,last_error,attempt_count,lease_owner,lease_expires_at,next_retry_at,created_at,updated_at) VALUES('backup-link-2','int-synced','u1','primary',0,'evt-backup-2',NULL,'present',1,1,'synced',NULL,0,NULL,NULL,NULL,${NOW},${NOW});`,
    `CREATE UNIQUE INDEX "calendar_event_links_interaction_uidx" ON "calendar_event_links" ("interaction_id");`,
    `CREATE INDEX "calendar_event_links_sync_status_idx" ON "calendar_event_links" ("sync_status");`,
    `CREATE TABLE "calendar_event_link_history" (`,
    `  \`id\` text PRIMARY KEY NOT NULL,`,
    `  \`link_id\` text NOT NULL REFERENCES \`calendar_event_links\`(\`id\`),`,
    `  \`generation\` integer NOT NULL,`,
    `  \`google_event_id\` text NOT NULL,`,
    `  \`create_status\` text DEFAULT 'not_attempted' NOT NULL,`,
    `  \`cleanup_needed\` integer DEFAULT 0 NOT NULL,`,
    `  \`cleanup_status\` text DEFAULT 'not_needed' NOT NULL,`,
    `  \`cleanup_attempts\` integer DEFAULT 0 NOT NULL,`,
    `  \`created_at\` integer NOT NULL,`,
    `  \`updated_at\` integer NOT NULL,`,
    `  CHECK (\`create_status\` IN ('not_attempted','in_flight','succeeded','failed','invalid')),`,
    `  CHECK (\`cleanup_status\` IN ('not_needed','pending','uncertain','done'))`,
    `);`,
    `INSERT INTO "calendar_event_link_history" (id,link_id,generation,google_event_id,create_status,cleanup_needed,cleanup_status,cleanup_attempts,created_at,updated_at) VALUES('backup-hist-1','backup-link-1',0,'evt-backup-hist-1','not_attempted',0,'not_needed',0,${NOW},${NOW});`,
    `INSERT INTO "calendar_event_link_history" (id,link_id,generation,google_event_id,create_status,cleanup_needed,cleanup_status,cleanup_attempts,created_at,updated_at) VALUES('backup-hist-2','backup-link-2',0,'evt-backup-hist-2','succeeded',0,'not_needed',0,${NOW},${NOW});`,
    `CREATE UNIQUE INDEX "calendar_event_link_history_link_generation_uidx" ON "calendar_event_link_history" ("link_id","generation");`,
    `CREATE INDEX "calendar_event_link_history_cleanup_idx" ON "calendar_event_link_history" ("cleanup_needed","cleanup_status");`,
  ].join("\n");
}

async function run() {
  // =========================================================================
  // Main rehearsal: Phases 1-6, against one database.
  // =========================================================================
  {
    const { db, dispose } = await createRehearsalDatabase();
    try {
      const before = await snapshot(db);
      assert.equal(before.links.length, 6, "setup sanity: all six synthetic links must exist before the repair");
      assert.equal(before.history.length, 10, "setup sanity: all ten synthetic history rows must exist before the repair");

      // =====================================================================
      // Phase 2: the pre-fix defect is real against this exact stored
      // schema text, via the REAL normalizeSchemaSql() the production
      // backup path uses -- not assumed, not merely re-asserted from a
      // prior round.
      // =====================================================================
      const buggyLinksSql = await tableSql(db, "calendar_event_links");
      const buggyHistorySql = await tableSql(db, "calendar_event_link_history");
      assert.match(buggyLinksSql, /next_retry_at/, "sanity: this must be the real stored schema, not an empty result");
      assertRestoreSyntaxError(buggyLinksSql, "CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`)");
      assertRestoreSyntaxError(buggyHistorySql, "CREATE UNIQUE INDEX `calendar_event_link_history_link_generation_uidx` ON `calendar_event_link_history` (`link_id`,`generation`)");

      // =====================================================================
      // Phase 3: apply the repair -- EXACTLY the mechanism proposed for
      // Staging, a single db.batch() call built from the real migration
      // file's own statements.
      // =====================================================================
      const repairStatements = readMigrationBatchStatements(REPAIR_MIGRATION_PATH);
      assert.ok(repairStatements.length >= 14, "sanity: the repair migration must parse into its full set of statements");
      await db.batch(repairStatements.map((statement) => db.prepare(statement)));

      // =====================================================================
      // Phase 4: every row/column/index/FK survived, and the repaired text
      // matches today's already-corrected migration exactly. Phase 5 (the
      // restore defect is gone) is included inside this same helper.
      // =====================================================================
      await assertRepairAppliedCorrectly(db, before, "main rehearsal");
      await assertNoStrayQuarantineTables(db, "main rehearsal");

      // =====================================================================
      // Phase 6: the actual, real production schema-backup/restore path --
      // buildSchemaOnlyBackup(), the exact function
      // tests/production-backup-readiness.test.mjs exercises -- now
      // succeeds against this repaired, REAL D1 database's own full
      // schema (every migration, not just the calendar tables), and the
      // resulting backup restores cleanly into a fresh database with a
      // clean integrity check, no foreign-key violations, and zero
      // business rows (schema-only).
      //
      // CONFIRMED PLATFORM LIMITATION: D1 rejects `PRAGMA integrity_check`
      // over the Workers binding itself with `D1_ERROR: not authorized:
      // SQLITE_AUTH` -- there is no way to run that specific check
      // directly against a live D1 database; it is only exercised here
      // against the restored copy, which is plain node:sqlite, not D1.
      // =====================================================================
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

      process.stdout.write("calendar-schema-repair-rehearsal.test.mjs: main rehearsal (Phases 1-6) passed against a REAL local D1 binding\n");
    } finally {
      await dispose();
    }
  }

  // =========================================================================
  // Phase 7: the recovery procedure (lib/operations/calendar-schema-repair-
  // recovery.ts) actually restores a backup's exact content against a
  // real local D1 database that is in a DIFFERENT state -- not just that
  // the statement-building logic produces plausible-looking text
  // (tests/calendar-schema-repair-recovery.test.mjs already covers that
  // offline), but that APPLYING it via db.batch() against real D1
  // genuinely replaces the current (different) data with the backup's own.
  // =========================================================================
  {
    const { db, dispose } = await createRehearsalDatabase();
    try {
      const beforeRecovery = await snapshot(db);
      assert.equal(beforeRecovery.links.length, 6, "setup sanity: the database must start with the full synthetic dataset, deliberately DIFFERENT from the backup being recovered");

      const backupText = buildSampleRecoveryBackupText();
      const recoveryStatements = buildCalendarTablesRecoveryStatements(backupText);
      await db.batch(recoveryStatements.map((statement) => db.prepare(statement)));

      const afterRecovery = await snapshot(db);
      assert.equal(afterRecovery.links.length, 2, "recovery must replace the prior 6 links with exactly the backup's own 2");
      assert.deepEqual(afterRecovery.links.map((l) => l.id).sort(), ["backup-link-1", "backup-link-2"]);
      assert.equal(afterRecovery.history.length, 2, "recovery must replace the prior 10 history rows with exactly the backup's own 2");
      assert.deepEqual(afterRecovery.history.map((h) => h.id).sort(), ["backup-hist-1", "backup-hist-2"]);

      const { results: fkViolations } = await db.prepare("PRAGMA foreign_key_check").all();
      assert.deepEqual(fkViolations, [], "recovered schema must have a clean foreign_key_check");
      const { results: historyForeignKeys } = await db.prepare("PRAGMA foreign_key_list(calendar_event_link_history)").all();
      assert.ok(historyForeignKeys.some((fk) => fk.table === "calendar_event_links" && fk.from === "link_id" && fk.to === "id"), "recovered calendar_event_link_history must have its FOREIGN KEY to calendar_event_links");
      const { results: linkIndexes } = await db.prepare("PRAGMA index_list(calendar_event_links)").all();
      assert.ok(linkIndexes.some((i) => i.unique && i.name === "calendar_event_links_interaction_uidx"), "recovered calendar_event_links must have its unique index");

      process.stdout.write("calendar-schema-repair-rehearsal.test.mjs: recovery procedure (Phase 7) passed against a REAL local D1 binding\n");
    } finally {
      await dispose();
    }
  }

  // =========================================================================
  // Phase 8: failure injection into the REAL parsed repair statements, at
  // three points -- early, right after a real DROP TABLE has already
  // executed, and late in the second rebuild pass -- each against its
  // OWN fresh real local D1 database.
  // =========================================================================
  {
    const repairStatements = readMigrationBatchStatements(REPAIR_MIGRATION_PATH);
    assert.ok(repairStatements.length >= 14, "sanity: the repair migration must parse into its full set of statements");

    // index 0: ALTER TABLE calendar_event_link_history RENAME TO ..._old_0049
    //   -- early: the ORIGINAL history table no longer exists under its
    //   real name by this point, even though almost nothing else has run.
    await runFailureInjectionCase("early (right after the first rename)", repairStatements, 0);

    // index 7: DROP TABLE calendar_event_links_old_0049 -- mid, right
    //   after a REAL DROP TABLE of the original links backup has already
    //   executed: by this point calendar_event_links has already been
    //   fully rebuilt and its only old copy destroyed.
    await runFailureInjectionCase("mid (right after calendar_event_links_old_0049 is dropped)", repairStatements, 7);

    // index 13: DROP TABLE calendar_event_link_history_old2_0049 -- late:
    //   only the final two CREATE INDEX statements remain; proves even
    //   this close to completion, failure still rolls back EVERYTHING,
    //   including the FIRST table's entire rebuild many statements earlier.
    await runFailureInjectionCase("late (right after the second history rebuild's DROP, near the very end)", repairStatements, 13);

    process.stdout.write("calendar-schema-repair-rehearsal.test.mjs: failure injection (Phase 8, 3 cases) passed against REAL local D1 bindings\n");
  }

  process.stdout.write("calendar-schema-repair-rehearsal.test.mjs: all assertions passed against a REAL local D1 binding\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
