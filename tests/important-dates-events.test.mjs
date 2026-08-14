import assert from "node:assert/strict";
import { buildImportantDateRelationshipEvents, buildYahrtzeitRelationshipDateEvents } from "../lib/workspace/relationship-date-events.ts";

// NOW = 2026-08-13T12:00:00Z (30 Av 5786). "Aug 16" is 3 days out (inside
// the 14-day lead window); "Aug 20" is 7 days out (also inside); "Jan 1" is
// far outside.
const NOW = Math.floor(Date.parse("2026-08-13T12:00:00Z") / 1000);
const TIMEZONE = "America/New_York";

function run() {
  const identityByDonor = new Map([
    ["donor-1", { donorName: "Mr. David Cohen", initials: "DC", donorCode: "10001" }],
    ["donor-2", { donorName: "Mr. & Mrs. Cohen", initials: "MC", donorCode: "10002" }],
  ]);

  // --- birthday within window: relationshipPhrase is possessive, no
  // secondaryDateLabel when year is unknown, provenanceName is null
  // (the person is already named in relationshipPhrase). ---
  const birthdayEvents = buildImportantDateRelationshipEvents(
    [{ id: "row-1", donorId: "donor-1", type: "birthday", personName: "David Cohen", relationship: "Donor", month: 8, day: 16, year: null }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(birthdayEvents.length, 1);
  const birthday = birthdayEvents[0];
  assert.equal(birthday.type, "birthday");
  assert.equal(birthday.label, "Birthday");
  assert.equal(birthday.donorId, "donor-1");
  assert.equal(birthday.donorName, "Mr. David Cohen");
  assert.equal(birthday.relationshipPhrase, "David Cohen's birthday");
  assert.equal(birthday.secondaryDateLabel, null, "no derived age when the birth year is unknown");
  assert.equal(birthday.provenanceName, null, "the celebrant is already named in relationshipPhrase, so provenanceName stays null to avoid a redundant line");
  assert.equal(birthday.id, "important-date:row-1");

  // --- birthday with a known year: secondaryDateLabel carries the
  // display-only derived age, computed from the occurrence's own year. ---
  const birthdayWithAge = buildImportantDateRelationshipEvents(
    [{ id: "row-2", donorId: "donor-1", type: "birthday", personName: "David Cohen", relationship: null, month: 8, day: 16, year: 1985 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(birthdayWithAge[0].secondaryDateLabel, "Turning 41");

  // --- anniversary within window: household-level phrase, no person name. ---
  const anniversaryEvents = buildImportantDateRelationshipEvents(
    [{ id: "row-3", donorId: "donor-2", type: "anniversary", personName: null, relationship: null, month: 8, day: 20, year: 2010 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(anniversaryEvents.length, 1);
  const anniversary = anniversaryEvents[0];
  assert.equal(anniversary.type, "anniversary");
  assert.equal(anniversary.label, "Anniversary");
  assert.equal(anniversary.relationshipPhrase, "Wedding anniversary");
  assert.equal(anniversary.secondaryDateLabel, "16 years married");
  assert.equal(anniversary.provenanceName, null);

  // --- outside the lead window: no event. ---
  const outsideWindow = buildImportantDateRelationshipEvents(
    [{ id: "row-4", donorId: "donor-1", type: "birthday", personName: "Someone", relationship: null, month: 1, day: 1, year: null }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(outsideWindow.length, 0);

  // --- a donor missing from identityByDonor is silently skipped. ---
  const missingIdentity = buildImportantDateRelationshipEvents(
    [{ id: "row-5", donorId: "donor-unknown", type: "birthday", personName: "Someone", relationship: null, month: 8, day: 16, year: null }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.equal(missingIdentity.length, 0);

  // --- Feb 29 ambiguity propagates onto the event, exactly like yahrtzeit's
  // Adar-leap-year ambiguity does. ---
  const nowNearFeb = Math.floor(Date.parse("2027-02-20T12:00:00Z") / 1000);
  const feb29Events = buildImportantDateRelationshipEvents(
    [{ id: "row-6", donorId: "donor-1", type: "birthday", personName: "Leap Person", relationship: null, month: 2, day: 29, year: null }],
    identityByDonor,
    TIMEZONE,
    nowNearFeb,
  );
  assert.equal(feb29Events.length, 1);
  assert.equal(feb29Events[0].ambiguous, true, "a Feb 29 birthday falling in a non-leap year must be flagged ambiguous, not silently shown as Feb 28");
  assert.equal(feb29Events[0].dateLabel.includes("28"), true, "the displayed date must be the Feb 28 fallback");

  // --- long person names are never length-truncated by the data layer --
  // relationshipPhrase normalizes casing by design (see possessivePhrase),
  // but every word of a long name must still be present, in full, not
  // cut short. ---
  const longName = "Alexander Bartholomew Featherstonehaugh-Winterbourne III";
  const longNameEvents = buildImportantDateRelationshipEvents(
    [{ id: "row-7", donorId: "donor-1", type: "birthday", personName: longName, relationship: null, month: 8, day: 16, year: null }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  assert.match(longNameEvents[0].relationshipPhrase.toLowerCase(), new RegExp(longName.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "a long person name must not be length-truncated by the data layer, even though display casing is normalized");

  console.log("Important-date relationship-event checks passed.");

  // --- chronological sort with MIXED Yahrtzeit/Birthday/Anniversary events
  // -- exactly what live-data.ts does: build each type separately, then
  // concatenate and re-sort by dateEpoch. Multiple events on the same exact
  // date (Aug 16: David's yahrtzeit-fixture-coincident 3 Elul, David's
  // birthday, and a second same-day birthday) must all survive. ---
  const yahrtzeitEvents = buildYahrtzeitRelationshipDateEvents(
    [{ id: "yz-1", donorId: "donor-2", deceasedNameEnglish: "Someone", deceasedNameHebrew: null, relationship: "Mother", hebrewMonth: "Elul", hebrewDay: 3 }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  const sameDayBirthday = buildImportantDateRelationshipEvents(
    [{ id: "row-8", donorId: "donor-2", type: "birthday", personName: "Same Day Person", relationship: null, month: 8, day: 16, year: null }],
    identityByDonor,
    TIMEZONE,
    NOW,
  );
  const mixed = [...yahrtzeitEvents, ...birthdayEvents, ...anniversaryEvents, ...sameDayBirthday].sort((a, b) => a.dateEpoch - b.dateEpoch);
  assert.equal(mixed.length, 4, "all four qualifying events across all three types must survive the merge");
  const epochs = mixed.map((event) => event.dateEpoch);
  assert.deepEqual([...epochs].sort((a, b) => a - b), epochs, "the merged list must be in non-decreasing chronological order");
  // Every event landing on the exact same Gregorian date (Aug 16, shared by
  // the yahrtzeit fixture and two distinct birthdays) must remain visible,
  // not merged or deduplicated away.
  const aug16Events = mixed.filter((event) => event.dateEpoch === birthday.dateEpoch);
  assert.equal(aug16Events.length, 3, "three distinct events falling on the same Gregorian date must all remain visible");
  assert.deepEqual(new Set(aug16Events.map((event) => event.type)), new Set(["yahrtzeit", "birthday"]), "the same-day events must span more than one relationship-date type");
  const types = new Set(mixed.map((event) => event.type));
  assert.deepEqual(types, new Set(["yahrtzeit", "birthday", "anniversary"]), "all three relationship-date types must be able to coexist in one Coming Up list");

  console.log("Mixed relationship-date chronological sort checks passed.");
}

run();
