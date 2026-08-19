-- A fundraiser-recorded ask/solicitation -- the relationship layer's own
-- record of "we asked this donor for $X," deliberately separate from
-- giving_activities (JL Solutions import only -- the financial system of
-- record). status='committed' means only that the fundraiser recorded the
-- donor's yes -- it never creates, updates, or implies a real JL-recorded
-- pledge/gift. Editable (amount/purpose/note/status) -- this row IS the
-- maintained fact, not an event log; its own history lives in ask_changes
-- below, same convention as yahrtzeits/yahrtzeit_changes. Multiple
-- simultaneous pending asks per donor are allowed by design.
CREATE TABLE `asks` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `amount_cents` integer,
  `purpose` text,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','committed','declined','withdrawn')),
  `asked_at` integer NOT NULL,
  `note` text,
  `source_interaction_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`source_interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `asks_donor_status_idx` ON `asks` (`donor_id`,`status`);
--> statement-breakpoint
-- Append-only audit trail for meaningful asks changes (status transitions,
-- amount/purpose corrections) -- matching donor_contact_audits' shape.
-- ask_id IS a real foreign key here (unlike yahrtzeit_changes.yahrtzeit_id,
-- which is not) because, unlike yahrtzeits, asks are never hard-deleted in
-- v1 -- every mutation is an update, so an audit row can never outlive the
-- ask it describes.
CREATE TABLE `ask_changes` (
  `id` text PRIMARY KEY NOT NULL,
  `ask_id` text NOT NULL,
  `user_id` text NOT NULL,
  `donor_id` text NOT NULL,
  `action` text NOT NULL CHECK (`action` IN ('created','updated','status_changed')),
  `changed_fields` text NOT NULL,
  `before_json` text,
  `after_json` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`ask_id`) REFERENCES `asks`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ask_changes_ask_idx` ON `ask_changes` (`ask_id`,`created_at`);
