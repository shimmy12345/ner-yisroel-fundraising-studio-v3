-- Trip Planning -- Deliberate Prospect Selection (2026-10-18, see
-- docs/AI-HANDOFF.md). Purely additive: one new nullable column on the
-- existing `trip_prospects` table, plus a supporting index, plus two
-- backfill UPDATEs for rows that already existed when this migration
-- runs. No existing row is deleted or recreated; no other column's
-- meaning changes.
--
-- `selected_at` records the moment a trip_prospects row became a
-- deliberate outreach target. "My trip prospects"
-- (app/travel-planning/[id]/TripDashboardExperience.tsx) shows only rows
-- WHERE selected_at IS NOT NULL -- a row with selected_at IS NULL is a
-- CANDIDATE only, never treated as something the owner is actively
-- planning to contact.
--
-- Going forward (lib/relationships/trips-data.ts's createTrip()), a
-- region match no longer inserts a trip_prospects row at all -- regional
-- donors are surfaced live, read-only, in "Find prospects", and a row is
-- only ever created (with selected_at set immediately) via the explicit
-- "Add to trip" action (selectTripProspect()). This migration's own job
-- is just the backfill below, for every row inserted by the OLD
-- behavior before this change shipped.
ALTER TABLE `trip_prospects` ADD COLUMN `selected_at` integer;
--> statement-breakpoint
CREATE INDEX `trip_prospects_trip_selected_idx` ON `trip_prospects` (`trip_id`,`selected_at`);
--> statement-breakpoint
-- `added_method = 'manual'` was always a deliberate, one-at-a-time
-- fundraiser action under the OLD code too (the existing "Add a donor
-- manually" search, or the old "New prospects available" panel's own Add
-- button) -- every such row is selected as of its own creation.
UPDATE `trip_prospects` SET `selected_at` = `created_at` WHERE `added_method` = 'manual';
--> statement-breakpoint
-- A legacy auto-inserted row (added_method='auto_region', from the OLD
-- "every regional donor is auto-added" behavior) that the owner has
-- since visibly acted on -- changed its status away from the default,
-- scheduled or completed a real meeting, added trip notes or a next
-- action, set a manual priority rank, or had real giving attributed to
-- it on this trip -- carries unambiguous evidence of deliberate
-- attention, so it is treated as already selected rather than stranded
-- in "Find prospects" once the owner has plainly already been working
-- with it. `updated_at` is the closest real timestamp to when that
-- action happened -- never `created_at`, which would misrepresent a row
-- the owner touched well after trip creation as "selected" at creation
-- time.
--
-- Every OTHER auto_region row (no visible edit of any kind) keeps
-- selected_at NULL -- the owner's own explicit "do not assume every
-- auto_region + not_contacted row is disposable or unwanted" / "do not
-- silently classify ambiguous rows" instruction. Nothing about such a
-- row is touched, hidden, or removed; it simply remains a candidate,
-- surfaced in "Find prospects" (already in trip_prospects, so selecting
-- it there reuses this exact row rather than inserting a second one)
-- until the owner explicitly picks it.
UPDATE `trip_prospects` SET `selected_at` = `updated_at`
  WHERE `added_method` = 'auto_region' AND `selected_at` IS NULL AND (
    `status` != 'not_contacted'
    OR `trip_notes` IS NOT NULL
    OR `next_action` IS NOT NULL
    OR `manual_rank` IS NOT NULL
    OR `meeting_at` IS NOT NULL
    OR `linked_interaction_id` IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM `trip_financial_attributions` tfa
      WHERE tfa.`trip_id` = `trip_prospects`.`trip_id`
        AND tfa.`donor_id` = `trip_prospects`.`donor_id`
        AND tfa.`removed_at` IS NULL
    )
  );
