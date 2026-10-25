-- Trip Planner -- Multi-Region Prospect Selection + Manually Added
-- Prospects (2026-10-25, see docs/AI-HANDOFF.md). STAGING ONLY -- not
-- applied to Production as part of this round, same carve-out as
-- drizzle/0046, 0047, 0050, and 0051.
--
-- Multi-region prospect selection needs NO schema change at all: a
-- trip_prospects row has never been restricted to the trip's own
-- destination_region_id -- selectTripProspect() (lib/relationships/
-- trips-data.ts) already accepts any live, owned donor regardless of
-- region, and `added_method` only ever LABELS whether the donor matched
-- the destination region at the moment they were added, never gates
-- which donors can be added. The only change that feature needs is a
-- client-side, multi-select region filter in "Find prospects" (see
-- lib/relationships/donor-geo-filter.ts's new matchesAnyRegionFilter /
-- filterByGeoRegions) -- this migration is entirely about the SECOND
-- feature, manually added (not-yet-in-FOS) prospects.
--
-- `trip_prospects.donor_id` was NOT NULL (drizzle/0045) -- a trip
-- prospect could only ever be a real, existing donor row. SQLite has no
-- ALTER TABLE ... ALTER COLUMN to drop a NOT NULL constraint, so this
-- rebuilds the table (same convention as drizzle/0029's important_dates
-- rebuild and drizzle/0031's shared_activities rebuild) with donor_id
-- made nullable, plus six new nullable columns holding a manually
-- entered prospect's own identity/contact details when donor_id is
-- NULL. Every existing row's data, id, and column values are copied
-- across byte-for-byte unchanged; no row is deleted or recreated by
-- identity, only the table's own DDL changes.
--
-- A trip_prospects row is "linked" (donor_id IS NOT NULL, exactly as
-- before -- an ordinary FOS donor, selected via "Find prospects") or
-- "unlinked" (donor_id IS NULL -- added via the new "Add a prospect
-- manually" action, identified only by the manual_* columns below).
-- `donor_id` is the one and only switch between these two states --
-- linking or converting an unlinked prospect (lib/relationships/
-- trips-data.ts's linkProspectToDonor/convertProspectToNewDonor) simply
-- UPDATEs donor_id on this SAME row, preserving its id, status, trip
-- notes, next action, meeting/interaction history, and manual_rank
-- untouched -- never a delete-and-recreate. The manual_* columns are
-- left in place after linking, as a harmless historical record of how
-- the prospect was originally entered; nothing reads them once donor_id
-- is set.
--
-- The existing CHECK constraint on `added_method` ('auto_region' |
-- 'manual') is unchanged and still applies to BOTH linked and unlinked
-- rows -- a manually added, not-yet-in-FOS prospect is `added_method =
-- 'manual'` for the exact same reason an out-of-region donor search
-- result is: neither was auto-matched to the trip's destination region.
--
-- The existing UNIQUE index `trip_prospects_trip_donor_idx` ON
-- (trip_id, donor_id) is left completely alone -- standard SQL NULL
-- semantics (confirmed against SQLite's own documented UNIQUE-index
-- behavior) mean a NULL never collides with another NULL, so any number
-- of unlinked rows can coexist on one trip without touching this index
-- at all; duplicate-FOS-donor prevention for LINKED rows is exactly as
-- strict as it always was.
--
-- The new CHECK constraint below is the one new structural guarantee:
-- every row is either linked (donor_id set) or carries a real manual
-- name (donor_id NULL, manual_name non-blank) -- never a row with
-- neither, which would have no identity at all.
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_trip_prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`donor_id` text,
	`manual_name` text,
	`manual_city` text,
	`manual_region_id` text,
	`manual_phone` text,
	`manual_email` text,
	`manual_notes` text,
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
	`selected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (`donor_id` IS NOT NULL OR (`manual_name` IS NOT NULL AND trim(`manual_name`) != '')),
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`linked_interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_trip_prospects` (`id`,`trip_id`,`donor_id`,`added_method`,`status`,`suggested_reason`,`suggested_score`,`suggested_generated_at`,`manual_rank`,`meeting_at`,`meeting_location`,`next_action`,`trip_notes`,`linked_interaction_id`,`selected_at`,`created_at`,`updated_at`)
  SELECT `id`,`trip_id`,`donor_id`,`added_method`,`status`,`suggested_reason`,`suggested_score`,`suggested_generated_at`,`manual_rank`,`meeting_at`,`meeting_location`,`next_action`,`trip_notes`,`linked_interaction_id`,`selected_at`,`created_at`,`updated_at` FROM `trip_prospects`;
--> statement-breakpoint
DROP TABLE `trip_prospects`;
--> statement-breakpoint
ALTER TABLE `__new_trip_prospects` RENAME TO `trip_prospects`;
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_prospects_trip_donor_idx` ON `trip_prospects` (`trip_id`,`donor_id`);
--> statement-breakpoint
CREATE INDEX `trip_prospects_donor_idx` ON `trip_prospects` (`donor_id`);
--> statement-breakpoint
CREATE INDEX `trip_prospects_trip_selected_idx` ON `trip_prospects` (`trip_id`,`selected_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
-- Unlinked-Prospect Fundraising (same round). A deliberately thin,
-- append-only ledger for a pledge/donation recorded against an unlinked
-- (not-yet-in-FOS) prospect -- the one case trip_financial_attributions
-- structurally cannot represent, since every row there requires a real
-- `donor_id` and a real `giving_activities` row, and this feature's own
-- explicit "do not automatically create donor accounts or modify
-- official donor financial records until the normal import or
-- reconciliation process confirms the transactions" instruction means
-- NO giving_activities row is ever written for an unlinked prospect.
-- This table stores the actual figures itself (unlike
-- trip_financial_attributions' pure link-only design) for exactly that
-- reason -- there is no real financial record anywhere else for it to
-- point at yet.
--
-- `category`/`committed_cents`/`activity_date`/`designation`/`note`
-- mirror giving_activities' own pending_gift/pending_pledge shape
-- (lib/giving/pending-records.ts) so the EXACT same amount/date
-- validation and the EXACT same "Record a new donation/pledge" UI and
-- summarization logic (lib/relationships/trip-financial-attribution.ts's
-- summarizeTripFinancials, which reads only plain fields already on its
-- input records and has no idea whether a record came from this table
-- or a real giving_activities join) apply unchanged -- "using the
-- existing trip fundraising workflow," literally.
--
-- `donor_confirmed_at` is the same "the prospect themselves confirmed
-- this" signal trip_financial_attributions already uses -- it counts
-- toward trip totals immediately once confirmed, before any FOS donor
-- account exists, with the UI labeling it accordingly rather than
-- "Awaiting JL" (which implies a donor record that does not exist yet).
--
-- `migrated_giving_activity_id`/`migrated_attribution_id`/`migrated_at`
-- are set together, once, the moment this prospect is linked to an
-- existing donor or converted into a new one (lib/relationships/
-- trips-data.ts's migrateProspectCommitments): a real giving_activities
-- row and a real trip_financial_attributions row are created for the
-- now-known donor (preserving this row's own category/amount/date/
-- designation/note/donor_confirmed_at exactly), and this row is marked
-- migrated so it is excluded from every future total -- the real
-- attribution now represents that exact dollar amount instead,
-- preventing double counting by construction (every total-producing
-- query filters WHERE migrated_at IS NULL). This row is never deleted
-- even after migrating -- it stays as the permanent record of how this
-- commitment originated, the same append-only convention
-- trip_financial_attributions itself already follows.
CREATE TABLE `trip_prospect_commitments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`prospect_id` text NOT NULL,
	`category` text NOT NULL CHECK (`category` IN ('pending_gift','pending_pledge')),
	`committed_cents` integer NOT NULL,
	`activity_date` integer,
	`designation` text,
	`note` text,
	`donor_confirmed_at` integer,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	`removed_reason` text,
	`migrated_giving_activity_id` text,
	`migrated_attribution_id` text,
	`migrated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prospect_id`) REFERENCES `trip_prospects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`migrated_giving_activity_id`) REFERENCES `giving_activities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`migrated_attribution_id`) REFERENCES `trip_financial_attributions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trip_prospect_commitments_trip_idx` ON `trip_prospect_commitments` (`trip_id`, `removed_at`, `migrated_at`);
--> statement-breakpoint
CREATE INDEX `trip_prospect_commitments_prospect_idx` ON `trip_prospect_commitments` (`prospect_id`);
