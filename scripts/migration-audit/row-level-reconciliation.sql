-- Row-level, deterministic reconciliation for a future migration
-- rehearsal (docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md Section
-- 15.3, item 4). READ-ONLY -- every statement here is a SELECT.
--
-- Rationale: D1/SQLite as deployed here has no built-in cryptographic
-- hash function, so a row-level content check cannot be a single
-- cross-database checksum comparison. Instead, this produces a fully
-- deterministic, ordered column dump for each table. Run it once
-- against the frozen source (a decrypted backup, or a live export taken
-- at the moment a rehearsal begins -- never today's live Staging,
-- which will have changed by rehearsal time) and once more, post-
-- restore, against the rehearsal database, then diff the two text
-- outputs byte-for-byte (e.g. `diff source.txt rehearsal.txt`). An
-- empty diff is the pass condition -- not just matching COUNT(*) or
-- SUM(...), which this file's queries never compute.
--
-- Usage (same invocation pattern as reconciliation-baselines.sql; run
-- individually, never UNION ALL'd, per that file's own D1 compound-
-- SELECT term-limit note):
--
--   npx --yes wrangler@4.92.0 d1 execute <database-name> --remote --command "<statement>" --json
--
-- giving_activities is the authoritative financial ledger and the
-- table this round's owner decision concerns directly -- every other
-- MIGRATE table (Section 3 of the audit doc) should get the same
-- treatment (ORDER BY id dump of every financially/status-meaningful
-- column) before a real rehearsal is run; this file seeds the pattern
-- with the one table most load-bearing for this decision.
-- description and source_snapshot (a large JSON blob) are
-- deliberately omitted here -- neither is financial or status data,
-- and source_snapshot in particular would make the diff output
-- unwieldy without adding reconciliation value.

SELECT id, donor_id, owner_user_id, external_source, external_household_id,
  source_fingerprint, activity_date, committed_cents, paid_cents,
  balance_cents, record_origin, workspace_status, category, item_type,
  source_campaign, confirmed_by_activity_id, created_at, updated_at
FROM giving_activities
ORDER BY id;

-- Same pattern for the one table whose row-level integrity this round's
-- owner decision specifically depends on (Goldman's preserved
-- acknowledgment).
SELECT id, donor_id, gift_source, gift_id, status, created_at
FROM gift_acknowledgments
ORDER BY id;

-- pledge_balance_corrections: the one active manual correction
-- (Section 4.3) must reconcile identically row-for-row, not just in
-- its aggregate net-delta figure.
SELECT id, pledge_activity_id, donor_id, imported_balance_cents_at_correction,
  corrected_balance_cents, reason, created_at, reversed_at, reversal_reason
FROM pledge_balance_corrections
ORDER BY id;
