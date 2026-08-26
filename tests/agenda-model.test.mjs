import assert from "node:assert/strict";
import { buildAgenda } from "../lib/agenda/agenda-model.ts";
import { localDateOnlyEpoch } from "../lib/workspace/local-time.ts";
import { AGENDA_TIMEZONE } from "../lib/agenda/timezone.ts";
import { dedupeRelationshipQueue, groupRelationshipQueue, resolvePriorityCap } from "../lib/workspace/relationship-queue.ts";
import { HOMEPAGE_MAX_RESULTS } from "../lib/workspace/suggestion-candidates.ts";

const NOW = Math.floor(Date.parse("2026-08-26T14:00:00Z") / 1000); // 9 AM EDT, Wednesday Aug 26 2026
const BASE_URL = "https://fundraising-os-staging.sgoldstein.workers.dev";
// The date-only, UTC-midnight-of-local-date value "today" resolves to --
// the same space WorkspaceRelationshipDateEvent.dateEpoch values live in
// (see relationship-date-events.ts's own doc comment on this convention).
// Fixtures below build dateEpoch as TODAY_EPOCH + N*86400 for "N days from
// today," matching exactly how the real occurrence functions compute it.
const TODAY_EPOCH = localDateOnlyEpoch(NOW, AGENDA_TIMEZONE);

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

  // --- Advance notice: birthdays/anniversaries/yahrtzeits inside the
  // email's 7-day window (upcomingRelationshipDates), distinct wording
  // from the exact-today case, boundary at day 7 (included) vs. day 8
  // (excluded), and preserved context (Hebrew date/age/donor link). ---
  {
    const tomorrow = relationshipDateEvent({
      id: "date-tomorrow",
      donorId: "donor-11",
      donorName: "Mr. & Mrs. Katz",
      type: "birthday",
      relationshipPhrase: "Shimmy's birthday",
      secondaryDateLabel: "Turning 12",
      provenanceName: null,
      dateLabel: "Aug 27, 2026",
      dateEpoch: TODAY_EPOCH + 1 * 86400,
    });
    const in5Days = relationshipDateEvent({
      id: "date-in-5",
      donorId: "donor-12",
      donorName: "Mr. & Mrs. Rosen",
      type: "yahrtzeit",
      relationshipPhrase: "Father's yahrtzeit",
      secondaryDateLabel: "5 Elul",
      provenanceName: "Yosef Rosen",
      provenanceNameHebrew: "יוסף",
      dateLabel: "Aug 31, 2026",
      dateEpoch: TODAY_EPOCH + 5 * 86400,
    });
    const atBoundary = relationshipDateEvent({
      id: "date-boundary-7",
      donorId: "donor-13",
      donorName: "Mr. & Mrs. Adler",
      type: "anniversary",
      relationshipPhrase: "Wedding anniversary",
      secondaryDateLabel: "18 years married",
      provenanceName: null,
      dateLabel: "Sep 2, 2026",
      dateEpoch: TODAY_EPOCH + 7 * 86400,
    });
    const justOutsideWindow = relationshipDateEvent({
      id: "date-outside-8",
      donorId: "donor-14",
      donorName: "Mr. & Mrs. Outside",
      type: "birthday",
      relationshipPhrase: "Dovi's birthday",
      dateLabel: "Sep 3, 2026",
      dateEpoch: TODAY_EPOCH + 8 * 86400,
    });
    const todayEvent = relationshipDateEvent({
      id: "date-today",
      donorId: "donor-15",
      donorName: "Mr. & Mrs. Today",
      relationshipPhrase: "Mother's yahrtzeit",
      dateEpoch: TODAY_EPOCH,
    });
    const brief = emptyBrief({
      todayRelationshipDates: [todayEvent],
      upcomingRelationshipDates: [tomorrow, in5Days, atBoundary, justOutsideWindow],
    });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });

    // Today's event, the 3 in-window upcoming events -- never the
    // 8-days-out one.
    assert.equal(agenda.importantDates.length, 4, "exactly today + the 3 events inside the 7-day window; the 8-day-out one must be excluded");
    assert.ok(!agenda.importantDates.some((item) => item.donorName === "Mr. & Mrs. Outside"), "an event 8 days out must never appear -- only through 7 days, per the approved window");

    const byDonor = Object.fromEntries(agenda.importantDates.map((item) => [item.donorName, item]));
    assert.equal(byDonor["Mr. & Mrs. Today"].headline, "Mother's yahrtzeit today", "the exact-today wording is unchanged by this change");
    assert.equal(byDonor["Mr. & Mrs. Katz"].headline, "Shimmy's birthday — Tomorrow, Aug 27, 2026", "1 day out reads as \"Tomorrow\", concise and distinct from today's wording");
    assert.equal(byDonor["Mr. & Mrs. Katz"].context, "Turning 12", "age context is preserved for an upcoming birthday, not just a today one");
    assert.equal(byDonor["Mr. & Mrs. Rosen"].headline, "Father's yahrtzeit — In 5 days, Aug 31, 2026", "multi-day-out reads as \"In N days\" plus the actual date");
    assert.equal(byDonor["Mr. & Mrs. Rosen"].context, "Yosef Rosen (יוסף) · 5 Elul", "deceased name/Hebrew-date context is preserved for an upcoming yahrtzeit");
    assert.equal(byDonor["Mr. & Mrs. Rosen"].href, `${BASE_URL}/donors/donor-12`, "donor link is preserved for an upcoming date, same as today's");
    assert.equal(byDonor["Mr. & Mrs. Adler"].headline, "Wedding anniversary — In 7 days, Sep 2, 2026", "day 7 itself is included -- the window is inclusive of the boundary");

    console.log("agenda-model: advance-notice window checks passed");
  }

  // --- Score-based Suggested re-rank: reproduces the concrete real-data
  // failure from the investigation (docs/AI-HANDOFF.md's Daily
  // Fundraising Agenda Quality Investigation) -- an open_ask candidate
  // scoring 0.8075 was silently discarded before Suggested ever saw it,
  // purely because follow_up_pledge had a better coarse homepage rank
  // tier, never because of real score. Input order deliberately puts the
  // lower-scoring item FIRST, simulating the old coarse-rank ordering
  // that used to privilege it -- proving the output order comes from
  // score, not from whatever order the items arrived in. ---
  {
    const pledgeItem = priority({
      queueId: "priority:pledge-donor:follow_up_pledge",
      donorId: "pledge-donor",
      name: "Mr. & Mrs. Pledge",
      reason: "Follow up on the open $500 pledge.",
      why: "No payment activity in 253 days.",
      href: "/donors/pledge-donor",
      dueAt: null,
      dueLabel: "No due date recorded",
      score: 0.65,
    });
    const askItem = priority({
      queueId: "priority:ask-donor:open_ask",
      donorId: "ask-donor",
      name: "Mr. & Mrs. Ask",
      reason: "Follow up on the $10,000 ask.",
      why: "An ask was made 200 days ago and is still pending.",
      href: "/donors/ask-donor",
      dueAt: null,
      dueLabel: "No due date recorded",
      score: 0.8075,
    });
    // Lower-scoring cultivation opportunity -- real from the investigation
    // (Weinschneider, continue_conversation, 0.5600) -- included to prove
    // it does NOT displace the higher-scoring pledge merely for category
    // diversity (see the dedicated diversity test further below too).
    const cultivationItem = priority({
      queueId: "priority:cultivation-donor:continue_conversation",
      donorId: "cultivation-donor",
      name: "Mr. & Mrs. Cultivation",
      reason: "Follow up after succos.",
      why: "A specific follow-up was noted in the most recent text.",
      href: "/donors/cultivation-donor",
      dueAt: null,
      dueLabel: "No due date recorded",
      score: 0.56,
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [], today: [], thisWeek: [], upcoming: [pledgeItem, cultivationItem, askItem] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.suggested.length, 3);
    assert.deepEqual(
      agenda.suggested.map((item) => item.donorName),
      ["Mr. & Mrs. Ask", "Mr. & Mrs. Pledge", "Mr. & Mrs. Cultivation"],
      "Suggested must be ordered by real score (0.8075 > 0.65 > 0.56), not by the input order that used to reflect the old coarse rank tier",
    );

    console.log("agenda-model: score-based Suggested re-rank checks passed");
  }

  // --- The re-rank must never displace a higher-scoring pledge for a
  // lower-scoring cultivation item merely for category diversity -- when
  // MAX_SUGGESTED trims the list, the genuinely higher-scoring items win,
  // full stop. Four pledges (0.65 each) + one weaker cultivation item
  // (0.56): the cultivation item must NOT bump a pledge out of the top 3
  // just to appear. ---
  {
    const pledges = ["A", "B", "C", "D"].map((letter) =>
      priority({
        queueId: `priority:pledge-${letter}`,
        donorId: `pledge-donor-${letter}`,
        name: `Pledge Donor ${letter}`,
        reason: "Follow up on the open pledge.",
        why: "No payment activity in 253 days.",
        href: `/donors/pledge-donor-${letter}`,
        dueAt: null,
        score: 0.65,
      }),
    );
    const weakerCultivation = priority({
      queueId: "priority:cultivation-weak",
      donorId: "cultivation-weak-donor",
      name: "Weaker Cultivation Donor",
      reason: "Reach out and reference: a minor note.",
      why: "A specific, donor-relevant fact is on file.",
      href: "/donors/cultivation-weak-donor",
      dueAt: null,
      score: 0.42,
    });
    const brief = emptyBrief({ relationshipQueue: { overdue: [], today: [], thisWeek: [], upcoming: [...pledges, weakerCultivation] } });
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: BASE_URL });
    assert.equal(agenda.suggested.length, 3, "still capped at MAX_SUGGESTED");
    assert.ok(!agenda.suggested.some((item) => item.donorName === "Weaker Cultivation Donor"), "a genuinely lower-scoring cultivation item must not displace higher-scoring pledges merely to appear -- no artificial diversity quota");
    assert.ok(agenda.suggested.every((item) => item.donorName.startsWith("Pledge Donor")), "the three genuinely highest-scoring items (all pledges here) win on merit");

    console.log("agenda-model: no-artificial-diversity checks passed");
  }

  // --- End-to-end regression: the real dedupeRelationshipQueue ->
  // resolvePriorityCap -> groupRelationshipQueue -> buildAgenda() pipeline,
  // exactly as live-data.ts's loadWorkspaceBriefUncached assembles it --
  // minus only the D1 fetch and per-donor recommendation-scoring loop
  // itself, which require env.DB from cloudflare:workers and have no
  // meaningful mock outside a real Workers/Miniflare runtime (this repo's
  // established limitation for every D1-coupled loader -- see
  // tests/workspace-brief-instrumentation.test.mjs). Reproduces the residual
  // bug found after the Suggested-rerank fix first landed: buildAgenda()'s
  // real-score rerank can only reorder whatever survived an EARLIER
  // coarse-rank slice in live-data.ts, so a genuinely higher-scoring rank-4
  // open_ask could still be discarded there before ever reaching
  // buildAgenda -- the real Allen Pfeiffer/0.8075 case found in the live
  // Independent Staging preview reproduced exactly this. ---
  {
    const OLD_AGENDA_PRIORITY_LIMIT = 50; // send-agenda.ts's value before this fix
    const NEW_AGENDA_PRIORITY_LIMIT = 500; // send-agenda.ts's current value

    // 50 follow_up_pledge candidates (old coarse rank 3) -- on their own
    // enough to fill the old 50-slot cap. Real fixture shape: the exact
    // QueueCandidate fields dedupeRelationshipQueue/groupRelationshipQueue
    // consume (queueId, donorId, dueAt, rank, sortAt) plus the full
    // WorkspacePriority fields buildAgenda's priorityToItem reads --
    // mirroring exactly what live-data.ts's ranked.push(...) produces for a
    // recommendation-kind candidate.
    const pledgeCandidates = Array.from({ length: 50 }, (_, i) => ({
      queueId: `recommendation:pledge-donor-${i}:follow_up_pledge`,
      donorId: `pledge-donor-${i}`,
      name: `Pledge Donor ${i}`,
      initials: "PD",
      donorCode: String(i),
      label: "Pledge follow-up",
      signal: "warm",
      reason: "Follow up on the open pledge.",
      why: "No payment activity in 200+ days.",
      action: "Follow up",
      href: `/donors/pledge-donor-${i}`,
      dueAt: null,
      dueLabel: "No due date recorded",
      score: 0.65,
      rank: 3,
      sortAt: 1000 + i,
    }));
    // The real evidenced case: an open_ask candidate at 0.8075, old coarse
    // rank 4 (worse than follow_up_pledge's rank 3) despite the higher real
    // score.
    const openAskCandidate = {
      queueId: "recommendation:open-ask-donor:open_ask",
      donorId: "open-ask-donor",
      name: "Mr. & Mrs. Open Ask",
      initials: "OA",
      donorCode: "999",
      label: "Open Ask",
      signal: "warm",
      reason: "Follow up on the open ask.",
      why: "A specific ask amount and purpose were discussed.",
      action: "Follow up",
      href: "/donors/open-ask-donor",
      dueAt: null,
      dueLabel: "No due date recorded",
      score: 0.8075,
      rank: 4,
      sortAt: 2000,
    };
    const allCandidates = [...pledgeCandidates, openAskCandidate];
    assert.equal(allCandidates.length, 51, "sanity: more than 50 upstream candidates exist in this fixture");
    assert.equal(pledgeCandidates.length, 50, "sanity: 50 rank<=3 items alone are enough to fill the old 50-slot cap");

    function buildRelationshipQueue(priorityCap) {
      const deduped = dedupeRelationshipQueue(allCandidates, new Set()).slice(0, priorityCap);
      const withBucket = deduped.map(({ rank: _rank, sortAt: _sortAt, ...item }) => ({ ...item, bucket: "upcoming" }));
      return groupRelationshipQueue(withBucket.map((item, index) => ({ ...item, rank: index, sortAt: item.dueAt ?? Number.MAX_SAFE_INTEGER })), NOW, AGENDA_TIMEZONE);
    }

    // OLD behavior: the exact prior cap formula and value, before this fix.
    const oldCap = Math.max(5, Math.min(OLD_AGENDA_PRIORITY_LIMIT, HOMEPAGE_MAX_RESULTS));
    const oldQueue = buildRelationshipQueue(oldCap);
    assert.ok(!oldQueue.upcoming.some((item) => item.donorId === "open-ask-donor"), "OLD behavior: the higher-scoring open_ask must have been cut by the coarse-rank cap before ever reaching buildAgenda()");
    const oldAgenda = buildAgenda(emptyBrief({ relationshipQueue: oldQueue }), { now: NOW, baseUrl: BASE_URL });
    assert.ok(!oldAgenda.suggested.some((item) => item.donorName === "Mr. & Mrs. Open Ask"), "OLD end-to-end agenda must not include the open_ask");

    // NEW behavior: the real resolvePriorityCap, for the real "daily-agenda"
    // context and the real current AGENDA_PRIORITY_LIMIT.
    const newCap = resolvePriorityCap("daily-agenda", NEW_AGENDA_PRIORITY_LIMIT, HOMEPAGE_MAX_RESULTS);
    const newQueue = buildRelationshipQueue(newCap);
    assert.ok(newQueue.upcoming.some((item) => item.donorId === "open-ask-donor"), "NEW behavior: the daily-agenda context's own priorityLimit must let the higher-scoring open_ask survive into relationshipQueue.upcoming");
    const newAgenda = buildAgenda(emptyBrief({ relationshipQueue: newQueue }), { now: NOW, baseUrl: BASE_URL });
    assert.equal(newAgenda.suggested[0]?.donorName, "Mr. & Mrs. Open Ask", "buildAgenda() must rank the surviving higher-scoring open_ask above the lower-scoring pledge follow-ups");
    assert.equal(newAgenda.suggested.length, 3, "still capped at MAX_SUGGESTED");

    // The homepage/Today-page path must be provably untouched: same
    // fixture, the homepage's own real context ("today") and real
    // priorityLimit (8) -- resolvePriorityCap must still clamp exactly as
    // before, since 8 < HOMEPAGE_MAX_RESULTS regardless of context.
    const homepageCap = resolvePriorityCap("today", 8, HOMEPAGE_MAX_RESULTS);
    assert.equal(homepageCap, 8, "homepage/Today-page priorityLimit=8 must be completely unaffected by this fix");
    const homepageQueue = buildRelationshipQueue(homepageCap);
    assert.equal(homepageQueue.upcoming.length, 8, "homepage queue must still be capped at its own priorityLimit, exactly as before");
    assert.ok(homepageQueue.upcoming.every((item) => item.donorId.startsWith("pledge-donor")), "homepage's own coarse-rank ordering (rank 3 before rank 4) is completely unchanged -- the open_ask still would not appear in the homepage's own small slice");

    console.log("agenda-model: end-to-end resolvePriorityCap -> relationshipQueue -> buildAgenda() checks passed");
  }

  console.log("agenda-model: all assertions passed");
}

await run();
