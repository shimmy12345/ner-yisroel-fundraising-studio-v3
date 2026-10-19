// Shared connect-and-validate logic for the drizzle/pending-review/0049
// Calendar schema repair's two prepared-but-never-run scripts
// (apply-0049-calendar-schema-repair-staging.mjs and
// recover-0049-calendar-schema-repair-staging.mjs). Never imported by
// anything that runs automatically -- both of those scripts are invoked
// by hand only, after separate owner authorization.
//
// Connects to the REAL remote Staging D1 through TWO independent paths
// -- the Workers `D1Database` binding (via `getPlatformProxy({
// remoteBindings: true})`) and the wrangler CLI's own `d1 execute
// --remote` -- and refuses to proceed unless both agree on the same,
// known database identity. This exists because the binding alone can
// silently resolve to an EMPTY LOCAL SIMULATED database (see
// wrangler.staging-repair.jsonc's own header for the exact mechanism)
// while every call still appears to succeed; cross-checking against the
// CLI's independently-resolved database_id and schema is the only way to
// catch that before any mutation.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getPlatformProxy } from "wrangler";
import { computeSchemaFingerprint, validateRepairTarget } from "../../lib/operations/staging-repair-target.ts";

export const STAGING_REPAIR_CONFIG_PATH = path.resolve(import.meta.dirname, "../../wrangler.staging-repair.jsonc");
export const STAGING_DATABASE_NAME = "fundraising-os-staging-db";
const SCHEMA_ROWS_QUERY = "SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name;";

export function wrangler(args, { allowFailure = false, cwd } = {}) {
  const result = spawnSync("npx", ["--yes", "wrangler@4.92.0", ...args], { cwd: cwd ?? path.resolve(import.meta.dirname, "../.."), encoding: "utf8", env: process.env });
  if (result.status !== 0 && !allowFailure) throw new Error(`wrangler ${args.join(" ")} failed:\n${(result.stderr || result.stdout || "").trim()}`);
  return result;
}

export function wranglerJson(args) {
  const result = wrangler([...args, "--json"]);
  const lines = result.stdout.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate); } catch { /* keep scanning */ }
  }
  throw new Error(`Could not find JSON in wrangler output for: ${args.join(" ")}\n${result.stdout}`);
}

// Opens the real remote Staging D1 binding, independently fetches the
// same live schema via the wrangler CLI, cross-validates both against
// Staging's known database id, and throws (closing the proxy first) if
// validation fails for any reason. On success, returns the OPEN,
// already-validated binding for the caller to reuse for its own actual
// work -- never re-resolved a second time, so there is no gap between
// "validated" and "used."
export async function connectAndValidateStagingTarget({ expectedAccountId = process.env.STAGING_REPAIR_EXPECTED_ACCOUNT_ID || null } = {}) {
  console.log("Resolving the target database id via the wrangler CLI (d1 info)...");
  const info = wranglerJson(["d1", "info", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH]);
  const cliDatabaseId = info?.uuid ?? info?.[0]?.uuid ?? null;

  console.log("Reading the live schema via the wrangler CLI (read-only)...");
  const cliSchemaResult = wranglerJson(["d1", "execute", STAGING_DATABASE_NAME, "--remote", "--config", STAGING_REPAIR_CONFIG_PATH, "--command", SCHEMA_ROWS_QUERY]);
  const cliSchemaRows = cliSchemaResult?.[0]?.results ?? [];

  console.log("Opening the real remote Staging D1 binding (getPlatformProxy, remoteBindings: true)...");
  const proxy = await getPlatformProxy({ configPath: STAGING_REPAIR_CONFIG_PATH, remoteBindings: true });
  const db = proxy.env.DB;

  let bindingSchemaRows = [];
  try {
    const bindingSchemaResult = await db.prepare(SCHEMA_ROWS_QUERY).all();
    bindingSchemaRows = bindingSchemaResult?.results ?? [];
  } catch (error) {
    await proxy.dispose();
    throw new Error(`Could not read the live schema via the D1 binding: ${error.message}`);
  }

  const cliAccountId = process.env.CLOUDFLARE_ACCOUNT_ID || null;
  const validation = validateRepairTarget({
    cliDatabaseId,
    bindingRowCount: bindingSchemaRows.length,
    cliRowCount: cliSchemaRows.length,
    bindingFingerprint: computeSchemaFingerprint(bindingSchemaRows),
    cliFingerprint: computeSchemaFingerprint(cliSchemaRows),
    expectedAccountId,
    cliAccountId,
  });

  if (!validation.ok) {
    await proxy.dispose();
    throw new Error(`Target validation failed -- refusing to proceed against any database:\n  - ${validation.errors.join("\n  - ")}`);
  }

  console.log(`Target validated: database id ${cliDatabaseId} matches Staging's known identity; the D1 binding and the wrangler CLI agree on ${bindingSchemaRows.length} schema object(s) (fingerprint ${computeSchemaFingerprint(bindingSchemaRows).slice(0, 12)}...).`);
  return { db, dispose: () => proxy.dispose() };
}
