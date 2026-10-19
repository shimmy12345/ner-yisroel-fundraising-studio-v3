-- DRAFT -- PENDING SEPARATE REVIEW. Deliberately placed under
-- drizzle/pending-review/, NOT drizzle/ itself, so it is never picked up
-- by scripts/generate-production-baseline.mjs, lib/calendar/testing/
-- local-d1.ts, or any other tool that globs drizzle/*.sql -- adding it
-- to the real migration sequence (renumbering, regenerating the
-- baseline, bumping the hardcoded migration-count check in
-- lib/data-health/production-baseline.ts) is the owner's own decision
-- to make, not performed here. NOT applied anywhere by this round.
--
-- What this fixes: a read-only `wrangler d1 execute --remote` schema
-- export of Staging's REAL, currently-live calendar_event_links/
-- calendar_event_link_history tables, fed through the exact same
-- normalize-then-rebuild logic lib/operations/schema-backup.ts's
-- buildSchemaOnlyBackup() uses, reproduces a real "near CREATE: syntax
-- error" restore failure against Staging's OWN actual stored schema
-- text -- a live, present-tense defect in the real schema-backup/
-- restore path today, not a cosmetic difference. Root cause: two
-- explanatory comments, added to drizzle/0048_google_calendar_sync.sql
-- by an earlier "issue 2" review round, were placed INSIDE the
-- calendar_event_links/calendar_event_link_history column lists --
-- violating that same migration's own documented convention (every
-- comment belongs BEFORE the whole CREATE statement). Both tables were
-- already created on Staging from that pre-fix text; a table's own
-- stored CREATE TABLE text, once it exists, can only be changed by
-- rebuilding the table -- editing the migration file (already done,
-- commit d153259) has no effect on a table SQLite already created from
-- the old text. Every column, type, default, constraint, and index this
-- migration ends with is byte-identical to the already-corrected
-- drizzle/0048_google_calendar_sync.sql; only the stored comment
-- placement changes. No existing row's data is altered, reordered, or
-- dropped. Safe to apply to an environment whose tables were already
-- created from the CORRECTED 0048 text too (the rebuild is then simply
-- redundant: identical structure in, identical structure out).
--
-- Revision history (condensed -- see docs/AI-HANDOFF.md for the full
-- evidence trail, including the actual CI run for each round):
--   1st-4th review rounds: identified the defect; an early draft used
--     `PRAGMA foreign_keys=OFF` around a DROP-TABLE-while-referenced
--     rebuild (SQLite's own documented 12-step "complex schema change"
--     procedure), tested only against plain SQLite (node:sqlite), not
--     real D1.
--   5th review round: `PRAGMA foreign_keys` confirmed to have NO effect
--     on D1 (it enforces FKs unconditionally, always). Switched to
--     `PRAGMA defer_foreign_keys = on` inside a single `db.batch()`.
--   6th review round: rehearsed against a REAL local D1 binding on
--     Linux CI with synthetic data that actually exercises the FK.
--     `defer_foreign_keys` FAILED there too: D1 rejected the batch at
--     the DROP TABLE step with "Durable Object was reset ... FOREIGN
--     KEY constraint failed" -- a confirmed, currently open/unresolved
--     upstream limitation (cloudflare/workerd#7657, cloudflare/
--     workers-sdk#16071): D1's own commit-time FK consistency check does
--     not reliably honor `defer_foreign_keys`'s deferral window.
--     Redesigned to never drop a table while anything else's FK still
--     points at it (rebuild the child table WITHOUT its FK first, then
--     the parent, then the child again WITH the FK restored) -- the real
--     D1 batch then applied cleanly with zero FK errors.
--   7th review round (2026-10-19, this draft): the SAME rehearsal then
--     caught a SECOND, independent real-D1 quirk in that version: it
--     used `ALTER TABLE <temp-name> RENAME TO <real-name>` to move the
--     rebuilt table into place, and `PRAGMA integrity_check` showed that
--     D1/SQLite's own RENAME TO rewrites the table's stored identifier
--     using DOUBLE QUOTES (`"calendar_event_links"`), regardless of the
--     original backtick-quoted CREATE TABLE text -- a well-known SQLite
--     behavior, not a bug introduced here. Left as-is, this would make
--     the repaired table's own stored text permanently diverge (by
--     quoting style alone) from what a fresh migration replay produces,
--     which is exactly the kind of difference
--     lib/data-health/production-baseline.ts's compareSchemaObjects()
--     treats as "Table definition differs" -- silently reintroducing a
--     NEW schema/baseline mismatch in the same breath as fixing the old
--     one. `PRAGMA integrity_check` itself also turned out to be flatly
--     rejected by D1 over the Workers binding (`D1_ERROR: not
--     authorized: SQLITE_AUTH`) -- unrelated to this defect, but
--     confirmed this round; see docs/AI-HANDOFF.md.
--
-- THIS DRAFT'S ACTUAL MECHANISM (7th review round): the FINAL table
-- under each real name is always created by a literal, directly-quoted
-- `CREATE TABLE` statement -- NEVER produced by renaming a temp table
-- into place -- so the stored text is always byte-identical to what a
-- fresh migration replay would produce. Only the OLD table (which gets
-- dropped immediately after its data is copied out) is ever renamed;
-- its resulting quote style is irrelevant since it never persists.
-- Combined with the 6th round's fix (rebuild order that never drops a
-- table while anything else's FK points at it):
--   1. `calendar_event_link_history` is renamed out of the way, then
--      recreated directly under its real name WITHOUT the
--      `link_id REFERENCES calendar_event_links` clause, and its data
--      copied back in -- calendar_event_links now has no referencing FK
--      anywhere in the database, declared or otherwise.
--   2. `calendar_event_links` is renamed out of the way, then recreated
--      directly under its real name with the corrected (comment-free-
--      in-the-column-list) text, and its data copied back in -- always
--      safe to rename/drop, since step 1 already removed the only FK
--      that could have pointed at it.
--   3. `calendar_event_link_history` (the FK-less version from step 1)
--      is renamed out of the way AGAIN, then recreated directly under
--      its real name WITH the FK restored, and its data copied back in
--      -- calendar_event_links is now stable under its real name with
--      the same ids, so every row's FK is satisfied immediately, not
--      deferred.
-- Every intermediate "old" table is dropped only after its own data has
-- already been copied into the real one; nothing is ever dropped while
-- anything else's FK points at it. Every statement runs inside ONE
-- single `db.batch()` call -- the only confirmed-atomic multi-statement
-- D1 primitive -- so an interrupted/rejected attempt leaves zero partial
-- state. No `PRAGMA` of any kind appears in this version. See
-- docs/AI-HANDOFF.md's own "Staging-only application plan" for the exact
-- script this requires and the rehearsal that proved this version
-- against a real local D1 (tests/calendar-schema-repair-rehearsal.test.mjs).
--> statement-breakpoint
ALTER TABLE `calendar_event_link_history` RENAME TO `calendar_event_link_history_old_0049`;
--> statement-breakpoint
CREATE TABLE `calendar_event_link_history` (
  `id` text PRIMARY KEY NOT NULL,
  `link_id` text NOT NULL,
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
INSERT INTO `calendar_event_link_history`
  (`id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`)
  SELECT `id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`
  FROM `calendar_event_link_history_old_0049`;
--> statement-breakpoint
DROP TABLE `calendar_event_link_history_old_0049`;
--> statement-breakpoint
ALTER TABLE `calendar_event_links` RENAME TO `calendar_event_links_old_0049`;
--> statement-breakpoint
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
  `next_retry_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK (`desired_state` IN ('present','absent')),
  CHECK (`sync_status` IN ('pending','synced','failed','invalid','auth_required','missing_remotely'))
);
--> statement-breakpoint
INSERT INTO `calendar_event_links`
  (`id`,`interaction_id`,`user_id`,`google_calendar_id`,`generation`,`google_event_id`,`google_etag`,`desired_state`,`desired_revision`,`synced_revision`,`sync_status`,`last_error`,`attempt_count`,`lease_owner`,`lease_expires_at`,`next_retry_at`,`created_at`,`updated_at`)
  SELECT `id`,`interaction_id`,`user_id`,`google_calendar_id`,`generation`,`google_event_id`,`google_etag`,`desired_state`,`desired_revision`,`synced_revision`,`sync_status`,`last_error`,`attempt_count`,`lease_owner`,`lease_expires_at`,`next_retry_at`,`created_at`,`updated_at`
  FROM `calendar_event_links_old_0049`;
--> statement-breakpoint
DROP TABLE `calendar_event_links_old_0049`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_links_interaction_uidx` ON `calendar_event_links` (`interaction_id`);
--> statement-breakpoint
CREATE INDEX `calendar_event_links_sync_status_idx` ON `calendar_event_links` (`sync_status`);
--> statement-breakpoint
ALTER TABLE `calendar_event_link_history` RENAME TO `calendar_event_link_history_old2_0049`;
--> statement-breakpoint
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
  CHECK (`create_status` IN ('not_attempted','in_flight','succeeded','failed','invalid')),
  CHECK (`cleanup_status` IN ('not_needed','pending','uncertain','done'))
);
--> statement-breakpoint
INSERT INTO `calendar_event_link_history`
  (`id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`)
  SELECT `id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`
  FROM `calendar_event_link_history_old2_0049`;
--> statement-breakpoint
DROP TABLE `calendar_event_link_history_old2_0049`;
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_event_link_history_link_generation_uidx` ON `calendar_event_link_history` (`link_id`,`generation`);
--> statement-breakpoint
CREATE INDEX `calendar_event_link_history_cleanup_idx` ON `calendar_event_link_history` (`cleanup_needed`,`cleanup_status`);
