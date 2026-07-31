ALTER TABLE `donors` ADD COLUMN `donor_code` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `spouse` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `address` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `external_source` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `external_id` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `last_name` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `primary_first_name` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `spouse_first_name` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `primary_title` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `spouse_title` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `alternate_mobile_phone` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `home_phone` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `address_line_1` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `city` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `state` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `postal_code` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `country` text;
--> statement-breakpoint
ALTER TABLE `donors` ADD COLUMN `source_snapshot` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `donors_donor_code_unique` ON `donors` (`donor_code`) WHERE `donor_code` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `donors_external_source_id_unique` ON `donors` (`external_source`,`external_id`) WHERE `external_source` IS NOT NULL AND `external_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `gifts` ADD COLUMN `note` text;
--> statement-breakpoint
CREATE TABLE `data_imports` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `file_name` text NOT NULL,
  `file_hash` text NOT NULL,
  `status` text NOT NULL,
  `update_existing` integer DEFAULT 0 NOT NULL,
  `report_json` text NOT NULL,
  `created_at` integer NOT NULL,
  `completed_at` integer,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `data_imports_file_hash_unique` ON `data_imports` (`file_hash`);
--> statement-breakpoint
CREATE INDEX `data_imports_user_date_idx` ON `data_imports` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `onboarding_preferences` (
  `user_id` text PRIMARY KEY NOT NULL,
  `sample_data_acknowledged` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
