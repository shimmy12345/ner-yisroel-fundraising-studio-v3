import { env } from "cloudflare:workers";
import {
  ACTIVE_DONORS_SQL,
  BROKEN_MERGE_REDIRECTS_SQL,
  DUPLICATE_GIVING_FINGERPRINTS_SQL,
  DUPLICATE_JL_CODES_SQL,
  FAILED_IMPORTS_SQL,
  GIVING_RECONCILIATION_SQL,
  LAST_BACKUP_SQL,
  LATEST_DONATION_REVIEW_SQL,
  ORPHANED_GIFTS_SQL,
  ORPHANED_INTERACTIONS_SQL,
  ORPHANED_PAYMENTS_SQL,
  ORPHANED_REMINDERS_SQL,
  REFRESH_STATE_SQL,
} from "./queries";
import {
  APP_VERSION,
  MIGRATION_LEDGER_COMPLETE,
  LEDGERED_MIGRATION_TAGS,
  buildDataHealthReport,
  inferMigrationLevel,
  migrationLevelFromTags,
  reconcileRemoteMigrationTags,
  schemaIsReady,
  type DataHealthFacts,
  type DataHealthReport,
} from "./model";
import { readRemoteMigrationHistory } from "./remote-migrations";
import { ACCOUNT_CONFIGURATION_COUNT_SQL, BUSINESS_DATA_COUNT_SQL, FUNDRAISING_DATA_COUNT_SQL, PRODUCTION_BASELINE_HASH, PRODUCTION_BASELINE_LEVEL, PRODUCTION_BASELINE_VERIFIED, compareSchemaObjects, stagingSchemaObjects } from "./production-baseline";
import { deploymentEnvironment } from "../environment";

type QueryResult = { results?: Array<Record<string, unknown>> };

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
  failedOrIncompleteImports: null,
  lastHouseholdRefreshAt: null,
  lastDonationRefreshAt: null,
  lastBackupAt: null,
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
  try {
    const schemaResults = await env.DB.batch([
      env.DB.prepare("SELECT 1 AS connected"),
      env.DB.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name"),
      env.DB.prepare("PRAGMA table_info('users')"),
      env.DB.prepare("PRAGMA table_info('donors')"),
      env.DB.prepare("PRAGMA table_info('giving_activities')"),
    ]) as unknown as QueryResult[];
    facts.databaseConnected = number(first(schemaResults[0]).connected) === 1;
    const tableNames = rows(schemaResults[1]).filter((row) => row.type === "table").map((row) => String(row.name ?? ""));
    const schemaComparison = compareSchemaObjects(stagingSchemaObjects(rows(schemaResults[1])));
    facts.schemaMatchesBaseline = schemaComparison.matches;
    facts.schemaComparisonDifferences = schemaComparison.differences;
    const userColumns = rows(schemaResults[2]).map((row) => String(row.name ?? ""));
    const donorColumns = rows(schemaResults[3]).map((row) => String(row.name ?? ""));
    const givingColumns = rows(schemaResults[4]).map((row) => String(row.name ?? ""));
    facts.currentMigrationLevel = inferMigrationLevel(tableNames, userColumns, donorColumns, givingColumns);
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
    facts.pendingPledgeAssignments = number(latestDonation.pending_assignments);
    facts.failedOrIncompleteImports = number(first(healthResults[10]).count);
    facts.lastHouseholdRefreshAt = number(refresh.last_household_refresh_at, null);
    facts.lastDonationRefreshAt = number(refresh.last_donation_refresh_at, null);
    facts.lastBackupAt = number(first(healthResults[12]).created_at, null);
    return buildDataHealthReport(facts);
  } catch {
    return buildDataHealthReport(facts);
  }
}
