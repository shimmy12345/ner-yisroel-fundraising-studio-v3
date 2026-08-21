import assert from "node:assert/strict";
import {
  classifyFactCategory,
  classifyFactLifecycle,
  classifyRelationshipFact,
  hasSubstantiveContentBesidesCommitment,
  isSingularStateCategory,
  CATEGORY_DECAY_WINDOW_DAYS,
  DURABLE_BASELINE_SCORE,
  RELEVANCE_FLOOR,
} from "../lib/relationships/fact-classification.ts";

// Relationship Intelligence Phase 1 -- the deterministic category/
// lifecycle waterfall (lib/relationships/fact-classification.ts). Every
// example given across the three design-pass conversations (the original
// architecture approval, the synthesis design, and the Lifecycle
// Correction) is exercised here directly, plus the passed-away vs.
// singular-state-health-category conflict caught and fixed while writing
// these tests (see PERMANENT_LIFE_EVENT_PATTERN's own doc comment).

async function run() {
  // --- The exact triad from the Lifecycle Correction request: an
  // identity fact, its paired event fact, and its paired follow-up fact,
  // about the SAME family member, same category, three different
  // lifecycles. ---
  assert.deepEqual(classifyRelationshipFact("His daughter is Danielle."), { category: "family_milestone", lifecycle: "durable" });
  assert.deepEqual(classifyRelationshipFact("His daughter Danielle is getting married in November."), { category: "family_milestone", lifecycle: "time_bound" });
  assert.deepEqual(classifyRelationshipFact("Follow up after Danielle's wedding."), { category: "commitment_followup", lifecycle: "follow_up" });

  // --- "Very close with Rabbi Cohen" -- a standing, non-family
  // relationship fact with no dedicated category signal at all, must
  // still default durable (general category, not singular-state). ---
  assert.deepEqual(classifyRelationshipFact("Very close with Rabbi Cohen; mentioned they study together weekly."), { category: "general", lifecycle: "durable" });

  // --- "Planning to be in Israel this Sukkos" -- explicit relative-time
  // signal ("this Sukkos"), engagement category (campus/travel), not
  // family (no family-cluster keyword present). ---
  assert.deepEqual(classifyRelationshipFact("He's planning a trip to Israel this Sukkos and asked about visiting campus."), { category: "engagement", lifecycle: "time_bound" });

  // --- The health contradiction pair: "recovering" (transient-state
  // signal) and its resolution via RELATIONSHIP_CHANGE_PATTERN's "no
  // longer" -- both time_bound, same category, correctly poised to
  // auto-supersede (singular-state category, same lifecycle). ---
  assert.deepEqual(classifyRelationshipFact("She mentioned she's recovering from hip surgery."), { category: "health", lifecycle: "time_bound" });
  assert.deepEqual(classifyRelationshipFact("Confirmed she's no longer recovering and is back to her normal routine."), { category: "health", lifecycle: "time_bound" });

  // --- "His mother passed away" -- durable family context, per explicit
  // instruction, even though "passed away" is itself a HEALTH_FACT_
  // PATTERN term (health is a singular-state category that would
  // otherwise default to time_bound). This is the exact conflict caught
  // while writing this test suite: without PERMANENT_LIFE_EVENT_PATTERN's
  // override, "His mother passed away" would have fallen through to
  // step 4's category-informed default and wrongly come out time_bound.
  // Also confirms it does NOT get caught by TRANSIENT_HEALTH_STATE_
  // PATTERN (a deliberate, disclosed exclusion). ---
  assert.deepEqual(classifyRelationshipFact("His mother passed away."), { category: "health", lifecycle: "durable" });
  assert.doesNotMatch("His mother passed away.", /\b(?:sick|illness|recovering|hospital)\b/i, "sanity check: TRANSIENT_HEALTH_STATE_PATTERN must not itself match \"passed away\"");
  // A death mentioned alongside an explicit month must still stay durable
  // -- PERMANENT_LIFE_EVENT_PATTERN is checked before the relative-time
  // signal precisely to prevent this collision.
  assert.deepEqual(classifyRelationshipFact("His mother passed away in November."), { category: "health", lifecycle: "durable" });
  // A death mentioned alongside a commitment word must still keep a
  // durable LIFECYCLE -- PERMANENT_LIFE_EVENT_PATTERN is checked before
  // COMMITMENT_PATTERN in classifyFactLifecycle specifically for this.
  // CATEGORY, independently, still comes out commitment_followup here
  // (a real commitment -- "promised to send flowers" -- is genuinely
  // present, and classifyFactCategory's own priority order checks
  // COMMITMENT_PATTERN first) -- an honest, disclosed corner case for a
  // single compound sentence carrying two distinct facts at once (an
  // action and a permanent fact), same category of limitation as the
  // bar-mitzvah default-durable case above: this module classifies one
  // sentence as one fact, by design (see docs/AI-HANDOFF.md); a note
  // with two truly separate facts should ideally be written or extracted
  // as two sentences, which specificFacts already does at the sentence-
  // splitting stage upstream.
  assert.deepEqual(classifyRelationshipFact("Promised to send flowers since his mother passed away."), { category: "commitment_followup", lifecycle: "durable" });

  // --- Solicitation, category-informed default: no explicit date/
  // change/commitment signal, but the category itself (singular-state)
  // means the default is time_bound, not durable -- an ask-in-progress
  // must decay like any other point-in-time state. ---
  assert.deepEqual(classifyRelationshipFact("Discussed a $10,000 pledge for the building fund; he wants to think it over."), { category: "solicitation", lifecycle: "time_bound" });
  assert.deepEqual(classifyRelationshipFact("He confirmed the $10,000 building fund gift and asked for a plaque acknowledgment."), { category: "solicitation", lifecycle: "time_bound" });

  // --- Disclosed limitation: a past one-off event with no explicit
  // date/relative-time word defaults to durable (family_milestone, not
  // singular-state) -- the deliberate, safer failure mode, not silently
  // fixed by this test suite. ---
  assert.deepEqual(classifyRelationshipFact("His grandson had his bar mitzvah, a beautiful simcha."), { category: "family_milestone", lifecycle: "durable" });

  // --- Regression: "solicited" is a real SOLICITATION_FACT_TERMS entry
  // (2026-08-21, found via the real Phase 1 backfill preview against
  // Independent Staging -- Klein/Pfeiffer/Rovinsky's text). Category
  // must come out solicitation (not general), and lifecycle must come
  // out time_bound via the singular-state category default (no other
  // signal fires in any of these three real sentences). ---
  assert.deepEqual(classifyRelationshipFact("Solicited for a plaque ($5k)"), { category: "solicitation", lifecycle: "time_bound" });
  assert.deepEqual(classifyRelationshipFact("Solicited for $10k"), { category: "solicitation", lifecycle: "time_bound" });
  assert.deepEqual(classifyRelationshipFact("Solicited for a plaque in memory of his wife ($5k)"), { category: "solicitation", lifecycle: "time_bound" });
  // The literal word "solicit"/"solicitation" is deliberately NOT added
  // -- not observed anywhere in the real corpus, so classification for
  // those forms is unchanged (falls to the category-informed default via
  // whatever other signal, if any, the sentence carries).
  assert.equal(classifyFactCategory("Discussed a possible solicitation next year."), "general", "bare 'solicitation' (not observed in the real corpus) must not be treated as a solicitation-category signal -- only the evidenced 'solicited' is");

  // --- Regression: "this Shabbos" is a real RELATIVE_TIME_PATTERN entry
  // (2026-08-21, found via the same live preview -- Mark Danziger and
  // Sonnenblick's text). Category stays family_milestone (bar mitzvah/
  // grandson/son); lifecycle must now come out time_bound, not the
  // family_milestone category's durable default, since the event is
  // explicitly anchored to a near-term date. ---
  assert.deepEqual(classifyRelationshipFact("called to wish mazel tov on grandson's bar mitzvah this shabbos."), { category: "family_milestone", lifecycle: "time_bound" });
  assert.deepEqual(classifyRelationshipFact("called to wish mazel tov on son's bar mitzvah this shabbos."), { category: "family_milestone", lifecycle: "time_bound" });
  // Case-insensitivity, matching every other RELATIVE_TIME_PATTERN entry.
  assert.equal(classifyFactLifecycle("Coming by this Shabbos to drop off a gift.", "general"), "time_bound");
  // Sanity: without "this"/"next"/"upcoming" immediately before it, bare
  // "Shabbos" must not itself trigger time_bound (matches every other
  // holiday/season entry's own "this/next/upcoming + word" requirement,
  // not a bare mention).
  assert.equal(classifyFactLifecycle("He always looks forward to Shabbos.", "general"), "durable");

  // --- Regression: hasSubstantiveContentBesidesCommitment -- the real
  // Weinschneider case (Kollel donation + a follow-up instruction in one
  // sentence) must be detected as bundling a real substantive fact with
  // an action, so a caller can avoid silently losing the donation
  // context by treating the whole sentence as pure follow_up. ---
  assert.equal(hasSubstantiveContentBesidesCommitment("Discussed Kollel donation and said to follow up after succos."), true);
  // A pure action sentence with no competing substantive signal must NOT
  // be flagged -- "wedding" here is timing context for the follow-up,
  // but is also a real FAMILY_MILESTONE_TERMS word, so this intentionally
  // DOES flag too (see the test file/backfill script's own comment on
  // why this conservative false-positive tradeoff -- flag rather than
  // silently drop -- is deliberate).
  assert.equal(hasSubstantiveContentBesidesCommitment("Follow up after Danielle's wedding."), true, "a commitment sentence that also happens to name a family-milestone word is deliberately flagged too, per the conservative fail-closed tradeoff");
  // A genuinely pure action sentence with no competing signal at all must
  // NOT be flagged.
  assert.equal(hasSubstantiveContentBesidesCommitment("Promised to send the updated schedule."), false);
  // Never flags text that isn't even follow_up-shaped in the first place.
  assert.equal(hasSubstantiveContentBesidesCommitment("His daughter is Danielle."), false);

  // --- Category taxonomy: isSingularStateCategory is exactly {solicitation, health}. ---
  assert.equal(isSingularStateCategory("solicitation"), true);
  assert.equal(isSingularStateCategory("health"), true);
  for (const category of ["family_milestone", "commitment_followup", "engagement", "general"]) {
    assert.equal(isSingularStateCategory(category), false, `${category} must be additive, not singular-state`);
  }

  // --- classifyFactCategory in isolation: program/beneficiary terms
  // (scholarship/student/tuition/education/seminary) fall to general,
  // per the design doc's own explicit non-duplication principle (not a
  // dedicated category, and never a shadow copy of giving_activities). ---
  assert.equal(classifyFactCategory("He's excited his granddaughter got a scholarship for seminary."), "family_milestone", "family-cluster keywords (granddaughter) take priority over the weaker program/beneficiary signal when both are present, per the fixed priority order");
  assert.equal(classifyFactCategory("Discussed the scholarship criteria for next year's applicants."), "general", "a bare program/beneficiary term with no stronger category signal falls to general");

  // --- Decay-window table covers all 6 categories, and the two
  // constants used by synthesis scoring are sane (floor strictly below
  // the durable baseline, so durable facts always clear the floor). ---
  for (const category of ["family_milestone", "solicitation", "health", "commitment_followup", "engagement", "general"]) {
    assert.equal(typeof CATEGORY_DECAY_WINDOW_DAYS[category], "number");
    assert.ok(CATEGORY_DECAY_WINDOW_DAYS[category] > 0);
  }
  assert.ok(RELEVANCE_FLOOR < DURABLE_BASELINE_SCORE, "a durable fact's fixed baseline score must always clear the relevance floor");

  console.log("relationship-fact-classification: ok");
}

await run();
