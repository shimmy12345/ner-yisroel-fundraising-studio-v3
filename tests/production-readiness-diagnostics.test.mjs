import assert from "node:assert/strict";
import test from "node:test";
import { APP_VERSION, buildDataHealthReport } from "../lib/data-health/model.ts";

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
    lastBackupAt: null,
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

test("stale artifact: hash mismatch is distinguished from missing artifact and flags business-data risk", () => {
  const report = buildDataHealthReport(productionFacts({ productionBaselineState: "hash-mismatch", productionBaselineApplied: false }));
  const baseline = check(report, "production-baseline");
  assert.equal(baseline.status, "critical");
  assert.equal(baseline.value, "0019 · Mismatch");
  assert.notEqual(baseline.value, "0019 · Not yet applied");
  assert.equal(baseline.evidence.businessDataAtRisk, true);
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
