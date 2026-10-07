-- Pledge payment-plan CLEANUP REVIEW (see
-- docs/PLEDGE-PAYMENT-PLAN-CLEANUP-AUDIT.md and the /pledge-review
-- surface) -- a narrow, temporary human-review decision recorded
-- against one specific pledge: "I manually reviewed this pledge during
-- the cleanup and chose this outcome." This is deliberately NOT the
-- payment-plan feature (pledge_payment_plans, migration 0033) --
-- selecting 'needs_payment_plan' here never creates, edits, or implies
-- a real pledge_payment_plans row.
--
-- No donor_id column: every access pattern joins through
-- pledge_activity_id to giving_activities when a donor is needed, and
-- omitting it keeps this table to the minimal field set this narrow
-- workflow needs. No reviewer_user_id: this app has no multi-reviewer/
-- collaboration model anywhere else. No *_changes audit table (unlike
-- pledge_payment_plan_changes) -- a single mutable human decision for a
-- temporary cleanup pass does not warrant one; updated_at already
-- answers "when did this last change."
--
-- "Unreviewed" is never a stored value -- it is the ABSENCE of a row
-- for a given (user_id, pledge_activity_id) pair. A save is always an
-- upsert (INSERT ... ON CONFLICT(user_id, pledge_activity_id) DO
-- UPDATE), so changing a decision updates the one existing row rather
-- than creating a duplicate; clearing a decision deletes the row.
CREATE TABLE `pledge_payment_plan_reviews` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `pledge_activity_id` text NOT NULL,
  `review_status` text NOT NULL CHECK (`review_status` IN ('needs_payment_plan','no_payment_plan_needed','need_to_investigate')),
  `reviewed_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pledge_payment_plan_reviews_user_pledge_uidx` ON `pledge_payment_plan_reviews` (`user_id`,`pledge_activity_id`);
