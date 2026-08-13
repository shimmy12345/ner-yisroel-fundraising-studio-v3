import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isPlausibleHebrewDate, isValidHebrewDateForYear, nextYahrtzeitOccurrence, hebrewScriptToMonthName, HEBREW_MONTHS } from "../lib/calendar/hebrew-date.ts";
import { parseYahrtzeitWorkbook, decodeGematriyaNumber, decodeGematriyaYear } from "../lib/import/yahrtzeit-workbook.ts";
import { buildYahrtzeitPreview } from "../lib/import/yahrtzeit-pipeline.ts";
import { yahrtzeitFingerprint } from "../lib/import/yahrtzeit-fingerprint.ts";

// Noon UTC -- see tests/recommendation-engine.test.mjs for why midnight UTC
// is unsafe here (it can fall on the previous calendar day in
// America/New_York, shifting which Hebrew day "today" resolves to).
const NOW = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
const TIMEZONE = "America/New_York";

async function run() {
  // --- known reference point: verified against the user's own worked
  // example (2 Tishrei -> Sep 13, 2026) before this design was approved. ---
  const zeffren = nextYahrtzeitOccurrence("Tishrei", 2, TIMEZONE, NOW);
  assert.equal(new Date(zeffren.primary.gregorianEpoch * 1000).toISOString().slice(0, 10), "2026-09-13");
  assert.equal(zeffren.ambiguous, false);

  // --- unambiguous dates: no HebYear required to compute recurrence. ---
  const noYearNeeded = nextYahrtzeitOccurrence("Shevat", 16, TIMEZONE, NOW);
  assert.equal(noYearNeeded.ambiguous, false);
  assert.ok(noYearNeeded.primary.gregorianEpoch > NOW);

  // --- date-only: never a time component on the computed occurrence. ---
  assert.equal(new Date(zeffren.primary.gregorianEpoch * 1000).getUTCHours(), 0);

  // --- Adar-in-a-leap-year ambiguity: computed AND flagged, never silently
  // resolved to one answer. Both plausible candidates are returned. ---
  const adarInLeapYear = nextYahrtzeitOccurrence("Adar", 8, TIMEZONE, NOW);
  assert.equal(adarInLeapYear.ambiguous, true, "a plain-Adar death recurring in a leap year must be flagged");
  assert.ok(adarInLeapYear.ambiguityNote, "an ambiguous occurrence must carry a human-readable note");
  assert.ok(adarInLeapYear.alternate, "both Adar I and Adar II candidates must be surfaced");
  assert.notEqual(adarInLeapYear.primary.resolvedMonth, adarInLeapYear.alternate.resolvedMonth);

  // --- day-30-in-a-variable-length-month ambiguity: flagged, with a
  // nearest-existing-date fallback, never silently dropped. ---
  // Find a year where Cheshvan is short (29 days) by scanning forward from
  // "today" -- rather than hardcoding a specific Hebrew year, which could
  // silently stop testing the real code path if the library's data ever
  // shifted which years are short/long.
  let foundDeficientCheshvan = false;
  for (let offsetDays = 0; offsetDays < 365 * 20 && !foundDeficientCheshvan; offsetDays += 200) {
    const occ = nextYahrtzeitOccurrence("Cheshvan", 30, TIMEZONE, NOW + offsetDays * 86400);
    if (occ.ambiguous) {
      foundDeficientCheshvan = true;
      assert.ok(occ.ambiguityNote);
      assert.equal(occ.primary.hebrewLabel.startsWith("29"), true, "the fallback candidate must be the nearest existing day, not day 30 itself");
    }
  }
  assert.ok(foundDeficientCheshvan, "test setup: expected to find at least one deficient-Cheshvan year within 20 years");

  // --- validation: implausible dates rejected outright, not "ambiguous". ---
  assert.equal(isPlausibleHebrewDate("Teves", 30), false, "Teves never has 30 days in any year");
  assert.equal(isPlausibleHebrewDate("Cheshvan", 30), true, "Cheshvan can have 30 days depending on the year");
  assert.equal(isPlausibleHebrewDate("NotAMonth", 5), false);
  assert.equal(isValidHebrewDateForYear("Adar", 30, 5785), false, "Adar (non-leap) never has 30 days");

  // --- Hebrew-script month parsing (workbook's own HebMonth column). ---
  assert.equal(hebrewScriptToMonthName("תשרי"), "Tishrei");
  assert.equal(hebrewScriptToMonthName("אדר"), "Adar");
  assert.equal(hebrewScriptToMonthName("not hebrew"), null);
  for (const month of HEBREW_MONTHS) assert.ok(typeof month === "string");

  // --- gematriya decoding, verified against every real value in the
  // actual Yahrtzeit.xlsx workbook (audited before implementation). ---
  assert.equal(decodeGematriyaNumber("טז"), 16);
  assert.equal(decodeGematriyaNumber("ב"), 2);
  assert.equal(decodeGematriyaYear("תשעד"), 5774);
  assert.equal(decodeGematriyaYear("תשפה"), 5785);

  // --- fingerprint: deterministic, and deliberately excludes hebrewYear/
  // relationship so a later correction to either updates the existing row
  // instead of creating a duplicate (same reasoning as
  // mondaySourceFingerprint excluding fields the fundraiser might revise). ---
  const fpA = yahrtzeitFingerprint({ donorId: "donor-1", hebrewMonth: "Tishrei", hebrewDay: 2, deceasedNameEnglish: "Mattil Tzirel" });
  const fpB = yahrtzeitFingerprint({ donorId: "donor-1", hebrewMonth: "Tishrei", hebrewDay: 2, deceasedNameEnglish: "Mattil Tzirel" });
  assert.equal(fpA, fpB, "the fingerprint must be deterministic");
  const fpDifferentDonor = yahrtzeitFingerprint({ donorId: "donor-2", hebrewMonth: "Tishrei", hebrewDay: 2, deceasedNameEnglish: "Mattil Tzirel" });
  assert.notEqual(fpA, fpDifferentDonor);
  const fpCaseInsensitiveName = yahrtzeitFingerprint({ donorId: "donor-1", hebrewMonth: "Tishrei", hebrewDay: 2, deceasedNameEnglish: "MATTIL TZIREL" });
  assert.equal(fpA, fpCaseInsensitiveName, "name normalization must be case-insensitive so trivial capitalization differences don't create duplicates");

  // --- real workbook, end to end: parse -> match -> preview. Uses the
  // actual real donor codes and Hebrew values audited before this feature
  // was designed, as a regression fixture shaped exactly like the real file. ---
  const workbookPath = new URL("./fixtures/yahrtzeit-workbook.json", import.meta.url);
  const fixtureRows = JSON.parse(await readFile(workbookPath, "utf8"));
  const donorLookup = new Map([
    ["43425", { donorId: "d-zeffren", donorName: "Dr. & Mrs. Dov Zeffren" }],
    ["49134", { donorId: "d-potesky", donorName: "Mr. & Mrs. Yaakov M Potesky" }],
  ]);
  const preview = buildYahrtzeitPreview(fixtureRows, donorLookup, TIMEZONE, NOW);
  assert.equal(preview.length, fixtureRows.length);
  const matched = preview.filter((row) => row.matchedDonorId);
  assert.ok(matched.length >= 2, "the real donor codes in the fixture must match");
  const unmatched = preview.find((row) => row.donorCode === "999999");
  assert.ok(unmatched && !unmatched.matchedDonorId, "an unrecognized code must never be silently matched by name");
  // The row with a malformed Hebrew name (English text embedded, mirroring
  // the real workbook's row 16) must be flagged for review but not
  // silently dropped from commit -- the fundraiser decides.
  const malformedRow = preview.find((row) => row.deceasedNameHebrew && /[A-Za-z]/.test(row.deceasedNameHebrew));
  assert.ok(malformedRow, "test setup: fixture must include a malformed-Hebrew-name row");
  assert.ok(malformedRow.issues.some((issue) => /English text/i.test(issue)));
  assert.equal(malformedRow.canCommit, true, "a malformed Hebrew name must be flagged, not block commit");
  // The row missing a Hebrew year (mirroring real rows 4/13) must still
  // compute a valid recurrence -- HebYear is never required.
  const noYearRow = preview.find((row) => row.hebrewYear === null && row.matchedDonorId);
  assert.ok(noYearRow && noYearRow.occurrence, "a missing Hebrew year must not block recurrence calculation");

  console.log("Yahrtzeit recurrence and import checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
