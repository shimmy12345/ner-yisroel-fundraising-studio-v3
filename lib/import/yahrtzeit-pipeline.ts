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
// fingerprint -> the existing yahrtzeits.id already holding that fact, so a
// re-uploaded workbook can tell "already imported" apart from "new."
export type YahrtzeitExistingLookup = Map<string, string>;

// "already_imported" always wins regardless of any other issue -- an
// already-committed row is never re-flagged for review just because it
// happens to have a malformed name or an ambiguous date; those were
// already reviewed (or knowingly accepted) the first time. "unmatched" is
// its own category, distinct from "needs_review": no donor code match
// means there is nothing to review here, only a donor record to resolve
// separately. "needs_review" covers a matched, not-yet-imported row with
// at least one real issue -- it may still be perfectly committable
// (a source-valid-but-recurrence-ambiguous date is never a blocking
// issue), the label just means a human should look at it once.
export type YahrtzeitRowStatus = "already_imported" | "unmatched" | "needs_review" | "ready";
// Machine-readable tags for the two specific issue types the review UI
// gives a dedicated action for. Other issues (missing name, unrecognized
// month, an implausible date) still land the row in "needs_review" via
// `issues`, just without one of these two tags -- there is no bespoke fix
// action for them because they are read-only problems with the source row,
// not editable-in-place data.
export type YahrtzeitReviewReason = "malformed_hebrew_name" | "ambiguous_recurrence";

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
  status: YahrtzeitRowStatus;
  reviewReasons: YahrtzeitReviewReason[];
  // Set only when status === "already_imported".
  existingId: string | null;
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
  ambiguousOccurrence: boolean;
}): { issues: string[]; canCommit: boolean; reviewReasons: YahrtzeitReviewReason[] } {
  const issues: string[] = [];
  const reviewReasons: YahrtzeitReviewReason[] = [];
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
    reviewReasons.push("malformed_hebrew_name");
  }
  // The source Hebrew date itself is completely valid here -- the
  // ambiguity is only about which future Hebrew leap year this recurs in
  // (Adar I or Adar II), never about whether 8 Adar happened. This must
  // never block canCommit -- see lib/calendar/hebrew-date.ts's own
  // "flag, never resolve" design.
  if (row.ambiguousOccurrence) {
    issues.push("The Hebrew date is valid as recorded. A future occurrence falls in a leap year with two Adars -- flagged for review, not blocked.");
    reviewReasons.push("ambiguous_recurrence");
  }

  const hasValidDate = row.hebrewMonth !== null && row.hebrewDay !== null
    && isPlausibleHebrewDate(row.hebrewMonth, row.hebrewDay)
    && (row.hebrewYear === null || isValidHebrewDateForYear(row.hebrewMonth, row.hebrewDay, row.hebrewYear));
  const canCommit = row.matchedDonorId !== null && !!row.deceasedNameEnglish && hasValidDate;
  return { issues, canCommit, reviewReasons };
}

export function buildYahrtzeitPreview(rows: YahrtzeitWorkbookRow[], donorLookup: YahrtzeitDonorLookup, timezone: string, nowEpochSeconds: number, existingFingerprints: YahrtzeitExistingLookup = new Map()): YahrtzeitPreviewRow[] {
  return rows.map((row) => {
    const match = row.donorCode ? donorLookup.get(row.donorCode) ?? null : null;
    const hebrewMonth = row.hebrewMonthRaw ? hebrewScriptToMonthName(row.hebrewMonthRaw) : null;
    const hebrewDay = row.hebrewDayRaw ? decodeGematriyaNumber(row.hebrewDayRaw) : null;
    const hebrewYear = row.hebrewYearRaw ? decodeGematriyaYear(row.hebrewYearRaw) : null;

    const occurrence = hebrewMonth !== null && hebrewDay !== null && isPlausibleHebrewDate(hebrewMonth, hebrewDay)
      ? nextYahrtzeitOccurrence(hebrewMonth, hebrewDay, timezone, nowEpochSeconds)
      : null;

    const { issues, canCommit, reviewReasons } = buildIssuesAndCommit({
      matchedDonorId: match?.donorId ?? null,
      donorCode: row.donorCode,
      deceasedNameEnglish: row.deceasedNameEnglish,
      deceasedNameHebrew: row.deceasedNameHebrew,
      hebrewMonth,
      hebrewMonthRaw: row.hebrewMonthRaw,
      hebrewDay,
      hebrewDayRaw: row.hebrewDayRaw,
      hebrewYear,
      ambiguousOccurrence: occurrence?.ambiguous ?? false,
    });

    const fingerprint = match && hebrewMonth && hebrewDay !== null && row.deceasedNameEnglish
      ? yahrtzeitFingerprint({ donorId: match.donorId, hebrewMonth, hebrewDay, deceasedNameEnglish: row.deceasedNameEnglish })
      : null;
    const existingId = fingerprint ? existingFingerprints.get(fingerprint) ?? null : null;

    const status: YahrtzeitRowStatus = existingId !== null ? "already_imported"
      : !match ? "unmatched"
      : issues.length > 0 ? "needs_review"
      : "ready";

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
      fingerprint,
      status,
      reviewReasons,
      existingId,
    };
  });
}
