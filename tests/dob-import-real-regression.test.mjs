import assert from "node:assert/strict";
import { classifyDobRow } from "../lib/import/dob-pipeline.ts";

// Category 4: real-regression tests for the two genuine shortened-first-
// name needs_review cases found in the live staging audit of
// birthdate.xlsx/birthdate.csv against the real donors table (171/171 code
// matches, 158 ready_to_add, 10 already_recorded, 1 enrich_missing_year, 2
// needs_review -- these are exactly those 2, reproduced with their real
// donor ids, codes, names, and dates). Both existing records have a
// month/day/year IDENTICAL to the spreadsheet -- the only reason they
// cannot auto-resolve is a shortened personName with a blank relationship,
// which the approved automatic indicators correctly decline to fuzzy-match.

async function run() {
  // --- Case 1: Yaakov Yisroel Klein, donor d7374b2d-82b2-45fd-b8d2-397c67b5ed15,
  // code 67103, spreadsheet DOB 6/21/1985. Existing Birthday record:
  // personName="Yaakov", relationship=null. ---
  {
    const donor = { donorId: "d7374b2d-82b2-45fd-b8d2-397c67b5ed15", donorName: "Yaakov Yisroel Klein", donorFirstName: "Yaakov Yisroel" };
    const donorLookup = new Map([["67103", [donor]]]);
    const existingLookup = new Map([[donor.donorId, [{ id: "existing-klein", personName: "Yaakov", relationship: null, month: 6, day: 21, year: 1985 }]]]);
    const dobRow = { rowNumber: 67, donorCode: "67103", dobRaw: "6/21/1985", month: 6, day: 21, year: 1985, dateError: null };

    const preview = classifyDobRow(dobRow, donorLookup, existingLookup);
    assert.equal(preview.status, "needs_review", "shortened first name 'Yaakov' vs donor's full first name 'Yaakov Yisroel' must never auto-match -- no fuzzy matching");
    assert.equal(preview.canCommit, false);
    assert.equal(preview.existingBirthday.id, "existing-klein");
    assert.equal(preview.existingBirthday.personName, "Yaakov");

    // Confirming donor-own identity: date already matches exactly, so this
    // must resolve to already_recorded (no write), and must NEVER rewrite
    // "Yaakov" into "Yaakov Yisroel".
    const confirmed = classifyDobRow(dobRow, donorLookup, existingLookup, "existing-klein");
    assert.equal(confirmed.status, "already_recorded");
    assert.equal(confirmed.canCommit, false);
    assert.equal(confirmed.existingBirthday.personName, "Yaakov", "confirming this is the donor's own birthday must never rewrite the existing personName");
  }

  // --- Case 2: Aharon J. Spetner, donor 1f645294-3557-4902-af8f-d3b60e40ce6d,
  // code 59936, spreadsheet DOB 6/7/1981. Existing Birthday record:
  // personName="Aharon", relationship=null. ---
  {
    const donor = { donorId: "1f645294-3557-4902-af8f-d3b60e40ce6d", donorName: "Aharon J. Spetner", donorFirstName: "Aharon J." };
    const donorLookup = new Map([["59936", [donor]]]);
    const existingLookup = new Map([[donor.donorId, [{ id: "existing-spetner", personName: "Aharon", relationship: null, month: 6, day: 7, year: 1981 }]]]);
    const dobRow = { rowNumber: 139, donorCode: "59936", dobRaw: "6/7/1981", month: 6, day: 7, year: 1981, dateError: null };

    const preview = classifyDobRow(dobRow, donorLookup, existingLookup);
    assert.equal(preview.status, "needs_review", "shortened first name 'Aharon' vs donor's on-file first name 'Aharon J.' must never auto-match");
    assert.equal(preview.canCommit, false);
    assert.equal(preview.existingBirthday.id, "existing-spetner");

    const confirmed = classifyDobRow(dobRow, donorLookup, existingLookup, "existing-spetner");
    assert.equal(confirmed.status, "already_recorded");
    assert.equal(confirmed.canCommit, false);
    assert.equal(confirmed.existingBirthday.personName, "Aharon", "confirming this is the donor's own birthday must never rewrite the existing personName");
  }

  // --- Regression guard: the real enrich_missing_year case from the same
  // audit (donor 9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e, "Dovie
  // Weinschneider", code 68390, spreadsheet DOB 4/15/1991, existing
  // personName="Dovi", relationship="Donor", year=null) must classify as
  // enrich_missing_year, not needs_review -- relationship="Donor" IS an
  // approved automatic indicator on its own, independent of the name. ---
  {
    const donor = { donorId: "9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e", donorName: "Dovie Weinschneider", donorFirstName: "Dovie" };
    const donorLookup = new Map([["68390", [donor]]]);
    const existingLookup = new Map([[donor.donorId, [{ id: "existing-weinschneider", personName: "Dovi", relationship: "Donor", month: 4, day: 15, year: null }]]]);
    const dobRow = { rowNumber: 158, donorCode: "68390", dobRaw: "4/15/1991", month: 4, day: 15, year: 1991, dateError: null };

    const preview = classifyDobRow(dobRow, donorLookup, existingLookup);
    assert.equal(preview.status, "enrich_missing_year");
    assert.equal(preview.canCommit, true);
    assert.equal(preview.existingBirthday.personName, "Dovi");
  }

  console.log("DOB real-donor regression checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
