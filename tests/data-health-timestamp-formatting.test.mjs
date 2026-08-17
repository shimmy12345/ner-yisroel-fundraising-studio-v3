import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { formatTimestamp } from "../app/settings/dataHealthFormat.ts";
import { buildDataHealthReport, APP_VERSION } from "../lib/data-health/model.ts";

// Regression coverage for the 2026-08-17 fix: DataHealthDashboard.tsx's
// displayValue() gates human-readable formatting behind a hardcoded
// check-id allowlist that still said "backup" (the single card's id
// before it was split into "automated-backup"/"restore-verification"/
// "manual-export" earlier the same day). The new ids were never added, so
// those three cards silently fell back to raw ISO/UTC strings.

const SAMPLE_ISO = "2026-08-17T15:40:00.000Z";

test("formatTimestamp produces a human-readable date/time, not the raw ISO string", () => {
  const utc = formatTimestamp(SAMPLE_ISO, false);
  assert.notEqual(utc, SAMPLE_ISO, "must not simply pass the raw ISO string through");
  assert.doesNotMatch(utc, /T\d{2}:\d{2}:\d{2}/, "must not retain the raw ISO T-separated time format");
  assert.match(utc, /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[  ]?[AP]M UTC$/, `expected an "Aug 17, 2026, 3:40 PM UTC"-style string, got "${utc}"`);

  const local = formatTimestamp(SAMPLE_ISO, true);
  assert.notEqual(local, SAMPLE_ISO);
  assert.doesNotMatch(local, /T\d{2}:\d{2}:\d{2}/);
});

test("formatTimestamp leaves non-timestamp values (Never run, Unknown, etc.) unchanged", () => {
  for (const value of ["Never run", "Unknown", "Never succeeded", "No manual export yet"]) {
    assert.equal(formatTimestamp(value, false), value);
    assert.equal(formatTimestamp(value, true), value);
  }
});

test("formatTimestamp leaves a genuinely unparseable string unchanged rather than guessing", () => {
  assert.equal(formatTimestamp("not-a-date", false), "not-a-date");
});

test("DataHealthDashboard's displayValue allowlist covers the current Automated backup / Restore verification / Manual export card ids", () => {
  const ui = fs.readFileSync(new URL("../app/settings/DataHealthDashboard.tsx", import.meta.url), "utf8");
  const displayValueMatch = ui.match(/function displayValue\(check: HealthCheck, useLocalTime: boolean\) \{\s*\n\s*if \(!\[([^\]]+)\]\.includes\(check\.id\)/);
  assert.ok(displayValueMatch, "displayValue's allowlist guard must exist in its current recognizable shape");
  const allowlist = displayValueMatch[1].split(",").map((id) => id.trim().replace(/^"|"$/g, ""));
  assert.deepEqual(new Set(allowlist), new Set(["household-refresh", "donation-refresh", "automated-backup", "restore-verification", "manual-export"]));
  // The stale pre-redesign id must not silently be present as its own
  // list entry (distinct from "automated-backup"/"manual-export", which
  // legitimately contain "backup" as a substring).
  assert.ok(!allowlist.includes("backup"), "the old single-card id must not remain in the allowlist");
});

test("model.ts still sets raw, unformatted ISO timestamps as check.value -- formatting is a presentation-layer concern only", () => {
  const now = new Date("2026-08-17T16:00:00.000Z").toISOString();
  const completedAt = "2026-08-17T15:00:00.000Z"; // 1h old -- healthy on the backup card's freshness scale
  const facts = {
    deploymentEnvironment: "staging-independent", databaseConnected: true, schemaReady: true, currentMigrationLevel: "0022",
    migrationLedgerComplete: true, journalMigrationLevel: "0019", remoteMigrationLevel: "0019", remoteMigrationTable: "d1_migrations",
    remoteMigrationHistoryComplete: true, remoteMigrationHistoryConsistent: true, remoteMigrationDiagnosticLines: [],
    productionBaselineLevel: "0019", productionBaselineVerified: true, productionBaselineApplied: true, productionBaselineState: "verified",
    productionBaselineEvidenceSource: "test", productionBaselineVerifiedAt: null, schemaMatchesBaseline: true, schemaComparisonDifferences: [],
    businessDataRows: 0, fundraisingDataRows: 0, accountConfigurationRows: 1, businessRecordCounts: { donors: 0, givingActivities: 0, interactions: 0, reminders: 0 },
    activeDonors: 0, duplicateJlCodes: 0, orphanedGifts: 0, orphanedInteractions: 0, orphanedReminders: 0, orphanedPayments: 0, brokenMergeRedirects: 0,
    givingSourceTotalCents: 0, givingLinkedTotalCents: 0, invalidGivingRows: 0, duplicateGivingFingerprints: 0, unmatchedJlCodes: 0,
    pendingPledgeAssignments: 0, savedForLaterReviewRows: 0, unresolvedActiveDrafts: 0, failedOrIncompleteImports: 0,
    lastHouseholdRefreshAt: null, lastDonationRefreshAt: null, lastManualExportAt: Math.floor(new Date(completedAt).getTime() / 1000),
    backupStatusReachable: true,
    backupSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt, backupObjectKey: "daily/x.sql.gz.gpg", workflowRunId: "1", workflowRunUrl: "https://example/actions/runs/1" },
    backupAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: completedAt, attemptStatus: "success", workflowRunId: "1", workflowRunUrl: "https://example/actions/runs/1" },
    restoreSuccess: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", completedAt, verifiedBackupObjectKey: "latest/x.sql.gz.gpg", workflowRunId: "2", workflowRunUrl: "https://example/actions/runs/2" },
    restoreAttempt: { schemaVersion: 1, databaseName: "fundraising-os-staging-db", attemptAt: completedAt, attemptStatus: "success", workflowRunId: "2", workflowRunUrl: "https://example/actions/runs/2" },
    appVersion: APP_VERSION, deployedCommit: "abc1234",
  };
  const report = buildDataHealthReport(facts, now);
  const backupCheck = report.checks.find((check) => check.id === "automated-backup");
  const restoreCheck = report.checks.find((check) => check.id === "restore-verification");
  const manualExportCheck = report.checks.find((check) => check.id === "manual-export");

  // The status calculation already correctly used the raw timestamp to
  // decide "healthy" (proven by existing tests in
  // tests/workspace-health-semantics.test.mjs); this test's job is only to
  // confirm the *value* handed to the UI is still the exact, unformatted
  // ISO string -- formatting must happen at render time, not baked in here.
  assert.equal(backupCheck.status, "healthy");
  assert.equal(backupCheck.value, completedAt);
  assert.equal(restoreCheck.status, "healthy");
  assert.equal(restoreCheck.value, completedAt);
  assert.equal(manualExportCheck.value, completedAt);

  // And formatTimestamp turns that same raw value into the human-readable
  // form the dashboard now displays for all three -- proving the fix's
  // two halves (data stays raw, display formats it) fit together.
  for (const check of [backupCheck, restoreCheck, manualExportCheck]) {
    const displayed = formatTimestamp(check.value, false);
    assert.notEqual(displayed, check.value);
    assert.match(displayed, /^[A-Z][a-z]{2} \d{1,2}, \d{4}/);
  }
});
