import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNDRAISING_DATA_TABLES } from '../lib/data-health/production-baseline.ts';
import { STAGING_RESET_TABLE_ORDER } from '../lib/operations/staging-reset.ts';
import {
  D1_RESTORE_DATA_ORDER,
  D1_RESTORE_SKIP_DATA_TABLES,
  D1_SAFE_STATEMENT_BYTES,
  classifySqlValueExpression,
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
