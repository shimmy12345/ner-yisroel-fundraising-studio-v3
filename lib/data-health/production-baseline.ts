import manifest from "../../production-baseline/schema-manifest.json" with { type: "json" };

export type SchemaObject = { type: "table" | "index"; name: string; sql: string };
export type SchemaComparison = { matches: boolean; differences: string[] };

export const PRODUCTION_BASELINE_LEVEL = manifest.baselineLevel;
export const PRODUCTION_BASELINE_HASH = manifest.schemaHash;
export const PRODUCTION_BASELINE_SOURCE_MIGRATIONS = manifest.sourceMigrations;
export const PRODUCTION_BASELINE_OBJECTS = manifest.ddlTopology as SchemaObject[];
export const PRODUCTION_BASELINE_TABLES = PRODUCTION_BASELINE_OBJECTS.filter((object) => object.type === "table").map((object) => object.name);
export const BUSINESS_DATA_COUNT_SQL = `SELECT ${PRODUCTION_BASELINE_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS count`;
// 52 as of 0053_meeting_note_save_identity.sql
// Manual sync (prepared 2026-10-22; the automated prepare-sync tool
// (scripts/prepare-main-restore-sync-patch.mjs) again refused this one --
// see below), see docs/D1-MIGRATION-SYNC-PROCESS.md.
// production-baseline/schema-manifest.json was replaced verbatim from the
// release candidate branch's own current, verified manifest -- the same
// sync mechanism used for every prior round (see docs/AI-HANDOFF.md's "D1
// Monthly Restore Verification Repair" entries). PRODUCTION_BASELINE_LEVEL
// stays "0019": that label identifies the single bootstrap file's origin,
// not its current contents.
//
// This round closes the gap left by the PRIOR manual sync (52 lines
// above, in git history): that sync added 0048_google_calendar_sync.sql,
// 0050_trip_attribution_confirmation.sql, and
// 0051_trip_reconciliation_concurrency_guard.sql to this file on the
// assumption that none of the three had reached Production yet. Since
// then, a real Production deployment (docs/AI-HANDOFF.md, "Production
// Deployment -- AI Meeting Notes + JL Pending-Reconciliation
// Confirmation") applied 0050, 0051, 0052_interaction_write_proof_
// token.sql, and 0053_meeting_note_save_identity.sql to the real
// fundraising-os-production-db -- confirmed directly against live
// Production (read-only `sqlite_schema` queries, 2026-10-22,
// docs/AI-HANDOFF.md's "Backup Restore Verification" entries): Production
// now has `interactions.write_token` (0052) and the
// `meeting_note_save_identities` table (0053), matching the release
// candidate branch exactly. The SAME queries confirmed 0048 (Google
// Calendar sync -- `interactions.all_day`/`all_day_date`/`end_at`/
// `location`, `users.calendar_sync_enabled`, and the `calendar_event_
// links`/`calendar_event_link_history` tables) is NOT present in
// Production; it exists only on fundraising-os-staging-db and in this
// migration file. The automated prepare-sync tool refuses this sync
// because main's OWN manifest (pre-fix) listed 0048 as a source
// migration the canonical branch does not have -- it only ever handles
// main being purely BEHIND, never genuinely diverged -- so this round's
// resolution (keep 0052+0053, drop 0048's columns/tables from the
// PRODUCTION baseline this file exists to describe) is a human judgment
// call, prepared here for review rather than auto-applied.
//
// drizzle/0048_google_calendar_sync.sql itself is left untouched -- still
// present in this repository, still tracked in lib/operations/staging-
// reset.ts's STAGING_RESET_TABLE_ORDER (which describes resetting the
// real fundraising-os-staging-db, where 0048 IS applied) -- only this
// file's and production-baseline/schema-manifest.json's claim about what
// defines the PRODUCTION baseline is corrected to match verified live
// Production. If 0048 is later deployed to Production, it needs its own
// sync round, same as any other new migration.
export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 52;

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
