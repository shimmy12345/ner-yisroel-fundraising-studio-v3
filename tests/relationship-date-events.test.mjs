import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildYahrtzeitRelationshipDateEvents, possessivePhrase } from "../lib/workspace/relationship-date-events.ts";

// NOW (2026-08-13T12:00:00Z) is 30 Av 5786. "3 Elul" is 3 days out
// (inside the 14-day lead window); "28 Av" already passed this year and
// recurs over a year out (well outside the window).
const NOW = Math.floor(Date.parse("2026-08-13T12:00:00Z") / 1000);
const TIMEZONE = "America/New_York";

async function run() {
  const identityByDonor = new Map([
    ["donor-1", { donorName: "Dr. & Mrs. Dov Zeffren", initials: "DZ", donorCode: "43425" }],
    ["donor-2", { donorName: "Mr. & Mrs. Yaakov Pollack", initials: "YP", donorCode: "58183" }],
  ]);

  // --- possessivePhrase: natural display phrasing, with a neutral
  // fallback for anything that isn't a short plain word/phrase (never a
  // broken-grammar output). ---
  assert.equal(possessivePhrase("Mother", "yahrtzeit"), "Mother's yahrtzeit");
  assert.equal(possessivePhrase("father", "yahrtzeit"), "Father's yahrtzeit", "capitalization is normalized for display only");
  assert.equal(possessivePhrase("Brother", "yahrtzeit"), "Brother's yahrtzeit");
  assert.equal(possessivePhrase("Wife", "yahrtzeit"), "Wife's yahrtzeit");
  assert.equal(possessivePhrase("Grandmother", "yahrtzeit"), "Grandmother's yahrtzeit");
  assert.equal(possessivePhrase("Charles", "yahrtzeit"), "Charles' yahrtzeit", "a subject already ending in s takes a bare apostrophe");
  assert.equal(possessivePhrase("", "yahrtzeit"), "Yahrtzeit", "blank relationship text falls back to the neutral noun, not broken grammar");
  assert.equal(possessivePhrase("N/A", "yahrtzeit"), "Yahrtzeit", "punctuation-bearing free text falls back rather than producing \"N/A's yahrtzeit\"");
  assert.equal(possessivePhrase("2nd cousin", "yahrtzeit"), "Yahrtzeit", "text that doesn't start with a letter falls back to neutral phrasing");
  assert.equal(possessivePhrase("a".repeat(30), "yahrtzeit"), "Yahrtzeit", "unexpectedly long relationship text falls back rather than producing an unwieldy phrase");

  // --- within-window yahrtzeit produces a fully-populated event with
  // granular, independent fields (not one flattened string). ---
  const withinWindow = buildYahrtzeitRelationshipDateEvents(
    [{ id: "row-1", donorId: "donor-1", deceasedNameEnglish: "Mattil Tzirel Bas Moshe", deceasedNameHebrew: "מטיל צירל בת משה", relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 3 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(withinWindow.length, 1, "a yahrtzeit inside the lead window must produce exactly one event");
  const event = withinWindow[0];
  assert.equal(event.type, "yahrtzeit");
  assert.equal(event.donorId, "donor-1");
  assert.equal(event.donorName, "Dr. & Mrs. Dov Zeffren");
  assert.equal(event.donorCode, "43425");
  assert.equal(event.label, "Yahrtzeit");
  assert.equal(event.relationshipPhrase, "Mother's yahrtzeit", "relationship must be rendered as natural possessive phrasing");
  assert.equal(event.hebrewDateLabel, "3 Elul", "the Hebrew date must be its own field, not folded into another string");
  assert.equal(event.provenanceName, "Mattil Tzirel Bas Moshe", "the deceased's name must remain available as its own field");
  assert.equal(event.provenanceNameHebrew, "מטיל צירל בת משה");
  assert.ok(event.dateEpoch > NOW, "the Gregorian occurrence must be in the future relative to now");
  assert.equal(event.ambiguous, false);
  assert.equal(event.id, "yahrtzeit:row-1", "the event id must be derived from the real yahrtzeit row id, not synthesized");

  // --- deceased name and relationship happening to contain the same text
  // is valid data, not a duplicate-rendering bug -- both fields must
  // survive independently and unaltered. ---
  const matchingFields = buildYahrtzeitRelationshipDateEvents(
    [{ id: "row-match", donorId: "donor-2", deceasedNameEnglish: "mother", deceasedNameHebrew: null, relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 5 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(matchingFields.length, 1);
  assert.equal(matchingFields[0].relationshipPhrase, "Mother's yahrtzeit", "relationship phrasing must still be produced normally");
  assert.equal(matchingFields[0].provenanceName, "mother", "the deceased name field must be preserved byte-for-byte, not suppressed or deduplicated because it matches the relationship text");

  // --- long donor names are passed through unaltered -- wrapping is a
  // presentation (CSS) concern, not something the data layer truncates. ---
  const longName = "Dr. & Mrs. Alexander Bartholomew Featherstonehaugh-Winterbourne III";
  const longNameIdentity = new Map([["donor-3", { donorName: longName, initials: "AF", donorCode: "99001" }]]);
  const longNameEvents = buildYahrtzeitRelationshipDateEvents(
    [{ id: "row-long", donorId: "donor-3", deceasedNameEnglish: "Someone", deceasedNameHebrew: null, relationship: "Father", hebrewMonth: "Elul", hebrewDay: 3 }],
    longNameIdentity,
    TIMEZONE,
    NOW,
  );
  assert.equal(longNameEvents.length, 1);
  assert.equal(longNameEvents[0].donorName, longName, "a long donor name must not be truncated by the data layer");

  // --- outside-window yahrtzeit produces no event at all. ---
  const outsideWindow = buildYahrtzeitRelationshipDateEvents(
    [{ id: "row-2", donorId: "donor-1", deceasedNameEnglish: "Someone", deceasedNameHebrew: null, relationship: "Uncle", hebrewMonth: "Av", hebrewDay: 28 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(outsideWindow.length, 0, "a yahrtzeit far outside the lead window must produce no Coming Up event");

  // --- a donor missing from identityByDonor is silently skipped, never crashes. ---
  const missingIdentity = buildYahrtzeitRelationshipDateEvents(
    [{ id: "row-3", donorId: "donor-unknown", deceasedNameEnglish: "Someone", deceasedNameHebrew: null, relationship: "Aunt", hebrewMonth: "Elul", hebrewDay: 3 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(missingIdentity.length, 0);

  // --- multiple qualifying yahrtzeits are sorted soonest-first, including
  // when several of them belong to the same donor (two distinct records
  // must never be merged into one event). ---
  const multiple = buildYahrtzeitRelationshipDateEvents(
    [
      { id: "row-later", donorId: "donor-2", deceasedNameEnglish: "Later Person", deceasedNameHebrew: null, relationship: "Father", hebrewMonth: "Elul", hebrewDay: 10 },
      { id: "row-sooner", donorId: "donor-1", deceasedNameEnglish: "Sooner Person", deceasedNameHebrew: null, relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 3 },
      { id: "row-same-donor", donorId: "donor-1", deceasedNameEnglish: "Another Relative", deceasedNameHebrew: null, relationship: "Brother", hebrewMonth: "Elul", hebrewDay: 8 },
    ],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(multiple.length, 3, "three distinct qualifying yahrtzeit records must produce three distinct events, even with two for the same donor");
  assert.deepEqual(multiple.map((item) => item.id), ["yahrtzeit:row-sooner", "yahrtzeit:row-same-donor", "yahrtzeit:row-later"], "events must be sorted by soonest occurrence first, including across multiple records for one donor");
  assert.equal(multiple[0].donorId, "donor-1");
  assert.equal(multiple[1].donorId, "donor-1");
  assert.notEqual(multiple[0].id, multiple[1].id, "two records for the same donor must remain two separate events, not merged");

  // --- ambiguous recurrence is surfaced on the event, never hidden or
  // silently resolved -- 8 Adar's next occurrence lands in a leap year
  // relative to this NOW (verified in tests/yahrtzeit-recurrence.test.mjs). ---
  const ambiguousEvents = buildYahrtzeitRelationshipDateEvents(
    [{ id: "row-adar", donorId: "donor-1", deceasedNameEnglish: "Pinchas Leib Ben Yosef", deceasedNameHebrew: null, relationship: "Brother", hebrewMonth: "Adar", hebrewDay: 8 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  if (ambiguousEvents.length > 0) assert.equal(ambiguousEvents[0].ambiguous, true, "an ambiguous recurrence must be flagged on the event, not silently resolved");

  console.log("Relationship-date event builder checks passed.");

  // --- source-level: yahrtzeit_outreach must never need to win the
  // canonical ranking to be visible on the homepage -- it's excluded from
  // the ranked/relationshipQueue path entirely, and Coming Up is built
  // from a separate, unconditional path instead. ---
  const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  assert.match(liveData, /if \(recommendation\.kind === "yahrtzeit_outreach"\) continue;/, "yahrtzeit_outreach must be excluded from the ranked homepage path, so it never has to beat other candidates to appear in Coming Up");
  assert.match(liveData, /buildYahrtzeitRelationshipDateEvents/, "the homepage must build Coming Up events through the dedicated, unconditional path");
  assert.match(liveData, /upcomingRelationshipDates/, "WorkspaceBrief must expose the Coming Up events separately from the ranked priorities");

  // --- the recommendation engine itself is untouched: yahrtzeit_outreach
  // is still a real candidate, still usable by donor profile/Meeting
  // Brief/Assistant -- this feature narrows where it competes, it does
  // not remove it. ---
  const candidatesSource = await readFile(new URL("../lib/relationships/recommendation-candidates.ts", import.meta.url), "utf8");
  assert.match(candidatesSource, /yahrtzeitOutreachCandidate/, "the yahrtzeit_outreach candidate generator must still exist, unchanged");

  // --- no D1 write of any kind: the pure event module never imports D1 or
  // touches env.DB, so a yahrtzeit appearing in Coming Up structurally
  // cannot create or mutate a reminder, recommendation, or interaction. ---
  const eventsSource = await readFile(new URL("../lib/workspace/relationship-date-events.ts", import.meta.url), "utf8");
  assert.doesNotMatch(eventsSource, /cloudflare:workers|env\.DB|INSERT INTO|UPDATE |DELETE FROM/i, "the relationship-date-events module must be pure -- no D1 access of any kind");
  assert.doesNotMatch(eventsSource, /\brecommendations\b|\binteractions\b/i, "building Coming Up events must never reference the recommendations or interactions tables");

  console.log("Relationship-date event safety checks passed.");

  // --- presentation: the compact row markup must exist, must not branch
  // on event.type (so birthdays/anniversaries render through the exact
  // same row without a new layout), and must not reuse the tall generic
  // scheduled-activity-card scaffolding that caused the oversized cards. ---
  const pageSource = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const rowComponentMatch = pageSource.match(/function RelationshipDateEventRow[\s\S]*?\n}/);
  assert.ok(rowComponentMatch, "a dedicated compact row component must exist for relationship-date events");
  const rowComponentSource = rowComponentMatch[0];
  assert.doesNotMatch(rowComponentSource, /event\.type\s*===/, "the row must render generically from the event's own fields, not branch per relationship-date-event type");
  assert.doesNotMatch(rowComponentSource, /scheduled-activity-card|today-meeting-card/, "the compact row must not inherit the tall generic scheduled-activity-card layout that caused the oversized cards");
  assert.match(rowComponentSource, /relationship-date-row/, "the row must use its own dedicated compact layout class");
  assert.match(rowComponentSource, /event\.relationshipPhrase/, "the row must render the natural relationship phrasing");
  assert.match(rowComponentSource, /event\.provenanceName/, "the row must render the deceased/provenance name as its own, lower-priority line");
  assert.match(rowComponentSource, /dir="rtl"/, "a Hebrew provenance name must be rendered with explicit directionality");

  console.log("Relationship-date row presentation checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
