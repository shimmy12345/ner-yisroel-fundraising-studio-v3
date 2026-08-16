import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNDRAISING_DATA_TABLES } from '../lib/data-health/production-baseline.ts';
import { STAGING_RESET_TABLE_ORDER } from '../lib/operations/staging-reset.ts';
import {
  D1_RESTORE_DATA_ORDER,
  D1_RESTORE_SKIP_DATA_TABLES,
  parseRestoreStatements,
  planD1Restore,
  reorderD1ExportForRestore,
} from '../lib/operations/d1-restore-order.ts';

// A small, hand-built fixture reproducing the exact shape that caused the
// real failure: `donors` (with a foreign key to `users`) is created and
// populated BEFORE `users` itself, matching how `wrangler d1 export`
// actually orders fundraising-os-staging-db's real tables (by
// sqlite_master position, not by dependency). Also includes a multi-line
// CREATE TABLE block, a CREATE INDEX, and the trailing
// ANALYZE/sqlite_stat1 statements `wrangler d1 export` appends, so the
// parser is exercised against every statement shape it has to handle for
// real.
const FIXTURE = [
  'PRAGMA defer_foreign_keys=TRUE;',
  'CREATE TABLE `donors` (',
  '  `id` text PRIMARY KEY NOT NULL,',
  '  `owner_user_id` text NOT NULL,',
  '  FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`)',
  ');',
  'CREATE TABLE `users` (',
  '  `id` text PRIMARY KEY NOT NULL',
  ');',
  'CREATE INDEX `donors_owner_idx` ON `donors` (`owner_user_id`);',
  'INSERT INTO "donors" ("id","owner_user_id") VALUES(\'donor-1\',\'user-1\');',
  'INSERT INTO "users" ("id") VALUES(\'user-1\');',
  'ANALYZE sqlite_schema;',
  'INSERT INTO "sqlite_stat1" ("tbl","idx","stat") VALUES(\'donors\',\'donors_owner_idx\',\'1 1\');',
].join('\n') + '\n';

test('D1_RESTORE_DATA_ORDER covers every fundraising table plus the three true roots, with no duplicates', () => {
  const roots = ['production_schema_baseline', 'users', 'onboarding_preferences'];
  for (const root of roots) assert.ok(D1_RESTORE_DATA_ORDER.includes(root), `missing root table "${root}"`);
  assert.equal(new Set(D1_RESTORE_DATA_ORDER).size, D1_RESTORE_DATA_ORDER.length, 'no table should appear twice');
  // Every real fundraising table (from the same authoritative source the
  // rest of the app uses) must be covered by this order or explicitly
  // skipped -- never silently missing.
  const covered = new Set(D1_RESTORE_DATA_ORDER);
  const skipped = new Set(D1_RESTORE_SKIP_DATA_TABLES);
  const missing = FUNDRAISING_DATA_TABLES.filter((table) => !covered.has(table) && !skipped.has(table));
  assert.deepEqual(missing, [], 'every fundraising table must be in D1_RESTORE_DATA_ORDER or D1_RESTORE_SKIP_DATA_TABLES');
  // Reversing D1_RESTORE_DATA_ORDER's non-root tail must reproduce
  // STAGING_RESET_TABLE_ORDER exactly -- proves insertion order really is
  // the deletion order run backwards, not a separately hand-maintained
  // list that could quietly drift from it.
  const tail = D1_RESTORE_DATA_ORDER.slice(3);
  assert.deepEqual([...tail].reverse(), [...STAGING_RESET_TABLE_ORDER]);
});

test('parseRestoreStatements splits every statement shape correctly, including multi-line CREATE TABLE', () => {
  const parsed = parseRestoreStatements(FIXTURE);
  assert.deepEqual(parsed.preamble, ['PRAGMA defer_foreign_keys=TRUE;']);
  assert.equal(parsed.schema.length, 3, 'two CREATE TABLE blocks + one CREATE INDEX');
  assert.match(parsed.schema[0], /^CREATE TABLE `donors`/);
  assert.match(parsed.schema[0], /FOREIGN KEY \(`owner_user_id`\) REFERENCES `users`\(`id`\)/, 'multi-line CREATE TABLE body must not be truncated');
  assert.equal(parsed.insertsByTable.get('donors')?.length, 1);
  assert.equal(parsed.insertsByTable.get('users')?.length, 1);
  assert.equal(parsed.insertsByTable.has('sqlite_stat1'), false, 'sqlite_stat1 rows must be routed to trailingStats, not treated as a fundraising table');
  assert.equal(parsed.trailingStats.length, 2, 'the ANALYZE statement plus one sqlite_stat1 row');
  assert.deepEqual(parsed.unrecognized, []);
});

test('reorderD1ExportForRestore puts users before donors, fixing the real "no such table: main.users" failure', () => {
  const reordered = reorderD1ExportForRestore(FIXTURE);
  const usersInsertIndex = reordered.indexOf('INSERT INTO "users"');
  const donorsInsertIndex = reordered.indexOf('INSERT INTO "donors"');
  assert.ok(usersInsertIndex >= 0 && donorsInsertIndex >= 0);
  assert.ok(usersInsertIndex < donorsInsertIndex, 'users must be inserted before donors, which has a foreign key to it');
  // Reordering must never drop or duplicate content.
  for (const line of FIXTURE.split('\n')) if (line.trim()) assert.ok(reordered.includes(line.trim()) || reordered.includes(line), `lost content: ${line}`);
});

test('reorderD1ExportForRestore throws on an INSERT for a table it does not recognize, rather than guessing', () => {
  const withUnknownTable = FIXTURE.replace('INSERT INTO "donors"', 'INSERT INTO "some_future_table"');
  assert.throws(() => reorderD1ExportForRestore(withUnknownTable), /some_future_table/);
});

test('planD1Restore separates schema, per-table data steps in dependency order, and trailing stats', () => {
  const plan = planD1Restore(FIXTURE);
  assert.match(plan.schemaSql, /CREATE TABLE `donors`/);
  assert.match(plan.schemaSql, /CREATE TABLE `users`/);
  assert.doesNotMatch(plan.schemaSql, /INSERT INTO/, 'schemaSql must contain no data');
  assert.equal(plan.dataSteps.length, 2);
  const tableOrder = plan.dataSteps.map((step) => step.table);
  assert.deepEqual(tableOrder, ['users', 'donors'], 'users must be its own step, restored before donors');
  for (const step of plan.dataSteps) assert.match(step.sql, new RegExp(`^INSERT INTO "${step.table}"`));
  assert.match(plan.trailingStatsSql, /ANALYZE sqlite_schema/);
  assert.match(plan.trailingStatsSql, /sqlite_stat1/);
  assert.deepEqual(plan.skippedTables, [], 'fixture has no import_preview_sessions/import_preview_session_chunks data to skip');
});

test('planD1Restore skips DATA (not schema) for the two explicitly excluded ephemeral tables', () => {
  const withChunks = FIXTURE + 'INSERT INTO "import_preview_session_chunks" ("session_id") VALUES(\'s1\');\n';
  const plan = planD1Restore(withChunks);
  assert.deepEqual(plan.skippedTables, ['import_preview_session_chunks']);
  assert.equal(plan.dataSteps.some((step) => step.table === 'import_preview_session_chunks'), false, 'skipped table must not appear as a data step');
  // Skipping must not trip the "unknown table" fail-loud check -- it is a
  // deliberate, named exclusion, not an unrecognized table.
  assert.doesNotThrow(() => planD1Restore(withChunks));
});
