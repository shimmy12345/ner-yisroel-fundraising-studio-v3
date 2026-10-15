import manifest from "../../production-baseline/schema-manifest.json" with { type: "json" };

export type SchemaObject = { type: "table" | "index"; name: string; sql: string };
export type SchemaComparison = { matches: boolean; differences: string[] };

export const PRODUCTION_BASELINE_LEVEL = manifest.baselineLevel;
export const PRODUCTION_BASELINE_HASH = manifest.schemaHash;
export const PRODUCTION_BASELINE_SOURCE_MIGRATIONS = manifest.sourceMigrations;
export const PRODUCTION_BASELINE_OBJECTS = manifest.ddlTopology as SchemaObject[];
export const PRODUCTION_BASELINE_TABLES = PRODUCTION_BASELINE_OBJECTS.filter((object) => object.type === "table").map((object) => object.name);
export const BUSINESS_DATA_COUNT_SQL = `SELECT ${PRODUCTION_BASELINE_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS count`;
// 47 as of 0046_trip_financial_attributions.sql (feature/independent-
// cloudflare-sandbox commit e9a40f2, synced to this branch 2026-10-15 --
// schema-manifest.json copied verbatim from that branch's own current,
// verified manifest, the same sync mechanism as commits 4ea1d5e/62628b3/
// ad80cf6/5e48837/114c7bb/[0041-0042 sync]/[0043 sync]; see
// docs/AI-HANDOFF.md's "D1 Monthly Restore Verification Repair" and
// "October 14 2026 Email Incident" entries). This sync covers THREE
// migrations in one pass, same as the prior 0039+0040 and 0041+0042
// syncs:
//   - 0044_agenda_manual_test_send_log.sql: ADDS ONE NEW TABLE
//     (agenda_manual_test_send_log, the temporary Gmail OAuth
//     verification mechanism's one-time claim record -- see
//     docs/AI-HANDOFF.md's "October 14 2026 Email Incident" entry). Its
//     only foreign key is `user_id` -> `users.id` -- the same shape as
//     backup_alert_state/agenda_send_log just below, not
//     pledge_balance_corrections -- so it is NOT part of
//     STAGING_RESET_TABLE_ORDER.
//   - 0045_trips.sql: ADDS TWO NEW TABLES (trips, trip_prospects --
//     Trip-Based Meeting Planning; see docs/AI-HANDOFF.md). Real
//     fundraising/relationship data, not account configuration, so both
//     fall into FUNDRAISING_DATA_TABLES automatically and ARE part of
//     STAGING_RESET_TABLE_ORDER.
//   - 0046_trip_financial_attributions.sql: ADDS ONE NEW TABLE
//     (trip_financial_attributions -- Trip Fundraising Results
//     Dashboard; see docs/AI-HANDOFF.md). Same as trips/trip_prospects:
//     real fundraising data, part of STAGING_RESET_TABLE_ORDER.
// All four new tables are why this sync could not be handled by the
// automated prepare-sync job (it deliberately refuses any migration that
// introduces a new table -- see docs/D1-MIGRATION-SYNC-PROCESS.md --
// confirmed by running scripts/prepare-main-restore-sync-patch.mjs on the
// canonical branch, which returned safe:false with exactly that reason)
// and had to be prepared by hand, following the same narrow pattern as
// every prior new-table sync. See lib/operations/staging-reset.ts and
// lib/operations/d1-restore-order.ts for each table's restore-order
// placement and test/d1-restore-order.test.mjs for the dependency-order
// regressions.
// PRODUCTION_BASELINE_HASH changed again (PRODUCTION_BASELINE_LEVEL stays
// "0019": that label identifies the single bootstrap file's origin, not
// its current contents). Caught by this repository's own generic
// restore/schema drift guard (feature/independent-cloudflare-sandbox's
// scripts/check-main-restore-sync.mjs) before any scheduled monthly
// restore-verification run would have found it.
export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 47;

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
