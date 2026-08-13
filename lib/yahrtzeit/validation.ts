import { HEBREW_MONTHS, isHebrewMonthName, isPlausibleHebrewDate, isValidHebrewDateForYear, type HebrewMonthName } from "../calendar/hebrew-date.ts";

export type YahrtzeitInput = {
  deceasedNameEnglish?: string;
  deceasedNameHebrew?: string;
  relationship?: string;
  hebrewMonth?: string;
  hebrewDay?: number;
  hebrewYear?: number | null;
};

export type NormalizedYahrtzeit = {
  deceasedNameEnglish: string;
  deceasedNameHebrew: string | null;
  relationship: string;
  hebrewMonth: HebrewMonthName | null;
  hebrewDay: number | null;
  hebrewYear: number | null;
};

function clean(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function normalizeYahrtzeit(input: YahrtzeitInput) {
  const deceasedNameEnglish = clean(input.deceasedNameEnglish);
  const deceasedNameHebrewRaw = clean(input.deceasedNameHebrew);
  const relationship = clean(input.relationship);
  const monthRaw = clean(input.hebrewMonth);
  const hebrewDay = Number.isInteger(input.hebrewDay) ? (input.hebrewDay as number) : null;
  const hebrewYear = Number.isInteger(input.hebrewYear) ? (input.hebrewYear as number) : null;

  const normalized: NormalizedYahrtzeit = {
    deceasedNameEnglish,
    deceasedNameHebrew: deceasedNameHebrewRaw || null,
    relationship,
    hebrewMonth: isHebrewMonthName(monthRaw) ? monthRaw : null,
    hebrewDay,
    hebrewYear,
  };

  const errors: Record<string, string> = {};
  if (!deceasedNameEnglish) errors.deceasedNameEnglish = "The deceased's English name is required.";
  if (deceasedNameEnglish.length > 200) errors.deceasedNameEnglish = "Use 200 characters or fewer.";
  if (deceasedNameHebrewRaw.length > 200) errors.deceasedNameHebrew = "Use 200 characters or fewer.";
  if (!relationship) errors.relationship = "Relationship to the donor is required.";
  if (relationship.length > 100) errors.relationship = "Use 100 characters or fewer.";
  if (!normalized.hebrewMonth) errors.hebrewMonth = `Choose a Hebrew month (${HEBREW_MONTHS.join(", ")}).`;
  if (hebrewDay === null || hebrewDay < 1) errors.hebrewDay = "Enter a Hebrew day (1 or greater).";
  if (normalized.hebrewMonth && hebrewDay !== null && !isPlausibleHebrewDate(normalized.hebrewMonth, hebrewDay)) {
    errors.hebrewDay = `${hebrewDay} is not a possible day for ${normalized.hebrewMonth}.`;
  }
  if (normalized.hebrewMonth && hebrewDay !== null && hebrewYear !== null && !errors.hebrewDay && !isValidHebrewDateForYear(normalized.hebrewMonth, hebrewDay, hebrewYear)) {
    errors.hebrewDay = `${hebrewDay} ${normalized.hebrewMonth} did not occur in Hebrew year ${hebrewYear}.`;
  }
  if (hebrewYear !== null && (hebrewYear < 3000 || hebrewYear > 7000)) errors.hebrewYear = "Enter a Hebrew year (e.g. 5785), or leave it blank.";

  return { normalized, errors, valid: Object.keys(errors).length === 0 };
}

export function changedYahrtzeitFields(before: NormalizedYahrtzeit | null, after: NormalizedYahrtzeit): string[] {
  const keys = Object.keys(after) as (keyof NormalizedYahrtzeit)[];
  if (!before) return keys;
  return keys.filter((key) => before[key] !== after[key]);
}
