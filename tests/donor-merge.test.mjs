import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MERGE_FIELD_GROUPS, mergeFieldValues, validateMergeChoices } from "../lib/donors/merge.ts";
import { findLikelyManualDonorMatches } from "../lib/donors/merge-preview.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const donor = (id, source, code, name) => ({ id, owner_user_id:"owner", data_source:"live", archived_at:null, merged_into_donor_id:null, display_name:name, spouse:null, donor_code:code, external_source:source, external_id:code, email:null, phone:null, home_phone:null, alternate_mobile_phone:null, address:null, address_line_1:null, city:null, state:null, postal_code:null, country:null, contact_note:null, last_name:name.split(" ").at(-1), primary_first_name:null, spouse_first_name:null, primary_title:null, spouse_title:null, source_snapshot:null });

test("field choices support either manual or JL survivor without automatic merging", () => {
  const manual = donor("manual","Manual",null,"Ari Cohen"); const jl = donor("jl","JL Solutions","JL-42","Mr. Ari Cohen"); jl.email="jl@example.test"; manual.phone="4105550100";
  const manualChoices = Object.fromEntries(MERGE_FIELD_GROUPS.map((field)=>[field,"manual"])); manualChoices.email="jl";
  assert.equal(validateMergeChoices("manual","jl",manualChoices),true);
  assert.equal(mergeFieldValues(manual,jl,manualChoices).email,"jl@example.test");
  const jlChoices = Object.fromEntries(MERGE_FIELD_GROUPS.map((field)=>[field,"jl"])); jlChoices.phones="manual";
  assert.equal(mergeFieldValues(jl,manual,jlChoices).phone,"4105550100");
  assert.equal(validateMergeChoices("manual","jl",{...manualChoices,email:"third"}),false);
});

test("an exact JL Code on a manual donor always pauses import for a decision", () => {
  const candidates=findLikelyManualDonorMatches([{id:"incoming",donorCode:"JL-42",name:"Different Display",spouse:null,email:null,phone:null,address:null,contact:{lastName:null,primaryFirstName:null,spouseFirstName:null}}],[{id:"manual",display_name:"Unrelated Local Name",donor_code:"JL-42",external_id:null,email:null,phone:null,home_phone:null,address_line_1:null,city:null,state:null,postal_code:null}]);
  assert.equal(candidates.length,1); assert.match(candidates[0].reasons.join(" "),/same JL Code/);
});

test("merge schema archives aliases and retains a durable audit", () => {
  const database=new DatabaseSync(":memory:");
  for(const file of fs.readdirSync(new URL("../drizzle",import.meta.url)).filter((name)=>/^\d{4}_.+\.sql$/.test(name)).sort()) database.exec(read(`drizzle/${file}`));
  const columns=database.prepare("PRAGMA table_info(donors)").all().map((row)=>row.name);
  assert.equal(columns.includes("archived_at"),true); assert.equal(columns.includes("merged_into_donor_id"),true);
  assert.ok(database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='donor_merge_audits'").get());
});

test("merge route moves every linked history table, archives instead of deletes, and redirects old donor links", () => {
  const route=read("app/api/donors/merge/route.ts"); const page=read("app/donors/[id]/page.tsx"); const importer=read("app/api/import/route.ts"); const ui=read("app/onboarding/import/ImportExperience.tsx");
  for(const table of ["gifts","giving_activities","interactions","recommendations","donor_contact_audits","jl_payment_assignment_audits"]) assert.match(route,new RegExp(`UPDATE ${table} SET donor_id=\\?`));
  assert.match(route,/INSERT INTO donor_merge_audits/); assert.match(route,/archived_at=\?,merged_into_donor_id=\?/); assert.doesNotMatch(route,/DELETE FROM donors/);
  assert.match(page,/redirect\(`\/donors\/\$\{encodeURIComponent\(donor\.merged_into_donor_id\)\}`\)/); assert.match(page,/Resolve Duplicate/);
  assert.match(ui,/>Resolve Duplicate</); assert.match(ui,/Review later — do not import this household/); assert.match(importer,/decision\?\.action === "review_later"/); assert.doesNotMatch(importer,/DELETE FROM donors WHERE id=\?/);
});

test("default directory and capture search exclude archived aliases", () => {
  assert.match(read("app/donors/page.tsx"),/archived_at IS NULL/); assert.match(read("app/capture/page.tsx"),/archived_at IS NULL/); assert.match(read("lib/workspace/live-data.ts"),/d\.archived_at IS NULL/);
});
