// Pure transform: WorkspaceBrief (the same, already-tested data
// lib/workspace/live-data.ts's loadWorkspaceBrief() computes for the
// Today page) -> the four-section Daily Fundraising Agenda structure. No
// D1 access, no network call, no side effect of any kind -- everything
// here is a deterministic function of its inputs, which is what makes it
// safe to unit-test and to reuse for both the real send and the
// no-send preview route.
//
// Section assignment, deliberately:
// - TODAY'S PRIORITIES: relationshipQueue.today only -- reminders/
//   follow-ups (including Ask follow-ups, which reuse the same
//   recommendations-table reminder mechanism) with a real due date of
//   today. Already ordered by the app's own ranking (rank, then due
//   time) -- not re-sorted here.
// - OVERDUE: relationshipQueue.overdue -- the identical reminder
//   mechanism, just past its due date.
// - IMPORTANT DATES / STEWARDSHIP: todayRelationshipDates (yahrtzeit/
//   birthday/anniversary occurring today) plus todaySchedule (a meeting/
//   call/visit already on the calendar for today) plus, since 2026-08-26,
//   upcomingRelationshipDates post-filtered to this email's own
//   AGENDA_RELATIONSHIP_DATE_WINDOW_DAYS (7 days) -- both "today" and
//   "upcoming" are calendar-driven stewardship moments, not reminder-queue
//   items, which is why they're grouped together under this header rather
//   than folded into Today's Priorities. The 7-day window is a pure
//   post-filter of the SAME already-computed upcomingRelationshipDates
//   array the homepage's "Coming Up" section reads (itself bounded by the
//   shared, unchanged 14-day RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) -- no
//   change to that shared constant, to relationship-date-events.ts, or to
//   the homepage's own behavior. An item appears every day it remains
//   inside the 7-day window (re-derived fresh from real dates each time
//   this function runs, so nothing needs to be recorded anywhere to
//   "remember" it was already shown).
// - SUGGESTED: relationshipQueue.upcoming, filtered to items with no real
//   due date at all (dueAt === null -- genuine recommendation-engine
//   suggestions like reconnect_contact_gap/continue_conversation/
//   relationship_opportunity/follow_up_pledge/solicit, never a
//   future-dated reminder), re-sorted by each item's own real
//   WorkspacePriority.score (since 2026-08-26 -- see that field's own doc
//   comment in lib/workspace/live-data.ts for why the homepage's rank/
//   sortAt ordering isn't a substitute for this), then capped to a small
//   number. This re-rank is scoped to this module only -- it never
//   touches relationshipQueue.upcoming's own order, so the homepage's
//   "Coming Up"/queue surfaces are completely unaffected.
//
// Why this can't double-count a reminder as a suggestion: loadWorkspaceBrief
// already runs every reminder/suggestion candidate through
// dedupeRelationshipQueue() (lib/workspace/relationship-queue.ts), which
// keeps at most ONE item per donor across the whole brief before bucketing
// into overdue/today/thisWeek/upcoming. A donor with an overdue or
// due-today reminder therefore cannot simultaneously appear in the
// `upcoming` bucket this module reads for Suggested -- the two pools are
// structurally disjoint, not just filtered to look that way. The
// dedupeItems() pass below is a second, explicit safety net across all
// four rendered sections (including todaySchedule/todayRelationshipDates,
// which are NOT part of that donor-level dedup), so the guarantee holds
// even if a future change to live-data.ts loosens it.

import type { WorkspaceBrief, WorkspacePriority, WorkspaceScheduledActivity } from "../workspace/live-data.ts";
import type { WorkspaceRelationshipDateEvent } from "../workspace/relationship-date-events.ts";
import { localDateOnlyEpoch } from "../workspace/local-time.ts";
import { easternDateLabel, AGENDA_TIMEZONE } from "./timezone.ts";

export type AgendaItem = {
  key: string;
  donorId: string;
  donorName: string;
  donorCode: string | null;
  // "What" -- a short, concrete action or fact, taken verbatim from the
  // already-vetted data this module reads (a reminder's own `reason`, a
  // scheduled activity's subject, a relationship date's phrase) -- never
  // generated or paraphrased here.
  headline: string;
  // "Why now" -- concise supporting context (a due-date label, the
  // recommendation engine's own reasoning, a scheduled activity's note, a
  // yahrtzeit's provenance/Hebrew date), or null when the headline alone
  // already says everything relevant. Never manufactured: always a
  // pass-through of an existing field.
  context: string | null;
  href: string;
};

export type Agenda = {
  subject: string;
  dateLabel: string;
  generatedAt: number;
  todayPriorities: AgendaItem[];
  overdue: AgendaItem[];
  importantDates: AgendaItem[];
  suggested: AgendaItem[];
  isEmpty: boolean;
};

export type BuildAgendaOptions = {
  now: number;
  // The app's own public origin (e.g. https://fundraising-os-staging.
  // sgoldstein.workers.dev), used to turn the app's existing relative
  // donor/capture links (e.g. `/donors/{id}`) into absolute links an email
  // client can actually follow. No trailing slash required.
  baseUrl: string;
};

const MAX_SUGGESTED = 3;

// Email-specific advance-notice window for birthdays/anniversaries/
// yahrtzeits -- deliberately separate from and smaller than the shared
// RELATIONSHIP_DATE_LEAD_WINDOW_DAYS (14) the homepage's "Coming Up" and
// the recommendation engine's own outreach candidates use. A pure
// post-filter of the already-computed upcomingRelationshipDates array
// (itself already bounded by the 14-day constant), chosen per the real-
// data analysis in docs/AI-HANDOFF.md's Daily Fundraising Agenda Quality
// Investigation -- never a change to the shared constant itself.
const AGENDA_RELATIONSHIP_DATE_WINDOW_DAYS = 7;

function absoluteHref(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function priorityToItem(priority: WorkspacePriority, baseUrl: string): AgendaItem {
  const isDue = priority.dueAt != null;
  return {
    key: `priority:${priority.queueId}`,
    donorId: priority.donorId,
    donorName: priority.name,
    donorCode: priority.donorCode,
    headline: priority.reason,
    // A due/overdue reminder's own dueLabel ("Overdue Aug 20" / "Due
    // today") is the concise "why now"; an undated suggestion has no due
    // label worth showing, so its own `why` reasoning text is used
    // instead -- both are existing fields, never composed here.
    context: isDue ? priority.dueLabel : priority.why,
    href: absoluteHref(baseUrl, priority.href),
  };
}

function scheduledActivityToItem(activity: WorkspaceScheduledActivity, baseUrl: string): AgendaItem {
  const context = activity.note && activity.note !== activity.subject ? activity.note : null;
  return {
    key: `schedule:${activity.id}`,
    donorId: activity.donorId,
    donorName: activity.donorName,
    donorCode: activity.donorCode,
    headline: `${activity.typeLabel} at ${activity.time} ${activity.period} — ${activity.subject}`,
    context,
    href: absoluteHref(baseUrl, activity.prepareHref ?? activity.openHref),
  };
}

// Shared context (deceased/provenance name + Hebrew date, or age/years-
// married) for both the exact-today and the advance-notice renderings
// below -- advance notice changes only the headline's own timing phrase,
// never what supporting context is shown alongside it.
function relationshipDateContext(event: WorkspaceRelationshipDateEvent): string | null {
  const contextParts: string[] = [];
  if (event.provenanceName) {
    contextParts.push(event.provenanceNameHebrew ? `${event.provenanceName} (${event.provenanceNameHebrew})` : event.provenanceName);
  }
  if (event.secondaryDateLabel) contextParts.push(event.secondaryDateLabel);
  return contextParts.length ? contextParts.join(" · ") : null;
}

function dateEventToItem(event: WorkspaceRelationshipDateEvent, baseUrl: string): AgendaItem {
  return {
    key: `date:${event.id}`,
    donorId: event.donorId,
    donorName: event.donorName,
    donorCode: event.donorCode,
    headline: `${event.relationshipPhrase} today`,
    context: relationshipDateContext(event),
    href: absoluteHref(baseUrl, `/donors/${encodeURIComponent(event.donorId)}`),
  };
}

// Advance-notice rendering for a relationship date still inside the
// email's 7-day window but not yet today -- a distinct timing phrase
// ("Tomorrow" / "In N days") plus the actual calendar date, so a
// fundraiser can tell at a glance whether something needs action now or
// is worth preparing for (a card, a gift, a call) ahead of time. Never
// used for daysUntil === 0 -- that stays dateEventToItem's "today"
// wording, unchanged, so existing behavior/tests for the exact-today case
// are untouched.
function upcomingDateEventToItem(event: WorkspaceRelationshipDateEvent, baseUrl: string, daysUntil: number): AgendaItem {
  const timing = daysUntil === 1 ? "Tomorrow" : `In ${daysUntil} days`;
  return {
    key: `date:${event.id}`,
    donorId: event.donorId,
    donorName: event.donorName,
    donorCode: event.donorCode,
    headline: `${event.relationshipPhrase} — ${timing}, ${event.dateLabel}`,
    context: relationshipDateContext(event),
    href: absoluteHref(baseUrl, `/donors/${encodeURIComponent(event.donorId)}`),
  };
}

// Applied across all four sections in this fixed priority order (overdue,
// today, important dates, suggested) so a collision always keeps the
// higher-priority placement and drops the later, lower-priority repeat --
// matching "an Ask follow-up due today should appear once as a due
// priority, not again as a generic Suggested Action." The key is donor +
// headline text rather than `key` itself, since `key` is already
// per-source-record unique by construction (it would never collide even
// for a genuine duplicate action).
function dedupeAcrossSections(sections: AgendaItem[][]): AgendaItem[][] {
  const seen = new Set<string>();
  return sections.map((items) =>
    items.filter((item) => {
      const dedupeKey = `${item.donorId}::${item.headline.trim().toLowerCase()}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    }),
  );
}

// Real score first (descending), an unscored item (a real, undated
// fundraiser-created reminder that reached this bucket with no
// recommendation-engine candidate behind it -- rare in practice) treated
// as maximal priority rather than silently buried beneath every scored
// suggestion. Explicit relational comparison, not subtraction -- two
// unscored items would both be Number.POSITIVE_INFINITY, and
// Infinity - Infinity is NaN, not a valid comparator result (same
// footgun lib/workspace/suggestion-candidates.ts's own staleness sort
// already documents and avoids).
function suggestedScoreKey(priority: WorkspacePriority): number {
  return priority.score ?? Number.POSITIVE_INFINITY;
}
function bySuggestedScoreDescending(a: WorkspacePriority, b: WorkspacePriority): number {
  const sa = suggestedScoreKey(a);
  const sb = suggestedScoreKey(b);
  return sa === sb ? 0 : sb > sa ? 1 : -1;
}

export function buildAgenda(brief: WorkspaceBrief, options: BuildAgendaOptions): Agenda {
  const { now, baseUrl } = options;

  const overdueRaw = brief.relationshipQueue.overdue.map((priority) => priorityToItem(priority, baseUrl));
  const todayPriorityRaw = brief.relationshipQueue.today.map((priority) => priorityToItem(priority, baseUrl));

  // Advance notice: post-filter the already-computed upcomingRelationshipDates
  // (itself bounded by the shared 14-day RELATIONSHIP_DATE_LEAD_WINDOW_DAYS,
  // unchanged) down to this email's own 7-day window. daysUntil is derived
  // fresh from each event's own date-only dateEpoch against "today" in the
  // same date-only space (localDateOnlyEpoch) partitionRelationshipDateEventsByToday
  // itself uses -- never a naive (dateEpoch - now)/86400, which could be
  // off by a day depending on what time of day "now" is.
  const todayEpoch = localDateOnlyEpoch(now, AGENDA_TIMEZONE);
  const upcomingDatesInWindow = brief.upcomingRelationshipDates
    .map((event) => ({ event, daysUntil: Math.round((event.dateEpoch - todayEpoch) / 86400) }))
    .filter(({ daysUntil }) => daysUntil >= 1 && daysUntil <= AGENDA_RELATIONSHIP_DATE_WINDOW_DAYS);

  const importantDateRaw = [
    ...brief.todayRelationshipDates.map((event) => dateEventToItem(event, baseUrl)),
    ...brief.todaySchedule.map((activity) => scheduledActivityToItem(activity, baseUrl)),
    ...upcomingDatesInWindow.map(({ event, daysUntil }) => upcomingDateEventToItem(event, baseUrl, daysUntil)),
  ];

  // Suggested: re-rank by each candidate's own real recommendation-engine
  // score (WorkspacePriority.score) rather than trusting the order
  // relationshipQueue.upcoming already arrived in -- that order reflects
  // the homepage's own coarse rank/sortAt tiering (unchanged, still used
  // for the homepage itself), not real merit. This re-rank exists only
  // here; relationshipQueue.upcoming's own array is never mutated or
  // reordered in place.
  const suggestedRaw = [...brief.relationshipQueue.upcoming]
    .filter((priority) => priority.dueAt === null)
    .sort(bySuggestedScoreDescending)
    .slice(0, MAX_SUGGESTED)
    .map((priority) => priorityToItem(priority, baseUrl));

  const [overdue, todayPriorities, importantDates, suggested] = dedupeAcrossSections([
    overdueRaw,
    todayPriorityRaw,
    importantDateRaw,
    suggestedRaw,
  ]);

  return {
    subject: `Fundraising Agenda — ${easternDateLabel(now)}`,
    dateLabel: easternDateLabel(now),
    generatedAt: now,
    todayPriorities,
    overdue,
    importantDates,
    suggested,
    isEmpty: overdue.length === 0 && todayPriorities.length === 0 && importantDates.length === 0 && suggested.length === 0,
  };
}
