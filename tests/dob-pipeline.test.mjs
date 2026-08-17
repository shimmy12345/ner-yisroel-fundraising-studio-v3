import assert from "node:assert/strict";
import { buildDobPreview, classifyDobRow, looksLikeDonorsOwnBirthday, summarizeDobPreview } from "../lib/import/dob-pipeline.ts";
import { importantDateFingerprint } from "../lib/import/important-date-fingerprint.ts";

// Categories 2 (matching), 3 (all 7 classification branches), 5 (review
// confirmation), 6 (enrich), 7 (idempotency).

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
  const donor1 = { donorId: "donor-1", donorName: "Test Donor", donorFirstName: "Yosef" };

  // --- Category 2: matching -- exact code, unmatched, duplicate-code
  // ambiguity, no fuzzy matching. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const matched = classifyDobRow(row(), lookup, existingLookup([]));
    assert.equal(matched.matchedDonorId, "donor-1");

    const unmatched = classifyDobRow(row({ donorCode: "999" }), lookup, existingLookup([]));
    assert.equal(unmatched.status, "unmatched");
    assert.equal(unmatched.matchedDonorId, null);

    const dupLookup = donorLookup([["100", [donor1, { donorId: "donor-2", donorName: "Other", donorFirstName: "Chaim" }]]]);
    const ambiguous = classifyDobRow(row(), dupLookup, existingLookup([]));
    assert.equal(ambiguous.status, "ambiguous");
    assert.equal(ambiguous.matchedDonorId, null, "an ambiguous code must never guess which of the duplicate donors is meant");

    // No fuzzy matching -- a code that's off by formatting only still fails
    // to match; codes are compared as exact strings from the lookup, never
    // via similarity.
    const noFuzzy = classifyDobRow(row({ donorCode: "1000" }), lookup, existingLookup([]));
    assert.equal(noFuzzy.status, "unmatched");
  }

  // --- Category 3, branch 1: no existing donor-own Birthday -> ready_to_add. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const result = classifyDobRow(row(), lookup, existingLookup([]));
    assert.equal(result.status, "ready_to_add");
    assert.equal(result.canCommit, true);
    assert.equal(result.donorFirstName, "Yosef");
    const expectedFingerprint = importantDateFingerprint({ id: "", donorId: "donor-1", type: "birthday", month: 6, day: 1, personName: "Yosef" });
    assert.equal(result.fingerprint, expectedFingerprint);
  }

  // --- Category 3, branch 2: exact month/day/year match -> already_recorded, no write. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-1", personName: "Yosef", relationship: "Donor", month: 6, day: 1, year: 1990 }]]]);
    const result = classifyDobRow(row(), lookup, existing);
    assert.equal(result.status, "already_recorded");
    assert.equal(result.canCommit, false);
    assert.equal(result.existingBirthday.id, "ex-1");
  }

  // --- Category 3, branch 3: same month/day, existing year null -> enrich_missing_year. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-2", personName: "Yosef", relationship: "Donor", month: 6, day: 1, year: null }]]]);
    const result = classifyDobRow(row(), lookup, existing);
    assert.equal(result.status, "enrich_missing_year");
    assert.equal(result.canCommit, true);
    assert.equal(result.existingBirthday.id, "ex-2");
  }

  // --- Category 3, branch 4: same month/day, different non-null year -> conflict, no write. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-3", personName: "Yosef", relationship: "Donor", month: 6, day: 1, year: 1985 }]]]);
    const result = classifyDobRow(row(), lookup, existing);
    assert.equal(result.status, "conflict");
    assert.equal(result.canCommit, false);
  }

  // --- Category 3, branch 5: different month/day -> conflict. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-4", personName: "Yosef", relationship: "Donor", month: 7, day: 4, year: 1990 }]]]);
    const result = classifyDobRow(row(), lookup, existing);
    assert.equal(result.status, "conflict");
    assert.equal(result.canCommit, false);
  }

  // --- Category 3, branch 6: existing birthday row(s) but none confidently
  // donor-own (e.g. a spouse birthday, relationship not "Donor" and name
  // doesn't match) -> needs_review, no write, never guessed. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-5", personName: "Chana", relationship: "Spouse", month: 3, day: 3, year: 1988 }]]]);
    const result = classifyDobRow(row(), lookup, existing);
    assert.equal(result.status, "needs_review");
    assert.equal(result.canCommit, false);
    assert.equal(result.existingBirthday.id, "ex-5");
  }

  // --- Category 3, branch 7: more than one row appears donor-own -> needs_review, never guess. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [
      { id: "ex-6a", personName: "Yosef", relationship: "Donor", month: 6, day: 1, year: 1990 },
      { id: "ex-6b", personName: null, relationship: "Donor", month: 8, day: 8, year: 1990 },
    ]]]);
    const result = classifyDobRow(row(), lookup, existing);
    assert.equal(result.status, "needs_review");
    assert.equal(result.canCommit, false);
  }

  // --- Invalid rows: missing code / missing or bad date. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const noCode = classifyDobRow(row({ donorCode: null }), lookup, existingLookup([]));
    assert.equal(noCode.status, "invalid");
    const noDate = classifyDobRow(row({ month: null, day: null, year: null, dateError: "Missing date of birth." }), lookup, existingLookup([]));
    assert.equal(noDate.status, "invalid");
  }

  // --- Donor with no first name on file -- cannot derive a deterministic
  // person_name, so this must be needs_review, never inventing a name. ---
  {
    const noNameDonor = { donorId: "donor-3", donorName: "No First Name Donor", donorFirstName: null };
    const lookup = donorLookup([["100", [noNameDonor]]]);
    const result = classifyDobRow(row(), lookup, existingLookup([]));
    assert.equal(result.status, "needs_review");
    assert.equal(result.canCommit, false);
  }

  // --- Automatic donor-own indicators: exactly the two approved signals,
  // nothing else. ---
  {
    assert.equal(looksLikeDonorsOwnBirthday({ personName: "Anything", relationship: "Donor" }, "Yosef"), true);
    assert.equal(looksLikeDonorsOwnBirthday({ personName: "Yosef", relationship: null }, "Yosef"), true, "blank relationship + exact first-name match is donor-own");
    assert.equal(looksLikeDonorsOwnBirthday({ personName: "Yosef", relationship: "" }, "Yosef"), true);
    assert.equal(looksLikeDonorsOwnBirthday({ personName: "Chana", relationship: "Spouse" }, "Yosef"), false, "a non-Donor relationship is never automatically donor-own, even with a name that happens to match some other way");
    assert.equal(looksLikeDonorsOwnBirthday({ personName: "Yos", relationship: null }, "Yosef"), false, "a shortened/partial name with blank relationship must never fuzzy-match");
    assert.equal(looksLikeDonorsOwnBirthday({ personName: null, relationship: null }, "Yosef"), false);
  }

  // --- Category 5: review confirmation. Confirming donor-own identity via
  // confirmedExistingId does not require retyping the date, does not
  // rewrite person_name, and an exact-match date becomes a no-op
  // (already_recorded), never a write. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-7", personName: "Yos", relationship: null, month: 6, day: 1, year: 1990 }]]]);
    // Without confirmation: not automatically donor-own (name doesn't
    // exact-match) -> needs_review.
    const beforeConfirm = classifyDobRow(row(), lookup, existing);
    assert.equal(beforeConfirm.status, "needs_review");

    // With explicit confirmation of ex-7: date already matches exactly ->
    // already_recorded, still no write, and person_name is never touched
    // (the classifier never returns a person_name override for this row --
    // the commit route only ever writes existingBirthday's own id, never a
    // new person_name for an existing row).
    const afterConfirm = classifyDobRow(row(), lookup, existing, "ex-7");
    assert.equal(afterConfirm.status, "already_recorded");
    assert.equal(afterConfirm.canCommit, false);
    assert.equal(afterConfirm.existingBirthday.personName, "Yos", "the existing record's personName must be preserved verbatim -- confirming identity is never a rename");

    // A confirmedExistingId that doesn't belong to this donor's own
    // existing rows must be ignored, never trusted blindly (mirrors the
    // commit route's own re-derivation from real D1 state).
    const bogusConfirm = classifyDobRow(row(), lookup, existing, "some-other-donors-row");
    assert.equal(bogusConfirm.status, "needs_review", "a confirmedExistingId that isn't among this donor's real existing rows must never be honored");
  }

  // --- Category 6: enrich -- only year (and, only if currently blank,
  // relationship normalization) may change; person_name is never part of
  // the classification's enrich output, so nothing about it can leak into
  // a rewrite. ---
  {
    const lookup = donorLookup([["100", [donor1]]]);
    const existing = existingLookup([["donor-1", [{ id: "ex-8", personName: "Dovi", relationship: "Donor", month: 4, day: 15, year: null }]]]);
    const dobRow = row({ month: 4, day: 15, year: 1991 });
    const result = classifyDobRow(dobRow, lookup, existing);
    assert.equal(result.status, "enrich_missing_year");
    assert.equal(result.canCommit, true);
    assert.equal(result.existingBirthday.personName, "Dovi");
    assert.equal(result.existingBirthday.year, null, "the classification's existingBirthday snapshot reflects the pre-enrich state; the commit route is what applies the new year");
  }

  // --- Category 7: idempotency. Building a preview a second time against
  // an existingLookup that already reflects a successful commit's resulting
  // rows must produce 0 ready_to_add and 0 enrich_missing_year -- every
  // successfully imported row becomes already_recorded, with a stable
  // fingerprint across both passes (since person_name for a newly-created
  // row is deterministically the donor's own first name every time). ---
  {
    const rows = [
      row({ rowNumber: 2, donorCode: "100", month: 6, day: 1, year: 1990 }),
      row({ rowNumber: 3, donorCode: "200", month: 4, day: 15, year: 1991 }),
    ];
    const donor2 = { donorId: "donor-2", donorName: "Second Donor", donorFirstName: "Dovi" };
    const lookup = donorLookup([["100", [donor1]], ["200", [donor2]]]);

    // First pass: nothing on file yet.
    const firstPreview = buildDobPreview(rows, lookup, existingLookup([]));
    const firstSummary = summarizeDobPreview(firstPreview);
    assert.equal(firstSummary.ready_to_add, 2);
    assert.equal(firstSummary.already_recorded, 0);

    // Simulate a successful commit: each ready_to_add row becomes a real
    // existing birthday row keyed by the SAME deterministic person_name
    // (donorFirstName) and the fingerprint computed during preview.
    const postCommitExisting = existingLookup([
      ["donor-1", [{ id: "new-1", personName: "Yosef", relationship: "Donor", month: 6, day: 1, year: 1990 }]],
      ["donor-2", [{ id: "new-2", personName: "Dovi", relationship: "Donor", month: 4, day: 15, year: 1991 }]],
    ]);

    // Second pass: re-uploading the identical workbook.
    const secondPreview = buildDobPreview(rows, lookup, postCommitExisting);
    const secondSummary = summarizeDobPreview(secondPreview);
    assert.equal(secondSummary.ready_to_add, 0, "re-uploading after a successful commit must never re-offer a create");
    assert.equal(secondSummary.enrich_missing_year, 0, "re-uploading after a successful commit must never re-offer an enrich");
    assert.equal(secondSummary.already_recorded, 2, "every previously-imported row must now be recognized as already recorded");
    for (const previewRow of secondPreview) assert.equal(previewRow.canCommit, false, "no already_recorded row is ever eligible for a second write");

    // Fingerprints are stable across both passes for the same donor/date.
    assert.equal(firstPreview[0].fingerprint, secondPreview[0].fingerprint);
    assert.equal(firstPreview[1].fingerprint, secondPreview[1].fingerprint);
  }

  console.log("DOB pipeline matching/classification/idempotency checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
