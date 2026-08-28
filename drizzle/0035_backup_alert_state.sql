-- Backup Scheduling Reliability Stage 3 (see docs/BACKUP-SCHEDULING-
-- RELIABILITY.md and docs/AI-HANDOFF.md's "D1 Nightly Backup Scheduling
-- Reliability" entries). Tracks whether an active email alert has
-- already been sent for the CURRENT backup-staleness incident, so the
-- main app's hourly scheduled check (lib/backup-alert/) can suppress
-- duplicate emails while the same incident continues, and allow a new
-- alert once a fresh successful backup resolves it (or a genuinely new
-- incident begins). One row per user (matching onboarding_preferences'
-- own shape) -- upserted via ON CONFLICT(user_id), never inserted a
-- second time for the same user.
--
-- incident_key identifies WHICH stale incident was last alerted on --
-- the alerted-on backup-latest-success.json's own completedAt value, or
-- the literal string 'no-success-ever' when no successful backup has
-- ever been recorded. It changes (resolving the old incident) exactly
-- when a new successful backup completes.
--
-- first_alerted_at/last_alerted_at are real timestamps, not the generic
-- created_at/updated_at every other table uses, because their semantics
-- are deliberately narrower: "when the CURRENT incident_key was
-- first/most recently alerted on" -- both are overwritten together when
-- a new incident begins, unlike a normal created_at, which never changes.
--
-- This table holds no donor, gift, or fundraising data of any kind --
-- see lib/data-health/production-baseline.ts's ACCOUNT_CONFIGURATION_TABLES,
-- which this table is added to alongside onboarding_preferences.
CREATE TABLE `backup_alert_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`incident_key` text NOT NULL,
	`first_alerted_at` integer NOT NULL,
	`last_alerted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
