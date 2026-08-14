import { isPlausibleGregorianDate } from "../calendar/gregorian-recurring-date.ts";

export type ImportantDateType = "birthday" | "anniversary";

export type ImportantDateInput = {
  type?: string;
  personName?: string;
  relationship?: string;
  month?: number;
  day?: number;
  year?: number | null;
  notes?: string;
};

export type NormalizedImportantDate = {
  type: ImportantDateType | null;
  personName: string | null;
  relationship: string | null;
  month: number | null;
  day: number | null;
  year: number | null;
  notes: string | null;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function isImportantDateType(value: string): value is ImportantDateType {
  return value === "birthday" || value === "anniversary";
}

// personName is required for a birthday (whose birthday is it) and always
// forced to null for an anniversary -- a wedding anniversary is a
// household-level fact, not a specific person's, so there is nothing to
// silently coerce or reject; an anniversary submission simply never stores
// one, regardless of what the caller sent.
export function normalizeImportantDate(input: ImportantDateInput) {
  const typeRaw = clean(input.type);
  const type = isImportantDateType(typeRaw) ? typeRaw : null;
  const personNameRaw = clean(input.personName);
  const relationshipRaw = clean(input.relationship);
  const notesRaw = clean(input.notes);
  const month = Number.isInteger(input.month) ? (input.month as number) : null;
  const day = Number.isInteger(input.day) ? (input.day as number) : null;
  const year = Number.isInteger(input.year) ? (input.year as number) : null;

  const normalized: NormalizedImportantDate = {
    type,
    personName: type === "birthday" ? (personNameRaw || null) : null,
    relationship: relationshipRaw || null,
    month,
    day,
    year,
    notes: notesRaw || null,
  };

  const errors: Record<string, string> = {};
  if (!type) errors.type = "Choose Birthday or Anniversary.";
  if (type === "birthday" && !personNameRaw) errors.personName = "Whose birthday this is required.";
  if (personNameRaw.length > 200) errors.personName = "Use 200 characters or fewer.";
  if (relationshipRaw.length > 100) errors.relationship = "Use 100 characters or fewer.";
  if (notesRaw.length > 500) errors.notes = "Use 500 characters or fewer.";
  if (month === null || month < 1 || month > 12) errors.month = "Choose a month.";
  if (day === null || day < 1) errors.day = "Enter a day (1 or greater).";
  if (month !== null && day !== null && !isPlausibleGregorianDate(month, day)) {
    errors.day = `${day} is not a possible day for that month.`;
  }
  if (year !== null && (year < 1900 || year > 2100)) errors.year = "Enter a year between 1900 and 2100, or leave it blank.";

  return { normalized, errors, valid: Object.keys(errors).length === 0 };
}

export function changedImportantDateFields(before: NormalizedImportantDate | null, after: NormalizedImportantDate): string[] {
  const keys = Object.keys(after) as (keyof NormalizedImportantDate)[];
  if (!before) return keys;
  return keys.filter((key) => before[key] !== after[key]);
}
