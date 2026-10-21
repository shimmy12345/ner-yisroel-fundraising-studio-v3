import manifest from "../../production-baseline/schema-manifest.json" with { type: "json" };

export type SchemaObject = { type: "table" | "index"; name: string; sql: string };
export type SchemaComparison = { matches: boolean; differences: string[] };

export const PRODUCTION_BASELINE_LEVEL = manifest.baselineLevel;
export const PRODUCTION_BASELINE_HASH = manifest.schemaHash;
export const PRODUCTION_BASELINE_SOURCE_MIGRATIONS = manifest.sourceMigrations;
export const PRODUCTION_BASELINE_OBJECTS = manifest.ddlTopology as SchemaObject[];
export const PRODUCTION_BASELINE_TABLES = PRODUCTION_BASELINE_OBJECTS.filter((object) => object.type === "table").map((object) => object.name);
export const BUSINESS_DATA_COUNT_SQL = `SELECT ${PRODUCTION_BASELINE_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS count`;
// 51 as of 0051_trip_reconciliation_concurrency_guard.sql
// Manual sync (prepared 2026-10-21; the automated prepare-sync could not
// handle this one -- see below), see docs/D1-MIGRATION-SYNC-PROCESS.md.
// production-baseline/schema-manifest.json was replaced verbatim from
// feature/independent-cloudflare-sandbox's own current, verified
// manifest -- the same sync mechanism used for every prior round (see
// docs/AI-HANDOFF.md's "D1 Monthly Restore Verification Repair"
// entries). PRODUCTION_BASELINE_LEVEL stays "0019": that label
// identifies the single bootstrap file's origin, not its current
// contents.
//
// Covers three migrations main was behind on: 0048_google_calendar_sync.sql
// (two new tables, calendar_event_links/calendar_event_link_history --
// lib/operations/staging-reset.ts's STAGING_RESET_TABLE_ORDER updated
// separately, in the same change, to place them correctly: NOT
// automatable, since placing a new table requires human judgment about
// its real foreign-key dependencies, per this process's own documented
// scope), 0050_trip_attribution_confirmation.sql and
// 0051_trip_reconciliation_concurrency_guard.sql (both pure additions --
// new columns/an index on the EXISTING trip_financial_attributions
// table only, no new table -- automatable on their own, but bundled with
// 0048 in the same drift here since they landed on the canonical branch
// first). None of these three migrations has been applied to Production;
// 0050/0051 are applied to fundraising-os-staging-db only, 0048 is not
// applied anywhere. This sync updates ONLY main's own restore/schema
// TRACKING to match the canonical branch's real, intended schema -- it
// does not itself apply any migration anywhere.
export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 51;

// Tables that hold the app's own account/authentication state rather than a
// fundraiser's relationship or giving data. A brand-new environment is
// expected to contain exactly one owner's row here after their first
// authenticated visit; that must never register as fundraising business
// data. Used only by the independent-staging Workspace Health summary — the
// backup-safety gate and rehearsal scripts keep using the untouched,
// intentionally conservative BUSINESS_DATA_COUNT_SQL above.
//
// backup_alert_state (added 2026-09-01, ported from
// feature/independent-cloudflare-sandbox's Backup Scheduling Reliability
// Stage 3) holds the same kind of thing: operational dedupe state for a
// scheduled email-alert check, never donor or fundraising data.
//
// agenda_send_log (added 2026-10-14, ported from feature/independent-
// cloudflare-sandbox's October 14 2026 Email Incident fix) is the same
// kind of thing again: operational dedupe state for the Daily
// Fundraising Agenda send, never donor or fundraising data.
//
// agenda_manual_test_send_log (added 2026-10-15, ported from feature/
// independent-cloudflare-sandbox's October 14 2026 Email Incident's
// temporary Gmail OAuth verification mechanism) is the same kind of
// thing once more: a one-time claim record, never donor or fundraising
// data.
export const ACCOUNT_CONFIGURATION_TABLES = ["users", "onboarding_preferences", "backup_alert_state", "agenda_send_log", "agenda_manual_test_send_log"];
export const FUNDRAISING_DATA_TABLES = PRODUCTION_BASELINE_TABLES.filter((table) => !ACCOUNT_CONFIGURATION_TABLES.includes(table));
export const FUNDRAISING_DATA_COUNT_SQL = `SELECT ${FUNDRAISING_DATA_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS count`;
export const ACCOUNT_CONFIGURATION_COUNT_SQL = `SELECT COUNT(*) AS count FROM "users"`;

// These tables belong to the hosting/runtime layer, not the Fundraising OS
// application schema. They are intentionally absent from a portable D1
// production baseline and must never make an otherwise identical application
// schema look unsafe.
export const PLATFORM_MANAGED_SCHEMA_OBJECTS = new Set([
  "__appgarden_migrations",
  "_cf_KV",
  "_cf_METADATA",
  "d1_migrations",
  "__drizzle_migrations",
  "drizzle_migrations",
]);

export const normalizeSchemaSql = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

export function compareSchemaObjects(liveObjects: readonly SchemaObject[], baselineObjects: readonly SchemaObject[] = PRODUCTION_BASELINE_OBJECTS): SchemaComparison {
  const live = new Map(liveObjects.map((object) => [`${object.type}:${object.name}`, object]));
  const baseline = new Map(baselineObjects.map((object) => [`${object.type}:${object.name}`, object]));
  const differences: string[] = [];
  for (const [key, expected] of baseline) {
    const actual = live.get(key);
    if (!actual) differences.push(`Missing ${expected.type}: ${expected.name}.`);
    else if (normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) differences.push(`${expected.type === "table" ? "Table" : "Index"} definition differs: ${expected.name}${expected.type === "table" ? " (columns or constraints)" : ""}.`);
  }
  for (const [key, actual] of live) if (!baseline.has(key) && actual.name !== "production_schema_baseline") differences.push(`Unexpected ${actual.type}: ${actual.name}.`);
  return { matches: differences.length === 0, differences };
}

export function stagingSchemaObjects(rows: Array<Record<string, unknown>>): SchemaObject[] {
  return rows
    .filter((row) => (row.type === "table" || row.type === "index") && typeof row.name === "string" && typeof row.sql === "string" && !String(row.name).startsWith("sqlite_") && !PLATFORM_MANAGED_SCHEMA_OBJECTS.has(String(row.name)))
    .map((row) => ({ type: row.type as "table" | "index", name: String(row.name), sql: normalizeSchemaSql(row.sql) }))
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}
