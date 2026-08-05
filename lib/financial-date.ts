const DAY_SECONDS = 86_400;

function validUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Parses a calendar date without ever consulting the machine or user timezone. */
export function parseFinancialDate(value: string) {
  const trimmed = value.trim();
  // Full JL and spreadsheet exports sometimes append a midnight time. Read
  // only the leading calendar date so that neither the suffix nor its zone can
  // move the financial record to a different day.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(trimmed);
  const us = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+.*)?$/.exec(trimmed);
  const parts = iso
    ? { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }
    : us
      ? { year: Number(us[3]), month: Number(us[1]), day: Number(us[2]) }
      : null;
  if (!parts || !validUtcDate(parts.year, parts.month, parts.day)) return null;
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 1000);
}

/** Removes an accidental time component while retaining the stored UTC calendar day. */
export function normalizeFinancialDate(epoch: number) {
  return Math.floor(epoch / DAY_SECONDS) * DAY_SECONDS;
}

export function financialDateLabel(epoch: number, dateStyle: "medium" | "long" = "medium") {
  return new Intl.DateTimeFormat("en-US", { dateStyle, timeZone: "UTC" }).format(new Date(normalizeFinancialDate(epoch) * 1000));
}
