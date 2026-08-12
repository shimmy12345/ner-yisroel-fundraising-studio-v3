-- Distinguishes a genuinely timed record (a real captured/scheduled
-- wall-clock moment) from a date-only record (Monday.com supplies a
-- calendar date, never a time -- the commit route anchors it at UTC noon
-- purely to avoid a timezone day-shift, which is not evidence of an 8:00 AM
-- event). Defaults to false so every existing row keeps its current display
-- behavior; only the Monday import commit route ever writes true.
ALTER TABLE `interactions` ADD COLUMN `occurred_at_date_only` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `recommendations` ADD COLUMN `due_at_date_only` integer DEFAULT 0 NOT NULL;
