import { stableTransactionId } from "./jl-donations.ts";

// Row shape returned by the query below -- deliberately narrow (only the
// fields matching actually needs), matching this codebase's own
// RawExistingDonationRow/ExistingGivingActivity convention in
// jl-donation-cross-import.ts / jl-donation-match.ts.
export type ExistingCompletedGiftRow = {
  id: string;
  donor_id: string;
  activity_date: number | null;
  committed_cents: number | null;
  source_campaign: string | null;
  description: string | null;
  source_snapshot: string;
  created_at: number;
};

// Scoped to completed_gift only, deliberately: a completed gift's
// committed_cents equals its paid_cents (money fully received on
// activity_date), which is the one category this codebase can compare
// against an incoming payment's own (date, amount) with confidence. An
// open_pledge or partially_paid_pledge's committed_cents/activity_date
// describe the PLEDGE's own commitment/date, not any individual payment
// received against it over time -- there is no per-payment date recorded
// for those, so matching a payment's date against a pledge's own date
// would be unreliable and is intentionally out of scope here (see
// docs/AI-HANDOFF.md's Giving Import Reconciliation entry).
export const EXISTING_COMPLETED_GIFTS_FOR_DUPLICATE_MATCH_SQL = `SELECT id, donor_id, activity_date, committed_cents, source_campaign, description, source_snapshot, created_at
  FROM giving_activities
  WHERE owner_user_id = ? AND record_origin = 'live' AND workspace_status = 'active'
    AND category = 'completed_gift'
    AND donor_id IN (SELECT value FROM json_each(?))`;

export type PaymentDuplicateConfidence = "confirmed" | "likely" | "possible";

export type PaymentDuplicateMatch = {
  confidence: PaymentDuplicateConfidence;
  existingActivityId: string;
  existingDonorId: string;
  existingActivityDate: number | null;
  existingAmountCents: number | null;
  existingCampaign: string;
  existingDescription: string;
  reason: string;
};

function parseSnapshot(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Confidence-aware duplicate detection for an incoming payment against
// existing, already-recorded completed gifts -- distinct from (and
// complementary to) the exact-content-fingerprint cross-import matching in
// jl-donation-cross-import.ts, which only catches a byte-identical repeat
// of the SAME export format/columns. A payment reported through a
// different JL Solutions export shape than the one that originally
// recorded the gift (e.g. a compact payments report vs. the original full
// pledge export) produces a structurally different content fingerprint
// for the exact same real-world transaction, because canonicalFingerprint
// (jl-donations.ts) includes Item Num/Desc/Company columns a compact
// export never has -- so fingerprint-only matching can never catch this
// case. This function instead matches on the underlying financial facts
// (donor, date, amount, campaign) that describe the same transaction
// regardless of which export produced it.
//
// Never treats donor+date+amount alone as proof: a donor can legitimately
// make two equal payments on the same day. Three tiers, from strongest to
// weakest evidence:
//   - "confirmed": a stable transaction/payment/reference/check identifier
//     already recorded on an existing gift's own source snapshot matches
//     this payment's identifier -- the only tier proven by something more
//     specific than content overlap.
//   - "likely": donor + date + amount match exactly ONE existing gift, and
//     that gift's campaign also matches this payment's campaign
//     (case-insensitive, both non-empty) -- strong content-only evidence,
//     but still never silently applied without the user seeing and
//     confirming it (see planPaymentAssignments's "skip_duplicate" action,
//     which is always an explicit, visible, overridable decision).
//   - "possible": donor + date + amount match, but the campaign differs
//     (or either side has none recorded), or more than one existing gift
//     matches -- genuinely ambiguous, surfaced for the user's own
//     judgment rather than preselecting anything.
// Returns null when there is no meaningful evidence at all.
export function findPaymentDuplicateMatch(
  stableId: string | null,
  donorId: string,
  activityDate: number | null,
  amountCents: number | null,
  campaign: string,
  existingByDonor: ReadonlyMap<string, ExistingCompletedGiftRow[]>,
): PaymentDuplicateMatch | null {
  const candidates = existingByDonor.get(donorId) ?? [];
  if (candidates.length === 0) return null;

  if (stableId) {
    const stableMatch = candidates.find((existing) => {
      const existingId = stableTransactionId(parseSnapshot(existing.source_snapshot));
      return existingId !== null && existingId.trim().toLowerCase() === stableId.trim().toLowerCase();
    });
    if (stableMatch) {
      return {
        confidence: "confirmed",
        existingActivityId: stableMatch.id,
        existingDonorId: stableMatch.donor_id,
        existingActivityDate: stableMatch.activity_date,
        existingAmountCents: stableMatch.committed_cents,
        existingCampaign: stableMatch.source_campaign ?? "",
        existingDescription: stableMatch.description ?? "",
        reason: `Transaction ID "${stableId}" already exists in Fundraising OS.`,
      };
    }
  }

  if (activityDate === null || amountCents === null || amountCents <= 0) return null;
  const dateAmountMatches = candidates.filter((existing) => existing.activity_date === activityDate && existing.committed_cents === amountCents);
  if (dateAmountMatches.length === 0) return null;

  const normalizedCampaign = campaign.trim().toLowerCase();
  const campaignMatches = normalizedCampaign ? dateAmountMatches.filter((existing) => (existing.source_campaign ?? "").trim().toLowerCase() === normalizedCampaign) : [];
  const best = campaignMatches[0] ?? dateAmountMatches[0];
  const confidence: PaymentDuplicateConfidence = campaignMatches.length === 1 ? "likely" : "possible";
  const campaignNote = confidence === "likely" ? ` (campaign: ${best.source_campaign})` : "";
  return {
    confidence,
    existingActivityId: best.id,
    existingDonorId: best.donor_id,
    existingActivityDate: best.activity_date,
    existingAmountCents: best.committed_cents,
    existingCampaign: best.source_campaign ?? "",
    existingDescription: best.description ?? "",
    reason: `A completed gift with the same donor, date, and amount${campaignNote} is already recorded in Fundraising OS.`,
  };
}
