-- Daily Fundraising Agenda idempotency (October 14 2026 incident --
-- docs/AI-HANDOFF.md). Provides a concurrency-safe, persistent claim so at
-- most one real send is ever attempted per (user, Eastern calendar day),
-- regardless of how many times the scheduled() handler is invoked that day
-- -- a genuine concurrent double-fire, a retried failed invocation, or (the
-- exact failure mode this incident traced) a Worker's Cron Trigger firing
-- despite its own config appearing to have been cleared. See
-- lib/agenda/send-log.ts for the atomic claim query this table backs, and
-- docs/AI-HANDOFF.md for the full delivery-semantics writeup (deliberately
-- at-least-once: an occasional duplicate email is accepted in exchange for
-- never silently missing a day).
--
-- This table's dedup state is per-environment (each D1 database has its own
-- copy) -- it does NOT by itself prevent Staging from sending a real email;
-- that is lib/agenda/email-send-guard.ts's job, enforced inside
-- sendGmail() itself regardless of which environment's D1 this table lives
-- in. This table only prevents duplicate sends from whichever single
-- environment's own scheduled() handler is actually allowed to send.
--
-- Same category as backup_alert_state (drizzle/0035_backup_alert_state.sql):
-- operational dedupe state, never donor or fundraising data -- see
-- lib/data-health/production-baseline.ts's ACCOUNT_CONFIGURATION_TABLES.
--
-- status is 'pending' (claimed, send in flight or abandoned) or 'sent'
-- (confirmed delivered without error). claimed_at is the timestamp of the
-- most recent claim attempt -- a 'pending' row whose claimed_at is older
-- than AGENDA_CLAIM_STALE_AFTER_SECONDS (lib/agenda/send-log.ts) is treated
-- as an abandoned claim (the invocation that took it crashed, timed out, or
-- threw) and may be re-claimed by a later invocation; a 'sent' row can
-- never be re-claimed regardless of age, since the claim query only ever
-- touches rows whose status is still 'pending'.
CREATE TABLE `agenda_send_log` (
	`user_id` text NOT NULL,
	`send_date` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`sent_at` integer,
	PRIMARY KEY (`user_id`, `send_date`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
