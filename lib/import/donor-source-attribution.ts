// Giving Import -- Third-Party Source Attribution. Pure, no D1 access.
//
// Distinguishes SOURCE PAYER ("who did JL record this transaction
// under?") from FUNDRAISING ATTRIBUTION ("whose fundraising relationship
// should this gift count toward in Fundraising OS?"). A `donor_source_
// attributions` row (db/schema.ts) is ONLY ever a SUGGESTION -- it makes
// a specific donor the easy, one-click choice in the review UI when an
// incoming transaction's JL source code is a known third-party payer
// commonly associated with them, but it is NEVER consulted to auto-
// attribute anything. Every transaction still requires an explicit,
// per-row human decision (lib/import/jl-donation-rejection-review.ts's
// `match_donor` action, or lib/import/jl-payment-assignment.ts's
// `attributedDonorId` field) -- this module only supplies the
// suggestion, never the decision.
//
// This is transaction attribution, not identity merging: a suggested
// donor's own JL external_id/donor_code is never changed, and the
// source code is never written anywhere as if it were the donor's own
// code. See db/schema.ts's own comment on `donorSourceAttributions` for
// the full reasoning.
export type KnownSourceAttribution = {
  sourceExternalId: string;
  sourceName: string | null;
  suggestedDonorId: string;
  suggestedDonorCode: string;
  suggestedDonorName: string;
  note: string | null;
};

export type RawDonorSourceAttributionRow = {
  source_external_id: string;
  source_name: string | null;
  suggested_donor_id: string;
  suggested_donor_code: string;
  suggested_donor_name: string;
  note: string | null;
};

// Builds a lookup keyed by lowercased source code -- the same
// normalization every other JL-code lookup in this codebase already
// uses (see lib/import/jl-donation-match.ts's own `householdByCode`).
// A row whose suggested donor no longer resolves (e.g. the join failed
// because the donor was archived/deleted) is silently excluded rather
// than surfaced as a broken suggestion -- the review UI simply falls
// back to its ordinary, unsuggested unmatched-code experience for that
// row, exactly as if no mapping existed at all. This degrade-safely
// behavior is deliberate: a stale mapping must never block or corrupt
// an otherwise-ordinary import.
export function buildKnownAttributionsByCode(rows: RawDonorSourceAttributionRow[]): Map<string, KnownSourceAttribution> {
  const byCode = new Map<string, KnownSourceAttribution>();
  for (const row of rows) {
    const code = row.source_external_id.trim().toLowerCase();
    if (!code || !row.suggested_donor_id || !row.suggested_donor_code) continue;
    byCode.set(code, {
      sourceExternalId: row.source_external_id,
      sourceName: row.source_name,
      suggestedDonorId: row.suggested_donor_id,
      suggestedDonorCode: row.suggested_donor_code,
      suggestedDonorName: row.suggested_donor_name,
      note: row.note,
    });
  }
  return byCode;
}
