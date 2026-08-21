import assert from "node:assert/strict";
import { selectSupersessionTarget } from "../lib/relationships/fact-supersession.ts";

// Relationship Intelligence Phase 2 -- selectSupersessionTarget(), the
// pure "add rather than erase" decision core the shared accept pipeline
// (lib/relationships/fact-accept.ts) uses. Deliberately kept in its own
// module (lib/relationships/fact-supersession.ts) with no
// "cloudflare:workers" import -- fact-accept.ts imports "cloudflare:
// workers" at its top and cannot be imported outside a Workers runtime
// at all (matching every existing route file's own established
// constraint), so this decision logic had to live in a separate file to
// be unit-testable, not just be exported from the same one.

function existing(overrides) {
  return { id: "existing-1", category: "general", lifecycle: "durable", sourceInteractionId: "int-old", fingerprint: "fp-old", ...overrides };
}
function proposed(overrides) {
  return { category: "general", lifecycle: "durable", sourceInteractionId: "int-new", fingerprint: "fp-new", ...overrides };
}

async function run() {
  // --- 1: additive categories (family_milestone, engagement,
  // commitment_followup, general) never auto-supersede on category match
  // alone -- accepting fact B after fact A must leave BOTH current, no
  // target selected. Direct proof of the central "accumulate, don't
  // erase" requirement. ---
  for (const category of ["family_milestone", "engagement", "commitment_followup", "general"]) {
    const decision = selectSupersessionTarget(
      [existing({ category, lifecycle: category === "commitment_followup" ? "follow_up" : "durable" })],
      proposed({ category, lifecycle: category === "commitment_followup" ? "follow_up" : "durable" }),
    );
    assert.equal(decision.targetId, null, `${category} must never auto-supersede on category match alone`);
    assert.equal(decision.isNoOp, false);
  }

  // --- Singular-state categories (solicitation, health) DO auto-
  // supersede when both category AND lifecycle match. ---
  for (const category of ["solicitation", "health"]) {
    const decision = selectSupersessionTarget(
      [existing({ category, lifecycle: "time_bound" })],
      proposed({ category, lifecycle: "time_bound" }),
    );
    assert.equal(decision.targetId, "existing-1", `${category} must auto-supersede when category and lifecycle both match`);
  }

  // --- The Lifecycle Correction's own fix, re-verified here at the
  // decision layer: same category, DIFFERENT lifecycle, in a singular-
  // state category, must NOT auto-supersede -- e.g. a durable identity-
  // adjacent health fact must never be blown away by an unrelated
  // time_bound health-status update, or vice versa. ---
  {
    const decision = selectSupersessionTarget(
      [existing({ category: "health", lifecycle: "durable" })],
      proposed({ category: "health", lifecycle: "time_bound" }),
    );
    assert.equal(decision.targetId, null, "same category but different lifecycle must never auto-supersede, even in a singular-state category");
  }

  // --- 2 (the rejection analogue): a proposal directed at a donor with
  // NO existing facts at all finds no target and is not a no-op --
  // proceeds as a plain new fact, which is exactly what "accepting" (not
  // rejecting) should do; rejection itself is a route-level decision
  // never to call this function at all (proven at the wiring layer). ---
  {
    const decision = selectSupersessionTarget([], proposed({}));
    assert.equal(decision.targetId, null);
    assert.equal(decision.isNoOp, false);
  }

  // --- 7 (provenance): an exact same-source-interaction match ALWAYS
  // wins first -- a correction to what THIS interaction already
  // contributed -- regardless of category, lifecycle, or singular-
  // state-ness. Proves an edit's re-accept targets its own prior
  // contribution specifically, not just "any additive-category fact". ---
  {
    const decision = selectSupersessionTarget(
      [existing({ category: "family_milestone", lifecycle: "durable", sourceInteractionId: "int-shared" })],
      proposed({ category: "engagement", lifecycle: "time_bound", sourceInteractionId: "int-shared" }), // same interaction, even though category/lifecycle both changed
    );
    assert.equal(decision.targetId, "existing-1", "an exact source-interaction match must supersede its own prior contribution even when category/lifecycle differ (a genuine correction)");
  }
  // A same-source-interaction match takes priority even OVER an
  // available singular-state category match on a DIFFERENT fact --
  // proving the interaction-provenance rule is checked first, not just
  // "whichever rule fires".
  {
    const sameInteraction = existing({ id: "same-interaction-fact", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-shared" });
    const otherSolicitation = existing({ id: "other-solicitation-fact", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-other" });
    const decision = selectSupersessionTarget([otherSolicitation, sameInteraction], proposed({ category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-shared" }));
    assert.equal(decision.targetId, "same-interaction-fact", "the same-source-interaction match must win even when a different fact would also match via the singular-state-category rule");
  }

  // --- No-op detection: re-accepting text that would produce a byte-
  // identical fact to the one it would supersede (an edit that didn't
  // actually change the accepted sentence) must be flagged isNoOp, so
  // the caller writes nothing at all -- not even a pointless supersede-
  // with-identical-content chain. ---
  {
    const decision = selectSupersessionTarget(
      [existing({ sourceInteractionId: "int-same", fingerprint: "fp-identical" })],
      proposed({ sourceInteractionId: "int-same", fingerprint: "fp-identical" }),
    );
    assert.equal(decision.targetId, "existing-1");
    assert.equal(decision.isNoOp, true);
  }
  // A GENUINE change (different fingerprint) from the same interaction
  // is NOT a no-op -- it must proceed to supersede with real new content.
  {
    const decision = selectSupersessionTarget(
      [existing({ sourceInteractionId: "int-same", fingerprint: "fp-old-text" })],
      proposed({ sourceInteractionId: "int-same", fingerprint: "fp-new-text" }),
    );
    assert.equal(decision.targetId, "existing-1");
    assert.equal(decision.isNoOp, false);
  }

  console.log("relationship-fact-accept-core: ok");
}

await run();
