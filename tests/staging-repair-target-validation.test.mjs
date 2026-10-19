import assert from "node:assert/strict";
import test from "node:test";
import {
  STAGING_REPAIR_EXPECTED_DATABASE_ID,
  computeSchemaFingerprint,
  validateRepairTarget,
} from "../lib/operations/staging-repair-target.ts";

// Pure, offline coverage for scripts/apply-0049-calendar-schema-repair-
// staging.mjs's own target-identity validation -- no wrangler, no
// network, no D1 of any kind. The script itself can only be rehearsed
// end-to-end against real credentials this repo's sandbox does not have;
// this proves the VALIDATION LOGIC fails closed on every way the real
// script could otherwise be fooled into silently operating on the wrong
// (or no) database, using plain synthetic inputs.

const GOOD_ROWS = [
  { name: "calendar_event_links", type: "table", sql: "CREATE TABLE `calendar_event_links` (`id` text PRIMARY KEY NOT NULL)" },
  { name: "calendar_event_links_interaction_uidx", type: "index", sql: "CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`)" },
];

test("computeSchemaFingerprint is stable for the same rows and changes when the schema changes", () => {
  const a = computeSchemaFingerprint(GOOD_ROWS);
  const b = computeSchemaFingerprint(GOOD_ROWS.map((row) => ({ ...row })));
  assert.equal(a, b, "identical schema rows must fingerprint identically");

  const different = computeSchemaFingerprint([...GOOD_ROWS, { name: "extra_table", type: "table", sql: "CREATE TABLE `extra_table` (`id` text)" }]);
  assert.notEqual(a, different, "a different schema must fingerprint differently");
});

test("computeSchemaFingerprint ignores incidental whitespace, matching the real production comparison", () => {
  const spaced = [{ name: "calendar_event_links", type: "table", sql: "CREATE TABLE  `calendar_event_links`   (\n  `id` text PRIMARY KEY NOT NULL\n)" }];
  const tight = [{ name: "calendar_event_links", type: "table", sql: "CREATE TABLE `calendar_event_links` ( `id` text PRIMARY KEY NOT NULL )" }];
  assert.equal(computeSchemaFingerprint(spaced), computeSchemaFingerprint(tight));
});

function validInput(overrides = {}) {
  const fingerprint = computeSchemaFingerprint(GOOD_ROWS);
  return {
    cliDatabaseId: STAGING_REPAIR_EXPECTED_DATABASE_ID,
    bindingRowCount: GOOD_ROWS.length,
    cliRowCount: GOOD_ROWS.length,
    bindingFingerprint: fingerprint,
    cliFingerprint: fingerprint,
    ...overrides,
  };
}

test("validateRepairTarget passes when the CLI database id matches and both paths agree", () => {
  const result = validateRepairTarget(validInput());
  assert.deepEqual(result, { ok: true, errors: [] });
});

test("validateRepairTarget fails closed when the CLI database id does not match Staging's known id", () => {
  const result = validateRepairTarget(validInput({ cliDatabaseId: "11111111-1111-1111-1111-111111111111" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("does not match Staging's known database id")));
});

test("validateRepairTarget fails closed when the CLI database id is missing entirely", () => {
  for (const missing of [null, undefined, ""]) {
    const result = validateRepairTarget(validInput({ cliDatabaseId: missing }));
    assert.equal(result.ok, false, `missing cliDatabaseId (${JSON.stringify(missing)}) must fail closed`);
    assert.ok(result.errors.some((e) => e.includes("missing result")));
  }
});

test("validateRepairTarget fails closed on an empty binding result -- the signature of a local-simulated fallback", () => {
  const result = validateRepairTarget(validInput({ bindingRowCount: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("local-simulated fallback")));
});

test("validateRepairTarget fails closed on an empty CLI result", () => {
  const result = validateRepairTarget(validInput({ cliRowCount: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("missing results")));
});

test("validateRepairTarget fails closed when the binding and CLI fingerprints disagree -- not looking at the same database", () => {
  const otherFingerprint = computeSchemaFingerprint([{ name: "a_completely_different_table", type: "table", sql: "CREATE TABLE `a_completely_different_table` (`id` text)" }]);
  const result = validateRepairTarget(validInput({ bindingFingerprint: otherFingerprint }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("not looking at the same data")));
});

test("validateRepairTarget fails closed when either fingerprint is missing", () => {
  for (const key of ["bindingFingerprint", "cliFingerprint"]) {
    const result = validateRepairTarget(validInput({ [key]: "" }));
    assert.equal(result.ok, false, `missing ${key} must fail closed`);
  }
});

test("validateRepairTarget cross-checks an operator-supplied expected account id when both sides provide one", () => {
  const ok = validateRepairTarget(validInput({ expectedAccountId: "acct-123", cliAccountId: "acct-123" }));
  assert.equal(ok.ok, true);

  const mismatch = validateRepairTarget(validInput({ expectedAccountId: "acct-123", cliAccountId: "acct-456" }));
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.some((e) => e.includes("does not match the operator-supplied expected account id")));
});

test("validateRepairTarget does not require an account id check when neither side supplies one", () => {
  const result = validateRepairTarget(validInput());
  assert.equal(result.ok, true, "account id cross-check must be optional, not a silent requirement");
});

test("validateRepairTarget reports every failing condition at once, not just the first", () => {
  const result = validateRepairTarget(validInput({ cliDatabaseId: "wrong", bindingRowCount: 0 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2, "multiple independent failures must all be reported, not short-circuited");
});
