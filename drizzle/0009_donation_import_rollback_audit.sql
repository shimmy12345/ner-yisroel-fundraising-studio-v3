CREATE TABLE `donation_import_rollback_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `import_id` text NOT NULL,
  `backup_confirmed` integer NOT NULL,
  `preview_json` text NOT NULL,
  `removed_gifts` integer NOT NULL,
  `restored_pledges` integer NOT NULL,
  `restored_balances` integer NOT NULL,
  `restored_statuses` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donation_import_rollback_audits_import_idx` ON `donation_import_rollback_audits` (`import_id`);
--> statement-breakpoint
CREATE INDEX `donation_import_rollback_audits_user_date_idx` ON `donation_import_rollback_audits` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `workspace_backup_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `purpose` text NOT NULL,
  `import_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workspace_backup_audits_user_import_idx` ON `workspace_backup_audits` (`user_id`,`import_id`,`created_at`);
