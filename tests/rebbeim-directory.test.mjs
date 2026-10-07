import assert from "node:assert/strict";
import { normalizeRebbiName, likelyRebbiMatches, findCanonicalRebbi } from "../lib/relationships/rebbeim.ts";
import { CANONICAL_REBBEIM, planRebbeimSeed } from "../scripts/seed-rebbeim-directory.mjs";

// --- Canonical directory ---

// Exactly the approved master list: 43 names (41 original + 2 added
// 2026-10-07: "Harav Sax" and "Harav Yosef Kalman Neuberger").
assert.equal(CANONICAL_REBBEIM.length, 43, "the canonical Rebbeim list must have exactly 43 names");
assert.equal(new Set(CANONICAL_REBBEIM).size, 43, "the canonical list must have no exact-string duplicates");
assert.ok(CANONICAL_REBBEIM.includes("Harav Sax"));
assert.ok(CANONICAL_REBBEIM.includes("Harav Yosef Kalman Neuberger"));

// All 43 remain distinct after normalization -- proves normalizeRebbiName
// does not accidentally collapse genuinely different Rebbeim (e.g. the
// six Neuberger Rebbeim, which share a surname but are six real, distinct
// people -- now seven, with "Harav Yosef Kalman Neuberger" added, who is
// NOT the same person as the already-seeded "Harav Yosef Neuberger").
{
  const normalized = CANONICAL_REBBEIM.map(normalizeRebbiName);
  assert.equal(new Set(normalized).size, 43, "all 43 canonical names must remain distinct after normalization");
  assert.notEqual(normalizeRebbiName("Harav Yosef Neuberger"), normalizeRebbiName("Harav Yosef Kalman Neuberger"), "the middle name must keep these two genuinely different Rebbeim distinct");
}

// --- normalizeRebbiName ---

assert.equal(normalizeRebbiName("Harav Berkowitz"), "berkowitz");
assert.equal(normalizeRebbiName("Rav Berkowitz"), "berkowitz");
assert.equal(normalizeRebbiName("Rabbi Berkowitz"), "berkowitz");
assert.equal(normalizeRebbiName("HARAV BERKOWITZ"), "berkowitz");
assert.equal(normalizeRebbiName("  Harav   Berkowitz  "), "berkowitz", "extra whitespace must be collapsed");
assert.equal(normalizeRebbiName("Harav Naftali Neuberger"), "naftali neuberger");
assert.equal(normalizeRebbiName("Harav Sheftel Neuberger"), "sheftel neuberger", "two different Neuberger Rebbeim must stay distinct after normalization");
assert.notEqual(normalizeRebbiName("Harav Naftali Neuberger"), normalizeRebbiName("Harav Sheftel Neuberger"));

// --- likelyRebbiMatches / findCanonicalRebbi ---

const canonical = CANONICAL_REBBEIM.map((displayName, index) => ({ id: `rebbi-${index}`, displayName, normalizedName: normalizeRebbiName(displayName) }));

{
  const match = findCanonicalRebbi("Rav Berkowitz", canonical);
  assert.ok(match);
  assert.equal(match.displayName, "Harav Berkowitz");
}
assert.equal(findCanonicalRebbi("Harav Someone Nonexistent", canonical), null);

{
  // "Harav Tzvi Berkowitz" is not an exact match for any canonical name,
  // but shares the surname "Berkowitz" with exactly one canonical Rebbi.
  const likely = likelyRebbiMatches("Harav Tzvi Berkowitz", canonical);
  assert.equal(likely.length, 1);
  assert.equal(likely[0].displayName, "Harav Berkowitz");
}
{
  // A bare surname shared by seven real, distinct canonical Neuberger
  // Rebbeim (six original plus "Harav Yosef Kalman Neuberger", added
  // 2026-10-07) must surface ALL of them, never silently resolve to one
  // -- this is exactly what prevents the guard from ever auto-merging an
  // ambiguous fuzzy match.
  const likely = likelyRebbiMatches("Harav Neuberger", canonical);
  assert.equal(likely.length, 7, "all seven Neuberger Rebbeim must be surfaced as candidates, never collapsed to one");
}
{
  // An exact match is never also reported as a "likely" match.
  const likely = likelyRebbiMatches("Harav Berkowitz", canonical);
  assert.equal(likely.length, 0);
}

// --- Seed idempotency (pure planning logic, no network) ---

{
  const plan = planRebbeimSeed([]);
  assert.equal(plan.toInsert.length, 43, "an empty database must plan to insert all 43");
  assert.equal(plan.alreadyPresent.length, 0);
  assert.equal(plan.extra.length, 0);
}
{
  const fullyExisting = CANONICAL_REBBEIM.map((displayName, index) => ({ id: `id-${index}`, display_name: displayName, normalized_name: normalizeRebbiName(displayName) }));
  const plan = planRebbeimSeed(fullyExisting);
  assert.equal(plan.toInsert.length, 0, "re-running the seed against a fully-populated directory must plan zero inserts (idempotent)");
  assert.equal(plan.alreadyPresent.length, 43);
}
{
  // A directory with 42 of the 43 already present plans to insert
  // exactly the one missing name.
  const almostAll = CANONICAL_REBBEIM.slice(0, 42).map((displayName, index) => ({ id: `id-${index}`, display_name: displayName, normalized_name: normalizeRebbiName(displayName) }));
  const plan = planRebbeimSeed(almostAll);
  assert.equal(plan.toInsert.length, 1);
  assert.equal(plan.toInsert[0].displayName, CANONICAL_REBBEIM[42]);
}
{
  // A row that exists but is NOT part of the canonical list is reported
  // as "extra" and never touched/removed by the plan.
  const withExtra = [{ id: "extra-1", display_name: "Harav Someone Else", normalized_name: "someone else" }];
  const plan = planRebbeimSeed(withExtra);
  assert.equal(plan.extra.length, 1);
  assert.equal(plan.extra[0].display_name, "Harav Someone Else");
  assert.equal(plan.toInsert.length, 43, "an unrelated extra row must never reduce the planned insert count");
}

process.stdout.write("Rebbeim directory checks passed.\n");
