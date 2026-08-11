import { computeFindingFingerprint } from "./fingerprint.ts";
import { normalizeOrganizationName } from "./organization.ts";
import { TIER_REQUIRES_CORROBORATION, WEAKEST_UNCORROBORATED_TIER, type FindingCategory, type FindingStatus, type SourceTier } from "./types.ts";

// Pure decision logic for turning one confirmed piece of evidence into a
// finding write. No D1 access here -- callers (app/api/research/*) run the
// lookups this needs, pass in the results, and translate the returned plan
// into prepared statements. Kept pure so this is testable with plain
// assert, the same convention used throughout this codebase.

// Professional and Boards & Affiliations claims cannot become "current" on
// Tier 5 (public search result) evidence alone -- they land as
// "unverified" instead, same status, same visibility, just labeled
// honestly as needing stronger corroboration.
export function resolveFindingStatus(category: FindingCategory, sourceTier: SourceTier): FindingStatus {
  if (TIER_REQUIRES_CORROBORATION.includes(category) && sourceTier === WEAKEST_UNCORROBORATED_TIER) return "unverified";
  return "current";
}

export type ExistingActiveFinding = { id: string; fingerprint: string; category: FindingCategory; organizationNormalized: string | null };

export type FindingPlan =
  | { action: "reuse"; fingerprint: string; status: FindingStatus; existingFindingId: string }
  | { action: "insert"; fingerprint: string; status: FindingStatus }
  | { action: "supersede-and-insert"; fingerprint: string; status: FindingStatus; supersedesFindingId: string };

// existingActiveFindings must be the donor's own current+unverified
// findings only (never another donor's, never historical rows) -- the
// caller is responsible for that scope, matching exactly what the
// donor_research_findings_donor_fingerprint_active_uidx constraint
// protects.
export function planFinding(input: {
  category: FindingCategory;
  claim: string;
  sourceTier: SourceTier;
  organizationNormalized: string | null;
  relatedDonorId?: string | null;
  existingActiveFindings: ExistingActiveFinding[];
}): FindingPlan {
  const status = resolveFindingStatus(input.category, input.sourceTier);
  const fingerprint = computeFindingFingerprint({ category: input.category, claim: input.claim, relatedDonorId: input.relatedDonorId });

  const exactMatch = input.existingActiveFindings.find((finding) => finding.fingerprint === fingerprint);
  if (exactMatch) return { action: "reuse", fingerprint, status, existingFindingId: exactMatch.id };

  // Only treat this as a changed version of an EXISTING fact -- not a new,
  // independent one -- when it shares both category and organization with
  // an existing active finding. Category alone is too coarse (a donor can
  // legitimately hold two unrelated professional roles at once); without a
  // known organization, there is no safe signal to supersede on, so this
  // always inserts as independent rather than guessing.
  const sameFactDifferentDetails = input.organizationNormalized
    ? input.existingActiveFindings.find((finding) => finding.category === input.category && finding.organizationNormalized === input.organizationNormalized)
    : undefined;
  if (sameFactDifferentDetails) return { action: "supersede-and-insert", fingerprint, status, supersedesFindingId: sameFactDifferentDetails.id };

  return { action: "insert", fingerprint, status };
}

export type SharedAffiliationPlan = { donorId: string; relatedDonorId: string; claim: string; fingerprint: string };

// One organizationNormalized value just became active for `donorId`.
// otherDonorIds are every OTHER donor (same workspace) who already has an
// active professional/boards_affiliations/public_philanthropy finding for
// that same normalized organization -- the caller runs that lookup
// (donor_research_findings_user_org_idx exists for exactly this). Produces
// a symmetric pair of possible_connections plans per overlapping donor, so
// the connection is visible from both donor pages, each citing its own
// evidence. Wording is deliberately "shared public affiliation" only --
// never friendship, relationship, influence, or closeness.
export function planSharedAffiliations(input: {
  donorId: string;
  organizationDisplayName: string;
  organizationNormalized: string;
  otherDonorIds: string[];
}): SharedAffiliationPlan[] {
  const claim = `Shared public affiliation with ${input.organizationDisplayName}`;
  return input.otherDonorIds.flatMap((otherDonorId) => [
    { donorId: input.donorId, relatedDonorId: otherDonorId, claim, fingerprint: computeFindingFingerprint({ category: "possible_connections", claim, relatedDonorId: otherDonorId }) },
    { donorId: otherDonorId, relatedDonorId: input.donorId, claim, fingerprint: computeFindingFingerprint({ category: "possible_connections", claim, relatedDonorId: input.donorId }) },
  ]);
}

export { normalizeOrganizationName };
