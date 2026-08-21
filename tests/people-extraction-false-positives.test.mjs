import assert from "node:assert/strict";
import { relationshipSnapshotDetails, actionableRelationshipSnapshot, extractInteraction } from "../lib/capture/interaction.ts";

// Regression for the 2026-08-21 people-extraction false-positive
// investigation and fix (see docs/AI-HANDOFF.md "People-Extraction
// False-Positive Investigation and Fix"). mentionedPeople() -- a pure
// capitalized-word regex with an exclusion list, no NER, no AI -- was
// misreading capitalized non-person words as donor names. Root cause:
// (1) an incomplete exclusion list (missing real evidenced non-name
// words: Zman, Yahrtzeit, Kollel, Dropped, Imported, Source), and (2) two
// structural gaps in how the exclusion list was applied -- a leading
// excluded word inside a multi-word capitalized span didn't stop the
// WHOLE span from being read as one name ("Discussed Kollel"), and the
// verb-follower check ("X about/with/regarding/via") applied anywhere in
// the note instead of only at a sentence boundary, dropping real names
// that merely happened to precede "about" mid-sentence ("Spoke with
// Yaakov about the new Zman" lost "Yaakov"). This file exercises the
// real, unmodified extraction functions -- never a reimplementation.

function expectNoPeople(note, kind, label) {
  const details = relationshipSnapshotDetails(note, kind);
  assert.deepEqual(details.people, [], `${label}: "${note}" must not extract any person from this non-person term`);
}

async function run() {
  // ---- Real corpus false positives, now excluded ----
  expectNoPeople("Texted video from first day of Zman and thanked him for his support that makes it happen.", "text", "Zachter (60830) real note -- Zman");
  expectNoPeople("Sent text on wife's Yahrtzeit to acknowledge it.", "personal", "Semmelman (72957) real note -- Yahrtzeit");
  expectNoPeople("Discussed Kollel donation and said to follow up after succos", "call", "Weinschneider (68390) real note -- Kollel (multi-word leading-verb strip)");
  expectNoPeople("Dropped off bottle of schnaps for son's bar mitzvah", "visit", "Danziger (63618) real note -- Dropped");
  expectNoPeople("Imported from Monday.com pipeline export. Source due date: 2025-09-15.", "note", "Monday-import provenance boilerplate -- Imported/Source");

  // ---- False-negative protection: real names must survive even when
  // adjacent to one of the newly-excluded terms (Phase 4/6 required cases) ----
  const yaakovDetails = relationshipSnapshotDetails("Spoke with Yaakov about the new Zman.", "call");
  assert.deepEqual(yaakovDetails.people, ["Yaakov"], "Yaakov must remain recognized as a person even though 'about' follows it mid-sentence and 'Zman' is nearby");

  const davidDetails = relationshipSnapshotDetails("Called David on his wife's Yahrtzeit.", "call");
  assert.deepEqual(davidDetails.people, ["David"], "David must remain recognized as a person even though 'Yahrtzeit' is nearby");

  const rabbiDetails = relationshipSnapshotDetails("Met Rabbi Cohen at the Yeshiva.", "meeting");
  assert.deepEqual(rabbiDetails.people, ["Rabbi Cohen"], "a genuine two-word name preceded by an excluded verb ('Met') must keep the name intact, not be reduced or entirely dropped");

  // ---- Documented, acknowledged, unevidenced edge case (not fixed): a
  // period immediately after a capitalized word ("Mr.") breaks the
  // multi-word match before it can join "Zman" -- "Zman" is still
  // correctly excluded (via VERB_FOLLOWER_PATTERN's "about", independent
  // of the new exclusion list), but "Mr" survives alone as a
  // pre-existing, unrelated regex limitation. No real corpus evidence of
  // "Zman" or any newly-excluded word being an actual donor surname
  // exists, so this is not fixed here -- documented instead. ----
  const mrZmanDetails = relationshipSnapshotDetails("Spoke with Mr. Zman about his pledge.", "call");
  assert.ok(!mrZmanDetails.people.includes("Zman"), "Zman itself must never appear as a person");
  assert.deepEqual(mrZmanDetails.people, ["Mr"], "documents the known 'Mr.' truncation edge case -- not a regression introduced by this fix, unchanged before and after");

  // ---- Existing legitimate-name extraction must be completely unaffected ----
  const coffeeDetails = relationshipSnapshotDetails("Coffee with Elena. She loved Maya's update and wants to visit campus this fall. I promised to send the outcomes brief.", "meeting");
  assert.deepEqual(coffeeDetails.people, ["Elena", "Maya"], "genuine names in the repo's own existing regression case must still be captured unchanged");

  // ---- Phase 7: the recently-completed Relationship Snapshot work must
  // be completely untouched by this people-only fix ----
  const zachterSnapshot = actionableRelationshipSnapshot("Texted video from first day of Zman and thanked him for his support that makes it happen", "text");
  assert.equal(zachterSnapshot, "Texted video from first day of Zman and thanked him for his support that makes it happen.", "Zachter's approved relationship_summary must be produced identically after this fix");

  const semmelmanSnapshot = actionableRelationshipSnapshot("Sent text on wife's Yahrtzeit to acknowledge it", "personal");
  assert.equal(semmelmanSnapshot, "Sent text on wife's Yahrtzeit to acknowledge it.", "Semmelman's approved relationship_summary must be produced identically after this fix");

  const zachterMemory = extractInteraction("Texted video from first day of Zman and thanked him for his support that makes it happen", "text", "").memory;
  assert.equal(zachterMemory, "Text Message context: Texted video from first day of Zman and thanked him for his support that makes it happen", "Zachter's institutional_memory template must be produced identically after this fix");

  const semmelmanMemory = extractInteraction("Sent text on wife's Yahrtzeit to acknowledge it", "personal", "").memory;
  assert.equal(semmelmanMemory, "Personal interaction context: Sent text on wife's Yahrtzeit to acknowledge it", "Semmelman's institutional_memory template must be produced identically after this fix");

  console.log("people-extraction-false-positives: ok");
}

await run();
