import assert from "node:assert/strict";
import test from "node:test";
import { buildD1InfoArgs, buildSchemaRowsExecuteArgs, STAGING_DATABASE_NAME, STAGING_REPAIR_CONFIG_PATH } from "../scripts/lib/staging-repair-connect.mjs";

// Regression for a real bug an actual manual dispatch run caught
// (run 39298894750): `d1 info` was called with `--remote`, which
// wrangler 4.92.0 rejects outright for that subcommand ("Unknown
// argument: remote") -- confirmed directly against the pinned
// version's own `--help` output, which states "This command acts on
// remote D1 Databases": `d1 info` is ALWAYS remote, with no flag to
// pass at all. `d1 execute`, by contrast, DOES require `--remote` to
// act on the real database rather than a local one. This test asserts
// the exact argv arrays built for each -- no wrangler process is
// spawned, so this never needs network access or credentials.

test("buildD1InfoArgs never includes --remote -- wrangler 4.92.0 rejects it for this subcommand", () => {
  const args = buildD1InfoArgs(STAGING_DATABASE_NAME, STAGING_REPAIR_CONFIG_PATH);
  assert.deepEqual(args, ["d1", "info", STAGING_DATABASE_NAME, "--config", STAGING_REPAIR_CONFIG_PATH]);
  assert.ok(!args.includes("--remote"), "d1 info must never be passed --remote (confirmed via `wrangler d1 info --help`: this subcommand is always remote, with no such flag)");
});

test("buildSchemaRowsExecuteArgs includes --remote -- d1 execute needs it to act on the real database", () => {
  const args = buildSchemaRowsExecuteArgs(STAGING_DATABASE_NAME, STAGING_REPAIR_CONFIG_PATH);
  assert.ok(args.includes("--remote"), "d1 execute must be passed --remote, or it acts on a local database instead of the real Staging D1");
  assert.equal(args[0], "d1");
  assert.equal(args[1], "execute");
  assert.equal(args[2], STAGING_DATABASE_NAME);
  assert.ok(args.includes("--command"));
});

test("buildD1InfoArgs and buildSchemaRowsExecuteArgs both carry the given config path, for any database name/path (not hardcoded)", () => {
  const infoArgs = buildD1InfoArgs("some-other-db", "/some/other/config.jsonc");
  assert.deepEqual(infoArgs, ["d1", "info", "some-other-db", "--config", "/some/other/config.jsonc"]);
  const execArgs = buildSchemaRowsExecuteArgs("some-other-db", "/some/other/config.jsonc");
  assert.ok(execArgs.includes("some-other-db"));
  assert.ok(execArgs.includes("/some/other/config.jsonc"));
});
