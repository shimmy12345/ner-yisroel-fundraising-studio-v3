import type { ImportRow } from "../import/recognition.ts";
import { numericDonorCode } from "./donor-identity.ts";

// Donor Rebbeim -- lightweight relationship intelligence (see
// docs/AI-HANDOFF.md's "Donor Rebbeim" entry). A binary donor <-> Rebbi
// relationship: it either exists or it does not. Deliberately no
// strength score, no primary/secondary hierarchy, no current/former
// lifecycle, no notes/status per relationship.

export type RebbiRecord = { id: string; displayName: string; normalizedName: string };

// Honorific prefixes stripped purely for EXACT-duplicate prevention
// ("Harav Berkowitz" / "Rav Berkowitz" / "Rabbi Berkowitz" must collapse
// to the same canonical record) -- never a fuzzy-match field. A name with
// no recognized prefix is normalized as-is.
const HONORIFIC_PREFIXES = ["horav", "harav", "ha-rav", "rabbi", "rav", "reb"];

export function normalizeRebbiName(raw: string): string {
  const collapsed = raw.trim().toLowerCase().replace(/\s+/g, " ");
  for (const prefix of HONORIFIC_PREFIXES) {
    if (collapsed === prefix) return "";
    if (collapsed.startsWith(`${prefix} `)) return collapsed.slice(prefix.length + 1).trim();
  }
  return collapsed;
}

// Cautious, explainable "likely means an existing canonical Rebbi"
// detector for an UNRECOGNIZED bulk-import name -- deliberately NOT a
// general fuzzy/Levenshtein matcher (none exists safely reusable in this
// codebase; see lib/donors/merge-preview.ts, which is donor-specific).
// Flags every canonical Rebbi sharing the unrecognized name's last word
// (surname) -- e.g. "Harav Tzvi Berkowitz" surfaces "Harav Berkowitz" for
// review. Deliberately returns EVERY match, not just one: several
// canonical Rebbeim legitimately share a surname (six different
// Neuberger Rebbeim are seeded -- see scripts/seed-rebbeim-directory.mjs),
// so an ambiguous last-word match must never silently resolve to a single
// guess. Never auto-applied by any caller -- always surfaced for human
// review only.
export function likelyRebbiMatches(rawName: string, canonical: readonly RebbiRecord[]): RebbiRecord[] {
  const normalized = normalizeRebbiName(rawName);
  const lastWord = normalized.split(" ").filter(Boolean).pop();
  if (!lastWord) return [];
  return canonical.filter((rebbi) => {
    if (rebbi.normalizedName === normalized) return false; // exact matches are handled separately, never "likely"
    const parts = rebbi.normalizedName.split(" ").filter(Boolean);
    return parts[parts.length - 1] === lastWord;
  });
}

export function findCanonicalRebbi(rawName: string, canonical: readonly RebbiRecord[]): RebbiRecord | null {
  const normalized = normalizeRebbiName(rawName);
  if (!normalized) return null;
  return canonical.find((rebbi) => rebbi.normalizedName === normalized) ?? null;
}

// --- Bulk donor-code / Rebbeim assignment import ---
//
// Accepted CSV shapes (both read via the same "Donor Code" column;
// column names matched case-insensitively after trimming):
//   Donor Code,Rebbeim              <- semicolon-separated, primary format
//   48637,Harav Berkowitz; Harav Frand
// or:
//   Donor Code,Rebbi                <- one name per row, repeated donor code
//   48637,Harav Berkowitz
//   48637,Harav Frand
// Never donor name/address matching -- donor identity is exact donor code
// only, mirroring every other bulk importer in this codebase (see
// lib/import/dob-pipeline.ts's own header comment).

export type FlattenedRebbeimRow = { rowNumber: number; donorCodeRaw: string; rebbiNameRaw: string };

function findColumn(row: ImportRow, candidates: string[]): string | null {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const match = keys.find((key) => key.trim().toLowerCase() === candidate);
    if (match) return match;
  }
  return null;
}

// Splits raw CSV rows into one flattened {donorCodeRaw, rebbiNameRaw} pair
// per requested Rebbi, deduplicating a repeated Rebbi name WITHIN the same
// donor code (case/whitespace/honorific-insensitive) before classification
// ever sees it -- "Harav Berkowitz; Harav Berkowitz" or two separate rows
// for the same donor code + Rebbi collapse to exactly one flattened row,
// keeping the first occurrence's row number for display. rowNumber is
// 1-indexed against the data rows only (header excluded), matching this
// codebase's other CSV importers.
export function flattenRebbeimImportRows(rows: ImportRow[]): FlattenedRebbeimRow[] {
  const flattened: FlattenedRebbeimRow[] = [];
  const seen = new Set<string>(); // `${donorCodeRaw.trim()}\u001f${normalizeRebbiName(name)}`
  rows.forEach((row, index) => {
    const donorCodeColumn = findColumn(row, ["donor code", "code"]);
    const donorCodeRaw = (donorCodeColumn ? row[donorCodeColumn] : "").trim();
    const plural = findColumn(row, ["rebbeim"]);
    const singular = findColumn(row, ["rebbi"]);
    const rawValue = (plural ? row[plural] : singular ? row[singular] : "").trim();
    if (!rawValue) return; // blank Rebbeim/Rebbi field -- no-op, not an error
    const names = plural ? rawValue.split(";").map((name) => name.trim()).filter(Boolean) : [rawValue];
    for (const rebbiNameRaw of names) {
      const dedupeKey = `${donorCodeRaw.toLowerCase()}\u001f${normalizeRebbiName(rebbiNameRaw)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      flattened.push({ rowNumber: index + 2, donorCodeRaw, rebbiNameRaw });
    }
  });
  return flattened;
}

export type RebbeimImportDonorCandidate = { donorId: string; donorName: string };
export type RebbeimImportDonorLookup = Map<string, RebbeimImportDonorCandidate[]>;

export type RebbeimImportRowStatus =
  | "ready_to_add"
  | "already_exists"
  | "unmatched_donor"
  | "ambiguous_donor"
  | "unrecognized_rebbi";

export type RebbeimImportPreviewRow = {
  rowNumber: number;
  donorCodeRaw: string;
  matchedDonorId: string | null;
  matchedDonorName: string | null;
  rebbiNameRaw: string;
  matchedRebbiId: string | null;
  matchedRebbiName: string | null;
  status: RebbeimImportRowStatus;
  issue: string | null;
  likelyMatches: RebbiRecord[];
  canCommit: boolean;
};

// Pure classification -- no D1 access. existingPairs is the set of
// `${donorId}\u001f${rebbiId}` pairs already present (for the
// already_exists/idempotent-no-op check).
export function classifyRebbeimRow(
  flat: FlattenedRebbeimRow,
  donorLookup: RebbeimImportDonorLookup,
  canonical: readonly RebbiRecord[],
  existingPairs: ReadonlySet<string>,
): RebbeimImportPreviewRow {
  const base = { rowNumber: flat.rowNumber, donorCodeRaw: flat.donorCodeRaw, rebbiNameRaw: flat.rebbiNameRaw };
  const code = numericDonorCode({ donorCode: flat.donorCodeRaw, externalId: null });
  const candidates = code ? donorLookup.get(code) ?? [] : [];

  if (!code || candidates.length === 0) {
    return { ...base, matchedDonorId: null, matchedDonorName: null, matchedRebbiId: null, matchedRebbiName: null, status: "unmatched_donor", issue: `No donor found with code "${flat.donorCodeRaw}". This row will be skipped -- never matched by name.`, likelyMatches: [], canCommit: false };
  }
  if (candidates.length > 1) {
    return { ...base, matchedDonorId: null, matchedDonorName: null, matchedRebbiId: null, matchedRebbiName: null, status: "ambiguous_donor", issue: `Code "${flat.donorCodeRaw}" matches more than one live donor. Resolve the duplicate donor code before importing this row.`, likelyMatches: [], canCommit: false };
  }
  const donor = candidates[0];

  const rebbi = findCanonicalRebbi(flat.rebbiNameRaw, canonical);
  if (!rebbi) {
    return { ...base, matchedDonorId: donor.donorId, matchedDonorName: donor.donorName, matchedRebbiId: null, matchedRebbiName: null, status: "unrecognized_rebbi", issue: `"${flat.rebbiNameRaw}" does not match any Rebbi in the canonical directory. It will not be created automatically.`, likelyMatches: likelyRebbiMatches(flat.rebbiNameRaw, canonical), canCommit: false };
  }

  if (existingPairs.has(`${donor.donorId}\u001f${rebbi.id}`)) {
    return { ...base, matchedDonorId: donor.donorId, matchedDonorName: donor.donorName, matchedRebbiId: rebbi.id, matchedRebbiName: rebbi.displayName, status: "already_exists", issue: null, likelyMatches: [], canCommit: false };
  }

  return { ...base, matchedDonorId: donor.donorId, matchedDonorName: donor.donorName, matchedRebbiId: rebbi.id, matchedRebbiName: rebbi.displayName, status: "ready_to_add", issue: null, likelyMatches: [], canCommit: true };
}

export function buildRebbeimImportPreview(
  rows: ImportRow[],
  donorLookup: RebbeimImportDonorLookup,
  canonical: readonly RebbiRecord[],
  existingPairs: ReadonlySet<string>,
): RebbeimImportPreviewRow[] {
  return flattenRebbeimImportRows(rows).map((flat) => classifyRebbeimRow(flat, donorLookup, canonical, existingPairs));
}

export type RebbeimImportSummary = Record<RebbeimImportRowStatus, number>;
export function summarizeRebbeimImportPreview(rows: RebbeimImportPreviewRow[]): RebbeimImportSummary {
  const summary: RebbeimImportSummary = { ready_to_add: 0, already_exists: 0, unmatched_donor: 0, ambiguous_donor: 0, unrecognized_rebbi: 0 };
  for (const row of rows) summary[row.status]++;
  return summary;
}
