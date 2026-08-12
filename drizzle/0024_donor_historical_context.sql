-- First-class historical context for uncertain donor history (e.g.
-- Monday.com import rows that cannot be safely classified as a completed
-- interaction or a genuine future plan). Deliberately its own table: never
-- written to interactions, recommendations, donors.contact_note/
-- relationship_summary/institutional_memory, or donor_research_findings.
-- status is only ever 'unconfirmed' or 'dismissed' -- there is no
-- 'confirmed' state here, since confirming something means writing a real
-- interactions/recommendations row through the existing importer actions,
-- not flipping a flag on this table.
CREATE TABLE `donor_historical_context` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `text` text NOT NULL,
  `source_date` integer,
  `classification` text NOT NULL,
  `source` text NOT NULL,
  `fingerprint` text NOT NULL,
  `status` text NOT NULL DEFAULT 'unconfirmed' CHECK (`status` IN ('unconfirmed','dismissed')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `donor_historical_context_user_fingerprint_uidx` ON `donor_historical_context` (`user_id`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX `donor_historical_context_donor_date_idx` ON `donor_historical_context` (`donor_id`,`created_at`);
