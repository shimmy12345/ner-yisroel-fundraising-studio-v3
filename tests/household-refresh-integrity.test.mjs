import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { findLikelyManualDonorMatches } from "../lib/donors/merge-preview.ts";
import { buildHouseholdRollbackPreview } from "../lib/import/household-rollback.ts";
import { effectiveDonorLastName, searchDonors } from "../lib/relationships/donor-search.ts";
import { buildLegacyHouseholdRepairAssessment, LEGACY_HOUSEHOLD_BATCH_ID } from "../lib/import/legacy-household-repair.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migrations = () => fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();

test("default and searched donor lists share one owner-scoped live dataset without a hidden page cap", () => {
  const page = read("app/donors/page.tsx");
  assert.match(page, /const directorySql = `SELECT/);
  assert.match(page, /owner_user_id = \? AND data_source = 'live'/);
  assert.doesNotMatch(page, /LIMIT 1000/);
  assert.equal((page.match(/FROM donors WHERE \$\{scope\}/g) ?? []).length, 1);
  assert.equal((page.match(/searchDonors\(/g) ?? []).length, 2);
  assert.doesNotMatch(page, /searchFilter/);
  assert.match(page, /export const revalidate = 0/);
  assert.match(read("app/components/AppShell.tsx"), /<a className=\{active === "donors".*href="\/donors"/);
});

test("titled households with a blank stored last name remain visible and sort by inferred surname", () => {
  const fixtures = [
    { id: "ordinary", name: "Mr. Aaron Baker", lastName: "Baker", spouse: null, code: null, email: null, phone: null },
    { id: "titled-a", name: "Dr. & Mrs. Jonah Armand", lastName: null, spouse: "Mira", code: "A-1", email: null, phone: null },
    { id: "titled-g", name: "Mr. & Mrs. Peter Z. Greene", lastName: "", spouse: "Kara", code: "G-1", email: null, phone: null },
  ];
  assert.equal(effectiveDonorLastName(fixtures[1]), "Armand");
  assert.equal(effectiveDonorLastName(fixtures[2]), "Greene");
  const defaultRows = searchDonors(fixtures, "", Number.MAX_SAFE_INTEGER);
  assert.deepEqual(defaultRows.map((row) => row.id), ["titled-a", "ordinary", "titled-g"]);
  assert.equal(searchDonors(defaultRows, "Armand", Number.MAX_SAFE_INTEGER)[0].id, "titled-a");
  assert.equal(searchDonors(defaultRows, "Peter Z. Greene", Number.MAX_SAFE_INTEGER)[0].id, "titled-g");
  assert.deepEqual(new Set(defaultRows.map((row) => row.id)), new Set(fixtures.map((row) => row.id)));
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
  assert.deepEqual(preview.totals, { householdsRemoved: 1, householdsRecreated: 0, householdsRestored: 1, laterEditsPreserved: 1, batchRecordsRemoved: 0 });
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
  assert.match(history, /report\.profile === "General spreadsheet"/);
  assert.match(component, /Households created by this batch/);
  assert.match(component, /Later edits preserved/);
  assert.match(component, /View Details & Undo/);
});

test("ordinary spreadsheet household imports use the same rollback ledger and capture batch-created records", () => {
  const route = read("app/api/import/route.ts");
  const rollback = read("app/api/import/household-rollback/route.ts");
  assert.match(route, /profile: jlDetected \? "JL Solutions" : "General spreadsheet"/);
  assert.match(route, /if \(householdChangeRows\.length\)/);
  assert.doesNotMatch(route, /if \(jlDetected && householdChangeRows\.length\)/);
  assert.match(route, /after\.__batchLinked = \{ gifts:/);
  assert.match(rollback, /This older batch cannot be undone because its exact before-values and inserted-record IDs were not recorded/);
  assert.match(rollback, /DELETE FROM gifts WHERE id IN/);
  assert.match(rollback, /DELETE FROM interactions WHERE id IN/);
  assert.match(rollback, /DELETE FROM recommendations WHERE id IN/);

  const changes = [{ donor_id: "new-household", change_type: "insert", before_json: null, after_json: JSON.stringify({ owner_user_id: "user", data_source: "live", display_name: "New Household", __batchLinked: { gifts: ["gift-1"], interactions: ["interaction-1"], recommendations: ["reminder-1"] } }) }];
  const preview = buildHouseholdRollbackPreview(changes, [{ id: "new-household", owner_user_id: "user", data_source: "live", display_name: "New Household", dependency_count: 3 }]);
  assert.equal(preview.safe, true);
  assert.deepEqual(preview.batchDeletes, { gifts: ["gift-1"], interactions: ["interaction-1"], recommendations: ["reminder-1"] });
  assert.equal(preview.totals.batchRecordsRemoved, 3);
  assert.equal(preview.created[0].donorId, "new-household");
});

test("the one-time legacy repair tool identifies candidates but blocks timestamp-only rollback", () => {
  const batch = { id: LEGACY_HOUSEHOLD_BATCH_ID, file_name: "legacy-households.csv", status: "completed", report_json: JSON.stringify({ firstRelationshipId: "existing", imported: { donors: 2 } }), created_at: 100, completed_at: 110 };
  const candidates = [
    { id: "existing", display_name: "Dr. & Mrs. Jonah Armand", last_name: null, donor_code: "A-1", external_id: null, external_source: "JL Solutions", owner_user_id: "owner", data_source: "live", created_at: 10, updated_at: 110 },
    { id: "possible-new", display_name: "Mr. & Mrs. Peter Z. Greene", last_name: null, donor_code: "G-1", external_id: null, external_source: null, owner_user_id: "owner", data_source: "live", created_at: 110, updated_at: 110 },
  ];
  const assessment = buildLegacyHouseholdRepairAssessment(batch, candidates, 0, 0);
  assert.equal(assessment.automaticRepairSafe, false);
  assert.equal(assessment.exactAttributionProven, false);
  assert.deepEqual(assessment.candidates.map((item) => item.probableChange), ["possible_update", "possible_insert"]);
  assert.match(assessment.blockers.join(" "), /before-values/);
  assert.match(assessment.blockers.join(" "), /timestamps are supporting evidence only/i);
  const route = read("app/api/import/legacy-household-repair/route.ts");
  const component = read("app/onboarding/import/UndoDonationImport.tsx");
  assert.match(route, /LEGACY_HOUSEHOLD_BATCH_ID/);
  assert.match(route, /owner_user_id=\? AND data_source='live'/);
  assert.match(route, /IN \('49026','65904'\)/);
  assert.match(route, /status: 409/);
  assert.match(component, /Automatic repair blocked/);
  assert.match(component, /Manual repair plan/);
  assert.match(component, /Stored last name/);
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
