// Same lightweight FNV-1a hash already used elsewhere in this codebase
// (lib/logger.ts's userId pseudonymization, lib/research/fingerprint.ts) --
// reused here rather than adding a crypto dependency.
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Identifies "the same Monday source row" across re-imports of the same
// (or a refreshed) workbook. Deliberately excludes anything the
// fundraiser chooses during review -- the confirmed contact date, a
// follow-up's new due date -- so correcting that choice later updates
// the existing record instead of creating a duplicate. donorCode +
// subitem's own position within that donor's block + its own text and
// Monday due date are the only inputs, all of which come from Monday
// itself and stay stable across re-imports.
export function mondaySourceFingerprint(input: { donorCode: string; subitemIndex: number; text: string; dueDateRaw: string | null }): string {
  const normalizedText = input.text.trim().toLowerCase().replace(/\s+/g, " ");
  return fnv1a(["monday", input.donorCode, String(input.subitemIndex), normalizedText, input.dueDateRaw ?? ""].join("|"));
}

export function mondayInteractionId(fingerprint: string): string {
  return `monday-interaction-${fingerprint}`;
}

export function mondayRecommendationId(fingerprint: string): string {
  return `monday-recommendation-${fingerprint}`;
}

export function mondayHistoricalContextId(fingerprint: string): string {
  return `monday-context-${fingerprint}`;
}
