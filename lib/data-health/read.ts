import { env } from "cloudflare:workers";
import {
  ACTIVE_DONORS_SQL,
  BROKEN_MERGE_REDIRECTS_SQL,
  BUSINESS_RECORD_COUNTS_SQL,
  DUPLICATE_GIVING_FINGERPRINTS_SQL,
  DUPLICATE_JL_CODES_SQL,
  FAILED_IMPORTS_SQL,
  GIVING_RECONCILIATION_SQL,
  IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL,
  LAST_BACKUP_SQL,
  LATEST_DONATION_REVIEW_SQL,
  ORPHANED_GIFTS_SQL,
  ORPHANED_INTERACTIONS_SQL,
  ORPHANED_PAYMENTS_SQL,
  ORPHANED_REMINDERS_SQL,
  REFRESH_STATE_SQL,
} from "./queries";
import { countPendingPaymentDecisions, countReviewLaterDecisions } from "../import/preview-session";
import {
  APP_VERSION,
  MIGRATION_LEDGER_COMPLETE,
  LEDGERED_MIGRATION_TAGS,
  buildDataHealthReport,
  inferMigrationLevel,
  migrationLevelFromTags,
  reconcileRemoteMigrationTags,
  schemaIsReady,
  type BackupAttemptStatus,
  type BackupSuccessStatus,
  type DataHealthFacts,
  type DataHealthReport,
  type RestoreAttemptStatus,
  type RestoreSuccessStatus,
} from "./model";
import { readRemoteMigrationHistory } from "./remote-migrations";
import { ACCOUNT_CONFIGURATION_COUNT_SQL, BUSINESS_DATA_COUNT_SQL, FUNDRAISING_DATA_COUNT_SQL, PRODUCTION_BASELINE_HASH, PRODUCTION_BASELINE_LEVEL, PRODUCTION_BASELINE_VERIFIED, compareSchemaObjects, stagingSchemaObjects } from "./production-baseline";
import { deploymentEnvironment } from "../environment";

type QueryResult = { results?: Array<Record<string, unknown>> };

// Validates the shape of a status object read back from the status-worker
// without trusting it -- this is data from outside this process (via a
// service binding, but still: a separate deployable with its own release
// cycle). Never guesses a partially-valid object into a used one; an
// object missing/mistyping any required field is treated as absent, the
// same as if it had never been read at all.
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function asBackupSuccess(value: unknown): BackupSuccessStatus | null {
  const v = value as Record<string, unknown> | null;
  if (!v || !isNonEmptyString(v.databaseName) || !isNonEmptyString(v.completedAt) || !isNonEmptyString(v.backupObjectKey) || !isNonEmptyString(v.workflowRunUrl)) return null;
  return { schemaVersion: Number(v.schemaVersion) || 1, databaseName: v.databaseName, completedAt: v.completedAt, backupObjectKey: v.backupObjectKey, workflowRunId: String(v.workflowRunId ?? ""), workflowRunUrl: v.workflowRunUrl };
}
function asBackupAttempt(value: unknown): BackupAttemptStatus | null {
  const v = value as Record<string, unknown> | null;
  if (!v || !isNonEmptyString(v.databaseName) || !isNonEmptyString(v.attemptAt) || !isNonEmptyString(v.attemptStatus) || !isNonEmptyString(v.workflowRunUrl)) return null;
  return { schemaVersion: Number(v.schemaVersion) || 1, databaseName: v.databaseName, attemptAt: v.attemptAt, attemptStatus: v.attemptStatus, workflowRunId: String(v.workflowRunId ?? ""), workflowRunUrl: v.workflowRunUrl };
}
// verifiedLatestObjectKey is required (the workflow always knows which
// pointer it targeted). verifiedBackupObjectKey/verifiedBackupCompletedAt
// are each independently optional -- a status object that omits them, or
// sets them to something other than a non-empty string, is read as
// "identity unknown for this run" (both null) rather than rejecting the
// whole object or guessing a partial identity from just one of the two
// fields.
function asRestoreSuccess(value: unknown): RestoreSuccessStatus | null {
  const v = value as Record<string, unknown> | null;
  if (!v || !isNonEmptyString(v.databaseName) || !isNonEmptyString(v.completedAt) || !isNonEmptyString(v.verifiedLatestObjectKey) || !isNonEmptyString(v.workflowRunUrl)) return null;
  const identityKnown = isNonEmptyString(v.verifiedBackupObjectKey) && isNonEmptyString(v.verifiedBackupCompletedAt);
  return {
    schemaVersion: Number(v.schemaVersion) || 1,
    databaseName: v.databaseName,
    completedAt: v.completedAt,
    verifiedLatestObjectKey: v.verifiedLatestObjectKey,
    verifiedBackupObjectKey: identityKnown ? (v.verifiedBackupObjectKey as string) : null,
    verifiedBackupCompletedAt: identityKnown ? (v.verifiedBackupCompletedAt as string) : null,
    workflowRunId: String(v.workflowRunId ?? ""),
    workflowRunUrl: v.workflowRunUrl,
  };
}
const asRestoreAttempt: (value: unknown) => RestoreAttemptStatus | null = asBackupAttempt;

// Fetches the four backup/restore status objects from the dedicated
// status-worker (Worker-to-Worker service binding -- see
// wrangler.staging.jsonc's `services` entry and status-worker/). Never
// throws: any failure (binding absent, network error, non-200, malformed
// JSON) is reported as "unreachable", never as "healthy" and never
// re-thrown into the caller's own broader D1-failure handling -- a status-
// worker problem must not take down the rest of the health report.
// Exported for reuse by the Backup Scheduling Reliability Stage 3 email
// alert (lib/backup-alert/) -- the identical STATUS_WORKER read/validate
// this file's own report already needed, not a second implementation.
export async function fetchBackupStatus(): Promise<Pick<DataHealthFacts, "backupStatusReachable" | "backupSuccess" | "backupAttempt" | "restoreSuccess" | "restoreAttempt">> {
  const unreachable = { backupStatusReachable: false, backupSuccess: null, backupAttempt: null, restoreSuccess: null, restoreAttempt: null };
  if (!env.STATUS_WORKER) return unreachable;
  try {
    const response = await env.STATUS_WORKER.fetch(new Request("https://status-worker.internal/status"));
    if (!response.ok) return unreachable;
    const body = (await response.json()) as { backup?: { success?: unknown; attempt?: unknown }; restore?: { success?: unknown; attempt?: unknown } };
    return {
      backupStatusReachable: true,
      backupSuccess: asBackupSuccess(body?.backup?.success),
      backupAttempt: asBackupAttempt(body?.backup?.attempt),
      restoreSuccess: asRestoreSuccess(body?.restore?.success),
      restoreAttempt: asRestoreAttempt(body?.restore?.attempt),
    };
  } catch {
    return unreachable;
  }
}

const deployedCommit = typeof __FUNDRAISING_OS_COMMIT__ === "string" && __FUNDRAISING_OS_COMMIT__.trim()
  ? __FUNDRAISING_OS_COMMIT__.trim()
  : null;
// The independent staging Worker is bootstrapped from the same verified
// baseline as production and carries a live production_schema_baseline
// marker, so it is checked the same way. Only legacy (ChatGPT Sites)
// staging is structurally exempt.
const checksLiveBaseline = deploymentEnvironment === "production" || deploymentEnvironment === "staging-independent";

const emptyFacts = (): DataHealthFacts => ({
  deploymentEnvironment,
  databaseConnected: false,
  schemaReady: false,
  currentMigrationLevel: null,
  migrationLedgerComplete: MIGRATION_LEDGER_COMPLETE,
  journalMigrationLevel: migrationLevelFromTags(LEDGERED_MIGRATION_TAGS),
  remoteMigrationLevel: null,
  remoteMigrationTable: null,
  remoteMigrationHistoryComplete: false,
  remoteMigrationHistoryConsistent: false,
  remoteMigrationDiagnosticLines: ["Remote migration history has not been verified."],
  productionBaselineLevel: PRODUCTION_BASELINE_LEVEL,
  productionBaselineVerified: PRODUCTION_BASELINE_VERIFIED,
  productionBaselineApplied: deploymentEnvironment === "staging",
  productionBaselineState: checksLiveBaseline ? "unreadable" : "not-applicable",
  productionBaselineEvidenceSource: checksLiveBaseline ? "Live query against this environment's D1 binding did not complete." : "Not evaluated: this request is not against an environment with a live baseline marker.",
  productionBaselineVerifiedAt: null,
  schemaMatchesBaseline: false,
  schemaComparisonDifferences: ["The staging schema has not been compared with the production baseline."],
  businessDataRows: null,
  fundraisingDataRows: null,
  accountConfigurationRows: null,
  businessRecordCounts: null,
  activeDonors: null,
  duplicateJlCodes: null,
  orphanedGifts: null,
  orphanedInteractions: null,
  orphanedReminders: null,
  orphanedPayments: null,
  brokenMergeRedirects: null,
  givingSourceTotalCents: null,
  givingLinkedTotalCents: null,
  invalidGivingRows: null,
  duplicateGivingFingerprints: null,
  unmatchedJlCodes: null,
  pendingPledgeAssignments: null,
  savedForLaterReviewRows: null,
  unresolvedActiveDrafts: null,
  failedOrIncompleteImports: null,
  lastHouseholdRefreshAt: null,
  lastDonationRefreshAt: null,
  lastManualExportAt: null,
  backupStatusReachable: false,
  backupSuccess: null,
  backupAttempt: null,
  restoreSuccess: null,
  restoreAttempt: null,
  appVersion: APP_VERSION,
  deployedCommit,
});

const rows = (result: QueryResult | undefined) => result?.results ?? [];
const first = (result: QueryResult | undefined) => rows(result)[0] ?? {};
const number = (value: unknown, fallback: number | null = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export async function loadDataHealth(userId: string): Promise<DataHealthReport> {
  const facts = emptyFacts();
  // Independent of the D1-backed facts below and of each other's success:
  // fetched first, outside the main try/catch, so a status-worker problem
  // can never suppress the rest of this report (nor vice versa -- a D1
  // problem below must not discard an already-fetched backup status).
  Object.assign(facts, await fetchBackupStatus());
  try {
    const schemaResults = await env.DB.batch([
      env.DB.prepare("SELECT 1 AS connected"),
      env.DB.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name"),
      env.DB.prepare("PRAGMA table_info('users')"),
      env.DB.prepare("PRAGMA table_info('donors')"),
      env.DB.prepare("PRAGMA table_info('giving_activities')"),
      // Returns no rows (not an error) if the table doesn't exist yet --
      // safe on an environment that predates migration 0021.
      env.DB.prepare("PRAGMA table_info('import_preview_sessions')"),
    ]) as unknown as QueryResult[];
    facts.databaseConnected = number(first(schemaResults[0]).connected) === 1;
    const tableNames = rows(schemaResults[1]).filter((row) => row.type === "table").map((row) => String(row.name ?? ""));
    const schemaComparison = compareSchemaObjects(stagingSchemaObjects(rows(schemaResults[1])));
    facts.schemaMatchesBaseline = schemaComparison.matches;
    facts.schemaComparisonDifferences = schemaComparison.differences;
    const userColumns = rows(schemaResults[2]).map((row) => String(row.name ?? ""));
    const donorColumns = rows(schemaResults[3]).map((row) => String(row.name ?? ""));
    const givingColumns = rows(schemaResults[4]).map((row) => String(row.name ?? ""));
    const importPreviewSessionColumns = rows(schemaResults[5]).map((row) => String(row.name ?? ""));
    facts.currentMigrationLevel = inferMigrationLevel(tableNames, userColumns, donorColumns, givingColumns, importPreviewSessionColumns);
    facts.schemaReady = schemaIsReady(tableNames, userColumns, donorColumns, givingColumns);
    if (checksLiveBaseline) {
      if (!tableNames.includes("production_schema_baseline")) {
        // A genuinely new D1 never carries this marker until the baseline
        // SQL is applied to it directly — this is expected, not an error,
        // and must read as "not yet applied", never "Failed".
        facts.productionBaselineState = "not-applied";
        facts.productionBaselineApplied = false;
        facts.productionBaselineEvidenceSource = "Live query against this environment's D1 binding: no production_schema_baseline table exists.";
      } else {
        try {
          const marker = await env.DB.prepare("SELECT schema_hash, created_at FROM production_schema_baseline WHERE id = '0019'").first<{ schema_hash?: string; created_at?: number }>();
          const verified = marker?.schema_hash === PRODUCTION_BASELINE_HASH;
          facts.productionBaselineState = verified ? "verified" : "hash-mismatch";
          facts.productionBaselineApplied = verified;
          facts.productionBaselineEvidenceSource = "Live query against this environment's D1 binding (production_schema_baseline table, id '0019').";
          facts.productionBaselineVerifiedAt = marker?.created_at ? new Date(marker.created_at * 1000).toISOString() : null;
        } catch {
          // The table exists but the row could not be read — this is
          // genuinely unknown, not a confirmed failure. Never fold this into
          // the same "Failed" bucket as a real hash mismatch.
          facts.productionBaselineState = "unreadable";
          facts.productionBaselineApplied = false;
          facts.productionBaselineEvidenceSource = "Live query against production_schema_baseline failed (connection or query error) after the table was found.";
        }
      }
    }
    const remoteHistory = await readRemoteMigrationHistory(env.DB);
    const remoteReconciliation = reconcileRemoteMigrationTags(remoteHistory.entries.map((entry) => entry.tag));
    facts.remoteMigrationLevel = remoteReconciliation.level;
    facts.remoteMigrationTable = remoteHistory.tableName;
    facts.remoteMigrationHistoryComplete = remoteReconciliation.complete;
    facts.remoteMigrationHistoryConsistent = remoteReconciliation.consistent;
    facts.remoteMigrationDiagnosticLines = remoteHistory.diagnostic ? [remoteHistory.diagnostic] : remoteReconciliation.diagnostics;
    if (!facts.schemaReady) return buildDataHealthReport(facts);

    facts.businessDataRows = number((await env.DB.prepare(BUSINESS_DATA_COUNT_SQL).first<{ count?: number }>())?.count, null);
    facts.fundraisingDataRows = number((await env.DB.prepare(FUNDRAISING_DATA_COUNT_SQL).first<{ count?: number }>())?.count, null);
    facts.accountConfigurationRows = number((await env.DB.prepare(ACCOUNT_CONFIGURATION_COUNT_SQL).first<{ count?: number }>())?.count, null);
    const businessRecordCounts = await env.DB.prepare(BUSINESS_RECORD_COUNTS_SQL).bind(userId, userId, userId, userId).first<{ donors?: number; giving_activities?: number; interactions?: number; reminders?: number }>();
    facts.businessRecordCounts = businessRecordCounts ? {
      donors: number(businessRecordCounts.donors) ?? 0,
      givingActivities: number(businessRecordCounts.giving_activities) ?? 0,
      interactions: number(businessRecordCounts.interactions) ?? 0,
      reminders: number(businessRecordCounts.reminders) ?? 0,
    } : null;

    // Real pending-assignment/import-review-state facts, computed from
    // active draft sessions rather than a completed import's frozen
    // report_json. import_preview_sessions may not exist yet on an
    // environment that predates migration 0021 -- tableNames already told
    // us that, so this is skipped cleanly rather than throwing.
    if (tableNames.includes("import_preview_sessions")) {
      const now = Math.floor(Date.now() / 1000);
      const sessions = (await env.DB.prepare(IMPORT_PREVIEW_SESSIONS_FOR_HEALTH_SQL).bind(userId).all<{ status: string; decisions_json: string; expires_at: number }>()).results ?? [];
      const activeDrafts = sessions.filter((session) => session.status === "draft" && session.expires_at > now);
      facts.unresolvedActiveDrafts = activeDrafts.length;
      facts.pendingPledgeAssignments = activeDrafts.reduce((sum, session) => sum + countPendingPaymentDecisions(session.decisions_json), 0);
      const committedSessions = sessions.filter((session) => session.status === "committed");
      facts.savedForLaterReviewRows = committedSessions.reduce((sum, session) => sum + countReviewLaterDecisions(session.decisions_json), 0);
    } else {
      facts.unresolvedActiveDrafts = 0;
      facts.pendingPledgeAssignments = 0;
      facts.savedForLaterReviewRows = 0;
    }

    const healthResults = await env.DB.batch([
      env.DB.prepare(ACTIVE_DONORS_SQL).bind(userId),
      env.DB.prepare(DUPLICATE_JL_CODES_SQL).bind(userId),
      env.DB.prepare(ORPHANED_GIFTS_SQL).bind(userId),
      env.DB.prepare(ORPHANED_INTERACTIONS_SQL).bind(userId, userId),
      env.DB.prepare(ORPHANED_REMINDERS_SQL).bind(userId, userId),
      env.DB.prepare(ORPHANED_PAYMENTS_SQL).bind(userId, userId, userId),
      env.DB.prepare(BROKEN_MERGE_REDIRECTS_SQL).bind(userId, userId),
      env.DB.prepare(GIVING_RECONCILIATION_SQL).bind(userId, userId),
      env.DB.prepare(DUPLICATE_GIVING_FINGERPRINTS_SQL).bind(userId),
      env.DB.prepare(LATEST_DONATION_REVIEW_SQL).bind(userId),
      env.DB.prepare(FAILED_IMPORTS_SQL).bind(userId),
      env.DB.prepare(REFRESH_STATE_SQL).bind(userId),
      env.DB.prepare(LAST_BACKUP_SQL).bind(userId),
    ]) as unknown as QueryResult[];

    const giving = first(healthResults[7]);
    const latestDonation = first(healthResults[9]);
    const refresh = first(healthResults[11]);
    facts.activeDonors = number(first(healthResults[0]).count);
    facts.duplicateJlCodes = number(first(healthResults[1]).count);
    facts.orphanedGifts = number(first(healthResults[2]).count);
    facts.orphanedInteractions = number(first(healthResults[3]).count);
    facts.orphanedReminders = number(first(healthResults[4]).count);
    facts.orphanedPayments = number(first(healthResults[5]).count);
    facts.brokenMergeRedirects = number(first(healthResults[6]).count);
    facts.givingSourceTotalCents = number(giving.source_total_cents);
    facts.givingLinkedTotalCents = number(giving.linked_total_cents);
    facts.invalidGivingRows = number(giving.invalid_rows);
    facts.duplicateGivingFingerprints = number(first(healthResults[8]).count);
    facts.unmatchedJlCodes = number(latestDonation.unmatched_jl_codes);
    facts.failedOrIncompleteImports = number(first(healthResults[10]).count);
    facts.lastHouseholdRefreshAt = number(refresh.last_household_refresh_at, null);
    facts.lastDonationRefreshAt = number(refresh.last_donation_refresh_at, null);
    facts.lastManualExportAt = number(first(healthResults[12]).created_at, null);
    return buildDataHealthReport(facts);
  } catch {
    return buildDataHealthReport(facts);
  }
}
