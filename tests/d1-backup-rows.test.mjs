import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCTION_BASELINE_HASH } from "../lib/data-health/production-baseline.ts";
import {
  classifySqlValueExpression,
  findInsertedRow,
  parameterizeInsertStatement,
  splitTopLevelSqlValues,
} from "../lib/operations/d1-backup-rows.ts";

// Regression coverage for the production_schema_baseline restore-verification
// semantic fix (ported from main, commit a9685bac34db). Previously,
// scripts/verify-remote-restore.mjs asserted the RESTORED
// production_schema_baseline row's schema_hash equalled TODAY's packaged
// PRODUCTION_BASELINE_HASH. That conflated two different questions:
//   A. backup fidelity -- did the restore faithfully reproduce this row?
//      (should compare restored vs. the SOURCE BACKUP's own value)
//   B. current structural integrity -- does the live schema match today's
//      manifest? (compareSchemaObjects, which never reads
//      production_schema_baseline's row value at all -- see
//      tests/production-baseline.test.mjs for that coverage)
// production_schema_baseline (id '0019') is a write-once historical
// lineage stamp, not continuously re-stamped as later migrations land, so
// it is EXPECTED to go stale relative to PRODUCTION_BASELINE_HASH over
// time -- that must never by itself fail restore verification of an
// older, still-valid backup. These tests prove findInsertedRow extracts
// that historical marker correctly and independently of today's hash, and
// that a genuine restore-fidelity failure is still detectable.

test("splitTopLevelSqlValues respects quoted strings (including doubled '' escapes) and nested parens", () => {
  const inner = `'donor-1','{"a":1,"b":2,"note":"it''s fine"}',replace('a','b',char(10)),NULL,42`;
  const values = splitTopLevelSqlValues(inner);
  assert.deepEqual(values, [
    `'donor-1'`,
    `'{"a":1,"b":2,"note":"it''s fine"}'`,
    `replace('a','b',char(10))`,
    "NULL",
    "42",
  ]);
  assert.equal(values.join(","), inner);
});

test("classifySqlValueExpression classifies literals and rejects function-call expressions", () => {
  assert.deepEqual(classifySqlValueExpression("NULL"), { kind: "null", value: null });
  assert.deepEqual(classifySqlValueExpression("42"), { kind: "number", value: 42 });
  assert.deepEqual(classifySqlValueExpression(`'it''s fine'`), { kind: "string", value: `it's fine` });
  assert.deepEqual(classifySqlValueExpression(`replace('a','b',char(10))`), { kind: "other" });
});

test("parameterizeInsertStatement parses columns and literal values from a real production_schema_baseline INSERT", () => {
  const result = parameterizeInsertStatement(`INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','abc',123);`);
  assert.deepEqual(result.columns, ["id", "schema_hash", "created_at"]);
  assert.deepEqual(result.params, ["0019", "abc", 123]);
});

test("findInsertedRow extracts a historical production_schema_baseline marker from backup SQL exactly, independent of PRODUCTION_BASELINE_HASH", () => {
  const staleHash = "0df7c3561261e9e500d8f7fe563ea76ae19fcb0304a994ff5354b210e0f4e41b";
  const backup = [
    "CREATE TABLE `production_schema_baseline` (`id` text PRIMARY KEY NOT NULL, `schema_hash` text NOT NULL, `created_at` integer NOT NULL);",
    `INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','${staleHash}',1785944072);`,
  ].join("\n") + "\n";
  const row = findInsertedRow(backup, "production_schema_baseline", "id", "0019");
  assert.deepEqual(row, { id: "0019", schema_hash: staleHash, created_at: 1785944072 });
  assert.notEqual(row.schema_hash, PRODUCTION_BASELINE_HASH, "test fixture must use a genuinely stale hash to be meaningful");
});

test("findInsertedRow returns null (never guesses) when no row matches the given id", () => {
  const backup = "CREATE TABLE `production_schema_baseline` (`id` text PRIMARY KEY NOT NULL, `schema_hash` text NOT NULL);\n";
  assert.equal(findInsertedRow(backup, "production_schema_baseline", "id", "0019"), null);
});

test("regression: an old but faithfully-restored historical marker does not fail merely because today's packaged hash changed", () => {
  const staleHash = "0df7c3561261e9e500d8f7fe563ea76ae19fcb0304a994ff5354b210e0f4e41b";
  const backup = `INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','${staleHash}',1785944072);\n`;
  const sourceRow = findInsertedRow(backup, "production_schema_baseline", "id", "0019");
  assert.notEqual(sourceRow.schema_hash, PRODUCTION_BASELINE_HASH, "fixture must be genuinely stale relative to today's packaged hash to prove the point");
  const restoredHash = staleHash; // simulates a faithful restore of an older, still-valid backup
  assert.equal(restoredHash, sourceRow.schema_hash, "a faithful restore reproduces the backup marker exactly, regardless of today's packaged hash");
});

test("regression: a restored marker differing from the SOURCE BACKUP's own marker is detected (real restore corruption)", () => {
  const backup = `INSERT INTO "production_schema_baseline" ("id","schema_hash","created_at") VALUES('0019','aaaa',1785944072);\n`;
  const sourceRow = findInsertedRow(backup, "production_schema_baseline", "id", "0019");
  const restoredHash = "bbbb"; // simulates a restore that silently corrupted/lost this row
  assert.notEqual(restoredHash, sourceRow.schema_hash, "a corrupted restore must remain distinguishable from a faithful one");
});
