CREATE TABLE `data_health_repair_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `record_type` text NOT NULL CHECK (`record_type` IN ('interaction','reminder')),
  `record_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('reattach','move_to_survivor','archive','dismiss_false_positive')),
  `previous_donor_id` text,
  `next_donor_id` text,
  `previous_state_json` text NOT NULL,
  `next_state_json` text NOT NULL,
  `reason` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `idx_data_health_repairs_user_record`
ON `data_health_repair_audits` (`user_id`,`record_type`,`record_id`,`created_at`);

CREATE INDEX `idx_data_health_repairs_user_date`
ON `data_health_repair_audits` (`user_id`,`created_at`);

PRAGMA optimize;
