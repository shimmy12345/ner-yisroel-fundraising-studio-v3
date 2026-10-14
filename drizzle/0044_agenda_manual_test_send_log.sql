-- Temporary Production Gmail OAuth verification mechanism (October 14
-- 2026 incident -- docs/AI-HANDOFF.md). Backs the one-time, atomic,
-- persistent claim for POST /api/agenda/test-send
-- (app/api/agenda/test-send/route.ts), which exists only to send a
-- single real Daily Fundraising Agenda email to the owner and prove the
-- newly-corrected Gmail OAuth credentials actually work, without waiting
-- for the next natural 9 AM Eastern scheduled window.
--
-- Deliberately a SEPARATE table from agenda_send_log
-- (drizzle/0043_agenda_send_log.sql), not a row within it: this
-- mechanism must never be able to interfere with, or even touch,
-- agenda_send_log's own per-calendar-day idempotency record for the
-- real scheduled send (including October 15's), and keeping the tables
-- physically separate makes that true by construction rather than by a
-- shared-table invariant that has to be maintained by hand.
--
-- `id` is a single, fixed, hardcoded sentinel value (see
-- lib/agenda/test-send-log.ts's TEST_SEND_CLAIM_ID) -- there is
-- deliberately no per-day or per-user keying, because this mechanism is
-- a true one-time-ever action, not a recurring one: `INSERT ... ON
-- CONFLICT(id) DO NOTHING` makes the very first successful claim
-- permanent -- no later request, retry, or concurrent request can ever
-- claim it again, regardless of whether the first attempt's send
-- ultimately succeeded or failed. Unlike agenda_send_log's own claim
-- (which deliberately allows a stale 'pending' row to be reclaimed after
-- a timeout, for a recurring daily job), this table has no reclaim path
-- at all -- a human clearing a specific row by hand is the only way a
-- second real attempt could ever be made, which is the intended,
-- tightly-controlled behavior for a mechanism meant to run exactly once.
--
-- Same category as backup_alert_state/agenda_send_log: operational
-- state, never donor or fundraising data -- see
-- lib/data-health/production-baseline.ts's ACCOUNT_CONFIGURATION_TABLES.
-- Rows are kept permanently after the route is removed/disabled, as the
-- audit record of the test and its outcome.
CREATE TABLE `agenda_manual_test_send_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` integer NOT NULL,
	`sent_at` integer,
	`outcome` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
