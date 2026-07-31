CREATE TABLE `giving_activities` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `external_source` text NOT NULL,
  `external_household_id` text NOT NULL,
  `source_fingerprint` text NOT NULL,
  `activity_date` integer,
  `committed_cents` integer,
  `paid_cents` integer,
  `balance_cents` integer,
  `item_type` text,
  `description` text,
  `source_campaign` text,
  `category` text NOT NULL,
  `source_snapshot` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `giving_activities_source_fingerprint_unique` ON `giving_activities` (`external_source`,`source_fingerprint`);
--> statement-breakpoint
CREATE INDEX `giving_activities_donor_date_idx` ON `giving_activities` (`donor_id`,`activity_date`);
--> statement-breakpoint
CREATE TABLE `giving_activity_import_changes` (
  `import_id` text NOT NULL,
  `source_fingerprint` text NOT NULL,
  `change_type` text NOT NULL,
  `previous_json` text,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`import_id`,`source_fingerprint`),
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action
);
