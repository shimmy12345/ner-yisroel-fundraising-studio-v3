import assert from "node:assert/strict";
import test from "node:test";
import { APP_VERSION, EXPECTED_MIGRATION_LEVEL, LATEST_MIGRATION_LEVEL, buildDataHealthReport, isProductionEnvironment, usesLatestDetectableMigrationLevel } from "../lib/data-health/model.ts";

const now = 1_786_000_000;

function productionFacts(overrides = {}) {
  return {
    deploymentEnvironment: "production",
    databaseConnected: true,
    schemaReady: true,
    currentMigrationLevel: "0019",
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
    productionBaselineEvidenceSource: "Live query against the production D1 binding (production_schema_baseline table, id '0019').",
    productionBaselineVerifiedAt: "2026-08-01T00:00:00.000Z",
    schemaMatchesBaseline: true,
    schemaComparisonDifferences: [],
    businessDataRows: 0,
    fundraisingDataRows: 0,
    accountConfigurationRows: 1,
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
    lastHouseholdRefreshAt: null,
    lastDonationRefreshAt: null,
    lastManualExportAt: null,
    appVersion: APP_VERSION,
    deployedCommit: "prod123",
    ...overrides,
  };
}

function stagingFacts(overrides = {}) {
  return {
    ...productionFacts(),
    deploymentEnvironment: "staging",
    productionBaselineApplied: true,
    productionBaselineState: "not-applicable",
    productionBaselineEvidenceSource: "Not evaluated: this request is not against the production environment.",
    productionBaselineVerifiedAt: null,
    ...overrides,
  };
}

function independentStagingFacts(overrides = {}) {
  return {
    ...productionFacts(),
    deploymentEnvironment: "staging-independent",
    // Independent staging intentionally runs ahead of production's pinned
    // 0019 expectation -- migrations 0021/0022 are applied here, so its
    // "Live schema version" card compares against LATEST_MIGRATION_LEVEL
    // ("0022"), not EXPECTED_MIGRATION_LEVEL.
    currentMigrationLevel: "0022",
    businessRecordCounts: { donors: 0, givingActivities: 0, interactions: 0, reminders: 0 },
    // Automated backup / restore verification render on both independent
    // Staging and independent Production (not legacy staging/production) --
    // default to a healthy, reachable status here so tests unrelated to
    // this pipeline (e.g. deployed-commit metadata) aren't incidentally
    // affected by it. See tests/workspace-health-semantics.test.mjs for
    // this pipeline's own freshness/attempt-floors-status/unavailable-state
    // coverage, and this file's own "Production Workspace Health" block
    // below for independent Production's equivalent coverage.
    backupStatusReachable: true,
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: new Date().toISOString(), backupObjectKey: "daily/fundraising-os-staging-db-example.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: new Date().toISOString(), attemptStatus: "success", workflowRunId: "1", workflowRunUrl: "https://github.com/example/repo/actions/runs/1" },
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt: new Date().toISOString(), verifiedBackupObjectKey: "latest/fundraising-os-staging-db.sql.gz.gpg", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    restoreAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: new Date().toISOString(), attemptStatus: "success", workflowRunId: "2", workflowRunUrl: "https://github.com/example/repo/actions/runs/2" },
    ...overrides,
  };
}

function independentProductionFacts(overrides = {}) {
  return {
    ...productionFacts(),
    deploymentEnvironment: "production-independent",
    // The packaged baseline artifact is continually regenerated to include
    // every migration while deliberately keeping its own historical "0019"
    // file-origin label unchanged (see production-baseline.ts's own
    // comment on PRODUCTION_BASELINE_LEVEL) -- a freshly-bootstrapped
    // independent Production database genuinely reports "0022" here, the
    // newest migration inferMigrationLevel can detect, never the stale
    // "0019" pin. This is the realistic fixture value the 2026-10-11
    // investigation found missing from this test file
    // (docs/PRODUCTION-SCHEMA-MISMATCH-INVESTIGATION.md) -- every prior
    // "production" fixture here used "0019", silently matching
    // EXPECTED_MIGRATION_LEVEL by construction and never exercising the
    // real-world case that actually reached the owner's screen.
    currentMigrationLevel: "0022",
    businessRecordCounts: { donors: 0, givingActivities: 0, interactions: 0, reminders: 0 },
    ...overrides,
  };
}

const check = (report, id) => report.checks.find((c) => c.id === id);

test("verified baseline: production reports Ready with no blockers", () => {
  const report = buildDataHealthReport(productionFacts());
  assert.equal(check(report, "production-baseline").status, "healthy");
  assert.equal(check(report, "production-baseline").value, "0019 · Verified");
  assert.equal(check(report, "production-readiness").status, "healthy");
  assert.equal(check(report, "production-readiness").value, "Ready");
  assert.equal(report.platform.productionReadinessBlockers.length, 0);
});

test("missing artifact: production reports Not yet applied, not a generic Failed", () => {
  const report = buildDataHealthReport(productionFacts({ productionBaselineState: "not-applied", productionBaselineApplied: false, productionBaselineEvidenceSource: "Live query against the production D1 binding: no production_schema_baseline table exists." }));
  const baseline = check(report, "production-baseline");
  assert.equal(baseline.status, "critical");
  assert.equal(baseline.value, "0019 · Not yet applied");
  assert.equal(baseline.evidence.businessDataAtRisk, false);
  assert.match(baseline.evidence.repairStep, /0000_production_baseline_0019\.sql/);
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("baseline is not verified")));
});

test("stale artifact: hash mismatch is distinguished from missing artifact and never blocks launch readiness or flags business-data risk (October 14 2026 Production Health correction)", () => {
  const report = buildDataHealthReport(productionFacts({ productionBaselineState: "hash-mismatch", productionBaselineApplied: false }));
  const baseline = check(report, "production-baseline");
  // A hash-mismatch means the historical stamp predates a later, legitimate
  // migration -- the baseline genuinely was applied, so this must never
  // read as critical, never block readiness, and never claim business data
  // is at risk. "Production ↔ baseline schema" (schema-comparison) is the
  // current, authoritative structural proof, computed independently below.
  assert.equal(baseline.status, "info");
  assert.notEqual(baseline.status, "critical");
  assert.equal(baseline.value, "0019 · Stale stamp");
  assert.notEqual(baseline.value, "0019 · Not yet applied");
  assert.equal(baseline.evidence.businessDataAtRisk, false);
  assert.equal(check(report, "production-readiness").value, "Ready", "a stale stamp alone must never block Production launch readiness");
  assert.deepEqual(report.platform.productionReadinessBlockers, []);
});

test("schema mismatch: staging/baseline schema comparison blocks readiness independently of the baseline check", () => {
  const report = buildDataHealthReport(productionFacts({ schemaMatchesBaseline: false, schemaComparisonDifferences: ["Missing table: donor_views."] }));
  assert.equal(check(report, "production-baseline").status, "healthy", "baseline verification itself is unaffected by a schema drift found elsewhere");
  assert.equal(check(report, "schema-comparison").status, "critical");
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("1 difference")));
});

test("unknown result: an unreadable marker reports Unknown, never Failed, and still blocks launch", () => {
  const report = buildDataHealthReport(productionFacts({ productionBaselineState: "unreadable", productionBaselineApplied: false, productionBaselineEvidenceSource: "Live query against production_schema_baseline failed (connection or query error) after the table was found." }));
  const baseline = check(report, "production-baseline");
  assert.equal(baseline.status, "unavailable", "evidence-missing must never render as critical/Failed");
  assert.equal(baseline.value, "0019 · Unknown");
  assert.notEqual(baseline.status, "critical");
  assert.equal(check(report, "production-readiness").value, "Blocked", "an unknown baseline state must still block launch");
});

test("true failure: baseline is verified but relationship-data integrity is broken, and only that is listed as a blocker", () => {
  const report = buildDataHealthReport(productionFacts({ duplicateJlCodes: 2 }));
  assert.equal(check(report, "production-baseline").status, "healthy", "an unrelated integrity failure must not retroactively fail the baseline check");
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.deepEqual(report.platform.productionReadinessBlockers, ["One or more relationship-data integrity checks (duplicates, orphans, broken merge redirects) have not passed."]);
});

test("staging never derives production readiness from its own local baseline-marker state", () => {
  const report = buildDataHealthReport(stagingFacts());
  const baseline = check(report, "production-baseline");
  const readiness = check(report, "production-readiness");
  assert.notEqual(baseline.value, "0019 · Failed", "staging must never show the old ambiguous Failed value");
  assert.notEqual(readiness.value, "Blocked", "staging must never claim production launch readiness is Blocked");
  assert.equal(baseline.label, "Production baseline artifact");
  assert.equal(readiness.status, "info");
  assert.match(readiness.explanation, /never derived from staging/);
});

test("independent staging: verified clean baseline, empty business data, and one configured owner render the exact requested summary, with no production-launch wording", () => {
  const report = buildDataHealthReport(independentStagingFacts({ fundraisingDataRows: 0, accountConfigurationRows: 1, activeDonors: 0 }));
  assert.equal(check(report, "independent-staging-environment").value, "Independent Staging");
  assert.equal(check(report, "independent-staging-baseline").value, "0019 · Verified · stamped 2026-08-01");
  assert.equal(check(report, "independent-staging-business-data").value, "Empty");
  assert.equal(check(report, "independent-staging-account-setup").value, "1 owner configured");

  // Production-only wording and launch-readiness claims must remain production-only.
  const readiness = check(report, "production-readiness");
  assert.equal(readiness.status, "info", "independent staging must never claim production launch readiness");
  assert.notEqual(readiness.value, "Blocked");
  assert.equal(check(report, "production-baseline").label, "Production baseline artifact", "independent staging reuses legacy staging's informational-only production-baseline wording verbatim");
  assert.deepEqual(report.platform.productionReadinessBlockers, []);
});

test("independent staging: an unreadable baseline marker reports Unknown, never Failed, on the independent-staging-specific check", () => {
  const report = buildDataHealthReport(independentStagingFacts({ productionBaselineState: "unreadable", productionBaselineApplied: false }));
  const baseline = check(report, "independent-staging-baseline");
  assert.equal(baseline.value, "0019 · Unknown");
  assert.equal(baseline.status, "unavailable");
  assert.notEqual(baseline.status, "critical");
});

test("independent staging: a stale baseline stamp (hash differs from the current packaged manifest) is informational, not a structural failure", () => {
  const report = buildDataHealthReport(independentStagingFacts({ productionBaselineState: "hash-mismatch", productionBaselineApplied: false }));
  const baseline = check(report, "independent-staging-baseline");
  assert.equal(baseline.value, "0019 · Stale stamp (2026-08-01)");
  // A hash-mismatch here only ever means the point-in-time stamp predates a
  // later migration -- it is expected drift, not a current structural
  // failure, and must never be presented as business-data risk. The
  // authoritative current-schema check is "Staging ↔ baseline schema"
  // (schema-comparison), not this stamp.
  assert.equal(baseline.status, "info");
  assert.notEqual(baseline.status, "critical");
  assert.equal(baseline.evidence.businessDataAtRisk, false);
  assert.doesNotMatch(baseline.explanation, /may not be what this build expects/i, "must never claim the live schema itself is in doubt -- that is schema-comparison's job");
  assert.match(baseline.explanation, /expected|drift|not.*corrupt/i);
});

test("independent staging: the owner's account row alone (no fundraising data) never triggers a business-data warning", () => {
  // businessDataRows/fundraisingDataRows still reflect the raw all-tables
  // counts (as computed by BUSINESS_DATA_COUNT_SQL / FUNDRAISING_DATA_COUNT_SQL
  // for the backup-safety gate, unaffected by this fix) but
  // businessRecordCounts (donors/giving activities/interactions/reminders
  // only) is what the Business data check itself reads and displays.
  const report = buildDataHealthReport(independentStagingFacts({ businessDataRows: 2, fundraisingDataRows: 0, accountConfigurationRows: 1, activeDonors: 0 }));
  const businessData = check(report, "independent-staging-business-data");
  assert.equal(businessData.value, "Empty");
  assert.equal(businessData.status, "healthy");
  const accountSetup = check(report, "independent-staging-account-setup");
  assert.equal(accountSetup.value, "1 owner configured");
  assert.equal(accountSetup.status, "info");
});

test("independent staging: adding a fictional donor or gift changes Business data to non-empty, informationally, not as a warning", () => {
  const report = buildDataHealthReport(independentStagingFacts({ businessDataRows: 3, fundraisingDataRows: 1, accountConfigurationRows: 1, activeDonors: 1, businessRecordCounts: { donors: 1, givingActivities: 0, interactions: 0, reminders: 0 } }));
  const businessData = check(report, "independent-staging-business-data");
  assert.notEqual(businessData.value, "Empty");
  assert.match(businessData.value, /1 donor/);
  assert.doesNotMatch(businessData.explanation, /expected to remain empty/i, "the old invariant-violation wording must be gone");
  assert.match(businessData.explanation, /intentionally populated/i);
  // Intentionally populated independent staging is expected, current
  // behavior -- it must never be flagged as a warning merely for having
  // data (requirement: real fundraising records here are normal, not a
  // problem to draw attention to).
  assert.equal(businessData.status, "healthy");
  // Import batches, change audits, and draft bookkeeping must never be
  // blended into this business-record count.
  assert.doesNotMatch(businessData.value, /import|audit|draft/i);
  // Adding fundraising data must not change the separately-tracked account count.
  assert.equal(check(report, "independent-staging-account-setup").value, "1 owner configured");
});

test("independent-staging summary checks do not appear on legacy staging or production", () => {
  const stagingReport = buildDataHealthReport(stagingFacts());
  const productionReport = buildDataHealthReport(productionFacts());
  for (const report of [stagingReport, productionReport]) {
    assert.equal(check(report, "independent-staging-environment"), undefined);
    assert.equal(check(report, "independent-staging-baseline"), undefined);
    assert.equal(check(report, "independent-staging-business-data"), undefined);
    assert.equal(check(report, "independent-staging-account-setup"), undefined);
  }
});

test("missing deployed-commit metadata is informational and never taints the overall report status", () => {
  const report = buildDataHealthReport(independentStagingFacts({ deployedCommit: null }));
  const release = check(report, "release");
  assert.equal(release.status, "info", "a missing commit SHA must never render as attention/critical");
  assert.equal(release.value, report.platform.appVersion, "falls back to the app version alone");
  assert.equal(report.status, "healthy", "missing build metadata must not push the overall report away from healthy");
});

test("a present deployed commit shows the app version and a short SHA, and stays healthy", () => {
  const report = buildDataHealthReport(independentStagingFacts({ deployedCommit: "abcdef1234567890" }));
  const release = check(report, "release");
  assert.equal(release.status, "healthy");
  assert.equal(release.value, `${report.platform.appVersion} · abcdef1`);
});

// ---- Independent Production (deploymentEnvironment: "production-independent")
// -- added 2026-10-11 after the first real deployment surfaced a false
// "Live schema version: 0022 / 0019 -- ERROR" and several Staging-labeled
// cards on the real, live Production environment. See
// docs/PRODUCTION-SCHEMA-MISMATCH-INVESTIGATION.md (root cause) and
// docs/PRODUCTION-HEALTH-REPORTING-FIX.md (the fix these tests cover). ----

test("independent production: a healthy environment at the realistic 0022 schema level reports Ready with no blockers", () => {
  const report = buildDataHealthReport(independentProductionFacts());
  const liveSchema = check(report, "live-schema");
  assert.equal(liveSchema.status, "healthy", "0022 is the correct live level for a freshly-bootstrapped independent Production database -- it must not read as a mismatch against the stale 0019 pin");
  assert.equal(liveSchema.value, "0022 / 0022");
  assert.equal(check(report, "production-readiness").status, "healthy");
  assert.equal(check(report, "production-readiness").value, "Ready");
  assert.equal(report.platform.productionReady, true);
  assert.deepEqual(report.platform.productionReadinessBlockers, []);
});

test("independent production: a valid baseline marker is verified against the real, live production_schema_baseline row -- not the build-time-only informational artifact independent production previously fell through to", () => {
  const report = buildDataHealthReport(independentProductionFacts());
  const baseline = check(report, "production-baseline");
  assert.equal(baseline.label, "Production rehearsal baseline", "must take the real, live-query branch");
  assert.equal(baseline.status, "healthy");
  assert.equal(baseline.value, "0019 · Verified");
  assert.match(baseline.explanation, /schema_hash matches the packaged 0019 baseline exactly/);
});

test("independent production: a missing baseline marker blocks readiness exactly as it does for legacy production", () => {
  const report = buildDataHealthReport(independentProductionFacts({ productionBaselineState: "not-applied", productionBaselineApplied: false }));
  const baseline = check(report, "production-baseline");
  assert.equal(baseline.status, "critical");
  assert.equal(baseline.value, "0019 · Not yet applied");
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("baseline is not verified")));
});

test("independent production: a stale baseline stamp (hash differs from the current packaged manifest) never blocks readiness and is never a business-data risk (October 14 2026 Production Health correction)", () => {
  const report = buildDataHealthReport(independentProductionFacts({ productionBaselineState: "hash-mismatch", productionBaselineApplied: false }));
  const baseline = check(report, "production-baseline");
  assert.equal(baseline.status, "info");
  assert.notEqual(baseline.status, "critical");
  assert.equal(baseline.value, "0019 · Stale stamp");
  assert.equal(baseline.evidence.businessDataAtRisk, false);
  assert.doesNotMatch(baseline.explanation, /may not be what this build expects/i, "must never claim the live schema itself is in doubt -- that is schema-comparison's job");
  const readiness = check(report, "production-readiness");
  assert.equal(readiness.value, "Ready", "an outdated historical baseline stamp alone must never block Production launch readiness after a legitimate migration");
  assert.equal(readiness.status, "healthy");
  assert.deepEqual(report.platform.productionReadinessBlockers, []);
  assert.equal(report.platform.productionReady, true);
});

test("independent production: the Production migration history card reflects a stale stamp informationally, never as Unverified (October 14 2026 Production Health correction)", () => {
  const report = buildDataHealthReport(independentProductionFacts({ productionBaselineState: "hash-mismatch", productionBaselineVerifiedAt: "2026-08-01T00:00:00.000Z" }));
  const history = check(report, "staging-migration-history");
  assert.equal(history.label, "Production migration history");
  assert.equal(history.status, "info");
  assert.notEqual(history.status, "critical");
  assert.equal(history.value, "Baseline 0019 · Stale stamp (2026-08-01)");
  assert.notEqual(history.value, "Unverified", "the database genuinely was created from the verified baseline -- a stale stamp must never read as if the baseline marker were missing");
  assert.match(history.explanation, /predates one or more later, legitimate migrations/i);
});

test("independent production: a genuinely missing baseline marker still shows Unverified on the Production migration history card, distinct from a stale stamp", () => {
  const report = buildDataHealthReport(independentProductionFacts({ productionBaselineState: "not-applied" }));
  const history = check(report, "staging-migration-history");
  assert.equal(history.status, "critical");
  assert.equal(history.value, "Unverified");
});

// ---- Comprehensive coverage for the October 14 2026 Production Health
// correction: the overall report.status rollup (what the owner actually
// sees as "Healthy" / "Needs attention"), not just individual check
// fields, across every productionBaselineState value, plus proof that
// every OTHER genuine problem category (schema mismatch, stale live
// migration level, relationship-integrity failure, giving-reconciliation
// failure, backup/restore failure) still fails the overall report exactly
// as before -- this fix touches nothing but the hash-mismatch state. ----

// Every test below passes the same fixed checkedAt the other
// productionBackupFacts()-based tests in this file use
// ("2026-10-12T12:00:00.000Z", matching productionBackupFacts()'s own
// backup/restore completedAt values) -- without it, buildDataHealthReport
// defaults to the real wall-clock time, making those fixed historical
// backup dates look stale relative to whenever this suite actually runs,
// which would fail these tests for a reason having nothing to do with the
// baseline-stamp fix under test here.
const BACKUP_FIXTURE_CHECKED_AT = "2026-10-12T12:00:00.000Z";

test("overall report.status: a stale baseline stamp alone resolves to healthy, not attention or critical", () => {
  // productionBackupFacts() (not the bare independentProductionFacts()) is
  // required here so the unrelated Automated backup / Monthly restore test
  // cards resolve to their own healthy defaults rather than "unavailable"
  // (no backup facts supplied) -- this test is specifically isolating the
  // baseline-stamp fix's effect on the overall rollup, not re-proving
  // backup-status plumbing already covered elsewhere in this file.
  const report = buildDataHealthReport(productionBackupFacts({ productionBaselineState: "hash-mismatch" }), BACKUP_FIXTURE_CHECKED_AT);
  assert.equal(report.status, "healthy");
  assert.equal(report.summary, "Workspace data and the application foundation are healthy.");
});

test("overall report.status: every genuinely blocking productionBaselineState still resolves to critical", () => {
  for (const state of ["not-applied", "unreadable"]) {
    const report = buildDataHealthReport(productionBackupFacts({ productionBaselineState: state }), BACKUP_FIXTURE_CHECKED_AT);
    assert.equal(report.status, "critical", `productionBaselineState "${state}" must still produce a critical overall report`);
    assert.equal(check(report, "production-readiness").value, "Blocked");
  }
});

test("overall report.status: a genuine structural schema mismatch still resolves to critical, unaffected by this fix", () => {
  const report = buildDataHealthReport(productionBackupFacts({ schemaMatchesBaseline: false, schemaComparisonDifferences: ["Missing table: donors."] }), BACKUP_FIXTURE_CHECKED_AT);
  assert.equal(report.status, "critical");
  assert.equal(check(report, "production-readiness").value, "Blocked");
});

test("overall report.status: a genuinely stale live migration level still resolves to critical, unaffected by this fix", () => {
  const report = buildDataHealthReport(productionBackupFacts({ currentMigrationLevel: "0019" }), BACKUP_FIXTURE_CHECKED_AT);
  assert.equal(report.status, "critical");
  assert.equal(check(report, "production-readiness").value, "Blocked");
});

test("overall report.status: a genuine relationship-data integrity failure still resolves to critical even with a verified baseline, unaffected by this fix", () => {
  const report = buildDataHealthReport(productionBackupFacts({ duplicateJlCodes: 3 }), BACKUP_FIXTURE_CHECKED_AT);
  assert.equal(report.status, "critical");
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("relationship-data integrity")));
});

test("overall report.status: a failed giving-total reconciliation still resolves to critical even with a verified baseline, unaffected by this fix", () => {
  const report = buildDataHealthReport(productionBackupFacts({ givingSourceTotalCents: 500, givingLinkedTotalCents: 400 }), BACKUP_FIXTURE_CHECKED_AT);
  assert.equal(report.status, "critical");
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("Giving-total reconciliation")));
});

test("overall report.status: a stale baseline stamp combined with a genuinely failed backup still blocks on the backup failure alone -- the stamp never masks a real problem", () => {
  const report = buildDataHealthReport(
    productionBackupFacts({
      productionBaselineState: "hash-mismatch",
      backupSuccess: null,
      backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-production-db", attemptAt: "2026-10-12T08:03:00.000Z", attemptStatus: "failure", workflowRunId: "999", workflowRunUrl: "https://github.com/example/repo/actions/runs/999" },
    }),
    "2026-10-12T12:00:00.000Z",
  );
  assert.equal(check(report, "production-baseline").status, "info", "the stale stamp itself must still read as informational, not critical");
  assert.equal(check(report, "automated-backup").status, "critical", "a genuinely failed backup must still be flagged, proving the baseline fix does not mask unrelated real failures");
});

test("independent production: a genuine structural schema mismatch still fails, independent of the baseline marker and the migration-level heuristic", () => {
  const report = buildDataHealthReport(independentProductionFacts({ schemaMatchesBaseline: false, schemaComparisonDifferences: ["Missing table: pledge_balance_corrections."] }));
  assert.equal(check(report, "production-baseline").status, "healthy", "an unrelated structural drift must not retroactively fail the baseline marker check");
  const comparison = check(report, "schema-comparison");
  assert.equal(comparison.status, "critical");
  assert.deepEqual(comparison.diagnosticLines, ["Missing table: pledge_balance_corrections."]);
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("baseline schema comparison found")));
});

test("independent production: a genuinely stale live schema (below the detectable ceiling) still fails -- the fix must not blanket-suppress real staleness", () => {
  const report = buildDataHealthReport(independentProductionFacts({ currentMigrationLevel: "0019" }));
  const liveSchema = check(report, "live-schema");
  assert.equal(liveSchema.status, "critical", "a database that has not actually been bootstrapped from the current baseline must still be flagged");
  assert.equal(liveSchema.value, "0019 / 0022");
  assert.equal(check(report, "production-readiness").value, "Blocked");
  assert.ok(report.platform.productionReadinessBlockers.some((line) => line.includes("Live migration level is 0019; expected 0022")));
});

test("independent production: an empty database (zero business data) is healthy, with a Production-specific label", () => {
  const report = buildDataHealthReport(independentProductionFacts({ businessDataRows: 0 }));
  const state = check(report, "business-data-state");
  assert.equal(state.label, "Production data state");
  assert.equal(state.status, "healthy");
  assert.equal(state.value, "Schema only");
});

test("independent production: every dashboard card carries a Production-specific label, with no leftover Staging-only wording", () => {
  const report = buildDataHealthReport(independentProductionFacts());
  assert.equal(check(report, "staging-migration-history").label, "Production migration history");
  assert.equal(check(report, "schema-comparison").label, "Production ↔ baseline schema");
  assert.equal(check(report, "business-data-state").label, "Production data state");
  assert.equal(check(report, "production-baseline").label, "Production rehearsal baseline");
  const readiness = check(report, "production-readiness");
  assert.notEqual(readiness.value, "Evaluated on production only", "independent production must receive a real verdict, never the non-production placeholder");
  assert.notEqual(readiness.status, "info");
  for (const item of report.checks) {
    assert.doesNotMatch(item.label, /^Staging/, `check "${item.id}" must not carry a Staging-prefixed label when viewed on independent production`);
  }
});

test("isProductionEnvironment / usesLatestDetectableMigrationLevel correctly classify every deployment environment", () => {
  assert.equal(isProductionEnvironment("production"), true);
  assert.equal(isProductionEnvironment("production-independent"), true);
  assert.equal(isProductionEnvironment("staging"), false);
  assert.equal(isProductionEnvironment("staging-independent"), false);
  assert.equal(usesLatestDetectableMigrationLevel("staging-independent"), true);
  assert.equal(usesLatestDetectableMigrationLevel("production-independent"), true);
  assert.equal(usesLatestDetectableMigrationLevel("production"), false, "legacy production's provenance was not re-verified by this fix -- it must not silently move to the 0022 ceiling");
  assert.equal(usesLatestDetectableMigrationLevel("staging"), false);
  assert.notEqual(EXPECTED_MIGRATION_LEVEL, LATEST_MIGRATION_LEVEL);
});

test("legacy production behavior is preserved: still compares against the historical 0019 pin, not the 0022 detection ceiling", () => {
  const healthyLegacy = buildDataHealthReport(productionFacts());
  assert.equal(check(healthyLegacy, "live-schema").value, "0019 / 0019");
  assert.equal(check(healthyLegacy, "live-schema").status, "healthy");
  // Feeding the same "0022" reading that independent production now
  // correctly treats as healthy, into LEGACY production (whose own
  // provenance this fix deliberately leaves unverified and unchanged),
  // must still report a mismatch -- proving this fix did not quietly move
  // legacy production's comparison basis along with independent production's.
  const hypotheticalLegacyAt0022 = buildDataHealthReport(productionFacts({ currentMigrationLevel: "0022" }));
  assert.equal(check(hypotheticalLegacyAt0022, "live-schema").status, "critical");
  assert.equal(check(hypotheticalLegacyAt0022, "live-schema").value, "0022 / 0019");
});

test("independent staging behavior is fully preserved: unchanged labels, unchanged 0022/0022 comparison, unchanged informational production-readiness verdict", () => {
  const report = buildDataHealthReport(independentStagingFacts());
  assert.equal(check(report, "live-schema").value, "0022 / 0022");
  assert.equal(check(report, "live-schema").status, "healthy");
  assert.match(check(report, "live-schema").explanation, /0020 is data-only/i);
  assert.equal(check(report, "schema-comparison").label, "Staging ↔ baseline schema", "staging-independent keeps its own existing label, unaffected by the new Production-specific label");
  assert.equal(check(report, "staging-migration-history").label, "Staging migration history");
  assert.equal(check(report, "production-baseline").label, "Production baseline artifact", "staging-independent keeps taking the non-production, informational branch exactly as before");
  const readiness = check(report, "production-readiness");
  assert.equal(readiness.status, "info");
  assert.equal(readiness.value, "Evaluated on production only");
  assert.match(readiness.explanation, /never derived from staging/);
});

// ---- Production Workspace Health: missing "Automated backup" / "Monthly
// restore test" cards (2026-10-12) -- these two cards are built by
// backupAndRestoreChecks() (lib/data-health/model.ts) and were historically
// only ever spliced into the checks array for deploymentEnvironment ===
// "staging-independent". Independent Production has carried its own,
// separate status-worker/R2 binding since 2026-10-09/11
// (wrangler.production.jsonc's STATUS_WORKER -> fundraising-os-production-
// backup-status) and lib/data-health/read.ts's fetchBackupStatus() was
// already environment-agnostic, so the live backup/restore evidence was
// being fetched correctly the whole time -- it was simply never rendered
// as cards on Production's own Workspace Health page. This block proves
// the fix without re-testing pipelineStatusCheck/restoreVerificationCheck's
// own freshness/attempt-floors-status logic, which tests/workspace-health-
// semantics.test.mjs already covers exhaustively against staging-independent
// and is unchanged by this fix (both functions are reused verbatim). ----

function productionBackupFacts(overrides = {}) {
  return independentProductionFacts({
    backupStatusReachable: true,
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-production-db", completedAt: "2026-10-12T08:03:00.000Z", backupObjectKey: "daily/fundraising-os-production-db-20261012T080300Z.sql.gz.gpg", workflowRunId: "101", workflowRunUrl: "https://github.com/example/repo/actions/runs/101" },
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-production-db", attemptAt: "2026-10-12T08:03:00.000Z", attemptStatus: "success", workflowRunId: "101", workflowRunUrl: "https://github.com/example/repo/actions/runs/101" },
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-production-db", completedAt: "2026-10-01T09:10:00.000Z", verifiedLatestObjectKey: "latest/fundraising-os-production-db.sql.gz.gpg", verifiedBackupObjectKey: "daily/fundraising-os-production-db-20261001T080300Z.sql.gz.gpg", verifiedBackupCompletedAt: "2026-10-01T08:03:00.000Z", workflowRunId: "102", workflowRunUrl: "https://github.com/example/repo/actions/runs/102" },
    restoreAttempt: { schemaVersion: 1, databaseName: "fundraising-os-production-db", attemptAt: "2026-10-01T09:10:00.000Z", attemptStatus: "success", workflowRunId: "102", workflowRunUrl: "https://github.com/example/repo/actions/runs/102" },
    ...overrides,
  });
}

test("independent production: Automated backup / Monthly restore test cards now render, using only Production's own status facts", () => {
  const report = buildDataHealthReport(productionBackupFacts(), "2026-10-12T12:00:00.000Z");
  const backup = check(report, "automated-backup");
  const restore = check(report, "restore-verification");
  assert.notEqual(backup, undefined, "the Automated backup card must now render on independent Production");
  assert.notEqual(restore, undefined, "the Monthly restore test card must now render on independent Production");
  assert.equal(backup.label, "Automated backup");
  assert.equal(restore.label, "Monthly restore test");
  assert.equal(backup.status, "healthy");
  assert.equal(restore.status, "healthy");
  // The displayed date/time is Production's own recorded completedAt, not a
  // fabricated or reformatted value.
  assert.equal(backup.value, "2026-10-12T08:03:00.000Z");
  assert.equal(restore.value, "2026-10-01T09:10:00.000Z");
  assert.match(backup.explanation, /fundraising-os-production-db-20261012T080300Z/, "must reflect Production's own object key, never Staging's");
  assert.doesNotMatch(JSON.stringify(report), /fundraising-os-staging-db/, "no Staging backup/restore identity may leak into a Production report");
});

test("independent production: Healthy, Overdue (attention), and Unavailable backup/restore statuses are all reachable with real data, same as independent Staging", () => {
  const unavailable = check(buildDataHealthReport(independentProductionFacts({ backupStatusReachable: false, backupSuccess: null, backupAttempt: null, restoreSuccess: null, restoreAttempt: null }), "2026-10-12T12:00:00.000Z"), "automated-backup");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.value, "Unknown");

  const overdueBackup = check(buildDataHealthReport(productionBackupFacts({ backupSuccess: { ...productionBackupFacts().backupSuccess, completedAt: "2026-10-08T08:03:00.000Z" }, backupAttempt: { ...productionBackupFacts().backupAttempt, attemptAt: "2026-10-08T08:03:00.000Z" } }), "2026-10-12T12:00:00.000Z"), "automated-backup");
  assert.equal(overdueBackup.status, "critical", "a backup over 72h old (Oct 8 -> Oct 12) must be critical, proving real freshness evaluation runs on Production too");

  const failedBackup = check(buildDataHealthReport(productionBackupFacts({ backupSuccess: null, backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-production-db", attemptAt: "2026-10-12T08:03:00.000Z", attemptStatus: "failure", workflowRunId: "999", workflowRunUrl: "https://github.com/example/repo/actions/runs/999" } }), "2026-10-12T12:00:00.000Z"), "automated-backup");
  assert.equal(failedBackup.status, "critical");
  assert.equal(failedBackup.value, "Never succeeded");
});

test("independent production: backup/restore cards are still absent from legacy production, matching every other production-independent-only check", () => {
  const legacyReport = buildDataHealthReport(productionFacts());
  assert.equal(check(legacyReport, "automated-backup"), undefined);
  assert.equal(check(legacyReport, "restore-verification"), undefined);
});

test("independent production: the independent-staging-only informational cards (Environment/Baseline lineage/Business data/Account setup) still never appear on independent Production", () => {
  const report = buildDataHealthReport(productionBackupFacts());
  for (const id of ["independent-staging-environment", "independent-staging-baseline", "independent-staging-business-data", "independent-staging-account-setup"]) {
    assert.equal(check(report, id), undefined, `"${id}" is Staging-specific wording and must not appear on independent Production`);
  }
});
