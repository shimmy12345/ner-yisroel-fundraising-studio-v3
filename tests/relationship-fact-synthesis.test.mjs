import assert from "node:assert/strict";
import { synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";

// Relationship Intelligence Phase 2 -- the deterministic synthesis
// function (lib/relationships/fact-synthesis.ts). Pure, no D1, directly
// unit-testable. "now" is a fixed, arbitrary epoch second; every fact's
// age is expressed relative to it in days for readability.

const NOW = 1787000000; // fixed "now"
const DAY = 86400;
const daysAgo = (days) => NOW - days * DAY;

function fact(overrides) {
  return {
    factText: "Fact text.",
    category: "general",
    lifecycle: "durable",
    status: "current",
    sourceInteractionId: null,
    sourceInteractionOccurredAt: NOW,
    ...overrides,
  };
}

async function run() {
  // --- 1: accepting fact B after fact A (different, additive
  // categories) leaves BOTH durable and synthesizes both, most-recent
  // first -- never replacing A. Direct proof of the governing
  // "accumulate, don't erase" principle at the synthesis layer. ---
  {
    const a = fact({ factText: "His daughter is Danielle.", category: "family_milestone", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(10) });
    const b = fact({ factText: "Very close with Rabbi Cohen.", category: "general", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(1) });
    const result = synthesizeRelationshipSnapshot([a, b], NOW);
    assert.equal(result.relationshipSummary, "Very close with Rabbi Cohen. His daughter is Danielle.", "both durable facts must appear, most-recent first, neither replacing the other");
    assert.equal(result.institutionalMemory, result.relationshipSummary, "with only 2 current facts, both surfaces show the same content");
  }

  // --- 2: rejecting a proposed fact -- simply never call this function
  // with the rejected text at all (the write path's own job); proven at
  // the route-wiring level in tests/relationship-fact-accept-wiring.
  // test.mjs. At the synthesis layer, the direct analogue is: a fact
  // that was never added does not appear, and the existing set's own
  // synthesis is completely unaffected by what didn't happen. ---
  {
    const a = fact({ factText: "His daughter is Danielle.", sourceInteractionOccurredAt: daysAgo(1) });
    const before = synthesizeRelationshipSnapshot([a], NOW);
    const stillBefore = synthesizeRelationshipSnapshot([a], NOW); // no new fact added -- "rejection" means this, not a second call with new content
    assert.deepEqual(before, stillBefore);
  }

  // --- 3: durable + time-bound facts rank according to the approved
  // model -- a fresh time_bound fact (score near 1.0) outranks a durable
  // fact (fixed 0.3), which outranks a decayed time_bound fact (score
  // 0), for the terse top-2 relationship_summary cut; institutional_
  // memory's fuller, floor-qualifying list still excludes the fully
  // decayed one. Reproduces the exact real Zachter-corpus-derived worked
  // example from docs/AI-HANDOFF.md's synthesis design. ---
  {
    const freshTimeBound = fact({ factText: "Fresh time-bound fact.", category: "engagement", lifecycle: "time_bound", sourceInteractionOccurredAt: daysAgo(10) }); // engagement window 120 -> score ~0.92
    const durableFact = fact({ factText: "Durable fact.", category: "general", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(1000) }); // age irrelevant, score 0.3
    const decayedTimeBound = fact({ factText: "Decayed time-bound fact.", category: "engagement", lifecycle: "time_bound", sourceInteractionOccurredAt: daysAgo(365) }); // far past 120-day window -> score 0
    const result = synthesizeRelationshipSnapshot([freshTimeBound, durableFact, decayedTimeBound], NOW);
    assert.equal(result.relationshipSummary, "Fresh time-bound fact. Durable fact.", "fresh time_bound must outrank durable, which must outrank fully-decayed time_bound, in the top-2 cut");
    assert.doesNotMatch(result.institutionalMemory, /Decayed time-bound fact/, "a fully-decayed time_bound fact (score 0) must not clear the relevance floor even in the fuller institutional_memory list");
  }

  // --- 4: follow_up facts NEVER enter Snapshot prose, regardless of age
  // or how "fresh" they might otherwise seem. ---
  {
    const followUp = fact({ factText: "Promised to send the schedule.", category: "commitment_followup", lifecycle: "follow_up", sourceInteractionOccurredAt: daysAgo(0) });
    const durableFact = fact({ factText: "His daughter is Danielle.", sourceInteractionOccurredAt: daysAgo(1000) });
    const result = synthesizeRelationshipSnapshot([followUp, durableFact], NOW);
    assert.doesNotMatch(result.relationshipSummary, /schedule/i);
    assert.doesNotMatch(result.institutionalMemory, /schedule/i);
    assert.equal(result.relationshipSummary, "His daughter is Danielle.");
  }
  // A donor whose ONLY current fact is follow_up must show a blank
  // Snapshot, not a fallback to the follow_up text (the "never blank
  // while any accepted fact exists" fallback applies to non-follow_up
  // facts only -- follow_up is structurally excluded, not just
  // deprioritized).
  {
    const onlyFollowUp = fact({ factText: "Promised to send the schedule.", category: "commitment_followup", lifecycle: "follow_up" });
    const result = synthesizeRelationshipSnapshot([onlyFollowUp], NOW);
    assert.equal(result.relationshipSummary, null);
    assert.equal(result.institutionalMemory, null);
  }

  // --- 5: superseded/archived_with_source facts disappear from current
  // synthesis without being deleted (deletion is out of scope for this
  // pure function entirely -- it only ever reads the `status` field it's
  // given; the "not deleted" half of this guarantee is proven at the D1
  // layer by tests/relationship-facts-schema.test.mjs and the live
  // Phase 1 verification already on record). ---
  {
    const superseded = fact({ factText: "Old, superseded fact.", status: "superseded", sourceInteractionOccurredAt: daysAgo(1) });
    const archived = fact({ factText: "Archived-with-source fact.", status: "archived_with_source", sourceInteractionOccurredAt: daysAgo(1) });
    const current = fact({ factText: "Current fact.", sourceInteractionOccurredAt: daysAgo(1) });
    const result = synthesizeRelationshipSnapshot([superseded, archived, current], NOW);
    assert.equal(result.relationshipSummary, "Current fact.");
    assert.doesNotMatch(result.institutionalMemory, /superseded|Archived-with-source/i);
  }

  // --- 6: structured Ask influence -- ONLY the narrow, sanctioned
  // pinned-freshness channel, never anything else. A solicitation fact
  // linked to a still-pending ask (via sourceInteractionId) is pinned to
  // score 1.0 regardless of age; once unpinned, it decays normally. No
  // ask amount/purpose text ever appears in the synthesized output (this
  // function never even receives that data -- proving structural
  // non-duplication by construction, not just by convention). ---
  {
    const oldPinnedSolicitation = fact({ factText: "Discussed a gift.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-1", sourceInteractionOccurredAt: daysAgo(500) }); // far past the 90-day window
    const result = synthesizeRelationshipSnapshot([oldPinnedSolicitation], NOW, new Set(["int-1"]));
    assert.equal(result.relationshipSummary, "Discussed a gift.", "a pinned solicitation fact must stay at full freshness (score 1.0) regardless of age");
  }
  {
    // A second, unrelated durable fact is included so the decayed
    // solicitation fact's exclusion is proven by real competition, not
    // by accidentally tripping the separate "never blank when it's the
    // only fact on file" fallback (which would otherwise still surface
    // it despite a score of 0).
    const sameFactUnpinned = fact({ factText: "Discussed a gift.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-1", sourceInteractionOccurredAt: daysAgo(500) });
    const otherDurable = fact({ factText: "Very close with Rabbi Cohen.", category: "general", lifecycle: "durable" });
    const result = synthesizeRelationshipSnapshot([sameFactUnpinned, otherDurable], NOW, new Set()); // no pending ask this time
    assert.equal(result.relationshipSummary, "Very close with Rabbi Cohen.", "without the pin, the same fact at 500 days into a 90-day window must be fully decayed and excluded once a real competing fact exists");
  }

  // --- 7: source-interaction provenance -- this function is provenance-
  // AGNOSTIC by design (it only ever consumes sourceInteractionOccurredAt
  // for decay math and sourceInteractionId only for the ask-pin check);
  // it never inspects or requires a real interaction to exist. Full
  // provenance correctness (the right id/date actually being stored) is
  // proven at the D1/route-wiring layer, not here -- this test only
  // confirms the synthesis function treats a null sourceInteractionId
  // (a Phase 1 backfilled fact, like Zachter's real one) identically to
  // a real one for scoring purposes. ---
  {
    const backfilled = fact({ factText: "Backfilled fact.", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(1) });
    const live = fact({ factText: "Live fact.", sourceInteractionId: "int-2", sourceInteractionOccurredAt: daysAgo(1) });
    const result = synthesizeRelationshipSnapshot([backfilled, live], NOW);
    assert.match(result.relationshipSummary, /Backfilled fact\./);
    assert.match(result.relationshipSummary, /Live fact\./);
  }

  // --- 9: Zachter's real Phase 1 fact must participate correctly --
  // reproduces the exact real row (see docs/AI-HANDOFF.md's D1
  // verification: category engagement, lifecycle durable, no source
  // interaction). As the donor's only current fact, it alone must
  // synthesize into both surfaces verbatim. ---
  {
    const zachter = fact({
      factText: "Texted video from first day of Zman and thanked him for his support that makes it happen.",
      category: "engagement",
      lifecycle: "durable",
      sourceInteractionId: null,
      sourceInteractionOccurredAt: 1787336520,
    });
    const result = synthesizeRelationshipSnapshot([zachter], NOW);
    assert.equal(result.relationshipSummary, "Texted video from first day of Zman and thanked him for his support that makes it happen.");
    assert.equal(result.institutionalMemory, result.relationshipSummary);
  }

  // --- Institutional_memory cap: at most 5 facts, even when more clear
  // the floor. ---
  {
    const many = Array.from({ length: 7 }, (_, i) => fact({ factText: `Fact ${i}.`, category: "general", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(i) }));
    const result = synthesizeRelationshipSnapshot(many, NOW);
    const count = result.institutionalMemory.split(". ").length;
    assert.ok(count <= 5, `institutional_memory must cap at 5 facts, got ${count}`);
  }

  // --- Never-blank fallback: if EVERY current (non-follow_up) fact is
  // fully decayed, the single most recent one still appears rather than
  // leaving the Snapshot blank while accepted facts exist. ---
  {
    const older = fact({ factText: "Older decayed fact.", category: "engagement", lifecycle: "time_bound", sourceInteractionOccurredAt: daysAgo(400) });
    const newer = fact({ factText: "Newer decayed fact.", category: "engagement", lifecycle: "time_bound", sourceInteractionOccurredAt: daysAgo(300) });
    const result = synthesizeRelationshipSnapshot([older, newer], NOW);
    assert.equal(result.relationshipSummary, "Newer decayed fact.", "never blank while an accepted fact exists -- falls back to the single most recent, even fully decayed, fact");
  }

  console.log("relationship-fact-synthesis: ok");
}

await run();
