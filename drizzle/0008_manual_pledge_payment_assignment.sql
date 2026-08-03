CREATE TABLE `jl_payment_assignments` (
  `user_id` text NOT NULL,
  `payment_fingerprint` text NOT NULL,
  `decision_type` text NOT NULL CHECK (`decision_type` IN ('apply_to_pledge', 'new_gift')),
  `pledge_activity_id` text,
  `applied_import_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`user_id`, `payment_fingerprint`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `jl_payment_assignments_pledge_idx` ON `jl_payment_assignments` (`pledge_activity_id`);
--> statement-breakpoint
PRAGMA optimize;
