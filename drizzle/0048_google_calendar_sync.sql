-- Google Calendar Integration -- isolated sync core (2026-10-18, see
-- docs/GOOGLE-CALENDAR-INTEGRATION-DESIGN.md and docs/AI-HANDOFF.md).
-- Purely additive: two new tables, new nullable columns on `interactions`
-- and `trip_prospects`, one new boolean on `users`. No existing column,
-- index, or row is altered or deleted. NOT applied to any remote D1
-- database by this round -- schema/code only, proven against a local,
-- isolated `node:sqlite` database by tests/calendar-sync-sqlite-
-- store.test.mjs. Not wired into any live route or cron.
--
-- `calendar_event_links`: one durable row per FOS meeting
-- (`interactions.id`) that has ever been enrolled for calendar sync.
-- `desired_state`/`desired_revision` are the authoritative "what should
-- Google show right now" facts, written atomically with whatever FOS
-- change caused them (reschedule/cancel/reopen) -- durable intent,
-- independent of whether any network call to Google has happened yet.
-- `synced_revision` only ever advances to a revision this row's own
-- reconciler attempt actually sent to and had confirmed by Google --
-- never bumped merely because a newer revision exists while an older
-- attempt is still in flight (see the reconciler's own CAS writes).
-- `generation` increments on every cancel-then-reopen cycle; the Google
-- event id is a pure function of (interaction_id, generation), never
-- reused across generations, since a deleted Google event's id can never
-- be reinserted (verified against Google's own 409 "identifier already
-- exists" documentation).
CREATE TABLE `calendar_event_links` (
  `id` text PRIMARY KEY NOT NULL,
  `interaction_id` text NOT NULL REFERENCES `interactions`(`id`),
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `google_calendar_id` text DEFAULT 'primary' NOT NULL,
  `generation` integer DEFAULT 0 NOT NULL,
  `google_event_id` text,
  `google_etag` text,
  `desired_state` text DEFAULT 'present' NOT NULL,
  `desired_revision` integer DEFAULT 1 NOT NULL,
  `synced_revision` integer DEFAULT 0 NOT NULL,
  `sync_status` text DEFAULT 'pending' NOT NULL,
  `last_error` text,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `lease_owner` text,
  `lease_expires_at` integer,
  -- 2026-10-19 review, issue 2: bounded-backoff scheduling for a
  -- 'failed' link -- null means eligible now (no backoff in effect).
  -- Never consulted for 'invalid'/'auth_required', which are excluded
  -- from automatic reconciliation entirely regardless of this value.
  `next_retry_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`desired_state` IN ('present','absent')),
  -- 2026-10-19 review, issue 2: 'invalid' (a definitive, permanent
  -- rejection -- this app's own pre-mutation validation or a real
  -- Google 400 -- never auto-retried) and 'auth_required' (a 401/403,
  -- an authentication/configuration problem, also never auto-retried)
  -- added -- see calendar-sync-types.ts's own SyncStatus doc comment.
  CHECK (`sync_status` IN ('pending','synced','failed','invalid','auth_required','missing_remotely'))
);
--> statement-breakpoint
-- The real duplicate-prevention backstop -- at most one link row can ever
-- exist per meeting, structurally, not merely by application-level
-- convention (same "UNIQUE constraint is the actual guarantee" shape as
-- trip_prospects' own UNIQUE(trip_id, donor_id)).
CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`);
--> statement-breakpoint
-- Supports the reconciliation sweep's "which rows need attention" query
-- (sync_status != 'synced' OR desired_revision != synced_revision) --
-- the sweep only ever reads FROM this table, never scans `interactions`
-- directly, which is what makes "retrying already-enrolled work" and
-- "enrolling a previously-unsynced meeting" structurally distinct
-- operations (see the reconciler's own header comment).
CREATE INDEX `calendar_event_links_sync_status_idx` ON `calendar_event_links` (`sync_status`);
--> statement-breakpoint
-- Durable, append-only history across every generation a meeting's
-- calendar link ever went through -- deliberately never deleted or
-- overwritten when a reopen bumps `generation`, so a prior generation's
-- own pending/uncertain deletion is never silently abandoned (see the
-- reconciler's own "late create after cancel" handling).
--
-- IMPORTANT: every explanatory comment for this table's columns is kept
-- HERE, before the statement, never inside the parenthesized column
-- list below. `lib/data-health/production-baseline.ts`'s
-- normalizeSchemaSql() collapses an object's recorded SQL onto a single
-- line (comparing schema objects regardless of incidental whitespace
-- differences) -- a `--` comment placed BETWEEN column definitions would
-- then swallow every following column/CHECK as part of that single-line
-- comment once reconstructed, producing invalid SQL. A comment before
-- the whole CREATE statement is not part of the stored object's own SQL
-- text at all, so it is immune to this.
--
-- `create_status`: resolved only by the specific create attempt that
-- made the exact outbound HTTP call -- 'in_flight' until that attempt's
-- own response (success or a definitive, non-ambiguous failure) resolves
-- it. A timeout/connection-error leaves it 'in_flight' -- genuinely
-- unknown, never assumed either way.
-- `cleanup_needed`: whether this generation's event should be removed
-- from Google. false for the CURRENT generation while it is still
-- desired_state 'present'; set true the moment a cancel or a
-- reopen-into-a-new-generation makes this specific generation's event
-- unwanted.
-- `cleanup_status`: 'uncertain' (not 'done') is the direct fix for "do
-- not claim 404 alone guarantees absence while a create may still be in
-- flight" -- a delete that returns 404/410 while create_status is still
-- 'in_flight' lands here, not 'done', and is retried by a later sweep
-- once the create's own outcome has actually resolved.
CREATE TABLE `calendar_event_link_history` (
  `id` text PRIMARY KEY NOT NULL,
  `link_id` text NOT NULL REFERENCES `calendar_event_links`(`id`),
  `generation` integer NOT NULL,
  `google_event_id` text NOT NULL,
  `create_status` text DEFAULT 'not_attempted' NOT NULL,
  `cleanup_needed` integer DEFAULT 0 NOT NULL,
  `cleanup_status` text DEFAULT 'not_needed' NOT NULL,
  `cleanup_attempts` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  -- 2026-10-19 review, issue 2: 'invalid' added -- a DEFINITIVE,
  -- PERMANENT rejection of this generation's create attempt (a real
  -- Google 400), distinct from 'in_flight' (genuinely ambiguous --
  -- timeout/network/malformed response) -- see
  -- calendar-sync-types.ts's own CreateStatus doc comment.
  CHECK (`create_status` IN ('not_attempted','in_flight','succeeded','failed','invalid')),
  CHECK (`cleanup_status` IN ('not_needed','pending','uncertain','done'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_link_history_link_generation_uidx` ON `calendar_event_link_history` (`link_id`,`generation`);
--> statement-breakpoint
-- Drives the cleanup sweep: every generation across every link that
-- still needs its own event removed from Google, independent of and
-- never blocking the current generation's own create/update work (see
-- "keep deletion retries separate from creating the reopened event").
CREATE INDEX `calendar_event_link_history_cleanup_idx` ON `calendar_event_link_history` (`cleanup_needed`,`cleanup_status`);
--> statement-breakpoint
-- Date-only storage for an all-day meeting (Issue 5 of the reviewed
-- design): a plain 'YYYY-MM-DD' string, never an epoch -- the same
-- lesson already applied once this session fixing Meeting Prep's
-- date-only occurrence-label bug, deliberately not repeated here.
-- `occurred_at` stays NOT NULL and populated (a derived display value
-- only for an all-day row -- see the design doc section 7.1); the calendar-sync
-- layer itself never reads `occurred_at` for an all-day meeting, only
-- `all_day_date`.
ALTER TABLE `interactions` ADD COLUMN `all_day` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `interactions` ADD COLUMN `all_day_date` text;
--> statement-breakpoint
-- Nullable end instant for a TIMED meeting only (meaningless/NULL for an
-- all-day row). Never silently defaulted and hidden -- populated from a
-- visible, editable default duration at scheduling time.
ALTER TABLE `interactions` ADD COLUMN `end_at` integer;
--> statement-breakpoint
-- Explicit, user-entered only -- never auto-filled from a donor's mailing
-- address (see the design doc's section 9.2 default).
ALTER TABLE `interactions` ADD COLUMN `location` text;
--> statement-breakpoint
-- Mirrored onto trip_prospects the same way meeting_location already is
-- -- display/sorting convenience for the trip UI, never a second
-- independent source of truth (written by the same scheduleProspectMeeting
-- ()/completeProspectMeeting() functions that already write the other
-- mirrored fields).
ALTER TABLE `trip_prospects` ADD COLUMN `all_day` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `trip_prospects` ADD COLUMN `all_day_date` text;
--> statement-breakpoint
-- The real, persisted, enforced disconnect (Issue 4) -- checked at every
-- call site that could reach Google, not merely a Settings display label
-- being cleared. Defaults to false: calendar sync is opt-in, never
-- active merely because credentials happen to exist.
ALTER TABLE `users` ADD COLUMN `calendar_sync_enabled` integer DEFAULT 0 NOT NULL;
