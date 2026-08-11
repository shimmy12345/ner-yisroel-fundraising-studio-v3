import type { FindingCategory } from "./types.ts";

// Same lightweight, deterministic FNV-1a hash already used to pseudonymize
// userId at the logging boundary (lib/logger.ts) -- reused here rather than
// adding a crypto dependency for something that only needs to be stable and
// well-distributed, not cryptographically strong.
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeClaimText(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");
}

// Identifies "the same logical finding" across research runs so re-running
// research dedupes instead of duplicating, and so a fact that goes away and
// later comes back (a board term lapses, then renews) gets a fresh row
// rather than colliding with its own now-superseded history.
//
// Deliberately excludes source domain: if the identical claim is found via
// two different pages, that's corroboration of one fact (donor_research_finding_sources
// already supports multiple sources per finding) rather than two separate
// findings to track. This also keeps the fingerprint recomputable from a
// finding's own stored columns alone (category, claim, relatedDonorId),
// with no source lookup needed -- required by donor-merge reconciliation
// (lib/donors/merge-research.ts), which must recompute a
// possible_connections finding's fingerprint after repointing
// relatedDonorId.
export function computeFindingFingerprint(input: { category: FindingCategory; claim: string; relatedDonorId?: string | null }): string {
  const parts = [input.category, normalizeClaimText(input.claim), input.relatedDonorId ?? ""];
  return fnv1a(parts.join("|"));
}
