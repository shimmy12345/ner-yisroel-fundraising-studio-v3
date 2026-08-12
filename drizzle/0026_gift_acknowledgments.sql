-- Lightweight, append-only acknowledgment tracking for a paid gift/giving
-- activity ("Mark thank-you sent" etc.), deliberately never a full
-- interactions row: does not count as a completed relationship
-- interaction, does not change last-contact, and never generates
-- relationship_summary/institutional_memory content. A dedicated table
-- (rather than a column on giving_activities/gifts) so a JL re-import's
-- own UPDATE on giving_activities can never touch it -- this table isn't
-- referenced by that statement at all, so acknowledgment state survives
-- every re-import automatically, with no special-case needed. Append-only
-- (never UPDATEd) so a later status change never destroys the record of
-- what was marked before -- current status is simply the most recent row
-- for a given (gift_source, gift_id).
CREATE TABLE `gift_acknowledgments` (
  `id` text PRIMARY KEY NOT NULL,
  `donor_id` text NOT NULL,
  `user_id` text NOT NULL,
  `gift_source` text NOT NULL CHECK (`gift_source` IN ('giving_activity','gift')),
  `gift_id` text NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('thank_you_sent','thank_you_call','no_acknowledgment_needed')),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `gift_acknowledgments_gift_idx` ON `gift_acknowledgments` (`user_id`,`gift_source`,`gift_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `gift_acknowledgments_donor_idx` ON `gift_acknowledgments` (`donor_id`,`created_at`);
