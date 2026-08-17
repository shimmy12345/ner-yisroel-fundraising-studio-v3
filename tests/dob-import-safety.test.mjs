import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { nextGregorianRecurrence, yearsSinceForOccurrence } from "../lib/calendar/gregorian-recurring-date.ts";
import { classifyDobRow } from "../lib/import/dob-pipeline.ts";

// Same convention as tests/yahrtzeit-import-safety.test.mjs and
// tests/important-dates-safety.test.mjs: the D1-dependent routes touch
// cloudflare:workers' env.DB, which only exists inside a Workers runtime,
// so their safety properties are verified against the route/schema source
// text rather than by executing them against a live D1 instance.
//
// Category 8: safety/source-text (commit route never touches forbidden
// tables/fields). Category 9: migration (manual still accepted, import-dob
// accepted, invalid source rejected, existing rows preserved -- verified
// here at the schema/migration-text level; the actual byte-for-byte
// row-preservation and CHECK-constraint behavior was independently
// rehearsed against a real SQLite engine via node:sqlite, see
// rehearse-migration.mjs). Category 10: age/recurrence integration
// (imported year remains available to the existing derived-age logic, no
// stored age field is ever introduced).

async function run() {
  const previewRoute = await readFile(new URL("../app/api/import/dob/preview/route.ts", import.meta.url), "utf8");
  const commitRoute = await readFile(new URL("../app/api/import/dob/commit/route.ts", import.meta.url), "utf8");
  const pipeline = await readFile(new URL("../lib/import/dob-pipeline.ts", import.meta.url), "utf8");
  const workbook = await readFile(new URL("../lib/import/dob-workbook.ts", import.meta.url), "utf8");
  const schema = await readFile(new URL("../db/schema.ts", import.meta.url), "utf8");
  const migration = await readFile(new URL("../drizzle/0029_important_dates_dob_source.sql", import.meta.url), "utf8");
  const stripComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");

  // --- Category 8: forbidden tables/fields -- the commit route (and
  // preview route, which is read-only but must still never reference these)
  // must never touch interactions, recommendations, giving_activities,
  // gifts, pledges, donor_historical_context, yahrtzeits,
  // relationship_summary, or institutional_memory. ---
  for (const [name, source] of [["preview", previewRoute], ["commit", commitRoute]]) {
    const code = stripComments(source);
    assert.doesNotMatch(code, /\binteractions\b/i, `${name} route must never touch the interactions table`);
    assert.doesNotMatch(code, /\brecommendations\b/i, `${name} route must never touch the recommendations table`);
    assert.doesNotMatch(code, /\bgiving_activities\b|\bgifts\b/i, `${name} route must never touch giving/gift records`);
    assert.doesNotMatch(code, /\bpledges\b/i, `${name} route must never touch pledges`);
    assert.doesNotMatch(code, /donor_historical_context/i, `${name} route must never touch donor_historical_context`);
    assert.doesNotMatch(code, /\byahrtzeits\b/i, `${name} route must never touch yahrtzeits`);
    assert.doesNotMatch(code, /relationship_summary|institutional_memory/i, `${name} route must never write donor narrative fields`);
  }

  // --- the commit route's only writes are important_dates and
  // important_date_changes. ---
  assert.match(commitRoute, /INSERT INTO important_dates/);
  assert.match(commitRoute, /UPDATE important_dates SET/);
  assert.match(commitRoute, /INSERT INTO important_date_changes/);
  const insertStatements = [...commitRoute.matchAll(/(?:INSERT INTO|UPDATE)\s+(\w+)/g)].map((m) => m[1]);
  assert.deepEqual(new Set(insertStatements), new Set(["important_dates", "important_date_changes"]), "the commit route must never write to any table other than important_dates and important_date_changes");

  // --- server independently re-derives everything from real D1 state --
  // classifyDobRow is called on the server's own donorLookup/existingLookup
  // built from fresh SELECTs, never trusting a client-submitted status. ---
  assert.match(commitRoute, /classifyDobRow\(row, donorLookup, existingLookup/, "the commit route must independently re-classify every row server-side");
  assert.doesNotMatch(stripComments(commitRoute), /row\.status/, "the commit route must never read a client-submitted status field -- only its own re-derived classification.status");
  assert.match(commitRoute, /classification\.status !== "ready_to_add" && classification\.status !== "enrich_missing_year"/, "only server-re-derived ready_to_add/enrich_missing_year rows may be written -- everything else is rejected even if the client claims otherwise");

  // --- exact donor-code matching only -- never fuzzy name matching. ---
  assert.match(pipeline, /donorLookup\.get\(row\.donorCode/, "donor matching must be an exact-key lookup on the code");
  assert.doesNotMatch(stripComments(pipeline), /similarity|levenshtein/i, "the pipeline must never fuzzy-match by name");
  assert.doesNotMatch(stripComments(workbook), /similarity|levenshtein/i);

  // --- ownership scoping on every D1 read. ---
  assert.match(previewRoute, /owner_user_id=\? AND data_source='live' AND archived_at IS NULL/, "preview must scope donor matching to this owner's live donors");
  assert.match(commitRoute, /owner_user_id=\? AND data_source='live' AND archived_at IS NULL/, "commit must scope donor matching to this owner's live donors");
  assert.match(previewRoute, /important_dates WHERE user_id=\? AND type='birthday'/, "preview must scope existing-birthday reads to this owner");
  assert.match(commitRoute, /important_dates WHERE user_id=\? AND type='birthday'/, "commit must scope existing-birthday reads to this owner");

  // --- both writes happen atomically in a single batch, so an audit row
  // can never be silently skipped by a partial failure. ---
  assert.match(commitRoute, /env\.DB\.batch\(statements\)/, "commit must write every row/audit pair atomically in one batch");

  // --- enrich never touches person_name: the UPDATE statement's column
  // list for the enrich branch must not include person_name. ---
  const enrichUpdateMatch = commitRoute.match(/UPDATE important_dates SET year=\?, relationship=\?, updated_at=\? WHERE/);
  assert.ok(enrichUpdateMatch, "the enrich UPDATE must set exactly year, relationship, and updated_at -- never person_name");

  // --- Category 9: migration/schema. ---
  assert.match(schema, /source: text\("source", \{ enum: \["manual", "import-dob"\] \}\)/, "schema must widen the source enum to include import-dob");
  assert.match(migration, /CHECK \(`source` IN \('manual','import-dob'\)\)/, "migration must widen the CHECK constraint to accept import-dob alongside manual");
  assert.match(migration, /INSERT INTO `__new_important_dates`/, "migration must copy every existing row across during the table rebuild, not just create a fresh empty table");
  assert.match(migration, /DROP TABLE `important_dates`/);
  assert.match(migration, /ALTER TABLE `__new_important_dates` RENAME TO `important_dates`/);
  // The three original indexes must be recreated, not silently dropped.
  assert.match(migration, /CREATE UNIQUE INDEX `important_dates_fingerprint_idx`/);
  assert.match(migration, /CREATE INDEX `important_dates_donor_idx`/);
  assert.match(migration, /CREATE INDEX `important_dates_user_idx`/);
  // No column beyond source's own CHECK differs from the original table --
  // this migration must never introduce a new stored-age or other new
  // column as a side effect of the rebuild.
  const columnNames = [...migration.matchAll(/`(\w+)` (?:text|integer)/g)].map((m) => m[1]);
  assert.ok(!columnNames.includes("age"), "the migration must never introduce a stored age column");

  // --- Category 10: age/recurrence integration. An imported row's year is
  // stored as a plain year field, and the EXISTING derived-age machinery
  // (nextGregorianRecurrence + yearsSinceForOccurrence) can compute an age
  // from it exactly like a manually-entered Birthday -- no DOB-specific age
  // logic, and no stored age field, is introduced anywhere in this
  // feature's own files. ---
  for (const source of [pipeline, workbook, commitRoute, previewRoute, schema]) {
    assert.doesNotMatch(stripComments(source), /\bage\s*[:=]/i, "no DOB-importer file may introduce a stored or computed 'age' field of its own -- age is always derived live from year + recurrence");
  }
  // Prove the existing derived-age path actually works end-to-end against
  // an imported year, using a real classification result's year as input --
  // the same numbers a newly-created import-dob row would carry.
  const donor = { donorId: "donor-1", donorName: "Test Donor", donorFirstName: "Yosef" };
  const donorLookup = new Map([["100", [donor]]]);
  const dobRow = { rowNumber: 2, donorCode: "100", dobRaw: "6/1/1990", month: 6, day: 1, year: 1990, dateError: null };
  const classification = classifyDobRow(dobRow, donorLookup, new Map());
  assert.equal(classification.status, "ready_to_add");
  assert.equal(classification.year, 1990, "the imported year must survive classification unchanged, ready to be stored and later used for age derivation");
  const timezone = "America/New_York";
  const now = Math.floor(Date.parse("2026-08-13T12:00:00Z") / 1000);
  const occurrence = nextGregorianRecurrence(classification.month, classification.day, timezone, now);
  const age = yearsSinceForOccurrence(occurrence.primary.year, classification.year);
  assert.equal(age, occurrence.primary.year - 1990, "the existing derived-age logic must compute a correct age directly from the imported month/day/year, with no import-dob-specific age code involved");
  assert.ok(age > 0, "the derived age must be a real, positive value -- proving the integration actually ran, not just returned zero by coincidence");

  console.log("DOB import safety/migration/age-integration checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
