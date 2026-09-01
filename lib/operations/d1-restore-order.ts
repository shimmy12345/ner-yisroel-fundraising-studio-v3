import { STAGING_RESET_TABLE_ORDER } from "./staging-reset.ts";

// Dependency-safe order to load DATA into a D1 database whose schema has
// already been fully created. This is the reverse of
// STAGING_RESET_TABLE_ORDER (which deletes children before parents, so no
// foreign key ever points at an already-deleted row) -- for insertion the
// requirement is the opposite: every parent row must exist before any
// child row whose foreign key references it.
//
// Ported from the proven implementation on main (commit 92e0bfd and
// follow-ups) -- this file did not previously exist on this branch (see
// lib/operations/d1-backup-rows.ts's own header comment for why: this
// branch's own scripts/verify-remote-restore.mjs restores an export
// directly without reordering, since it was never exercised against a
// large real export). It is added here now so the dependency order can be
// derived, tested, and proven correct against this branch's own richer
// schema-derivation tooling (lib/data-health/production-baseline.ts,
// STAGING_RESET_TABLE_ORDER's own regression test) BEFORE the equivalent,
// narrower data-only fix is ported to main -- see
// docs/AI-HANDOFF.md's "D1 Monthly Restore Verification Repair" entry.
//
// Four tables are prepended as true roots -- nothing in the schema has a
// foreign key pointing at any of them (except backup_alert_state, which
// only depends on users -- already listed before it here), so their
// relative order otherwise never matters, but all of them must be
// inserted before anything that could reference them:
//   - "users" and "onboarding_preferences" are two of the three
//     ACCOUNT_CONFIGURATION_TABLES (lib/data-health/production-baseline.ts).
//     STAGING_RESET_TABLE_ORDER never includes them -- a staging reset
//     deliberately preserves the owner's account rows instead of deleting
//     them -- so they are not part of its reversed order either.
//   - "backup_alert_state" is the third ACCOUNT_CONFIGURATION_TABLE
//     (added by Backup Scheduling Reliability Stage 3,
//     drizzle/0035_backup_alert_state.sql) -- also excluded from
//     STAGING_RESET_TABLE_ORDER for the same reason. Its own
//     `userId` column IS a real foreign key to users.id, so it is listed
//     here AFTER "users" specifically (not merely alongside it as a true
//     zero-dependency root like production_schema_baseline below).
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
// request internally. Confirmed empirically on main 2026-08-16: a real
// nightly export applied via a single
// `wrangler d1 execute --remote --file=...` against a throwaway scratch
// database failed with exactly "no such table: main.users: SQLITE_ERROR"
// (schema+data combined) and "FOREIGN KEY constraint failed:
// SQLITE_CONSTRAINT" (data-only, applied after a separate successful
// schema-only restore) -- reordering data per this list before restoring
// resolved both.
export const D1_RESTORE_DATA_ORDER: readonly string[] = [
  "production_schema_baseline",
  "users",
  "backup_alert_state",
  "onboarding_preferences",
  ...[...STAGING_RESET_TABLE_ORDER].reverse(),
];

// A second, independent restore-blocking problem discovered on main while
// fixing the ordering issue above (2026-08-16): a real, current
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

// A third, independent restore-blocking problem, found on main while
// tracking down why `data_imports` (real audit/history data -- must never
// be skipped) still failed after the ordering fix and the per-table split
// above (2026-08-16). Binary-searched empirically against a fresh
// throwaway scratch database for each size tested (eliminating sequence-
// position as a variable): a single INSERT statement with its values
// written as literal SQL text fails with "statement too long:
// SQLITE_TOOBIG" somewhere between 100,000 and 102,400 bytes, regardless
// of which table it targets or where in the restore sequence it runs --
// confirmed with synthetic statements of exact known sizes, not just the
// real data_imports row. This is D1's bulk Import pipeline enforcing a
// hard SQL-TEXT-length ceiling per statement, unrelated to the total
// amount of data in the row.
//
// The fix is not a bigger/smaller chunk of statements -- no amount of
// regrouping helps a single statement that is already too big alone.
// Confirmed empirically: the D1 HTTP query API
// (POST .../d1/database/{id}/query with a JSON body of
// {sql, params}) accepts a PARAMETERIZED statement whose SQL TEXT is tiny
// (placeholders only) with a 300KB value passed in `params` -- nearly 2x
// the real data_imports row's size and well past the inline-literal
// ceiling -- with no error. The limit is specifically on inline SQL TEXT
// length, not on parameter/row data size. parameterizeInsertStatement
// below converts a single-row INSERT statement into exactly this shape;
// a caller uses it only for statements at or above this threshold,
// calling the D1 HTTP API directly for those and leaving every
// normal-sized statement on the already-proven `wrangler d1 execute
// --file` path unchanged.
export const D1_SAFE_STATEMENT_BYTES = 65536;

// Splits the inner content of a SQL "VALUES(...)" or column-list "(...)"
// clause into its top-level comma-separated expressions, respecting
// single-quoted string literals (where '' is an escaped quote, not the
// end of the string) and parenthesized sub-expressions (e.g. a function
// call like replace('a','b',char(10))) so commas inside either are never
// mistaken for tuple separators. Never modifies the substrings it splits
// out -- reassembling them with "," reproduces the input exactly.
export function splitTopLevelSqlValues(inner: string): string[] {
  const values: string[] = [];
  let depth = 0;
  let inString = false;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") { current += "'"; i++; }
        else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === "(") { depth++; current += ch; continue; }
    if (ch === ")") { depth--; current += ch; continue; }
    if (ch === "," && depth === 0) { values.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim() !== "") values.push(current.trim());
  return values;
}

export type ClassifiedSqlValue = { kind: "string" | "number" | "null"; value: string | number | null } | { kind: "other" };

// Classifies a single top-level VALUES expression as a plain literal
// (safely bindable as a parameter) or "other" (a function call or other
// expression -- e.g. replace('a','b',char(10)), seen in real exports for
// text fields with embedded newlines -- which cannot be represented as a
// single bound parameter and must stay as inline SQL text).
export function classifySqlValueExpression(expr: string): ClassifiedSqlValue {
  const trimmed = expr.trim();
  if (/^null$/i.test(trimmed)) return { kind: "null", value: null };
  if (/^-?\d+$/.test(trimmed)) return { kind: "number", value: Number(trimmed) };
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(trimmed)) return { kind: "number", value: Number(trimmed) };
  if (/^'(?:[^']|'')*'$/.test(trimmed)) return { kind: "string", value: trimmed.slice(1, -1).replace(/''/g, "'") };
  return { kind: "other" };
}

// Converts a single-row INSERT statement, exactly as `wrangler d1 export`
// emits it (`INSERT INTO "table" (col,...) VALUES(v,...);`), into a
// parameterized statement: SQL text with "?" placeholders (tiny,
// regardless of how large the original values were) plus a `params`
// array carrying the actual values, safe to send to the D1 HTTP query
// API's {sql, params} body. Returns null -- never guesses -- if the
// statement is not a single-row INSERT this parser recognizes, or if any
// value is not a plain literal (a number, a quoted string, or NULL) it
// can safely bind as a parameter. The caller must fail loudly on null,
// never fall back to sending the original oversized statement as-is.
export function parameterizeInsertStatement(statementSql: string): { sql: string; columns: string[]; params: Array<string | number | null> } | null {
  const trimmed = statementSql.trim().replace(/;\s*$/, "");
  const match = trimmed.match(/^INSERT INTO ("[^"]+")\s*\(([^)]*)\)\s*VALUES\(([\s\S]*)\)$/);
  if (!match) return null;
  const [, tableRef, columnList, valuesInner] = match;
  const columns = splitTopLevelSqlValues(columnList).map((column) => column.replace(/^"|"$/g, ""));
  const values = splitTopLevelSqlValues(valuesInner);
  if (values.length === 0 || values.length !== columns.length) return null;
  const params: Array<string | number | null> = [];
  for (const value of values) {
    const classified = classifySqlValueExpression(value);
    if (classified.kind === "other") return null;
    params.push(classified.value);
  }
  const placeholders = values.map(() => "?").join(",");
  return { sql: `INSERT INTO ${tableRef} (${columnList}) VALUES(${placeholders})`, columns, params };
}

// Extracts a single row's column values from an export's raw SQL text --
// e.g. reading a specific marker row (like production_schema_baseline's
// id='0019' row) directly out of a SOURCE BACKUP FILE, independent of and
// prior to any restore. Used to verify BACKUP FIDELITY (does the restored
// database faithfully reproduce a specific row from the backup) as
// distinct from CURRENT STRUCTURAL INTEGRITY (does the restored schema
// match today's packaged manifest -- see compareSchemaObjects in
// lib/data-health/production-baseline.ts) -- these are two different
// questions and must not be conflated. Returns null if the table has no
// INSERT with a matching value in whereColumn (never guesses or returns a
// partial/best-effort row).
export function findInsertedRow(
  sqlText: string,
  table: string,
  whereColumn: string,
  whereValue: string | number | null,
): Record<string, string | number | null> | null {
  const statements = parseRestoreStatements(sqlText).insertsByTable.get(table) ?? [];
  for (const statement of statements) {
    const parsed = parameterizeInsertStatement(statement);
    if (!parsed) continue;
    const row: Record<string, string | number | null> = {};
    parsed.columns.forEach((column, index) => { row[column] = parsed.params[index]; });
    if (row[whereColumn] === whereValue) return row;
  }
  return null;
}

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

// A single restore step for one table. "file" steps bundle every
// normal-sized statement for that table into one SQL blob meant for
// `wrangler d1 execute --file=...`; "statement" steps are one individual
// pre-parameterized oversized INSERT meant for the D1 HTTP query API
// (POST .../d1/database/{id}/query with {sql, params} -- see
// D1_SAFE_STATEMENT_BYTES's doc comment for why). A table with both
// normal and oversized rows produces one of each kind, consecutively.
export type D1RestoreStep =
  | { table: string; kind: "file"; sql: string }
  | { table: string; kind: "statement"; sql: string; params: Array<string | number | null> };

export type D1RestorePlan = {
  // PRAGMA preamble + every CREATE statement, applied first as one file.
  schemaSql: string;
  // One or two entries per table with data (a "file" step for its
  // normal-sized rows, a "statement" step for each oversized row), in
  // dependency-safe table order -- critically, ALL of a table's steps
  // (file and statement) appear together, at that table's position in
  // the order, before moving on to the next table.
  steps: D1RestoreStep[];
  // ANALYZE / sqlite_stat1, applied last as one file (optional -- these
  // are query-planner hints, not data; a restore is still fully correct
  // without them).
  trailingStatsSql: string;
  // Tables with real INSERT data in the export that were deliberately
  // left out of steps -- see D1_RESTORE_SKIP_DATA_TABLES.
  skippedTables: string[];
};

export function planD1Restore(
  sqlText: string,
  order: readonly string[] = D1_RESTORE_DATA_ORDER,
  skipDataForTables: readonly string[] = D1_RESTORE_SKIP_DATA_TABLES,
  safeStatementBytes: number = D1_SAFE_STATEMENT_BYTES,
): D1RestorePlan {
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
  const steps: D1RestoreStep[] = [];
  for (const table of order) {
    if (skip.has(table)) continue;
    const statements = parsed.insertsByTable.get(table) ?? [];
    if (statements.length === 0) continue;
    const small: string[] = [];
    const oversized: Array<{ sql: string; params: Array<string | number | null> }> = [];
    for (const statement of statements) {
      if (statement.length < safeStatementBytes) { small.push(statement); continue; }
      const parameterized = parameterizeInsertStatement(statement);
      if (!parameterized) {
        throw new Error(`planD1Restore found an oversized statement (${statement.length} bytes) for table "${table}" that could not be safely parameterized (not a recognized single-row INSERT, or contains a non-literal value expression). Refusing to guess -- this statement cannot be restored via either path:\n${statement.slice(0, 200)}...`);
      }
      oversized.push(parameterized);
    }
    if (small.length > 0) steps.push({ table, kind: "file", sql: small.join("\n") + "\n" });
    for (const statement of oversized) steps.push({ table, kind: "statement", ...statement });
  }
  const skippedTables = order.filter((table) => skip.has(table) && (parsed.insertsByTable.get(table)?.length ?? 0) > 0);
  return {
    schemaSql: [...parsed.preamble, ...parsed.schema].join("\n") + "\n",
    steps,
    trailingStatsSql: parsed.trailingStats.length > 0 ? parsed.trailingStats.join("\n") + "\n" : "",
    skippedTables,
  };
}
