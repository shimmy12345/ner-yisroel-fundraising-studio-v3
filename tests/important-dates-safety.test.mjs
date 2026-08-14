import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Same convention as tests/gift-acknowledgment-safety.test.mjs and
// tests/monday-import-safety.test.mjs: the important-dates routes touch
// cloudflare:workers' env.DB, which only exists inside a Workers runtime,
// so their D1-dependent safety properties are verified against the route/
// schema source text rather than by executing them against a live D1
// instance.

async function run() {
  const createRoute = await readFile(new URL("../app/api/donors/[id]/important-dates/route.ts", import.meta.url), "utf8");
  const itemRoute = await readFile(new URL("../app/api/important-dates/[id]/route.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0028_important_dates.sql", import.meta.url), "utf8");
  const stagingReset = await readFile(new URL("../lib/operations/staging-reset.ts", import.meta.url), "utf8");

  // --- Birthday/anniversary CRUD must never touch interactions, giving,
  // pledges, or the recommendations table -- background family context,
  // never a logged contact, never an automatically-created reminder. ---
  for (const [name, source] of [["create route", createRoute], ["item route", itemRoute]]) {
    const code = source.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /\binteractions\b/i, `${name} must never touch the interactions table`);
    assert.doesNotMatch(code, /\brecommendations\b/i, `${name} must never touch the recommendations table -- no automatic reminder is ever created`);
    assert.doesNotMatch(code, /\bgiving_activities\b|\bgifts\b/i, `${name} must never touch giving/pledge data`);
    assert.doesNotMatch(code, /UPDATE donors|relationship_summary|institutional_memory/i, `${name} must never write donor narrative fields`);
    // Structurally separate from yahrtzeits -- adding/editing/deleting a
    // birthday or anniversary must never read or write the yahrtzeits table.
    assert.doesNotMatch(code, /\byahrtzeits\b/i, `${name} must never touch the yahrtzeits table -- yahrtzeit data is untouched by this feature`);
  }

  // --- Every write is owner-scoped: the donor (create) or the important
  // date's own donor join (edit/delete) must belong to the authenticated
  // owner's live records before anything is written. ---
  assert.match(createRoute, /donors WHERE id=\? AND owner_user_id=\? AND data_source='live' AND archived_at IS NULL/, "create must verify the donor belongs to the authenticated owner before inserting");
  assert.match(itemRoute, /JOIN donors d ON d\.id = i\.donor_id/, "edit/delete must join through donors for ownership");
  assert.match(itemRoute, /d\.owner_user_id=\? AND d\.data_source='live'/, "edit/delete must verify owner_user_id and data_source scoping");
  assert.match(itemRoute, /i\.user_id=\?/, "edit/delete must also verify the important_dates row's own user_id");

  // --- Every create/update/delete writes an audit row in the same D1
  // batch as the mutation itself (matching yahrtzeit_changes' pattern),
  // so an audit entry can never be silently skipped by a partial failure. ---
  assert.match(createRoute, /INSERT INTO important_dates/);
  assert.match(createRoute, /INSERT INTO important_date_changes/);
  assert.match(createRoute, /env\.DB\.batch\(/, "create must write the row and its audit entry atomically");
  assert.match(itemRoute, /UPDATE important_dates SET/);
  assert.match(itemRoute, /INSERT INTO important_date_changes/);
  assert.match(itemRoute, /DELETE FROM important_dates WHERE id=\? AND user_id=\?/);
  const batchCount = (itemRoute.match(/env\.DB\.batch\(/g) ?? []).length;
  assert.equal(batchCount, 2, "both PATCH and DELETE must write their row change and audit entry atomically");

  // --- Schema: append-only audit action is constrained to the three
  // documented values, and important_date_id is deliberately not a foreign
  // key, so a deletion's audit row survives after the row it describes is
  // gone (same reasoning as yahrtzeit_changes). ---
  assert.match(schema, /action: text\("action", \{ enum: \["created", "updated", "deleted"\] \}\)/);
  assert.match(migration, /CHECK \(`action` IN \('created','updated','deleted'\)\)/);
  assert.match(migration, /CHECK \(`type` IN \('birthday','anniversary'\)\)/);
  assert.doesNotMatch(migration, /`important_date_id` text NOT NULL,\s*\n\s*FOREIGN KEY \(`important_date_id`\)/, "important_date_id must not be a foreign key");

  // --- new tables are included in the independent-staging reset, so a
  // reset genuinely clears all fundraising data, not just some of it. ---
  assert.match(stagingReset, /"important_dates"/);
  assert.match(stagingReset, /"important_date_changes"/);

  // --- Anniversary never stores a person name, even if one is sent --
  // the route/validation layer forces it to null, not just the UI. ---
  const validation = await readFile(new URL("../lib/important-dates/validation.ts", import.meta.url), "utf8");
  assert.match(validation, /type === "birthday" \? \(personNameRaw \|\| null\) : null/, "personName must be forced to null for anniversary at the validation layer, not merely omitted by the UI");

  console.log("Important-date safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
