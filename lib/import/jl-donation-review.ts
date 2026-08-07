import type { GivingActivity } from "./jl-donations.ts";

export type ReviewDecisionAction = "import_anyway" | "skip" | "review_later";
export type ReviewDecision = { fingerprint: string; groupKey?: string | null; action: ReviewDecisionAction };

export type ReviewResolution = {
  // Possible-duplicate rows explicitly approved for import, with their true
  // (pre-override) category restored so they classify exactly as they
  // would have without the duplicate flag.
  approvedActivities: GivingActivity[];
  // Possible-duplicate rows present in this preview with no decision at
  // all — must block commit ("Review later must write nothing" only holds
  // when it was an explicit choice, not a silently-missing one).
  unresolvedFingerprints: string[];
};

// Only "possible duplicate" rows are resolvable this way. Other needs_review
// reasons (missing code, invalid date, ambiguous amounts, missing payment
// status) lack the data to ever become importable, so a decision for them
// would have nothing to act on — they are intentionally excluded here and
// remain permanently excluded from the commit, exactly as before.
export function resolvePossibleDuplicateDecisions(activities: GivingActivity[], decisions: ReviewDecision[]): ReviewResolution {
  const byFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const byGroup = new Map(decisions.filter((decision) => decision.groupKey).map((decision) => [decision.groupKey!, decision]));
  const approvedActivities: GivingActivity[] = [];
  const unresolvedFingerprints: string[] = [];
  for (const activity of activities) {
    if (activity.duplicateStatus !== "possible_duplicate") continue;
    const decision = byFingerprint.get(activity.fingerprint) ?? (activity.duplicateGroupKey ? byGroup.get(activity.duplicateGroupKey) : undefined);
    if (!decision) { unresolvedFingerprints.push(activity.fingerprint); continue; }
    if (decision.action === "import_anyway") {
      approvedActivities.push({ ...activity, category: activity.underlyingCategory, reviewReason: null, duplicateStatus: null });
    }
    // "skip" and "review_later" both leave the row excluded from the
    // commit. The distinction is user-facing intent only — neither writes
    // anything for this row, matching "Review Later writes nothing".
  }
  return { approvedActivities, unresolvedFingerprints };
}
