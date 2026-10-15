-- Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
-- One new, additive table; no existing table's schema changes. STAGING
-- ONLY -- not applied to Production as part of this round.
--
-- Deliberately a thin ATTRIBUTION layer, never a parallel ledger: this
-- table never stores an amount, a category, or any financial figure of
-- its own. It only links a trip to ONE real `giving_activities` row (the
-- CRM's own pledge/gift record, already the source of truth for
-- committed/paid/balance). Every dollar figure the Trip Fundraising
-- Results Dashboard shows is read live from giving_activities at query
-- time through this link -- never snapshotted here -- so a later payment,
-- correction, or re-categorization of the underlying record is reflected
-- automatically, with nothing in this table ever going stale or
-- disagreeing with the CRM.
--
-- Append-only, mirroring pledge_balance_corrections' own
-- create/reverse convention (never hard-deleted, so "a donor's gift was
-- attributed to the wrong trip, then corrected" stays a fully auditable
-- history, not a silent overwrite). `removed_at IS NULL` means "this
-- attribution is currently active."
--
-- The partial UNIQUE index below is the actual double-counting guard at
-- the database level: a single giving_activities row can be ACTIVELY
-- attributed to at most one trip at a time, so the same $25,000 pledge
-- can never count toward two different trips' goals simultaneously, even
-- under concurrent requests. Removing an attribution (removed_at set)
-- frees the row to be attributed elsewhere, same as a real correction.
CREATE TABLE `trip_financial_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`donor_id` text NOT NULL,
	`giving_activity_id` text NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	`removed_reason` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`giving_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_financial_attributions_active_giving_activity_uidx` ON `trip_financial_attributions` (`giving_activity_id`) WHERE `removed_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `trip_financial_attributions_trip_idx` ON `trip_financial_attributions` (`trip_id`, `removed_at`);
--> statement-breakpoint
CREATE INDEX `trip_financial_attributions_donor_idx` ON `trip_financial_attributions` (`donor_id`);
