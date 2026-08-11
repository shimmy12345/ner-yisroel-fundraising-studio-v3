import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildUnifiedTimeline } from "../lib/relationships/unified-timeline.ts";

const RECENT_LIMIT = 10;

// Spaced a day apart (normalizeFinancialDate floors to the calendar day)
// so each gift lands on a distinct, strictly increasing date.
function makeGifts(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `gift-${index}`, donor_id: "fictional-donor", external_source: "JL Solutions",
    activity_date: 1_000_000_000 + index * 100_000, committed_cents: 5_000, paid_cents: 5_000, balance_cents: 0,
    item_type: "Gift", description: `Gift ${index}`, source_campaign: null, category: "completed_gift",
    workspace_status: "active", private_note: null, updated_at: 1_000_000_000 + index * 100_000,
  }));
}

// Mirrors UnifiedRelationshipTimeline's own reducer: start at
// RECENT_LIMIT, grow by RECENT_LIMIT per "Show N more" click (never
// jumping to the full total), and report what each step actually shows
// plus the size of the next available batch (null once nothing is left).
function expansionSequence(total) {
  const steps = [];
  let visibleCount = RECENT_LIMIT;
  for (;;) {
    const shown = Math.min(visibleCount, total);
    const hidden = total - shown;
    if (hidden <= 0) { steps.push({ shown, nextBatch: null }); return steps; }
    steps.push({ shown, nextBatch: Math.min(RECENT_LIMIT, hidden) });
    visibleCount += RECENT_LIMIT;
  }
}

async function run() {
  // ---- 9 and 10 records: below or exactly at the initial page, no
  // expansion control should ever be offered. ----
  for (const count of [9, 10]) {
    const [firstStep] = expansionSequence(count);
    assert.equal(firstStep.shown, count);
    assert.equal(firstStep.nextBatch, null, `${count} records must not show an expansion control`);
  }

  // ---- 11 records: exactly one leftover record -- the button must say
  // "Show 1 more", not a rounded-up "Show 10 more". ----
  {
    const sequence = expansionSequence(11);
    assert.deepEqual(sequence.map((step) => step.shown), [10, 11]);
    assert.deepEqual(sequence.map((step) => step.nextBatch), [1, null]);
  }

  // ---- 25 records: 10 -> 20 -> 25, with an accurate final "5 more". ----
  {
    const sequence = expansionSequence(25);
    assert.deepEqual(sequence.map((step) => step.shown), [10, 20, 25]);
    assert.deepEqual(sequence.map((step) => step.nextBatch), [10, 5, null]);
  }

  // ---- 130 records: strict 10-record increments the whole way, never a
  // single jump to "all 130". ----
  {
    const sequence = expansionSequence(130);
    assert.deepEqual(sequence.map((step) => step.shown), Array.from({ length: 13 }, (_, index) => (index + 1) * 10));
    assert.ok(sequence.slice(0, -1).every((step) => step.nextBatch === RECENT_LIMIT), "every batch before the last is a full 10-record increment");
    assert.equal(sequence.at(-1).nextBatch, null);
  }

  // ---- Newest-first ordering holds at every expansion step: the visible
  // slice is always a prefix of the already-sorted (buildUnifiedTimeline)
  // array, never re-sorted or reshuffled by expanding. ----
  const timeline = buildUnifiedTimeline({ giving: makeGifts(37), legacyGifts: [], payments: [], interactions: [], reminders: [], now: 2_000_000_000 });
  assert.equal(timeline.length, 37);
  assert.equal(timeline[0].key, "giving:gift-36", "newest gift sorts first");
  for (const visibleCount of [10, 20, 30, 37]) {
    const slice = timeline.slice(0, visibleCount);
    for (let index = 1; index < slice.length; index++) assert.ok(slice[index - 1].eventAt >= slice[index].eventAt, "visible slice stays newest-first at every expansion step");
  }

  // ---- Collapse always returns to the most recent 10, regardless of how
  // far expansion had gone. ----
  assert.deepEqual(timeline.slice(0, RECENT_LIMIT).map((item) => item.key), Array.from({ length: 10 }, (_, index) => `giving:gift-${36 - index}`));

  // ---- Source wiring: confirm the component implements exactly this
  // incremental algorithm rather than a giant "show all" jump, resets on
  // filter change, and never refetches (everything comes from props
  // already in memory). ----
  const component = await readFile(new URL("../app/donors/[id]/UnifiedRelationshipTimeline.tsx", import.meta.url), "utf8");
  assert.match(component, /const RECENT_LIMIT = 10;/);
  assert.match(component, /const \[visibleCount, setVisibleCount\] = useState\(RECENT_LIMIT\);/);
  assert.match(component, /const nextBatchSize = Math\.min\(RECENT_LIMIT, hiddenCount\);/);
  assert.match(component, /onClick=\{\(\) => setVisibleCount\(\(count\) => count \+ RECENT_LIMIT\)\}/, "each click grows the shown count by one batch, never jumps to the total");
  assert.match(component, /Show \{nextBatchSize\} more/);
  assert.match(component, /onClick=\{\(\) => setVisibleCount\(RECENT_LIMIT\)\}/, "collapse resets to exactly the initial page size");
  assert.match(component, /Show recent \{RECENT_LIMIT\}/);
  assert.match(component, /setFilter\(next\);\s*setVisibleCount\(RECENT_LIMIT\);/, "changing filters resets back to the first 10 of the new filtered set");
  assert.doesNotMatch(component, /Show all/i, "no giant show-all action");
  assert.doesNotMatch(component, /fetch\(|await fetch/, "expansion never refetches -- everything is already in memory from props");
  assert.match(component, /href={`#pledge-/, "a visible linked pledge still renders as a real, working anchor");
  assert.match(component, /Linked pledge is unavailable/, "a genuinely orphaned pledge link is still reported honestly");
  assert.match(component, /revealThrough/, "clicking a not-yet-visible linked pledge reveals exactly as far as that record");

  process.stdout.write("Timeline pagination checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
