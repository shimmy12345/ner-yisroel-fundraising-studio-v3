import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { findLikelyManualDonorMatches } from "../lib/donors/merge-preview.ts";
import { buildHouseholdRollbackPreview } from "../lib/import/household-rollback.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migrations = () => fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();

test("default and searched donor lists share one owner-scoped live dataset without a hidden page cap", () => {
  const page = read("app/donors/page.tsx");
  assert.match(page, /const directorySql = `SELECT/);
  assert.match(page, /owner_user_id = \? AND data_source = 'live'/);
  assert.match(page, /COALESCE\(NULLIF\(last_name, ''\), display_name\).*COLLATE NOCASE/);
  assert.doesNotMatch(page, /LIMIT 1000/);
  assert.equal((page.match(/FROM donors WHERE \$\{scope\}/g) ?? []).length, 1);
});

test("a likely manual/JL duplicate cannot be inserted without an explicit three-way decision", () => {
  const candidates = findLikelyManualDonorMatches([{ id: "jl", donorCode: "JL-7", name: "Rosen Family", email: null, phone: null, address: null, spouse: null, contact: { lastName: "Rosen", primaryFirstName: "Ari", spouseFirstName: "Leah" } }], [{ id: "manual", display_name: "Ari and Leah Rosen", email: null, phone: null, home_phone: null, address_line_1: null, city: null, state: null, postal_code: null, last_name: "Rosen", primary_first_name: "Ari", spouse: "Leah", spouse_first_name: "Leah" }]);
  assert.equal(candidates.length, 1);
  const ui = read("app/onboarding/import/ImportExperience.tsx");
  const route = read("app/api/import/route.ts");
  const previewRoute = read("app/api/import/preview/route.ts");
  assert.match(ui, /Merge and preserve history/);
  assert.match(ui, /Keep as separate donors/);
  assert.match(ui, /Review later — do not import this household/);
  assert.match(ui, /needs_decision/);
  assert.match(route, /decision\?\.action === "review_later"/);
  assert.match(route, /ownedIds\.delete\(donor\.id\)/);
  assert.match(route, /Review the possible manual donor match/);
  assert.match(previewRoute, /const candidateDonors = matches\.map/);
  assert.match(route, /changeType: "consolidated"/);
  assert.match(route, /UPDATE interactions SET donor_id/);
  assert.match(route, /DELETE FROM donors WHERE id=.*external_source='JL Solutions'/);
});

test("household rollback restores updates, removes only batch inserts, and preserves later edits", () => {
  const database = new DatabaseSync(":memory:");
  for (const file of migrations()) database.exec(read(`drizzle/${file}`));
  const now = 1_800_000_000;
  database.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?,?,?,?,?)").run("user", "user@example.test", "User", now, now);
  database.prepare("INSERT INTO donors (id,owner_user_id,data_source,display_name,email,phone,last_name,external_source,external_id,donor_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("existing", "user", "live", "Rosen Family", "new@example.test", "later-phone", "Rosen", "JL Solutions", "JL-1", "JL-1", now, now);
  database.prepare("INSERT INTO donors (id,owner_user_id,data_source,display_name,last_name,external_source,external_id,donor_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("created", "user", "live", "Silver Family", "Silver", "JL Solutions", "JL-2", "JL-2", now, now);
  const changes = [
    { donor_id: "existing", change_type: "update", before_json: JSON.stringify({ email: "old@example.test", phone: "old-phone" }), after_json: JSON.stringify({ email: "new@example.test", phone: "import-phone" }) },
    { donor_id: "created", change_type: "insert", before_json: null, after_json: JSON.stringify({ owner_user_id: "user", data_source: "live", donor_code: "JL-2", external_source: "JL Solutions", external_id: "JL-2", display_name: "Silver Family", last_name: "Silver" }) },
  ];
  const current = database.prepare("SELECT *,0 AS dependency_count FROM donors ORDER BY id").all();
  const preview = buildHouseholdRollbackPreview(changes, current);
  assert.equal(preview.safe, true);
  assert.deepEqual(preview.totals, { householdsRemoved: 1, householdsRecreated: 0, householdsRestored: 1, laterEditsPreserved: 1 });
  assert.deepEqual(preview.restores[0].fields, { email: "old@example.test" });
  database.exec("BEGIN");
  database.prepare("UPDATE donors SET email=? WHERE id=?").run(preview.restores[0].fields.email, "existing");
  database.prepare("DELETE FROM donors WHERE id=?").run(preview.created[0].donorId);
  database.exec("COMMIT");
  assert.equal(database.prepare("SELECT email FROM donors WHERE id='existing'").get().email, "old@example.test");
  assert.equal(database.prepare("SELECT phone FROM donors WHERE id='existing'").get().phone, "later-phone");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM donors WHERE id='created'").get().count, 0);
});

test("household undo is batch-scoped, previewed, backed up, and audited", () => {
  const route = read("app/api/import/household-rollback/route.ts");
  const history = read("app/onboarding/import/page.tsx");
  const component = read("app/onboarding/import/UndoDonationImport.tsx");
  assert.match(route, /Only the most recent completed household import/);
  assert.match(route, /household_import_changes/);
  assert.match(route, /purpose='household_rollback'/);
  assert.match(route, /household_import_rollback_audits/);
  assert.match(route, /preserved_later_edits/);
  assert.match(route, /Previously separate|recreateFields/);
  assert.match(history, /latestCompletedHouseholdId/);
  assert.match(component, /Households created by this batch/);
  assert.match(component, /Later edits preserved/);
});

test("undo can recreate an explicitly consolidated JL household and its original links", () => {
  const changes = [
    { donor_id: "manual", change_type: "merge", before_json: JSON.stringify({ external_source: "Manual", external_id: null }), after_json: JSON.stringify({ external_source: "JL Solutions", external_id: "JL-9" }) },
    { donor_id: "jl-old", change_type: "consolidated", before_json: JSON.stringify({ display_name: "Original JL", external_source: "JL Solutions", external_id: "JL-9", linked: { interactions: ["interaction-1"] } }), after_json: JSON.stringify({ mergedInto: "manual" }) },
  ];
  const preview = buildHouseholdRollbackPreview(changes, [{ id: "manual", display_name: "Manual", external_source: "JL Solutions", external_id: "JL-9", dependency_count: 0 }]);
  assert.equal(preview.safe, true);
  assert.equal(preview.recreates.length, 1);
  assert.deepEqual(preview.recreates[0].linked.interactions, ["interaction-1"]);
  assert.equal(preview.restores[0].fields.external_source, "Manual");
});
