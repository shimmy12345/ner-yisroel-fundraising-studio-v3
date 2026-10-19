// Builds the recovery batch for drizzle/pending-review/0049_fix_calendar_
// schema_text_staging_repair.sql: given a full backup export's raw SQL
// text (the same format `wrangler d1 export` produces, and the same
// line-terminated-statement convention lib/operations/d1-backup-rows.ts
// already parses), extracts and re-orders ONLY the statements for
// calendar_event_links/calendar_event_link_history into a single,
// FK-safe batch that replaces whatever is currently in those two tables
// with exactly what the backup contains.
//
// This exists because "import this file into the existing database" is
// not a real recovery procedure on its own: if the tables already exist
// (in whatever state -- original, successfully repaired, or anything a
// partially-applied/interrupted attempt could have left, though D1's own
// batch atomicity means that last case should never actually occur), a
// raw `wrangler d1 execute --file <backup>` replay of CREATE TABLE
// statements fails outright ("table already exists") rather than
// restoring anything. This module instead builds an explicit DROP-then-
// recreate batch, using the same never-drop-a-still-referenced-table
// ordering the repair migration itself proved safe on real D1: drop the
// CHILD table first (nothing references it), then the parent, then
// recreate the parent (with its data and indexes) before the child (so
// the child's own FK and its data insert both succeed immediately).
import { splitIntoStatements } from "./d1-backup-rows.ts";

export const CALENDAR_EVENT_LINKS_TABLE = "calendar_event_links";
export const CALENDAR_EVENT_LINK_HISTORY_TABLE = "calendar_event_link_history";

function quotedNamePattern(tableName: string): string {
  // Matches the table name wrapped in backticks, double quotes, or no
  // quoting at all -- a raw `wrangler d1 export` dump double-quotes
  // identifiers; this repo's own migrations backtick-quote them; a
  // table that went through an ALTER TABLE RENAME TO on real D1 can
  // come back double-quoted even from a backtick-quoted migration (see
  // docs/AI-HANDOFF.md's own finding) -- so this must tolerate any of
  // the three, never assume one.
  return `[\`"]?${tableName}[\`"]?`;
}

function isCreateTableFor(statement: string, tableName: string): boolean {
  return new RegExp(`^CREATE TABLE\\s+${quotedNamePattern(tableName)}\\s*\\(`, "i").test(statement.trim());
}

function isInsertInto(statement: string, tableName: string): boolean {
  return new RegExp(`^INSERT INTO\\s+${quotedNamePattern(tableName)}\\s*[\\s(]`, "i").test(statement.trim());
}

function isIndexOn(statement: string, tableName: string): boolean {
  return new RegExp(`^CREATE\\s+(UNIQUE\\s+)?INDEX\\b[\\s\\S]*\\bON\\s+${quotedNamePattern(tableName)}\\s*\\(`, "i").test(statement.trim());
}

// Statements for one table, in the SAME relative order the backup text
// itself used (a real export always emits a table's own CREATE before
// its INSERTs and indexes, so preserving backup order is sufficient --
// this never re-sorts, only filters).
function statementsForTable(statements: string[], tableName: string): { createTable: string | null; inserts: string[]; indexes: string[] } {
  let createTable: string | null = null;
  const inserts: string[] = [];
  const indexes: string[] = [];
  for (const statement of statements) {
    const trimmed = statement.trim();
    if (!trimmed) continue;
    if (isCreateTableFor(trimmed, tableName)) createTable = trimmed.replace(/;\s*$/, "");
    else if (isInsertInto(trimmed, tableName)) inserts.push(trimmed.replace(/;\s*$/, ""));
    else if (isIndexOn(trimmed, tableName)) indexes.push(trimmed.replace(/;\s*$/, ""));
  }
  return { createTable, inserts, indexes };
}

// Builds the ordered recovery statements (no trailing semicolons -- the
// caller `.prepare()`s each one individually, exactly like the repair
// migration's own statements). Throws, rather than returning a partial
// result, if either table's own CREATE TABLE statement cannot be found
// in the given backup text -- recovery must never silently recreate only
// half of the schema.
export function buildCalendarTablesRecoveryStatements(backupSqlText: string): string[] {
  const statements = splitIntoStatements(backupSqlText);
  const links = statementsForTable(statements, CALENDAR_EVENT_LINKS_TABLE);
  const history = statementsForTable(statements, CALENDAR_EVENT_LINK_HISTORY_TABLE);

  if (!links.createTable) throw new Error(`Recovery aborted: no CREATE TABLE statement for "${CALENDAR_EVENT_LINKS_TABLE}" found in the backup text.`);
  if (!history.createTable) throw new Error(`Recovery aborted: no CREATE TABLE statement for "${CALENDAR_EVENT_LINK_HISTORY_TABLE}" found in the backup text.`);

  return [
    // Child first: nothing references calendar_event_link_history, so
    // dropping it is always safe regardless of the current state of
    // either table.
    `DROP TABLE IF EXISTS \`${CALENDAR_EVENT_LINK_HISTORY_TABLE}\``,
    // Parent second: now safe, since the only table that could reference
    // it was just removed.
    `DROP TABLE IF EXISTS \`${CALENDAR_EVENT_LINKS_TABLE}\``,
    // Recreate the parent (schema, data, indexes) before the child, so
    // the child's own FOREIGN KEY and its INSERTs are satisfied
    // immediately -- no deferred-constraint behavior relied upon, same
    // principle as the repair migration itself.
    links.createTable,
    ...links.inserts,
    ...links.indexes,
    history.createTable,
    ...history.inserts,
    ...history.indexes,
  ];
}
