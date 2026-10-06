-- Donor Rebbeim (see docs/AI-HANDOFF.md and lib/relationships/rebbeim.ts).
-- Hand-authored, per this repo's established convention: drizzle-kit's own
-- generate journal has been stale since migration 0014 and is not trusted.
-- Purely additive: two new CREATE TABLE statements, three new indexes --
-- zero ALTER of any existing table.
--
-- Product context: for each donor, record zero, one, or many Rebbeim that
-- donor is meaningfully connected to -- a binary relationship (exists or
-- does not), never a relationship-strength score, a primary/secondary
-- hierarchy, or a current/former lifecycle. `rebbeim` is a canonical
-- directory (so "Harav Berkowitz" is one record reused everywhere, never a
-- free-text string repeated inconsistently per donor); `donor_rebbeim` is
-- the many-to-many join. Neither table is ever written to by ordinary JL
-- donation/household import -- this is populated only by the dedicated
-- seed script (scripts/seed-rebbeim-directory.mjs) and the dedicated
-- donor-code/Rebbeim bulk-assignment import.
CREATE TABLE `rebbeim` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rebbeim_normalized_name_idx` ON `rebbeim` (`user_id`,`normalized_name`);
--> statement-breakpoint
CREATE TABLE `donor_rebbeim` (
	`donor_id` text NOT NULL,
	`rebbi_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL CHECK(`source` IN ('manual','bulk_import')),
	`created_at` integer NOT NULL,
	PRIMARY KEY(`donor_id`, `rebbi_id`),
	FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rebbi_id`) REFERENCES `rebbeim`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `donor_rebbeim_rebbi_idx` ON `donor_rebbeim` (`rebbi_id`);
