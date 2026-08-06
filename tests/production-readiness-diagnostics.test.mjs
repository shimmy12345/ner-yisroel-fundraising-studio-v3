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

test("independent staging: verified clean baseline and empty business data render the exact requested summary, with no production-launch wording", () => {
  const report = buildDataHealthReport(independentStagingFacts({ businessDataRows: 0, activeDonors: 0 }));
  assert.equal(check(report, "independent-staging-environment").value, "Independent Staging");
  assert.equal(check(report, "independent-staging-baseline").value, "Verified");
  assert.equal(check(report, "independent-staging-business-data").value, "Empty");

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
  assert.equal(baseline.value, "Unknown");
  assert.equal(baseline.status, "unavailable");
  assert.notEqual(baseline.status, "critical");
});

test("independent staging: a hash mismatch is reported as Mismatch on the independent-staging-specific check and flags business-data risk", () => {
  const report = buildDataHealthReport(independentStagingFacts({ productionBaselineState: "hash-mismatch", productionBaselineApplied: false }));
  const baseline = check(report, "independent-staging-baseline");
  assert.equal(baseline.value, "Mismatch");
  assert.equal(baseline.status, "critical");
  assert.equal(baseline.evidence.businessDataAtRisk, true);
});

test("independent staging: nonzero business data is reported, not Empty", () => {
  const report = buildDataHealthReport(independentStagingFacts({ businessDataRows: 3, activeDonors: 3 }));
  const businessData = check(report, "independent-staging-business-data");
  assert.notEqual(businessData.value, "Empty");
  assert.match(businessData.value, /3 row/);
  assert.equal(businessData.status, "attention");
});

test("independent-staging summary checks do not appear on legacy staging or production", () => {
  const stagingReport = buildDataHealthReport(stagingFacts());
  const productionReport = buildDataHealthReport(productionFacts());
  for (const report of [stagingReport, productionReport]) {
    assert.equal(check(report, "independent-staging-environment"), undefined);
    assert.equal(check(report, "independent-staging-baseline"), undefined);
    assert.equal(check(report, "independent-staging-business-data"), undefined);
  }
});
