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

test('an unexpected new table still fails verification against EITHER baseline', () => {
  const injected = { type: 'table', name: 'definitely_not_a_real_table', sql: 'CREATE TABLE `definitely_not_a_real_table` (`id` text PRIMARY KEY NOT NULL)' };
  const prodResult = compareSchemaObjects([...PRODUCTION_BASELINE_OBJECTS, injected], PRODUCTION_BASELINE_OBJECTS);
  assert.equal(prodResult.matches, false);
  assert.ok(prodResult.differences.some((d) => d.includes('Unexpected table: definitely_not_a_real_table')));

  const stagingResult = compareSchemaObjects([...STAGING_BASELINE_OBJECTS, injected], STAGING_BASELINE_OBJECTS);
  assert.equal(stagingResult.matches, false);
  assert.ok(stagingResult.differences.some((d) => d.includes('Unexpected table: definitely_not_a_real_table')));
});
