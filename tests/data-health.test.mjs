import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  APP_VERSION,
  EXPECTED_MIGRATION_LEVEL,
  MIGRATION_LEDGER_COMPLETE,
  buildDataHealthReport,
  inferMigrationLevel,
  schemaIsReady,
  reconcileRemoteMigrationTags,
  EXPECTED_MIGRATION_TAGS,
} from "../lib/data-health/model.ts";
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
} from "../lib/data-health/queries.ts";

const owner = "fictional-owner";
const now = 1_786_000_000;
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function fictionalFailureDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE donors (id TEXT PRIMARY KEY,owner_user_id TEXT,data_source TEXT,archived_at INTEGER,merged_into_donor_id TEXT,external_source TEXT,external_id TEXT,donor_code TEXT);
    CREATE TABLE gifts (id TEXT PRIMARY KEY,donor_id TEXT);
    CREATE TABLE interactions (id TEXT PRIMARY KEY,donor_id TEXT,user_id TEXT,source TEXT);
    CREATE TABLE recommendations (id TEXT PRIMARY KEY,donor_id TEXT,user_id TEXT,status TEXT);
    CREATE TABLE giving_activities (id TEXT PRIMARY KEY,owner_user_id TEXT,donor_id TEXT,pledge_activity_id TEXT,external_source TEXT,source_fingerprint TEXT,record_origin TEXT,workspace_status TEXT,category TEXT,committed_cents INTEGER,paid_cents INTEGER,balance_cents INTEGER);
    CREATE TABLE jl_payment_assignments (user_id TEXT,payment_fingerprint TEXT,decision_type TEXT,pledge_activity_id TEXT);
    CREATE TABLE data_imports (id TEXT PRIMARY KEY,user_id TEXT,status TEXT,report_json TEXT,created_at INTEGER,completed_at INTEGER);
    CREATE TABLE jl_refresh_state (user_id TEXT,last_household_refresh_at INTEGER,last_donation_refresh_at INTEGER);
    CREATE TABLE workspace_backup_audits (id TEXT PRIMARY KEY,user_id TEXT,created_at INTEGER);
    CREATE TABLE data_health_repair_audits (id TEXT PRIMARY KEY,user_id TEXT,record_type TEXT,record_id TEXT,action TEXT,previous_donor_id TEXT,next_donor_id TEXT,previous_state_json TEXT,next_state_json TEXT,reason TEXT,created_at INTEGER);
  `);
  const donor = db.prepare("INSERT INTO donors VALUES (?,?,?,?,?,?,?,?)");
  donor.run("active-a", owner, "live", null, null, "JL Solutions", "JL-1", "JL-1");
  donor.run("active-b", owner, "live", null, null, "JL Solutions", "JL-1", "JL-1");
  donor.run("archived", owner, "live", now - 100, "missing-survivor", "Manual", null, null);
  db.prepare("INSERT INTO gifts VALUES (?,?)").run("gift-orphan", "archived");
  db.prepare("INSERT INTO interactions VALUES (?,?,?,?)").run("interaction-orphan", "missing", owner, "capture:call");
  db.prepare("INSERT INTO recommendations VALUES (?,?,?,?)").run("reminder-orphan", "missing", owner, "open");
  const giving = db.prepare("INSERT INTO giving_activities VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  giving.run("gift-ok", owner, "active-a", null, "JL Solutions", "fp-ok", "live", "active", "completed_gift", 100, 100, 0);
  giving.run("gift-archived", owner, "archived", null, "JL Solutions", "fp-archived", "live", "active", "completed_gift", 50, 50, 0);
  giving.run("gift-invalid", owner, "active-a", null, "JL Solutions", "fp-invalid", "live", "active", "completed_gift", 10, -1, 0);
  giving.run("gift-dup-a", owner, "active-a", null, "JL Solutions", "fp-duplicate", "live", "active", "completed_gift", 10, 10, 0);
  giving.run("gift-dup-b", owner, "active-b", null, "JL Solutions", "fp-duplicate", "live", "active", "completed_gift", 10, 10, 0);
  db.prepare("INSERT INTO jl_payment_assignments VALUES (?,?,?,?)").run(owner, "payment-orphan", "apply_to_pledge", "missing-pledge");
  db.prepare("INSERT INTO data_imports VALUES (?,?,?,?,?,?)").run("donation", owner, "completed", JSON.stringify({ profile: "JL Solutions Donations", results: { unmatchedJlCodes: 2, rowsRequiringReview: 3 } }), now - 300, now - 300);
  db.prepare("INSERT INTO data_imports VALUES (?,?,?,?,?,?)").run("failed", owner, "failed", "not-json", now - 200, null);
  db.prepare("INSERT INTO jl_refresh_state VALUES (?,?,?)").run(owner, now - 5000, now - 4000);
  db.prepare("INSERT INTO workspace_backup_audits VALUES (?,?,?)").run("backup", owner, now - 1000);
  return db;
}

const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).count);

test("fictional integrity failures are detected without exposing donor details", () => {
  const db = fictionalFailureDatabase();
  const giving = db.prepare(GIVING_RECONCILIATION_SQL).get(owner, owner);
  const donation = db.prepare(LATEST_DONATION_REVIEW_SQL).get(owner);
  const refresh = db.prepare(REFRESH_STATE_SQL).get(owner);
  const backup = db.prepare(LAST_BACKUP_SQL).get(owner);
  const facts = {
    databaseConnected: true, schemaReady: true, currentMigrationLevel: EXPECTED_MIGRATION_LEVEL, migrationLedgerComplete: true, journalMigrationLevel: EXPECTED_MIGRATION_LEVEL, remoteMigrationLevel: EXPECTED_MIGRATION_LEVEL, remoteMigrationTable: "d1_migrations", remoteMigrationHistoryComplete: true, remoteMigrationHistoryConsistent: true, remoteMigrationDiagnosticLines: [], productionBaselineLevel:"0019",productionBaselineVerified:true,schemaMatchesBaseline:true,schemaComparisonDifferences:[],
    activeDonors: count(db, ACTIVE_DONORS_SQL, owner), duplicateJlCodes: count(db, DUPLICATE_JL_CODES_SQL, owner),
    orphanedGifts: count(db, ORPHANED_GIFTS_SQL, owner), orphanedInteractions: count(db, ORPHANED_INTERACTIONS_SQL, owner, owner),
    orphanedReminders: count(db, ORPHANED_REMINDERS_SQL, owner, owner), orphanedPayments: count(db, ORPHANED_PAYMENTS_SQL, owner, owner, owner),
    brokenMergeRedirects: count(db, BROKEN_MERGE_REDIRECTS_SQL, owner, owner),
    givingSourceTotalCents: Number(giving.source_total_cents), givingLinkedTotalCents: Number(giving.linked_total_cents), invalidGivingRows: Number(giving.invalid_rows),
    duplicateGivingFingerprints: count(db, DUPLICATE_GIVING_FINGERPRINTS_SQL, owner), unmatchedJlCodes: Number(donation.unmatched_jl_codes), pendingPledgeAssignments: Number(donation.pending_assignments),
    failedOrIncompleteImports: count(db, FAILED_IMPORTS_SQL, owner), lastHouseholdRefreshAt: Number(refresh.last_household_refresh_at), lastDonationRefreshAt: Number(refresh.last_donation_refresh_at), lastBackupAt: Number(backup.created_at),
    appVersion: APP_VERSION, deployedCommit: "fictional123456789",
  };
  assert.deepEqual({ duplicates: facts.duplicateJlCodes, gifts: facts.orphanedGifts, interactions: facts.orphanedInteractions, reminders: facts.orphanedReminders, payments: facts.orphanedPayments, redirects: facts.brokenMergeRedirects }, { duplicates: 1, gifts: 1, interactions: 1, reminders: 1, payments: 1, redirects: 1 });
  assert.equal(facts.invalidGivingRows, 1);
  assert.equal(facts.duplicateGivingFingerprints, 1);
  assert.notEqual(facts.givingSourceTotalCents, facts.givingLinkedTotalCents);
  assert.equal(facts.unmatchedJlCodes, 2);
  assert.equal(facts.pendingPledgeAssignments, 3);
  assert.equal(facts.failedOrIncompleteImports, 1);
  const report = buildDataHealthReport(facts, "2026-08-05T12:00:00.000Z");
  assert.equal(report.status, "critical");
  for (const id of ["duplicate-jl-codes", "orphaned-gifts", "orphaned-interactions", "orphaned-reminders", "orphaned-payments", "merge-redirects", "giving-reconciliation"]) assert.equal(report.checks.find((check) => check.id === id).status, "critical", id);
  assert.doesNotMatch(JSON.stringify(report), /active-a|active-b|fictional annual|\$|donorName|display_name/);
});

test("a healthy established workspace receives a clear green result", () => {
  const report = buildDataHealthReport({ databaseConnected:true,schemaReady:true,currentMigrationLevel:"0019",migrationLedgerComplete:true,journalMigrationLevel:"0019",remoteMigrationLevel:"0019",remoteMigrationTable:"d1_migrations",remoteMigrationHistoryComplete:true,remoteMigrationHistoryConsistent:true,remoteMigrationDiagnosticLines:[],productionBaselineLevel:"0019",productionBaselineVerified:true,schemaMatchesBaseline:true,schemaComparisonDifferences:[],activeDonors:12,duplicateJlCodes:0,orphanedGifts:0,orphanedInteractions:0,orphanedReminders:0,orphanedPayments:0,brokenMergeRedirects:0,givingSourceTotalCents:100,givingLinkedTotalCents:100,invalidGivingRows:0,duplicateGivingFingerprints:0,unmatchedJlCodes:0,pendingPledgeAssignments:0,failedOrIncompleteImports:0,lastHouseholdRefreshAt:now,lastDonationRefreshAt:now,lastBackupAt:now,appVersion:APP_VERSION,deployedCommit:"healthy123" });
  assert.equal(report.status,"healthy");
  assert.match(report.summary,/healthy/i);
});

test("six-month edge cases avoid false green results", () => {
  assert.equal(MIGRATION_LEDGER_COMPLETE,false,"the known 0014-0017 journal gap remains visible until deliberately repaired");
  assert.equal(inferMigrationLevel(["donors","data_imports","donor_views","relationship_queue_dismissals","data_health_repair_audits","legacy_test_cleanup_audits"],[],[],[]),"0019");
  assert.equal(schemaIsReady(["donors"],[],[],[]),false,"a partially migrated database never runs deeper checks as zero");
  const newWorkspace = buildDataHealthReport({ databaseConnected:true,schemaReady:true,currentMigrationLevel:"0019",migrationLedgerComplete:true,journalMigrationLevel:"0019",remoteMigrationLevel:"0019",remoteMigrationTable:"d1_migrations",remoteMigrationHistoryComplete:true,remoteMigrationHistoryConsistent:true,remoteMigrationDiagnosticLines:[],productionBaselineLevel:"0019",productionBaselineVerified:true,schemaMatchesBaseline:true,schemaComparisonDifferences:[],activeDonors:0,duplicateJlCodes:0,orphanedGifts:0,orphanedInteractions:0,orphanedReminders:0,orphanedPayments:0,brokenMergeRedirects:0,givingSourceTotalCents:0,givingLinkedTotalCents:0,invalidGivingRows:0,duplicateGivingFingerprints:0,unmatchedJlCodes:0,pendingPledgeAssignments:0,failedOrIncompleteImports:0,lastHouseholdRefreshAt:null,lastDonationRefreshAt:null,lastBackupAt:null,appVersion:APP_VERSION,deployedCommit:"new123" });
  assert.equal(newWorkspace.checks.find((check)=>check.id==="household-refresh").status,"info","a new manual-only workspace is not falsely failed for having no JL refresh");
  assert.equal(newWorkspace.checks.find((check)=>check.id==="backup").status,"attention","backup readiness remains explicit even before the first import");
  assert.equal(reconcileRemoteMigrationTags(EXPECTED_MIGRATION_TAGS).complete, true);
  assert.equal(reconcileRemoteMigrationTags([...EXPECTED_MIGRATION_TAGS, EXPECTED_MIGRATION_TAGS.at(-1)]).consistent, false, "duplicate remote rows block readiness");
  assert.equal(reconcileRemoteMigrationTags(EXPECTED_MIGRATION_TAGS.filter((tag) => !tag.startsWith("0016_"))).consistent, false, "a remote history gap blocks readiness");
  assert.equal(reconcileRemoteMigrationTags([...EXPECTED_MIGRATION_TAGS].reverse()).consistent, false, "out-of-order remote history blocks readiness");
});

test("route and interface are authenticated, owner scoped, honest, and actionable", () => {
  const route=read("app/api/health/route.ts"), loader=read("lib/data-health/read.ts"), queries=read("lib/data-health/queries.ts"), ui=read("app/settings/DataHealthDashboard.tsx"), settings=read("app/settings/page.tsx"), backup=read("app/api/import/backup/route.ts"), vite=read("vite.config.ts");
  assert.match(route,/getChatGPTUser/); assert.match(route,/Authentication required/); assert.match(route,/loadDataHealth\(userIdForEmail\(identity\.email\)\)/); assert.doesNotMatch(route,/ensureUserProfile/); assert.match(route,/cache-control/);
  assert.match(loader,/env\.DB\.batch/); assert.match(loader,/schemaIsReady/); assert.match(queries,/owner_user_id=\?/); assert.doesNotMatch(queries,/display_name|donor_name/);
  for(const label of ["Database connection","Live schema version","Staging migration history","Production rehearsal baseline","Staging ↔ baseline schema","Production launch readiness","Production data state","Active donors","Duplicate active JL Codes","Orphaned gifts","Orphaned interactions","Orphaned reminders","Orphaned pledge payments","Broken merge redirects","Giving-total reconciliation","Unmatched JL Codes","Pending pledge assignments","Failed or incomplete imports","Last household refresh","Last donation refresh","Last successful backup","Deployed version"]) assert.match(read("lib/data-health/model.ts"),new RegExp(label));
  assert.match(ui,/Run health check/); assert.match(ui,/state === "loading"/); assert.match(ui,/setState\("success"\)/); assert.match(ui,/setState\("error"\)/); assert.match(ui,/Names, amounts, and source rows are never shown/); assert.match(settings,/Data Health/);
  assert.match(ui,/useEffect\(\(\) => setUseLocalTime\(true\)/,"timestamps must keep server and first client render deterministic before switching to local time");
  assert.match(backup,/workspace_export/); assert.match(backup,/dataHealthRepairAudits/); assert.match(vite,/FUNDRAISING_OS_COMMIT/);
});
