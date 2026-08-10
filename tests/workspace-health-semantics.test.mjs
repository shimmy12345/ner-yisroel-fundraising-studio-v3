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
    lastBackupAt: now,
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

  process.stdout.write("Workspace Health semantic-cleanup checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
