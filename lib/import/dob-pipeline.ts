import type { DobWorkbookRow } from "./dob-workbook.ts";
import { importantDateFingerprint } from "./important-date-fingerprint.ts";

// Pure orchestration: matches each workbook row to a donor by exact Code
// only (never fuzzy name matching -- an unmatched code stays unmatched,
// full stop), determines whether an existing important_dates birthday row
// is confidently the donor's own, and classifies each row into exactly
// one of the statuses below. No D1 access -- the caller supplies the
// donor lookup and the existing-birthday lookup (each built from one
// exact-match SELECT).

export type DobDonorCandidate = { donorId: string; donorName: string; donorFirstName: string | null };
// donorCode -> every live donor sharing that code (almost always 0 or 1;
// >1 is the "ambiguous" case -- fail/review, never guess).
export type DobDonorLookup = Map<string, DobDonorCandidate[]>;

export type ExistingBirthdayRow = { id: string; personName: string | null; relationship: string | null; month: number; day: number; year: number | null };
// donorId -> every existing important_dates row with type='birthday' for
// that donor (spouse/child birthdays included -- filtering to "the
// donor's own" happens in classifyDobRow, never in the lookup itself, so
// a spouse/child record is always visible for the "not confidently the
// donor's own" case rather than silently absent).
export type DobExistingLookup = Map<string, ExistingBirthdayRow[]>;

export type DobRowStatus =
  | "ready_to_add"
  | "already_recorded"
  | "enrich_missing_year"
  | "conflict"
  | "needs_review"
  | "unmatched"
  | "ambiguous"
  | "invalid";

export type DobPreviewRow = {
  rowNumber: number;
  donorCode: string | null;
  matchedDonorId: string | null;
  matchedDonorName: string | null;
  // The deterministic identity field this row's birthday would be (or
  // already is) recorded under -- donors.primary_first_name, the same
  // field confirmed against real manually-entered Birthday records.
  donorFirstName: string | null;
  month: number | null;
  day: number | null;
  year: number | null;
  status: DobRowStatus;
  issues: string[];
  // The existing important_dates row this row relates to, if any --
  // populated for already_recorded/enrich_missing_year/conflict/
  // needs_review (when an existing row is why review is needed).
  existingBirthday: ExistingBirthdayRow | null;
  fingerprint: string | null;
  // True only for ready_to_add and enrich_missing_year -- the only two
  // statuses eligible for the bulk "Commit all clean rows" action.
  canCommit: boolean;
};

const normalize = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

// Approved automatic donor-own indicators, exactly as designed -- no
// fuzzy matching, no surname similarity, no household display name, no
// spouse/child inference:
//   - relationship normalizes to exactly "donor", OR
//   - relationship is blank AND person_name exact-normalized-matches the
//     donor's own first name.
// Any other relationship value (spouse/child/etc., or a blank
// relationship with a non-matching name) is never automatically treated
// as the donor's own.
export function looksLikeDonorsOwnBirthday(existing: { personName: string | null; relationship: string | null }, donorFirstName: string | null): boolean {
  const relationship = normalize(existing.relationship);
  if (relationship === "donor") return true;
  if (relationship) return false;
  if (!donorFirstName) return false;
  return normalize(existing.personName) === normalize(donorFirstName);
}

function emptyRow(row: DobWorkbookRow, status: DobRowStatus, issues: string[], overrides: Partial<DobPreviewRow> = {}): DobPreviewRow {
  return {
    rowNumber: row.rowNumber,
    donorCode: row.donorCode,
    matchedDonorId: null,
    matchedDonorName: null,
    donorFirstName: null,
    month: row.month,
    day: row.day,
    year: row.year,
    status,
    issues,
    existingBirthday: null,
    fingerprint: null,
    canCommit: false,
    ...overrides,
  };
}

// confirmedExistingId: set only by the explicit "Confirm this is the
// donor's birthday" review action (see the review-confirmation tests) --
// associates one specific existing important_dates row with this row's
// donor-own decision, overriding the automatic detection above for this
// row only. Never inferred, never defaulted -- always an explicit,
// per-row, human decision the caller must supply, and the commit route
// independently re-validates it (see app/api/import/dob/commit/route.ts)
// rather than trusting it at face value.
export function classifyDobRow(row: DobWorkbookRow, donorLookup: DobDonorLookup, existingLookup: DobExistingLookup, confirmedExistingId?: string | null): DobPreviewRow {
  const issues: string[] = [];
  if (!row.donorCode) issues.push("No donor code on this row.");
  if (row.month === null || row.day === null || row.year === null) issues.push(row.dateError ?? "Invalid or missing date of birth.");
  if (issues.length > 0) return emptyRow(row, "invalid", issues);

  const candidates = donorLookup.get(row.donorCode!) ?? [];
  if (candidates.length === 0) return emptyRow(row, "unmatched", [`No donor found with code "${row.donorCode}". This row will be skipped -- never matched by name.`]);
  if (candidates.length > 1) return emptyRow(row, "ambiguous", [`Code "${row.donorCode}" matches more than one live donor. Resolve the duplicate donor code before importing this row.`], { matchedDonorId: null });

  const donor = candidates[0];
  const base: Partial<DobPreviewRow> = { matchedDonorId: donor.donorId, matchedDonorName: donor.donorName, donorFirstName: donor.donorFirstName };

  if (!donor.donorFirstName) {
    return emptyRow(row, "needs_review", ["This donor has no first name on file, so a deterministic Birthday person_name cannot be derived. Add the donor's first name, then re-import."], base);
  }

  const existingRows = existingLookup.get(donor.donorId) ?? [];
  const confirmed = confirmedExistingId ? existingRows.find((r) => r.id === confirmedExistingId) ?? null : null;
  const autoOwnRows = existingRows.filter((r) => looksLikeDonorsOwnBirthday(r, donor.donorFirstName));
  // An explicit confirmation always wins over automatic detection for
  // this one row, but only for a row that is genuinely one of this
  // donor's own existing birthday rows -- never an arbitrary id.
  const ownRows = confirmed ? [confirmed] : autoOwnRows;

  const fingerprint = importantDateFingerprint({ id: "", donorId: donor.donorId, type: "birthday", month: row.month!, day: row.day!, personName: donor.donorFirstName });

  if (ownRows.length > 1) {
    return emptyRow(row, "needs_review", ["More than one existing birthday record looks like the donor's own -- resolve manually before importing."], { ...base, existingBirthday: ownRows[0], fingerprint });
  }

  if (ownRows.length === 0) {
    if (existingRows.length > 0) {
      return emptyRow(row, "needs_review", ["An existing birthday record is present for this donor but is not confidently identifiable as the donor's own (it may belong to a spouse or child)."], { ...base, existingBirthday: existingRows[0], fingerprint });
    }
    return emptyRow(row, "ready_to_add", [], { ...base, fingerprint, canCommit: true });
  }

  const existing = ownRows[0];
  if (existing.month !== row.month || existing.day !== row.day) {
    return emptyRow(row, "conflict", [`The existing Birthday record is ${existing.month}/${existing.day}; the spreadsheet says ${row.month}/${row.day}.`], { ...base, existingBirthday: existing, fingerprint });
  }
  if (existing.year === null) {
    return emptyRow(row, "enrich_missing_year", [], { ...base, existingBirthday: existing, fingerprint, canCommit: true });
  }
  if (existing.year === row.year) {
    return emptyRow(row, "already_recorded", [], { ...base, existingBirthday: existing, fingerprint });
  }
  return emptyRow(row, "conflict", [`The existing Birthday record is dated ${existing.year}; the spreadsheet says ${row.year}.`], { ...base, existingBirthday: existing, fingerprint });
}

export function buildDobPreview(rows: DobWorkbookRow[], donorLookup: DobDonorLookup, existingLookup: DobExistingLookup, confirmedExistingIdByRow: Map<number, string> = new Map()): DobPreviewRow[] {
  return rows.map((row) => classifyDobRow(row, donorLookup, existingLookup, confirmedExistingIdByRow.get(row.rowNumber) ?? null));
}

export type DobConfirmValidation =
  | { ok: true; donorId: string; existingId: string }
  | { ok: false; reason: string };

// Validates the ONE narrow case the "Confirm this is the donor's birthday"
// persistence path (app/api/import/dob/confirm/route.ts) is allowed to act
// on: an existing birthday row that is currently needs_review purely
// because donor-own identity can't be established automatically, whose
// month/day/year already exactly match the spreadsheet row. Deliberately
// reuses classifyDobRow itself (never a parallel reimplementation) so this
// can never drift from the preview's own classification rules -- run twice,
// once without and once with the confirmation, exactly mirroring what the
// review UI already showed the fundraiser before they clicked Confirm.
//
// Does NOT handle the enrich_missing_year sub-case (existing year is null)
// -- confirming identity there still routes through the normal bulk
// "Commit all clean rows" path, which already writes year AND relationship
// (if blank) atomically in one step; splitting that into a separate
// identity-only write here would be redundant and add a second audit row
// for no benefit.
export function validateDonorOwnBirthdayConfirmation(row: DobWorkbookRow, existingId: string, donorLookup: DobDonorLookup, existingLookup: DobExistingLookup): DobConfirmValidation {
  const withoutConfirmation = classifyDobRow(row, donorLookup, existingLookup, null);
  if (withoutConfirmation.status !== "needs_review") {
    return { ok: false, reason: `This row's current classification is "${withoutConfirmation.status}", not needs_review -- there is nothing to confirm.` };
  }
  if (!withoutConfirmation.existingBirthday || withoutConfirmation.existingBirthday.id !== existingId) {
    return { ok: false, reason: "The confirmed record is not the specific existing birthday row currently surfaced for review on this donor." };
  }
  // Independent of classification: a relationship that already carries an
  // explicit, non-blank value (Spouse, Child, etc.) can never be
  // overwritten to "Donor" through this path, even if some other quirk of
  // the data made classifyDobRow report needs_review for it. Only a
  // genuinely blank relationship may be confirmed.
  if (withoutConfirmation.existingBirthday.relationship && withoutConfirmation.existingBirthday.relationship.trim()) {
    return { ok: false, reason: `This record's relationship is already set to "${withoutConfirmation.existingBirthday.relationship}" -- only a blank relationship can be confirmed as the donor's own birthday.` };
  }

  const withConfirmation = classifyDobRow(row, donorLookup, existingLookup, existingId);
  if (withConfirmation.status !== "already_recorded") {
    return { ok: false, reason: `Confirming this row resolves to "${withConfirmation.status}", not an exact date match -- this confirmation path only persists identity when the existing record's month/day/year already exactly match the spreadsheet.` };
  }

  return { ok: true, donorId: withConfirmation.matchedDonorId!, existingId };
}

// Grouped counts for the preview UI -- computed once here so the route,
// the review UI, and tests/staging verification all count the exact same
// way, never three independent tallies that could silently drift apart.
export type DobPreviewSummary = Record<DobRowStatus, number>;
export function summarizeDobPreview(rows: DobPreviewRow[]): DobPreviewSummary {
  const summary: DobPreviewSummary = { ready_to_add: 0, already_recorded: 0, enrich_missing_year: 0, conflict: 0, needs_review: 0, unmatched: 0, ambiguous: 0, invalid: 0 };
  for (const row of rows) summary[row.status]++;
  return summary;
}
