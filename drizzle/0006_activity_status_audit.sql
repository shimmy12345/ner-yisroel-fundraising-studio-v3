CREATE TABLE `activity_status_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `interaction_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL,
  `from_status` text NOT NULL,
  `to_status` text NOT NULL,
  `previous_source` text NOT NULL,
  `next_source` text NOT NULL,
  `previous_occurred_at` integer NOT NULL,
  `next_occurred_at` integer NOT NULL,
  `previous_summary` text NOT NULL,
  `next_summary` text NOT NULL,
  `follow_up_id` text,
  `created_at` integer NOT NULL,
  `undone_at` integer,
  FOREIGN KEY (`interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activity_status_audits_interaction_date_idx` ON `activity_status_audits` (`interaction_id`,`created_at`);
--> statement-breakpoint
PRAGMA optimize;
