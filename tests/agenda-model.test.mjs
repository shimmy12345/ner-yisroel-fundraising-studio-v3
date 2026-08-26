import assert from "node:assert/strict";
import { buildAgenda } from "../lib/agenda/agenda-model.ts";

const NOW = Math.floor(Date.parse("2026-08-26T14:00:00Z") / 1000); // 9 AM EDT, Wednesday Aug 26 2026
const BASE_URL = "https://fundraising-os-staging.sgoldstein.workers.dev";

function priority(overrides) {
  return {
    queueId: "priority:default",
    donorId: "donor-x",
    name: "Default Donor",
    initials: "DD",
    donorCode: "1",
    label: "Reminder",
    signal: "steady",
    reason: "Do something",
    why: "Because reasons",
    action: "Open donor",
    href: "/donors/donor-x",
    dueAt: null,
    dueLabel: "No due date recorded",
    bucket: "upcoming",
    ...overrides,
  };
}

function scheduledActivity(overrides) {
  return {
    id: "activity-default",
    donorId: "donor-x",
    type: "meeting",
    typeLabel: "Meeting",
    time: "2:00",
    period: "PM",
    date: "Aug 26",
    donorName: "Default Donor",
    donorCode: "1",
    initials: "DD",
    subject: "Discuss campaign",
    note: "Discuss campaign",
    prepareHref: null,
    openHref: "/donors/donor-x",
    editHref: "/interactions/activity-default/edit",
    logOutcomeHref: "/interactions/activity-default/outcome",
    canCancel: true,
    ...overrides,
  };
}

function relationshipDateEvent(overrides) {
  return {
    id: "date-default",
    type: "yahrtzeit",
    donorId: "donor-x",
    donorName: "Default Donor",
    initials: "DD",
    donorCode: "1",
    label: "Yahrtzeit",
    relationshipPhrase: "Mother's yahrtzeit",
    secondaryDateLabel: "5 Elul",
    provenanceName: "Chana Weiss",
    provenanceNameHebrew: null,
    dateLabel: "Aug 26, 2026",
    dateEpoch: NOW,
    ambiguous: false,
    ...overrides,
  };
}

function emptyBrief(overrides) {
  return {
    overview: "",
    recommendation: "",
    priorities: [],
    priorityCount: 0,
    relationshipQueue: { overdue: [], today: [], thisWeek: [], upcoming: [] },
    morningBrief: { meetingsToday: 0, overdueFollowUps: 0, recentGifts: 0, upcomingReminders: 0, suggestedPriority: null },
    recentlyViewed: [],
    recentlyUpdated: [],
    todaySchedule: [],
    upcomingActivities: [],
    meetings: [],
    gifts: [],
    todayRelationshipDates: [],
    upcomingRelationshipDates: [],
    generatedAt: NOW,
    ...overrides,
  };
}

async function run() {
  // --- Subject/date label always reflect the real America/New_York
  // calendar date, in the requested format. ---
  {
    const agenda = buildAgenda(emptyBrief(), { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.subject, "Fundraising Agenda — Wednesday, August 26");
    assert.equal(agenda.dateLabel, "Wednesday, August 26");
  }

  // --- Empty-agenda behavior: every section empty, isEmpty true. ---
  {
    const agenda = buildAgenda(emptyBrief(), { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.isEmpty, true);
    assert.deepEqual(agenda.todayPriorities, []);
    assert.deepEqual(agenda.overdue, []);
    assert.deepEqual(agenda.importantDates, []);
    assert.deepEqual(agenda.suggested, []);
  }

  // --- Due-today reminder (including an Ask follow-up, which is just a
  // reminder like any other) -> TODAY'S PRIORITIES, with a concise
  // "why now" (dueLabel), an absolute donor link, and ordering preserved
  // from the already-ranked relationshipQueue.today. ---
  {
    const askFollowUp = priority({
      queueId: "priority:donor-2:ask",
      donorId: "donor-2",
      name: "Mr. & Mrs. Levy",
      donorCode: "58200",
      reason: "Follow up on the $500 building fund ask.",
      why: "Due today. Follow up on the $500 building fund ask.",
      href: "/donors/donor-2",
      dueAt: NOW,
      dueLabel: "Due today",
    });
    const callReminder = priority({
      queueId: "priority:donor-3:call",
      donorId: "donor-3",
      name: "Mr. & Mrs. Katz",
      reason: "Call to check in.",
      href: "/donors/donor-3",
      dueAt: NOW,
      dueLabel: "Due today",
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [], today: [askFollowUp, callReminder], thisWeek: [], upcoming: [] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.todayPriorities.length, 2);
    assert.equal(agenda.todayPriorities[0].donorName, "Mr. & Mrs. Levy");
    assert.equal(agenda.todayPriorities[0].headline, "Follow up on the $500 building fund ask.");
    assert.equal(agenda.todayPriorities[0].context, "Due today", "a due item's context is its own dueLabel, not the redundant `why` text");
    assert.equal(agenda.todayPriorities[0].href, `${BASE_URL}/donors/donor-2`, "donor links are absolute, using the app's own base URL");
    assert.equal(agenda.todayPriorities[1].donorName, "Mr. & Mrs. Katz");
    assert.equal(agenda.overdue.length, 0);
    assert.equal(agenda.isEmpty, false);
  }

  // --- Overdue classification: an item in relationshipQueue.overdue
  // renders in OVERDUE, never in TODAY'S PRIORITIES. ---
  {
    const overdueReminder = priority({
      queueId: "priority:donor-4:overdue",
      donorId: "donor-4",
      name: "Mr. & Mrs. Roth",
      reason: "Send the updated pledge form.",
      href: "/donors/donor-4",
      dueAt: NOW - 5 * 86400,
      dueLabel: "Overdue Aug 21",
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [overdueReminder], today: [], thisWeek: [], upcoming: [] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.overdue.length, 1);
    assert.equal(agenda.overdue[0].headline, "Send the updated pledge form.");
    assert.equal(agenda.overdue[0].context, "Overdue Aug 21");
    assert.equal(agenda.todayPriorities.length, 0);
  }

  // --- Suggested: only undated (dueAt === null) recommendation-kind
  // items qualify, using the recommendation's own `why` reasoning as
  // context (there's no due label worth showing), capped to a small
  // number (3), in the existing rank order. A future-DATED reminder
  // (dueAt set, just not today/overdue) must never appear here at all. ---
  {
    const suggestions = ["A", "B", "C", "D", "E"].map((letter, index) =>
      priority({
        queueId: `priority:suggest-${letter}`,
        donorId: `donor-suggest-${letter}`,
        name: `Donor ${letter}`,
        reason: `Reach out and reference: item ${letter}.`,
        why: `It's been ${40 + index} days since your last substantive contact.`,
        href: `/donors/donor-suggest-${letter}`,
        dueAt: null,
        dueLabel: "No due date recorded",
      }),
    );
    const futureDatedReminder = priority({
      queueId: "priority:future",
      donorId: "donor-future",
      name: "Future Donor",
      reason: "Not due yet",
      href: "/donors/donor-future",
      dueAt: NOW + 3 * 86400,
      dueLabel: "Due in 3 days",
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [], today: [], thisWeek: [], upcoming: [...suggestions, futureDatedReminder] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.suggested.length, 3, "capped to a small number, not every eligible suggestion");
    assert.deepEqual(agenda.suggested.map((item) => item.donorName), ["Donor A", "Donor B", "Donor C"], "existing rank order preserved, not re-sorted");
    assert.equal(agenda.suggested[0].context, "It's been 40 days since your last substantive contact.");
    assert.ok(!agenda.suggested.some((item) => item.donorName === "Future Donor"), "a future-dated (not yet due) reminder must never appear as a Suggested item");
  }

  // --- Important Dates / Stewardship: today's yahrtzeit (with deceased
  // name + Hebrew date context) and today's scheduled meeting (with the
  // Meeting Brief link preferred over the plain donor link, and its note
  // shown only when it differs from the subject). ---
  {
    const yahrtzeit = relationshipDateEvent({
      id: "yahrtzeit-1",
      donorId: "donor-5",
      donorName: "Mr. & Mrs. Weiss",
      relationshipPhrase: "Mother's yahrtzeit",
      provenanceName: "Chana Weiss",
      provenanceNameHebrew: "חנה",
      secondaryDateLabel: "5 Elul",
    });
    const meeting = scheduledActivity({
      id: "activity-1",
      donorId: "donor-6",
      donorName: "Mr. & Mrs. Adler",
      typeLabel: "Meeting",
      time: "2:00",
      period: "PM",
      subject: "Discuss capital campaign",
      note: "Bring the updated pledge form",
      prepareHref: "/donors/donor-6/meeting-brief",
      openHref: "/donors/donor-6",
    });
    const call = scheduledActivity({
      id: "activity-2",
      donorId: "donor-7",
      donorName: "Mr. & Mrs. Fine",
      typeLabel: "Call",
      time: "4:30",
      period: "PM",
      subject: "Check in",
      note: "Check in", // identical to subject -- no separate note
      prepareHref: null,
      openHref: "/donors/donor-7",
    });
    const brief = emptyBrief({ todayRelationshipDates: [yahrtzeit], todaySchedule: [meeting, call] });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.importantDates.length, 3);
    const [dateItem, meetingItem, callItem] = agenda.importantDates;
    assert.equal(dateItem.headline, "Mother's yahrtzeit today");
    assert.equal(dateItem.context, "Chana Weiss (חנה) · 5 Elul");
    assert.equal(dateItem.href, `${BASE_URL}/donors/donor-5`);
    assert.equal(meetingItem.headline, "Meeting at 2:00 PM — Discuss capital campaign");
    assert.equal(meetingItem.context, "Bring the updated pledge form");
    assert.equal(meetingItem.href, `${BASE_URL}/donors/donor-6/meeting-brief`, "a meeting links to its Meeting Brief, not just the donor page");
    assert.equal(callItem.headline, "Call at 4:30 PM — Check in");
    assert.equal(callItem.context, null, "no separate note is shown when it's identical to the subject");
    assert.equal(callItem.href, `${BASE_URL}/donors/donor-7`);
  }

  // --- Deduplication, case 1: a genuine due-today item must never also
  // appear as a Suggested item for the same underlying action, even if a
  // future change to the upstream data ever violated the donor-level
  // dedup loadWorkspaceBrief itself normally guarantees -- this module's
  // own dedupeAcrossSections is a second, independent safety net. ---
  {
    const dueToday = priority({
      queueId: "priority:donor-8:today",
      donorId: "donor-8",
      name: "Mr. & Mrs. Stern",
      reason: "Follow up on the $250 dinner ask.",
      href: "/donors/donor-8",
      dueAt: NOW,
      dueLabel: "Due today",
    });
    const sameActionAsSuggestion = priority({
      queueId: "priority:donor-8:duplicate-suggestion",
      donorId: "donor-8",
      name: "Mr. & Mrs. Stern",
      reason: "Follow up on the $250 dinner ask.", // identical headline, same donor
      why: "It's been 60 days.",
      href: "/donors/donor-8",
      dueAt: null,
      dueLabel: "No due date recorded",
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [], today: [dueToday], thisWeek: [], upcoming: [sameActionAsSuggestion] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.todayPriorities.length, 1);
    assert.equal(agenda.suggested.length, 0, "the duplicate must be dropped from Suggested, not shown twice");
  }

  // --- Deduplication, case 2: OVERDUE outranks Suggested too (not just
  // Today's Priorities) -- the fixed priority order is overdue, then
  // today, then important dates, then suggested; a collision always
  // keeps the earliest of those and drops the rest. ---
  {
    const overdueAction = priority({
      queueId: "priority:donor-9:overdue",
      donorId: "donor-9",
      name: "Mr. & Mrs. Berg",
      reason: "Send the updated pledge form.",
      href: "/donors/donor-9",
      dueAt: NOW - 86400,
      dueLabel: "Overdue Aug 25",
    });
    const duplicateSuggestion = priority({
      queueId: "priority:donor-9:duplicate-suggestion",
      donorId: "donor-9",
      name: "Mr. & Mrs. Berg",
      reason: "Send the updated pledge form.", // identical headline, same donor
      why: "It's been 50 days.",
      href: "/donors/donor-9",
      dueAt: null,
      dueLabel: "No due date recorded",
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [overdueAction], today: [], thisWeek: [], upcoming: [duplicateSuggestion] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.overdue.length, 1);
    assert.equal(agenda.suggested.length, 0, "the duplicate must be dropped from Suggested in favor of the overdue placement");
  }

  // --- Different underlying actions for the same donor, even with
  // superficially related text, are never over-eagerly collapsed --
  // dedup keys on exact (donorId, headline) text, not a fuzzy match. ---
  {
    const overdueAction = priority({
      queueId: "priority:donor-10:overdue",
      donorId: "donor-10",
      name: "Mr. & Mrs. Fine",
      reason: "Prepare for scheduled call",
      href: "/donors/donor-10",
      dueAt: NOW - 86400,
      dueLabel: "Overdue Aug 25",
    });
    const unrelatedSchedule = scheduledActivity({
      id: "activity-10",
      donorId: "donor-10",
      donorName: "Mr. & Mrs. Fine",
      typeLabel: "Call",
      subject: "Prepare for scheduled call", // same words, but composed into a genuinely different headline string
      note: "Prepare for scheduled call",
    });
    const agenda = buildAgenda(
      emptyBrief({ relationshipQueue: { overdue: [overdueAction], today: [], thisWeek: [], upcoming: [] }, todaySchedule: [unrelatedSchedule] }),
      { now: NOW, baseUrl: BASE_URL },
    );
    assert.equal(agenda.overdue.length, 1);
    assert.equal(agenda.importantDates.length, 1, "a scheduled activity is never suppressed just because a reminder mentions similar words");
  }

  console.log("agenda-model: all assertions passed");
}

await run();
