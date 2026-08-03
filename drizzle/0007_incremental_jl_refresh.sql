CREATE TABLE `jl_refresh_state` (
  `user_id` text PRIMARY KEY NOT NULL,
  `last_household_refresh_at` integer,
  `last_donation_refresh_at` integer,
  `last_donation_range_start` integer,
  `last_donation_range_end` integer,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA optimize;
