// Builds the ordered, FK-safe, per-table restore SQL files for a
// migration rehearsal from a frozen D1 export (see
// docs/PRODUCTION-DONOR-DATA-MIGRATION-REHEARSAL.md). READ-ONLY
// against the export file; writes only to the given output directory,
// which MUST be a local scratch location outside the repo (it will
// contain real donor data) -- never point it inside the working tree.
// Prints only table names, row/byte counts, and chunk counts -- never
// row content, so no donor PII reaches stdout from this script.
//
// Usage: node scripts/migration-audit/build-rehearsal-restore-files.mjs <export.sql> <outDir>
import fs from "node:fs";
import path from "node:path";
import {
  D1_RESTORE_DATA_ORDER,
  D1_RESTORE_SKIP_DATA_TABLES,
  D1_SAFE_STATEMENT_BYTES,
  parseRestoreStatements,
  parameterizeInsertStatement,
} from "../../lib/operations/d1-restore-order.ts";

const [exportPath, outDir] = process.argv.slice(2);
if (!exportPath || !outDir) throw new Error("Usage: node build-rehearsal-restore-files.mjs <export.sql> <outDir>");
const resolvedOutDir = path.resolve(outDir);
const repoRoot = path.resolve(import.meta.dirname, "../..");
if (resolvedOutDir === repoRoot || resolvedOutDir.startsWith(repoRoot + path.sep)) {
  throw new Error(`Refusing to write rehearsal restore files (will contain real donor data) inside the repository: ${resolvedOutDir}. Pass a local scratch directory outside the working tree instead.`);
}
fs.mkdirSync(resolvedOutDir, { recursive: true });

const sqlText = fs.readFileSync(path.resolve(exportPath), "utf8");
const parsed = parseRestoreStatements(sqlText);
if (parsed.unrecognized.length > 0) throw new Error(`${parsed.unrecognized.length} unrecognized statements -- refusing to guess.`);

// Rehearsal-specific restore order (docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md
// Section 8.4/8.6/15.4): drop production_schema_baseline (the rehearsal
// DB gets its own fresh marker from the baseline schema file),
// onboarding_preferences and backup_alert_state (account-config,
// nothing references either by FK). KEEP "users" -- every
// ownerUserId/userId FK in the 48 MIGRATE tables points at the one
// real deterministic id, and the users table carries no
// credential-shaped column (db/schema.ts), so restoring its one real
// row is safe and required for PRAGMA foreign_key_check to pass.
const DROP_FROM_REHEARSAL = new Set(["production_schema_baseline", "onboarding_preferences", "backup_alert_state"]);
const REHEARSAL_ORDER = D1_RESTORE_DATA_ORDER.filter((t) => !DROP_FROM_REHEARSAL.has(t));

const skip = new Set(D1_RESTORE_SKIP_DATA_TABLES);
const known = new Set([...REHEARSAL_ORDER, ...DROP_FROM_REHEARSAL]);
const unknown = [...parsed.insertsByTable.keys()].filter((t) => !known.has(t) && !skip.has(t));
if (unknown.length > 0) throw new Error(`Tables not in REHEARSAL_ORDER: ${unknown.join(", ")}. Add them with the correct dependency position before restoring.`);

// A real export can contain a single-row INSERT whose inline SQL text
// exceeds D1's bulk-import statement-length ceiling (D1_SAFE_STATEMENT_BYTES,
// see lib/operations/d1-restore-order.ts's own header comment). The
// documented fix is the D1 HTTP query API's parameterized {sql,params}
// path, which requires a bare Cloudflare API token/account id -- not
// always available in every environment this rehearsal runs in (it
// was not in the sandbox this was first exercised in, 2026-10-11).
// This chunking technique achieves the same result using ONLY
// `wrangler d1 execute`, which this script already depends on: insert
// the row with its one oversized column empty, then append the value
// in safe-sized pieces via repeated `col = col || '<chunk>'` UPDATEs.
// Row-level hash comparison (row-level-hash-compare.mjs) proves this
// produces a byte-identical final value.
const CHUNK_BYTES = 40000; // comfortably under the ~100-102KB inline-literal ceiling

function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}

function buildChunkedInsertAndUpdates(statementSql, table) {
  const parameterized = parameterizeInsertStatement(statementSql);
  if (!parameterized) throw new Error(`Oversized statement for "${table}" could not be parsed as a single-row INSERT -- cannot chunk it safely.`);
  const { columns, params } = parameterized;
  let bigIndex = -1;
  let bigLen = -1;
  params.forEach((value, index) => {
    if (typeof value === "string" && value.length > bigLen) { bigLen = value.length; bigIndex = index; }
  });
  if (bigIndex === -1) throw new Error(`Oversized statement for "${table}" has no string column large enough to chunk.`);
  const bigValue = params[bigIndex];
  const idColumnIndex = columns.indexOf("id");
  if (idColumnIndex === -1) throw new Error(`Oversized statement for "${table}" has no "id" column to key the follow-up UPDATEs on.`);
  const idValue = params[idColumnIndex];
  if (typeof idValue !== "string") throw new Error(`Oversized statement for "${table}" has a non-string id -- cannot safely quote it.`);

  const literalFor = (value) => {
    if (value === null) return "NULL";
    if (typeof value === "number") return String(value);
    return `'${escapeSqlString(String(value))}'`;
  };
  const insertColumns = columns.map((c) => `"${c}"`).join(",");
  const insertValues = columns.map((c, i) => (i === bigIndex ? "''" : literalFor(params[i]))).join(",");
  const statements = [`INSERT INTO "${table}" (${insertColumns}) VALUES(${insertValues});`];
  for (let offset = 0; offset < bigValue.length; offset += CHUNK_BYTES) {
    const chunk = bigValue.slice(offset, offset + CHUNK_BYTES);
    statements.push(`UPDATE "${table}" SET "${columns[bigIndex]}" = "${columns[bigIndex]}" || '${escapeSqlString(chunk)}' WHERE "${columns[idColumnIndex]}" = '${escapeSqlString(idValue)}';`);
  }
  return { statements, chunkedColumn: columns[bigIndex], totalBytes: bigValue.length, chunkCount: statements.length - 1 };
}

const manifest = { tables: [], chunkedRows: [] };
for (const table of REHEARSAL_ORDER) {
  if (skip.has(table)) continue;
  const statements = parsed.insertsByTable.get(table) ?? [];
  if (statements.length === 0) continue;
  const normal = [];
  const chunkedBlocks = [];
  for (const statement of statements) {
    if (statement.length < D1_SAFE_STATEMENT_BYTES) { normal.push(statement); continue; }
    const result = buildChunkedInsertAndUpdates(statement, table);
    chunkedBlocks.push(result.statements.join("\n"));
    manifest.chunkedRows.push({ table, chunkedColumn: result.chunkedColumn, totalBytes: result.totalBytes, chunkCount: result.chunkCount });
  }
  const fileLines = [...normal, ...chunkedBlocks];
  const outFile = path.join(resolvedOutDir, `data-${table}.sql`);
  fs.writeFileSync(outFile, fileLines.join("\n") + "\n", "utf8");
  manifest.tables.push({ table, rows: statements.length, file: path.basename(outFile), bytes: fs.statSync(outFile).size });
}

for (const table of D1_RESTORE_SKIP_DATA_TABLES) {
  const n = (parsed.insertsByTable.get(table) ?? []).length;
  if (n > 0) manifest.tables.push({ table, rows: n, file: null, bytes: 0, skipped: "ephemeral review-session cache, D1_RESTORE_SKIP_DATA_TABLES" });
}
for (const table of DROP_FROM_REHEARSAL) {
  const n = (parsed.insertsByTable.get(table) ?? []).length;
  manifest.tables.push({ table, rows: n, file: null, bytes: 0, skipped: table === "production_schema_baseline" ? "rehearsal gets its own fresh marker from the baseline schema file" : "account-config table excluded by migration plan (nothing references it by FK)" });
}

fs.writeFileSync(path.join(resolvedOutDir, "schema.sql"), [...parsed.preamble, ...parsed.schema].join("\n") + "\n", "utf8");
fs.writeFileSync(path.join(resolvedOutDir, "trailing-stats.sql"), parsed.trailingStats.length > 0 ? parsed.trailingStats.join("\n") + "\n" : "-- no trailing stats\n", "utf8");
fs.writeFileSync(path.join(resolvedOutDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

console.log(`Wrote ${manifest.tables.length} table entries + schema.sql + trailing-stats.sql to ${resolvedOutDir}`);
console.log(`Chunked (oversized) rows: ${manifest.chunkedRows.length}`);
for (const row of manifest.chunkedRows) console.log(`  ${row.table}.${row.chunkedColumn}: ${row.totalBytes} bytes -> ${row.chunkCount} UPDATE chunks`);
console.log(`Restore order (${manifest.tables.filter((t) => t.file).length} tables with data to insert):`);
for (const t of manifest.tables) console.log(`  ${t.table}: ${t.rows} rows${t.skipped ? ` (SKIPPED: ${t.skipped})` : ""}`);
