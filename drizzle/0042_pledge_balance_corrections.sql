-- Manual Pledge Balance Corrections (see docs/AI-HANDOFF.md). A
-- controlled, auditable exception mechanism for the rare case where
-- the real-world JL error has already been corrected, but the
-- correction never reached the spreadsheet FOS imports from (the real
-- Shlomo Kutoff / DIN2023 case) -- never a new payment, never a
-- replacement for the JL import process. The authoritative
-- `giving_activities.balance_cents` (the real imported figure) is
-- NEVER overwritten by this table -- it is read-only input to the
-- correction, preserved verbatim alongside the correction for display
-- and comparison.
--
-- One row per correction EVENT (create, or supersede-with-a-new-amount,
-- or reverse) -- append-only, matching this schema's own established
-- pattern of a live-state row's full history living in its own rows
-- rather than being overwritten in place (same discipline
-- pledge_payment_plan_changes already applies to pledge_payment_plans).
-- `reversed_at IS NULL` means this specific row is the currently ACTIVE
-- correction for its pledge; a non-null `reversed_at` means this row is
-- historical. Correcting an already-corrected pledge, or removing an
-- active correction, both work by reversing the current active row and
-- (for a new correction) inserting a fresh one -- never an in-place
-- UPDATE of a correction's own amount/reason, so the full history of
-- every value ever set is preserved exactly as entered.
--
-- `pledge_activity_id` is `giving_activities.id` -- the one stable
-- identifier a JL re-import never changes for an existing pledge (see
-- the import-matching investigation in docs/AI-HANDOFF.md) -- never a
-- donor id, campaign code, or any text-matched field, so a correction
-- can never silently attach to the wrong pledge and never becomes a
-- donor-wide override.
CREATE TABLE `pledge_balance_corrections` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `pledge_activity_id` text NOT NULL,
  `imported_balance_cents_at_correction` integer NOT NULL,
  `corrected_balance_cents` integer NOT NULL,
  `reason` text NOT NULL,
  `created_at` integer NOT NULL,
  `reversed_at` integer,
  `reversal_reason` text,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action,
  CHECK (`corrected_balance_cents` >= 0)
);
--> statement-breakpoint
-- DB-enforced concurrency/duplicate protection (requirement: concurrent
-- or repeated corrections cannot silently overwrite one another): at
-- most one ACTIVE (non-reversed) correction row can ever exist per
-- pledge. A second concurrent request trying to insert a new active row
-- while one already exists fails this constraint outright, rather than
-- silently racing. Same partial-unique-index pattern already used by
-- `interactions_shared_activity_donor_uidx` (migration 0030) and
-- `donor_research_findings_donor_fingerprint_active_uidx` (migration
-- 0023).
CREATE UNIQUE INDEX `pledge_balance_corrections_active_uidx` ON `pledge_balance_corrections` (`pledge_activity_id`) WHERE `reversed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `pledge_balance_corrections_pledge_idx` ON `pledge_balance_corrections` (`pledge_activity_id`,`created_at`);
