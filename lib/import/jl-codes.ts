// JL Codes convenience export (docs/AI-HANDOFF.md). Canonical source is
// donors.donor_code -- the field the JL importer itself trusts (see
// app/api/import/route.ts's code-lookup query and lib/import/jl-match.ts's
// matchJlDonors). donors.external_id is a JL-specific mirror of the same
// value that is only ever set alongside donor_code, never instead of it, so
// donor_code alone is already the complete set -- no coalesce needed.

// Never cast to number for storage/comparison identity: a JL Code is
// opaque text, and a leading zero (or any non-numeric code a household
// import might carry) must survive unchanged.
export function extractUniqueJlCodes(rawCodes: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const raw of rawCodes) {
    const code = typeof raw === "string" ? raw.trim() : "";
    if (code) seen.add(code);
  }
  return sortJlCodes([...seen]);
}

// Numeric sort only when EVERY code is purely digits -- avoids an
// ambiguous mixed-mode ordering if the workspace ever has a non-numeric
// code alongside numeric ones. Equal numeric value but different string
// form (e.g. "007" vs "7") ties on the string itself, since those are
// distinct real values, not duplicates.
export function sortJlCodes(codes: string[]): string[] {
  const allNumeric = codes.length > 0 && codes.every((code) => /^\d+$/.test(code));
  return [...codes].sort(allNumeric
    ? (a, b) => Number(a) - Number(b) || a.localeCompare(b)
    : (a, b) => a.localeCompare(b));
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function jlCodesToCsv(codes: string[]): string {
  return ["JL Code", ...codes.map(csvField)].join("\n") + "\n";
}

export function jlCodesToClipboardText(codes: string[]): string {
  return codes.join("\n");
}
