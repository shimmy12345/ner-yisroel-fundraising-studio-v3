import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Relationship Intelligence Phase 1 -- migration 0034 rehearsal, run
// against a real SQLite engine, matching the established convention in
// tests/text-message-type.test.mjs (Migration 0031 rehearsal) and
// tests/production-baseline.test.mjs. This is schema-constraint testing
// for the actual, real migration file, not a reimplementation of it.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const allMigrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
const migration0034 = "0034_donor_relationship_facts.sql";
assert.ok(allMigrations.includes(migration0034), "migration 0034 must exist on disk");
const preMigrations = allMigrations.filter((name) => name !== migration0034 && name < migration0034);

function freshDatabase({ apply0034 } = { apply0034: true }) {
  const database = new DatabaseSync(":memory:");
  for (const migration of preMigrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  if (apply0034) database.exec(fs.readFileSync(path.join(migrationDirectory, migration0034), "utf8"));
  return database;
}

function schemaObjects(database, tblName) {
  return database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = ? ORDER BY type, name").all(tblName);
}

async function run() {
  // --- 1: purely additive -- every pre-existing table's own schema
  // objects are byte-for-byte unchanged by 0034 (this migration only ever
  // CREATEs two brand-new tables, never rebuilds an existing one -- unlike
  // 0031, which had to rebuild shared_activities for its CHECK widening). ---
  const before = freshDatabase({ apply0034: false });
  const preDonorsSchema = schemaObjects(before, "donors");
  const preInteractionsSchema = schemaObjects(before, "interactions");
  const preAsksSchema = schemaObjects(before, "asks");
  before.close();

  const database = freshDatabase();
  assert.deepEqual(schemaObjects(database, "donors"), preDonorsSchema, "0034 must never touch donors' own schema objects -- it only reads/references donors.id via FK");
  assert.deepEqual(schemaObjects(database, "interactions"), preInteractionsSchema, "0034 must never touch interactions' own schema objects");
  assert.deepEqual(schemaObjects(database, "asks"), preAsksSchema, "0034 must never touch any other pre-existing table");

  const now = Math.floor(Date.now() / 1000);
  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'owner@example.com', ${now}, ${now})`);
  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('d1', 'Donor One', ${now}, ${now})`);
  database.exec(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
    VALUES ('i1', 'd1', 'u1', 'call', ${now}, 'Subject\nNote', 'capture:call', ${now}, ${now})`);

  // --- 2: both new tables exist with every column this design requires. ---
  const factColumns = database.prepare("PRAGMA table_info(donor_relationship_facts)").all().map((c) => c.name);
  for (const column of ["id", "donor_id", "user_id", "category", "lifecycle", "fact_text", "source_interaction_id", "source_interaction_occurred_at", "status", "supersedes_fact_id", "fingerprint", "created_at", "updated_at"]) {
    assert.ok(factColumns.includes(column), `donor_relationship_facts must have column ${column}`);
  }
  const changeColumns = database.prepare("PRAGMA table_info(donor_relationship_fact_changes)").all().map((c) => c.name);
  for (const column of ["id", "fact_id", "user_id", "donor_id", "action", "changed_fields", "before_json", "after_json", "created_at"]) {
    assert.ok(changeColumns.includes(column), `donor_relationship_fact_changes must have column ${column}`);
  }

  // --- 3: a real, well-formed fact row can be inserted (source_interaction_id
  // set, the normal Phase 2+ shape) -- and status/updated_at default correctly. ---
  database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, fingerprint, created_at, updated_at)
    VALUES ('f1', 'd1', 'u1', 'family_milestone', 'durable', 'His daughter is Danielle.', 'i1', ${now}, 'fp-f1', ${now}, ${now})`);
  const f1 = database.prepare("SELECT * FROM donor_relationship_facts WHERE id = 'f1'").get();
  assert.equal(f1.status, "current", "status must default to 'current'");
  assert.equal(f1.supersedes_fact_id, null);

  // --- 4: a backfilled fact (source_interaction_id NULL) is structurally
  // valid -- the whole point of Phase 1's backfill; must never require a
  // source interaction. ---
  assert.doesNotThrow(() => database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_id, source_interaction_occurred_at, fingerprint, created_at, updated_at)
    VALUES ('f2', 'd1', 'u1', 'general', 'durable', 'Backfilled text.', NULL, ${now}, 'fp-f2', ${now}, ${now})`), "source_interaction_id must be nullable for backfilled facts");

  // --- 5: category CHECK constraint rejects an invalid value. ---
  assert.throws(() => database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, fingerprint, created_at, updated_at)
    VALUES ('bad-cat', 'd1', 'u1', 'not_a_real_category', 'durable', 'x', ${now}, 'fp-bad-cat', ${now}, ${now})`), /CHECK constraint failed/, "an invalid category must be rejected at the database level, not just by application code");

  // --- 6: lifecycle CHECK constraint rejects an invalid value -- this is
  // the actual regression test for the Lifecycle Correction: lifecycle
  // must be its OWN enforced column, not folded into category. ---
  assert.throws(() => database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, fingerprint, created_at, updated_at)
    VALUES ('bad-life', 'd1', 'u1', 'family_milestone', 'permanent', 'x', ${now}, 'fp-bad-life', ${now}, ${now})`), /CHECK constraint failed/, "an invalid lifecycle value must be rejected at the database level");

  // --- 7: status CHECK constraint rejects an invalid value. ---
  assert.throws(() => database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, status, fingerprint, created_at, updated_at)
    VALUES ('bad-status', 'd1', 'u1', 'general', 'durable', 'x', ${now}, 'deleted', 'fp-bad-status', ${now}, ${now})`), /CHECK constraint failed/, "an invalid status value must be rejected at the database level");

  // --- 8: the (user_id, fingerprint) unique index actually enforces
  // idempotency at the database level -- a second insert with the same
  // fingerprint for the same user must fail, not silently duplicate. This
  // is the real database-level backstop behind the backfill script's own
  // idempotency logic. ---
  assert.throws(() => database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, fingerprint, created_at, updated_at)
    VALUES ('f1-dupe', 'd1', 'u1', 'family_milestone', 'durable', 'His daughter is Danielle.', ${now}, 'fp-f1', ${now}, ${now})`), /UNIQUE constraint failed/, "a duplicate (user_id, fingerprint) pair must be rejected at the database level -- the real idempotency backstop");

  // --- 9: the SAME fingerprint string IS allowed for a different user
  // (fingerprint uniqueness is scoped per-user, matching donor_historical_
  // context's own established convention, not global). ---
  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'owner2@example.com', ${now}, ${now})`);
  database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('d2', 'Donor Two', ${now}, ${now})`);
  assert.doesNotThrow(() => database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, fingerprint, created_at, updated_at)
    VALUES ('f3', 'd2', 'u2', 'family_milestone', 'durable', 'His daughter is Danielle.', ${now}, 'fp-f1', ${now}, ${now})`), "fingerprint uniqueness must be scoped per-user, not global");

  // --- 10: donor_relationship_facts_donor_status_idx and _supersedes_idx
  // both exist (used by synthesis's "current facts for this donor" query
  // and by supersession-chain lookups respectively). ---
  const factIndexes = schemaObjects(database, "donor_relationship_facts").filter((o) => o.type === "index").map((o) => o.name);
  assert.ok(factIndexes.includes("donor_relationship_facts_donor_status_idx"));
  assert.ok(factIndexes.includes("donor_relationship_facts_user_fingerprint_uidx"));
  assert.ok(factIndexes.includes("donor_relationship_facts_supersedes_idx"));

  // --- 11: supersession chain -- a fact can reference an earlier fact's id
  // via supersedes_fact_id with no FK friction (deliberately not a real FK,
  // matching donor_research_findings.supersedesFindingId), and multiple
  // hops (a chain) are representable. ---
  database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, status, fingerprint, created_at, updated_at)
    VALUES ('f4', 'd1', 'u1', 'solicitation', 'time_bound', 'Discussed a gift.', ${now}, 'superseded', 'fp-f4', ${now}, ${now})`);
  database.exec(`INSERT INTO donor_relationship_facts
    (id, donor_id, user_id, category, lifecycle, fact_text, source_interaction_occurred_at, supersedes_fact_id, fingerprint, created_at, updated_at)
    VALUES ('f5', 'd1', 'u1', 'solicitation', 'time_bound', 'Confirmed the gift.', ${now}, 'f4', 'fp-f5', ${now}, ${now})`);
  const chain = database.prepare("SELECT id, supersedes_fact_id, status FROM donor_relationship_facts WHERE id IN ('f4','f5') ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(chain, [{ id: "f4", supersedes_fact_id: null, status: "superseded" }, { id: "f5", supersedes_fact_id: "f4", status: "current" }]);

  // --- 12: donor_relationship_fact_changes -- action CHECK, and a valid
  // insert linking back to a real fact. ---
  database.exec(`INSERT INTO donor_relationship_fact_changes
    (id, fact_id, user_id, donor_id, action, changed_fields, after_json, created_at)
    VALUES ('c1', 'f1', 'u1', 'd1', 'created', '[]', '{}', ${now})`);
  assert.throws(() => database.exec(`INSERT INTO donor_relationship_fact_changes
    (id, fact_id, user_id, donor_id, action, changed_fields, after_json, created_at)
    VALUES ('bad-action', 'f1', 'u1', 'd1', 'deleted_forever', '[]', '{}', ${now})`), /CHECK constraint failed/, "an invalid action value must be rejected at the database level");
  const changeIndexes = schemaObjects(database, "donor_relationship_fact_changes").filter((o) => o.type === "index").map((o) => o.name);
  assert.ok(changeIndexes.includes("donor_relationship_fact_changes_fact_idx"));

  console.log("relationship-facts-schema: ok");
}

await run();
