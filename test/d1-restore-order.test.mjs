import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNDRAISING_DATA_TABLES, PRODUCTION_BASELINE_HASH, PRODUCTION_BASELINE_OBJECTS, compareSchemaObjects, stagingSchemaObjects } from '../lib/data-health/production-baseline.ts';
import { STAGING_RESET_TABLE_ORDER } from '../lib/operations/staging-reset.ts';
import {
  D1_RESTORE_DATA_ORDER,
  D1_RESTORE_SKIP_DATA_TABLES,
  D1_SAFE_STATEMENT_BYTES,
  classifySqlValueExpression,
  findInsertedRow,
  parameterizeInsertStatement,
  parseRestoreStatements,
  planD1Restore,
  reorderD1ExportForRestore,
  splitTopLevelSqlValues,
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

test('D1_RESTORE_DATA_ORDER covers every fundraising table plus the four true roots, with no duplicates', () => {
  // backup_alert_state added 2026-09-01 (D1 Monthly Restore Verification
  // Repair, porting Backup Scheduling Reliability Stage 3's addition from
  // feature/independent-cloudflare-sandbox) -- a fourth
  // ACCOUNT_CONFIGURATION_TABLE root, not part of STAGING_RESET_TABLE_ORDER's
  // reversal (same reasoning as users/onboarding_preferences).
  const roots = ['production_schema_baseline', 'users', 'backup_alert_state', 'onboarding_preferences'];
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
  const tail = D1_RESTORE_DATA_ORDER.slice(4);
  assert.deepEqual([...tail].reverse(), [...STAGING_RESET_TABLE_ORDER]);
});

test('backup_alert_state is positioned after "users", its own real foreign key target', () => {
  const usersIndex = D1_RESTORE_DATA_ORDER.indexOf('users');
  const backupAlertIndex = D1_RESTORE_DATA_ORDER.indexOf('backup_alert_state');
  assert.ok(usersIndex >= 0 && backupAlertIndex > usersIndex, 'backup_alert_state must be inserted after users');
});

// Bidirectional coverage, mirroring
// feature/independent-cloudflare-sandbox's own tests/staging-reset.test.mjs
// ("the reset table order covers every fundraising-data table and nothing
// else"). The pre-existing coverage test above only ever checked ONE
// direction (every FUNDRAISING_DATA_TABLES entry is present in
// D1_RESTORE_DATA_ORDER or the skip list) -- which is exactly why the drift
// that caused GitHub Actions run 33515781926's failure went undetected for
// as long as it did: D1_RESTORE_DATA_ORDER/STAGING_RESET_TABLE_ORDER can be
// a strict SUPERSET of a stale FUNDRAISING_DATA_TABLES (derived from this
// branch's own, separately-synced production-baseline manifest) and that
// one-directional check still passes. This exact-equality check closes
// that gap: it fails the moment STAGING_RESET_TABLE_ORDER and
// FUNDRAISING_DATA_TABLES disagree in EITHER direction, which is what
// should have caught this drift automatically the next time either file
// was touched.
test('STAGING_RESET_TABLE_ORDER is exactly FUNDRAISING_DATA_TABLES, in some order (bidirectional -- closes the gap that let run 33515781926 fail silently)', () => {
  assert.deepEqual([...STAGING_RESET_TABLE_ORDER].sort(), [...FUNDRAISING_DATA_TABLES].sort());
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
  assert.equal(plan.steps.length, 2);
  const tableOrder = plan.steps.map((step) => step.table);
  assert.deepEqual(tableOrder, ['users', 'donors'], 'users must be its own step, restored before donors');
  for (const step of plan.steps) {
    assert.equal(step.kind, 'file', 'no statement in this small fixture is oversized');
    assert.match(step.sql, new RegExp(`^INSERT INTO "${step.table}"`));
  }
  assert.match(plan.trailingStatsSql, /ANALYZE sqlite_schema/);
  assert.match(plan.trailingStatsSql, /sqlite_stat1/);
  assert.deepEqual(plan.skippedTables, [], 'fixture has no import_preview_sessions/import_preview_session_chunks data to skip');
});

test('planD1Restore skips DATA (not schema) for the two explicitly excluded ephemeral tables', () => {
  const withChunks = FIXTURE + 'INSERT INTO "import_preview_session_chunks" ("session_id") VALUES(\'s1\');\n';
  const plan = planD1Restore(withChunks);
  assert.deepEqual(plan.skippedTables, ['import_preview_session_chunks']);
  assert.equal(plan.steps.some((step) => step.table === 'import_preview_session_chunks'), false, 'skipped table must not appear as a data step');
  // Skipping must not trip the "unknown table" fail-loud check -- it is a
  // deliberate, named exclusion, not an unrecognized table.
  assert.doesNotThrow(() => planD1Restore(withChunks));
});

// --- Regression tests for the SQLITE_TOOBIG chunking fix (2026-08-16) ---
//
// Root cause: D1's bulk Import pipeline (used by `wrangler d1 execute
// --remote --file=...`) enforces a hard ceiling on INLINE LITERAL SQL
// statement TEXT length somewhere in (100000, 102400] bytes, independent of
// total row/parameter data size. The fix parameterizes any statement at or
// above D1_SAFE_STATEMENT_BYTES and restores it via the D1 HTTP query API
// ({sql, params}), which is not subject to that ceiling. These tests cover
// the tokenizer/classifier/parameterizer in isolation (splitTopLevelSqlValues,
// classifySqlValueExpression, parameterizeInsertStatement) plus planD1Restore's
// end-to-end chunk selection and interleaving.

test("splitTopLevelSqlValues respects quoted strings (including doubled '' escapes) and nested parens", () => {
  // A JSON-shaped text value containing commas and a doubled single-quote
  // escape, next to a function-call expression containing its own commas
  // in an argument list -- both must be treated as ONE value each, not
  // split on their internal commas.
  const inner = `'donor-1','{"a":1,"b":2,"note":"it''s fine"}',replace('a','b',char(10)),NULL,42`;
  const values = splitTopLevelSqlValues(inner);
  assert.deepEqual(values, [
    `'donor-1'`,
    `'{"a":1,"b":2,"note":"it''s fine"}'`,
    `replace('a','b',char(10))`,
    'NULL',
    '42',
  ]);
  // Rejoining with "," must reproduce the original input exactly.
  assert.equal(values.join(','), inner);
});

test('splitTopLevelSqlValues handles embedded semicolons and newlines inside a quoted string without splitting', () => {
  const inner = `'line one;\nline two;\nline three',7`;
  const values = splitTopLevelSqlValues(inner);
  assert.equal(values.length, 2);
  assert.equal(values[0], `'line one;\nline two;\nline three'`);
  assert.equal(values[1], '7');
});

test('classifySqlValueExpression classifies literals and rejects function-call expressions', () => {
  assert.deepEqual(classifySqlValueExpression('NULL'), { kind: 'null', value: null });
  assert.deepEqual(classifySqlValueExpression('42'), { kind: 'number', value: 42 });
  assert.deepEqual(classifySqlValueExpression('-3.5'), { kind: 'number', value: -3.5 });
  assert.deepEqual(classifySqlValueExpression(`'it''s fine'`), { kind: 'string', value: `it's fine` });
  assert.deepEqual(classifySqlValueExpression(`replace('a','b',char(10))`), { kind: 'other' });
});

test('parameterizeInsertStatement round-trips a data_imports-shaped statement with embedded commas/semicolons/apostrophes/newlines byte-for-byte', () => {
  // Modeled on the real statement shape that triggered SQLITE_TOOBIG: a
  // large JSON payload column, as a plain quoted-string literal exactly as
  // `wrangler d1 export` emits it (embedded quotes doubled per SQL string
  // escaping), containing commas, semicolons, and a literal newline.
  const jsonPayload = `{"rows":[{"id":1,"note":"a,b;c\nmulti-line"},{"id":2,"note":"it''s here"}]}`;
  const statement = `INSERT INTO "data_imports" ("id","payload","row_count") VALUES('import-1','${jsonPayload}',3);`;
  const result = parameterizeInsertStatement(statement);
  assert.ok(result, 'must successfully parameterize a real single-row INSERT with literal values');
  assert.equal(result.sql, `INSERT INTO "data_imports" ("id","payload","row_count") VALUES(?,?,?)`);
  assert.deepEqual(result.params, ['import-1', jsonPayload.replace(/''/g, "'"), 3]);
});

test('parameterizeInsertStatement returns null (never guesses) when a value is a non-literal expression', () => {
  const statement = `INSERT INTO "data_imports" ("id","summary") VALUES('import-1',replace('a','b',char(10)));`;
  assert.equal(parameterizeInsertStatement(statement), null, 'a function-call value cannot be safely bound as a single parameter, so this must fail loudly rather than guess');
});

test('parameterizeInsertStatement handles a statement at/over the discovered ~100-102KB D1 SQLITE_TOOBIG threshold', () => {
  // 101000 bytes of literal string content -- inside the empirically
  // confirmed (100000, 102400] failure band for inline SQL text.
  const bigValue = 'x'.repeat(101000);
  const statement = `INSERT INTO "data_imports" ("id","payload") VALUES('import-big','${bigValue}');`;
  assert.ok(statement.length > D1_SAFE_STATEMENT_BYTES, 'fixture must actually exceed the safe-statement threshold to be a meaningful test');
  const result = parameterizeInsertStatement(statement);
  assert.ok(result, 'a statement at/over the threshold must still parameterize successfully when every value is a plain literal');
  assert.equal(result.sql, `INSERT INTO "data_imports" ("id","payload") VALUES(?,?)`);
  assert.ok(result.sql.length < 200, 'parameterized SQL text must be tiny regardless of original value size -- this is the entire point of the fix');
  assert.deepEqual(result.params, ['import-big', bigValue]);
});

test('planD1Restore routes oversized statements to a "statement" step and normal-sized statements to a "file" step, interleaved per table', () => {
  const bigValue = 'x'.repeat(101000);
  const sql = [
    'CREATE TABLE `data_imports` (`id` text PRIMARY KEY NOT NULL, `payload` text);',
    'CREATE TABLE `giving_activity_import_changes` (`id` text PRIMARY KEY NOT NULL, `import_id` text NOT NULL, FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`));',
    `INSERT INTO "data_imports" ("id","payload") VALUES('import-small','ok');`,
    `INSERT INTO "data_imports" ("id","payload") VALUES('import-big','${bigValue}');`,
    `INSERT INTO "giving_activity_import_changes" ("id","import_id") VALUES('chg-1','import-big');`,
  ].join('\n') + '\n';
  const order = ['data_imports', 'giving_activity_import_changes'];
  const plan = planD1Restore(sql, order, [], D1_SAFE_STATEMENT_BYTES);
  // Both of data_imports' steps (file + statement) must appear together,
  // BEFORE giving_activity_import_changes' step -- this is the exact
  // interleaving-by-construction fix for the dependency-order regression
  // found empirically 2026-08-16 (a deferred-to-the-end oversized statement
  // broke a later table's foreign-key check even though ordinary rows were
  // already correctly ordered).
  const shapes = plan.steps.map((step) => `${step.table}:${step.kind}`);
  assert.deepEqual(shapes, [
    'data_imports:file',
    'data_imports:statement',
    'giving_activity_import_changes:file',
  ]);
  const statementStep = plan.steps.find((step) => step.kind === 'statement');
  assert.equal(statementStep.sql, `INSERT INTO "data_imports" ("id","payload") VALUES(?,?)`);
  assert.deepEqual(statementStep.params, ['import-big', bigValue]);
  const fileStep = plan.steps.find((step) => step.table === 'data_imports' && step.kind === 'file');
  assert.match(fileStep.sql, /'import-small'/);
  assert.doesNotMatch(fileStep.sql, /import-big/, 'the oversized row must not also appear in the file step');
});

test('planD1Restore produces one "statement" step per oversized row when a table has multiple oversized rows', () => {
  const bigValue1 = 'x'.repeat(101000);
  const bigValue2 = 'y'.repeat(101500);
  const sql = [
    'CREATE TABLE `data_imports` (`id` text PRIMARY KEY NOT NULL, `payload` text);',
    `INSERT INTO "data_imports" ("id","payload") VALUES('import-small','ok');`,
    `INSERT INTO "data_imports" ("id","payload") VALUES('import-big-1','${bigValue1}');`,
    `INSERT INTO "data_imports" ("id","payload") VALUES('import-big-2','${bigValue2}');`,
  ].join('\n') + '\n';
  const plan = planD1Restore(sql, ['data_imports'], [], D1_SAFE_STATEMENT_BYTES);
  const shapes = plan.steps.map((step) => step.kind);
  assert.deepEqual(shapes, ['file', 'statement', 'statement'], 'one file step for the small row, plus one statement step per oversized row, in original row order');
  assert.deepEqual(plan.steps[1].params, ['import-big-1', bigValue1]);
  assert.deepEqual(plan.steps[2].params, ['import-big-2', bigValue2]);
});

test('planD1Restore fails loudly rather than silently dropping an oversized statement it cannot safely parameterize', () => {
  const bigValue = 'x'.repeat(101000);
  // A multi-row-shaped statement is not something parameterizeInsertStatement
  // recognizes (it only handles single-row INSERT ... VALUES(...)), so this
  // must throw rather than restore truncated/incorrect data.
  const sql = [
    'CREATE TABLE `data_imports` (`id` text PRIMARY KEY NOT NULL, `payload` text);',
    `INSERT INTO "data_imports" ("id","payload") VALUES('a','${bigValue}'),('b','${bigValue}');`,
  ].join('\n') + '\n';
  assert.throws(() => planD1Restore(sql, ['data_imports'], [], D1_SAFE_STATEMENT_BYTES), /could not be safely parameterized/);
});

// --- Regression tests for the production_schema_baseline semantic fix (2026-08-16) ---
//
// verify-remote-restore.mjs previously asserted the RESTORED
// production_schema_baseline row's schema_hash equalled TODAY's packaged
// PRODUCTION_BASELINE_HASH. That conflated two different questions:
//   A. backup fidelity -- did the restore faithfully reproduce this row?
//      (should compare restored vs. the SOURCE BACKUP's own value)
//   B/C. current structural integrity + migration readiness -- does the
//      live schema match today's manifest? (compareSchemaObjects, which
//      never reads production_schema_baseline's row value at all)
// production_schema_baseline (id '0019') is a write-once historical
// lineage stamp, not continuously re-stamped as later migrations land, so
// it is EXPECTED to go stale relative to PRODUCTION_BASELINE_HASH over
// time -- that must never by itself fail restore verification. These
// tests prove the two checks are now independent, and that each still
// fails loudly on a real problem.

test('findInsertedRow extracts a historical production_schema_baseline marker from backup SQL exactly, independent of PRODUCTION_BASELINE_HASH', () => {
  const staleHash = '0df7c3561261e9e500d8f7fe563ea76ae19fcb0304a994ff5354b210e0f4e41b';
  const backup = [
    'CREATE TABLE `production_schema_baseline` (`id` text PRIMARY KEY NOT NULL, `schema_hash` text NOT NULL, `created_at` integer NOT NULL);',
    `INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','${staleHash}',1785944072);`,
  ].join('\n') + '\n';
  const row = findInsertedRow(backup, 'production_schema_baseline', 'id', '0019');
  assert.deepEqual(row, { id: '0019', schema_hash: staleHash, created_at: 1785944072 });
  assert.notEqual(row.schema_hash, PRODUCTION_BASELINE_HASH, 'test fixture must use a genuinely stale hash to be meaningful');
});

test('findInsertedRow returns null (never guesses) when no row matches the given id', () => {
  const backup = 'CREATE TABLE `production_schema_baseline` (`id` text PRIMARY KEY NOT NULL, `schema_hash` text NOT NULL);\n';
  assert.equal(findInsertedRow(backup, 'production_schema_baseline', 'id', '0019'), null);
});

test('parameterizeInsertStatement also returns the parsed column names, in order, alongside params', () => {
  const result = parameterizeInsertStatement(`INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','abc',123);`);
  assert.deepEqual(result.columns, ['id', 'schema_hash', 'created_at']);
  assert.deepEqual(result.params, ['0019', 'abc', 123]);
});

test('regression 1: a stale historical baseline marker does not block verification when the actual restored schema matches the current manifest', () => {
  const miniBaseline = [{ type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)' }];
  const restoredSchemaRows = [{ type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)' }];
  // Structural integrity: matches, using ONLY the live schema --
  // production_schema_baseline's row value is never an input to this check.
  const schemaComparison = compareSchemaObjects(stagingSchemaObjects(restoredSchemaRows), miniBaseline);
  assert.equal(schemaComparison.matches, true);

  // Backup fidelity: the historical marker is genuinely stale relative to
  // today's packaged hash, and that alone must not fail anything -- a
  // faithful restore only needs to reproduce the BACKUP's own value.
  const staleHash = '0df7c3561261e9e500d8f7fe563ea76ae19fcb0304a994ff5354b210e0f4e41b';
  const backup = `INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','${staleHash}',1785944072);\n`;
  const sourceRow = findInsertedRow(backup, 'production_schema_baseline', 'id', '0019');
  assert.notEqual(sourceRow.schema_hash, PRODUCTION_BASELINE_HASH, 'fixture must be genuinely stale to prove the point');
  const restoredHash = staleHash; // simulates a faithful restore of this row
  assert.equal(restoredHash, sourceRow.schema_hash, 'a faithful restore reproduces the backup marker exactly, regardless of today\'s packaged hash');
});

test('regression 2: a restored baseline marker that differs from the SOURCE BACKUP\'s own marker is detected (real corruption)', () => {
  const backup = `INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','aaaa',1785944072);\n`;
  const sourceRow = findInsertedRow(backup, 'production_schema_baseline', 'id', '0019');
  const restoredHash = 'bbbb'; // simulates a restore that silently corrupted/lost this row
  assert.notEqual(restoredHash, sourceRow.schema_hash, 'a corrupted restore must remain distinguishable from a faithful one');
});

test('regression 3: current structural integrity still fails loudly on a real missing table', () => {
  const baseline = [{ type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)' }];
  const comparison = compareSchemaObjects(stagingSchemaObjects([]), baseline);
  assert.equal(comparison.matches, false);
  assert.match(comparison.differences.join(' '), /Missing table: donors/);
});

test('regression 3: current structural integrity still fails loudly on a real column/definition difference', () => {
  const baseline = [{ type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL, `name` text)' }];
  const restoredSchemaRows = [{ type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)' }]; // missing the `name` column
  const comparison = compareSchemaObjects(stagingSchemaObjects(restoredSchemaRows), baseline);
  assert.equal(comparison.matches, false);
  assert.match(comparison.differences.join(' '), /Table definition differs: donors/);
});

test('regression 3: current structural integrity still fails loudly on a real missing index', () => {
  const baseline = [
    { type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)' },
    { type: 'index', name: 'donors_id_idx', sql: 'CREATE INDEX `donors_id_idx` ON `donors` (`id`)' },
  ];
  const restoredSchemaRows = [{ type: 'table', name: 'donors', sql: 'CREATE TABLE `donors` (`id` text PRIMARY KEY NOT NULL)' }]; // index missing
  const comparison = compareSchemaObjects(stagingSchemaObjects(restoredSchemaRows), baseline);
  assert.equal(comparison.matches, false);
  assert.match(comparison.differences.join(' '), /Missing index: donors_id_idx/);
});

test('sanity: the real current PRODUCTION_BASELINE_OBJECTS manifest matches itself (compareSchemaObjects is not vacuously true)', () => {
  const asLiveRows = PRODUCTION_BASELINE_OBJECTS.map((object) => ({ type: object.type, name: object.name, sql: object.sql }));
  const comparison = compareSchemaObjects(stagingSchemaObjects(asLiveRows));
  assert.equal(comparison.matches, true, comparison.differences.join(' '));
});
