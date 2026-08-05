export type RemoteMigrationEntry = {
  sequence: number;
  tag: string;
  hash: string | null;
  appliedAt: string | null;
};

export type RemoteMigrationHistory = {
  tableName: string | null;
  entries: RemoteMigrationEntry[];
  diagnostic: string | null;
};

type D1Result<T> = { results: T[] };
type D1DatabaseLike = {
  prepare(sql: string): {
    all<T>(): Promise<D1Result<T>>;
  };
};

type TableRow = { name: string };
type ColumnRow = { name: string };

const supportedTables = ["d1_migrations", "__drizzle_migrations", "drizzle_migrations"];
const tagColumns = ["name", "tag", "migration_name"];
const hashColumns = ["hash", "sha256", "checksum"];
const appliedColumns = ["applied_at", "created_at", "when"];

const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function normalizeMigrationTag(value: unknown) {
  return String(value ?? "").trim().replace(/\.sql$/i, "");
}

export async function readRemoteMigrationHistory(db: D1DatabaseLike): Promise<RemoteMigrationHistory> {
  const tableResult = await db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND lower(name) LIKE '%migration%' ORDER BY name").all<TableRow>();
  const tableName = supportedTables.find((candidate) => tableResult.results.some((row) => row.name === candidate)) ?? null;
  if (!tableName) return { tableName: null, entries: [], diagnostic: "No supported D1 migration table was found." };

  const columns = await db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all<ColumnRow>();
  const names = new Set(columns.results.map((column) => column.name));
  const tagColumn = tagColumns.find((column) => names.has(column));
  if (!tagColumn) return { tableName, entries: [], diagnostic: `Migration table ${tableName} has no supported migration-name column.` };
  const hashColumn = hashColumns.find((column) => names.has(column)) ?? null;
  const appliedColumn = appliedColumns.find((column) => names.has(column)) ?? null;
  const rows = await db.prepare(`SELECT rowid AS sequence,${quoteIdentifier(tagColumn)} AS tag,${hashColumn ? quoteIdentifier(hashColumn) : "NULL"} AS hash,${appliedColumn ? quoteIdentifier(appliedColumn) : "NULL"} AS applied_at FROM ${quoteIdentifier(tableName)} ORDER BY rowid`).all<{ sequence: number; tag: unknown; hash: unknown; applied_at: unknown }>();
  return {
    tableName,
    entries: rows.results.map((row) => ({ sequence: Number(row.sequence), tag: normalizeMigrationTag(row.tag), hash: row.hash === null ? null : String(row.hash), appliedAt: row.applied_at === null ? null : String(row.applied_at) })),
    diagnostic: null,
  };
}
