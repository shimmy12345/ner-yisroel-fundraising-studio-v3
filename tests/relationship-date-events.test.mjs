import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildYahrtzeitRelationshipDateEvents } from "../lib/workspace/relationship-date-events.ts";

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

  // --- within-window yahrtzeit produces a fully-populated event. ---
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
  assert.match(event.detail, /Mother/, "detail must name the relationship");
  assert.match(event.detail, /Mattil Tzirel Bas Moshe/, "detail must name the deceased (English)");
  assert.match(event.detail, /מטיל צירל בת משה/, "detail must name the deceased (Hebrew) when known");
  assert.match(event.detail, /Elul/, "detail must show the Hebrew date");
  assert.ok(event.dateEpoch > NOW, "the Gregorian occurrence must be in the future relative to now");
  assert.equal(event.ambiguous, false);
  assert.equal(event.id, "yahrtzeit:row-1", "the event id must be derived from the real yahrtzeit row id, not synthesized");

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

  // --- multiple qualifying yahrtzeits are sorted soonest-first. ---
  const multiple = buildYahrtzeitRelationshipDateEvents(
    [
      { id: "row-later", donorId: "donor-2", deceasedNameEnglish: "Later Person", deceasedNameHebrew: null, relationship: "Father", hebrewMonth: "Elul", hebrewDay: 10 },
      { id: "row-sooner", donorId: "donor-1", deceasedNameEnglish: "Sooner Person", deceasedNameHebrew: null, relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 3 },
    ],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(multiple.length, 2);
  assert.equal(multiple[0].id, "yahrtzeit:row-sooner", "events must be sorted by soonest occurrence first");
  assert.equal(multiple[1].id, "yahrtzeit:row-later");

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
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
