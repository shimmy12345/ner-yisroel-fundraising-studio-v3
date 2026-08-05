CREATE TABLE `legacy_test_cleanup_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `preview_hash` text NOT NULL,
  `records_json` text NOT NULL,
  `archived_interactions` integer NOT NULL,
  `archived_reminders` integer NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `idx_legacy_test_cleanup_user_date`
ON `legacy_test_cleanup_audits` (`user_id`,`created_at`);

PRAGMA optimize;
