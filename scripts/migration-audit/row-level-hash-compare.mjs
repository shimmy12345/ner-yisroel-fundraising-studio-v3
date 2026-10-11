// Row-level, deterministic, cryptographic-hash comparison between a
// frozen source D1 export and a restored rehearsal database, for
// every migration-eligible table. Prints only counts and hash-match
// booleans -- never row content. This is the "do not rely solely on
// financial totals or a small selection of columns" check
// (docs/PRODUCTION-DONOR-DATA-MIGRATION-REHEARSAL.md): every column,
// every row, hashed and compared, not just aggregates.
//
// Method: for each table, extract its column list (in CREATE-TABLE
// order) from the export's own schema text, then:
//   SOURCE: parse every INSERT for that table from the export into a
//     column->value row object (handling both plain literals and the
//     one documented non-literal expression shape real exports
//     contain -- replace(...,char(10)) for embedded newlines -- via a
//     narrow, fail-loud evaluator, never a guess), then hash each row
//     (SHA-256 of a deterministic JSON serialization, fixed column
//     order, NULL normalized to null).
//   REHEARSAL: SELECT <same explicit column list> FROM table ORDER BY
//     id, hash each returned row the SAME way.
// Compares the two MULTISETS of hashes (sorted hash lists) -- this
// catches every value-level difference, addition, or omission,
// independent of row return order.
//
// Usage: node scripts/migration-audit/row-level-hash-compare.mjs <export.sql> <database-name> <restoreDir>
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  parseRestoreStatements,
  splitTopLevelSqlValues,
  classifySqlValueExpression,
} from "../../lib/operations/d1-restore-order.ts";

const [exportPath, db, restoreDir] = process.argv.slice(2);
if (!exportPath || !db || !restoreDir) throw new Error("Usage: node row-level-hash-compare.mjs <export.sql> <database-name> <restoreDir>");
const repoRoot = path.resolve(import.meta.dirname, "../..");

const sqlText = fs.readFileSync(exportPath, "utf8");
const parsed = parseRestoreStatements(sqlText);

// Extract ordered column names per table from its CREATE TABLE text.
// Real exports have been observed using EITHER backtick-table-name
// (`CREATE TABLE \`name\` (...)`) or double-quoted-with-IF-NOT-EXISTS
// (`CREATE TABLE IF NOT EXISTS "name" (...)`) for different tables in
// the SAME export file -- handle both, never assume one.
const columnsByTable = new Map();
for (const stmt of parsed.schema) {
  const m = stmt.match(/^CREATE TABLE(?: IF NOT EXISTS)? [`"]([^`"]+)[`"] \(([\s\S]*)\)\s*;?\s*$/);
  if (!m) continue;
  const [, table, body] = m;
  const cols = [];
  for (const line of body.split("\n")) {
    const colMatch = line.trim().match(/^`([^`]+)`\s+\w+/);
    if (colMatch) cols.push(colMatch[1]);
  }
  columnsByTable.set(table, cols);
}

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return String(value);
}

function hashRow(columns, rowObj) {
  const ordered = columns.map((c) => canonicalize(rowObj[c]));
  const h = crypto.createHash("sha256");
  h.update(JSON.stringify(ordered));
  return h.digest("hex");
}

// Evaluates the one documented non-literal expression shape real
// exports contain: replace('text with literal \n sequences', '\n',
// char(10)) -- `wrangler d1 export` escapes an embedded real newline
// byte as the two-character sequence \n inside the string literal,
// then wraps it in replace(...) to convert that sequence back to a
// real LF (code 10) at restore time. Recursive so char()/replace()
// can nest; throws (never guesses) on any other function or
// malformed expression, so an unrecognized shape fails loudly instead
// of silently mis-comparing.
function evaluateSqlExpression(expr) {
  const trimmed = expr.trim();
  const literal = classifySqlValueExpression(trimmed);
  if (literal.kind !== "other") return literal.value;
  const charMatch = trimmed.match(/^char\((\d+)\)$/i);
  if (charMatch) return String.fromCharCode(Number(charMatch[1]));
  const replaceMatch = trimmed.match(/^replace\(([\s\S]*)\)$/i);
  if (replaceMatch) {
    const args = splitTopLevelSqlValues(replaceMatch[1]);
    if (args.length !== 3) throw new Error(`replace() with ${args.length} args, expected 3: ${trimmed.slice(0, 100)}`);
    const [source, search, replacement] = args.map(evaluateSqlExpression);
    if (search === "") return source; // SQLite replace() semantics: empty search -> unchanged
    return String(source).split(String(search)).join(String(replacement));
  }
  throw new Error(`Unrecognized SQL expression (not a literal, char(), or replace()): ${trimmed.slice(0, 100)}`);
}

function parseInsertRow(statementSql) {
  const trimmed = statementSql.trim().replace(/;\s*$/, "");
  const match = trimmed.match(/^INSERT INTO ["`]([^"`]+)["`]\s*\(([^)]*)\)\s*VALUES\(([\s\S]*)\)$/);
  if (!match) return null;
  const [, , columnList, valuesInner] = match;
  const columns = splitTopLevelSqlValues(columnList).map((c) => c.replace(/^["`]|["`]$/g, ""));
  const values = splitTopLevelSqlValues(valuesInner);
  const row = {};
  values.forEach((raw, i) => { row[columns[i]] = evaluateSqlExpression(raw); });
  return { columns, row };
}

function q(sql) {
  const out = execSync(`npx --yes wrangler@4.92.0 d1 execute ${db} --remote --command "${sql.replace(/"/g, '\\"')}" --json`, { cwd: repoRoot, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
  const lines = out.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate)?.[0]?.results ?? []; } catch {}
  }
  throw new Error("No JSON found in: " + out);
}

// Tables deliberately excluded from the rehearsal by the approved
// plan -- row-level comparison against the export's row count is not
// meaningful for these (see verify-rehearsal.mjs for their by-design
// state checks instead).
const EXCLUDED_BY_DESIGN = new Set(["production_schema_baseline", "onboarding_preferences", "backup_alert_state", "import_preview_sessions", "import_preview_session_chunks"]);

const report = { tables: [] };
const tableNames = [...parsed.insertsByTable.keys()].filter((t) => !EXCLUDED_BY_DESIGN.has(t)).sort();

for (const table of tableNames) {
  const columns = columnsByTable.get(table);
  if (!columns) throw new Error(`No column list found in schema text for table "${table}" -- refusing to silently skip it.`);
  const sourceStatements = parsed.insertsByTable.get(table);
  const sourceHashes = [];
  for (const stmt of sourceStatements) {
    const parsedRow = parseInsertRow(stmt);
    if (!parsedRow) throw new Error(`Could not parse INSERT for table "${table}"`);
    sourceHashes.push(hashRow(columns, parsedRow.row));
  }
  sourceHashes.sort();

  const colList = columns.map((c) => `"${c}"`).join(",");
  const rows = q(`SELECT ${colList} FROM "${table}" ORDER BY ${columns.includes("id") ? '"id"' : columns[0]};`);
  const rehearsalHashes = rows.map((r) => hashRow(columns, r)).sort();

  const sourceCount = sourceHashes.length;
  const rehearsalCount = rehearsalHashes.length;
  let hashesMatch = sourceCount === rehearsalCount;
  if (hashesMatch) {
    for (let i = 0; i < sourceCount; i++) if (sourceHashes[i] !== rehearsalHashes[i]) { hashesMatch = false; break; }
  }
  const status = hashesMatch ? "MATCH" : "MISMATCH";
  console.log(`${table}: source=${sourceCount} rehearsal=${rehearsalCount} rowHashesMatch=${hashesMatch} -> ${status}`);
  report.tables.push({ table, sourceCount, rehearsalCount, hashesMatch, columns: columns.length });
}

fs.writeFileSync(`${restoreDir}/row-level-hash-report.json`, JSON.stringify(report, null, 2), "utf8");
const mismatches = report.tables.filter((t) => !t.hashesMatch);
console.log(`\n${report.tables.length} tables checked. Mismatches: ${mismatches.length}`);
if (mismatches.length > 0) console.log(JSON.stringify(mismatches, null, 2));
