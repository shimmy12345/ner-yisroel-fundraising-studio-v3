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

// JL Code + name CSV export (docs/AI-HANDOFF.md) -- the same donor
// population, dedup, and ordering as extractUniqueJlCodes/jlCodesToCsv
// above (this is a narrow addition to that existing export, not a new
// one), with First Name/Last Name added from donors.primary_first_name/
// donors.last_name -- the same structured, canonical name fields
// lib/donors/merge.ts and lib/relationships/donor-identity.ts already
// treat as authoritative, never parsed from display_name. Only the CSV
// download gains the new columns; the separate "Copy JL Codes" clipboard
// feature (plain codes, for pasting into JL's own search box) is a
// different use case and is untouched.
export type JlCodeIdentityRow = { donor_code: string | null; primary_first_name: string | null; last_name: string | null };
export type JlCodeIdentity = { code: string; firstName: string | null; lastName: string | null };

// A blank/whitespace-only name is reported as `null` (never invented or
// inferred) -- the caller renders that as an empty CSV cell, exactly the
// same way a donor who legitimately has no name on file already looks
// elsewhere in this app. If more than one donor row happens to share the
// same JL Code (not the normal case, but not structurally impossible),
// the FIRST row's name wins -- deterministic, and the code itself is
// still deduplicated exactly as before; which single name accompanies a
// shared code was never a decision the prior, name-less export had to
// make at all.
export function extractUniqueJlCodeIdentities(rows: JlCodeIdentityRow[]): JlCodeIdentity[] {
  const byCode = new Map<string, { firstName: string | null; lastName: string | null }>();
  for (const row of rows) {
    const code = typeof row.donor_code === "string" ? row.donor_code.trim() : "";
    if (!code || byCode.has(code)) continue;
    const firstName = typeof row.primary_first_name === "string" && row.primary_first_name.trim() ? row.primary_first_name.trim() : null;
    const lastName = typeof row.last_name === "string" && row.last_name.trim() ? row.last_name.trim() : null;
    byCode.set(code, { firstName, lastName });
  }
  return sortJlCodes([...byCode.keys()]).map((code) => ({ code, ...byCode.get(code)! }));
}

export function jlCodeIdentitiesToCsv(identities: JlCodeIdentity[]): string {
  const rows = identities.map((identity) => [csvField(identity.code), csvField(identity.firstName ?? ""), csvField(identity.lastName ?? "")].join(","));
  return ["JL Code,First Name,Last Name", ...rows].join("\n") + "\n";
}
