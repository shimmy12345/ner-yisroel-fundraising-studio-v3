-- Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md's
-- "Trip-Based Meeting Planning" entries for the full Phase 1 audit and the
-- independent-review refinements this schema incorporates). Two new,
-- additive tables; no existing table's schema changes.
--
-- `destination_region_id` is a TravelRegionId STRING (lib/relationships/
-- travel-regions.ts), never a FK -- regions are a code-defined list, not a
-- database table, by design (see that file's own header comment). This
-- table does not and must not reference a "regions" table that does not
-- exist. `destination_region_label` snapshots the region's display label
-- at creation time, so a trip's own history is never affected if a region
-- is later renamed or removed in code.
--
-- MVP supports exactly one primary destination region per trip
-- (independent-review decision, docs/AI-HANDOFF.md) -- donors outside it
-- are added to trip_prospects manually (added_method = 'manual').
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`destination_region_id` text,
	`destination_region_label` text,
	`start_date` integer NOT NULL,
	`end_date` integer NOT NULL,
	`fundraising_goal_cents` integer,
	`notes` text,
	`status` text NOT NULL DEFAULT 'planning' CHECK (`status` IN ('planning','active','completed','cancelled')),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trips_owner_status_idx` ON `trips` (`owner_user_id`,`status`);
--> statement-breakpoint
-- One row per donor being tracked for a trip -- UNIQUE(trip_id, donor_id)
-- below makes a donor appearing twice on the same trip structurally
-- impossible, not merely application-checked.
--
-- `suggested_reason`/`suggested_score`/`suggested_generated_at` are a
-- SNAPSHOT captured once, only when the prospect is added with
-- added_method='auto_region' -- the exact winning DonorRecommendation
-- (lib/relationships/recommendation-rank.ts) computed via the real,
-- unmodified loadMeetingBrief()/buildRecommendationEvidence()/
-- generateCandidates() pipeline at that moment, never a separate
-- trip-specific scoring system and never silently rewritten later if the
-- donor's underlying CRM evidence changes -- the independent review's
-- explicit "label the generation date, display current status
-- separately" requirement. `suggested_score` and `suggested_reason` are
-- both nullable: a donor with no actionable evidence at all is still a
-- legitimate prospect (being in the destination region is itself the
-- reason), and must show a neutral "no specific evidence on file" state
-- rather than a manufactured score or urgency.
--
-- `manual_rank` is an optional fundraiser override of DISPLAY order only
-- -- it never overwrites `suggested_score`, matching the explicit "do not
-- invent a separate trip-prioritization scoring system" instruction.
--
-- `linked_interaction_id` is set only once a real `interactions` row has
-- been written for this prospect's meeting (scheduled or completed) --
-- see lib/relationships/trips.ts's interaction source-string builders,
-- which keep that interaction entirely within the EXISTING, unmodified
-- lib/workspace/scheduled-activity.ts status-derivation conventions
-- (`capture-scheduled:`/`capture-completed:` source prefixes). This is
-- what lets a completed trip meeting automatically count as real contact
-- for every other CRM surface (Today, Portfolio Focus, future trips)
-- without a second, parallel meeting-history system.
CREATE TABLE `trip_prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`donor_id` text NOT NULL,
	`added_method` text NOT NULL CHECK (`added_method` IN ('auto_region','manual')),
	`status` text NOT NULL DEFAULT 'not_contacted' CHECK (`status` IN ('not_contacted','contacted','meeting_requested','meeting_scheduled','meeting_completed','declined','unable_to_schedule')),
	`suggested_reason` text,
	`suggested_score` real,
	`suggested_generated_at` integer,
	`manual_rank` integer,
	`meeting_at` integer,
	`meeting_location` text,
	`next_action` text,
	`trip_notes` text,
	`linked_interaction_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_prospects_trip_donor_idx` ON `trip_prospects` (`trip_id`,`donor_id`);
--> statement-breakpoint
-- Cross-trip conflict detection ("does this donor already have a meeting
-- requested/scheduled on a different trip") and "does this donor appear
-- on any other trip" both filter by donor_id across all trips -- this
-- index is what keeps that a real index scan, not a full table scan, as
-- the number of trips grows.
CREATE INDEX `trip_prospects_donor_idx` ON `trip_prospects` (`donor_id`);
