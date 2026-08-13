import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Same convention as tests/monday-import-safety.test.mjs and
// tests/gift-acknowledgment-safety.test.mjs: the D1-dependent routes touch
// cloudflare:workers' env.DB, which only exists inside a Workers runtime,
// so their safety properties are verified against the route/schema source
// text rather than executed against a live D1 instance.

async function run() {
  const createRoute = await readFile(new URL("../app/api/donors/[id]/yahrtzeits/route.ts", import.meta.url), "utf8");
  const editRoute = await readFile(new URL("../app/api/yahrtzeits/[id]/route.ts", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/yahrtzeit/preview/route.ts", import.meta.url), "utf8");
  const commitRoute = await readFile(new URL("../app/api/import/yahrtzeit/commit/route.ts", import.meta.url), "utf8");
  const pipeline = await readFile(new URL("../lib/import/yahrtzeit-pipeline.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0027_yahrtzeits.sql", import.meta.url), "utf8");
  const jlImportRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const captureRoute = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
  const stagingReset = await readFile(new URL("../lib/operations/staging-reset.ts", import.meta.url), "utf8");
  const stripComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");

  // --- 3 & 9: a yahrtzeit is background context, never a logged
  // interaction, never a financial record, and never touches donor
  // narrative fields. None of the four write-capable routes may reference
  // interactions, giving_activities, gifts, recommendations, or the
  // donors.relationship_summary/institutional_memory columns. ---
  for (const [name, source] of [["create", createRoute], ["edit/delete", editRoute], ["import commit", commitRoute]]) {
    const code = stripComments(source);
    assert.doesNotMatch(code, /\binteractions\b/i, `${name} route must never touch the interactions table`);
    assert.doesNotMatch(code, /\bgiving_activities\b|\bgifts\b/i, `${name} route must never touch financial records`);
    assert.doesNotMatch(code, /\brecommendations\b/i, `${name} route must never touch the recommendations table`);
    assert.doesNotMatch(code, /relationship_summary|institutional_memory/i, `${name} route must never write donor narrative fields`);
  }

  // --- exact donor-code matching only -- never fuzzy name matching. The
  // pipeline's only donor-resolution step is a Map.get() keyed on the
  // workbook's own Code column; there is no string-similarity, Levenshtein,
  // or name-comparison logic anywhere in it. ---
  assert.match(pipeline, /donorLookup\.get\(row\.donorCode\)/, "donor matching must be an exact-key lookup on Code");
  assert.doesNotMatch(stripComments(pipeline), /similarity|levenshtein|includes\(.*[Nn]ame/i, "the pipeline's actual code (not comments describing what it avoids) must never fuzzy-match by name");

  // --- ownership checks present on every write path. ---
  assert.match(createRoute, /owner_user_id=\? AND data_source='live'/, "manual create must scope to this owner's live donor");
  assert.match(editRoute, /d\.owner_user_id=\? AND d\.data_source='live'/, "edit/delete must scope through an owner-checked donor join");
  assert.match(commitRoute, /owner_user_id=\? AND data_source='live'/, "import commit must scope donor matching to this owner's live donors");

  // --- yahrtzeits itself is mutable (the record IS the maintained fact),
  // but its audit trail must be append-only -- a status/field change is a
  // new yahrtzeit_changes row, never an UPDATE that would erase the
  // record of what it looked like before. ---
  for (const [name, source] of [["create", createRoute], ["edit/delete", editRoute], ["import commit", commitRoute]]) {
    assert.doesNotMatch(stripComments(source), /UPDATE yahrtzeit_changes/, `${name} route must never UPDATE yahrtzeit_changes -- append-only`);
  }
  assert.match(editRoute, /UPDATE yahrtzeits SET/, "editing a yahrtzeit updates the live record in place");
  assert.match(editRoute, /DELETE FROM yahrtzeits/, "deleting removes the live record");
  assert.match(createRoute, /INSERT INTO yahrtzeit_changes/);
  assert.match(editRoute, /INSERT INTO yahrtzeit_changes/);
  assert.match(commitRoute, /INSERT INTO yahrtzeit_changes/);

  // --- schema: CHECK constraints match the documented enums. ---
  assert.match(migration, /CHECK \(`source` IN \('manual','import-yahrtzeit-workbook'\)\)/);
  assert.match(migration, /CHECK \(`action` IN \('created','updated','deleted'\)\)/);
  assert.match(schema, /source: text\("source", \{ enum: \["manual", "import-yahrtzeit-workbook"\] \}\)/);

  // --- 9: JL re-import idempotency, proven by construction -- the JL
  // import route's own donor-refresh UPDATE never references yahrtzeits at
  // all, so a yahrtzeit record can never be touched, reset, or duplicated
  // by re-importing a household/donation export. ---
  assert.doesNotMatch(jlImportRoute, /yahrtzeits/, "the JL import route must never reference yahrtzeits -- that's what makes yahrtzeit state re-import-safe by construction");

  // --- the normal interaction-capture flow is untouched by this feature. ---
  assert.match(captureRoute, /INSERT INTO interactions/);
  assert.doesNotMatch(captureRoute, /\byahrtzeits\b/i, "the normal capture flow must never reference yahrtzeit state");

  // --- staging reset covers both new tables. ---
  assert.match(stagingReset, /"yahrtzeit_changes"/);
  assert.match(stagingReset, /"yahrtzeits"/);

  console.log("Yahrtzeit import/manual-entry safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
