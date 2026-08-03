ALTER TABLE `donors` ADD COLUMN `contact_note` text;
--> statement-breakpoint
CREATE TABLE `donor_contact_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `action` text NOT NULL,
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `donor_contact_audits_donor_date_idx` ON `donor_contact_audits` (`donor_id`,`created_at`);
