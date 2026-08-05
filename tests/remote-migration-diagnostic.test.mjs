import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { normalizeMigrationTag } from "../lib/data-health/remote-migrations.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("migration diagnostic normalizes packaged SQL names without changing order", () => {
  assert.equal(normalizeMigrationTag("0018_data_health_repairs.sql"), "0018_data_health_repairs");
  assert.equal(normalizeMigrationTag("0019_legacy_test_orphan_cleanup"), "0019_legacy_test_orphan_cleanup");
});

test("diagnostic route is authenticated and read-only", () => {
  const route = read("app/api/health/migrations/route.ts");
  const reader = read("lib/data-health/remote-migrations.ts");
  assert.match(route, /getChatGPTUser/);
  assert.match(route, /Authentication required/);
  assert.match(reader, /sqlite_schema/);
  assert.match(reader, /d1_migrations/);
  assert.doesNotMatch(route + reader, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
});

test("fictional remote history patterns remain distinguishable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)");
  db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES (?,?)").run("0017_today_relationship_queue.sql", "fictional-time");
  db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES (?,?)").run("0018_data_health_repairs.sql", "fictional-time");
  const names = db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => normalizeMigrationTag(row.name));
  assert.deepEqual(names, ["0017_today_relationship_queue", "0018_data_health_repairs"]);
});
