import type { YahrtzeitWorkbookRow } from "./yahrtzeit-workbook.ts";
import { decodeGematriyaNumber, decodeGematriyaYear, hebrewScriptToMonthName } from "./yahrtzeit-workbook.ts";
import { isPlausibleHebrewDate, isValidHebrewDateForYear, nextYahrtzeitOccurrence, type HebrewMonthName, type YahrtzeitOccurrence } from "../calendar/hebrew-date.ts";
import { yahrtzeitFingerprint } from "./yahrtzeit-fingerprint.ts";

// Pure orchestration: matches each workbook row to a donor by exact Code
// only (never fuzzy name matching -- an unmatched code stays unmatched,
// full stop), computes the current Gregorian occurrence, and flags rows
// that need human review before anything is written. No D1 access -- the
// caller supplies the donor lookup (built from one exact-match SELECT) and
// the "now"/timezone context.

export type YahrtzeitDonorLookup = Map<string, { donorId: string; donorName: string }>;

export type YahrtzeitPreviewRow = {
  rowNumber: number;
  donorCode: string | null;
  matchedDonorId: string | null;
  matchedDonorName: string | null;
  deceasedNameEnglish: string | null;
  deceasedNameHebrew: string | null;
  relationship: string | null;
  hebrewMonth: HebrewMonthName | null;
  hebrewDay: number | null;
  hebrewYear: number | null;
  occurrence: YahrtzeitOccurrence | null;
  issues: string[];
  canCommit: boolean;
  fingerprint: string | null;
};

const LATIN_LETTERS = /[A-Za-z]/;

function buildIssuesAndCommit(row: {
  matchedDonorId: string | null;
  donorCode: string | null;
  deceasedNameEnglish: string | null;
  deceasedNameHebrew: string | null;
  hebrewMonth: HebrewMonthName | null;
  hebrewMonthRaw: string | null;
  hebrewDay: number | null;
  hebrewDayRaw: string | null;
  hebrewYear: number | null;
}): { issues: string[]; canCommit: boolean } {
  const issues: string[] = [];
  if (!row.donorCode) issues.push("No donor code on this row.");
  else if (!row.matchedDonorId) issues.push(`No donor found with code "${row.donorCode}". This row will be skipped -- never matched by name.`);
  if (!row.deceasedNameEnglish) issues.push("Missing the deceased's English name.");
  if (row.hebrewMonthRaw && !row.hebrewMonth) issues.push(`Unrecognized Hebrew month "${row.hebrewMonthRaw}".`);
  if (row.hebrewDayRaw && row.hebrewDay === null) issues.push(`Could not read Hebrew day "${row.hebrewDayRaw}".`);
  if (!row.hebrewMonthRaw) issues.push("Missing Hebrew month.");
  if (!row.hebrewDayRaw) issues.push("Missing Hebrew day.");
  if (row.hebrewMonth && row.hebrewDay !== null && !isPlausibleHebrewDate(row.hebrewMonth, row.hebrewDay)) {
    issues.push(`${row.hebrewDay} ${row.hebrewMonth} is not a possible Hebrew date.`);
  } else if (row.hebrewMonth && row.hebrewDay !== null && row.hebrewYear !== null && !isValidHebrewDateForYear(row.hebrewMonth, row.hebrewDay, row.hebrewYear)) {
    issues.push(`${row.hebrewDay} ${row.hebrewMonth} did not occur in Hebrew year ${row.hebrewYear}.`);
  }
  if (row.deceasedNameHebrew && LATIN_LETTERS.test(row.deceasedNameHebrew)) {
    issues.push("The Hebrew name field appears to contain English text -- review before relying on it.");
  }

  const hasValidDate = row.hebrewMonth !== null && row.hebrewDay !== null
    && isPlausibleHebrewDate(row.hebrewMonth, row.hebrewDay)
    && (row.hebrewYear === null || isValidHebrewDateForYear(row.hebrewMonth, row.hebrewDay, row.hebrewYear));
  const canCommit = row.matchedDonorId !== null && !!row.deceasedNameEnglish && hasValidDate;
  return { issues, canCommit };
}

export function buildYahrtzeitPreview(rows: YahrtzeitWorkbookRow[], donorLookup: YahrtzeitDonorLookup, timezone: string, nowEpochSeconds: number): YahrtzeitPreviewRow[] {
  return rows.map((row) => {
    const match = row.donorCode ? donorLookup.get(row.donorCode) ?? null : null;
    const hebrewMonth = row.hebrewMonthRaw ? hebrewScriptToMonthName(row.hebrewMonthRaw) : null;
    const hebrewDay = row.hebrewDayRaw ? decodeGematriyaNumber(row.hebrewDayRaw) : null;
    const hebrewYear = row.hebrewYearRaw ? decodeGematriyaYear(row.hebrewYearRaw) : null;

    const { issues, canCommit } = buildIssuesAndCommit({
      matchedDonorId: match?.donorId ?? null,
      donorCode: row.donorCode,
      deceasedNameEnglish: row.deceasedNameEnglish,
      deceasedNameHebrew: row.deceasedNameHebrew,
      hebrewMonth,
      hebrewMonthRaw: row.hebrewMonthRaw,
      hebrewDay,
      hebrewDayRaw: row.hebrewDayRaw,
      hebrewYear,
    });

    const occurrence = hebrewMonth !== null && hebrewDay !== null && isPlausibleHebrewDate(hebrewMonth, hebrewDay)
      ? nextYahrtzeitOccurrence(hebrewMonth, hebrewDay, timezone, nowEpochSeconds)
      : null;

    return {
      rowNumber: row.rowNumber,
      donorCode: row.donorCode,
      matchedDonorId: match?.donorId ?? null,
      matchedDonorName: match?.donorName ?? null,
      deceasedNameEnglish: row.deceasedNameEnglish,
      deceasedNameHebrew: row.deceasedNameHebrew,
      relationship: row.relationship,
      hebrewMonth,
      hebrewDay,
      hebrewYear,
      occurrence,
      issues,
      canCommit,
      fingerprint: match && hebrewMonth && hebrewDay !== null && row.deceasedNameEnglish
        ? yahrtzeitFingerprint({ donorId: match.donorId, hebrewMonth, hebrewDay, deceasedNameEnglish: row.deceasedNameEnglish })
        : null,
    };
  });
}
