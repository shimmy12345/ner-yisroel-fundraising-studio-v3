import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generateBaseline, schemaTopology } from "./generate-production-baseline.mjs";

const root = path.resolve(import.meta.dirname, "..");
const storedBaseline = fs.readFileSync(path.join(root, "production-baseline", "drizzle", "0000_production_baseline_0019.sql"), "utf8");
const storedManifest = JSON.parse(fs.readFileSync(path.join(root, "production-baseline", "schema-manifest.json"), "utf8"));
const generated = generateBaseline();

assert.equal(storedBaseline, generated.baseline, "the checked-in baseline must be regenerated when legacy migrations change");
assert.deepEqual(storedManifest, generated.manifest, "the schema manifest must match the baseline source");

const fresh = new DatabaseSync(":memory:");
fresh.exec(storedBaseline);
assert.deepEqual(schemaTopology(fresh), generated.manifest.topology, "the baseline must reproduce the canonical 0019 topology");
assert.equal(fresh.prepare("SELECT schema_hash FROM production_schema_baseline WHERE id='0019'").get().schema_hash, generated.manifest.schemaHash);
assert.equal(fresh.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
assert.deepEqual(fresh.prepare("PRAGMA foreign_key_check").all(), []);
for (const table of storedManifest.topology.tables) assert.equal(fresh.prepare(`SELECT COUNT(*) AS count FROM "${table.name.replaceAll('"', '""')}"`).get().count, 0, `${table.name} must start empty`);
assert.throws(() => fresh.exec(storedBaseline), /already exists/, "the baseline must fail closed instead of replaying");

console.log(`Production baseline 0019 verified: ${storedManifest.topology.tables.length} tables, integrity ok, no business rows, replay blocked.`);
