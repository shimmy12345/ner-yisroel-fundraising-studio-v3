// Exact-match normalization only, deliberately -- fuzzy/semantic
// organization-name matching would let Shared Public Affiliations fabricate
// overlaps ("Example Foundation" vs "The Example Foundation, Inc." judged
// "close enough") that no source actually establishes. Missing a real
// overlap because of a punctuation/casing difference is the safer failure
// mode than inventing one.
export function normalizeOrganizationName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^(the)\s+/, "")
    .trim();
}
