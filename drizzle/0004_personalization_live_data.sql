ALTER TABLE `users` ADD COLUMN `preferred_first_name` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `organization_name` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `job_title` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `timezone` text DEFAULT 'America/New_York' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `avatar_url` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `owner_user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `data_source` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
ALTER TABLE `giving_activities` ADD COLUMN `owner_user_id` text REFERENCES `users`(`id`);
--> statement-breakpoint
ALTER TABLE `onboarding_preferences` ADD COLUMN `data_mode` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
UPDATE `donors` SET `data_source` = 'sample' WHERE `id` = 'elena-chen';
--> statement-breakpoint
UPDATE `donors` SET `owner_user_id` = (SELECT `user_id` FROM `data_imports` WHERE `status` = 'completed' ORDER BY `completed_at` DESC LIMIT 1), `data_source` = 'live' WHERE `external_source` IS NOT NULL AND `owner_user_id` IS NULL;
--> statement-breakpoint
UPDATE `giving_activities` SET `owner_user_id` = (SELECT `owner_user_id` FROM `donors` WHERE `donors`.`id` = `giving_activities`.`donor_id`) WHERE `owner_user_id` IS NULL;
--> statement-breakpoint
CREATE INDEX `donors_owner_mode_name_idx` ON `donors` (`owner_user_id`,`data_source`,`display_name`);
--> statement-breakpoint
DROP INDEX `donors_donor_code_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `donors_owner_donor_code_unique` ON `donors` (`owner_user_id`,`donor_code`);
--> statement-breakpoint
DROP INDEX `donors_external_source_id_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `donors_owner_external_source_id_unique` ON `donors` (`owner_user_id`,`external_source`,`external_id`);
--> statement-breakpoint
CREATE INDEX `giving_activities_owner_date_idx` ON `giving_activities` (`owner_user_id`,`activity_date`);
--> statement-breakpoint
DROP INDEX `data_imports_file_hash_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `data_imports_user_file_hash_unique` ON `data_imports` (`user_id`,`file_hash`);
--> statement-breakpoint
DROP INDEX `giving_activities_source_fingerprint_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `giving_activities_owner_source_fingerprint_unique` ON `giving_activities` (`owner_user_id`,`external_source`,`source_fingerprint`);
--> statement-breakpoint
CREATE TABLE `sample_cleanup_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `backup_confirmed` integer NOT NULL,
  `removed_donors` integer NOT NULL,
  `removed_gifts` integer NOT NULL,
  `removed_interactions` integer NOT NULL,
  `removed_recommendations` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sample_cleanup_audits_user_date_idx` ON `sample_cleanup_audits` (`user_id`,`created_at`);
