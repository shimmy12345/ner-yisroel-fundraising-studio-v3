import assert from "node:assert/strict";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";

// Relationship Snapshot Architecture Stage 2 (see docs/AI-HANDOFF.md) --
// proves the recommendation engine decides solicit/relationship_
// opportunity actionability from fact-level relevance (scoreFact(), via
// findMostActionableFact()) for any donor with structured Relationship
// Facts, while a donor with zero fact rows keeps today's exact legacy
// narrative-text behavior. Pure, no D1, directly unit-testable against
// the REAL production functions -- never a reimplementation.

const NOW = 1787858000; // fixed "now", matching the real epoch this stage's live migration ran near
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

const BASE_INPUT = {
  donorId: "donor-1",
  mostRecentPaidGift: null,
  openPledge: null,
  lastCompletedInteraction: null,
  lastContactAt: null,
  lastSubstantiveContactAt: null,
  openReminder: null,
  openAsk: null,
  relationshipSummary: null,
  institutionalMemory: null,
  historicalContext: [],
  yahrtzeits: [],
  importantDates: [],
};

function evidenceFor(overrides) {
  return buildRecommendationEvidence({ ...BASE_INPUT, ...overrides }, NOW, "America/New_York");
}

function candidateKinds(evidence) {
  return generateCandidates(evidence).map((c) => c.kind);
}

async function run() {
  // --- 1: old solicitation + declined Ask -- historical fact retained
  // (still passed in, never mutated by this call), but must not generate
  // solicit merely because the text contains "Solicited". This is
  // Klein's exact real shape (declined ask, ~294 days since the source
  // interaction, 90-day solicitation window). ---
  {
    const f = fact({ factText: "Solicited for a plaque ($5k).", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-klein", sourceInteractionOccurredAt: daysAgo(294) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    assert.equal(candidateKinds(evidence).includes("solicit"), false, "an old, ask-resolved solicitation fact must not generate solicit");
    const rec = buildDonorRecommendation(evidence);
    assert.notEqual(rec?.kind, "solicit", "the winning recommendation must not be solicit from stale fact evidence");
    // Historical retention is structural (this is the same fact object,
    // untouched) -- explicitly confirm nothing in this evidence-building
    // path mutates it.
    assert.deepEqual(f, fact({ factText: "Solicited for a plaque ($5k).", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-klein", sourceInteractionOccurredAt: daysAgo(294) }), "the fact object must be unchanged by evidence-building");
  }

  // --- 2: old solicitation + committed (fulfilled) Ask -- same
  // principle, committed treated identically to declined for pinning
  // purposes (unchanged existing semantics). Rovinsky's exact real shape. ---
  {
    const f = fact({ factText: "Solicited for a plaque in memory of his wife ($5k).", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-rovinsky", sourceInteractionOccurredAt: daysAgo(332) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    assert.equal(candidateKinds(evidence).includes("solicit"), false, "an old, committed (resolved) solicitation fact must not generate a duplicate solicit recommendation");
  }

  // --- 3: pending Ask linked to the solicitation interaction -- existing
  // pinning keeps the fact current (score 1.0), so solicit IS a valid
  // candidate; but a real pending structured Ask ALSO produces open_ask,
  // and existing ranking (unchanged by Stage 2) must still prefer
  // open_ask as the single winning recommendation -- no duplicate/
  // conflicting action shown. ---
  {
    const f = fact({ factText: "Asked about a $5,000 gala sponsorship.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-pending", sourceInteractionOccurredAt: daysAgo(200) }); // 200 days old, would be fully decayed WITHOUT the pin
    const evidence = evidenceFor({
      relationshipFacts: [f],
      pendingAskSourceInteractionIds: ["int-pending"],
      openAsk: { id: "ask-1", amountCents: 500000, purpose: "Gala sponsorship", askedAt: daysAgo(200), activeFollowUpDueAt: null },
    });
    const kinds = candidateKinds(evidence);
    assert.ok(kinds.includes("solicit"), "pinned-fresh solicitation fact must still be a valid candidate (existing pinning semantics unchanged)");
    assert.ok(kinds.includes("open_ask"), "a real pending ask must independently produce open_ask");
    const rec = buildDonorRecommendation(evidence);
    assert.equal(rec?.kind, "open_ask", "existing ranking must still prefer the confirmed structured Ask over the fact-derived solicit candidate -- no duplicate/conflicting action surfaced, unchanged by Stage 2");
  }

  // --- 4: a new, later solicitation after an old declined Ask -- the
  // newer legitimate solicitation remains actionable; resolving the old
  // ask must not globally suppress solicitation recommendations. The old
  // fact is correctly `superseded` by the existing, unmodified
  // fact-supersession architecture (not re-implemented here -- this
  // proves the STATUS filter alone is sufficient). ---
  {
    const oldFact = fact({ factText: "Solicited for $10,000 for the building fund.", category: "solicitation", lifecycle: "time_bound", status: "superseded", sourceInteractionId: "int-old", sourceInteractionOccurredAt: daysAgo(400) });
    const newFact = fact({ factText: "Asked about a new $3,000 annual gift.", category: "solicitation", lifecycle: "time_bound", status: "current", sourceInteractionId: "int-new", sourceInteractionOccurredAt: daysAgo(5) });
    const evidence = evidenceFor({ relationshipFacts: [oldFact, newFact], pendingAskSourceInteractionIds: [] });
    const candidates = generateCandidates(evidence);
    const solicit = candidates.find((c) => c.kind === "solicit");
    assert.ok(solicit, "a fresh, current solicitation fact must still generate solicit even though an older, resolved one exists");
    assert.match(solicit.action, /\$3,000 annual gift/, "the candidate must be grounded in the NEW fact, never the old superseded one");
    assert.doesNotMatch(solicit.action, /building fund/, "the old superseded fact's text must never leak into the new candidate");
  }

  // --- 5: multiple facts, only one actionable -- a stale solicitation
  // must not contaminate a separate, currently-relevant fact of a
  // different category. relationship_opportunity should surface the
  // genuinely relevant engagement fact, never the decayed solicitation
  // one, and solicit must not fire at all. ---
  {
    const staleSolicitation = fact({ factText: "Solicited for $10,000 long ago.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-stale", sourceInteractionOccurredAt: daysAgo(400) });
    const freshEngagement = fact({ factText: "Planning a trip to Israel this Sukkos.", category: "engagement", lifecycle: "time_bound", sourceInteractionId: "int-fresh", sourceInteractionOccurredAt: daysAgo(10) });
    const evidence = evidenceFor({ relationshipFacts: [staleSolicitation, freshEngagement], pendingAskSourceInteractionIds: [] });
    const candidates = generateCandidates(evidence);
    assert.equal(candidates.some((c) => c.kind === "solicit"), false, "the stale solicitation fact must not generate solicit");
    const opportunity = candidates.find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "the fresh, unrelated engagement fact must still generate relationship_opportunity");
    assert.match(opportunity.action, /Sukkos/, "relationship_opportunity must be grounded in the currently-relevant fact");
    assert.doesNotMatch(opportunity.action, /\$10,000/, "the stale solicitation fact's text must never contaminate an unrelated candidate");
  }

  // --- 6: an archived/superseded fact must never become recommendation
  // evidence -- even when it is the donor's ONLY fact row (so
  // hasStructuredFacts is true) and even when stale legacy narrative text
  // is still separately present, the strict fact path (not the legacy
  // fallback) governs, and no candidate fires from it. ---
  {
    const archived = fact({ factText: "Solicited for $5,000.", category: "solicitation", lifecycle: "time_bound", status: "archived_with_source", sourceInteractionId: "int-archived", sourceInteractionOccurredAt: daysAgo(5) }); // fresh date, but archived
    const evidence = evidenceFor({
      relationshipFacts: [archived],
      pendingAskSourceInteractionIds: [],
      relationshipSummary: "Note context: Solicited for $5,000", // legacy text still present, must NOT be consulted
    });
    assert.equal(evidence.factActionability.hasStructuredFacts, true, "a donor with any fact row (even archived) has structured facts -- no silent fallback to legacy text");
    assert.equal(evidence.factActionability.actionableSolicitationFact, null, "an archived fact must never be actionable, regardless of how fresh its date is");
    const kinds = candidateKinds(evidence);
    assert.equal(kinds.includes("solicit"), false, "an archived fact must not generate solicit even though legacy narrative text still mentions a solicitation");
  }

  // --- 7: a time-decayed fact must not generate an action merely because
  // the Relationship Snapshot's "never blank" display behavior would
  // still show it. Direct proof that display and actionability are
  // governed by different rules. ---
  {
    const decayed = fact({ factText: "Solicited for a plaque ($5k).", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-decayed", sourceInteractionOccurredAt: daysAgo(300) }); // sole fact, ~300 days, 90-day window
    const snapshot = synthesizeRelationshipSnapshot([decayed], NOW);
    assert.equal(snapshot.relationshipSummary, "Solicited for a plaque ($5k).", "the DISPLAY snapshot correctly still shows this fact (never-blank fallback) -- historical/display-worthy is preserved");
    const evidence = evidenceFor({ relationshipFacts: [decayed], pendingAskSourceInteractionIds: [] });
    assert.equal(evidence.factActionability.actionableSolicitationFact, null, "the same fact must NOT be actionable -- the never-blank display fallback must never leak into the actionability decision");
    assert.equal(candidateKinds(evidence).includes("solicit"), false, "no solicit candidate merely because the Snapshot would still display this fact");
  }

  // --- 8: no structured Relationship Facts -- preserve safe legacy
  // behavior. A donor with zero fact rows and matching legacy narrative
  // text must keep generating solicit exactly as before Stage 2. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [], institutionalMemory: "Note context: Solicited for a plaque ($5k)" });
    assert.equal(evidence.factActionability.hasStructuredFacts, false, "zero fact rows means no structured facts");
    assert.ok(candidateKinds(evidence).includes("solicit"), "a donor with zero fact rows must keep the existing legacy narrative-text solicit behavior, unchanged by Stage 2");
    // Same check with relationshipFacts entirely omitted (an older
    // caller/fixture that predates this field) -- must behave identically.
    const evidenceOmitted = buildRecommendationEvidence({ ...BASE_INPUT, institutionalMemory: "Note context: Solicited for a plaque ($5k)" }, NOW, "America/New_York");
    assert.ok(candidateKinds(evidenceOmitted).includes("solicit"), "omitting relationshipFacts entirely must behave identically to passing an empty array");
  }

  // --- Explicit regression: Stage 1 gave Klein/Rovinsky/Pfeiffer real
  // fact rows -- prove the legacy fallback path does NOT accidentally
  // keep firing for them now that they have facts, even though their
  // cached narrative columns still contain the word "Solicited" (Stage 1
  // deliberately left those columns unchanged). ---
  {
    const kleinFact = fact({ factText: "Solicited for a plaque ($5k).", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "monday-interaction-5a79919d", sourceInteractionOccurredAt: daysAgo(294) });
    const evidence = evidenceFor({
      relationshipFacts: [kleinFact],
      pendingAskSourceInteractionIds: [], // declined -- not pending
      institutionalMemory: "Note context: Solicited for a plaque ($5k)", // real, unchanged Stage 1 cached value
    });
    assert.equal(evidence.factActionability.hasStructuredFacts, true, "Klein now has a structured fact -- must route to the strict fact path, not the legacy regex path");
    assert.equal(candidateKinds(evidence).includes("solicit"), false, "Klein must not continue through the legacy narrative-text path now that Stage 1 gave him a fact row");
  }

  // --- Explanations remain truthful: a fact-derived candidate's
  // action/why/evidence text is grounded in the real fact_text, and never
  // exposes internal implementation terminology (score, threshold,
  // pinnedFresh, RELEVANCE_FLOOR, etc). ---
  {
    const f = fact({ factText: "Asked about renewing gala support at $5,000.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-fresh2", sourceInteractionOccurredAt: daysAgo(5) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    const solicit = generateCandidates(evidence).find((c) => c.kind === "solicit");
    assert.ok(solicit);
    const fullText = `${solicit.action} ${solicit.why} ${solicit.evidence.join(" ")}`;
    assert.match(fullText, /\$5,000/, "the explanation must be traceable to the real, currently-actionable fact");
    for (const forbidden of ["score", "RELEVANCE_FLOOR", "pinnedFresh", "scoreFact", "findMostActionableFact", "actionable"]) {
      assert.doesNotMatch(fullText, new RegExp(forbidden, "i"), `recommendation text must never expose internal terminology ("${forbidden}")`);
    }
  }

  console.log("relationship-fact-recommendation-actionability: ok");
}

await run();
