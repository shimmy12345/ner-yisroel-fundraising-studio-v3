import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTION_BASELINE_OBJECTS, compareSchemaObjects } from '../lib/data-health/production-baseline.ts';
import { STAGING_BASELINE_OBJECTS } from '../lib/data-health/staging-baseline.ts';

// Regression coverage for the 2026-11-01 "separate Staging/Production
// restore-verify baselines" fix (see docs/AI-HANDOFF.md and this file's
// sibling lib/data-health/staging-baseline.ts for the full history: both
// monthly restore-verify GitHub Actions jobs used to share ONE
// Production-scoped manifest, which made Staging's own job fail every
// month on a real, legitimate, EXPECTED schema difference -- migration
// 0048_google_calendar_sync.sql's tables/columns, live on Staging, never
// on Production). These tests prove three things at once, each one
// independently, so a future change cannot silently break one while
// appearing to fix another:
//   1. Each environment's real schema passes cleanly against ITS OWN
//      baseline (no false failure from the legitimate divergence).
//   2. The two baselines are genuinely doing different jobs, not merely
//      "the check was disabled" -- Staging's real schema still correctly
//      reports differences against the PRODUCTION baseline.
//   3. A genuine, injected schema drift still fails verification against
//      EITHER baseline -- proves accepting legitimate differences did
//      not loosen the comparison itself into accepting real drift too.

test('Production baseline matches itself (no false failure from the split)', () => {
  const result = compareSchemaObjects(PRODUCTION_BASELINE_OBJECTS, PRODUCTION_BASELINE_OBJECTS);
  assert.equal(result.matches, true, result.differences.join(' '));
});

test('Staging baseline matches itself (no false failure from the split)', () => {
  const result = compareSchemaObjects(STAGING_BASELINE_OBJECTS, STAGING_BASELINE_OBJECTS);
  assert.equal(result.matches, true, result.differences.join(' '));
});

test('Staging\'s real schema still reports real differences against the PRODUCTION baseline (the two baselines are not merely a disabled check)', () => {
  const result = compareSchemaObjects(STAGING_BASELINE_OBJECTS, PRODUCTION_BASELINE_OBJECTS);
  assert.equal(result.matches, false);
  assert.ok(result.differences.some((d) => d.includes('calendar_event_links')), 'expected calendar_event_links to surface as a real difference');
  assert.ok(result.differences.some((d) => d.includes('calendar_event_link_history')), 'expected calendar_event_link_history to surface as a real difference');
});

test('Production\'s real schema still reports real differences against the STAGING baseline (symmetry check)', () => {
  const result = compareSchemaObjects(PRODUCTION_BASELINE_OBJECTS, STAGING_BASELINE_OBJECTS);
  assert.equal(result.matches, false);
  assert.ok(result.differences.some((d) => d.includes('Unexpected')) === false, 'Production has nothing STAGING baseline does not already expect to be missing');
});

test('a dropped column still fails verification against the PRODUCTION baseline (legitimate differences do not mask real drift)', () => {
  const live = PRODUCTION_BASELINE_OBJECTS.map((object) => {
    if (object.type === 'table' && object.name === 'donors') {
      return { ...object, sql: object.sql.replace(/,\s*`display_name`\s+text\s+NOT NULL/, '') };
    }
    return object;
  });
  const result = compareSchemaObjects(live, PRODUCTION_BASELINE_OBJECTS);
  assert.equal(result.matches, false);
  assert.ok(result.differences.some((d) => d.includes('donors')), 'expected the mutated donors table definition to be flagged');
});

test('a dropped index still fails verification against the STAGING baseline (legitimate differences do not mask real drift)', () => {
  const live = STAGING_BASELINE_OBJECTS.filter((object) => object.name !== 'calendar_event_links_sync_status_idx');
  const result = compareSchemaObjects(live, STAGING_BASELINE_OBJECTS);
  assert.equal(result.matches, false);
  assert.ok(result.differences.some((d) => d.includes('calendar_event_links_sync_status_idx')), 'expected the removed index to be flagged as missing');
});

// Regression coverage for the 2026-11-01 "Production restore-verify
// run 41328477955" discrepancy: the prior round's manual sync added
// migrations 0054/0055's two NEW tables (trip_destination_regions,
// trip_prospect_commitments) to Production's baseline, but missed that
// migration 0054 ALSO rebuilt an EXISTING table, trip_prospects --
// dropping NOT NULL on donor_id and adding six manual_* columns plus a
// new CHECK constraint. The baseline's trip_prospects entry was left at
// its pre-0054 shape, so every real Production restore-verify run
// failed structural comparison even though Production's actual schema
// was always correct. These two tests prove the baseline now matches
// the real, live, migration-0054-rebuilt shape, and that reverting to
// the old (pre-rebuild) shape is still correctly caught as drift.
test('PRODUCTION baseline\'s trip_prospects reflects migration 0054\'s rebuild (nullable donor_id, manual_* columns, the identity CHECK)', () => {
  const tripProspects = PRODUCTION_BASELINE_OBJECTS.find((object) => object.type === 'table' && object.name === 'trip_prospects');
  assert.ok(tripProspects, 'trip_prospects must be present in the Production baseline');
  assert.match(tripProspects.sql, /`manual_name` text/, 'migration 0054 added manual_name -- must be present post-rebuild');
  assert.doesNotMatch(tripProspects.sql, /`donor_id` text NOT NULL/, 'migration 0054 dropped the NOT NULL on donor_id -- must not still require it');
  assert.match(tripProspects.sql, /CHECK \(`donor_id` IS NOT NULL OR/, 'migration 0054\'s identity CHECK constraint must be present');
});

test('reverting trip_prospects to its PRE-0054 (stale) shape is still caught as real drift, not silently accepted', () => {
  const preRebuildTripProspects = {
    type: 'table', name: 'trip_prospects',
    sql: 'CREATE TABLE `trip_prospects` ( `id` text PRIMARY KEY NOT NULL, `trip_id` text NOT NULL, `donor_id` text NOT NULL, `added_method` text NOT NULL CHECK (`added_method` IN (\'auto_region\',\'manual\')), `status` text NOT NULL DEFAULT \'not_contacted\' CHECK (`status` IN (\'not_contacted\',\'contacted\',\'meeting_requested\',\'meeting_scheduled\',\'meeting_completed\',\'declined\',\'unable_to_schedule\')), `suggested_reason` text, `suggested_score` real, `suggested_generated_at` integer, `manual_rank` integer, `meeting_at` integer, `meeting_location` text, `next_action` text, `trip_notes` text, `linked_interaction_id` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `selected_at` integer, FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`donor_id`) REFERENCES `donors`(`id`) ON UPDATE no action ON DELETE no action, FOREIGN KEY (`linked_interaction_id`) REFERENCES `interactions`(`id`) ON UPDATE no action ON DELETE no action )',
  };
  const live = PRODUCTION_BASELINE_OBJECTS.map((object) => (object.type === 'table' && object.name === 'trip_prospects' ? preRebuildTripProspects : object));
  const result = compareSchemaObjects(live, PRODUCTION_BASELINE_OBJECTS);
  assert.equal(result.matches, false);
  assert.ok(result.differences.some((d) => d.includes('trip_prospects')), 'the real, live, rebuilt trip_prospects must still be flagged as different from a stale baseline');
});

test('an unexpected new table still fails verification against EITHER baseline', () => {
  const injected = { type: 'table', name: 'definitely_not_a_real_table', sql: 'CREATE TABLE `definitely_not_a_real_table` (`id` text PRIMARY KEY NOT NULL)' };
  const prodResult = compareSchemaObjects([...PRODUCTION_BASELINE_OBJECTS, injected], PRODUCTION_BASELINE_OBJECTS);
  assert.equal(prodResult.matches, false);
  assert.ok(prodResult.differences.some((d) => d.includes('Unexpected table: definitely_not_a_real_table')));

  const stagingResult = compareSchemaObjects([...STAGING_BASELINE_OBJECTS, injected], STAGING_BASELINE_OBJECTS);
  assert.equal(stagingResult.matches, false);
  assert.ok(stagingResult.differences.some((d) => d.includes('Unexpected table: definitely_not_a_real_table')));
});
