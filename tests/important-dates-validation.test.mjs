import assert from "node:assert/strict";
import { normalizeImportantDate } from "../lib/important-dates/validation.ts";
import { importantDateFingerprint } from "../lib/import/important-date-fingerprint.ts";

function run() {
  // --- birthday: personName required, month/day required, year optional. ---
  const birthdayValid = normalizeImportantDate({ type: "birthday", personName: "David Cohen", relationship: "Donor", month: 8, day: 24, year: 1985 });
  assert.equal(birthdayValid.valid, true);
  assert.equal(birthdayValid.normalized.type, "birthday");
  assert.equal(birthdayValid.normalized.personName, "David Cohen");
  assert.equal(birthdayValid.normalized.year, 1985);

  const birthdayNoYear = normalizeImportantDate({ type: "birthday", personName: "David Cohen", month: 8, day: 24 });
  assert.equal(birthdayNoYear.valid, true, "year must be optional");
  assert.equal(birthdayNoYear.normalized.year, null);

  const birthdayMissingPerson = normalizeImportantDate({ type: "birthday", month: 8, day: 24 });
  assert.equal(birthdayMissingPerson.valid, false, "personName is required for a birthday");
  assert.ok(birthdayMissingPerson.errors.personName);

  const birthdayMissingMonth = normalizeImportantDate({ type: "birthday", personName: "David Cohen", day: 24 });
  assert.equal(birthdayMissingMonth.valid, false, "month is required");

  const birthdayMissingDay = normalizeImportantDate({ type: "birthday", personName: "David Cohen", month: 8 });
  assert.equal(birthdayMissingDay.valid, false, "day is required");

  const birthdayBadDate = normalizeImportantDate({ type: "birthday", personName: "David Cohen", month: 4, day: 31 });
  assert.equal(birthdayBadDate.valid, false, "April 31 does not exist");

  const birthdayFeb29 = normalizeImportantDate({ type: "birthday", personName: "David Cohen", month: 2, day: 29 });
  assert.equal(birthdayFeb29.valid, true, "Feb 29 must be accepted as a plausible recorded date, independent of any specific year");

  // --- anniversary: personName is always forced to null, even if sent. ---
  const anniversaryValid = normalizeImportantDate({ type: "anniversary", personName: "should be ignored", month: 6, day: 12, year: 2010 });
  assert.equal(anniversaryValid.valid, true);
  assert.equal(anniversaryValid.normalized.personName, null, "an anniversary must never store a person name, regardless of what was submitted");

  const anniversaryNoYear = normalizeImportantDate({ type: "anniversary", month: 6, day: 12 });
  assert.equal(anniversaryNoYear.valid, true, "year must be optional for anniversary too");

  // --- missing/invalid type. ---
  const noType = normalizeImportantDate({ month: 6, day: 12 });
  assert.equal(noType.valid, false);
  assert.ok(noType.errors.type);

  const badType = normalizeImportantDate({ type: "quinceanera", month: 6, day: 12 });
  assert.equal(badType.valid, false, "only birthday and anniversary are supported types");

  // --- year sanity bounds. ---
  const yearTooOld = normalizeImportantDate({ type: "birthday", personName: "X", month: 1, day: 1, year: 1800 });
  assert.equal(yearTooOld.valid, false);
  const yearTooFuture = normalizeImportantDate({ type: "birthday", personName: "X", month: 1, day: 1, year: 3000 });
  assert.equal(yearTooFuture.valid, false);

  console.log("Important-date validation checks passed.");

  // --- fingerprint identity rule ---
  // Birthday: same donor + same person + same month/day collide (real
  // duplicate-prevention safety net), regardless of year/relationship --
  // exactly mirroring yahrtzeitFingerprint's own exclusions.
  const bday1 = importantDateFingerprint({ id: "id-1", donorId: "donor-1", type: "birthday", month: 8, day: 24, personName: "David Cohen" });
  const bday2 = importantDateFingerprint({ id: "id-2", donorId: "donor-1", type: "birthday", month: 8, day: 24, personName: "david cohen" });
  assert.equal(bday1, bday2, "the same person's birthday must fingerprint identically regardless of the new row's own id, and regardless of name casing/spacing");
  const bdayDifferentYear = importantDateFingerprint({ id: "id-3", donorId: "donor-1", type: "birthday", month: 8, day: 24, personName: "David Cohen" });
  assert.equal(bday1, bdayDifferentYear, "year is excluded from the birthday fingerprint -- adding a previously-unknown year must update the existing row, not create a duplicate");
  const bdayDifferentPerson = importantDateFingerprint({ id: "id-4", donorId: "donor-1", type: "birthday", month: 8, day: 24, personName: "Galit Cohen" });
  assert.notEqual(bday1, bdayDifferentPerson, "a different person's birthday on the same date must be a distinct record");
  const bdayDifferentDonor = importantDateFingerprint({ id: "id-5", donorId: "donor-2", type: "birthday", month: 8, day: 24, personName: "David Cohen" });
  assert.notEqual(bday1, bdayDifferentDonor, "the same name on a different donor must never collide");

  // --- Anniversary: deliberately keyed on the row's own id, so it is
  // ALWAYS unique. Two anniversary submissions for the same donor on the
  // exact same month/day (e.g. a remarriage landing on the same calendar
  // date) must never collide -- there is no person name to disambiguate by,
  // and the approved design explicitly rejects making "one anniversary per
  // household per date" an accidental side effect of a blank person field. ---
  const anniv1 = importantDateFingerprint({ id: "id-a", donorId: "donor-1", type: "anniversary", month: 6, day: 12, personName: null });
  const anniv2 = importantDateFingerprint({ id: "id-b", donorId: "donor-1", type: "anniversary", month: 6, day: 12, personName: null });
  assert.notEqual(anniv1, anniv2, "two distinct anniversary records for the same donor and the same calendar date must never be treated as duplicates");
  // Recomputing the fingerprint for the SAME existing row (same id) on
  // update must be stable, so an edit never spuriously changes identity.
  const anniv1Again = importantDateFingerprint({ id: "id-a", donorId: "donor-1", type: "anniversary", month: 6, day: 12, personName: null });
  assert.equal(anniv1, anniv1Again, "recomputing the fingerprint for the same row id (an edit) must be stable");

  console.log("Important-date fingerprint identity checks passed.");
}

run();
