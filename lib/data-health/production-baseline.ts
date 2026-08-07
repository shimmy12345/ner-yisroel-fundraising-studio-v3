import manifest from "../../production-baseline/schema-manifest.json" with { type: "json" };

export type SchemaObject = { type: "table" | "index"; name: string; sql: string };
export type SchemaComparison = { matches: boolean; differences: string[] };

export const PRODUCTION_BASELINE_LEVEL = manifest.baselineLevel;
export const PRODUCTION_BASELINE_HASH = manifest.schemaHash;
export const PRODUCTION_BASELINE_SOURCE_MIGRATIONS = manifest.sourceMigrations;
export const PRODUCTION_BASELINE_OBJECTS = manifest.ddlTopology as SchemaObject[];
export const PRODUCTION_BASELINE_TABLES = PRODUCTION_BASELINE_OBJECTS.filter((object) => object.type === "table").map((object) => object.name);
export const BUSINESS_DATA_COUNT_SQL = `SELECT ${PRODUCTION_BASELINE_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS count`;
// 22 as of 0021_import_preview_sessions.sql — adds import_preview_sessions
// and import_preview_session_chunks, so PRODUCTION_BASELINE_HASH changed
// (PRODUCTION_BASELINE_LEVEL stays "0019": that label identifies the single
// bootstrap file's origin, not its current contents).
export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 22;

// Tables that hold the app's own account/authentication state rather than a
// fundraiser's relationship or giving data. A brand-new environment is
// expected to contain exactly one owner's row here after their first
// authenticated visit; that must never register as fundraising business
// data. Used only by the independent-staging Workspace Health summary — the
// backup-safety gate and rehearsal scripts keep using the untouched,
// intentionally conservative BUSINESS_DATA_COUNT_SQL above.
export const ACCOUNT_CONFIGURATION_TABLES = ["users", "onboarding_preferences"];
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
