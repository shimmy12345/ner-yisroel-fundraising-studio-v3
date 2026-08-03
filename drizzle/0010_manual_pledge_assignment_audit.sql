CREATE TABLE `jl_payment_assignment_audits` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `import_id` text NOT NULL,
  `payment_fingerprint` text NOT NULL,
  `donor_id` text NOT NULL,
  `pledge_activity_id` text,
  `decision_type` text NOT NULL CHECK (`decision_type` IN ('apply_to_pledge', 'new_gift')),
  `payment_cents` integer NOT NULL,
  `applied_cents` integer NOT NULL,
  `new_gift_cents` integer NOT NULL,
  `overpayment_action` text CHECK (`overpayment_action` IS NULL OR `overpayment_action` = 'split_remainder_new_gift'),
  `previous_paid_cents` integer,
  `next_paid_cents` integer,
  `previous_balance_cents` integer,
  `next_balance_cents` integer,
  `previous_status` text,
  `next_status` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`import_id`) REFERENCES `data_imports`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`pledge_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jl_payment_assignment_audits_import_payment_idx` ON `jl_payment_assignment_audits` (`import_id`,`payment_fingerprint`);
--> statement-breakpoint
CREATE INDEX `jl_payment_assignment_audits_user_date_idx` ON `jl_payment_assignment_audits` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `jl_payment_assignment_audits_pledge_idx` ON `jl_payment_assignment_audits` (`pledge_activity_id`,`created_at`);
--> statement-breakpoint
PRAGMA optimize;
