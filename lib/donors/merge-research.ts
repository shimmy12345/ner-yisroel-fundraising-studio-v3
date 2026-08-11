import { computeFindingFingerprint } from "../research/fingerprint.ts";
import type { FindingCategory } from "../research/types.ts";

// Pure planning for donor-merge research reconciliation -- no D1 access
// here. app/api/donors/merge/route.ts runs the reads this needs, calls
// this, and turns the returned plan into prepared statements appended to
// the SAME env.DB.batch() as the rest of the merge, so reconciliation is
// atomic with the donor archive: if anything in that batch fails, nothing
// commits, research included.
//
// donor_research_runs, donor_research_pending_evidence, and
// donor_research_identity_candidates carry no uniqueness constraint on
// donor_id, so repointing them from the duplicate donor to the survivor is
// always a safe, unconditional UPDATE -- the route does that directly and
// this module isn't involved.
//
// donor_research_findings is different: donor_research_findings_donor_fingerprint_active_uidx
// forbids two active (current/unverified) rows sharing a (donor_id,
// fingerprint) pair. A straight "UPDATE donor_id" on every one of the
// duplicate's findings can violate that the moment the survivor already
// has an equivalent active finding -- which is exactly expected when A and
// B are duplicate records of the same real person. This planner decides,
// per finding, whether it's a safe simple repoint or a collision that
// needs resolving.
export type FindingRef = { id: string; fingerprint: string };
export type ReferencingFinding = { id: string; donorId: string; category: FindingCategory; claim: string };

export type MergeResearchPlan = {
  // Safe as-is: repoint donor_id to the survivor, nothing else changes.
  findingRepoints: string[];
  // The duplicate's finding collided with an existing survivor finding of
  // the identical fingerprint. The survivor's own pre-existing finding
  // always wins and is left untouched; the duplicate's finding is repointed
  // to the survivor AND marked superseded (never deleted -- its full
  // history and source citations remain inspectable), and every source it
  // cited is copied onto the winner (INSERT OR IGNORE, so a source already
  // cited by both is never duplicated).
  findingSupersessions: Array<{ loserId: string; winnerId: string }>;
  // A finding belonging to some OTHER donor C references the duplicate via
  // related_donor_id (a possible_connections finding: "C shares a public
  // affiliation with the duplicate"). Repointing related_donor_id to the
  // survivor changes what the finding asserts, so its fingerprint (which
  // embeds relatedDonorId) must be recomputed at the same time. Safe when
  // C has no existing active finding with that new fingerprint.
  relatedDonorRepoints: Array<{ findingId: string; newFingerprint: string }>;
  // C already has an existing active finding for "C shares a public
  // affiliation with the survivor" (discovered independently, before this
  // merge). That pre-existing finding wins; the duplicate-referencing one
  // is repointed and marked superseded, with its sources copied onto the
  // winner, identically to findingSupersessions above.
  relatedDonorSupersessions: Array<{ loserId: string; winnerId: string; newFingerprint: string }>;
};

export function planDonorMergeResearchReconciliation(input: {
  survivorId: string;
  // The duplicate's own findings, every status (historical rows can never
  // collide -- they're outside the active-uniqueness constraint -- so only
  // current/unverified ones actually need the collision check; pass all of
  // them and this function narrows itself, so callers don't have to).
  duplicateFindings: Array<FindingRef & { status: "current" | "superseded" | "removed_not_found" | "unverified" }>;
  // The survivor's own current/unverified findings only.
  survivorActiveFindings: FindingRef[];
  // Other donors' current/unverified findings whose related_donor_id is
  // the duplicate.
  referencingActiveFindings: ReferencingFinding[];
  // For every donorId appearing in referencingActiveFindings: that donor's
  // own current/unverified findings (including the referencing finding
  // itself, before repointing).
  activeFindingsByDonor: Map<string, FindingRef[]>;
}): MergeResearchPlan {
  const activeDuplicateFindings = input.duplicateFindings.filter((finding) => finding.status === "current" || finding.status === "unverified");

  const findingRepoints: string[] = [];
  const findingSupersessions: MergeResearchPlan["findingSupersessions"] = [];
  for (const finding of activeDuplicateFindings) {
    const collision = input.survivorActiveFindings.find((existing) => existing.fingerprint === finding.fingerprint);
    if (collision) findingSupersessions.push({ loserId: finding.id, winnerId: collision.id });
    else findingRepoints.push(finding.id);
  }

  const relatedDonorRepoints: MergeResearchPlan["relatedDonorRepoints"] = [];
  const relatedDonorSupersessions: MergeResearchPlan["relatedDonorSupersessions"] = [];
  for (const referencing of input.referencingActiveFindings) {
    const newFingerprint = computeFindingFingerprint({ category: referencing.category, claim: referencing.claim, relatedDonorId: input.survivorId });
    const ownerActiveFindings = input.activeFindingsByDonor.get(referencing.donorId) ?? [];
    const collision = ownerActiveFindings.find((existing) => existing.fingerprint === newFingerprint && existing.id !== referencing.id);
    if (collision) relatedDonorSupersessions.push({ loserId: referencing.id, winnerId: collision.id, newFingerprint });
    else relatedDonorRepoints.push({ findingId: referencing.id, newFingerprint });
  }

  return { findingRepoints, findingSupersessions, relatedDonorRepoints, relatedDonorSupersessions };
}
