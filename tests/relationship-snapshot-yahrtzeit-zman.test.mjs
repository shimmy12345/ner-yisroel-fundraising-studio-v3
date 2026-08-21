import assert from "node:assert/strict";
import { actionableRelationshipSnapshot, relationshipSnapshotDetails, extractInteraction } from "../lib/capture/interaction.ts";

// Regression for the 2026-08-20 Zman/Yahrtzeit extraction-vocabulary
// investigation and implementation (see docs/AI-HANDOFF.md): exercises
// the real, unmodified extraction functions -- never a reimplementation
// of the regexes -- against the two real flagged donors (Zachter 60830,
// Semmelman 72957) plus every regression case the design task specified.

function expectFacts(note, kind, label) {
  const details = relationshipSnapshotDetails(note, kind);
  const snapshot = actionableRelationshipSnapshot(note, kind);
  assert.ok(details.specificFacts.length > 0, `${label}: expected a fact from "${note}"`);
  assert.notEqual(snapshot, null, `${label}: expected a non-null relationship snapshot from "${note}"`);
  return snapshot;
}

function expectNoFacts(note, kind, label) {
  const details = relationshipSnapshotDetails(note, kind);
  assert.deepEqual(details.specificFacts, [], `${label}: "${note}" must not be treated as containing a fact`);
  assert.equal(actionableRelationshipSnapshot(note, kind), null, `${label}: "${note}" must not produce a relationship snapshot`);
}

async function run() {
  // ---- PART 2: Yahrtzeit as a simple fact signal ----

  // Semmelman's actual source note -- the desired behavior this change exists for.
  const semmelmanSnapshot = expectFacts("Sent text on wife's Yahrtzeit to acknowledge it", "personal", "Semmelman (72957) wife's Yahrtzeit");
  assert.equal(semmelmanSnapshot, "Sent text on wife's Yahrtzeit to acknowledge it.");

  // A different donor/family Yahrtzeit phrasing must also qualify.
  expectFacts("Called to check in ahead of his father's Yahrtzeit next week", "call", "father's Yahrtzeit (different donor)");

  // ---- existing birthday/anniversary/family behavior unchanged ----
  expectFacts("Called to wish him a happy birthday", "call", "birthday (unchanged)");
  expectFacts("Stopped by to celebrate their anniversary", "visit", "anniversary (unchanged)");
  expectFacts("Spoke about his son's upcoming bar mitzvah", "call", "son family term (unchanged)");
  expectFacts("Spoke about his grandson's upcoming bar mitzvah", "call", "grandson family term (unchanged, prior fix)");

  // ---- unrelated extraction behavior does not regress ----
  expectNoFacts("Left a voicemail, no answer", "call", "unrelated voicemail note (unchanged)");
  const commitmentNote = "Coffee with Elena. She loved the update and wants to visit campus this fall. I promised to send the outcomes brief.";
  const commitmentDetails = relationshipSnapshotDetails(commitmentNote, "meeting");
  assert.match(commitmentDetails.specificFacts.join(" "), /I promised to send the outcomes brief/, "commitment extraction must still work unchanged");

  // ---- PART 3/6: Zman contextual co-occurrence rule ----

  // 1. Zachter's actual source note -- SHOULD QUALIFY.
  const zachterSnapshot = expectFacts(
    "Texted video from first day of Zman and thanked him for his support that makes it happen",
    "text",
    "Zachter (60830) Zman + appreciation",
  );
  assert.equal(zachterSnapshot, "Texted video from first day of Zman and thanked him for his support that makes it happen.");

  // 2. A semantically equivalent donor-specific support/impact sentence supported by the actual rule (zman + support, no "thank").
  expectFacts("Shared the new Zman photos and said his support makes it possible", "text", "equivalent Zman + support phrasing");

  // 3-6. SHOULD NOT QUALIFY merely because of Zman (no appreciation/support language present).
  for (const note of [
    "Sent video from first day of Zman.",
    "Zman begins next week.",
    "Spoke before the end of Zman.",
    "Sent first day of Zman update.",
  ]) {
    expectNoFacts(note, "text", `Zman-only, no appreciation ("${note}")`);
  }

  // 7-9. SHOULD NOT QUALIFY merely because of thanks (no zman/semester
  // mention). "his donation"/"her gift" etc. are deliberately avoided here
  // -- those already trigger the pre-existing, unrelated
  // gift/donation/contribution fact signal, which would make this
  // assertion misleading about what the NEW Zman rule alone does.
  for (const note of [
    "Thanked him.",
    "Thanked him for getting back to me.",
    "Thanked him for his time.",
  ]) {
    expectNoFacts(note, "call", `thanks-only, no zman mention ("${note}")`);
  }

  // 10. Broadcast safety -- the real mass-broadcast Zman template (26 real
  // corpus rows, all `source: 'manual'`/shared-route, which never reach
  // extraction in production) must not become a donor fact merely because
  // it contains "zman": no appreciation/support language is present.
  expectNoFacts("Sent time lapse video from first name of the zman", "text", "real broadcast Zman template");

  // The other real broadcast template ("...welcome son (or grandson) back
  // for the new zman", 14 real corpus rows) DOES still produce a fact --
  // but proven here to be entirely because of the pre-existing "son" entry
  // in FACT_SIGNAL_PATTERN (added well before this task), NOT because of
  // the new Zman/appreciation rule: the new pattern alone does not match
  // this sentence (no thank/support word at all). This is a real,
  // pre-existing gap unrelated to Zman/Yahrtzeit, out of this task's
  // scope -- see docs/AI-HANDOFF.md. Documented here, not silently papered
  // over: this sentence is not extraction-eligible in production anyway
  // (it only ever arrives via the shared/broadcast route, which never
  // calls these functions), so it is not a live regression risk today.
  const grandsonBroadcastNote = "Sent message to welcome son (or grandson) back for the new zman";
  const grandsonBroadcastDetails = relationshipSnapshotDetails(grandsonBroadcastNote, "text");
  assert.ok(grandsonBroadcastDetails.specificFacts.length > 0, "pre-existing 'son' fact-signal match on this sentence, unrelated to this task's change");

  // ---- Part 7: the new Zman snapshot itself must not surface the
  // known people-extraction false positive ("Zman"/"Yahrtzeit" as a name)
  // -- specificFacts/actionableRelationshipSnapshot never include the
  // `people` array, so the bug does not affect the newly generated
  // snapshot content, and is correctly left untouched in this task. ----
  assert.doesNotMatch(zachterSnapshot, /People mentioned/i, "the Zman snapshot must never surface the people-extraction internals");
  assert.doesNotMatch(semmelmanSnapshot, /People mentioned/i, "the Yahrtzeit snapshot must never surface the people-extraction internals");

  // ---- explicit acceptance still required before any write (unchanged) ----
  const interactionRoute = await (await import("node:fs/promises")).readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
  assert.match(
    interactionRoute,
    /if \(!scheduled && body\.acceptRelationshipSnapshot === true\) \{/,
    "relationship_summary/institutional_memory must still only be written when explicitly accepted -- unaffected by the vocabulary changes in this file",
  );

  console.log("relationship-snapshot-yahrtzeit-zman: ok");
}

await run();
