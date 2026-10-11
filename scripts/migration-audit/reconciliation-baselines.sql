-- Read-only reconciliation baseline queries for the donor-data migration
-- audit (docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md). Every statement
-- here is a SELECT or a PRAGMA *_check -- none of them write. Run each
-- one individually (they are deliberately NOT chained with UNION ALL --
-- D1's remote query endpoint enforces a low compound-SELECT term limit,
-- empirically 5, that a single combined query would exceed):
--
--   npx --yes wrangler@4.92.0 d1 execute <database-name> --remote --command "<statement>" --json
--
-- Replace <database-name> with fundraising-os-staging-db or
-- fundraising-os-production-db. Every result reported in the audit doc
-- was produced by exactly these statements against both databases on
-- 2026-10-11.

-- === Foreign-key integrity (whole database) ===
PRAGMA foreign_key_check;

-- === Donor data-quality flags (dataSource / archived / merged) ===
SELECT data_source, COUNT(*) as cnt FROM donors GROUP BY data_source;

SELECT
  (SELECT COUNT(*) FROM donors WHERE archived_at IS NOT NULL) as archived,
  (SELECT COUNT(*) FROM donors WHERE merged_into_donor_id IS NOT NULL) as merged_away,
  (SELECT COUNT(*) FROM donors WHERE archived_at IS NULL AND merged_into_donor_id IS NULL) as active_unarchived;

-- === Donor ownership / identifier integrity ===
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN owner_user_id IS NULL THEN 1 ELSE 0 END) as no_owner,
  COUNT(DISTINCT external_id) as distinct_external_ids,
  SUM(CASE WHEN external_id IS NULL THEN 1 ELSE 0 END) as null_external_id,
  COUNT(DISTINCT display_name) as distinct_display_names
FROM donors;

-- Duplicate donor email (NULLs excluded by definition -- a NULL email is
-- not itself a duplicate). donors_owner_donor_code_unique and
-- users_email_unique are DB-enforced UNIQUE indexes, so these two checks
-- are a belt-and-suspenders confirmation, not the only guarantee.
SELECT email, COUNT(*) as cnt FROM donors WHERE email IS NOT NULL GROUP BY email HAVING COUNT(*) > 1;
SELECT donor_code, COUNT(*) as cnt FROM donors WHERE donor_code IS NOT NULL GROUP BY donor_code HAVING COUNT(*) > 1;

-- === Giving-activity data-quality flags (recordOrigin / workspaceStatus) ===
SELECT record_origin, COUNT(*) as cnt FROM giving_activities GROUP BY record_origin;
SELECT workspace_status, COUNT(*) as cnt FROM giving_activities GROUP BY workspace_status;

-- Any workspace_status other than 'active' is a named exception-register
-- candidate -- list them by internal id, never donor name/contact detail.
SELECT id, donor_id, committed_cents, balance_cents, created_at
FROM giving_activities WHERE workspace_status != 'active';

-- === Financial reconciliation (integer cents throughout -- never float) ===
-- Authoritative total committed/paid/outstanding across every record this
-- audit classifies as migration-eligible (workspace_status='active' AND
-- record_origin='live'). sum_corrected_balance_cents applies the ACTIVE
-- pledge_balance_corrections override (reversed_at IS NULL) in place of
-- giving_activities.balance_cents where one exists -- this, not the raw
-- column alone, is the real authoritative outstanding-balance figure
-- (see db/schema.ts's own header comment on pledgeBalanceCorrections).
SELECT
  COUNT(*) as total_rows,
  SUM(ga.committed_cents) as sum_committed_cents,
  SUM(ga.paid_cents) as sum_paid_cents,
  SUM(ga.balance_cents) as sum_raw_balance_cents,
  SUM(COALESCE(pbc.corrected_balance_cents, ga.balance_cents)) as sum_corrected_balance_cents,
  SUM(CASE WHEN ga.committed_cents IS NULL THEN 1 ELSE 0 END) as null_committed,
  SUM(CASE WHEN ga.balance_cents IS NULL THEN 1 ELSE 0 END) as null_balance
FROM giving_activities ga
LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
WHERE ga.workspace_status = 'active' AND ga.record_origin = 'live';

-- Internal consistency: balance_cents must equal committed_cents minus
-- paid_cents for every row where all three are known. A non-zero result
-- here is a STOP-condition-grade finding, not a rounding quirk (everything
-- is integer cents).
SELECT COUNT(*) as inconsistent_rows FROM giving_activities
WHERE balance_cents IS NOT NULL AND committed_cents IS NOT NULL AND paid_cents IS NOT NULL
  AND balance_cents != (committed_cents - paid_cents);

-- Active pledge-balance-correction count and net dollar effect (should
-- reconcile exactly to the raw-vs-corrected difference above).
SELECT COUNT(*) as active_corrections,
  SUM(corrected_balance_cents - imported_balance_cents_at_correction) as net_delta_cents
FROM pledge_balance_corrections WHERE reversed_at IS NULL;

-- Giving-activity date range and ownership completeness, migration-eligible rows only.
SELECT
  MIN(activity_date) as min_date_epoch_seconds,
  MAX(activity_date) as max_date_epoch_seconds,
  SUM(CASE WHEN owner_user_id IS NULL THEN 1 ELSE 0 END) as no_owner,
  SUM(CASE WHEN activity_date IS NULL THEN 1 ELSE 0 END) as null_date
FROM giving_activities WHERE workspace_status = 'active' AND record_origin = 'live';

-- === Payment-plan summary (stewardship metadata, not itself a liability total) ===
SELECT
  COUNT(*) as total,
  SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) as active_plans,
  SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END) as ended_plans,
  SUM(installment_amount_cents) as sum_installment_cents
FROM pledge_payment_plans;

-- === Identity parity check (run against EACH database, compare by hand) ===
-- Both environments must show the SAME deterministic id/email for this to
-- be a zero-remapping migration -- see the audit's "User identity" finding.
SELECT id, email FROM users;

-- === Schema baseline marker (run against Production) ===
SELECT id, schema_hash, created_at FROM production_schema_baseline;
