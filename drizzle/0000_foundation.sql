CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `email` text NOT NULL,
  `name` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE TABLE `donors` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `email` text,
  `phone` text,
  `location` text,
  `relationship_summary` text,
  `institutional_memory` text,
  `relationship_health` integer,
  `preferred_communication` text,
  `interests` text,
  `family` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `type` text NOT NULL,
  `occurred_at` integer NOT NULL,
  `summary` text NOT NULL,
  `source` text DEFAULT 'manual' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `interactions_donor_date_idx` ON `interactions` (`donor_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `gifts` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `amount_cents` integer NOT NULL,
  `fund` text NOT NULL,
  `received_at` integer NOT NULL,
  `acknowledged_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gifts_donor_date_idx` ON `gifts` (`donor_id`,`received_at`);
--> statement-breakpoint
CREATE TABLE `recommendations` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `action` text NOT NULL,
  `reason` text NOT NULL,
  `score` integer NOT NULL,
  `status` text DEFAULT 'open' NOT NULL,
  `due_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recommendations_user_status_idx` ON `recommendations` (`user_id`,`status`);
