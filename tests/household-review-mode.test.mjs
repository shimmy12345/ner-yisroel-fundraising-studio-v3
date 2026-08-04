import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { findLikelyManualDonorMatches } from "../lib/donors/merge-preview.ts";
import { buildExistingDonorReviews, householdReviewSignature, resolveReviewedJlUpdates } from "../lib/import/household-review.ts";
import { findJlCodeCollisions, matchJlDonors, sourceSnapshot } from "../lib/import/jl-match.ts";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migrations = () => fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
const incoming = (overrides = {}) => ({ id: "incoming", donorCode: "JL-7", name: "Cohen Household", email: "new@example.test", phone: "555-0100", address: "7 Main St", spouse: "Leah", contact: { lastName: "Cohen", primaryFirstName: "Ari", spouseFirstName: "Leah", primaryTitle: null, spouseTitle: null, alternateMobilePhone: null, homePhone: "555-0199", addressLine1: "7 Main St", city: "Lakewood", state: "NJ", postalCode: "08701", country: "US" }, sourceValues: {}, ...overrides });
const existing = (source, overrides = {}) => ({ id: "existing", external_id: "JL-7", display_name: source.name, email: source.email, phone: source.phone, address: source.address, last_name: source.contact.lastName, primary_first_name: source.contact.primaryFirstName, spouse_first_name: source.contact.spouseFirstName, primary_title: null, spouse_title: null, alternate_mobile_phone: null, home_phone: source.contact.homePhone, address_line_1: source.contact.addressLine1, city: source.contact.city, state: source.contact.state, postal_code: source.contact.postalCode, country: source.contact.country, source_snapshot: JSON.stringify(sourceSnapshot(source)), ...overrides });

test("all three modes review the intended unchanged and changed donors", () => {
  const unchangedDonor = incoming();
  const prior = incoming({ email: "old@example.test" });
  const unchanged = matchJlDonors([unchangedDonor], [existing(unchangedDonor)])[0];
  const changed = matchJlDonors([incoming()], [existing(prior)])[0];
  assert.equal(buildExistingDonorReviews([unchanged, changed], "review_every").length, 2);
  assert.deepEqual(buildExistingDonorReviews([unchanged, changed], "changes_only").map((item) => item.externalId), ["JL-7"]);
  assert.deepEqual(buildExistingDonorReviews([unchanged, changed], "auto_unchanged").map((item) => item.externalId), ["JL-7"]);
  assert.match(resolveReviewedJlUpdates(unchanged, "review_every", undefined, []).error, /needs review/);
  assert.equal(resolveReviewedJlUpdates(unchanged, "review_every", { externalId: "JL-7", action: "keep_current", signature: householdReviewSignature(unchanged) }, []).error, null);
  assert.deepEqual(resolveReviewedJlUpdates(unchanged, "review_every", { externalId: "JL-7", action: "accept_all", signature: householdReviewSignature(unchanged) }, []).updates, {});
  assert.equal(resolveReviewedJlUpdates(unchanged, "auto_unchanged", undefined, []).error, null);
});

test("changed donors support accept all, keep current, and field-by-field decisions", () => {
  const prior = incoming({ email: "old@example.test", phone: "555-0000" });
  const match = matchJlDonors([incoming()], [existing(prior)])[0];
  const signature = householdReviewSignature(match);
  assert.deepEqual(resolveReviewedJlUpdates(match, "changes_only", { externalId: "JL-7", action: "accept_all", signature }, []).updates, { email: "new@example.test", phone: "555-0100" });
  assert.deepEqual(resolveReviewedJlUpdates(match, "changes_only", { externalId: "JL-7", action: "keep_current", signature }, []).updates, {});
  const fieldResult = resolveReviewedJlUpdates(match, "changes_only", { externalId: "JL-7", action: "field_by_field", signature }, [
    { externalId: "JL-7", field: "email", action: "use_jl" }, { externalId: "JL-7", field: "phone", action: "keep_local" },
  ]);
  assert.deepEqual(fieldResult.updates, { email: "new@example.test" });
});

test("local overrides never continue silently in any mode", () => {
  const prior = incoming({ email: "old@example.test" });
  const changedExport = incoming({ email: "latest@example.test" });
  const overridden = matchJlDonors([changedExport], [existing(prior, { email: "fundraiser@example.test" })])[0];
  assert.equal(overridden.conflicts.length, 1);
  for (const mode of ["review_every", "changes_only", "auto_unchanged"]) {
    assert.equal(buildExistingDonorReviews([overridden], mode).length, 1);
    assert.match(resolveReviewedJlUpdates(overridden, mode, undefined, []).error, /needs review/);
  }
});

test("stale previews and JL Code ownership conflicts stop before writes", () => {
  const prior = incoming({ email: "old@example.test" });
  const match = matchJlDonors([incoming()], [existing(prior)])[0];
  assert.match(resolveReviewedJlUpdates(match, "auto_unchanged", { externalId: "JL-7", action: "accept_all", signature: "stale" }, []).error, /changed after the preview/);
  assert.equal(findJlCodeCollisions([{ id: "one", external_source: "JL Solutions", external_id: "JL-7", donor_code: "JL-7" }, { id: "two", external_source: "Manual", external_id: null, donor_code: "JL-7" }]).length, 1);
});

test("name-only manual duplicates still require a separate merge decision", () => {
  const candidates = findLikelyManualDonorMatches([incoming()], [{ id: "manual", display_name: "Cohen Household", donor_code: null, external_id: null, email: null, phone: null, home_phone: null, address_line_1: null, city: null, state: null, postal_code: null }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].exactCodeMatch, false);
});

test("review mode persists in D1 and the UI explains every choice to a first-time user", () => {
  const database = new DatabaseSync(":memory:");
  for (const file of migrations()) database.exec(read(`drizzle/${file}`));
  const now = 1_800_000_000;
  database.prepare("INSERT INTO users (id,email,name,household_import_review_mode,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("user", "user@example.test", "User", "review_every", now, now);
  assert.equal(database.prepare("SELECT household_import_review_mode mode FROM users WHERE id='user'").get().mode, "review_every");
  const settings = read("app/settings/SettingsExperience.tsx");
  const importer = read("app/onboarding/import/ImportExperience.tsx");
  for (const label of ["Review every existing donor", "Review only donors with changes", "Auto-continue unchanged donors"]) assert.match(settings, new RegExp(label));
  for (const label of ["No changes detected", "Accept JL values", "Keep current values", "Review field-by-field", "Change in Settings"]) assert.match(importer, new RegExp(label));
  assert.match(read("app/api/profile/route.ts"), /household_import_review_mode/);
});

test("final confirmation revalidates mode and records donor decisions in the batch audit without touching giving totals", () => {
  const route = read("app/api/import/route.ts");
  assert.match(route, /body\.reviewMode !== profile\.importReviewMode/);
  assert.match(route, /resolveReviewedJlUpdates/);
  assert.doesNotMatch(route, /\["continue", "accept_all"/);
  assert.match(route, /report\.household\.decisions\.push/);
  assert.match(route, /JSON\.stringify\(report\)/);
  assert.match(route, /beforeJson: JSON\.stringify\(before\)/);
  assert.doesNotMatch(route, /UPDATE giving_activities SET (paid_cents|balance_cents).*reviewMode/);
  assert.match(route, /UPDATE giving_activities SET donor_id=/);
  assert.match(route, /UPDATE interactions SET donor_id=/);
  assert.match(route, /UPDATE recommendations SET donor_id=/);
});
