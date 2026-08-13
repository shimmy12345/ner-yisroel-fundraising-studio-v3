-- Donor yahrtzeit tracking. The Hebrew date (hebrew_month/hebrew_day/
-- hebrew_year) is the canonical, permanent record; the corresponding
-- Gregorian date is never stored -- it's recalculated for the relevant year
-- on every read (see lib/calendar/hebrew-date.ts), so it moves correctly
-- year to year without a yearly manual update. Editable/deletable (unlike
-- gift_acknowledgments' append-only design) because the record itself is
-- the fact being maintained, not a log of events -- its own history lives
-- in yahrtzeit_changes below.
CREATE TABLE `yahrtzeits` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `deceased_name_english` text NOT NULL,
  `deceased_name_hebrew` text,
  `relationship` text NOT NULL,
  `hebrew_month` text NOT NULL,
  `hebrew_day` integer NOT NULL,
  `hebrew_year` integer,
  `source` text NOT NULL CHECK (`source` IN ('manual','import-yahrtzeit-workbook')),
  `source_donor_code` text,
  `fingerprint` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `yahrtzeits_fingerprint_idx` ON `yahrtzeits` (`fingerprint`);
--> statement-breakpoint
CREATE INDEX `yahrtzeits_donor_idx` ON `yahrtzeits` (`donor_id`,`hebrew_month`,`hebrew_day`);
--> statement-breakpoint
CREATE INDEX `yahrtzeits_user_idx` ON `yahrtzeits` (`user_id`);
--> statement-breakpoint
-- Append-only audit trail for yahrtzeits create/update/delete, matching the
-- shape of donor_contact_audits. yahrtzeit_id is not a foreign key: a
-- deletion's audit row must survive after the yahrtzeits row it describes
-- is gone.
CREATE TABLE `yahrtzeit_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `yahrtzeit_id` text NOT NULL,
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
CREATE INDEX `yahrtzeit_changes_yahrtzeit_idx` ON `yahrtzeit_changes` (`yahrtzeit_id`,`created_at`);
