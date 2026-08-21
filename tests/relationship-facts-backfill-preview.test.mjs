import assert from "node:assert/strict";
import { planBackfill, MAX_SANE_LENGTH } from "../scripts/relationship-facts-backfill-preview.mjs";
import { computeRelationshipFactFingerprint } from "../lib/relationships/fact-fingerprint.ts";
import { OLD_FORMAT_PREFIX } from "../scripts/relationship-summary-cleanup-preview.mjs";

// Relationship Intelligence Phase 1 -- tests for the read-only backfill
// PREVIEW tool (scripts/relationship-facts-backfill-preview.mjs). This
// script never writes to D1 in preview mode -- these tests exercise the
// pure classification/planning core (planBackfill) against synthetic
// fixtures, matching tests/relationship-summary-cleanup-preview.test.mjs's
// established convention, so they run offline with no wrangler/D1
// round-trip.

const RUN_AT = 1787000000; // fixed, arbitrary "backfill run time"
let nextId = 0;
function donor(overrides) {
  return { id: `donor-${nextId++}`, owner_user_id: "user-1", display_name: "Test Donor", relationship_summary: null, institutional_memory: null, ...overrides };
}

async function run() {
  // --- 1: the ordinary case -- relationship_summary is preferred,
  // classified via the real classifyRelationshipFact, source_interaction_
  // id always null, source_interaction_occurred_at clamped to the
  // backfill's own run time (never any historical date -- there is none
  // to clamp away from here, which is exactly the point). ---
  {
    const d = donor({ relationship_summary: "His daughter is Danielle.", institutional_memory: "Call context: His daughter is Danielle." });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(skipped.length, 0);
    assert.equal(plan.length, 1);
    const item = plan[0];
    assert.equal(item.sourceField, "relationship_summary", "relationship_summary must be preferred over institutional_memory when both are present");
    assert.equal(item.factText, "His daughter is Danielle.");
    assert.equal(item.category, "family_milestone");
    assert.equal(item.lifecycle, "durable");
    assert.equal(item.sourceInteractionId, null, "a backfilled fact must never claim a provable source interaction");
    assert.equal(item.sourceInteractionOccurredAt, RUN_AT, "decay-clock clamp: a backfilled fact's occurred_at must be the backfill's own run time, never a real historical date");
  }

  // --- 2: institutional_memory fallback -- only consulted when
  // relationship_summary is null, mirroring the existing narrative
  // fallback (`relationshipSummary || institutionalMemory`) already used
  // in lib/relationships/recommendation-candidates.ts. ---
  {
    const d = donor({ relationship_summary: null, institutional_memory: "Call context: Very close with Rabbi Cohen." });
    const { plan } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(plan[0].sourceField, "institutional_memory");
    assert.equal(plan[0].factText, "Call context: Very close with Rabbi Cohen.");
  }

  // --- 3: a donor with neither field populated produces neither a plan
  // item nor a skip entry -- there is nothing to report, not a failure. ---
  {
    const d = donor({});
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(plan.length, 0);
    assert.equal(skipped.length, 0);
  }

  // --- 4: backfill safety -- the provably-junk pre-fix field-label-dump
  // format is flagged NEEDS_REVIEW, never silently ingested as permanent
  // durable intelligence. ---
  {
    const junk = `${OLD_FORMAT_PREFIX}Personal update.\nPeople mentioned: Messaged.`;
    const d = donor({ relationship_summary: junk });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(plan.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /pre-fix/);
  }

  // --- 4b: backfill safety -- a Weinschneider-style sentence bundling a
  // real substantive fact (a Kollel donation) with a follow-up
  // instruction ("follow up after succos") must be flagged NEEDS_REVIEW,
  // never silently backfilled as a pure follow_up fact -- doing so would
  // permanently exclude the donation context from Snapshot synthesis
  // (follow_up facts never enter it, at any age). This is the exact real
  // donor text from the live Independent Staging preview, not a
  // synthetic paraphrase. ---
  {
    const d = donor({ relationship_summary: "Discussed Kollel donation and said to follow up after succos." });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(plan.length, 0, "a sentence bundling a real substantive fact with a follow-up instruction must never be silently backfilled as pure follow_up");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /follow_up/);
    assert.match(skipped[0].reason, /substantive/);
  }
  // A pure follow-up sentence with NO competing substantive signal is
  // still backfilled normally (follow_up facts are stored, just excluded
  // from synthesis by lifecycle -- see the design doc; they are not a
  // backfill-safety concern on their own).
  {
    const d = donor({ relationship_summary: "Promised to send the updated schedule." });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(skipped.length, 0);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].lifecycle, "follow_up");
  }

  // --- 5: backfill safety -- empty-after-trim is flagged, not silently
  // skipped as "nothing to do" and not silently ingested as an empty
  // durable fact either. ---
  {
    const d = donor({ relationship_summary: "   " });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(plan.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /empty after trim/);
  }

  // --- 6: backfill safety -- an implausibly long value is flagged for
  // human review rather than silently ingested as one giant "fact". ---
  {
    const d = donor({ relationship_summary: "x".repeat(MAX_SANE_LENGTH + 1) });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(plan.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /sanity bound/);
  }
  // A value exactly at the bound is NOT flagged.
  {
    const d = donor({ relationship_summary: "x".repeat(MAX_SANE_LENGTH) });
    const { plan, skipped } = planBackfill([d], new Set(), RUN_AT);
    assert.equal(skipped.length, 0);
    assert.equal(plan.length, 1);
  }

  // --- 7: idempotency -- a second run against a donor whose fingerprint
  // already exists in donor_relationship_facts (simulated via
  // existingFingerprints) is skipped, never re-inserted/duplicated. This
  // is the real safeguard behind "re-running this script is always
  // safe". ---
  {
    const d = donor({ relationship_summary: "His daughter is Danielle." });
    const fingerprint = computeRelationshipFactFingerprint({ donorId: d.id, factText: "His daughter is Danielle.", sourceInteractionId: null });
    const existing = new Set([`${d.owner_user_id}:${fingerprint}`]);
    const { plan, skipped } = planBackfill([d], existing, RUN_AT);
    assert.equal(plan.length, 0, "a donor whose fingerprint already exists must never be re-planned");
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /already exists/);
  }

  // --- 8: idempotency is scoped per-user -- the SAME fingerprint string
  // existing for a DIFFERENT user must not suppress this donor's own
  // backfill (matches donor_relationship_facts' own (user_id,
  // fingerprint) unique index scoping, verified at the database level in
  // tests/relationship-facts-schema.test.mjs). ---
  {
    const d = donor({ owner_user_id: "user-2", relationship_summary: "His daughter is Danielle." });
    const fingerprint = computeRelationshipFactFingerprint({ donorId: d.id, factText: "His daughter is Danielle.", sourceInteractionId: null });
    const existingForDifferentUser = new Set([`user-1:${fingerprint}`]);
    const { plan } = planBackfill([d], existingForDifferentUser, RUN_AT);
    assert.equal(plan.length, 1, "a fingerprint existing for a different user must not block this donor's own backfill");
  }

  // --- 9: duplicate prevention across DIFFERENT donors with
  // coincidentally identical text -- fingerprints must differ (donorId is
  // part of the fingerprint input), so two real donors who happen to
  // share the exact same accepted sentence are never merged/collapsed
  // into one apparent duplicate. ---
  {
    const a = donor({ id: "donor-a", relationship_summary: "Very close with Rabbi Cohen." });
    const b = donor({ id: "donor-b", relationship_summary: "Very close with Rabbi Cohen." });
    const { plan } = planBackfill([a, b], new Set(), RUN_AT);
    assert.equal(plan.length, 2);
    assert.notEqual(plan[0].fingerprint, plan[1].fingerprint, "two different donors' facts must never collide on fingerprint even with identical text");
  }

  // --- 10: fingerprint recomputation is deterministic -- running
  // planBackfill twice on the exact same input produces the exact same
  // fingerprint both times (the actual property idempotent re-runs
  // depend on). ---
  {
    const d = donor({ relationship_summary: "His daughter is Danielle." });
    const first = planBackfill([d], new Set(), RUN_AT).plan[0].fingerprint;
    const second = planBackfill([d], new Set(), RUN_AT + 999).plan[0].fingerprint;
    assert.equal(first, second, "fingerprint must be stable across separate runs regardless of backfill run timestamp -- only donor id + fact text + null source determine it");
  }

  // --- 11: a real, multi-donor mixed batch -- safe items and skipped
  // items are correctly separated, counts add up, nothing silently
  // dropped. ---
  {
    const donors = [
      donor({ id: "ok-1", relationship_summary: "His daughter is Danielle." }),
      donor({ id: "junk-1", relationship_summary: `${OLD_FORMAT_PREFIX}Junk.` }),
      donor({ id: "none-1" }),
      donor({ id: "ok-2", institutional_memory: "Call context: Recovering from surgery." }),
    ];
    const { plan, skipped } = planBackfill(donors, new Set(), RUN_AT);
    assert.equal(plan.length, 2);
    assert.equal(skipped.length, 1);
    assert.deepEqual(plan.map((p) => p.donorId).sort(), ["ok-1", "ok-2"]);
  }

  console.log("relationship-facts-backfill-preview: ok");
}

await run();
