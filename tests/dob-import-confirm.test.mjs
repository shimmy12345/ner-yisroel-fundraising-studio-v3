import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyDobRow, validateDonorOwnBirthdayConfirmation } from "../lib/import/dob-pipeline.ts";

// Regression coverage for the "Confirm this is the donor's birthday"
// PERSISTENCE path (app/api/import/dob/confirm/route.ts), added after the
// real-world finding that a confirmed exact-date match was never durably
// recorded -- the confirmation only lived inside one preview response, so
// every subsequent upload of the same workbook re-surfaced the same two
// donors (Klein/Spetner-shaped: a shortened first name, blank
// relationship) as needs_review forever. validateDonorOwnBirthdayConfirmation
// is the pure, D1-free core the route calls; these tests exercise it
// directly, plus a handful of static checks on the route's own source to
// prove its write surface and audit shape.

function row(overrides = {}) {
  return { rowNumber: 2, donorCode: "100", dobRaw: "6/1/1990", month: 6, day: 1, year: 1990, dateError: null, ...overrides };
}
function donorLookup(entries) {
  const map = new Map();
  for (const [code, candidates] of entries) map.set(code, candidates);
  return map;
}
function existingLookup(entries) {
  const map = new Map();
  for (const [donorId, rows] of entries) map.set(donorId, rows);
  return map;
}

async function run() {
  const donor = { donorId: "donor-1", donorName: "Test Donor", donorFirstName: "Yaakov Yisroel" };
  const otherDonor = { donorId: "donor-2", donorName: "Other Donor", donorFirstName: "Someone Else" };

  // --- 1: unconfirmed shortened-name record -> needs_review (the starting
  // state every confirmation begins from). ---
  {
    const lookup = donorLookup([["100", [donor]]]);
    const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]]]);
    const preview = classifyDobRow(row(), lookup, existing);
    assert.equal(preview.status, "needs_review");
    assert.equal(preview.canCommit, false);
  }

  // --- 2: explicit confirmation of an exact-DOB record is accepted, and
  // only relationship is proposed as the change -- personName/date/source/
  // fingerprint are never part of the validated write. ---
  {
    const lookup = donorLookup([["100", [donor]]]);
    const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]]]);
    const result = validateDonorOwnBirthdayConfirmation(row(), "existing-1", lookup, existing);
    assert.deepEqual(result, { ok: true, donorId: "donor-1", existingId: "existing-1" });
  }

  // --- 3: fresh preview after confirmation -- simulating the persisted
  // relationship="Donor" write by rebuilding existingLookup with it set,
  // WITHOUT passing any confirmedExistingId -- must resolve to
  // already_recorded purely from the persisted fact, no further review. ---
  {
    const lookup = donorLookup([["100", [donor]]]);
    const persistedExisting = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: "Donor", month: 6, day: 1, year: 1990 }]]]);
    const preview = classifyDobRow(row(), lookup, persistedExisting); // no confirmedExistingId
    assert.equal(preview.status, "already_recorded", "a persisted relationship=Donor must resolve automatically -- no confirmedExistingId override needed anymore");
    assert.equal(preview.canCommit, false);
    assert.equal(preview.existingBirthday.personName, "Yaakov", "personName must remain exactly as it was -- confirmation never renames it");
  }

  // --- 4: re-upload again -- buildDobPreview-equivalent classification a
  // second time against the same persisted state produces the identical
  // already_recorded result, zero eligibility for any write. ---
  {
    const lookup = donorLookup([["100", [donor]]]);
    const persistedExisting = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: "Donor", month: 6, day: 1, year: 1990 }]]]);
    const firstPass = classifyDobRow(row(), lookup, persistedExisting);
    const secondPass = classifyDobRow(row(), lookup, persistedExisting);
    assert.deepEqual(firstPass, secondPass);
    assert.equal(secondPass.status, "already_recorded");
    assert.equal(secondPass.canCommit, false);
  }

  // --- 5: confirmation is rejected in every listed adversarial case. ---
  {
    const lookup = donorLookup([["100", [donor]], ["200", [otherDonor]]]);

    // DOB no longer matches (spreadsheet says 6/2, existing record is 6/1).
    {
      const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]]]);
      const result = validateDonorOwnBirthdayConfirmation(row({ day: 2 }), "existing-1", lookup, existing);
      assert.equal(result.ok, false);
    }

    // Row belongs to another donor -- existingId is real, but for donor-2,
    // not donor-1 (the donor the submitted code resolves to).
    {
      const existing = existingLookup([
        ["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]],
        ["donor-2", [{ id: "existing-2", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]],
      ]);
      const result = validateDonorOwnBirthdayConfirmation(row(), "existing-2", lookup, existing);
      assert.equal(result.ok, false, "an existingId belonging to a different donor than the one the code resolves to must never be honored");
    }

    // Row isn't a birthday -- existingLookup is built exclusively from
    // type='birthday' rows by the real route, so an anniversary row's id
    // simply never appears in it; confirming against that id must fail
    // exactly like any other unrecognized id.
    {
      const existing = existingLookup([["donor-1", []]]); // the donor has no birthday row at all -- e.g. only an anniversary exists, filtered out upstream
      const result = validateDonorOwnBirthdayConfirmation(row(), "anniversary-row-id", lookup, existing);
      assert.equal(result.ok, false);
    }

    // Relationship already nonblank with conflicting semantics (Spouse).
    {
      const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: "Spouse", month: 6, day: 1, year: 1990 }]]]);
      const result = validateDonorOwnBirthdayConfirmation(row(), "existing-1", lookup, existing);
      assert.equal(result.ok, false);
      assert.match(result.reason, /already set to "Spouse"/);
    }

    // Donor code no longer resolves uniquely (now ambiguous -- two live
    // donors share the code).
    {
      const ambiguousLookup = donorLookup([["100", [donor, { donorId: "donor-3", donorName: "Duplicate Code Donor", donorFirstName: "Someone" }]]]);
      const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]]]);
      const result = validateDonorOwnBirthdayConfirmation(row(), "existing-1", ambiguousLookup, existing);
      assert.equal(result.ok, false);
    }

    // Row ID is tampered with -- a syntactically plausible id that simply
    // isn't among this donor's real existing rows.
    {
      const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Yaakov", relationship: null, month: 6, day: 1, year: 1990 }]]]);
      const result = validateDonorOwnBirthdayConfirmation(row(), "totally-made-up-id", lookup, existing);
      assert.equal(result.ok, false);
    }
  }

  // --- 6: spouse/child birthdays cannot be converted to Donor unless they
  // satisfy the EXACT approved review state (blank relationship + exact
  // date match). A non-blank relationship is rejected even when every
  // other fact (date, donor, row ownership) is otherwise valid -- covered
  // above -- and even when the row status is needs_review for the
  // "belongs to a spouse or child" reason specifically. ---
  {
    const lookup = donorLookup([["100", [donor]]]);
    const existing = existingLookup([["donor-1", [{ id: "existing-1", personName: "Chana", relationship: "Spouse", month: 6, day: 1, year: 1990 }]]]);
    const preview = classifyDobRow(row(), lookup, existing);
    assert.equal(preview.status, "needs_review", "test setup: a spouse-labeled birthday with matching date is needs_review, not auto-resolved");
    const result = validateDonorOwnBirthdayConfirmation(row(), "existing-1", lookup, existing);
    assert.equal(result.ok, false, "a Spouse-labeled row must never be confirmable to Donor through this path");
  }

  // --- source-level checks on the route itself: write surface, audit
  // shape, and authorization scoping. ---
  const confirmRoute = await readFile(new URL("../app/api/import/dob/confirm/route.ts", import.meta.url), "utf8");
  const stripComments = (source) => source.replace(/^\s*\/\/.*$/gm, "");
  const code = stripComments(confirmRoute);

  // Exactly one UPDATE, touching only relationship and updated_at.
  const updateStatements = [...code.matchAll(/UPDATE\s+(\w+)\s+SET\s+([^W]+?)\s+WHERE/g)];
  assert.equal(updateStatements.length, 1, "the confirm route must contain exactly one UPDATE statement");
  assert.equal(updateStatements[0][1], "important_dates", "the confirm route must only ever UPDATE important_dates");
  assert.match(updateStatements[0][2], /^relationship='Donor', updated_at=\?$/, "the confirm route's UPDATE must set only relationship and updated_at -- never person_name, month, day, year, source, or fingerprint");

  // Exactly one audit insert, action='updated'.
  const auditInserts = [...code.matchAll(/INSERT INTO\s+(\w+)/g)];
  assert.deepEqual(auditInserts.map((m) => m[1]), ["important_date_changes"], "the confirm route must write exactly one audit row and never insert into important_dates itself");
  assert.match(code, /'updated'/, "the audit row's action must be 'updated'");
  assert.match(code, /env\.DB\.batch\(/, "the update and its audit row must be written atomically");

  // Forbidden tables/fields -- never touched by this route.
  assert.doesNotMatch(code, /\binteractions\b/i);
  assert.doesNotMatch(code, /\brecommendations\b/i);
  assert.doesNotMatch(code, /\bgiving_activities\b|\bgifts\b|\bpledges\b/i);
  assert.doesNotMatch(code, /donor_historical_context/i);
  assert.doesNotMatch(code, /\byahrtzeits\b/i);
  assert.doesNotMatch(code, /relationship_summary|institutional_memory/i);

  // Authorization/ownership scoping, matching the DOB preview/commit routes.
  assert.match(confirmRoute, /owner_user_id=\? AND data_source='live' AND archived_at IS NULL/, "confirm must scope donor matching to this owner's live donors");
  assert.match(confirmRoute, /important_dates WHERE user_id=\? AND type='birthday'/, "confirm must scope existing-birthday reads to this owner");
  assert.match(confirmRoute, /WHERE id=\? AND user_id=\?/, "the UPDATE itself must also be scoped to this owner's own row, not just the pre-check");

  // Server never trusts a client-submitted classification/status -- it
  // must call the shared validator, which independently re-derives
  // everything from a fresh donorLookup/existingLookup built in this
  // route, never from anything the client asserts about its own row.
  assert.match(confirmRoute, /validateDonorOwnBirthdayConfirmation\(row, body\.existingId, donorLookup, existingLookup\)/);
  assert.doesNotMatch(code, /body\.relationship|body\.status|body\.canCommit/, "the route must never accept a client-submitted relationship, status, or canCommit value");

  console.log("DOB confirm-persistence checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
