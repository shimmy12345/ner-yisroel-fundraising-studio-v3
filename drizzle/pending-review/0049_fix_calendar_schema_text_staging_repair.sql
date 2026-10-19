-- DRAFT -- PENDING SEPARATE REVIEW. Deliberately placed under
-- drizzle/pending-review/, NOT drizzle/ itself, so it is never picked up
-- by scripts/generate-production-baseline.mjs, lib/calendar/testing/
-- local-d1.ts, or any other tool that globs drizzle/*.sql -- adding it
-- to the real migration sequence (renumbering, regenerating the
-- baseline, bumping the hardcoded migration-count check in
-- lib/data-health/production-baseline.ts) is the owner's own decision
-- to make, not performed here. NOT applied anywhere by this round.
--
-- What this fixes, and how it was confirmed (2026-10-19, second follow-
-- up review): a read-only `wrangler d1 execute --remote` schema export
-- of Staging's REAL, currently-live calendar_event_links/
-- calendar_event_link_history tables, fed through the exact same
-- normalize-then-rebuild logic lib/operations/schema-backup.ts's
-- buildSchemaOnlyBackup() uses, reproduces a real "near CREATE: syntax
-- error" restore failure against Staging's OWN actual stored schema
-- text -- not merely the already-fixed local migration/baseline copy.
-- This is a live, present-tense defect in the real schema-backup/
-- restore path today, not a cosmetic difference (see
-- docs/AI-HANDOFF.md's own corrected finding, which withdraws last
-- round's incorrect "cosmetic/zero-risk" characterization).
--
-- Root cause: two explanatory comments, added to
-- drizzle/0048_google_calendar_sync.sql by an earlier "issue 2" review
-- round, were placed INSIDE the calendar_event_links/
-- calendar_event_link_history column lists -- violating that same
-- migration's own documented convention (every comment belongs BEFORE
-- the whole CREATE statement). Both tables were already created on
-- Staging from that pre-fix text; a table's own stored CREATE TABLE
-- text, once it exists, can only be changed by rebuilding the table --
-- editing the migration file (already done, commit d153259) has no
-- effect on a table SQLite already created from the old text.
--
-- This migration rebuilds BOTH tables using SQLite's standard "create
-- corrected table under a temporary name, copy every row across
-- unchanged, drop the old table, rename the new one into place,
-- recreate its indexes" pattern -- the only way to change a table's own
-- stored text. Every column, type, default, constraint, and index is
-- byte-identical to the already-corrected drizzle/0048_google_calendar_
-- sync.sql; only the stored comment placement changes. No existing
-- row's data is altered, reordered, or dropped. Safe to apply to an
-- environment whose tables were already created from the CORRECTED
-- 0048 text too (the rebuild is then simply redundant: identical
-- structure in, identical structure out, zero behavioral difference).
--
-- Locally tested (not applied anywhere) against a reconstruction of
-- Staging's own actual live schema PLUS its one real row in each table
-- (the pre-existing "Bassman" trip-meeting test artifact from an
-- earlier round's live Staging verification) -- confirmed: applies
-- without error, both rows survive with every column identical, and
-- the resulting schema then passes the exact same restore-verification
-- check that failed before this migration. See the verification script
-- this round's own session used (not committed -- a throwaway local
-- check) for the exact commands; docs/AI-HANDOFF.md records the result.
--
-- CORRECTED (2026-10-19, fifth follow-up review) -- the previous draft
-- used `PRAGMA foreign_keys=OFF`, which does NOT work the way it does in
-- ordinary SQLite. Confirmed against Cloudflare's own current D1
-- documentation and independently rehearsed against a real local
-- Workers/D1 database (see docs/AI-HANDOFF.md for the CI evidence):
-- D1 enforces foreign key constraints by default on every query, and
-- `PRAGMA foreign_keys` cannot disable that enforcement at all --
-- setting it has no effect. The documented, D1-supported mechanism for
-- a migration that temporarily violates a constraint mid-sequence (as
-- every "rebuild a table under a new name, copy rows, drop the old one,
-- rename" repair must -- `calendar_event_link_history.link_id`
-- references `calendar_event_links`, which this repair drops and
-- recreates) is `PRAGMA defer_foreign_keys = on`: constraint checks are
-- deferred until the END of the current transaction, so the real
-- SQLite rule still applies ("DELETE/DROP a referenced parent while
-- referencing child rows still exist" is normally rejected immediately)
-- but only as of the final COMMIT, by which point the renamed table is
-- back in place with the SAME ids every child row already points to.
-- `defer_foreign_keys` resets to OFF automatically at that same commit
-- -- no explicit "turn it back on" statement is needed or appropriate.
--
-- Critically, this ONLY works if every statement below executes inside
-- ONE SINGLE transaction -- `defer_foreign_keys`'s own deferral window
-- is exactly "the current transaction," and D1's own only CONFIRMED
-- atomic multi-statement primitive is the Workers binding's own
-- `db.batch([...])` call (D1 itself documents: a batch runs as one
-- transaction; if any statement fails, the whole batch is rolled back).
-- `wrangler d1 execute --file`'s own cross-statement atomicity for a
-- whole file is NOT reliably documented or confirmed the same way (community
-- reports describe large files being split into multiple separately-
-- sent batches) -- this repair is therefore meant to be applied via a
-- SINGLE `db.batch()` call containing every statement below, in order,
-- never via a plain `wrangler d1 execute --file` invocation and never
-- as separate, individually-committed statements. See docs/AI-HANDOFF.md's
-- own "Staging-only application plan" for the exact script this
-- requires and the rehearsal that proved it against a real local D1.
--> statement-breakpoint
PRAGMA defer_foreign_keys = on;
--> statement-breakpoint
CREATE TABLE `calendar_event_links_rebuild_0049` (
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
  `next_retry_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`desired_state` IN ('present','absent')),
  CHECK (`sync_status` IN ('pending','synced','failed','invalid','auth_required','missing_remotely'))
);
--> statement-breakpoint
INSERT INTO `calendar_event_links_rebuild_0049`
  (`id`,`interaction_id`,`user_id`,`google_calendar_id`,`generation`,`google_event_id`,`google_etag`,`desired_state`,`desired_revision`,`synced_revision`,`sync_status`,`last_error`,`attempt_count`,`lease_owner`,`lease_expires_at`,`next_retry_at`,`created_at`,`updated_at`)
  SELECT `id`,`interaction_id`,`user_id`,`google_calendar_id`,`generation`,`google_event_id`,`google_etag`,`desired_state`,`desired_revision`,`synced_revision`,`sync_status`,`last_error`,`attempt_count`,`lease_owner`,`lease_expires_at`,`next_retry_at`,`created_at`,`updated_at`
  FROM `calendar_event_links`;
--> statement-breakpoint
DROP TABLE `calendar_event_links`;
--> statement-breakpoint
ALTER TABLE `calendar_event_links_rebuild_0049` RENAME TO `calendar_event_links`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`);
--> statement-breakpoint
CREATE INDEX `calendar_event_links_sync_status_idx` ON `calendar_event_links` (`sync_status`);
--> statement-breakpoint
CREATE TABLE `calendar_event_link_history_rebuild_0049` (
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
  CHECK (`create_status` IN ('not_attempted','in_flight','succeeded','failed','invalid')),
  CHECK (`cleanup_status` IN ('not_needed','pending','uncertain','done'))
);
--> statement-breakpoint
INSERT INTO `calendar_event_link_history_rebuild_0049`
  (`id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`)
  SELECT `id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`
  FROM `calendar_event_link_history`;
--> statement-breakpoint
DROP TABLE `calendar_event_link_history`;
--> statement-breakpoint
ALTER TABLE `calendar_event_link_history_rebuild_0049` RENAME TO `calendar_event_link_history`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_link_history_link_generation_uidx` ON `calendar_event_link_history` (`link_id`,`generation`);
--> statement-breakpoint
CREATE INDEX `calendar_event_link_history_cleanup_idx` ON `calendar_event_link_history` (`cleanup_needed`,`cleanup_status`);
-- No trailing `PRAGMA foreign_keys=ON` here: `defer_foreign_keys` already
-- resets itself to OFF automatically at this batch's own commit (the end
-- of "the current transaction" it deferred), and D1 never actually
-- disabled FK enforcement in the first place for this to "turn back on" --
-- an explicit statement here would be a no-op at best and misleading at
-- worst (implying foreign_keys was ever OFF under D1, which it cannot be).
