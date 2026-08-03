export const LEGACY_HOUSEHOLD_BATCH_ID = "95f0c912-b57c-43de-be25-fbd2c082f052";

export type LegacyBatchRow = { id: string; file_name: string; status: string; report_json: string; created_at: number; completed_at: number | null };
export type LegacyCandidateRow = { id: string; display_name: string; last_name: string | null; donor_code: string | null; external_id: string | null; external_source: string | null; owner_user_id: string | null; data_source: string; created_at: number; updated_at: number };

function reportFirstRelationship(reportJson: string) {
  try { return (JSON.parse(reportJson) as { firstRelationshipId?: string | null }).firstRelationshipId ?? null; } catch { return null; }
}

export function buildLegacyHouseholdRepairAssessment(batch: LegacyBatchRow, candidates: LegacyCandidateRow[], changeCount: number, contactAuditCount: number) {
  const firstRelationshipId = reportFirstRelationship(batch.report_json);
  const completedAt = batch.completed_at;
  const assessed = candidates.map((donor) => {
    const evidence: string[] = [];
    if (donor.id === firstRelationshipId) evidence.push("The import report identifies this as the first processed relationship.");
    if (completedAt !== null && donor.created_at === completedAt) evidence.push("The donor row was created in the batch's completion second.");
    if (completedAt !== null && donor.updated_at === completedAt) evidence.push("The donor row was last updated in the batch's completion second.");
    return { donorId: donor.id, donorName: donor.display_name, storedLastName: donor.last_name, donorCode: donor.external_id || donor.donor_code, probableChange: completedAt !== null && donor.created_at === completedAt ? "possible_insert" as const : "possible_update" as const, evidence };
  }).filter((donor) => donor.evidence.length > 0);
  const automaticRepairSafe = changeCount > 0;
  const blockers = automaticRepairSafe ? [] : [
    "No household_import_changes rows record which donors this batch inserted or updated.",
    "No field-level before-values exist for restoring an updated donor.",
    contactAuditCount ? "Contact audit rows exist, but they do not prove complete batch attribution or all prior field values." : "No contact audit identifies field-level changes from this spreadsheet import.",
    "Matching timestamps are supporting evidence only and cannot safely authorize deletion or reversion.",
  ];
  return {
    batchId: batch.id, fileName: batch.file_name, status: batch.status, completedAt, automaticRepairSafe, exactAttributionProven: automaticRepairSafe,
    candidates: assessed, blockers,
    manualRepairPlan: automaticRepairSafe ? [] : [
      "Locate the original spreadsheet and a D1 backup created before this batch.",
      "Match rows by stable donor code and internal donor ID; do not use file name or timestamp as the deciding evidence.",
      "For a possible insert, prove the internal donor ID did not exist before the batch and inspect later linked activity before removal.",
      "For a possible update, restore only fields whose exact before-values are present in the pre-batch backup, preserving later edits.",
      "Record the approved changes in an audit entry and take a fresh D1 backup before applying them.",
    ],
  };
}
