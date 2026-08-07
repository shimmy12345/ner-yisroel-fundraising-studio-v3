import type { DonationPreview, GivingActivity } from "./jl-donations.ts";

export type RejectedRowCategory = "duplicate_transaction_id" | "unmatched_jl_code" | "nonfinancial_entry";
export type RejectionSeverity = "hard" | "reviewable";

export type RejectedRow = {
  fingerprint: string;
  row: number;
  category: RejectedRowCategory;
  severity: RejectionSeverity;
  reason: string;
  donor: string | null;
  jlCode: string | null;
  campaign: string | null;
  date: number | null;
  amountCents: number | null;
  // The in-file row this one duplicates, when known (duplicate_transaction_id only).
  existingMatchRow: number | null;
};

// Hard rejections have no safe resolution -- nothing the user can decide
// changes whether the row is structurally re-importable, so no actions are
// ever offered for them. Reviewable rejections have a real decision that
// can safely resolve the row (attach a donor, or accept a $0/nonfinancial
// entry on purpose).
export function buildRejectedRows(duplicateRows: DonationPreview["duplicateRows"], unknownActivities: GivingActivity[], nonfinancialActivities: GivingActivity[]): RejectedRow[] {
  const hard: RejectedRow[] = duplicateRows.map((item) => ({
    fingerprint: item.fingerprint,
    row: item.row,
    category: "duplicate_transaction_id",
    severity: "hard",
    reason: "This transaction ID was already used earlier in this same file, so it cannot be imported again.",
    donor: item.donor || null,
    jlCode: item.jlCode || null,
    campaign: item.campaign || null,
    date: item.date,
    amountCents: item.amountCents,
    existingMatchRow: item.originalRow,
  }));
  const unmatched: RejectedRow[] = unknownActivities.map((activity) => ({
    fingerprint: activity.fingerprint,
    row: activity.rowNumber,
    category: "unmatched_jl_code",
    severity: "reviewable",
    reason: `JL Code "${activity.externalHouseholdId || "(blank)"}" does not match any imported household.`,
    donor: activity.sourceName || null,
    jlCode: activity.externalHouseholdId || null,
    campaign: activity.sourceCampaign || null,
    date: activity.activityDate,
    amountCents: activity.committedCents,
    existingMatchRow: null,
  }));
  const nonfinancial: RejectedRow[] = nonfinancialActivities.map((activity) => ({
    fingerprint: activity.fingerprint,
    row: activity.rowNumber,
    category: "nonfinancial_entry",
    severity: "reviewable",
    reason: "Zero-dollar, complimentary, or included entry -- excluded from giving history by default.",
    donor: activity.sourceName || null,
    jlCode: activity.externalHouseholdId || null,
    campaign: activity.sourceCampaign || null,
    date: activity.activityDate,
    amountCents: activity.committedCents,
    existingMatchRow: null,
  }));
  return [...hard, ...unmatched, ...nonfinancial].sort((a, b) => a.row - b.row);
}

export type RejectionDecisionAction = "import_anyway" | "match_donor" | "skip" | "review_later";
export type RejectionDecision = { fingerprint: string; action: RejectionDecisionAction; donorId?: string; correctedJlCode?: string };

export type RejectionEdit = { fingerprint: string; field: string; originalValue: string; correctedValue: string };

export type RejectionResolution = {
  approvedActivities: Array<GivingActivity & { donorId: string }>;
  // Reviewable rows with no valid decision -- either nothing was chosen, or
  // "Match donor"/"Import anyway" was chosen but could not actually resolve
  // (e.g. a corrected code that still matches no household). These must
  // block commit; a decision is only "resolved" once it is actually safe.
  unresolvedFingerprints: string[];
  edits: RejectionEdit[];
};

// householdByCode must be pre-merged with any additional households looked
// up for corrected JL codes -- this function never queries the database.
export function resolveRejectionDecisions(unknownActivities: GivingActivity[], nonfinancialActivities: GivingActivity[], decisions: RejectionDecision[], householdByCode: Map<string, string>): RejectionResolution {
  const decisionByFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const approvedActivities: RejectionResolution["approvedActivities"] = [];
  const unresolvedFingerprints: string[] = [];
  const edits: RejectionEdit[] = [];

  for (const activity of unknownActivities) {
    const decision = decisionByFingerprint.get(activity.fingerprint);
    if (!decision || decision.action !== "match_donor") { if (!decision) unresolvedFingerprints.push(activity.fingerprint); continue; }
    const correctedCode = decision.correctedJlCode?.trim();
    const donorId = decision.donorId || (correctedCode ? householdByCode.get(correctedCode.toLowerCase()) : householdByCode.get(activity.externalHouseholdId.toLowerCase()));
    if (!donorId) { unresolvedFingerprints.push(activity.fingerprint); continue; }
    if (correctedCode && correctedCode.toLowerCase() !== activity.externalHouseholdId.toLowerCase()) {
      edits.push({ fingerprint: activity.fingerprint, field: "JL Code", originalValue: activity.externalHouseholdId, correctedValue: correctedCode });
    }
    approvedActivities.push({
      ...activity,
      donorId,
      externalHouseholdId: correctedCode || activity.externalHouseholdId,
      sourceValues: correctedCode ? { ...activity.sourceValues, fundraisingOsCorrectedJlCode: correctedCode } : activity.sourceValues,
    });
  }

  for (const activity of nonfinancialActivities) {
    const decision = decisionByFingerprint.get(activity.fingerprint);
    if (!decision || decision.action !== "import_anyway") { if (!decision) unresolvedFingerprints.push(activity.fingerprint); continue; }
    const donorId = householdByCode.get(activity.externalHouseholdId.toLowerCase());
    if (!donorId) { unresolvedFingerprints.push(activity.fingerprint); continue; }
    approvedActivities.push({ ...activity, donorId });
  }

  return { approvedActivities, unresolvedFingerprints, edits };
}
