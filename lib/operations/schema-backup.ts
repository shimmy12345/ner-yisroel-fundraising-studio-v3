import { PRODUCTION_BASELINE_HASH, compareSchemaObjects, stagingSchemaObjects } from "../data-health/production-baseline.ts";

type SchemaRow = Record<string, unknown>;
type BaselineMarker = { schema_hash?: string; created_at?: number } | null;

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function buildSchemaOnlyBackup(rows: SchemaRow[], marker: BaselineMarker) {
  if (marker?.schema_hash !== PRODUCTION_BASELINE_HASH || !Number.isInteger(Number(marker.created_at))) {
    throw new Error("The verified production baseline marker is missing or invalid.");
  }
  const applicationObjects = stagingSchemaObjects(rows);
  const comparison = compareSchemaObjects(applicationObjects);
  if (!comparison.matches) throw new Error(`The live application schema differs from baseline: ${comparison.differences.join(" ")}`);
  const markerTable = applicationObjects.find((object) => object.type === "table" && object.name === "production_schema_baseline");
  if (!markerTable) throw new Error("The production baseline table is missing.");

  const ddl = applicationObjects
    .filter((object) => object.type === "table")
    .concat(applicationObjects.filter((object) => object.type === "index"))
    .map((object) => `${object.sql.replace(/;\s*$/, "")};`)
    .join("\n");
  return [
    "-- Fundraising OS production D1 schema-only backup",
    "-- Contains no donor or workspace business data.",
    "PRAGMA foreign_keys=OFF;",
    "BEGIN TRANSACTION;",
    ddl,
    `INSERT INTO production_schema_baseline (id,schema_hash,created_at) VALUES ('0019',${sqlLiteral(marker.schema_hash)},${Number(marker.created_at)});`,
    "COMMIT;",
    "PRAGMA foreign_keys=ON;",
    "PRAGMA optimize;",
    "",
  ].join("\n");
}
