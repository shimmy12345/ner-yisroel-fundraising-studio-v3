import assert from "node:assert/strict";
import { planBackfill } from "../scripts/relationship-facts-backfill-preview.mjs";
import { DISPOSITION, REVIEWED_HISTORICAL_DISPOSITIONS } from "../scripts/relationship-facts-historical-corpus-review.mjs";

// Relationship Intelligence Phase 1 -- tests for the explicit, hand-
// reviewed historical-corpus gate (scripts/relationship-facts-
// historical-corpus-review.mjs), proving it -- not the mechanical
// category/lifecycle classifier -- is what actually decides eligibility
// for this specific historical migration. Uses the REAL donor ids and
// REAL legacy text from the live Independent Staging corpus (see
// docs/AI-HANDOFF.md's "Semantic Backfill Review"), not synthetic
// stand-ins, so this is a true end-to-end proof against the actual
// reviewed corpus.

const OWNER = "user-test";
const RUN_AT = 1787000000;

// Exact real donor id -> exact real legacy text, reproducing the live
// preview's own candidate set precisely.
const REAL_CORPUS = {
  "e4626eea-56ce-4005-96db-eeafbfde6628": { field: "relationship_summary", text: "Personal invite to Teaneck event." }, // Abdelhak
  "e34dc801-ab11-468e-b1bf-b6af52653262": { field: "relationship_summary", text: "Dropped off bottle of schnaps for son's bar mitzvah." }, // Joel Danziger
  "bb929584-0ba8-4741-84b6-746427724bc4": { field: "relationship_summary", text: "called to wish mazel tov on grandson's bar mitzvah this shabbos." }, // Mark Danziger
  "cd4fbfd1-a461-4954-b580-64d3585f9cb9": { field: "relationship_summary", text: "Messaged to welcome son back to Yeshiva." }, // Horn
  "b5e8cc18-49f5-42c9-8511-26371ca3cef6": { field: "institutional_memory", text: "Note context: Solicited for a plaque ($5k)" }, // Klein
  "d1b9cf78-2cdb-4546-9527-6210b95d16d4": { field: "institutional_memory", text: "Note context: Solicited for $10k" }, // Pfeiffer
  "952a1cc7-c05a-42ed-a472-463fdb1d633b": { field: "institutional_memory", text: "Note context: Solicited for a plaque in memory of his wife ($5k)" }, // Rovinsky
  "5c35437c-4b08-4c05-8c65-bb3eb95e06aa": { field: "relationship_summary", text: "Sent text on wife's Yahrtzeit to acknowledge it." }, // Semmelman
  "072ec28e-e73e-4981-a91d-5157aedad72d": { field: "relationship_summary", text: "called to wish mazel tov on son's bar mitzvah this shabbos." }, // Sonnenblick
  "9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e": { field: "relationship_summary", text: "Discussed Kollel donation and said to follow up after succos." }, // Weinschneider
  "19af69d6-f147-474b-88ad-f6358ff65b9a": { field: "relationship_summary", text: "Texted video from first day of Zman and thanked him for his support that makes it happen." }, // Zachter
  "2a1735d2-c3a6-4707-beb9-9ac7a0ab4e34": { field: "relationship_summary", text: "Sent him an email with photo of his son." }, // Shlionsky
};

function donorRow(id, { field, text }) {
  return {
    id,
    owner_user_id: OWNER,
    display_name: REVIEWED_HISTORICAL_DISPOSITIONS[id]?.donorName ?? "Unknown",
    relationship_summary: field === "relationship_summary" ? text : null,
    institutional_memory: field === "institutional_memory" ? text : null,
  };
}

const allRealDonors = Object.entries(REAL_CORPUS).map(([id, spec]) => donorRow(id, spec));

const CLASSIFY_ONLY_DISPOSITIONS = ["STRUCTURED_DATA_ALREADY_COVERS_IT", "INTERACTION_HISTORY_ONLY", "NEEDS_REVIEW"];

async function run() {
  // --- 1: Zachter is the ONLY currently approved backfill row -- the
  // central, explicit requirement of this task. ---
  {
    const { plan, skipped } = planBackfill(allRealDonors, new Set(), RUN_AT);
    assert.equal(plan.length, 1, "exactly one donor must be eligible for this historical migration");
    assert.equal(plan[0].donorId, "19af69d6-f147-474b-88ad-f6358ff65b9a", "the one eligible donor must be Zachter");
    assert.equal(skipped.length, 11, "the other 11 reviewed donors must all be skipped");
  }

  // --- 2: Klein/Pfeiffer/Rovinsky/Semmelman skipped specifically because
  // structured data already covers them -- not for some other reason. ---
  {
    const structuredIds = ["b5e8cc18-49f5-42c9-8511-26371ca3cef6", "d1b9cf78-2cdb-4546-9527-6210b95d16d4", "952a1cc7-c05a-42ed-a472-463fdb1d633b", "5c35437c-4b08-4c05-8c65-bb3eb95e06aa"];
    const { plan, skipped } = planBackfill(allRealDonors, new Set(), RUN_AT);
    for (const id of structuredIds) {
      assert.ok(!plan.some((item) => item.donorId === id), `${id} must not be in the eligible plan`);
      const item = skipped.find((s) => s.donor.id === id);
      assert.ok(item, `${id} (Klein/Pfeiffer/Rovinsky/Semmelman) must appear in skipped`);
      assert.match(item.reason, /STRUCTURED_DATA_ALREADY_COVERS_IT/);
    }
  }

  // --- 3: Abdelhak/Horn/Shlionsky skipped specifically as interaction-
  // history-only. ---
  {
    const historyOnlyIds = ["e4626eea-56ce-4005-96db-eeafbfde6628", "cd4fbfd1-a461-4954-b580-64d3585f9cb9", "2a1735d2-c3a6-4707-beb9-9ac7a0ab4e34"];
    const { plan, skipped } = planBackfill(allRealDonors, new Set(), RUN_AT);
    for (const id of historyOnlyIds) {
      assert.ok(!plan.some((item) => item.donorId === id), `${id} must not be in the eligible plan`);
      const item = skipped.find((s) => s.donor.id === id);
      assert.ok(item, `${id} (Abdelhak/Horn/Shlionsky) must appear in skipped`);
      assert.match(item.reason, /INTERACTION_HISTORY_ONLY/);
    }
  }

  // --- 4: Joel Danziger/Mark Danziger/Sonnenblick/Weinschneider stay
  // blocked as NEEDS_REVIEW -- not silently promoted to eligible. ---
  {
    const needsReviewIds = ["e34dc801-ab11-468e-b1bf-b6af52653262", "bb929584-0ba8-4741-84b6-746427724bc4", "072ec28e-e73e-4981-a91d-5157aedad72d", "9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e"];
    const { plan, skipped } = planBackfill(allRealDonors, new Set(), RUN_AT);
    for (const id of needsReviewIds) {
      assert.ok(!plan.some((item) => item.donorId === id), `${id} must not be in the eligible plan`);
      const item = skipped.find((s) => s.donor.id === id);
      assert.ok(item, `${id} (Danziger x2/Sonnenblick/Weinschneider) must appear in skipped`);
      assert.match(item.reason, /NEEDS_REVIEW/);
    }
  }

  // --- 5: idempotency -- re-running the migration after Zachter's fact
  // was already created must produce zero plan entries and report
  // Zachter as already-existing, not silently re-attempt or duplicate. ---
  {
    // Simulate a completed first run: compute Zachter's real fingerprint
    // the same way applyBackfill() would have, and pre-populate
    // existingFingerprints exactly as fetchLivePlan() would after a real
    // apply.
    const firstRun = planBackfill(allRealDonors, new Set(), RUN_AT);
    assert.equal(firstRun.plan.length, 1);
    const zachterFingerprint = firstRun.plan[0].fingerprint;
    const existingAfterApply = new Set([`${OWNER}:${zachterFingerprint}`]);

    const secondRun = planBackfill(allRealDonors, existingAfterApply, RUN_AT + 12345);
    assert.equal(secondRun.plan.length, 0, "re-running after Zachter's fact already exists must produce zero new eligible rows");
    assert.equal(secondRun.skipped.length, 12, "all 12 donors must now be in skipped -- Zachter via idempotency, the other 11 via the same reviewed-disposition gate as before");
    const zachterSkip = secondRun.skipped.find((s) => s.donor.id === "19af69d6-f147-474b-88ad-f6358ff65b9a");
    assert.ok(zachterSkip);
    assert.match(zachterSkip.reason, /already exists/);
  }

  // --- 6: no skipped donor can enter the fact table merely because it
  // still passes the mechanical classifier. Two proofs: ---

  // 6a: every one of the 11 non-Zachter reviewed donors' REAL text
  // already mechanically classifies as a structurally "valid" category/
  // lifecycle under the corrected classifier (proving they are excluded
  // by the DISPOSITION gate, not because the mechanical classifier
  // happens to reject them -- if the gate were removed, all 11 would
  // otherwise sail through the mechanical checks the same way Zachter
  // does).
  {
    const { classifyRelationshipFact } = await import("../lib/relationships/fact-classification.ts");
    for (const [id, spec] of Object.entries(REAL_CORPUS)) {
      if (id === "19af69d6-f147-474b-88ad-f6358ff65b9a") continue; // Zachter, the one real exception
      const { category, lifecycle } = classifyRelationshipFact(spec.text);
      assert.ok(category, `${id} must still receive a real category from the mechanical classifier (proving the gate, not the classifier, is what excludes it)`);
      assert.ok(lifecycle, `${id} must still receive a real lifecycle from the mechanical classifier`);
    }
  }

  // 6b: a hypothetical 13th donor, NOT in the reviewed map, whose text
  // is mechanically indistinguishable from Zachter's own eligible case
  // (same Zman-appreciation pattern) must still be skipped -- proving
  // the gate excludes by REVIEW STATUS, not by re-deriving eligibility
  // from text.
  {
    const unreviewedDonor = {
      id: "unreviewed-hypothetical-donor",
      owner_user_id: OWNER,
      display_name: "Unreviewed Hypothetical Donor",
      relationship_summary: "Texted video from first day of Zman and thanked her for her support that makes it happen.",
      institutional_memory: null,
    };
    const { plan, skipped } = planBackfill([unreviewedDonor], new Set(), RUN_AT);
    assert.equal(plan.length, 0, "a donor with no reviewed disposition must never be auto-eligible, even with mechanically-identical-to-Zachter text");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /not part of the explicitly reviewed/i);
  }

  // --- Sanity: every disposition value used in the reviewed map is one
  // of the four defined constants -- no silent typo/drift possible. ---
  for (const entry of Object.values(REVIEWED_HISTORICAL_DISPOSITIONS)) {
    assert.ok(Object.values(DISPOSITION).includes(entry.disposition), `disposition "${entry.disposition}" for ${entry.donorName} must be one of the four defined DISPOSITION values`);
  }
  // The reviewed map has exactly 12 entries (the known corpus), exactly
  // 1 of which is BACKFILL.
  assert.equal(Object.keys(REVIEWED_HISTORICAL_DISPOSITIONS).length, 12);
  assert.equal(Object.values(REVIEWED_HISTORICAL_DISPOSITIONS).filter((entry) => entry.disposition === DISPOSITION.BACKFILL).length, 1);

  console.log("relationship-facts-historical-migration-gate: ok");
}

await run();
