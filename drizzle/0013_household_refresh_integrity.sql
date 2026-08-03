CREATE TABLE `household_import_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `import_id` text NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `change_type` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_import_changes_batch_donor_idx` ON `household_import_changes` (`import_id`,`donor_id`);
--> statement-breakpoint
CREATE INDEX `household_import_changes_user_date_idx` ON `household_import_changes` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `household_import_rollback_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `import_id` text NOT NULL,
  `backup_confirmed` integer NOT NULL,
  `preview_json` text NOT NULL,
  `removed_donors` integer NOT NULL,
  `restored_donors` integer NOT NULL,
  `preserved_later_edits` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_import_rollback_audits_import_idx` ON `household_import_rollback_audits` (`import_id`);
--> statement-breakpoint
CREATE INDEX `household_import_rollback_audits_user_date_idx` ON `household_import_rollback_audits` (`user_id`,`created_at`);
