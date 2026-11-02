import manifest from "../../production-baseline/schema-manifest.json" with { type: "json" };

export type SchemaObject = { type: "table" | "index"; name: string; sql: string };
export type SchemaComparison = { matches: boolean; differences: string[] };

export const PRODUCTION_BASELINE_LEVEL = manifest.baselineLevel;
export const PRODUCTION_BASELINE_HASH = manifest.schemaHash;
export const PRODUCTION_BASELINE_SOURCE_MIGRATIONS = manifest.sourceMigrations;
export const PRODUCTION_BASELINE_OBJECTS = manifest.ddlTopology as SchemaObject[];
export const PRODUCTION_BASELINE_TABLES = PRODUCTION_BASELINE_OBJECTS.filter((object) => object.type === "table").map((object) => object.name);
export const BUSINESS_DATA_COUNT_SQL = `SELECT ${PRODUCTION_BASELINE_TABLES.map((table) => `(SELECT COUNT(*) FROM "${table}")`).join(" + ")} AS count`;
// 54 as of 0054_trip_manual_prospects.sql (Multi-Region Prospect
// Selection + Manually Added Prospects, 2026-10-25, see docs/AI-
// HANDOFF.md). This round also regenerated the manifest's full
// ddlTopology/sourceMigrations from the real drizzle/ directory as it
// stands now -- it had been stuck at migration 0051 (missing
// 0052_interaction_write_proof_token.sql and 0053_meeting_note_save_
// identity.sql, both already live on this branch) since before this
// round started; regenerating for 0054 picked up that pre-existing gap
// too, as scripts/generate-production-baseline.mjs always builds from
// every migration file currently in drizzle/, not incrementally. "0049"
// is deliberately skipped -- drizzle/pending-review/0049_fix_calendar_
// schema_text_staging_repair.sql already reserves that number for a
// separate, unrelated, not-yet-reviewed draft kept outside drizzle/ for
// exactly this reason. Migration 0054 itself is STAGING ONLY -- NOT
// applied to Production as part of this round (same carve-out as
// 0046/0047/0050/0051) -- see docs/AI-HANDOFF.md for exactly which
// migrations are and are not confirmed live in Production as of this
// round; this manifest describes the intended baseline a newly
// provisioned or synced environment should have, reconciled against
// real Production only once a deployment round actually ships there.
//
// 55 as of 0055_trip_multi_region.sql (Multi-Region Trip Destination,
// 2026-10-26, see docs/AI-HANDOFF.md) -- one new table
// (trip_destination_regions), same STAGING ONLY carve-out as 0054 and
// every other migration in this trip-planning feature so far.
//
// 56 as of 0056_trip_archive_delete.sql (Add Archive and Delete
// Options to Trip Planner, 2026-11-02, see docs/AI-HANDOFF.md) -- one
// new column (trips.archived_at) and its index, same STAGING ONLY
// carve-out.
export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 56;

// Tables that hold the app's own account/authentication state rather than a
// fundraiser's relationship or giving data. A brand-new environment is
// expected to contain exactly one owner's row here after their first
// authenticated visit; that must never register as fundraising business
// data. Used only by the independent-staging Workspace Health summary — the
// backup-safety gate and rehearsal scripts keep using the untouched,
// intentionally conservative BUSINESS_DATA_COUNT_SQL above.
//
// backup_alert_state holds the same kind of thing: operational dedupe
// state for the Backup Scheduling Reliability Stage 3 email alert (which
// stale-incident an email was already sent for), never donor or
// fundraising data. See drizzle/0035_backup_alert_state.sql.
//
// agenda_send_log is the same kind of thing again: operational dedupe
// state for the Daily Fundraising Agenda send (October 14 2026 incident,
// docs/AI-HANDOFF.md), never donor or fundraising data. See
// drizzle/0043_agenda_send_log.sql.
//
// agenda_manual_test_send_log is the same kind of thing once more: the
// one-time claim record for the temporary Production Gmail OAuth
// verification mechanism (October 14 2026 incident, docs/AI-HANDOFF.md),
// never donor or fundraising data. See
// drizzle/0044_agenda_manual_test_send_log.sql.
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

// Removes SQL `--` line comments, respecting single-quoted string
// literals (so a literal `--` inside a string, or a `'` escaped as `''`,
// is never mistaken for a comment) -- never touches `/* */` block
// comments, since none exist anywhere in this project's real schema
// (confirmed by direct search of drizzle/*.sql; every `/*` that appears
// there is plain prose inside an ordinary `--` line comment, e.g. a
// `lib/research/*` path). Called BEFORE whitespace collapsing
// specifically: once a table's whole CREATE TABLE text is flattened
// onto one line, a `--` comment that used to end at a real newline has
// no terminator left at all, and silently swallows every following
// column/constraint as part of itself -- see normalizeSchemaSql's own
// doc comment for the real defect this caused (2026-11-02, "Final
// Schema and Deployment Safeguard Cleanup", docs/AI-HANDOFF.md).
function stripSqlLineComments(sql: string): string {
  let result = "";
  let inString = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (inString) {
      result += char;
      if (char === "'") {
        if (sql[index + 1] === "'") { result += sql[++index]; }
        else inString = false;
      }
      continue;
    }
    if (char === "'") { inString = true; result += char; continue; }
    if (char === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      continue;
    }
    result += char;
  }
  return result;
}

// Resolve Staging-only calendar_event_links/calendar_event_link_history
// schema differences (2026-11-02, see docs/AI-HANDOFF.md's "Final Schema
// and Deployment Safeguard Cleanup" entry). Root cause: an earlier review
// round briefly added explanatory `--` comments INSIDE these two tables'
// column lists (since corrected in the migration file itself, commit
// d153259), and Staging's real tables were created from that pre-fix
// text before the correction landed -- a table's own stored CREATE
// TABLE text, once created, is never retroactively rewritten just
// because the migration file that created it later changes. A `--`
// comment is completely inert SQL -- it can never represent a real
// column, type, default, constraint, or index -- so its mere presence
// or position can never be a genuine structural difference; stripping
// it before comparison is strictly more correct than treating it as
// one, and can never mask a real difference the way a general "ignore
// extra content" rule could. This also happens to fix a second, more
// serious, non-cosmetic defect in the same stored text: `normalizeSchemaSql`
// is also what `lib/operations/schema-backup.ts`'s buildSchemaOnlyBackup()
// uses to serialize a schema-only backup -- collapsing the OLD,
// uncommented-out `--` text onto one line destroyed its only terminator,
// so restoring that backup threw a genuine "near CREATE: syntax error"
// (see tests/calendar-schema-repair-rehearsal.test.mjs, which rehearsed
// drizzle/pending-review/0049_fix_calendar_schema_text_staging_repair.sql
// as a live-table-rebuild fix for exactly this). Fixing the shared
// normalization function instead resolves both the Health-page warning
// and the backup/restore defect with no database change at all, which is
// why that migration is NOT being applied -- see this round's entry in
// docs/AI-HANDOFF.md for the full comparison.
export const normalizeSchemaSql = (value: unknown) => stripSqlLineComments(String(value ?? "")).replace(/\s+/g, " ").trim();

// Resolve Production Schema Health Warnings (2026-11-02, see
// docs/AI-HANDOFF.md's investigation and this entry). Root cause: the
// previous comparison treated a table's whole `CREATE TABLE` string as
// one opaque blob, so two columns added by two different migrations to
// the SAME table, applied to an environment in a different relative
// order than the migration files are numbered, produced a textually
// different but STRUCTURALLY IDENTICAL table -- SQLite's own `ALTER
// TABLE ADD COLUMN` always appends to the table's current end, so
// whichever of two such migrations physically ran first ends up
// positioned earlier. This is a real, reproducible property of how
// this project actually deploys (individual, per-round `wrangler d1
// execute --file` runs, not one atomic ordered bootstrap per
// environment) -- confirmed for `interactions` (migration 0052's
// `write_token` landed before 0048's calendar columns on Production,
// the reverse of file order) -- never a sign of a genuine
// incompatibility, since every read/write in this codebase binds by
// column NAME, never position.
//
// `splitTopLevelClauses`/`tableColumnClauseSet` parse a table's column/
// constraint list into an ORDER-INDEPENDENT set of clauses (splitting
// on top-level commas only -- respecting parens, so a `CHECK (...)` or
// `REFERENCES x(y)` clause's own internal commas never get split) so a
// pure reordering of otherwise-identical clauses compares as a match,
// while a genuinely added, removed, retyped, or reconstrained column
// still produces a different clause set and still correctly fails.
// Index comparison is deliberately left untouched (exact text, order-
// sensitive): a compound index's own column order is semantically
// meaningful (which queries it can serve), never an incidental
// deployment-order artifact the way a table's own column list is.
function splitTopLevelClauses(body: string): string[] {
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    if (char === "," && depth === 0) {
      clauses.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

// Returns null (never an empty set) when the statement cannot be
// confidently parsed (no balanced top-level parens found) -- the
// caller must then fall back to the strict, pre-existing whole-string
// comparison rather than silently treat an unparseable statement as a
// match. A real, well-formed `CREATE TABLE ... (...)` always parses.
function tableColumnClauseSet(sql: string): Set<string> | null {
  const normalized = normalizeSchemaSql(sql);
  const openIndex = normalized.indexOf("(");
  const closeIndex = normalized.lastIndexOf(")");
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) return null;
  return new Set(splitTopLevelClauses(normalized.slice(openIndex + 1, closeIndex)));
}

function clauseColumnName(clause: string): string | null {
  const match = clause.match(/^`(\w+)`/);
  return match ? match[1] : null;
}

// Known, accepted, already-investigated historical drift -- NOT a
// general-purpose escape hatch. Confirmed (docs/AI-HANDOFF.md, this
// round): `trip_prospects.all_day`/`all_day_date` are genuinely dead --
// zero application code anywhere references them, and every one of
// Production's real rows holds exactly the column's own unchanged
// default (never a real value). Root cause: migration
// `0054_trip_manual_prospects.sql` rebuilds `trip_prospects` with an
// explicit, named column list that never re-declares these two columns
// (added one migration earlier by `0048_google_calendar_sync.sql`), so
// any FRESH bootstrap or migration replay -- what Staging and the
// packaged baseline both reflect -- ends up without them, while
// Production's own real, incremental deployment history happened to
// apply 0054's rebuild before 0048's trip_prospects columns existed
// there, so Production alone still has them. Removing them from
// Production would require an unnecessary, risky full-table rebuild of
// a heavily-referenced table (many FKs point at it) for zero
// functional benefit; adding them to Staging via a new migration would
// be a schema change with no application or data justification --
// "fixing the dashboard" is never sufficient justification on its own
// for either. This allowlist is intentionally narrow: it excuses ONLY
// these two exact, named columns on this one exact table from the
// "unexpected extra column" check; it can never mask a different
// extra column, a missing column, or a genuinely changed one (a
// redefinition of either column would still correctly surface as a
// difference -- see tests/production-baseline.test.mjs). If a future
// feature starts genuinely using either column, add it to a real
// migration and the baseline, and remove its entry here -- this
// exception describes today's confirmed-unused state only, not a
// permanent exemption.
const ACCEPTED_EXTRA_LIVE_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["trip_prospects", new Set(["all_day", "all_day_date"])],
]);

export function compareSchemaObjects(liveObjects: readonly SchemaObject[], baselineObjects: readonly SchemaObject[] = PRODUCTION_BASELINE_OBJECTS): SchemaComparison {
  const live = new Map(liveObjects.map((object) => [`${object.type}:${object.name}`, object]));
  const baseline = new Map(baselineObjects.map((object) => [`${object.type}:${object.name}`, object]));
  const differences: string[] = [];
  for (const [key, expected] of baseline) {
    const actual = live.get(key);
    if (!actual) { differences.push(`Missing ${expected.type}: ${expected.name}.`); continue; }
    if (expected.type === "index") {
      if (normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) differences.push(`Index definition differs: ${expected.name}.`);
      continue;
    }
    const actualClauses = tableColumnClauseSet(actual.sql);
    const expectedClauses = tableColumnClauseSet(expected.sql);
    if (!actualClauses || !expectedClauses) {
      // Could not confidently parse either side -- fall back to the
      // original strict comparison rather than silently pass.
      if (normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) differences.push(`Table definition differs: ${expected.name} (columns or constraints).`);
      continue;
    }
    const missingClauses = [...expectedClauses].filter((clause) => !actualClauses.has(clause));
    const extraClauses = [...actualClauses].filter((clause) => !expectedClauses.has(clause));
    const unexplainedExtraClauses = extraClauses.filter((clause) => {
      const columnName = clauseColumnName(clause);
      return !(columnName && ACCEPTED_EXTRA_LIVE_COLUMNS.get(expected.name)?.has(columnName));
    });
    if (missingClauses.length > 0 || unexplainedExtraClauses.length > 0) differences.push(`Table definition differs: ${expected.name} (columns or constraints).`);
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

// Repair and Verify Backup Restoration follow-up (2026-11-02, see
// docs/AI-HANDOFF.md's "Historical Backup Schema Validation" entry).
// Root cause: scripts/verify-remote-restore.mjs's restored-schema check
// always compared against TODAY's packaged baseline (PRODUCTION_BASELINE_OBJECTS,
// via compareSchemaObjects()'s own default argument) -- which is correct
// for the LATEST backup, but genuinely wrong for an older one: a backup
// taken before a later schema-affecting migration landed on the real
// database can NEVER structurally match today's baseline, through no
// fault of the backup or the restore mechanism (confirmed: GitHub Actions
// run 41466993401 restored a November 1 Staging backup and correctly
// found `trips_owner_archived_idx` missing -- migration 0056 was applied
// to the real Staging database on November 2, one day AFTER that backup
// was taken; the live Staging database has the index right now). This is
// the exact same class of problem already solved for
// production_schema_baseline's own backup-fidelity row below (compare
// against the BACKUP's own stamp, never today's) -- generalized here to
// the full structural schema comparison, which had not yet been fixed the
// same way.
//
// This function extracts the SAME SchemaObject{type,name,sql} shape
// stagingSchemaObjects() derives from a live database's sqlite_schema
// rows, but from the BACKUP FILE'S OWN embedded CREATE TABLE/INDEX
// statements instead -- the backup's own declared schema travels WITH
// it, so no separate historical-baseline lookup or migration-level
// tracking is needed. Passed as compareSchemaObjects()'s `baselineObjects`
// argument (which already supported overriding the default), this makes
// restore verification check "did the restore faithfully reproduce
// EXACTLY what this backup itself specifies" -- the real question a
// restore mechanism's own correctness turns on -- rather than "does this
// particular backup happen to already contain every table/index today's
// LATEST migration expects," a different, unrelated question already
// covered elsewhere (scripts/check-main-restore-sync.mjs / the monthly
// migration-sync guard) and never this script's job. A genuine restore
// defect -- the restored database missing, adding, or changing a
// table/index relative to what the backup's own SQL explicitly declared
// -- is still caught exactly as before; only the comparison TARGET
// changed, not the comparison's strictness.
//
// CREATE TRIGGER/VIEW/VIRTUAL TABLE statements (none exist in this
// project's real schema today) are skipped here, by design, the same way
// stagingSchemaObjects() already filters a live database's rows to
// type IN ('table','index') only -- so both sides of the comparison stay
// symmetric.
//
// Trailing `;` fix (2026-11-02, GitHub Actions run 41470202722, job
// 125361466671): this function's first version compared as "different"
// against EVERY one of the real schema's 100 indexes -- never fewer,
// never a genuine subset, always the full count -- which was itself the
// clue this was a structural parsing bug, not real drift. Investigated
// directly against a real restore (schema-only export restored into a
// disposable scratch database, its sqlite_schema queried back and
// diffed against the export's own text byte-for-byte): Cloudflare D1/
// SQLite does NOT rewrite, reformat, or normalize a CREATE INDEX
// statement's stored text at all -- it is preserved verbatim, including
// multi-line formatting. The one real asymmetry: `sqlite_schema.sql`
// NEVER includes the statement's trailing `;` (SQLite strips it when
// storing a CREATE statement), but a statement parsed out of raw backup
// SQL TEXT via parseRestoreStatements() (lib/operations/d1-restore-
// order.ts) always still has it, since that parser splits on a line
// ending in `;` without removing it. compareSchemaObjects()'s TABLE path
// never surfaced this (tableColumnClauseSet() only ever looks between
// the first `(` and the last `)`, so a trailing `;` after the final `)`
// is already irrelevant there); only the INDEX path -- a plain whole-
// string comparison, by design, since a compound index's column order
// is semantically meaningful -- was ever exposed to it, and it broke
// literally every index, every time. Stripped the SAME way this
// codebase already strips a trailing statement terminator elsewhere
// (lib/operations/d1-restore-order.ts's parameterizeInsertStatement),
// rather than loosening compareSchemaObjects()'s own exact-text,
// order-sensitive index comparison -- a genuinely missing index, a
// changed indexed column or column order, a UNIQUE/non-UNIQUE
// difference, or a partial index's WHERE condition differing all still
// fail exactly as before (see tests/production-baseline.test.mjs).
const CREATE_OBJECT_PATTERN = /^CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX|TRIGGER|VIEW|VIRTUAL\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/i;

export function backupSchemaObjects(createStatements: readonly string[]): SchemaObject[] {
  const objects: SchemaObject[] = [];
  for (const statement of createStatements) {
    const match = statement.match(CREATE_OBJECT_PATTERN);
    if (!match) throw new Error(`backupSchemaObjects: could not parse a CREATE statement's type/name -- refusing to guess: ${statement.slice(0, 160)}`);
    const [, kind, name] = match;
    // A real `wrangler d1 export`-shaped CREATE statement always ends with
    // exactly one terminating `;` (parseRestoreStatements() only ever
    // groups lines up to and including one) -- stripped here, once, so it
    // is never mistaken for a real structural difference against
    // sqlite_schema's own stored text, which never has one.
    const withoutTerminator = statement.replace(/;\s*$/, "");
    if (/INDEX/i.test(kind)) objects.push({ type: "index", name, sql: normalizeSchemaSql(withoutTerminator) });
    else if (/^TABLE$/i.test(kind)) objects.push({ type: "table", name, sql: normalizeSchemaSql(withoutTerminator) });
    // TRIGGER / VIEW / VIRTUAL TABLE: deliberately excluded, matching
    // stagingSchemaObjects()'s own type IN ('table','index') filter.
  }
  return objects.sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}
