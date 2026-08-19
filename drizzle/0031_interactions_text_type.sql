-- Adds "text" (Text Message) as a real, first-class channel alongside
-- call/email/meeting/visit/note/personal/gift.
--
-- interactions.type has NO CHECK constraint in the live schema (confirmed
-- by direct inspection of fundraising-os-staging-db post-0030) -- unlike
-- shared_activities.type, which does. Enforcement for interactions.type has
-- always been application-level only (the KINDS/kinds validation sets in
-- the API routes and the capture UI), so widening it needs no DDL change
-- here at all -- only shared_activities' CHECK constraint requires a table
-- rebuild, exactly like 0029 did for important_dates.source.
--
-- SQLite has no ALTER TABLE ... ALTER COLUMN for a CHECK constraint, so
-- this rebuilds shared_activities with the widened constraint and copies
-- every existing row across byte-for-byte unchanged -- only the constraint
-- governing FUTURE inserts changes; no existing shared_activities row's
-- data or id is altered. interactions, shared_activity_recipient_audits,
-- and every index/FK on any table are untouched by this migration.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_shared_activities` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('call','email','meeting','visit','note','personal','gift','text')),
  `occurred_at` integer NOT NULL,
  `occurred_at_date_only` integer NOT NULL DEFAULT 0,
  `summary` text NOT NULL,
  `source` text NOT NULL DEFAULT 'manual',
  `recipient_count` integer NOT NULL DEFAULT 0,
  `deleted_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_shared_activities` (`id`,`user_id`,`type`,`occurred_at`,`occurred_at_date_only`,`summary`,`source`,`recipient_count`,`deleted_at`,`created_at`,`updated_at`)
  SELECT `id`,`user_id`,`type`,`occurred_at`,`occurred_at_date_only`,`summary`,`source`,`recipient_count`,`deleted_at`,`created_at`,`updated_at` FROM `shared_activities`;
--> statement-breakpoint
DROP TABLE `shared_activities`;
--> statement-breakpoint
ALTER TABLE `__new_shared_activities` RENAME TO `shared_activities`;
--> statement-breakpoint
CREATE INDEX `shared_activities_user_date_idx` ON `shared_activities` (`user_id`,`occurred_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
