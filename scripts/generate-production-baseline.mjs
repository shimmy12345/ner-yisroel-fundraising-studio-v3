import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const outputDirectory = path.join(root, "production-baseline", "drizzle");
const baselinePath = path.join(outputDirectory, "0000_production_baseline_0019.sql");
const journalPath = path.join(outputDirectory, "meta", "_journal.json");
const manifestPath = path.join(root, "production-baseline", "schema-manifest.json");

const normalized = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function checks(sql) {
  const result = [];
  const upper = sql.toUpperCase();
  let cursor = 0;
  while ((cursor = upper.indexOf("CHECK", cursor)) >= 0) {
    const start = upper.indexOf("(", cursor + 5);
    if (start < 0) break;
    let depth = 0;
    let quoteCharacter = null;
    for (let index = start; index < sql.length; index += 1) {
      const character = sql[index];
      if (quoteCharacter) {
        if (character === quoteCharacter && sql[index - 1] !== "\\") quoteCharacter = null;
      } else if (character === "'" || character === '"' || character === "`") quoteCharacter = character;
      else if (character === "(") depth += 1;
      else if (character === ")" && --depth === 0) {
        result.push(normalized(sql.slice(cursor, index + 1)));
        cursor = index + 1;
        break;
      }
    }
  }
  return result.sort();
}

export function schemaTopology(database, excludedTables = ["production_schema_baseline"]) {
  const excluded = new Set(excludedTables);
  const schemaRows = database.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name").all();
  const tableRows = schemaRows.filter((row) => row.type === "table" && !excluded.has(row.name));
  const indexSql = new Map(schemaRows.filter((row) => row.type === "index").map((row) => [row.name, normalized(row.sql)]));
  const tables = tableRows.map((row) => {
    const columns = database.prepare(`PRAGMA table_info(${quote(row.name)})`).all().map((column) => ({ name: column.name, type: normalized(column.type).toUpperCase(), notNull: Boolean(column.notnull), defaultValue: column.dflt_value === null ? null : normalized(column.dflt_value), primaryKeyOrder: Number(column.pk) }));
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quote(row.name)})`).all().map((foreignKey) => ({ from: foreignKey.from, toTable: foreignKey.table, to: foreignKey.to, onUpdate: foreignKey.on_update, onDelete: foreignKey.on_delete })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const indexes = database.prepare(`PRAGMA index_list(${quote(row.name)})`).all().map((index) => {
      const indexColumns = database.prepare(`PRAGMA index_info(${quote(index.name)})`).all().sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((column) => column.name);
      return { name: index.origin === "c" ? index.name : null, columns: indexColumns, unique: Boolean(index.unique), partial: Boolean(index.partial), origin: index.origin, sql: index.origin === "c" ? indexSql.get(index.name) ?? null : null };
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { name: row.name, columns, foreignKeys, indexes, checks: checks(row.sql) };
  });
  return { tables };
}

export function applyLegacyMigrations(database) {
  database.exec("PRAGMA foreign_keys=ON");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
}

export function generateBaseline() {
  const canonical = new DatabaseSync(":memory:");
  applyLegacyMigrations(canonical);
  const topology = schemaTopology(canonical);
  const schemaHash = createHash("sha256").update(JSON.stringify(topology)).digest("hex");
  const schemaRows = canonical.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name").all();
  const ddlTopology = schemaRows.filter((row) => row.type === "table" || row.type === "index").map((row) => ({ type: row.type, name: row.name, sql: normalized(row.sql) }));
  const ddl = schemaRows.filter((row) => row.type === "table" || row.type === "index").map((row) => `${row.sql};`).join("\n\n");
  const baseline = `-- Fundraising OS production schema baseline through 0019.\n-- Apply only to a brand-new empty D1 database. Never apply to staging.\nPRAGMA foreign_keys=ON;\n\n${ddl}\n\nCREATE TABLE \`production_schema_baseline\` (\n  \`id\` text PRIMARY KEY NOT NULL CHECK (\`id\` = '0019'),\n  \`schema_hash\` text NOT NULL,\n  \`created_at\` integer NOT NULL\n);\nINSERT INTO \`production_schema_baseline\` (\`id\`,\`schema_hash\`,\`created_at\`) VALUES ('0019','${schemaHash}',1785944072);\nPRAGMA optimize;\n`;
  const journal = { version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "7", when: 1785944072000, tag: "0000_production_baseline_0019", breakpoints: true }] };
  const manifest = { baselineLevel: "0019", schemaHash, sourceMigrations: migrations, generatedFrom: "legacy migrations 0000-0019 applied once to an empty SQLite database", topology, ddlTopology };
  return { baseline, journal, manifest, canonical };
}

if (process.argv.includes("--write")) {
  const generated = generateBaseline();
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.writeFileSync(baselinePath, generated.baseline);
  fs.writeFileSync(journalPath, `${JSON.stringify(generated.journal, null, 2)}\n`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(generated.manifest, null, 2)}\n`);
  console.log(`Generated production baseline ${generated.manifest.schemaHash}.`);
}
