import { FUNDRAISING_DATA_TABLES } from "../data-health/production-baseline.ts";

// Table coverage of the app-level `/api/import/backup` JSON export.
//
// THIS IS NOT A FULL DATABASE BACKUP. It never was, despite Settings/
// OWNER-RECOVERY.md historically calling it "the D1 backup" -- an audit
// proved it silently omitted ~20 of 33 fundraising tables, including real
// donor-facing data (yahrtzeits, important_dates, gift_acknowledgments,
// donor_historical_context) added after this route was first written. The
// authoritative full backup is the nightly `wrangler d1 export` -> R2
// pipeline (see docs/DEPLOYMENT.md), which captures the entire database
// byte-for-byte with no per-table enumeration to keep in sync. This route
// remains a secondary, human-readable, owner-scoped JSON export -- useful
// for a quick look or for the pre-rollback safety snapshot
// (app/api/import/rollback, app/api/import/household-rollback both fetch
// it), not a substitute for the real backup.
//
// Every fundraising table must appear in EXACTLY ONE of the two lists
// below. tests/production-backup-readiness.test.mjs enforces this via
// verifyWorkspaceBackupCoverage: adding a new fundraising table to the
// schema without classifying it here fails CI, so this export can never
// silently drift further out of sync with reality the way it already did
// once. Expanding WORKSPACE_BACKUP_TABLES to cover more of the excluded
// list is welcome, but each addition needs its own correct owner-scoping
// (donor_id join vs. user_id vs. owner_user_id vary by table) verified
// against real data, not just added to satisfy this list.
export const WORKSPACE_BACKUP_TABLES = [
  "donors",
  "gifts",
  "giving_activities",
  "interactions",
  "shared_activities",
  "recommendations",
  "activity_status_audits",
  "shared_activity_recipient_audits",
  "data_health_repair_audits",
  "legacy_test_cleanup_audits",
  "giving_activity_management_audits",
  "data_imports",
  "giving_activity_import_changes",
  "household_import_changes",
  "jl_payment_assignments",
  "jl_payment_assignment_audits",
  "jl_refresh_state",
  "donation_import_rollback_audits",
  "household_import_rollback_audits",
] as const;

export const WORKSPACE_BACKUP_EXCLUDED_TABLES = [
  // Relationship-date and gift-acknowledgment tracking added after this
  // route was first written -- real donor-facing data, not audit trails.
  // Covered today only by the nightly whole-database R2 backup.
  "yahrtzeits",
  "yahrtzeit_changes",
  "important_dates",
  "important_date_changes",
  "gift_acknowledgments",
  "donor_historical_context",
  // Ask/solicitation tracking (Phase 1) -- same reasoning as yahrtzeits/
  // important_dates above: real donor-facing data added after this route
  // was written. Deliberately not added to WORKSPACE_BACKUP_TABLES in this
  // phase -- that would require its own correct owner-scoping work
  // verified against real data, a separate decision from building the
  // feature itself. Covered today only by the nightly whole-database R2
  // backup.
  "asks",
  "ask_changes",
  // Monthly Payment Plan feature -- same reason as asks/ask_changes above.
  "pledge_payment_plans",
  "pledge_payment_plan_changes",
  // Relationship Intelligence Phase 1 -- same reason as asks/
  // pledge_payment_plans above: real donor-facing durable relationship
  // data added after this route was written. Deliberately not added to
  // WORKSPACE_BACKUP_TABLES in this phase.
  "donor_relationship_facts",
  "donor_relationship_fact_changes",
  // Donor Research (Stage A) findings -- same reason as above.
  "donor_research_runs",
  "donor_research_pending_evidence",
  "donor_research_identity_candidates",
  "donor_research_findings",
  "donor_research_sources",
  "donor_research_finding_sources",
  // Administrative/audit trails, not primary relationship or giving data.
  "donor_views",
  "donor_contact_audits",
  "donor_merge_audits",
  "relationship_queue_dismissals",
  "sample_cleanup_audits",
  "workspace_backup_audits",
  // Ephemeral import-review working state with its own 14-day inactivity
  // TTL (lib/import/preview-session.ts) -- deliberately not backup-worthy.
  "import_preview_sessions",
  "import_preview_session_chunks",
] as const;

export type WorkspaceBackupCoverage = {
  inSync: boolean;
  // Fundraising tables that appear in neither list -- a new table was
  // added to the schema and nobody classified it yet.
  unclassified: string[];
  // Names in WORKSPACE_BACKUP_TABLES/WORKSPACE_BACKUP_EXCLUDED_TABLES that
  // no longer correspond to a real fundraising table (e.g. a table was
  // renamed or dropped and these lists weren't updated).
  stale: string[];
};

export function verifyWorkspaceBackupCoverage(fundraisingDataTables: readonly string[] = FUNDRAISING_DATA_TABLES): WorkspaceBackupCoverage {
  const classified = new Set<string>([...WORKSPACE_BACKUP_TABLES, ...WORKSPACE_BACKUP_EXCLUDED_TABLES]);
  const authoritative = new Set(fundraisingDataTables);
  const unclassified = fundraisingDataTables.filter((table) => !classified.has(table));
  const stale = [...classified].filter((table) => !authoritative.has(table));
  return { inSync: unclassified.length === 0 && stale.length === 0, unclassified, stale };
}
