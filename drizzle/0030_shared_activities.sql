-- One outreach activity (a shared meeting, or a broadcast text/email/photo)
-- logged once and linked to multiple donors. shared_activities holds the
-- single canonical copy of type/date/summary; interactions gains two
-- nullable columns (shared_activity_id, role) so each linked donor still
-- gets their own interactions row -- donor_id stays NOT NULL there, every
-- existing single-donor query (Last Contact, timeline, Meeting Brief,
-- recommendation scoring, donor merge) keeps working completely unchanged.
-- Every pre-existing interactions row simply has both new columns NULL,
-- which is exactly its current (undefined) state -- no backfill needed.
CREATE TABLE `shared_activities` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('call','email','meeting','visit','note','personal','gift')),
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
CREATE INDEX `shared_activities_user_date_idx` ON `shared_activities` (`user_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `shared_activity_recipient_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `shared_activity_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('added','removed')),
  `created_at` integer NOT NULL,
  FOREIGN KEY (`shared_activity_id`) REFERENCES `shared_activities`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shared_activity_recipient_audits_activity_date_idx` ON `shared_activity_recipient_audits` (`shared_activity_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `interactions` ADD COLUMN `shared_activity_id` text REFERENCES `shared_activities`(`id`);
--> statement-breakpoint
ALTER TABLE `interactions` ADD COLUMN `role` text CHECK (`role` IN ('participant','recipient'));
--> statement-breakpoint
CREATE INDEX `interactions_shared_activity_idx` ON `interactions` (`shared_activity_id`);
--> statement-breakpoint
-- A donor can only be linked to a given shared activity once -- guards both
-- accidental double-add from the recipient picker and the donor-merge case
-- where the surviving donor already has a link to the same activity as the
-- one being reassigned (app/api/donors/merge/route.ts must de-dup
-- explicitly before that reassignment; this constraint is the backstop).
CREATE UNIQUE INDEX `interactions_shared_activity_donor_uidx` ON `interactions` (`shared_activity_id`,`donor_id`) WHERE `shared_activity_id` IS NOT NULL;
