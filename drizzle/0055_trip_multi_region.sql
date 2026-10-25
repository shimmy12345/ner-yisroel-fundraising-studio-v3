-- Multi-Region Trip Destination (2026-10-26, see docs/AI-HANDOFF.md).
-- STAGING ONLY -- not applied to Production as part of this round, same
-- carve-out as drizzle/0046, 0047, 0050, 0051, 0054.
--
-- The Staging UI test for the prior round's "Find prospects" multi-
-- region filter surfaced a real gap: the TRIP's own "Destination Travel
-- Region" (set on the Create Trip screen, `trips.destination_region_id`)
-- was still a single value -- a trip could only ever be TAGGED with one
-- region, even though prospects from any combination of regions could
-- already be added to it. This migration lets a trip be tagged with any
-- number of destination regions.
--
-- Purely additive: one new table, no existing table's schema changes.
-- `trips.destination_region_id`/`destination_region_label` are left in
-- place, untouched, and simply no longer written or read going forward
-- (lib/relationships/trips-data.ts's createTrip/getTrip/listTrips/
-- updateTrip all move to this new table as the one source of truth) --
-- a column rebuild to remove them was considered and rejected as
-- unnecessary risk for zero functional benefit; every reader of trip
-- region data lives inside this same application, in files this exact
-- round already touches, confirmed by a repo-wide search before writing
-- this migration.
--
-- The backfill below makes every EXISTING trip's own single region (if
-- any) a real row here immediately, so "preserve compatibility with
-- existing trips that have only one region" is true from the moment
-- this migration applies, not just for trips created afterward.
CREATE TABLE `trip_destination_regions` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`region_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- A trip can never be tagged with the same region twice -- enforced
-- here, not just in application code, matching every other "no
-- duplicate membership" guarantee in this schema (e.g.
-- trip_prospects_trip_donor_idx).
CREATE UNIQUE INDEX `trip_destination_regions_trip_region_idx` ON `trip_destination_regions` (`trip_id`,`region_id`);
--> statement-breakpoint
CREATE INDEX `trip_destination_regions_trip_idx` ON `trip_destination_regions` (`trip_id`);
--> statement-breakpoint
-- `id` is deterministic (`backfill-<trip_id>-<region_id>`), not a random
-- UUID -- this INSERT...SELECT runs in plain SQL with no application
-- code (and therefore no crypto.randomUUID()) involved, and the
-- (trip_id, region_id) pair is already guaranteed unique by the index
-- above, so a deterministic id is simpler and exactly as safe as a
-- random one here, with the added benefit of being trivially
-- idempotent if this migration were ever replayed against the same data.
INSERT INTO `trip_destination_regions` (`id`, `trip_id`, `region_id`, `created_at`)
  SELECT 'backfill-' || `id` || '-' || `destination_region_id`, `id`, `destination_region_id`, `created_at`
  FROM `trips` WHERE `destination_region_id` IS NOT NULL;
