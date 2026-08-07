import type { ImportRow } from "./recognition.ts";
import { isJlDonationExport } from "./jl-donations.ts";
import { isJlSolutionsExport } from "./jl-solutions.ts";

// Columns that only ever appear on a donation/giving export — never on a
// household export. Presence of two or more is treated as a strong signal
// even when the file does not fully match the canonical/compact donation
// column set (e.g. a real-world export missing one required column).
const STRONG_DONATION_INDICATOR_COLUMNS = ["Campaign", "Due Date", "Amount", "Paid", "Balance Due"] as const;

export function countStrongDonationIndicators(columns: string[], rows: ImportRow[]) {
  const found = new Set(columns.map((column) => column.trim().toLowerCase()));
  let count = STRONG_DONATION_INDICATOR_COLUMNS.filter((column) => found.has(column.toLowerCase())).length;
  // "Company" is a household-adjacent column name, but JL donation exports
  // use it to record the transaction type; a literal "Donation" value is a
  // donation-only signal that a bare column-name check cannot see.
  if (found.has("company")) {
    const companyColumn = columns.find((column) => column.trim().toLowerCase() === "company");
    if (companyColumn && rows.some((row) => row[companyColumn]?.trim().toLowerCase() === "donation")) count += 1;
  }
  return count;
}

export type JlImportType = "donation" | "household" | "ambiguous" | "general";

// Detection is mutually exclusive by construction: a strong donation
// signature always wins over the (much looser) household check, and a weak
// donation signal against household-shaped columns is surfaced as
// "ambiguous" rather than guessed. Only a file matching neither is left to
// the general importer.
export function classifyJlImportType(columns: string[], rows: ImportRow[]): JlImportType {
  if (isJlDonationExport(columns)) return "donation";
  const donationIndicators = countStrongDonationIndicators(columns, rows);
  const looksLikeHousehold = isJlSolutionsExport(columns);
  if (donationIndicators >= 2) return "donation";
  if (donationIndicators === 1 && looksLikeHousehold) return "ambiguous";
  if (looksLikeHousehold) return "household";
  return "general";
}
