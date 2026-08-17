-- Widens important_dates.source to allow 'import-dob' (Date of Birth
-- spreadsheet import, matched strictly by donor code -- see
-- lib/import/dob-pipeline.ts) alongside the existing 'manual' value.
-- SQLite has no ALTER TABLE ... ALTER COLUMN for a CHECK constraint, so
-- this rebuilds the table with the widened constraint and copies every
-- existing row across byte-for-byte unchanged -- only the constraint
-- governing FUTURE inserts changes; no existing important_dates row's
-- data, id, or fingerprint is altered. important_date_changes and every
-- other table are untouched by this migration.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_important_dates` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL CHECK (`type` IN ('birthday','anniversary')),
  `person_name` text,
  `relationship` text,
  `month` integer NOT NULL,
  `day` integer NOT NULL,
  `year` integer,
  `notes` text,
  `source` text NOT NULL CHECK (`source` IN ('manual','import-dob')),
  `fingerprint` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_important_dates` (`id`,`donor_id`,`user_id`,`type`,`person_name`,`relationship`,`month`,`day`,`year`,`notes`,`source`,`fingerprint`,`created_at`,`updated_at`)
  SELECT `id`,`donor_id`,`user_id`,`type`,`person_name`,`relationship`,`month`,`day`,`year`,`notes`,`source`,`fingerprint`,`created_at`,`updated_at` FROM `important_dates`;
--> statement-breakpoint
DROP TABLE `important_dates`;
--> statement-breakpoint
ALTER TABLE `__new_important_dates` RENAME TO `important_dates`;
--> statement-breakpoint
CREATE UNIQUE INDEX `important_dates_fingerprint_idx` ON `important_dates` (`fingerprint`);
--> statement-breakpoint
CREATE INDEX `important_dates_donor_idx` ON `important_dates` (`donor_id`,`type`,`month`,`day`);
--> statement-breakpoint
CREATE INDEX `important_dates_user_idx` ON `important_dates` (`user_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
