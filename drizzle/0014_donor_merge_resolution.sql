ALTER TABLE `donors` ADD COLUMN `archived_at` integer;
ALTER TABLE `donors` ADD COLUMN `merged_into_donor_id` text REFERENCES `donors`(`id`);

CREATE INDEX `donors_owner_active_idx`
ON `donors` (`owner_user_id`,`data_source`,`archived_at`);

CREATE INDEX `donors_merged_into_idx`
ON `donors` (`merged_into_donor_id`);

CREATE TABLE `donor_merge_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `surviving_donor_id` text NOT NULL,
  `archived_donor_id` text NOT NULL,
  `field_choices_json` text NOT NULL,
  `survivor_before_json` text NOT NULL,
  `duplicate_before_json` text NOT NULL,
  `survivor_after_json` text NOT NULL,
  `moved_counts_json` text NOT NULL,
  `source` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
  FOREIGN KEY (`surviving_donor_id`) REFERENCES `donors`(`id`),
  FOREIGN KEY (`archived_donor_id`) REFERENCES `donors`(`id`)
);

CREATE INDEX `donor_merge_audits_user_date_idx`
ON `donor_merge_audits` (`user_id`,`created_at`);

CREATE INDEX `donor_merge_audits_archived_idx`
ON `donor_merge_audits` (`archived_donor_id`);

PRAGMA optimize;
