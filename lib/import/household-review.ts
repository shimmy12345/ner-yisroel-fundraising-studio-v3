import type { JlFieldDecision, JlMatch } from "./jl-match.ts";

export const HOUSEHOLD_REVIEW_MODES = ["review_every", "changes_only", "auto_unchanged"] as const;
export type HouseholdReviewMode = typeof HOUSEHOLD_REVIEW_MODES[number];
export type ExistingDonorDecisionAction = "continue" | "accept_all" | "keep_current" | "field_by_field";
export type ExistingDonorDecision = { externalId: string; action: ExistingDonorDecisionAction; signature: string };

export function validHouseholdReviewMode(value: unknown): value is HouseholdReviewMode {
  return typeof value === "string" && HOUSEHOLD_REVIEW_MODES.includes(value as HouseholdReviewMode);
}

export function householdReviewSignature(match: JlMatch) {
  return JSON.stringify(match.comparisons.map(({ field, currentValue, jlValue }) => [field, currentValue, jlValue]));
}

export function buildExistingDonorReviews(matches: JlMatch[], mode: HouseholdReviewMode) {
  return matches.filter((match) => match.existing && (mode === "review_every" || match.changes.length > 0)).map((match) => ({
    externalId: match.donor.donorCode ?? "",
    donorName: match.donor.name,
    changed: match.changes.length > 0,
    localOverrideCount: match.conflicts.length,
    signature: householdReviewSignature(match),
    comparisons: match.comparisons,
  }));
}

export function resolveReviewedJlUpdates(match: JlMatch, mode: HouseholdReviewMode, decision: ExistingDonorDecision | undefined, fieldDecisions: JlFieldDecision[]) {
  if (!match.existing) return { updates: {}, error: null as string | null };
  const needsReview = mode === "review_every" || match.changes.length > 0;
  if (!needsReview) return { updates: {}, error: null as string | null };
  if (!decision || decision.externalId.toLowerCase() !== (match.donor.donorCode ?? "").toLowerCase()) return { updates: {}, error: "This donor still needs review." };
  if (decision.signature !== householdReviewSignature(match)) return { updates: {}, error: "This donor changed after the preview. Refresh the preview before importing." };
  if (!match.changes.length) return decision.action === "continue" ? { updates: {}, error: null } : { updates: {}, error: "An unchanged donor must be continued from its review card." };
  if (decision.action === "accept_all") return { updates: Object.fromEntries(match.changes.map((change) => [change.field, change.jlValue || null])), error: null };
  if (decision.action === "keep_current") return { updates: {}, error: null };
  if (decision.action !== "field_by_field") return { updates: {}, error: "Choose how to handle this donor's changed values." };
  const decisions = new Map(fieldDecisions.filter((item) => item.externalId.toLowerCase() === decision.externalId.toLowerCase()).map((item) => [item.field, item.action]));
  if (match.changes.some((change) => !decisions.has(change.field))) return { updates: {}, error: "Choose a value for every changed field." };
  return { updates: Object.fromEntries(match.changes.filter((change) => decisions.get(change.field) === "use_jl").map((change) => [change.field, change.jlValue || null])), error: null };
}
