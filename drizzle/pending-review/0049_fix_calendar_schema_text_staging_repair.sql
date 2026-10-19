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
-- evidence trail of each round):
--   1st-4th review rounds: identified the defect; an early draft used
--     `PRAGMA foreign_keys=OFF` around a single DROP-TABLE-while-
--     referenced rebuild, modeled on ordinary SQLite's own documented
--     12-step "complex schema change" procedure, and was locally tested
--     only against plain SQLite (node:sqlite), not real D1.
--   5th review round: research into Cloudflare D1's actual documented
--     behavior found `PRAGMA foreign_keys` has NO effect on D1 at all --
--     D1 enforces foreign keys unconditionally on every query, and
--     cannot be told to stop. Switched to `PRAGMA defer_foreign_keys =
--     on`, SQLite's own documented alternative for exactly this
--     "temporarily violate an FK mid-rebuild" case, applied inside a
--     single `db.batch()` call (D1's only documented atomic multi-
--     statement primitive).
--   6th review round (2026-10-19, this draft): rehearsed the
--     `defer_foreign_keys` version against a REAL local D1 binding on
--     Linux CI, with synthetic data that actually exercises the FK (see
--     tests/calendar-schema-repair-rehearsal.test.mjs and docs/
--     AI-HANDOFF.md for the exact CI run). It FAILED: D1 rejected the
--     batch at the `DROP TABLE calendar_event_links` step with "Durable
--     Object was reset and rolled back to its last known good state
--     because the application left the database in a state where
--     constraints were violated: FOREIGN KEY constraint failed". This
--     matches a confirmed, currently open/unresolved upstream limitation
--     (cloudflare/workerd#7657, cloudflare/workers-sdk#16071): D1
--     performs its own commit-time foreign-key consistency check on a
--     batch's Durable-Object-level storage transaction, and this does
--     NOT reliably honor `defer_foreign_keys`'s SQL-level deferral
--     window the way plain SQLite does -- so a batch that would be
--     perfectly valid, deferred-then-resolved SQLite is still rejected
--     by D1. `defer_foreign_keys` is therefore NOT a dependable mechanism
--     for this kind of rebuild on D1, despite being SQLite's own
--     documented answer to exactly this scenario elsewhere.
--
-- THIS DRAFT'S ACTUAL MECHANISM (6th review round): never drop a table
-- while anything else's declared FOREIGN KEY still points at it, so no
-- deferred-or-otherwise FK check is ever needed at all:
--   1. Rebuild calendar_event_link_history FIRST, but WITHOUT its
--      `link_id REFERENCES calendar_event_links` clause -- this is the
--      only table that references calendar_event_links, so once this
--      step finishes, calendar_event_links has NO referencing FK
--      anywhere in the database, declared or otherwise. Dropping the
--      OLD calendar_event_link_history itself is always safe: nothing
--      references calendar_event_link_history.
--   2. Rebuild calendar_event_links with its corrected (comment-free-
--      in-the-column-list) text -- now safe to drop and replace, since
--      step 1 already removed the only FK that could have pointed at it.
--   3. Rebuild calendar_event_link_history a SECOND time, this time
--      WITH its `link_id REFERENCES calendar_event_links` clause
--      restored -- calendar_event_links is now stable under its real
--      name with the same ids, so this FK is satisfied immediately, not
--      deferred. Dropping the intermediate (FK-less) copy from step 1 is
--      still always safe: nothing references calendar_event_link_history.
-- Every statement below runs inside ONE single `db.batch()` call --
-- still the only confirmed-atomic multi-statement D1 primitive -- so an
-- interrupted/rejected attempt leaves zero partial state, but no
-- statement in this version ever depends on deferred constraint
-- checking: every individual statement is independently valid the
-- instant it runs. No `PRAGMA foreign_keys` / `defer_foreign_keys`
-- statement of any kind appears in this version. See docs/AI-HANDOFF.md's
-- own "Staging-only application plan" for the exact script this
-- requires and the rehearsal that proved this version against a real
-- local D1 (tests/calendar-schema-repair-rehearsal.test.mjs).
--> statement-breakpoint
CREATE TABLE `calendar_event_link_history_nofk_0049` (
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
INSERT INTO `calendar_event_link_history_nofk_0049`
  (`id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`)
  SELECT `id`,`link_id`,`generation`,`google_event_id`,`create_status`,`cleanup_needed`,`cleanup_status`,`cleanup_attempts`,`created_at`,`updated_at`
  FROM `calendar_event_link_history`;
--> statement-breakpoint
DROP TABLE `calendar_event_link_history`;
--> statement-breakpoint
ALTER TABLE `calendar_event_link_history_nofk_0049` RENAME TO `calendar_event_link_history`;
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
