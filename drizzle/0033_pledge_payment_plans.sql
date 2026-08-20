-- Fundraiser-declared stewardship metadata for an EXISTING open JL
-- pledge -- "this pledge is being paid monthly" -- never a rewrite of
-- JL/giving_activities data. See docs/PLEDGE-PAYMENT-PLAN-DESIGN.md for
-- the full design. pledge_activity_id is a real FK to the pledge's own
-- giving_activities row, proven stable across ordinary JL reimports
-- (that row is updated in place on payment application; only a
-- correction to the pledge's own original commitment terms, a separate,
-- rare event, would ever replace it). No UNIQUE constraint on
-- pledge_activity_id: a donor can end one plan and start a new one on
-- the same pledge later; "at most one ACTIVE plan per pledge" is an
-- application-level check, same treatment as asks' own "multiple
-- pending asks allowed, no artificial one-at-a-time DB constraint".
-- expected_day_of_month is auto-derived from the fundraiser's entered
-- next_expected_payment_at at creation/edit time -- never a separate
-- form field -- and is what every subsequent calendar-month advance
-- clamps to, so a February clamp can never permanently lose a
-- 31st-anchored schedule. isOnTrack/isLate/daysLate/latestActualPaymentAt
-- are deliberately NOT columns here -- always derived fresh from this
-- row + real jl_payment_assignment_audits history, never stored.
CREATE TABLE `pledge_payment_plans` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `pledge_activity_id` text NOT NULL,
  `cadence` text NOT NULL DEFAULT 'monthly' CHECK (`cadence` IN ('monthly')),
  `installment_amount_cents` integer,
  `expected_day_of_month` integer NOT NULL,
  `next_expected_payment_at` integer NOT NULL,
  `final_expected_payment_at` integer NOT NULL,
  `note` text,
  `ended_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action,
  CHECK (`expected_day_of_month` BETWEEN 1 AND 31)
);
--> statement-breakpoint
CREATE INDEX `pledge_payment_plans_pledge_idx` ON `pledge_payment_plans` (`pledge_activity_id`);
--> statement-breakpoint
-- Append-only audit trail for meaningful payment-plan changes (creation,
-- edits to the schedule/amount/note, ending) -- directly modeled on
-- ask_changes. plan_id IS a real foreign key (payment plans are never
-- hard-deleted, only ended) -- same reasoning as ask_id on ask_changes.
CREATE TABLE `pledge_payment_plan_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `plan_id` text NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','ended')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`plan_id`) REFERENCES `pledge_payment_plans`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pledge_payment_plan_changes_plan_idx` ON `pledge_payment_plan_changes` (`plan_id`,`created_at`);
