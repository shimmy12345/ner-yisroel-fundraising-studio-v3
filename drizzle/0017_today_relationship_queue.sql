CREATE TABLE `donor_views` (
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `viewed_at` integer NOT NULL,
  PRIMARY KEY (`user_id`,`donor_id`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `donor_views_user_date_idx` ON `donor_views` (`user_id`,`viewed_at`);

CREATE TABLE `relationship_queue_dismissals` (
  `user_id` text NOT NULL,
  `item_key` text NOT NULL,
  `donor_id` text NOT NULL,
  `dismissed_at` integer NOT NULL,
  PRIMARY KEY (`user_id`,`item_key`),
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `relationship_queue_dismissals_user_date_idx` ON `relationship_queue_dismissals` (`user_id`,`dismissed_at`);

PRAGMA optimize;
