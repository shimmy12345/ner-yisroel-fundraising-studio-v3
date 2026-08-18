import assert from "node:assert/strict";
import { APP_VERSION, EXPECTED_MIGRATION_LEVEL, LATEST_MIGRATION_LEVEL, buildDataHealthReport, inferMigrationLevel } from "../lib/data-health/model.ts";
import { countPendingPaymentDecisions, countReviewLaterDecisions } from "../lib/import/preview-session.ts";

// Live incident: Workspace Health showed "Pending pledge assignments: 240"
// for an import that had already completed successfully, where all 240
// rows were possible-duplicate rows the user explicitly chose Skip (proven
// by a prior forensic audit, fingerprint by fingerprint, against the real
// draft). Root cause: the card read results.rowsRequiringReview from the
// completed import's frozen report_json -- a field that predates the
// disposition-accuracy fix and never distinguished "explicitly resolved"
// from "genuinely pending" in the first place. This suite proves the
// redefined semantics: pending pledge assignments now come only from real,
// unresolved payment decisions inside an active, unexpired draft.

const now = 1_786_000_000;
// buildDataHealthReport in this file is always called without an explicit
// checkedAt (it defaults to the real wall clock), so the backup/restore
// status fixtures below use "right now" rather than a fixed date -- any
// fixed past date would eventually make these tests flake as real time
// passes it by whatever freshness window it started inside.
const rightNow = () => new Date().toISOString();

function baseFacts(overrides = {}) {
  return {
    deploymentEnvironment: "staging-independent",
    databaseConnected: true,
    schemaReady: true,
    currentMigrationLevel: LATEST_MIGRATION_LEVEL,
    migrationLedgerComplete: true,
    journalMigrationLevel: "0019",
    remoteMigrationLevel: "0019",
    remoteMigrationTable: "d1_migrations",
    remoteMigrationHistoryComplete: true,
    remoteMigrationHistoryConsistent: true,
    remoteMigrationDiagnosticLines: [],
    productionBaselineLevel: "0019",
    productionBaselineVerified: true,
    productionBaselineApplied: true,
    productionBaselineState: "verified",
    productionBaselineEvidenceSource: "Live query against this environment's D1 binding (production_schema_baseline table, id '0019').",
    productionBaselineVerifiedAt: "2026-08-05T15:34:32.000Z",
    schemaMatchesBaseline: true,
    schemaComparisonDifferences: [],
    businessDataRows: 0,
    fundraisingDataRows: 0,
    accountConfigurationRows: 1,
    businessRecordCounts: { donors: 0, givingActivities: 0, interactions: 0, reminders: 0 },
    activeDonors: 0,
    duplicateJlCodes: 0,
    orphanedGifts: 0,
    orphanedInteractions: 0,
    orphanedReminders: 0,
    orphanedPayments: 0,
    brokenMergeRedirects: 0,
    givingSourceTotalCents: 0,
    givingLinkedTotalCents: 0,
    invalidGivingRows: 0,
    duplicateGivingFingerprints: 0,
    unmatchedJlCodes: 0,
    pendingPledgeAssignments: 0,
    savedForLaterReviewRows: 0,
    unresolvedActiveDrafts: 0,
    failedOrIncompleteImports: 0,
    lastHouseholdRefreshAt: now,
    lastDonationRefreshAt: now,
    lastManualExportAt: now,
    backupStatusReachable: true,
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: rightNow(), backupObjectKey: "daily/fundraising-os-staging-db-example.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: rightNow(), attemptStatus: "success", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: rightNow(), verifiedBackupObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    restoreAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: rightNow(), attemptStatus: "success", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    appVersion: APP_VERSION,
    deployedCommit: "abcdef1234567890",
    ...overrides,
  };
}

const check = (report, id) => report.checks.find((c) => c.id === id);

async function run() {
  // ---- 1. The exact historical incident: 240 possible-duplicate rows, all
  // explicitly marked skip, on a session that is already committed. ----
  const historicalReviewDecisions = Object.fromEntries(Array.from({ length: 240 }, (_, index) => [`fp-skip-${index}`.padStart(64, "0"), { action: "skip" }]));
  const historicalDecisionsJson = JSON.stringify({ reviewDecisions: historicalReviewDecisions, rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {} });
  assert.equal(countPendingPaymentDecisions(historicalDecisionsJson), 0, "240 explicit Skip decisions on possible-duplicate rows must never register as a pending payment/pledge decision -- they aren't in the paymentDecisions map at all");

  // ---- 2. A completed import can never contribute, structurally --
  // pendingPledgeAssignments is computed only from active (status='draft',
  // unexpired) sessions; a committed session is never summed into it,
  // regardless of what its decisions_json contains. ----
  const sessions = [
    { status: "committed", decisions_json: historicalDecisionsJson, expires_at: now + 1_000_000 },
  ];
  const nowSeconds = now;
  const activeDraftsOnly = sessions.filter((session) => session.status === "draft" && session.expires_at > nowSeconds);
  const pendingFromCompletedOnly = activeDraftsOnly.reduce((sum, session) => sum + countPendingPaymentDecisions(session.decisions_json), 0);
  assert.equal(pendingFromCompletedOnly, 0, "a committed session must never be summed into pending pledge assignments, no matter what decisions it holds");
  const reportForCompletedImport = buildDataHealthReport(baseFacts({ pendingPledgeAssignments: pendingFromCompletedOnly }));
  assert.equal(check(reportForCompletedImport, "pending-pledge-assignments").status, "healthy");
  assert.equal(check(reportForCompletedImport, "pending-pledge-assignments").value, "0");
  assert.doesNotMatch(check(reportForCompletedImport, "pending-pledge-assignments").explanation, /rowsRequiringReview|latest import/i, "the explanation must never reference the retired historical field");

  // ---- 3. An active, unexpired draft with a genuinely unresolved payment
  // decision does count. ----
  const activeDraftDecisionsJson = JSON.stringify({
    reviewDecisions: {}, rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, pendingGiftDecisions: {},
    paymentDecisions: {
      [`fp-payment-resolved`.padStart(64, "0")]: { action: "apply_to_pledge", pledgeId: "pledge-1" },
      [`fp-payment-pending`.padStart(64, "0")]: { action: "needs_review", pledgeId: null },
    },
  });
  assert.equal(countPendingPaymentDecisions(activeDraftDecisionsJson), 1, "exactly the one payment decision still marked needs_review counts -- a resolved apply_to_pledge decision does not");
  const activeDraftSession = { status: "draft", decisions_json: activeDraftDecisionsJson, expires_at: now + 1_000_000 };
  const expiredDraftSession = { status: "draft", decisions_json: activeDraftDecisionsJson, expires_at: now - 1 };
  const mixedSessions = [activeDraftSession, expiredDraftSession];
  const activeDrafts = mixedSessions.filter((session) => session.status === "draft" && session.expires_at > nowSeconds);
  assert.equal(activeDrafts.length, 1, "an expired draft is never counted as active, even with the identical unresolved decision");
  const pendingFromActiveDraft = activeDrafts.reduce((sum, session) => sum + countPendingPaymentDecisions(session.decisions_json), 0);
  assert.equal(pendingFromActiveDraft, 1);
  const reportWithPending = buildDataHealthReport(baseFacts({ pendingPledgeAssignments: pendingFromActiveDraft }));
  const pendingCheck = check(reportWithPending, "pending-pledge-assignments");
  assert.equal(pendingCheck.status, "attention");
  assert.equal(pendingCheck.value, "1");
  assert.equal(pendingCheck.actionHref, "/onboarding/import");

  // ---- 4. Saved-for-later import work appears under the separate "Import
  // review state" card, using the existing countReviewLaterDecisions --
  // never counted as pending pledge assignments, never called "Skip". ----
  const committedWithReviewLater = JSON.stringify({
    reviewDecisions: {
      [`fp-later-1`.padStart(64, "0")]: { action: "review_later" },
      [`fp-later-2`.padStart(64, "0")]: { action: "skip" },
    },
    rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {},
  });
  const savedForLater = countReviewLaterDecisions(committedWithReviewLater);
  assert.equal(savedForLater, 1, "only the explicit review_later entry counts -- the skip entry in the same session must not");
  const reportWithReviewState = buildDataHealthReport(baseFacts({ savedForLaterReviewRows: savedForLater, unresolvedActiveDrafts: 1, failedOrIncompleteImports: 0 }));
  const reviewStateCheck = check(reportWithReviewState, "import-review-state");
  assert.equal(reviewStateCheck.status, "attention");
  assert.equal(reviewStateCheck.value, "1 saved · 1 unresolved · 0 failed");
  assert.ok(reviewStateCheck.diagnosticLines.some((line) => /1 row\(s\) saved for later review/.test(line)));
  assert.match(reviewStateCheck.explanation, /Skip.*fully resolved.*never counted/i, "must explicitly state that a Skip is resolved and excluded, not silently omit skip from the picture");
  // A fully clean import-review state (nothing saved, nothing unresolved,
  // nothing failed) must read as plainly healthy, matching "Healthy / 0".
  const cleanReviewState = check(buildDataHealthReport(baseFacts()), "import-review-state");
  assert.equal(cleanReviewState.status, "healthy");
  assert.equal(cleanReviewState.value, "0 saved · 0 unresolved · 0 failed");

  // ---- 5. Intentionally populated independent staging is informational,
  // never a warning, and never blends operational metadata into the count. ----
  const populatedReport = buildDataHealthReport(baseFacts({
    fundraisingDataRows: 5847,
    businessRecordCounts: { donors: 248, givingActivities: 5171, interactions: 0, reminders: 0 },
  }));
  const businessData = check(populatedReport, "independent-staging-business-data");
  assert.equal(businessData.status, "healthy", "real fundraising test data in independent staging must never read as a warning");
  assert.match(businessData.value, /248 donors/);
  assert.match(businessData.value, /5,171 giving activities/);
  assert.doesNotMatch(businessData.explanation, /expected to remain empty/i);
  assert.match(businessData.explanation, /intentionally populated/i);
  assert.equal(populatedReport.status, "healthy", "a fully clean independent-staging report with only intentional test data must read as healthy overall");

  // ---- 6. Baseline lineage remains 0019, explicitly labeled as a
  // historical stamp with its own timestamp -- a stale hash never reads as
  // a current structural failure. ----
  const staleBaseline = check(buildDataHealthReport(baseFacts({ productionBaselineState: "hash-mismatch" })), "independent-staging-baseline");
  assert.match(staleBaseline.value, /^0019/, "baseline lineage must always display 0019 regardless of hash-mismatch state");
  assert.equal(staleBaseline.status, "info", "a stale point-in-time stamp is informational, never a structural failure");
  assert.notEqual(staleBaseline.status, "critical");
  assert.equal(staleBaseline.evidence.businessDataAtRisk, false);
  const verifiedBaseline = check(buildDataHealthReport(baseFacts()), "independent-staging-baseline");
  assert.match(verifiedBaseline.value, /^0019/);
  assert.match(verifiedBaseline.value, /2026-08-05/, "the marker's created_at timestamp must be shown");

  // ---- 7. Live schema detection reports 0022 for a schema that actually
  // has migrations 0021 and 0022 applied (real sentinels, not the old
  // 0019 ceiling) -- and correctly still reports 0021/0019 for schemas
  // that only have the earlier migrations. ----
  const tablesThrough0019 = ["donors", "data_imports", "donor_views", "relationship_queue_dismissals", "data_health_repair_audits", "legacy_test_cleanup_audits"];
  assert.equal(inferMigrationLevel(tablesThrough0019, [], [], []), "0019", "no import_preview_sessions table at all -- still correctly 0019, not falsely advanced");
  assert.equal(inferMigrationLevel([...tablesThrough0019, "import_preview_sessions"], [], [], [], []), "0021", "the table exists (migration 0021) but none of 0022's columns do yet");
  assert.equal(inferMigrationLevel([...tablesThrough0019, "import_preview_sessions"], [], [], [], ["id", "decisions_json", "status", "progress_resolved", "progress_total"]), "0022", "0022's columns (decisions_json/status/progress_resolved) are present -- this is the real, current independent-staging schema shape");
  // A live-schema card for independent staging compares against
  // LATEST_MIGRATION_LEVEL ("0022"), never production's separate,
  // deliberately-pinned EXPECTED_MIGRATION_LEVEL ("0019").
  assert.equal(LATEST_MIGRATION_LEVEL, "0022");
  assert.notEqual(EXPECTED_MIGRATION_LEVEL, LATEST_MIGRATION_LEVEL, "production's pinned expectation and independent staging's latest detectable level must remain two distinct constants");
  const upToDateLiveSchema = check(buildDataHealthReport(baseFacts({ currentMigrationLevel: "0022" })), "live-schema");
  assert.equal(upToDateLiveSchema.status, "healthy");
  assert.equal(upToDateLiveSchema.value, "0022 / 0022");
  assert.match(upToDateLiveSchema.explanation, /0020 is data-only/i, "0020's schema-invisibility must be called out explicitly, not silently ignored");

  // ---- 8. A true structural schema mismatch on independent staging still
  // fails clearly -- extending detection past 0019 must never soften a
  // genuine gap. ----
  const genuinelyBehindReport = buildDataHealthReport(baseFacts({ currentMigrationLevel: "0021" }));
  const behindLiveSchema = check(genuinelyBehindReport, "live-schema");
  assert.equal(behindLiveSchema.status, "critical", "a schema that only has 0021, not 0022, must still fail -- extending detection must never quietly relax the comparison");
  assert.equal(behindLiveSchema.value, "0021 / 0022");
  // The structural DDL comparison (schema-comparison) is the authoritative
  // current-schema integrity check and must independently still fail on a
  // real difference, regardless of the migration-level sentinels above.
  const structuralMismatchReport = buildDataHealthReport(baseFacts({ schemaMatchesBaseline: false, schemaComparisonDifferences: ["Missing table: import_preview_session_chunks."] }));
  const schemaComparison = check(structuralMismatchReport, "schema-comparison");
  assert.equal(schemaComparison.status, "critical");
  assert.deepEqual(schemaComparison.diagnosticLines, ["Missing table: import_preview_session_chunks."]);

  // ---- 9. The standalone "Failed or incomplete imports" card is gone --
  // Import review state is the single user-facing place for it -- but the
  // underlying fact/query is untouched and a real failed import still
  // surfaces clearly (alerting is not weakened, only de-duplicated).
  const failedImportsReport = buildDataHealthReport(baseFacts({ failedOrIncompleteImports: 2 }));
  assert.equal(check(failedImportsReport, "failed-imports"), undefined, "the redundant standalone card must be removed");
  const reviewStateWithFailure = check(failedImportsReport, "import-review-state");
  assert.equal(reviewStateWithFailure.status, "attention", "a failed/incomplete import must still surface as an actionable warning");
  assert.equal(reviewStateWithFailure.value, "0 saved · 0 unresolved · 2 failed");
  assert.ok(reviewStateWithFailure.diagnosticLines.some((line) => /2 failed or incomplete import\(s\)/.test(line)));
  assert.equal(failedImportsReport.status, "attention", "a real failed import must still push the overall report status away from healthy");

  // ---- 10. Automated backup / restore verification / manual export are
  // three independent cards, never merged into one ambiguous fact. ----
  const cleanReport = buildDataHealthReport(baseFacts());
  assert.equal(check(cleanReport, "automated-backup").status, "healthy");
  assert.equal(check(cleanReport, "restore-verification").status, "healthy");
  // "Backup succeeded" and "restore verification succeeded" are not the
  // same fact: a card must exist for each, independently.
  assert.notEqual(check(cleanReport, "automated-backup"), undefined);
  assert.notEqual(check(cleanReport, "restore-verification"), undefined);

  // Unreachable status must never render as healthy -- it is Unknown, a
  // third state distinct from both healthy and failed.
  const unreachableReport = buildDataHealthReport(baseFacts({ backupStatusReachable: false, backupSuccess: null, backupAttempt: null, restoreSuccess: null, restoreAttempt: null }));
  assert.equal(check(unreachableReport, "automated-backup").status, "unavailable");
  assert.equal(check(unreachableReport, "restore-verification").status, "unavailable");
  assert.notEqual(check(unreachableReport, "automated-backup").status, "healthy");

  // Attempt-floors-status: the last SUCCESS is still fresh, but the most
  // recent ATTEMPT (newer than that success) failed -- the card must not
  // read healthy just because the age-based clock hasn't caught up yet.
  const oldSuccessAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago -- healthy on age alone
  const newerFailedAttemptAt = new Date(Date.now() - 30 * 60 * 1000).toISOString(); // 30m ago -- newer than the success
  const flooredReport = buildDataHealthReport(baseFacts({
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: oldSuccessAt, backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: newerFailedAttemptAt, attemptStatus: "failure", workflowRunId: "3", workflowRunUrl: "https://github.com/example/repo/actions/runs/3" },
  }));
  assert.equal(check(flooredReport, "automated-backup").status, "attention", "a known-failed most-recent attempt must floor the card at attention even while the last success is still within its healthy window");
  assert.match(check(flooredReport, "automated-backup").explanation, /most recent attempt/i);

  // An OLDER failed attempt (superseded by a later success) must not
  // floor anything -- only the MOST RECENT attempt matters.
  const supersededReport = buildDataHealthReport(baseFacts({
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: rightNow(), backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "4", workflowRunUrl: "https://github.com/example/repo/actions/runs/4" },
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), attemptStatus: "failure", workflowRunId: "3", workflowRunUrl: "https://github.com/example/repo/actions/runs/3" },
  }));
  assert.equal(check(supersededReport, "automated-backup").status, "healthy", "a failed attempt older than the most recent success must not floor the card -- it has already been superseded");

  // Freshness thresholds: attention band and critical band, backup side.
  const attentionAgeBackup = buildDataHealthReport(baseFacts({
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    backupAttempt: null,
  }));
  assert.equal(check(attentionAgeBackup, "automated-backup").status, "attention", "48h old is inside the 36-72h attention band");
  const criticalAgeBackup = buildDataHealthReport(baseFacts({
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: new Date(Date.now() - 96 * 60 * 60 * 1000).toISOString(), backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    backupAttempt: null,
  }));
  assert.equal(check(criticalAgeBackup, "automated-backup").status, "critical", "96h old is past the 72h critical threshold");

  // Freshness thresholds, restore-verification side (day-scale).
  const attentionAgeRestore = buildDataHealthReport(baseFacts({
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString(), verifiedBackupObjectKey: "latest/x.sql.gz.gpg", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    restoreAttempt: null,
  }));
  assert.equal(check(attentionAgeRestore, "restore-verification").status, "attention", "50 days old is inside the 40-60 day attention band");
  const criticalAgeRestore = buildDataHealthReport(baseFacts({
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: new Date(Date.now() - 65 * 24 * 60 * 60 * 1000).toISOString(), verifiedBackupObjectKey: "latest/x.sql.gz.gpg", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    restoreAttempt: null,
  }));
  assert.equal(check(criticalAgeRestore, "restore-verification").status, "critical", "65 days old is past the 60-day critical threshold");

  // ---- 11. Regression coverage for the backup/restore-provenance fix:
  // restore-verification now carries the SPECIFIC immutable dated backup
  // it actually tested (verifiedBackupObjectKey/verifiedBackupCompletedAt),
  // distinct from both the restore test's own completedAt and any newer
  // nightly backup that may exist -- see .github/workflows/
  // d1-restore-verify-monthly.yml and lib/data-health/model.ts's
  // restoreVerificationCheck. ----
  const identityKnownAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // the restore TEST itself ran 5h ago
  const testedBackupAt = "2026-08-17T08:32:36.000Z"; // the SPECIFIC dated backup it restored -- a genuinely different date
  const identityKnownReport = buildDataHealthReport(baseFacts({
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: identityKnownAt, verifiedLatestObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", verifiedBackupObjectKey: "daily/fundraising-os-staging-db-20260817T083236Z.sql.gz.gpg", verifiedBackupCompletedAt: testedBackupAt, workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
  }));
  const identityKnownCheck = check(identityKnownReport, "restore-verification");
  assert.equal(identityKnownCheck.status, "healthy");
  assert.equal(identityKnownCheck.label, "Monthly restore test", "the card must be relabeled so it can never be read as 'every backup is restore-tested'");
  assert.equal(identityKnownCheck.value, identityKnownAt, "the card's value is the restore TEST's own completion time, not the tested backup's date");
  assert.match(identityKnownCheck.explanation, /Aug 17, 2026/, "the explanation must name the specific dated backup that was actually tested");
  assert.match(identityKnownCheck.explanation, /Restore testing runs monthly/, "must always clarify the cadence so a healthy card is never mistaken for per-backup coverage");
  assert.match(identityKnownCheck.evidence.actual, /daily\/fundraising-os-staging-db-20260817T083236Z\.sql\.gz\.gpg/, "evidence must cite the exact dated object key that was tested");

  // ---- 12. Three genuinely separate, independently-readable facts --
  // latest nightly backup timestamp, monthly restore-test timestamp, and
  // the tested backup's own identity/date -- never collapsed into one. ----
  const backupOwnAt = "2026-08-18T08:24:44.000Z";
  const threeDatesReport = buildDataHealthReport(baseFacts({
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: backupOwnAt, backupObjectKey: "daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: identityKnownAt, verifiedLatestObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", verifiedBackupObjectKey: "daily/fundraising-os-staging-db-20260817T083236Z.sql.gz.gpg", verifiedBackupCompletedAt: testedBackupAt, workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
  }), "2026-08-18T09:00:00.000Z");
  const backupCard = check(threeDatesReport, "automated-backup");
  const restoreCard = check(threeDatesReport, "restore-verification");
  assert.equal(backupCard.value, backupOwnAt, "the backup card's own timestamp is independent");
  assert.equal(restoreCard.value, identityKnownAt, "the restore card's own timestamp (when the TEST ran) is independent of both the backup's and the tested backup's dates");
  assert.match(restoreCard.explanation, /Aug 17, 2026/, "the tested-backup identity/date is a third, separately-stated fact");
  assert.notEqual(backupCard.value, restoreCard.value, "all three dates in play (backup completedAt, restore-test completedAt, tested-backup completedAt) must be distinguishable, not merged");

  // ---- 13. A newer nightly backup than the last restore-tested backup
  // does NOT by itself downgrade restore health -- this is normal under
  // the nightly/monthly architecture, not a fault. Mirrors the real
  // Aug 18 backup / Aug 17 restore-test case exactly. ----
  const realExampleReport = buildDataHealthReport(baseFacts({
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: "2026-08-18T08:24:44.000Z", backupObjectKey: "daily/fundraising-os-staging-db-20260818T082441Z.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: "2026-08-17T15:49:05.000Z", verifiedLatestObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", verifiedBackupObjectKey: "daily/fundraising-os-staging-db-20260817T083236Z.sql.gz.gpg", verifiedBackupCompletedAt: "2026-08-17T08:32:36.000Z", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
  }), "2026-08-18T09:10:00.000Z");
  assert.equal(check(realExampleReport, "automated-backup").status, "healthy", "the Aug 18 backup, hours old, is healthy on its own freshness clock");
  assert.equal(check(realExampleReport, "restore-verification").status, "healthy", "the Aug 17 restore test, well under 40 days old, is healthy on its own freshness clock -- a fresher nightly backup existing must never downgrade it");
  assert.match(check(realExampleReport, "restore-verification").explanation, /Aug 17, 2026/, "explanation still honestly names the Aug 17 backup as what was actually tested, not the newer Aug 18 one");

  // ---- 14. The failed-attempt-floors-status rule applies to
  // restore-verification too, not just automated-backup. ----
  const restoreOldSuccessAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(); // 5 days ago -- healthy on age alone
  const restoreNewerFailedAttemptAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago -- newer than the success
  const restoreFlooredReport = buildDataHealthReport(baseFacts({
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: restoreOldSuccessAt, verifiedLatestObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", verifiedBackupObjectKey: "daily/x.sql.gz.gpg", verifiedBackupCompletedAt: restoreOldSuccessAt, workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    restoreAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: restoreNewerFailedAttemptAt, attemptStatus: "failure", workflowRunId: "6", workflowRunUrl: "https://github.com/example/repo/actions/runs/6" },
  }));
  assert.equal(check(restoreFlooredReport, "restore-verification").status, "attention", "a known-failed most-recent restore attempt must floor the card at attention even while the last success is still within its healthy window");
  assert.match(check(restoreFlooredReport, "restore-verification").explanation, /most recent monthly restore test/i);

  // ---- 15. A restore success with unestablished tested-backup identity
  // (both fields null -- e.g. backup-latest-success.json was unreadable
  // when the workflow ran) must never be presented as a known dated
  // backup: no fabricated date anywhere in the explanation, and evidence
  // must never cite a specific object key it has no proof of. ----
  const unknownIdentityReport = buildDataHealthReport(baseFacts({
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: rightNow(), verifiedLatestObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", verifiedBackupObjectKey: null, verifiedBackupCompletedAt: null, workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
  }));
  const unknownIdentityCheck = check(unknownIdentityReport, "restore-verification");
  assert.equal(unknownIdentityCheck.status, "healthy", "an unknown tested-backup identity does not itself make the restore test unsuccessful");
  assert.doesNotMatch(unknownIdentityCheck.explanation, /\b(19|20)\d{2}\b/, "must never state any year/date as if it were the confirmed tested-backup date when identity is unknown");
  assert.match(unknownIdentityCheck.explanation, /could not be confirmed/i, "must explicitly say the tested backup's identity is unconfirmed, never silently omit the caveat");
  assert.doesNotMatch(unknownIdentityCheck.evidence.actual, /daily\//, "evidence must never cite a specific dated object key it doesn't actually have proof of");

  // A pipeline that has attempted but never once succeeded is worse than
  // one that simply hasn't run yet -- must read critical, not info.
  const neverSucceededReport = buildDataHealthReport(baseFacts({
    backupSuccess: null,
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: rightNow(), attemptStatus: "failure", workflowRunId: "5", workflowRunUrl: "https://github.com/example/repo/actions/runs/5" },
  }));
  assert.equal(check(neverSucceededReport, "automated-backup").status, "critical");
  assert.equal(check(neverSucceededReport, "automated-backup").value, "Never succeeded");

  // Manual export: absence must never look alarming, regardless of
  // whether the workspace has real business data.
  const noManualExportReport = buildDataHealthReport(baseFacts({ lastManualExportAt: null, activeDonors: 12 }));
  const manualExportCard = check(noManualExportReport, "manual-export");
  assert.equal(manualExportCard.status, "info", "a missing manual/partial export must never be attention or critical -- the automated backup is this workspace's real protection");
  assert.notEqual(manualExportCard.status, "attention");
  assert.notEqual(manualExportCard.status, "critical");

  process.stdout.write("Workspace Health semantic-cleanup checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
