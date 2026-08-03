export type ImportBatchStatus = "active" | "completed" | "undone" | "failed" | "rolled_back" | string;

export const ACTIVE_IMPORT_STATUSES = ["active", "completed"] as const;

export function blocksIdenticalImport(status: ImportBatchStatus) {
  return ACTIVE_IMPORT_STATUSES.includes(status as (typeof ACTIVE_IMPORT_STATUSES)[number]);
}

export function canForceReprocessBatch(authenticatedUserId: string, batchOwnerUserId: string) {
  return Boolean(authenticatedUserId) && authenticatedUserId === batchOwnerUserId;
}

export function hasForceReprocessConfirmation(forceReprocess: boolean, confirmation: string | undefined) {
  return !forceReprocess || confirmation === "FORCE REPROCESS";
}

export const ACTIVE_PAYMENT_ASSIGNMENTS_SQL = `SELECT jpa.payment_fingerprint, jpa.decision_type, jpa.pledge_activity_id, jpa.applied_import_id
  FROM jl_payment_assignments jpa
  INNER JOIN data_imports di ON di.id = jpa.applied_import_id AND di.user_id = jpa.user_id
  WHERE jpa.user_id = ? AND di.status IN ('active','completed')
    AND jpa.payment_fingerprint IN (SELECT value FROM json_each(?))`;
