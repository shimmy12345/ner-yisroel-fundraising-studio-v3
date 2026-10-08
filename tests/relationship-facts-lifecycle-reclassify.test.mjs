import assert from "node:assert/strict";
import { planReclassification } from "../scripts/relationship-facts-lifecycle-reclassify.mjs";

// Relationship Intelligence Phase 1 -- planReclassification() is pure
// (no D1 access), so it's directly unit-testable against synthetic rows
// shaped exactly like a real donor_relationship_facts SELECT would
// return them. Exercises the real, imported classifyFactLifecycle(),
// never a reimplementation.

async function run() {
  // A row whose stored lifecycle (durable) now disagrees with the fixed
  // classifier's output (time_bound, via COMPLETED_WELL_WISH_PATTERN) --
  // the exact real Nussbaum shape -- must be planned for update.
  {
    const rows = [
      { id: "f1", donor_id: "d1", category: "family_milestone", lifecycle: "durable", fact_text: "sent text to wish happy birthday." },
    ];
    const plan = planReclassification(rows);
    assert.deepEqual(plan, [{ id: "f1", donorId: "d1", factText: "sent text to wish happy birthday.", category: "family_milestone", from: "durable", to: "time_bound" }]);
  }

  // A row whose stored lifecycle already agrees with the current
  // classifier must NOT be planned -- this is the idempotency guarantee
  // (a re-run after an apply touches zero already-correct rows).
  {
    const rows = [
      { id: "f2", donor_id: "d2", category: "family_milestone", lifecycle: "time_bound", fact_text: "sent text to wish happy birthday." },
      { id: "f3", donor_id: "d3", category: "general", lifecycle: "durable", fact_text: "His daughter is Danielle." },
    ];
    assert.deepEqual(planReclassification(rows), []);
  }

  // Mixed batch: only the disagreeing row is planned, by its own id.
  {
    const rows = [
      { id: "f4", donor_id: "d4", category: "family_milestone", lifecycle: "durable", fact_text: "texted to wish him a happy birthday." },
      { id: "f5", donor_id: "d5", category: "general", lifecycle: "durable", fact_text: "His daughter is Danielle." },
    ];
    const plan = planReclassification(rows);
    assert.deepEqual(plan.map((p) => p.id), ["f4"]);
  }

  console.log("relationship-facts-lifecycle-reclassify: ok");
}

await run();
