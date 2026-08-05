export type HealthStatus = "healthy" | "attention" | "critical" | "info" | "unavailable";

export type HealthCheck = {
  id: string;
  label: string;
  status: HealthStatus;
  value: string;
  explanation: string;
  actionHref?: string;
  actionLabel?: string;
  diagnosticLines?: string[];
};

export type DataHealthFacts = {
  databaseConnected: boolean;
  schemaReady: boolean;
  currentMigrationLevel: string | null;
  migrationLedgerComplete: boolean;
  activeDonors: number | null;
  duplicateJlCodes: number | null;
  orphanedGifts: number | null;
  orphanedInteractions: number | null;
  orphanedReminders: number | null;
  orphanedPayments: number | null;
  brokenMergeRedirects: number | null;
  givingSourceTotalCents: number | null;
  givingLinkedTotalCents: number | null;
  invalidGivingRows: number | null;
  duplicateGivingFingerprints: number | null;
  unmatchedJlCodes: number | null;
  pendingPledgeAssignments: number | null;
  failedOrIncompleteImports: number | null;
  lastHouseholdRefreshAt: number | null;
  lastDonationRefreshAt: number | null;
  lastBackupAt: number | null;
  appVersion: string;
  deployedCommit: string | null;
};

export type DataHealthReport = {
  status: "healthy" | "attention" | "critical";
  checkedAt: string;
  summary: string;
  checks: HealthCheck[];
  platform: {
    migrationLevel: string;
    expectedMigrationLevel: string;
    ledgerComplete: boolean;
    appVersion: string;
    deployedCommit: string | null;
  };
};

export const EXPECTED_MIGRATION_LEVEL = "0019";
export const APP_VERSION = "0.1.0";

export const EXPECTED_MIGRATION_TAGS = [
  "0000_foundation",
  "0001_staging_sample_data",
  "0002_onboarding_import",
  "0003_jl_donation_import",
  "0004_personalization_live_data",
  "0005_verification_data_integrity",
  "0006_activity_status_audit",
  "0007_incremental_jl_refresh",
  "0008_manual_pledge_payment_assignment",
  "0009_donation_import_rollback_audit",
  "0010_manual_pledge_assignment_audit",
  "0011_reimport_and_payment_timeline",
  "0012_donor_contact_management",
  "0013_household_refresh_integrity",
  "0014_donor_merge_resolution",
  "0015_household_import_review_mode",
  "0016_lightweight_donation_management",
  "0017_today_relationship_queue",
  "0018_data_health_repairs",
  "0019_legacy_test_orphan_cleanup",
] as const;

// This mirrors drizzle/meta/_journal.json. Keeping the known gap visible is
// intentional: Data Health must report it until the deployment migration
// contract is repaired and rehearsed, rather than presenting a false green.
export const LEDGERED_MIGRATION_TAGS = EXPECTED_MIGRATION_TAGS.slice(0, 14);

export const MIGRATION_LEDGER_COMPLETE =
  LEDGERED_MIGRATION_TAGS.length === EXPECTED_MIGRATION_TAGS.length &&
  EXPECTED_MIGRATION_TAGS.every((tag, index) => LEDGERED_MIGRATION_TAGS[index] === tag);

export const MISSING_LEDGER_MIGRATIONS = EXPECTED_MIGRATION_TAGS.filter((tag) => !LEDGERED_MIGRATION_TAGS.includes(tag));

const numberValue = (value: number | null) => value === null ? "Unavailable" : value.toLocaleString("en-US");

function countCheck(
  id: string,
  label: string,
  count: number | null,
  explanation: string,
  actionHref?: string,
  actionLabel?: string,
): HealthCheck {
  if (count === null) return { id, label, status: "unavailable", value: "Not checked", explanation: "This check needs the complete database schema before it can run." };
  return {
    id,
    label,
    status: count === 0 ? "healthy" : "critical",
    value: numberValue(count),
    explanation: count === 0 ? "No issue detected." : explanation,
    ...(count > 0 && actionHref ? { actionHref, actionLabel } : {}),
  };
}

function timestampCheck(id: string, label: string, timestamp: number | null, hasData: boolean, kind: "refresh" | "backup"): HealthCheck {
  if (timestamp) {
    const date = new Date(timestamp * 1000);
    if (Number.isFinite(date.getTime())) return { id, label, status: "healthy", value: date.toISOString(), explanation: kind === "backup" ? "A successful workspace backup is recorded." : "A successful JL refresh is recorded." };
  }
  if (!hasData && kind === "refresh") return { id, label, status: "info", value: "Not yet", explanation: "No JL refresh is expected in a new or manual-only workspace." };
  return {
    id,
    label,
    status: "attention",
    value: "Not recorded",
    explanation: kind === "backup" ? "Download a current workspace backup before high-risk imports or repairs." : "No successful refresh has been recorded for this live workspace.",
    actionHref: kind === "backup" ? "/api/import/backup" : "/onboarding/import",
    actionLabel: kind === "backup" ? "Download backup" : "Open data import",
  };
}

export function buildDataHealthReport(facts: DataHealthFacts, checkedAt = new Date().toISOString()): DataHealthReport {
  const hasData = (facts.activeDonors ?? 0) > 0;
  const givingReady = [facts.givingSourceTotalCents, facts.givingLinkedTotalCents, facts.invalidGivingRows, facts.duplicateGivingFingerprints].every((value) => value !== null);
  const givingHealthy = givingReady && facts.givingSourceTotalCents === facts.givingLinkedTotalCents && facts.invalidGivingRows === 0 && facts.duplicateGivingFingerprints === 0;
  const checks: HealthCheck[] = [
    {
      id: "database",
      label: "Database connection",
      status: facts.databaseConnected ? "healthy" : "critical",
      value: facts.databaseConnected ? "Connected" : "Unavailable",
      explanation: facts.databaseConnected ? "Fundraising OS can read the D1 workspace." : "Fundraising OS could not read D1. No workspace integrity checks were completed.",
    },
    {
      id: "migrations",
      label: "Database migrations",
      status: facts.schemaReady && facts.migrationLedgerComplete ? "healthy" : "critical",
      value: `${facts.currentMigrationLevel ?? "Unknown"} / ${EXPECTED_MIGRATION_LEVEL}`,
      explanation: !facts.schemaReady
        ? "The database is missing required tables or columns. Do not run imports until the schema is repaired."
        : facts.migrationLedgerComplete
          ? "The schema and migration ledger are complete."
          : "The live schema is ready, but the migration ledger does not include every packaged migration. Repair the release ledger before production launch.",
      diagnosticLines: facts.migrationLedgerComplete ? [] : MISSING_LEDGER_MIGRATIONS.map((tag) => `${tag} is packaged but missing from drizzle/meta/_journal.json.`),
    },
    {
      id: "active-donors",
      label: "Active donors",
      status: facts.activeDonors === null ? "unavailable" : "info",
      value: numberValue(facts.activeDonors),
      explanation: facts.activeDonors === null ? "The donor count could not be checked." : "Owner-scoped, active live relationships in this workspace.",
      actionHref: "/donors",
      actionLabel: "Open donor directory",
    },
    countCheck("duplicate-jl-codes", "Duplicate active JL Codes", facts.duplicateJlCodes, "More than one active relationship uses the same JL Code. Resolve duplicates before the next refresh.", "/onboarding/import", "Open import review"),
    countCheck("orphaned-gifts", "Orphaned gifts", facts.orphanedGifts, "Giving records remain attached to an archived relationship instead of its surviving donor.", "/onboarding/import", "Open import history"),
    countCheck("orphaned-interactions", "Orphaned interactions", facts.orphanedInteractions, "Interactions are missing an active donor relationship or point outside this workspace.", "/donors", "Open donor directory"),
    countCheck("orphaned-reminders", "Orphaned reminders", facts.orphanedReminders, "Reminders are missing an active donor relationship or point outside this workspace.", "/", "Open Today"),
    countCheck("orphaned-payments", "Orphaned pledge payments", facts.orphanedPayments, "A remembered pledge assignment no longer points to an active pledge for this owner.", "/onboarding/import", "Open import review"),
    countCheck("merge-redirects", "Broken merge redirects", facts.brokenMergeRedirects, "An archived duplicate cannot safely redirect to one active surviving donor.", "/donors", "Open donor directory"),
    {
      id: "giving-reconciliation",
      label: "Giving-total reconciliation",
      status: !givingReady ? "unavailable" : givingHealthy ? "healthy" : "critical",
      value: !givingReady ? "Not checked" : givingHealthy ? "Reconciled" : "Needs review",
      explanation: !givingReady
        ? "Giving totals need the complete database schema before they can be checked."
        : givingHealthy
          ? "Every counted live giving row belongs to an active donor, contains valid financial values, and has a unique source fingerprint."
          : "The owner total, active-donor total, financial validation, or source-fingerprint check does not agree. No amounts are shown here.",
      ...(!givingHealthy && givingReady ? { actionHref: "/onboarding/import", actionLabel: "Review giving imports" } : {}),
    },
    {
      id: "unmatched-jl-codes",
      label: "Unmatched JL Codes",
      status: facts.unmatchedJlCodes === null ? "unavailable" : facts.unmatchedJlCodes > 0 ? "attention" : "healthy",
      value: numberValue(facts.unmatchedJlCodes),
      explanation: facts.unmatchedJlCodes === null ? "The latest donation import could not be checked." : facts.unmatchedJlCodes > 0 ? "The latest donation import includes rows that did not match an active JL household." : "The latest donation import has no unmatched JL Codes.",
      ...(facts.unmatchedJlCodes !== null && facts.unmatchedJlCodes > 0 ? { actionHref: "/onboarding/import", actionLabel: "Review import report" } : {}),
    },
    {
      id: "pending-pledge-assignments",
      label: "Pending pledge assignments",
      status: facts.pendingPledgeAssignments === null ? "unavailable" : facts.pendingPledgeAssignments > 0 ? "attention" : "healthy",
      value: numberValue(facts.pendingPledgeAssignments),
      explanation: facts.pendingPledgeAssignments === null ? "Pledge-assignment review could not be checked." : facts.pendingPledgeAssignments > 0 ? "Donation rows from the latest import still require a classification or pledge decision." : "No pledge-assignment decisions are waiting from the latest donation import.",
      ...(facts.pendingPledgeAssignments !== null && facts.pendingPledgeAssignments > 0 ? { actionHref: "/onboarding/import", actionLabel: "Resolve assignments" } : {}),
    },
    {
      id: "failed-imports",
      label: "Failed or incomplete imports",
      status: facts.failedOrIncompleteImports === null ? "unavailable" : facts.failedOrIncompleteImports > 0 ? "attention" : "healthy",
      value: numberValue(facts.failedOrIncompleteImports),
      explanation: facts.failedOrIncompleteImports === null ? "Import history could not be checked." : facts.failedOrIncompleteImports > 0 ? "One or more imports failed, rolled back, or never reached completion. Completed and intentionally undone batches are not counted." : "No failed or incomplete import batches are recorded.",
      ...(facts.failedOrIncompleteImports !== null && facts.failedOrIncompleteImports > 0 ? { actionHref: "/onboarding/import", actionLabel: "Review import history" } : {}),
    },
    timestampCheck("household-refresh", "Last household refresh", facts.lastHouseholdRefreshAt, hasData, "refresh"),
    timestampCheck("donation-refresh", "Last donation refresh", facts.lastDonationRefreshAt, hasData, "refresh"),
    timestampCheck("backup", "Last successful backup", facts.lastBackupAt, hasData, "backup"),
    {
      id: "release",
      label: "Deployed version",
      status: facts.deployedCommit ? "healthy" : "attention",
      value: facts.deployedCommit ? `${facts.appVersion} · ${facts.deployedCommit.slice(0, 7)}` : facts.appVersion,
      explanation: facts.deployedCommit ? "This health report identifies the deployed application commit." : "The application version is available, but commit metadata was not injected into this build.",
    },
  ];

  const status = checks.some((check) => check.status === "critical")
    ? "critical"
    : checks.some((check) => check.status === "attention" || check.status === "unavailable")
      ? "attention"
      : "healthy";
  return {
    status,
    checkedAt,
    summary: status === "healthy" ? "Workspace data and the application foundation are healthy." : status === "critical" ? "One or more issues need attention before the workspace can be considered healthy." : "The workspace is usable, with follow-up items to review.",
    checks,
    platform: {
      migrationLevel: facts.currentMigrationLevel ?? "Unknown",
      expectedMigrationLevel: EXPECTED_MIGRATION_LEVEL,
      ledgerComplete: facts.migrationLedgerComplete,
      appVersion: facts.appVersion,
      deployedCommit: facts.deployedCommit,
    },
  };
}

export function inferMigrationLevel(tableNames: Iterable<string>, userColumns: Iterable<string>, donorColumns: Iterable<string>, givingColumns: Iterable<string>) {
  const tables = new Set(tableNames);
  const users = new Set(userColumns);
  const donors = new Set(donorColumns);
  const giving = new Set(givingColumns);
  if (tables.has("legacy_test_cleanup_audits")) return "0019";
  if (tables.has("data_health_repair_audits")) return "0018";
  if (tables.has("relationship_queue_dismissals") && tables.has("donor_views")) return "0017";
  if (tables.has("giving_activity_management_audits") && giving.has("workspace_status")) return "0016";
  if (users.has("household_import_review_mode")) return "0015";
  if (tables.has("donor_merge_audits") && donors.has("merged_into_donor_id")) return "0014";
  if (tables.has("household_import_changes")) return "0013";
  if (donors.has("archived_at")) return "0012";
  if (tables.has("jl_payment_assignment_audits")) return "0010";
  if (tables.has("workspace_backup_audits")) return "0009";
  if (tables.has("jl_payment_assignments")) return "0008";
  if (tables.has("jl_refresh_state")) return "0007";
  if (tables.has("activity_status_audits")) return "0006";
  if (tables.has("giving_activities")) return "0003";
  if (tables.has("data_imports")) return "0002";
  return tables.has("donors") ? "0000" : null;
}

export function schemaIsReady(tableNames: Iterable<string>, userColumns: Iterable<string>, donorColumns: Iterable<string>, givingColumns: Iterable<string>) {
  const tables = new Set(tableNames);
  const requiredTables = ["users", "donors", "gifts", "giving_activities", "interactions", "recommendations", "data_imports", "jl_refresh_state", "jl_payment_assignments", "donor_merge_audits", "workspace_backup_audits", "giving_activity_management_audits", "relationship_queue_dismissals", "donor_views", "data_health_repair_audits", "legacy_test_cleanup_audits"];
  return requiredTables.every((table) => tables.has(table))
    && new Set(userColumns).has("household_import_review_mode")
    && ["archived_at", "merged_into_donor_id"].every((column) => new Set(donorColumns).has(column))
    && ["workspace_status", "record_origin", "owner_user_id"].every((column) => new Set(givingColumns).has(column));
}
