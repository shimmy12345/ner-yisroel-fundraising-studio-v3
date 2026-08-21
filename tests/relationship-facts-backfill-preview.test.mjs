import assert from "node:assert/strict";
import { classifyCandidate, planBackfill, MAX_SANE_LENGTH } from "../scripts/relationship-facts-backfill-preview.mjs";
import { computeRelationshipFactFingerprint } from "../lib/relationships/fact-fingerprint.ts";
import { OLD_FORMAT_PREFIX } from "../scripts/relationship-summary-cleanup-preview.mjs";

// Relationship Intelligence Phase 1 -- tests for the read-only backfill
// PREVIEW tool (scripts/relationship-facts-backfill-preview.mjs). This
// script never writes to D1 in preview mode.
//
// Two layers are tested separately, matching the script's own
// classifyCandidate()/planBackfill() split: this file exercises
// classifyCandidate() -- the GENERAL mechanical safety pipeline (empty/
// too-long/junk-format/follow_up-plus-substantive-signal/fingerprint
// idempotency), using synthetic donor ids that are deliberately NOT part
// of the explicit historical-corpus review gate, since that gate is a
// separate, additional concern (tested specifically, against the real
// reviewed corpus, by tests/relationship-facts-historical-migration-
// gate.test.mjs). Matches tests/relationship-summary-cleanup-preview.
// test.mjs's established convention of testing pure cores offline, no
// wrangler/D1 round-trip.

const RUN_AT = 1787000000; // fixed, arbitrary "backfill run time"
let nextId = 0;
function donor(overrides) {
  return { id: `donor-${nextId++}`, owner_user_id: "user-1", display_name: "Test Donor", relationship_summary: null, institutional_memory: null, ...overrides };
}

// Reproduces planBackfill()'s own sourceField-selection logic (relationship_
// summary preferred, institutional_memory fallback), then calls
// classifyCandidate() directly -- bypassing the review gate on purpose.
function classifyOne(d, existingFingerprints = new Set(), runAt = RUN_AT) {
  const sourceField = d.relationship_summary !== null ? "relationship_summary" : d.institutional_memory !== null ? "institutional_memory" : null;
  if (sourceField === null) return null;
  const rawValue = sourceField === "relationship_summary" ? d.relationship_summary : d.institutional_memory;
  return classifyCandidate(d, sourceField, rawValue, existingFingerprints, runAt);
}

async function run() {
  // --- 1: the ordinary case -- relationship_summary is preferred,
  // classified via the real classifyRelationshipFact, source_interaction_
  // id always null, source_interaction_occurred_at clamped to the
  // backfill's own run time (never any historical date -- there is none
  // to clamp away from here, which is exactly the point). ---
  {
    const d = donor({ relationship_summary: "His daughter is Danielle.", institutional_memory: "Call context: His daughter is Danielle." });
    const result = classifyOne(d);
    assert.ok(result.plan && !result.skip);
    const item = result.plan;
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
    const result = classifyOne(d);
    assert.equal(result.plan.sourceField, "institutional_memory");
    assert.equal(result.plan.factText, "Call context: Very close with Rabbi Cohen.");
  }

  // --- 3: a donor with neither field populated produces null (nothing
  // to report). classifyOne() itself returns null here (the sourceField-
  // selection step, shared with planBackfill()); planBackfill() turns
  // that into "neither a plan item nor a skip entry", tested separately
  // below in case 11. ---
  {
    const d = donor({});
    assert.equal(classifyOne(d), null);
  }

  // --- 4: backfill safety -- the provably-junk pre-fix field-label-dump
  // format is flagged, never silently ingested as permanent durable
  // intelligence. ---
  {
    const junk = `${OLD_FORMAT_PREFIX}Personal update.\nPeople mentioned: Messaged.`;
    const d = donor({ relationship_summary: junk });
    const result = classifyOne(d);
    assert.ok(result.skip && !result.plan);
    assert.match(result.skip.reason, /pre-fix/);
  }

  // --- 4b: backfill safety -- a Weinschneider-style sentence bundling a
  // real substantive fact (a Kollel donation) with a follow-up
  // instruction ("follow up after succos") must be flagged, never
  // silently backfilled as a pure follow_up fact -- doing so would
  // permanently exclude the donation context from Snapshot synthesis
  // (follow_up facts never enter it, at any age). This is the exact real
  // donor text from the live Independent Staging preview, not a
  // synthetic paraphrase (see tests/relationship-facts-historical-
  // migration-gate.test.mjs for the real Weinschneider donor id/full
  // pipeline proof; this test isolates just the mechanical signal). ---
  {
    const d = donor({ relationship_summary: "Discussed Kollel donation and said to follow up after succos." });
    const result = classifyOne(d);
    assert.ok(result.skip && !result.plan, "a sentence bundling a real substantive fact with a follow-up instruction must never be silently backfilled as pure follow_up");
    assert.match(result.skip.reason, /follow_up/);
    assert.match(result.skip.reason, /substantive/);
  }
  // A pure follow-up sentence with NO competing substantive signal is
  // still backfilled normally (follow_up facts are stored, just excluded
  // from synthesis by lifecycle -- see the design doc; they are not a
  // backfill-safety concern on their own).
  {
    const d = donor({ relationship_summary: "Promised to send the updated schedule." });
    const result = classifyOne(d);
    assert.ok(result.plan && !result.skip);
    assert.equal(result.plan.lifecycle, "follow_up");
  }

  // --- 5: backfill safety -- empty-after-trim is flagged, not silently
  // skipped as "nothing to do" and not silently ingested as an empty
  // durable fact either. ---
  {
    const d = donor({ relationship_summary: "   " });
    const result = classifyOne(d);
    assert.ok(result.skip && !result.plan);
    assert.match(result.skip.reason, /empty after trim/);
  }

  // --- 6: backfill safety -- an implausibly long value is flagged for
  // human review rather than silently ingested as one giant "fact". ---
  {
    const d = donor({ relationship_summary: "x".repeat(MAX_SANE_LENGTH + 1) });
    const result = classifyOne(d);
    assert.ok(result.skip && !result.plan);
    assert.match(result.skip.reason, /sanity bound/);
  }
  // A value exactly at the bound is NOT flagged.
  {
    const d = donor({ relationship_summary: "x".repeat(MAX_SANE_LENGTH) });
    const result = classifyOne(d);
    assert.ok(result.plan && !result.skip);
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
    const result = classifyOne(d, existing);
    assert.ok(result.skip && !result.plan, "a donor whose fingerprint already exists must never be re-planned");
    assert.match(result.skip.reason, /already exists/);
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
    const result = classifyOne(d, existingForDifferentUser);
    assert.ok(result.plan && !result.skip, "a fingerprint existing for a different user must not block this donor's own backfill");
  }

  // --- 9: duplicate prevention across DIFFERENT donors with
  // coincidentally identical text -- fingerprints must differ (donorId is
  // part of the fingerprint input), so two real donors who happen to
  // share the exact same accepted sentence are never merged/collapsed
  // into one apparent duplicate. ---
  {
    const a = donor({ id: "donor-a", relationship_summary: "Very close with Rabbi Cohen." });
    const b = donor({ id: "donor-b", relationship_summary: "Very close with Rabbi Cohen." });
    const resultA = classifyOne(a);
    const resultB = classifyOne(b);
    assert.ok(resultA.plan && resultB.plan);
    assert.notEqual(resultA.plan.fingerprint, resultB.plan.fingerprint, "two different donors' facts must never collide on fingerprint even with identical text");
  }

  // --- 10: fingerprint recomputation is deterministic -- classifying the
  // same input twice produces the exact same fingerprint both times (the
  // actual property idempotent re-runs depend on). ---
  {
    const d = donor({ relationship_summary: "His daughter is Danielle." });
    const first = classifyOne(d, new Set(), RUN_AT).plan.fingerprint;
    const second = classifyOne(d, new Set(), RUN_AT + 999).plan.fingerprint;
    assert.equal(first, second, "fingerprint must be stable across separate runs regardless of backfill run timestamp -- only donor id + fact text + null source determine it");
  }

  // --- 11: planBackfill() itself, end to end, WITH the historical-
  // corpus review gate active -- a mixed batch of synthetic (non-
  // reviewed) donors must ALL be skipped by the gate, regardless of
  // what classifyCandidate() alone would have said about their text.
  // This is the direct proof that planBackfill() layers the gate on top
  // of (never bypasses) the mechanical pipeline exercised above. The
  // real reviewed corpus's own full plan/skip behavior is covered by
  // tests/relationship-facts-historical-migration-gate.test.mjs. ---
  {
    const donors = [
      donor({ id: "ok-1", relationship_summary: "His daughter is Danielle." }),
      donor({ id: "junk-1", relationship_summary: `${OLD_FORMAT_PREFIX}Junk.` }),
      donor({ id: "none-1" }),
      donor({ id: "ok-2", institutional_memory: "Call context: Recovering from surgery." }),
    ];
    const { plan, skipped } = planBackfill(donors, new Set(), RUN_AT);
    assert.equal(plan.length, 0, "no synthetic, unreviewed donor id may ever appear in planBackfill()'s eligible plan, even with otherwise-clean text");
    assert.equal(skipped.length, 3, "none-1 has no populated field at all, so it is neither planned nor skipped -- the other 3 are all skipped by the review gate");
    for (const item of skipped) assert.match(item.reason, /not part of the explicitly reviewed/i);
  }

  console.log("relationship-facts-backfill-preview: ok");
}

await run();
