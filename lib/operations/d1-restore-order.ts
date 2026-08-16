import { STAGING_RESET_TABLE_ORDER } from "./staging-reset.ts";

// Dependency-safe order to load DATA into a D1 database whose schema has
// already been fully created. This is the reverse of
// STAGING_RESET_TABLE_ORDER (which deletes children before parents, so no
// foreign key ever points at an already-deleted row) -- for insertion the
// requirement is the opposite: every parent row must exist before any
// child row whose foreign key references it.
//
// Three tables are prepended as true roots -- nothing in the schema has a
// foreign key pointing at any of them, so their relative order never
// matters, but all of them must be inserted before anything that could
// reference them:
//   - "users" and "onboarding_preferences" are the two
//     ACCOUNT_CONFIGURATION_TABLES (lib/data-health/production-baseline.ts).
//     STAGING_RESET_TABLE_ORDER never includes them -- a staging reset
//     deliberately preserves the owner's account rows instead of deleting
//     them -- so they are not part of its reversed order either.
//   - "production_schema_baseline" is the schema-verification marker
//     table. Nothing references it and it references nothing.
//
// Why this exists: `wrangler d1 export` orders CREATE TABLE and INSERT
// statements by each table's position in sqlite_master, not by foreign-key
// dependency (e.g. `donors`, which has a foreign key to `users`, is
// exported before `users` itself). Restoring a large export via
// `wrangler d1 execute --remote --file=...` goes through D1's own
// server-side Import pipeline, which applies the file across several
// internal batches -- and `PRAGMA defer_foreign_keys=TRUE` (set once, at
// the top of the exported file) does not survive across those internal
// batch boundaries. A row inserted in an early batch that references a
// row not inserted until a later batch fails immediately: either
// "no such table" (if the referenced TABLE was also created in a later
// batch -- though in practice CREATE TABLE order alone never triggers
// this, since SQLite does not validate a forward foreign-key reference's
// target at CREATE TABLE time) or a foreign-key constraint violation (if
// the table exists but the specific referenced ROW has not been inserted
// yet). Restoring data in this order guarantees every parent row that
// could ever be referenced already exists by the time any row that might
// reference it is applied, regardless of how D1 chooses to batch the
// request internally. Confirmed empirically 2026-08-16: a real nightly
// export applied via a single `wrangler d1 execute --remote --file=...`
// against a throwaway scratch database failed with exactly
// "no such table: main.users: SQLITE_ERROR" (schema+data combined) and
// "FOREIGN KEY constraint failed: SQLITE_CONSTRAINT" (data-only, applied
// after a separate successful schema-only restore) -- reordering data per
// this list before restoring resolved both.
export const D1_RESTORE_DATA_ORDER: readonly string[] = [
  "production_schema_baseline",
  "users",
  "onboarding_preferences",
  ...[...STAGING_RESET_TABLE_ORDER].reverse(),
];

// A second, independent restore-blocking problem discovered while fixing
// the ordering issue above (2026-08-16): a real, current
// import_preview_session_chunks row on fundraising-os-staging-db is
// ~512KB (a single chunk of a large in-progress donation-import review
// session -- see lib/import/preview-session.ts / lib/import/d1-json-chunks.ts).
// Restoring the reordered export into a fresh scratch database still
// failed, this time with "statement too long: SQLITE_TOOBIG" -- D1's bulk
// Import pipeline enforces its own per-statement size limit, independent
// of and lower than whatever limit the app's own live `env.DB` write path
// respects. This is unrelated to foreign-key ordering; it would have
// surfaced on its own once the ordering problem was fixed.
//
// import_preview_sessions and import_preview_session_chunks are already
// explicitly classified as not backup-worthy in
// lib/operations/workspace-backup.ts (ephemeral review-session working
// state with its own 14-day inactivity TTL) -- losing in-flight,
// soon-to-expire import-review cache in a disaster-recovery scenario is
// an accepted, already-documented tradeoff, unlike silently failing to
// restore or verify the backup at all because of it. Restore verification
// therefore restores every table's SCHEMA (proving the structure itself
// is intact) but deliberately skips DATA for exactly these two tables --
// a named, visible exclusion, not a silent one. This must never be used
// to skip a table with real donor/relationship/giving data; if a future
// table legitimately needs this treatment, add it here with the same
// reasoning, not by loosening the fail-loud "unknown table" check below.
export const D1_RESTORE_SKIP_DATA_TABLES: readonly string[] = ["import_preview_sessions", "import_preview_session_chunks"];

export type ParsedRestoreStatements = {
  // PRAGMA lines and anything else that precedes the first CREATE/INSERT
  // statement, in original order. Applied first, unchanged.
  preamble: string[];
  // CREATE TABLE / CREATE INDEX / CREATE TRIGGER / CREATE VIEW statements,
  // in original file order. Order among these never matters for foreign
  // keys (see above) so they are never reordered -- only grouped ahead of
  // all data.
  schema: string[];
  // INSERT statements grouped by target table, each table's own list in
  // original (exported row) order.
  insertsByTable: Map<string, string[]>;
  // `ANALYZE ...;` plus `INSERT INTO "sqlite_stat1" ...;` -- SQLite's
  // query-planner statistics, not application data. `wrangler d1 export`
  // emits these last, after every CREATE INDEX; they are query-planner
  // hints describing the table/index data, so they only make sense
  // applied after that data exists. Kept in original order, always
  // applied last.
  trailingStats: string[];
  // Any statement this parser did not recognize (should not happen
  // against a real `wrangler d1 export` output -- kept, never dropped, so
  // a genuinely novel statement type fails loudly downstream instead of
  // silently vanishing).
  unrecognized: string[];
};

const CREATE_STATEMENT = /^CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX|TRIGGER|VIEW|VIRTUAL\s+TABLE)\b/i;
const INSERT_STATEMENT = /^INSERT\s+INTO\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i;
const PRAGMA_STATEMENT = /^PRAGMA\b/i;
const ANALYZE_STATEMENT = /^ANALYZE\b/i;
// sqlite_stat1 is SQLite's own implicit query-planner-statistics table,
// not one of ours -- never subject to the application foreign-key
// dependency order, and not present in D1_RESTORE_DATA_ORDER on purpose.
const STATS_TABLE = "sqlite_stat1";

// `wrangler d1 export` output is machine-generated and consistent: every
// statement -- whether a single-line INSERT/PRAGMA or a multi-line CREATE
// TABLE block -- ends with a line whose trimmed end is exactly `;`. This
// walks the file line by line accumulating each statement until that
// terminator, which is sufficient for this specific, well-structured
// output without needing a full SQL parser.
function splitIntoStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let buffer: string[] = [];
  for (const line of sqlText.split("\n")) {
    buffer.push(line);
    if (line.trimEnd().endsWith(";")) {
      statements.push(buffer.join("\n"));
      buffer = [];
    }
  }
  if (buffer.some((line) => line.trim() !== "")) statements.push(buffer.join("\n"));
  return statements;
}

export function parseRestoreStatements(sqlText: string): ParsedRestoreStatements {
  const preamble: string[] = [];
  const schema: string[] = [];
  const insertsByTable = new Map<string, string[]>();
  const trailingStats: string[] = [];
  const unrecognized: string[] = [];
  let seenFirstCreateOrInsert = false;

  for (const statement of splitIntoStatements(sqlText)) {
    const trimmed = statement.trim();
    if (trimmed === "") continue;
    const insertMatch = trimmed.match(INSERT_STATEMENT);
    if (insertMatch) {
      seenFirstCreateOrInsert = true;
      const table = insertMatch[1];
      if (table === STATS_TABLE) {
        trailingStats.push(statement);
        continue;
      }
      if (!insertsByTable.has(table)) insertsByTable.set(table, []);
      insertsByTable.get(table)!.push(statement);
      continue;
    }
    if (CREATE_STATEMENT.test(trimmed)) {
      seenFirstCreateOrInsert = true;
      schema.push(statement);
      continue;
    }
    if (ANALYZE_STATEMENT.test(trimmed)) {
      seenFirstCreateOrInsert = true;
      trailingStats.push(statement);
      continue;
    }
    if (!seenFirstCreateOrInsert && PRAGMA_STATEMENT.test(trimmed)) {
      preamble.push(statement);
      continue;
    }
    unrecognized.push(statement);
  }
  return { preamble, schema, insertsByTable, trailingStats, unrecognized };
}

// Reassembles a parsed export with schema applied first (original order),
// data applied next in `order` (default: D1_RESTORE_DATA_ORDER), and
// query-planner statistics (ANALYZE / sqlite_stat1) applied last, since
// they only describe data that must already exist. Throws rather than
// silently dropping or misplacing data if the export contains an INSERT
// for a table this order does not know about -- the same "fail loudly on
// drift" contract as lib/operations/workspace-backup.ts's
// verifyWorkspaceBackupCoverage, so a future schema change can't silently
// reintroduce this class of bug.
export function reorderD1ExportForRestore(sqlText: string, order: readonly string[] = D1_RESTORE_DATA_ORDER, skipDataForTables: readonly string[] = D1_RESTORE_SKIP_DATA_TABLES): string {
  const parsed = parseRestoreStatements(sqlText);
  if (parsed.unrecognized.length > 0) {
    throw new Error(`reorderD1ExportForRestore encountered ${parsed.unrecognized.length} statement(s) it does not recognize (not PRAGMA, CREATE, INSERT, or ANALYZE) -- refusing to guess where they belong:\n${parsed.unrecognized.map((statement) => statement.slice(0, 120)).join("\n")}`);
  }
  const skip = new Set(skipDataForTables);
  const known = new Set(order);
  const unknownTables = [...parsed.insertsByTable.keys()].filter((table) => !known.has(table) && !skip.has(table));
  if (unknownTables.length > 0) {
    throw new Error(`reorderD1ExportForRestore found INSERT statements for table(s) not present in the dependency order: ${unknownTables.join(", ")}. Add them to D1_RESTORE_DATA_ORDER (lib/operations/d1-restore-order.ts) with the correct dependency position before restoring.`);
  }
  const orderedInserts = order.filter((table) => !skip.has(table)).flatMap((table) => parsed.insertsByTable.get(table) ?? []);
  return [...parsed.preamble, ...parsed.schema, ...orderedInserts, ...parsed.trailingStats].join("\n") + "\n";
}

export type D1RestorePlan = {
  // PRAGMA preamble + every CREATE statement, applied first as one file.
  schemaSql: string;
  // One entry per table with data, in dependency-safe order, each meant
  // to be applied as its OWN separate `wrangler d1 execute --file=...`
  // invocation rather than concatenated into one file.
  //
  // Why per-table, not one combined file: confirmed empirically
  // 2026-08-16 against fundraising-os-staging-db's real nightly export --
  // restoring the fully reordered, correctly-scoped 6.99MB export as a
  // single `wrangler d1 execute --remote --file=...` still failed with
  // "statement too long: SQLITE_TOOBIG", even though no individual
  // statement in that file exceeds 162KB (confirmed by re-parsing the
  // exact file that failed). Restoring the largest real table alone
  // (giving_activities, 4.36MB across 5171 INSERT statements) succeeded.
  // D1's remote bulk Import pipeline (POST .../import with action "init"
  // then "ingest", used internally for any `--remote --file` of
  // nontrivial size) evidently has some per-request or per-internal-batch
  // ceiling that a single large combined file can cross for reasons not
  // reproducible from statement size alone -- restoring one table's data
  // per request sidesteps needing to understand that undocumented
  // behavior further, and keeps any future failure attributable to one
  // specific table instead of an opaque whole-file error.
  dataSteps: Array<{ table: string; sql: string }>;
  // ANALYZE / sqlite_stat1, applied last as one file (optional -- these
  // are query-planner hints, not data; a restore is still fully correct
  // without them).
  trailingStatsSql: string;
  // Tables with real INSERT data in the export that were deliberately
  // left out of dataSteps -- see D1_RESTORE_SKIP_DATA_TABLES.
  skippedTables: string[];
};

export function planD1Restore(sqlText: string, order: readonly string[] = D1_RESTORE_DATA_ORDER, skipDataForTables: readonly string[] = D1_RESTORE_SKIP_DATA_TABLES): D1RestorePlan {
  const parsed = parseRestoreStatements(sqlText);
  if (parsed.unrecognized.length > 0) {
    throw new Error(`planD1Restore encountered ${parsed.unrecognized.length} statement(s) it does not recognize (not PRAGMA, CREATE, INSERT, or ANALYZE) -- refusing to guess where they belong:\n${parsed.unrecognized.map((statement) => statement.slice(0, 120)).join("\n")}`);
  }
  const skip = new Set(skipDataForTables);
  const known = new Set(order);
  const unknownTables = [...parsed.insertsByTable.keys()].filter((table) => !known.has(table) && !skip.has(table));
  if (unknownTables.length > 0) {
    throw new Error(`planD1Restore found INSERT statements for table(s) not present in the dependency order: ${unknownTables.join(", ")}. Add them to D1_RESTORE_DATA_ORDER (lib/operations/d1-restore-order.ts) with the correct dependency position before restoring.`);
  }
  const dataSteps = order
    .filter((table) => !skip.has(table) && (parsed.insertsByTable.get(table)?.length ?? 0) > 0)
    .map((table) => ({ table, sql: parsed.insertsByTable.get(table)!.join("\n") + "\n" }));
  const skippedTables = order.filter((table) => skip.has(table) && (parsed.insertsByTable.get(table)?.length ?? 0) > 0);
  return {
    schemaSql: [...parsed.preamble, ...parsed.schema].join("\n") + "\n",
    dataSteps,
    trailingStatsSql: parsed.trailingStats.length > 0 ? parsed.trailingStats.join("\n") + "\n" : "",
    skippedTables,
  };
}
