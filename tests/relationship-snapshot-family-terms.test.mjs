import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { actionableRelationshipSnapshot, relationshipSnapshotDetails } from "../lib/capture/interaction.ts";

// Regression for the confirmed extraction gap (2026-08-20, donor 987 vs
// 67909 -- see docs/AI-HANDOFF.md): FACT_SIGNAL_PATTERN matched \bson\b but
// that never fires inside "grandson" (no word boundary before "son" when
// preceded by "grand"), so a note about a donor's grandchild's milestone
// silently produced zero relationship-snapshot facts -- and, because
// app/api/interactions/route.ts gates institutional_memory on the same
// acceptRelationshipSnapshot flag as relationship_summary, silently lost
// institutional-memory capture too. This file exercises the real,
// unmodified extraction functions directly (not a source-text regex check)
// so it fails if the fix regresses or is reverted.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function expectFacts(note, label) {
  const details = relationshipSnapshotDetails(note, "call");
  const snapshot = actionableRelationshipSnapshot(note, "call");
  assert.ok(details.specificFacts.length > 0, `${label}: expected at least one extracted fact from "${note}"`);
  assert.notEqual(snapshot, null, `${label}: expected a non-null relationship snapshot from "${note}"`);
}

function expectNoFacts(note, label) {
  const details = relationshipSnapshotDetails(note, "call");
  assert.deepEqual(details.specificFacts, [], `${label}: "${note}" must not be treated as containing a family-relevance fact`);
}

async function run() {
  // ---- grandson / grandsons ----
  expectFacts("called to wish mazel tov on grandson's bar mitzvah this shabbos", "grandson (singular)");
  expectFacts("both grandsons are graduating this year", "grandsons (plural)");

  // ---- granddaughter / granddaughters ----
  expectFacts("called to wish mazel tov on granddaughter's bas mitzvah", "granddaughter (singular)");
  expectFacts("her granddaughters are visiting for the holidays", "granddaughters (plural)");

  // ---- grandchild / grandchildren ----
  expectFacts("mentioned a new grandchild was born last week", "grandchild (singular)");
  expectFacts("all the grandchildren came for the simcha", "grandchildren (plural)");

  // ---- grandparent / grandmother / grandfather ----
  expectFacts("she is now a grandparent for the first time", "grandparent (singular)");
  expectFacts("both grandparents attended the dinner", "grandparents (plural)");
  expectFacts("spoke fondly of her grandmother's influence", "grandmother (singular)");
  expectFacts("the grandfather made the introduction", "grandfather (singular)");

  // ---- existing son/daughter behavior unchanged ----
  expectFacts("called to wish mazel tov on son's bar mitzvah this shabbos", "son (unchanged)");
  expectFacts("her daughter just got engaged", "daughter (unchanged)");

  // ---- unrelated words containing "son" must not become false positives ----
  expectNoFacts("Left a voicemail for Johnson about next quarter", "Johnson (surname)");
  expectNoFacts("Discussed the reasons for the delay in person", "reasons/person (unrelated words)");
  expectNoFacts("Called about the upcoming season of events", "season (unrelated word)");

  // ---- explicit acceptance is still required before any write ----
  // (structural check on the actual write route, matching this repo's
  // existing convention of asserting source-code guards directly)
  const interactionRoute = await read("app/api/interactions/route.ts");
  assert.match(
    interactionRoute,
    /if \(!scheduled && body\.acceptRelationshipSnapshot === true\) \{/,
    "relationship_summary/institutional_memory must still only be written when the caller explicitly sent acceptRelationshipSnapshot: true -- a fixed extraction pattern must never make this write unconditional",
  );
  assert.match(
    interactionRoute,
    /UPDATE donors SET relationship_summary = \?, institutional_memory = \?, relationship_health = \?, updated_at = \?/,
    "the accept-gated write must still update both relationship_summary and institutional_memory together, not just one field",
  );

  console.log("relationship-snapshot-family-terms: ok");
}

await run();
