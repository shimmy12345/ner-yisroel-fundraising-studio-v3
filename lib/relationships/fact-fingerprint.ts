// Same lightweight, deterministic FNV-1a hash already used in
// lib/research/fingerprint.ts (and lib/logger.ts's pseudonymizeIdentifier)
// -- reused by convention rather than adding a crypto dependency for
// something that only needs to be stable and well-distributed, not
// cryptographically strong. Duplicated locally rather than imported,
// matching lib/research/fingerprint.ts's own admitted precedent for this
// exact tradeoff.
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeFactText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "");
}

// Identifies "the same accepted fact" for idempotent re-runs -- the real
// backstop behind the backfill script's own duplicate-prevention logic,
// and behind donor_relationship_facts' (user_id, fingerprint) unique
// index.
//
// Deliberately INCLUDES sourceInteractionId, unlike lib/research/
// fingerprint.ts's computeFindingFingerprint (which deliberately
// EXCLUDES source, since two sources finding the identical research
// claim is corroboration of one finding). Here the opposite is true: two
// different interactions that happen to produce coincidentally-identical
// fact text are two separate accepted moments, each with its own real
// provenance -- they must never collide into one row. A backfilled fact
// (no real source interaction) uses the fixed literal "backfill" in its
// place, which is exactly what makes the backfill idempotent: re-running
// it for the same donor/text always recomputes the same fingerprint and
// is skipped by the unique index (or an explicit pre-check), never
// duplicated.
export function computeRelationshipFactFingerprint(input: { donorId: string; factText: string; sourceInteractionId: string | null }): string {
  const parts = [input.donorId, normalizeFactText(input.factText), input.sourceInteractionId ?? "backfill"];
  return fnv1a(parts.join("|"));
}
