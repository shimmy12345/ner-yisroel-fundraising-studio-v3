export type HealthStatus = "healthy" | "attention" | "critical" | "info" | "unavailable";

// "unavailable" is this report's Unknown state: evidence could not be read,
// so the check must not claim Failed (which asserts a verified negative).
export type HealthEvidence = {
  expected: string;
  actual: string;
  evidenceSource: string;
  lastVerifiedAt: string | null;
  severity: "none" | "low" | "medium" | "high";
  businessDataAtRisk: boolean;
  repairStep: string;
};

export type HealthCheck = {
  id: string;
  label: string;
  status: HealthStatus;
  value: string;
  explanation: string;
  actionHref?: string;
  actionLabel?: string;
  diagnosticLines?: string[];
  evidence?: HealthEvidence;
};

// Shapes written by the D1 backup/restore-verification GitHub Actions
// workflows to the dedicated status bucket, and read back through the
// status-worker (status-worker/) -- see docs/DEPLOYMENT.md's "Backup/
// restore status reporting". Deliberately non-secret: timestamps, an
// object key, and a workflow-run URL, never backup content. Each field is
// independently optional/absent because these are four separately-written
// objects, not one atomically-updated record -- a partial read (e.g. the
// attempt object updated but not yet the success object) must never crash
// or be treated as complete.
export type BackupSuccessStatus = { schemaVersion: number; databaseName: string; completedAt: string; backupObjectKey: string; workflowRunId: string; workflowRunUrl: string };
export type BackupAttemptStatus = { schemaVersion: number; databaseName: string; attemptAt: string; attemptStatus: string; workflowRunId: string; workflowRunUrl: string };
// verifiedLatestObjectKey is always the mutable latest/ pointer name (what
// the restore-verify workflow's job is conceptually certifying: that the
// backup pipeline's output is restorable). verifiedBackupObjectKey/
// verifiedBackupCompletedAt identify the SPECIFIC immutable dated daily/...
// object actually downloaded and restored during that run -- present only
// when the workflow could establish that identity with certainty (see
// .github/workflows/d1-restore-verify-monthly.yml's "Determine which
// immutable backup..." step). null on either field means identity could
// not be established for this run; callers must never fabricate a date in
// that case (see restoreVerificationCheck below).
export type RestoreSuccessStatus = { schemaVersion: number; databaseName: string; completedAt: string; verifiedLatestObjectKey: string; verifiedBackupObjectKey: string | null; verifiedBackupCompletedAt: string | null; workflowRunId: string; workflowRunUrl: string };
export type RestoreAttemptStatus = BackupAttemptStatus;

export type DataHealthFacts = {
  deploymentEnvironment: "staging" | "production" | "staging-independent";
  databaseConnected: boolean;
  schemaReady: boolean;
  currentMigrationLevel: string | null;
  migrationLedgerComplete: boolean;
  journalMigrationLevel: string | null;
  remoteMigrationLevel: string | null;
  remoteMigrationTable: string | null;
  remoteMigrationHistoryComplete: boolean;
  remoteMigrationHistoryConsistent: boolean;
  remoteMigrationDiagnosticLines: string[];
  productionBaselineLevel: string;
  productionBaselineVerified: boolean;
  productionBaselineApplied: boolean;
  // Live-evidence state for the production D1 baseline marker. Only ever
  // populated by reading the production environment's own database — never
  // derived from staging. "not-applicable" means this fact was not checked
  // because the current request is not against production.
  productionBaselineState: "verified" | "not-applied" | "hash-mismatch" | "unreadable" | "not-applicable";
  productionBaselineEvidenceSource: string;
  productionBaselineVerifiedAt: string | null;
  schemaMatchesBaseline: boolean;
  schemaComparisonDifferences: string[];
  businessDataRows: number | null;
  // Same set of tables as businessDataRows, minus the app's own
  // account/configuration tables (users, onboarding_preferences). Kept for
  // the backup-safety gate and rehearsal scripts, which depend on this
  // exact, audit-inclusive definition -- the independent-staging "Business
  // data" card itself now displays businessRecordCounts instead (below).
  fundraisingDataRows: number | null;
  // Row count for the app's own account/configuration tables. Used only by
  // the independent-staging summary's "Account setup" check.
  accountConfigurationRows: number | null;
  // Real fundraising records only -- never import batches, change audits,
  // or draft-session bookkeeping. Used by the independent-staging "Business
  // data" card so it never conflates operational metadata with the
  // donor/gift data it actually exists to report on.
  businessRecordCounts: { donors: number; givingActivities: number; interactions: number; reminders: number } | null;
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
  // Real, currently-unresolved payment/pledge decisions inside this owner's
  // active (status='draft', unexpired) review drafts only -- never derived
  // from a completed import's frozen report_json. A completed import can
  // never contribute: the commit route rejects any unresolved payment
  // decision before writing anything, so "pending" can only exist
  // pre-commit. Skip and review_later on a non-payment duplicate are
  // resolved decisions in a different map entirely and are never counted.
  pendingPledgeAssignments: number | null;
  // Rows explicitly saved with a "review later" decision, summed across
  // every committed session this owner has (see countReviewLaterDecisions).
  // Distinct from pendingPledgeAssignments (an active, uncommitted draft)
  // and from skip (fully resolved, never counted anywhere as pending).
  savedForLaterReviewRows: number | null;
  // Count of this owner's still-open (status='draft', unexpired) review
  // drafts, regardless of what decisions they contain.
  unresolvedActiveDrafts: number | null;
  failedOrIncompleteImports: number | null;
  lastHouseholdRefreshAt: number | null;
  lastDonationRefreshAt: number | null;
  // The in-app, owner-scoped, PARTIAL manual export (app/api/import/backup)
  // -- informational only, never this workspace's real backup protection.
  // See lib/operations/workspace-backup.ts for exactly which tables it
  // covers. Kept distinct from the automated/restore status below, which
  // are whole-database, environment-wide facts, not per-owner ones.
  lastManualExportAt: number | null;
  // Whether the status-worker fetch itself succeeded and returned a
  // well-formed response -- false means "we don't know", never "unhealthy"
  // and never "healthy". See lib/data-health/read.ts.
  backupStatusReachable: boolean;
  backupSuccess: BackupSuccessStatus | null;
  backupAttempt: BackupAttemptStatus | null;
  restoreSuccess: RestoreSuccessStatus | null;
  restoreAttempt: RestoreAttemptStatus | null;
  appVersion: string;
  deployedCommit: string | null;
};

export type DataHealthReport = {
  status: "healthy" | "attention" | "critical";
  checkedAt: string;
  summary: string;
  checks: HealthCheck[];
  platform: {
    deploymentEnvironment: "staging" | "production" | "staging-independent";
    businessDataRows: number | null;
    migrationLevel: string;
    journalMigrationLevel: string;
    remoteMigrationLevel: string;
    productionReady: boolean;
    // Only meaningful when deploymentEnvironment is "production" — staging
    // never contributes to production launch readiness.
    productionReadinessBlockers: string[];
    productionBaselineLevel: string;
    schemaMatchesBaseline: boolean;
    expectedMigrationLevel: string;
    ledgerComplete: boolean;
    appVersion: string;
    deployedCommit: string | null;
  };
};

// Continues to gate production launch readiness specifically -- production
// is deliberately pinned to the verified 0019 baseline until it is itself
// migrated forward, a separate decision from what independent staging runs.
export const EXPECTED_MIGRATION_LEVEL = "0019";
// The newest migration inferMigrationLevel can currently detect via schema
// inspection. Kept distinct from EXPECTED_MIGRATION_LEVEL: independent
// staging intentionally runs ahead of production's pinned baseline, and its
// "Live schema version" card must compare against what it actually has, not
// production's separate expectation. 0020_financial_date_only.sql is
// data-only and has no schema signature, so it is never detectable this way
// -- 0021 and 0022 both changed import_preview_sessions and are.
export const LATEST_MIGRATION_LEVEL = "0022";
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

export function migrationLevelFromTags(tags: readonly string[]) {
  const last = tags.at(-1);
  return last?.match(/^(\d{4})_/)?.[1] ?? null;
}

export function reconcileRemoteMigrationTags(remoteTags: readonly string[], expectedTags: readonly string[] = EXPECTED_MIGRATION_TAGS) {
  const diagnostics: string[] = [];
  const duplicates = remoteTags.filter((tag, index) => remoteTags.indexOf(tag) !== index);
  if (duplicates.length) diagnostics.push(`Duplicate remote migration entries: ${[...new Set(duplicates)].join(", ")}.`);
  const firstMismatch = remoteTags.findIndex((tag, index) => expectedTags[index] !== tag);
  if (firstMismatch >= 0) diagnostics.push(`Remote sequence ${firstMismatch} is ${remoteTags[firstMismatch]}; expected ${expectedTags[firstMismatch] ?? "no additional migration"}.`);
  if (firstMismatch < 0 && remoteTags.length < expectedTags.length) diagnostics.push(`Remote history stops after ${remoteTags.at(-1) ?? "no migration"}; ${expectedTags.length - remoteTags.length} packaged migrations are missing.`);
  const consistent = diagnostics.length === 0;
  return { level: migrationLevelFromTags(remoteTags), complete: consistent && remoteTags.length === expectedTags.length, consistent, diagnostics };
}

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

function timestampCheck(id: string, label: string, timestamp: number | null, hasData: boolean, kind: "refresh"): HealthCheck {
  if (timestamp) {
    const date = new Date(timestamp * 1000);
    if (Number.isFinite(date.getTime())) return { id, label, status: "healthy", value: date.toISOString(), explanation: "A successful JL refresh is recorded." };
  }
  if (!hasData) return { id, label, status: "info", value: "Not yet", explanation: "No JL refresh is expected in a new or manual-only workspace." };
  return {
    id,
    label,
    status: "attention",
    value: "Not recorded",
    explanation: "No successful refresh has been recorded for this live workspace.",
    actionHref: "/onboarding/import",
    actionLabel: "Open data import",
  };
}

// The in-app manual/partial export (app/api/import/backup) is
// deliberately NEVER "attention"/"critical" here, regardless of age or
// absence -- it is a convenience download and a pre-rollback safety
// snapshot, not this workspace's real backup protection (that's the
// Automated backup / Monthly restore test cards below). Its absence must
// never look alarming.
function manualExportCheck(timestamp: number | null): HealthCheck {
  if (timestamp) {
    const date = new Date(timestamp * 1000);
    if (Number.isFinite(date.getTime())) {
      return {
        id: "manual-export",
        label: "Manual workspace export",
        status: "info",
        value: date.toISOString(),
        explanation: "A partial, owner-scoped JSON export was downloaded. This is a convenience download and pre-rollback safety snapshot -- not this workspace's real backup protection, which comes from the automated nightly backup below.",
        actionHref: "/api/import/backup",
        actionLabel: "Download partial export",
      };
    }
  }
  return {
    id: "manual-export",
    label: "Manual workspace export",
    status: "info",
    value: "No manual export yet",
    explanation: "Not required -- this workspace's real backup protection comes from the automated nightly backup below, not this partial (17 of 33 tables), owner-scoped convenience download.",
    actionHref: "/api/import/backup",
    actionLabel: "Download partial export",
  };
}

// Freshness thresholds, tied explicitly to each pipeline's own schedule
// (see .github/workflows/*.yml):
//   - Nightly backup (`0 8 * * *`, ~24h cadence): healthy under 36h (24h +
//     12h grace for GitHub's own best-effort scheduling delay), attention
//     36-72h (one cycle clearly missed), critical over 72h.
//   - Monthly restore verification (`0 9 1 * *`, ~28-31 day cadence,
//     always after that day's backup): healthy under 40 days (one full
//     month + ~9-12 days grace for the longest calendar month plus
//     scheduling slack), attention 40-60 days, critical over 60 days
//     (roughly two missed cycles).
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const BACKUP_FRESHNESS_HEALTHY_MS = 36 * HOUR_MS;
export const BACKUP_FRESHNESS_CRITICAL_MS = 72 * HOUR_MS;
export const RESTORE_FRESHNESS_HEALTHY_MS = 40 * DAY_MS;
export const RESTORE_FRESHNESS_CRITICAL_MS = 60 * DAY_MS;

export function freshnessStatus(ageMs: number, healthyBelowMs: number, criticalAboveMs: number): "healthy" | "attention" | "critical" {
  if (ageMs < healthyBelowMs) return "healthy";
  if (ageMs > criticalAboveMs) return "critical";
  return "attention";
}

type PipelineStatusParams = {
  id: string;
  label: string;
  reachable: boolean;
  success: { completedAt: string; objectKeyLabel: string; objectKey: string; workflowRunUrl: string } | null;
  attempt: { attemptAt: string; attemptStatus: string; workflowRunUrl: string } | null;
  healthyBelowMs: number;
  criticalAboveMs: number;
  now: number;
  neverRunExplanation: string;
};

// Backing logic for the "Automated backup" card -- one of two checks in
// this file backed by the status-worker rather than a live D1 query (the
// other, "Monthly restore test", has its own dedicated
// restoreVerificationCheck below: its copy must distinguish two different
// dates and honestly handle an unidentifiable tested backup in a way this
// shared, generic shape can't express). Deliberately never lets an
// unreachable or malformed status response render as "healthy": both feed
// into the "unavailable" branch below, matching this report's existing Unknown-
// state convention (see HealthStatus's doc comment).
function pipelineStatusCheck(params: PipelineStatusParams): HealthCheck {
  const evidenceSource = "The dedicated status-worker's /status endpoint (read-only access to a status-metadata-only R2 bucket, never the real backup bucket).";
  if (!params.reachable) {
    return {
      id: params.id,
      label: params.label,
      status: "unavailable",
      value: "Unknown",
      explanation: "Backup/restore status could not be read right now. This does not mean anything failed -- it means this specific check could not complete.",
      evidence: { expected: "A reachable status-worker response.", actual: "The status-worker request failed, was unreachable, or returned a malformed response.", evidenceSource, lastVerifiedAt: null, severity: "medium", businessDataAtRisk: false, repairStep: "Re-run the health check. If this persists, verify the status-worker service binding and its own deployment." },
    };
  }
  const successDate = params.success ? new Date(params.success.completedAt) : null;
  const successValid = successDate && Number.isFinite(successDate.getTime());
  if (!successValid) {
    if (params.attempt) {
      return {
        id: params.id,
        label: params.label,
        status: "critical",
        value: "Never succeeded",
        explanation: `The most recent attempt (${params.attempt.attemptAt}) did not succeed, and no successful run has ever been recorded.`,
        evidence: { expected: "At least one successful run recorded.", actual: `Most recent attempt status: "${params.attempt.attemptStatus}".`, evidenceSource, lastVerifiedAt: params.attempt.attemptAt, severity: "high", businessDataAtRisk: true, repairStep: `Check the workflow run: ${params.attempt.workflowRunUrl}` },
      };
    }
    return {
      id: params.id,
      label: params.label,
      status: "info",
      value: "Never run",
      explanation: params.neverRunExplanation,
      evidence: { expected: "At least one successful run recorded.", actual: "No run has been recorded yet.", evidenceSource, lastVerifiedAt: null, severity: "none", businessDataAtRisk: false, repairStep: "None -- this is expected before the pipeline's first scheduled run." },
    };
  }
  const ageMs = params.now - successDate.getTime();
  let status = freshnessStatus(ageMs, params.healthyBelowMs, params.criticalAboveMs);
  // Attempt-floors-status rule: a known-failed most-recent attempt (newer
  // than the last recorded success) always floors the card at "attention",
  // even while the last success is still within its healthy window --
  // otherwise a failure from the most recent run stays invisible until
  // the age-based threshold alone catches up, up to 36h/40d later.
  const attemptIsNewerFailure = params.attempt && params.attempt.attemptStatus !== "success" && new Date(params.attempt.attemptAt).getTime() > successDate.getTime();
  if (attemptIsNewerFailure && status === "healthy") status = "attention";
  const success = params.success!;
  return {
    id: params.id,
    label: params.label,
    status,
    value: success.completedAt,
    explanation: attemptIsNewerFailure
      ? `The most recent attempt (${params.attempt!.attemptAt}) failed. The last known-good run completed ${success.completedAt} (${success.objectKeyLabel}: ${success.objectKey}).`
      : status === "healthy"
        ? `Completed successfully ${success.completedAt} (${success.objectKeyLabel}: ${success.objectKey}).`
        : `The last successful run was ${success.completedAt}, which is longer ago than expected for this pipeline's schedule.`,
    evidence: {
      expected: `A successful run within the last ${Math.round(params.healthyBelowMs / HOUR_MS)}h.`,
      actual: `Last success: ${success.completedAt}${attemptIsNewerFailure ? `; most recent attempt (${params.attempt!.attemptAt}) failed` : ""}.`,
      evidenceSource,
      lastVerifiedAt: success.completedAt,
      severity: status === "healthy" ? "none" : status === "attention" ? "medium" : "high",
      businessDataAtRisk: status === "critical",
      repairStep: status === "healthy" ? "None." : `Check the workflow run: ${(attemptIsNewerFailure ? params.attempt!.workflowRunUrl : success.workflowRunUrl)}`,
    },
  };
}

function humanDate(iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(parsed);
}

// Dedicated "Monthly restore test" check -- deliberately NOT built on
// pipelineStatusCheck, because its copy must honestly distinguish two
// different dates (when THIS restore-test run completed vs. which specific
// dated backup it actually tested) and must never claim a specific backup
// was verified when identity could not be established (see Part 4 of the
// backup/restore investigation this implements). Freshness thresholds and
// the attempt-floors-status rule are otherwise unchanged from
// pipelineStatusCheck's shared logic: a newer nightly backup existing is
// explicitly NOT evaluated here at all (this function never reads
// facts.backupSuccess) -- restore testing is monthly by design, not
// per-backup, so a fresher nightly backup must never by itself downgrade
// this check.
function restoreVerificationCheck(facts: DataHealthFacts, now: number): HealthCheck {
  const id = "restore-verification";
  const label = "Monthly restore test";
  const evidenceSource = "The dedicated status-worker's /status endpoint (read-only access to a status-metadata-only R2 bucket, never the real backup bucket).";
  const cadenceNote = "Restore testing runs monthly.";
  if (!facts.backupStatusReachable) {
    return {
      id, label, status: "unavailable", value: "Unknown",
      explanation: "Backup/restore status could not be read right now. This does not mean anything failed -- it means this specific check could not complete.",
      evidence: { expected: "A reachable status-worker response.", actual: "The status-worker request failed, was unreachable, or returned a malformed response.", evidenceSource, lastVerifiedAt: null, severity: "medium", businessDataAtRisk: false, repairStep: "Re-run the health check. If this persists, verify the status-worker service binding and its own deployment." },
    };
  }
  const maybeSuccess = facts.restoreSuccess;
  const attempt = facts.restoreAttempt;
  const successDate = maybeSuccess ? new Date(maybeSuccess.completedAt) : null;
  const successValid = successDate && Number.isFinite(successDate.getTime());
  if (!maybeSuccess || !successValid) {
    if (attempt) {
      return {
        id, label, status: "critical", value: "Never succeeded",
        explanation: `The most recent monthly restore test (${attempt.attemptAt}) did not succeed, and no successful restore test has ever been recorded.`,
        evidence: { expected: "At least one successful restore test recorded.", actual: `Most recent attempt status: "${attempt.attemptStatus}".`, evidenceSource, lastVerifiedAt: attempt.attemptAt, severity: "high", businessDataAtRisk: true, repairStep: `Check the workflow run: ${attempt.workflowRunUrl}` },
      };
    }
    return {
      id, label, status: "info", value: "Never run",
      explanation: `No monthly restore test has been recorded yet. This is expected before the monthly workflow's first scheduled run. A backup existing is not the same as a backup being provably restorable.`,
      evidence: { expected: "At least one successful restore test recorded.", actual: "No restore test has been recorded yet.", evidenceSource, lastVerifiedAt: null, severity: "none", businessDataAtRisk: false, repairStep: "None -- this is expected before the pipeline's first scheduled run." },
    };
  }
  const success = maybeSuccess;
  const ageMs = now - successDate.getTime();
  let status = freshnessStatus(ageMs, RESTORE_FRESHNESS_HEALTHY_MS, RESTORE_FRESHNESS_CRITICAL_MS);
  // Same attempt-floors-status rule as pipelineStatusCheck: a known-failed
  // most-recent attempt (newer than the last recorded success) always
  // floors this card at "attention", even while the last success is still
  // within its healthy window.
  const attemptIsNewerFailure = Boolean(attempt) && attempt!.attemptStatus !== "success" && new Date(attempt!.attemptAt).getTime() > successDate.getTime();
  if (attemptIsNewerFailure && status === "healthy") status = "attention";

  // Honest provenance: only ever names a specific backup date when the
  // workflow could prove it (see RestoreSuccessStatus's doc comment) --
  // never guessed from the restore test's own completedAt, which is a
  // different date (when the TEST ran, not what it tested).
  const testedBackupPhrase = success.verifiedBackupCompletedAt
    ? `the ${humanDate(success.verifiedBackupCompletedAt)} backup`
    : "the latest backup at the time (its exact backup date could not be confirmed for this run)";

  const explanation = attemptIsNewerFailure
    ? `The most recent monthly restore test (${attempt!.attemptAt}) failed. The last known-good test successfully restored and verified ${testedBackupPhrase}, completed ${success.completedAt}. ${cadenceNote}`
    : status === "healthy"
      ? `Successfully restored and verified ${testedBackupPhrase}. ${cadenceNote}`
      : `The last successful restore test verified ${testedBackupPhrase} and completed ${success.completedAt}, which is longer ago than expected for this monthly pipeline. ${cadenceNote}`;

  return {
    id, label, status,
    value: success.completedAt,
    explanation,
    evidence: {
      expected: `A successful restore test within the last ${Math.round(RESTORE_FRESHNESS_HEALTHY_MS / DAY_MS)} days.`,
      actual: `Last successful restore test: ${success.completedAt}, verifying ${success.verifiedBackupObjectKey ?? "an unidentified backup object"}${attemptIsNewerFailure ? `; most recent attempt (${attempt!.attemptAt}) failed` : ""}.`,
      evidenceSource,
      lastVerifiedAt: success.completedAt,
      severity: status === "healthy" ? "none" : status === "attention" ? "medium" : "high",
      businessDataAtRisk: status === "critical",
      repairStep: status === "healthy" ? "None." : `Check the workflow run: ${attemptIsNewerFailure ? attempt!.workflowRunUrl : success.workflowRunUrl}`,
    },
  };
}

function productionBaselineCheck(facts: DataHealthFacts): HealthCheck {
  const level = facts.productionBaselineLevel;
  if (facts.deploymentEnvironment !== "production") {
    const packagedValid = facts.productionBaselineVerified;
    return {
      id: "production-baseline",
      label: "Production baseline artifact",
      status: packagedValid ? "info" : "critical",
      value: packagedValid ? `${level} · Packaged` : `${level} · Invalid`,
      explanation: packagedValid
        ? "This is the packaged 0019 baseline artifact bundled with this build, verified at build time. Staging is a legacy database that never carries the production_schema_baseline marker by design, so this value is informational only and never represents or blocks production launch readiness."
        : "The packaged baseline artifact bundled with this build failed its own internal validation. This does not reflect staging's live database.",
      evidence: {
        expected: "baselineLevel \"0019\", a 64-character hex schemaHash, and 20 source migrations in production-baseline/schema-manifest.json.",
        actual: packagedValid ? "The bundled manifest matches the expected shape." : "The bundled manifest failed level, hash-format, or source-migration-count validation.",
        evidenceSource: "Build-time schema-manifest.json bundled with this deployment, not any live database.",
        lastVerifiedAt: null,
        severity: packagedValid ? "none" : "high",
        businessDataAtRisk: false,
        repairStep: packagedValid ? "None." : "Run `pnpm db:baseline:generate` then `pnpm db:baseline:rehearse` to regenerate and re-verify the baseline artifact.",
      },
    };
  }
  const evidenceSource = facts.productionBaselineEvidenceSource || "Live query against the production D1 binding (production_schema_baseline table).";
  const verifiedAt = facts.productionBaselineVerifiedAt ?? null;
  const byState = {
    verified: { status: "healthy" as const, value: `${level} · Verified`, explanation: "The production D1 database carries the production_schema_baseline marker and its schema_hash matches the packaged 0019 baseline exactly.", severity: "none" as const, businessDataAtRisk: false, repairStep: "None.", actual: "production_schema_baseline row for id '0019' present with a matching schema_hash." },
    "not-applied": { status: "critical" as const, value: `${level} · Not yet applied`, explanation: "The production D1 database does not contain the production_schema_baseline table. The verified baseline artifact has not been applied to this database yet.", severity: "high" as const, businessDataAtRisk: false, repairStep: "Apply production-baseline/drizzle/0000_production_baseline_0019.sql to the production D1 database (remote), then reload this page to re-verify.", actual: "No production_schema_baseline table exists in the live production D1." },
    "hash-mismatch": { status: "critical" as const, value: `${level} · Mismatch`, explanation: "The production D1 database has a production_schema_baseline marker, but its recorded schema_hash does not match the packaged 0019 baseline. The live schema may not be what this build expects.", severity: "high" as const, businessDataAtRisk: true, repairStep: "Do not launch. Compare the live schema_hash against production-baseline/schema-manifest.json and investigate the discrepancy before taking any further action.", actual: "production_schema_baseline row present with a schema_hash that differs from the packaged baseline." },
    unreadable: { status: "unavailable" as const, value: `${level} · Unknown`, explanation: "The production baseline marker could not be read from the live database (a connection or query error occurred). This is not a confirmed failure — the check could not complete.", severity: "medium" as const, businessDataAtRisk: true, repairStep: "Re-run the health check. If this persists, verify the production D1 binding and the health check's database permissions.", actual: "The verification query against production_schema_baseline did not complete." },
    "not-applicable": { status: "unavailable" as const, value: `${level} · Unknown`, explanation: "This request's deployment environment could not be classified as production, so the live baseline marker was not checked.", severity: "medium" as const, businessDataAtRisk: true, repairStep: "Re-run the health check on the production environment.", actual: "Deployment environment was not resolved as production." },
  };
  const detail = byState[facts.productionBaselineState] ?? byState.unreadable;
  return {
    id: "production-baseline",
    label: "Production rehearsal baseline",
    status: detail.status,
    value: detail.value,
    explanation: detail.explanation,
    evidence: { expected: "A production_schema_baseline row for id '0019' whose schema_hash equals the packaged baseline's schemaHash.", actual: detail.actual, evidenceSource, lastVerifiedAt: verifiedAt, severity: detail.severity, businessDataAtRisk: detail.businessDataAtRisk, repairStep: detail.repairStep },
  };
}

function productionReadinessCheck(facts: DataHealthFacts, productionReady: boolean, blockers: string[]): HealthCheck {
  if (facts.deploymentEnvironment !== "production") {
    return {
      id: "production-readiness",
      label: "Production launch readiness",
      status: "info",
      value: "Evaluated on production only",
      explanation: "Production launch readiness reflects the production environment's own live database and packaged baseline. It is never derived from staging's local state — open this page on the production environment to see its current readiness.",
      evidence: { expected: "Not applicable on this environment.", actual: "This request was made against a non-production environment.", evidenceSource: "Deployment environment resolved from this build's configuration.", lastVerifiedAt: null, severity: "none", businessDataAtRisk: false, repairStep: "None." },
    };
  }
  return {
    id: "production-readiness",
    label: "Production launch readiness",
    status: productionReady ? "healthy" : "critical",
    value: productionReady ? "Ready" : "Blocked",
    explanation: productionReady ? "The clean baseline matches staging and the current workspace integrity checks pass." : `Production remains blocked by ${blockers.length} check${blockers.length === 1 ? "" : "s"}. See the itemized list below.`,
    diagnosticLines: productionReady ? [] : blockers,
    evidence: { expected: "Zero blocking checks.", actual: `${blockers.length} blocking check${blockers.length === 1 ? "" : "s"}.`, evidenceSource: "Live production D1 query combined with the packaged baseline artifact.", lastVerifiedAt: facts.productionBaselineVerifiedAt ?? null, severity: productionReady ? "none" : "high", businessDataAtRisk: false, repairStep: productionReady ? "None." : "Resolve each listed blocking check, then re-run this health check." },
  };
}

// production_schema_baseline is a historical, point-in-time stamp -- it is
// never rewritten automatically when a later migration is applied to this
// environment's D1. A stale hash here means exactly that (a stamp from
// before some later migration), never that the live schema is corrupt or
// unexpected: "Staging ↔ baseline schema" below does the authoritative,
// always-current structural comparison against the *current* packaged
// baseline and is what actually proves live-schema integrity.
const INDEPENDENT_STAGING_BASELINE_STATUS: Record<DataHealthFacts["productionBaselineState"], HealthStatus> = {
  verified: "healthy",
  "not-applied": "attention", // a genuine setup gap: the baseline was never applied at all, distinct from a merely stale stamp
  "hash-mismatch": "info",
  unreadable: "unavailable",
  "not-applicable": "unavailable",
};

// The independent staging Worker/D1 is bootstrapped from the same verified
// 0019 baseline as production, so it reuses that live-evidence plumbing —
// but it must never use production's "launch readiness"/"Blocked" wording,
// since it is never a launch gate for anything. Kept entirely separate from
// productionBaselineCheck/productionReadinessCheck so that wording can never
// leak between the two. Also distinct from the legacy ChatGPT Sites staging
// environment, which remains classified as "staging" throughout this file.
function independentStagingSummaryChecks(facts: DataHealthFacts, now: number): HealthCheck[] {
  const baselineState = facts.productionBaselineState;
  const baselineStatus = INDEPENDENT_STAGING_BASELINE_STATUS[baselineState];
  const stampedAt = facts.productionBaselineVerifiedAt;
  const counts = facts.businessRecordCounts;
  const businessTotal = counts ? counts.donors + counts.givingActivities + counts.interactions + counts.reminders : null;
  return [
    {
      id: "independent-staging-environment",
      label: "Environment",
      status: "info",
      value: "Independent Staging",
      explanation: "This is an independent Cloudflare staging Worker and D1, isolated from legacy ChatGPT Sites staging and from production. It is never a launch gate for either.",
    },
    {
      id: "independent-staging-baseline",
      label: "Baseline lineage",
      status: baselineStatus,
      value: baselineState === "not-applied" ? "0019 · Not yet applied"
        : baselineState === "unreadable" || baselineState === "not-applicable" ? "0019 · Unknown"
        : baselineState === "hash-mismatch" ? `0019 · Stale stamp${stampedAt ? ` (${stampedAt.slice(0, 10)})` : ""}`
        : `0019 · Verified${stampedAt ? ` · stamped ${stampedAt.slice(0, 10)}` : ""}`,
      explanation:
        baselineState === "verified" ? `production_schema_baseline is a historical stamp confirming this database originated from the verified 0019 baseline${stampedAt ? ` (written ${stampedAt})` : ""}. Its recorded hash currently matches the packaged baseline exactly.`
        : baselineState === "not-applied" ? "The verified 0019 baseline SQL has not been applied to this environment's D1 yet."
        : baselineState === "hash-mismatch" ? `production_schema_baseline is a historical, point-in-time stamp${stampedAt ? ` written ${stampedAt}` : ""} — it is never rewritten automatically when a later migration is applied. Its hash no longer matches the packaged baseline because migrations have been applied to this environment since it was stamped. This reflects the baseline's age, not a corrupt or unexpected live schema — see "Live schema version" and "Staging ↔ baseline schema" for the current, authoritative checks.`
        : "The baseline marker could not be read. This is not a confirmed failure — the check could not complete.",
      evidence: {
        expected: "A production_schema_baseline row for id '0019', which is a historical stamp rather than a continuously-reverified marker.",
        actual: facts.productionBaselineEvidenceSource,
        evidenceSource: facts.productionBaselineEvidenceSource,
        lastVerifiedAt: facts.productionBaselineVerifiedAt,
        severity: baselineStatus === "healthy" || baselineStatus === "info" ? "none" : baselineStatus === "unavailable" ? "medium" : "high",
        // A stale stamp is expected drift, not a business-data risk — the
        // structural comparison (schema-comparison) is what actually
        // verifies the live schema, and businessDataAtRisk here must never
        // imply a hash-mismatch alone puts data at risk.
        businessDataAtRisk: false,
        repairStep: baselineState === "not-applied" ? "Apply production-baseline/drizzle/0000_production_baseline_0019.sql to this environment's D1, then reload this page to re-verify." : "None. If you want the stamp itself refreshed, that is a separate, explicit maintenance action — not a repair.",
      },
    },
    {
      id: "independent-staging-business-data",
      label: "Business data",
      status: businessTotal === null ? "unavailable" : "healthy",
      value: businessTotal === null ? "Not checked" : businessTotal === 0 ? "Empty" : `${counts!.donors.toLocaleString("en-US")} donor${counts!.donors === 1 ? "" : "s"} · ${counts!.givingActivities.toLocaleString("en-US")} giving activit${counts!.givingActivities === 1 ? "y" : "ies"} · ${counts!.interactions.toLocaleString("en-US")} interaction${counts!.interactions === 1 ? "" : "s"} · ${counts!.reminders.toLocaleString("en-US")} reminder${counts!.reminders === 1 ? "" : "s"}`,
      explanation:
        businessTotal === null ? "The application tables could not be counted."
        : businessTotal === 0 ? "No donors, giving activities, interactions, or reminders are stored in this environment. The owner's own account row is tracked separately under Account setup and is never counted here."
        : "This independent staging environment is intentionally populated with real fundraising test data for staging validation. Import batches, change audits, and draft-review bookkeeping are tracked separately from these business-record counts, not blended into them.",
      ...(businessTotal !== null && businessTotal > 0 ? { diagnosticLines: [`${counts!.donors.toLocaleString("en-US")} donor(s).`, `${counts!.givingActivities.toLocaleString("en-US")} giving activit${counts!.givingActivities === 1 ? "y" : "ies"}.`, `${counts!.interactions.toLocaleString("en-US")} interaction(s).`, `${counts!.reminders.toLocaleString("en-US")} reminder(s).`] } : {}),
    },
    {
      id: "independent-staging-account-setup",
      label: "Account setup",
      status: "info",
      value: facts.accountConfigurationRows === null ? "Not checked" : facts.accountConfigurationRows === 0 ? "No owner configured yet" : `${facts.accountConfigurationRows} owner${facts.accountConfigurationRows === 1 ? "" : "s"} configured`,
      explanation: "The number of app-account rows in this environment, created automatically the first time an owner authenticates. This is account/configuration state, not fundraising business data, and is never counted toward Business data above.",
    },
    // Automated backup / restore verification are scoped to this
    // environment specifically -- the nightly/monthly D1 pipeline backs up
    // fundraising-os-staging-db (this environment's own database), and the
    // status-worker service binding is only wired up here. Not shown on
    // production or legacy staging, which have no such binding and would
    // otherwise show a permanently confusing "unavailable" for a pipeline
    // that was never meant to cover them.
    pipelineStatusCheck({
      id: "automated-backup",
      label: "Automated backup",
      reachable: facts.backupStatusReachable,
      success: facts.backupSuccess ? { completedAt: facts.backupSuccess.completedAt, objectKeyLabel: "object", objectKey: facts.backupSuccess.backupObjectKey, workflowRunUrl: facts.backupSuccess.workflowRunUrl } : null,
      attempt: facts.backupAttempt ? { attemptAt: facts.backupAttempt.attemptAt, attemptStatus: facts.backupAttempt.attemptStatus, workflowRunUrl: facts.backupAttempt.workflowRunUrl } : null,
      healthyBelowMs: BACKUP_FRESHNESS_HEALTHY_MS,
      criticalAboveMs: BACKUP_FRESHNESS_CRITICAL_MS,
      now,
      neverRunExplanation: "No automated backup run has been recorded yet. This is expected before the nightly workflow's first scheduled run.",
    }),
    restoreVerificationCheck(facts, now),
  ];
}

export function buildDataHealthReport(facts: DataHealthFacts, checkedAt = new Date().toISOString()): DataHealthReport {
  const deploymentEnvironment = facts.deploymentEnvironment ?? "staging";
  // Derived from checkedAt (not a fresh Date.now() call) so freshness
  // classification is deterministic and testable against a fixed clock.
  const now = Date.parse(checkedAt);
  const productionBaselineApplied = deploymentEnvironment === "production" ? facts.productionBaselineState === "verified" : true;
  const businessDataRows = facts.businessDataRows ?? facts.activeDonors;
  const hasData = (facts.activeDonors ?? 0) > 0;
  const givingReady = [facts.givingSourceTotalCents, facts.givingLinkedTotalCents, facts.invalidGivingRows, facts.duplicateGivingFingerprints].every((value) => value !== null);
  const givingHealthy = givingReady && facts.givingSourceTotalCents === facts.givingLinkedTotalCents && facts.invalidGivingRows === 0 && facts.duplicateGivingFingerprints === 0;
  const relationshipIntegrityHealthy = [facts.duplicateJlCodes, facts.orphanedGifts, facts.orphanedInteractions, facts.orphanedReminders, facts.orphanedPayments, facts.brokenMergeRedirects].every((value) => value === 0);
  const productionReady = facts.schemaReady && facts.currentMigrationLevel === EXPECTED_MIGRATION_LEVEL && facts.productionBaselineVerified && productionBaselineApplied && facts.schemaMatchesBaseline && givingHealthy && relationshipIntegrityHealthy;
  const productionBlockers: string[] = deploymentEnvironment === "production" && !productionReady ? [
    ...(!facts.schemaReady ? ["Live schema is not ready: required application tables or columns are missing."] : []),
    ...(facts.currentMigrationLevel !== EXPECTED_MIGRATION_LEVEL ? [`Live migration level is ${facts.currentMigrationLevel ?? "Unknown"}; expected ${EXPECTED_MIGRATION_LEVEL}.`] : []),
    ...(!productionBaselineApplied || !facts.productionBaselineVerified ? [`Production rehearsal baseline is not verified (current state: ${facts.productionBaselineState}).`] : []),
    ...(!facts.schemaMatchesBaseline ? [`Staging ↔ baseline schema comparison found ${facts.schemaComparisonDifferences.length} difference(s).`] : []),
    ...(!givingHealthy ? ["Giving-total reconciliation has not passed."] : []),
    ...(!relationshipIntegrityHealthy ? ["One or more relationship-data integrity checks (duplicates, orphans, broken merge redirects) have not passed."] : []),
  ] : [];
  const checks: HealthCheck[] = [
    ...(deploymentEnvironment === "staging-independent" ? independentStagingSummaryChecks(facts, now) : []),
    {
      id: "database",
      label: "Database connection",
      status: facts.databaseConnected ? "healthy" : "critical",
      value: facts.databaseConnected ? "Connected" : "Unavailable",
      explanation: facts.databaseConnected ? "Fundraising OS can read the D1 workspace." : "Fundraising OS could not read D1. No workspace integrity checks were completed.",
    },
    (() => {
      // Independent staging intentionally runs ahead of production's
      // pinned 0019 expectation (it has migrations 0021/0022 applied);
      // comparing it against EXPECTED_MIGRATION_LEVEL would falsely read
      // as a mismatch. Production and legacy staging keep the original
      // comparison unchanged.
      const expected = deploymentEnvironment === "staging-independent" ? LATEST_MIGRATION_LEVEL : EXPECTED_MIGRATION_LEVEL;
      const matches = facts.schemaReady && facts.currentMigrationLevel === expected;
      return {
        id: "live-schema",
        label: "Live schema version",
        status: matches ? "healthy" : "critical",
        value: `${facts.currentMigrationLevel ?? "Unknown"} / ${expected}`,
        explanation: matches
          ? deploymentEnvironment === "staging-independent"
            ? "The live D1 schema contains every expected table and column through migration 0022. Migration 0020 is data-only and has no schema signature, so it cannot be independently verified by schema inspection alone — see \"Staging ↔ baseline schema\" for the authoritative structural comparison."
            : "The live D1 schema contains every expected table and column."
          : "The live schema does not match the packaged application schema. Do not deploy database changes until reconciled.",
      };
    })(),
    deploymentEnvironment === "production"
      ? { id: "staging-migration-history", label: "Production migration history", status: productionBaselineApplied ? "healthy" : "critical", value: productionBaselineApplied ? "Baseline 0019" : "Unverified", explanation: productionBaselineApplied ? "This database was created from the verified 0019 production baseline. Legacy staging history was not copied." : "The production baseline marker or schema hash is missing. Do not load business data." }
      : { id: "staging-migration-history", label: "Staging migration history", status: "info", value: "Legacy · unverified", explanation: `Staging is intentionally treated as a legacy database. Its schema is inspected directly; migration SQL is never replayed and history is never guessed. Journal ${facts.journalMigrationLevel ?? "unknown"}; remote table ${facts.remoteMigrationTable ?? "not present"}.`, diagnosticLines: [...MISSING_LEDGER_MIGRATIONS.map((tag) => `${tag} is absent from the legacy journal.`), ...facts.remoteMigrationDiagnosticLines] },
    productionBaselineCheck(facts),
    { id: "schema-comparison", label: "Staging ↔ baseline schema", status: facts.schemaMatchesBaseline ? "healthy" : "critical", value: facts.schemaMatchesBaseline ? "Match" : `${facts.schemaComparisonDifferences.length} differences`, explanation: facts.schemaMatchesBaseline ? "Application tables, columns, indexes, and constraints match the verified 0019 baseline. Cloudflare-managed infrastructure tables are reported separately from application schema." : "Material application-schema differences exist between staging and the production rehearsal.", diagnosticLines: facts.schemaComparisonDifferences },
    productionReadinessCheck(facts, productionReady, productionBlockers),
    {
      id: "business-data-state",
      label: deploymentEnvironment === "production" ? "Production data state" : "Staging data state",
      status: businessDataRows === null || businessDataRows === undefined ? "unavailable" : businessDataRows === 0 ? "healthy" : "info",
      value: businessDataRows === null || businessDataRows === undefined ? "Not checked" : businessDataRows === 0 ? "Schema only" : "Live records present",
      explanation: businessDataRows === null || businessDataRows === undefined ? "The application tables could not be counted." : businessDataRows === 0 ? "No users, donors, gifts, interactions, reminders, imports, or audit records are stored." : "Application records are present; the health report continues to validate ownership, links, and totals without exposing them.",
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
      // Scoped to active (status='draft', unexpired) review drafts only --
      // see countPendingPaymentDecisions. A completed import can never
      // contribute: the commit route rejects any unresolved payment
      // decision before writing anything, so "pending" can only exist
      // pre-commit. Skip and review_later are resolved decisions in a
      // different decision map and are never counted here.
      id: "pending-pledge-assignments",
      label: "Pending pledge assignments",
      status: facts.pendingPledgeAssignments === null ? "unavailable" : facts.pendingPledgeAssignments > 0 ? "attention" : "healthy",
      value: numberValue(facts.pendingPledgeAssignments),
      explanation: facts.pendingPledgeAssignments === null ? "Pledge-assignment review could not be checked." : facts.pendingPledgeAssignments > 0 ? "An active, unfinished review draft has a payment or pledge-assignment decision still marked \"needs review\"." : "No active review draft has an unresolved payment or pledge-assignment decision. A completed import is never counted here — every payment decision is resolved before a commit can succeed.",
      ...(facts.pendingPledgeAssignments !== null && facts.pendingPledgeAssignments > 0 ? { actionHref: "/onboarding/import", actionLabel: "Resume review" } : {}),
    },
    (() => {
      const importReviewValues = [facts.savedForLaterReviewRows, facts.unresolvedActiveDrafts, facts.failedOrIncompleteImports];
      // Treats a genuinely-unset value the same as null/unavailable, rather
      // than risking a crash formatting `undefined` -- real usage
      // (lib/data-health/read.ts) always assigns a number or an explicit
      // null, so this only matters for incompletely-constructed facts.
      const checked = importReviewValues.every((value): value is number => typeof value === "number");
      const safeNumber = (value: number | null | undefined) => (value ?? 0).toLocaleString("en-US");
      const anyOutstanding = checked && (facts.savedForLaterReviewRows! > 0 || facts.unresolvedActiveDrafts! > 0 || facts.failedOrIncompleteImports! > 0);
      return {
        // Distinct from pending-pledge-assignments above: this covers
        // decisions/imports that are resolved-but-deferred (review later),
        // still in progress (an open draft), or never reached completion --
        // never a row the user explicitly chose to Skip, which is a fully
        // resolved outcome and is never counted anywhere as pending.
        id: "import-review-state",
        label: "Import review state",
        status: !checked ? "unavailable" : anyOutstanding ? "attention" : "healthy",
        value: !checked ? "Not checked" : `${safeNumber(facts.savedForLaterReviewRows)} saved · ${safeNumber(facts.unresolvedActiveDrafts)} unresolved · ${safeNumber(facts.failedOrIncompleteImports)} failed`,
        explanation: "Rows explicitly saved for later review, drafts still in progress, and import batches that failed or never completed — tracked independently of each other and of Pending pledge assignments above. A row explicitly marked Skip is fully resolved and is never counted here.",
        ...(checked ? { diagnosticLines: [
          `${safeNumber(facts.savedForLaterReviewRows)} row(s) saved for later review.`,
          `${safeNumber(facts.unresolvedActiveDrafts)} unresolved active draft(s).`,
          `${safeNumber(facts.failedOrIncompleteImports)} failed or incomplete import(s).`,
        ] } : {}),
        ...(anyOutstanding ? { actionHref: "/onboarding/import", actionLabel: "Open Import Center" } : {}),
      };
    })(),
    // The standalone "Failed or incomplete imports" card was removed here:
    // failedOrIncompleteImports is still computed (see
    // lib/data-health/read.ts, FAILED_IMPORTS_SQL) and still folded into
    // "Import review state" above -- both its status contribution
    // (anyOutstanding) and its own diagnosticLines/value line -- so no
    // alerting was lost, only the duplicate top-level presentation.
    timestampCheck("household-refresh", "Last household refresh", facts.lastHouseholdRefreshAt, hasData, "refresh"),
    timestampCheck("donation-refresh", "Last donation refresh", facts.lastDonationRefreshAt, hasData, "refresh"),
    manualExportCheck(facts.lastManualExportAt),
    {
      id: "release",
      label: "Deployed version",
      // Missing commit metadata is informational only — it never signals a
      // problem worth review, so it must never push the overall report
      // status away from "healthy" the way "attention" would.
      status: facts.deployedCommit ? "healthy" : "info",
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
      deploymentEnvironment,
      businessDataRows: businessDataRows ?? null,
      migrationLevel: facts.currentMigrationLevel ?? "Unknown",
      journalMigrationLevel: facts.journalMigrationLevel ?? "Unknown",
      remoteMigrationLevel: facts.remoteMigrationLevel ?? "Unknown",
      productionReady,
      productionReadinessBlockers: productionBlockers,
      productionBaselineLevel: facts.productionBaselineLevel,
      schemaMatchesBaseline: facts.schemaMatchesBaseline,
      expectedMigrationLevel: EXPECTED_MIGRATION_LEVEL,
      ledgerComplete: facts.migrationLedgerComplete,
      appVersion: facts.appVersion,
      deployedCommit: facts.deployedCommit,
    },
  };
}

export function inferMigrationLevel(tableNames: Iterable<string>, userColumns: Iterable<string>, donorColumns: Iterable<string>, givingColumns: Iterable<string>, importPreviewSessionColumns: Iterable<string> = []) {
  const tables = new Set(tableNames);
  const users = new Set(userColumns);
  const donors = new Set(donorColumns);
  const giving = new Set(givingColumns);
  const previewSessionColumns = new Set(importPreviewSessionColumns);
  // 0020_financial_date_only.sql is data-only (it corrects already-stored
  // date values) and has no schema signature at all -- it can never be
  // proven from schema inspection, only 0021 and 0022 (both of which
  // changed import_preview_sessions) can be.
  if (previewSessionColumns.has("decisions_json") && previewSessionColumns.has("status") && previewSessionColumns.has("progress_resolved")) return "0022";
  if (tables.has("import_preview_sessions")) return "0021";
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
