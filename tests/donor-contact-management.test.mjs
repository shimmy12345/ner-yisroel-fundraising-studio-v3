import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { normalizeDonorContact } from "../lib/donors/contact.ts";
import { findLikelyManualDonorMatches } from "../lib/donors/merge-preview.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("contact validation requires a name and normalizes optional values", () => {
  const missing = normalizeDonorContact({ householdName: "" });
  assert.equal(missing.valid, false);
  assert.equal(missing.errors.householdName, "Household or donor name is required.");
  const valid = normalizeDonorContact({ householdName: "  Cohen Household ", email: " donor@example.org ", mobilePhone: "(212) 555-0100" });
  assert.equal(valid.valid, true);
  assert.equal(valid.contact.householdName, "Cohen Household");
  assert.equal(valid.contact.email, "donor@example.org");
});

test("likely JL matches are advisory and require strong identity evidence", () => {
  const jl = [{ id: "incoming", donorCode: "JL-42", name: "Cohen Household", email: "donor@example.org", phone: "2125550100", address: null, spouse: null, contact: { addressLine1: null, city: null, state: null } }];
  const candidates = findLikelyManualDonorMatches(jl, [{ id: "manual-1", display_name: "Cohen Household", email: "donor@example.org", phone: null, home_phone: null, address_line_1: null, city: null, state: null, postal_code: null }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].manualDonorId, "manual-1");
  assert.equal(findLikelyManualDonorMatches([{ ...jl[0], name: "Different", email: null, phone: null }], [{ ...candidates[0], id: "manual-2", display_name: "Unrelated", email: null, phone: null, home_phone: null, address_line_1: null, city: null, state: null, postal_code: null }]).length, 0);
});

test("manual create/edit routes are authenticated, owner scoped, audited, and keep JL identifiers read-only", () => {
  const create = read("app/api/donors/route.ts");
  const edit = read("app/api/donors/[id]/route.ts");
  const form = read("app/donors/ContactForm.tsx");
  assert.match(create, /external_source.*Manual/s);
  assert.match(create, /crypto\.randomUUID\(\)/);
  assert.match(create, /donor_contact_audits/);
  assert.match(edit, /owner_user_id = \?/);
  assert.match(edit, /donor_contact_audits/);
  assert.doesNotMatch(edit, /source_snapshot\s*=/);
  assert.doesNotMatch(edit, /external_id\s*=/);
  assert.match(form, /readOnly aria-readonly="true"/);
});

test("JL refresh previews local conflicts and never auto-merges manual donors", () => {
  const preview = read("app/api/import/preview/route.ts");
  const importer = read("app/api/import/route.ts");
  const experience = read("app/onboarding/import/ImportExperience.tsx");
  assert.match(preview, /findLikelyManualDonorMatches/);
  assert.match(preview, /external_source = 'Manual'/);
  assert.match(experience, /Fundraising OS will never merge or add a likely duplicate without your decision/);
  assert.match(experience, /Resolve duplicate and preserve history/);
  assert.match(importer, /decision\?\.action === "merge"/);
  assert.match(importer, /ownedIds\.set\(donor\.id, manualDonor\.id\)/);
  assert.match(importer, /merged_with_jl/);
  assert.match(importer, /sourceSnapshot\(donor\)/);
});

test("contact schema migration adds notes and immutable audit history", () => {
  const db = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) db.exec(read(`drizzle/${file}`));
  const donorColumns = db.prepare("PRAGMA table_info(donors)").all().map((row) => row.name);
  assert.ok(donorColumns.includes("contact_note"));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='donor_contact_audits'").get().name, "donor_contact_audits");
});

test("donor directory exposes New Donor and donor contact editing", () => {
  assert.match(read("app/donors/page.tsx"), /href="\/donors\/new"/);
  assert.match(read("app/donors/[id]/page.tsx"), /Edit Contact Details/);
});
