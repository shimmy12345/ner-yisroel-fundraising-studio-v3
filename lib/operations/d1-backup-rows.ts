// Minimal SQL-backup-text parsing helpers needed to verify restore
// fidelity for a specific marker row (production_schema_baseline) without
// re-executing SQL. Ported from the proven implementation in
// lib/operations/d1-restore-order.ts on main (commit a9685bac34db) --
// deliberately narrow: this branch's restore path does not need per-table
// dependency ordering or oversized-statement chunking (main's
// D1_RESTORE_DATA_ORDER / planD1Restore), only "read one row out of raw
// backup SQL text," so only that slice was ported.

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
// (safely readable as a value) or "other" (a function call or other
// expression -- e.g. replace('a','b',char(10)) -- that cannot be
// represented as a single literal value).
export function classifySqlValueExpression(expr: string): ClassifiedSqlValue {
  const trimmed = expr.trim();
  if (/^null$/i.test(trimmed)) return { kind: "null", value: null };
  if (/^-?\d+$/.test(trimmed)) return { kind: "number", value: Number(trimmed) };
  if (/^-?\d+\.\d+([eE][-+]?\d+)?$/.test(trimmed)) return { kind: "number", value: Number(trimmed) };
  if (/^'(?:[^']|'')*'$/.test(trimmed)) return { kind: "string", value: trimmed.slice(1, -1).replace(/''/g, "'") };
  return { kind: "other" };
}

// Parses a single-row INSERT statement, exactly as `wrangler d1 export`
// emits it (`INSERT INTO "table" (col,...) VALUES(v,...);`), into its
// column names and literal values. Returns null -- never guesses -- if
// the statement is not a single-row INSERT this parser recognizes, or if
// any value is not a plain literal (a number, a quoted string, or NULL).
export function parameterizeInsertStatement(statementSql: string): { columns: string[]; params: Array<string | number | null> } | null {
  const trimmed = statementSql.trim().replace(/;\s*$/, "");
  const match = trimmed.match(/^INSERT INTO ("[^"]+")\s*\(([^)]*)\)\s*VALUES\(([\s\S]*)\)$/);
  if (!match) return null;
  const [, , columnList, valuesInner] = match;
  const columns = splitTopLevelSqlValues(columnList).map((column) => column.replace(/^"|"$/g, ""));
  const values = splitTopLevelSqlValues(valuesInner);
  if (values.length === 0 || values.length !== columns.length) return null;
  const params: Array<string | number | null> = [];
  for (const value of values) {
    const classified = classifySqlValueExpression(value);
    if (classified.kind === "other") return null;
    params.push(classified.value);
  }
  return { columns, params };
}

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

const INSERT_STATEMENT = /^INSERT\s+INTO\s+["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/i;

// Extracts a single row's column values from an export's raw SQL text --
// e.g. reading a specific marker row (like production_schema_baseline's
// id='0019' row) directly out of a SOURCE BACKUP FILE, independent of and
// prior to any restore. Used to verify BACKUP FIDELITY (does the restored
// database faithfully reproduce a specific row from the backup) as
// distinct from CURRENT STRUCTURAL INTEGRITY (does the restored schema
// match today's packaged manifest -- see compareSchemaObjects in
// lib/data-health/production-baseline.ts) -- these are two different
// questions and must not be conflated (see scripts/verify-remote-restore.mjs's
// production_schema_baseline handling for the case this was built for).
// Returns null if the table has no INSERT with a matching value in
// whereColumn (never guesses or returns a partial/best-effort row).
export function findInsertedRow(
  sqlText: string,
  table: string,
  whereColumn: string,
  whereValue: string | number | null,
): Record<string, string | number | null> | null {
  for (const statement of splitIntoStatements(sqlText)) {
    const trimmed = statement.trim();
    const insertMatch = trimmed.match(INSERT_STATEMENT);
    if (!insertMatch || insertMatch[1] !== table) continue;
    const parsed = parameterizeInsertStatement(trimmed);
    if (!parsed) continue;
    const row: Record<string, string | number | null> = {};
    parsed.columns.forEach((column, index) => { row[column] = parsed.params[index]; });
    if (row[whereColumn] === whereValue) return row;
  }
  return null;
}
