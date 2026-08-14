-- Birthday and Anniversary -- Gregorian-recurring relationship dates, kept
-- as a separate table from yahrtzeits rather than merged into it: the two
-- Gregorian types share identical recurrence semantics with each other but
-- not with yahrtzeit's Hebrew-calendar fields. yahrtzeits/yahrtzeit_changes
-- are untouched by this migration -- no existing data moves.
CREATE TABLE `important_dates` (
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
  `source` text NOT NULL CHECK (`source` IN ('manual')),
  `fingerprint` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `important_dates_fingerprint_idx` ON `important_dates` (`fingerprint`);
--> statement-breakpoint
CREATE INDEX `important_dates_donor_idx` ON `important_dates` (`donor_id`,`type`,`month`,`day`);
--> statement-breakpoint
CREATE INDEX `important_dates_user_idx` ON `important_dates` (`user_id`);
--> statement-breakpoint
-- Append-only audit trail for important_dates create/update/delete, matching
-- yahrtzeit_changes' shape exactly. important_date_id is not a foreign key:
-- a deletion's audit row must survive after the important_dates row it
-- describes is gone.
CREATE TABLE `important_date_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `important_date_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','deleted')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `important_date_changes_important_date_idx` ON `important_date_changes` (`important_date_id`,`created_at`);
