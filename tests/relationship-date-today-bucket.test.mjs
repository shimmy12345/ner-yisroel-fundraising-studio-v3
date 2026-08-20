import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildImportantDateRelationshipEvents,
  buildYahrtzeitRelationshipDateEvents,
  partitionRelationshipDateEventsByToday,
} from "../lib/workspace/relationship-date-events.ts";
import { localDateOnlyEpoch } from "../lib/workspace/local-time.ts";

// Regression coverage for the Today's-Agenda-birthday-bucketing fix: a
// relationship-date event (birthday/anniversary/yahrtzeit) occurring on
// today's local calendar date must be classified into Today's Agenda, not
// only Coming Up. Root cause was NOT a timezone or recurring-date
// calculation bug -- nextGregorianRecurrence/nextYahrtzeitOccurrence
// already correctly compute a same-day occurrence's dateEpoch as exactly
// today (verified below). The bug was purely a classification/bucketing
// gap: live-data.ts built one combined, unconditional list
// (upcomingRelationshipDates) and app/page.tsx rendered it only under
// Coming Up, with no split for "is this today." This file tests the real
// partition function (partitionRelationshipDateEventsByToday) that closes
// that gap, using the real builders -- not a reimplementation of the split
// logic that could silently drift from the real code.

const TIMEZONE = "America/New_York";
// A timezone deliberately behind UTC (so UTC-midnight-of-local-date !=
// UTC-midnight-of-UTC-date at this NOW) -- the exact condition that would
// expose a double-timezone-conversion bug if the partition ever used
// dayKey/localDayKey on an already-date-only dateEpoch instead of
// localDateOnlyEpoch.
const identityByDonor = new Map([
  ["donor-1", { donorName: "Dr. & Mrs. Yaakov Abdelhak", initials: "YA", donorCode: "12345" }],
]);

function run() {
  // --- 1: birthday TODAY -- exact live regression case (Abdelhak, Aug 19).
  // Picks a NOW where "today" in America/New_York is unambiguously Aug 19
  // regardless of what UTC hour the test happens to run at (noon local). ---
  {
    // Aug 19 noon EDT (UTC-4) = 16:00 UTC.
    const now = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000);
    const events = buildImportantDateRelationshipEvents(
      [{ id: "row-abdelhak", donorId: "donor-1", type: "birthday", personName: "Yaakov Abdelhak", relationship: null, month: 8, day: 19, year: 1967 }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(events.length, 1, "a birthday exactly on today's local date must still produce exactly one event (inside the lead window)");
    const todayEpoch = localDateOnlyEpoch(now, TIMEZONE);
    assert.equal(events[0].dateEpoch, todayEpoch, "a same-day birthday's computed dateEpoch must exactly equal today's date-only epoch -- confirms the recurring-date calculation itself is correct, not the bug");
    assert.equal(events[0].secondaryDateLabel, "Turning 59", "age must still be computed correctly for a same-day birthday");

    const { today, upcoming } = partitionRelationshipDateEventsByToday(events, now, TIMEZONE);
    assert.equal(today.length, 1, "a birthday occurring today must be classified into the 'today' bucket");
    assert.equal(upcoming.length, 0, "a same-day birthday must NOT also appear in the 'upcoming' bucket -- no unintentional duplication");
    assert.equal(today[0].id, events[0].id);
  }

  // --- 2: birthday TOMORROW -- must land in 'upcoming', not 'today'. ---
  {
    const now = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000);
    const events = buildImportantDateRelationshipEvents(
      [{ id: "row-tomorrow", donorId: "donor-1", type: "birthday", personName: "Someone", relationship: null, month: 8, day: 20, year: null }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(events.length, 1);
    const { today, upcoming } = partitionRelationshipDateEventsByToday(events, now, TIMEZONE);
    assert.equal(today.length, 0, "tomorrow's birthday must not appear in today's bucket");
    assert.equal(upcoming.length, 1, "tomorrow's birthday must appear in the upcoming bucket");
  }

  // --- 3: birthday YESTERDAY (already passed) -- the builder itself must
  // never produce a past occurrence in the first place (it always finds
  // the NEXT occurrence on or after now), so "yesterday" recurs next year,
  // landing far outside the 14-day lead window and producing no event at
  // all -- confirming the partition never has to handle a stale/past
  // event because the builder structurally excludes it upstream. ---
  {
    const now = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000);
    const events = buildImportantDateRelationshipEvents(
      [{ id: "row-yesterday", donorId: "donor-1", type: "birthday", personName: "Someone", relationship: null, month: 8, day: 18, year: null }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(events.length, 0, "a birthday whose month/day already passed this year must recur next year, well outside the lead window -- no event, nothing for the partition to misclassify");
  }

  // --- 4: timezone boundary near UTC midnight -- a birthday landing on
  // "today" in America/New_York but a DIFFERENT calendar date in raw UTC
  // must still classify correctly, proving the partition uses the same
  // date-only-epoch convention as the occurrence calculation itself,
  // never a second timezone-aware day-key comparison. NOW is chosen at
  // 2026-08-20T02:00:00Z, which is 2026-08-19T22:00 EDT (still Aug 19
  // locally) -- if the partition instead ran dayKey(event.dateEpoch,
  // timezone) against an already-date-only UTC-midnight value, it would
  // wrongly read as Aug 18 in America/New_York (UTC midnight of Aug 19 is
  // 8pm EDT on Aug 18), misclassifying a real same-day event as
  // yesterday/outside today. ---
  {
    const now = Math.floor(Date.parse("2026-08-20T02:00:00Z") / 1000);
    const localToday = localDateOnlyEpoch(now, TIMEZONE);
    const events = buildImportantDateRelationshipEvents(
      [{ id: "row-boundary", donorId: "donor-1", type: "birthday", personName: "Boundary Person", relationship: null, month: 8, day: 19, year: null }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(events.length, 1, "the Aug 19 birthday must still be found relative to America/New_York's Aug 19, even though raw UTC is already Aug 20");
    assert.equal(events[0].dateEpoch, localToday);
    const { today, upcoming } = partitionRelationshipDateEventsByToday(events, now, TIMEZONE);
    assert.equal(today.length, 1, "the birthday must classify as today in America/New_York despite the UTC-midnight boundary having already passed");
    assert.equal(upcoming.length, 0);
  }

  // --- 5: anniversary shares the exact same builder/path as birthday, so
  // the same-day classification must behave identically. ---
  {
    const now = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000);
    const events = buildImportantDateRelationshipEvents(
      [{ id: "row-anniv", donorId: "donor-1", type: "anniversary", personName: null, relationship: null, month: 8, day: 19, year: 2010 }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "anniversary");
    const { today, upcoming } = partitionRelationshipDateEventsByToday(events, now, TIMEZONE);
    assert.equal(today.length, 1, "a same-day anniversary must classify as today, exactly like a same-day birthday");
    assert.equal(upcoming.length, 0);
  }

  // --- 6: yahrtzeit behavior remains unchanged -- a same-day yahrtzeit
  // must ALSO now classify as today (the fix applies uniformly to all
  // three relationship-date types, since partitionRelationshipDateEventsByToday
  // operates generically on WorkspaceRelationshipDateEvent, never
  // branching on .type), and an outside-window yahrtzeit is unaffected. ---
  {
    // 2026-08-19 is 6 Elul 5786; use that exact Hebrew date so the
    // yahrtzeit's Gregorian occurrence lands on today.
    const now = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000);
    const todaysYahrtzeit = buildYahrtzeitRelationshipDateEvents(
      [{ id: "yz-today", donorId: "donor-1", deceasedNameEnglish: "Someone", deceasedNameHebrew: null, relationship: "Father", hebrewMonth: "Elul", hebrewDay: 6 }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(todaysYahrtzeit.length, 1, "sanity: 6 Elul must fall on 2026-08-19 for this NOW");
    const todayEpoch = localDateOnlyEpoch(now, TIMEZONE);
    assert.equal(todaysYahrtzeit[0].dateEpoch, todayEpoch, "sanity: the yahrtzeit's computed occurrence must actually be today");
    const { today, upcoming } = partitionRelationshipDateEventsByToday(todaysYahrtzeit, now, TIMEZONE);
    assert.equal(today.length, 1, "a same-day yahrtzeit must classify as today, same as birthday/anniversary");
    assert.equal(upcoming.length, 0);

    // A far-future yahrtzeit is unaffected by this change -- still
    // produces no event at all (outside the lead window), exactly as
    // before this fix.
    const farFuture = buildYahrtzeitRelationshipDateEvents(
      [{ id: "yz-far", donorId: "donor-1", deceasedNameEnglish: "Someone Else", deceasedNameHebrew: null, relationship: "Mother", hebrewMonth: "Nissan", hebrewDay: 1 }],
      identityByDonor,
      TIMEZONE,
      now,
    );
    assert.equal(farFuture.length, 0, "yahrtzeit outside the lead window is unaffected by the today-bucketing fix");
  }

  // --- 7: no duplicate same-day event across Today's Agenda and Coming
  // Up -- structural guarantee, not just a same-input check. Every event
  // that qualifies (mixed types, mixed dates) appears in exactly one of
  // the two returned buckets; the union recovers the original list
  // exactly, and today/upcoming never share an id. ---
  {
    const now = Math.floor(Date.parse("2026-08-19T16:00:00Z") / 1000);
    const mixed = [
      ...buildImportantDateRelationshipEvents(
        [
          { id: "row-a", donorId: "donor-1", type: "birthday", personName: "Today Person", relationship: null, month: 8, day: 19, year: null },
          { id: "row-b", donorId: "donor-1", type: "anniversary", personName: null, relationship: null, month: 8, day: 25, year: 2015 },
        ],
        identityByDonor, TIMEZONE, now,
      ),
      ...buildYahrtzeitRelationshipDateEvents(
        [{ id: "yz-c", donorId: "donor-1", deceasedNameEnglish: "Someone", deceasedNameHebrew: null, relationship: "Father", hebrewMonth: "Elul", hebrewDay: 6 }],
        identityByDonor, TIMEZONE, now,
      ),
    ].sort((a, b) => a.dateEpoch - b.dateEpoch);
    assert.equal(mixed.length, 3, "sanity: three distinct qualifying events");
    const { today, upcoming } = partitionRelationshipDateEventsByToday(mixed, now, TIMEZONE);
    assert.equal(today.length + upcoming.length, mixed.length, "every event must land in exactly one bucket -- none dropped");
    const todayIds = new Set(today.map((e) => e.id));
    const upcomingIds = new Set(upcoming.map((e) => e.id));
    for (const id of todayIds) assert.equal(upcomingIds.has(id), false, "an event in the today bucket must never also appear in the upcoming bucket");
    assert.deepEqual([...todayIds].sort(), ["important-date:row-a", "yahrtzeit:yz-c"].sort(), "both same-day events (birthday + yahrtzeit) must land in today, the later anniversary must not");
  }

  console.log("Relationship-date today/upcoming bucketing checks passed.");
}

run();

async function runIntegrationChecks() {
  // --- 8: live-data.ts actually routes through the real partition
  // function and exposes todayRelationshipDates on WorkspaceBrief -- not
  // just the pure builder-level behavior above. ---
  const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  assert.match(liveData, /partitionRelationshipDateEventsByToday/, "live-data.ts must route the combined event list through the real partition function, not reimplement the split inline");
  assert.match(liveData, /todayRelationshipDates:\s*WorkspaceRelationshipDateEvent\[\]/, "WorkspaceBrief must expose todayRelationshipDates as its own typed field");
  assert.match(liveData, /return \{[^}]*todayRelationshipDates,\s*upcomingRelationshipDates,/, "the loader's return statement must include todayRelationshipDates ahead of upcomingRelationshipDates");

  // --- 9: Today's Agenda actually renders todayRelationshipDates, and its
  // count includes them -- the product-visible half of the fix, not just
  // the data layer. ---
  const todayPage = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const agendaSectionMatch = todayPage.match(/<section className="today-command-section today-agenda"[\s\S]*?<\/section>/);
  assert.ok(agendaSectionMatch, "the Today's Agenda section must exist and be readable as one block");
  assert.match(agendaSectionMatch[0], /data\.todayRelationshipDates/, "Today's Agenda must render data.todayRelationshipDates");
  assert.match(agendaSectionMatch[0], /agendaQueueCount \+ data\.todaySchedule\.length \+ data\.todayRelationshipDates\.length/, "the Today's Agenda count badge must include todayRelationshipDates");

  // --- 10: Coming Up no longer double-counts today's events -- it still
  // renders data.upcomingRelationshipDates (now correctly excluding
  // today), and does not ALSO render todayRelationshipDates. ---
  const comingUpSectionMatch = todayPage.match(/<section className="today-command-section today-coming-up"[\s\S]*?<\/section>/);
  assert.ok(comingUpSectionMatch, "the Coming Up section must exist and be readable as one block");
  assert.match(comingUpSectionMatch[0], /data\.upcomingRelationshipDates/, "Coming Up must still render data.upcomingRelationshipDates");
  assert.doesNotMatch(comingUpSectionMatch[0], /data\.todayRelationshipDates/, "Coming Up must not also render todayRelationshipDates -- no intentional duplication");

  console.log("Relationship-date today-bucket live-data/page integration checks passed.");
}

await runIntegrationChecks();
