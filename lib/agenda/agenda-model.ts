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
//   call/visit already on the calendar for today) -- both are
//   calendar-driven stewardship moments, not reminder-queue items, which
//   is why they're grouped together under this header rather than folded
//   into Today's Priorities.
// - SUGGESTED: relationshipQueue.upcoming, filtered to items with no real
//   due date at all (dueAt === null -- genuine recommendation-engine
//   suggestions like reconnect_contact_gap/continue_conversation/
//   relationship_opportunity/follow_up_pledge/solicit, never a
//   future-dated reminder), capped to a small number.
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
import { easternDateLabel } from "./timezone.ts";

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

function dateEventToItem(event: WorkspaceRelationshipDateEvent, baseUrl: string): AgendaItem {
  const contextParts: string[] = [];
  if (event.provenanceName) {
    contextParts.push(event.provenanceNameHebrew ? `${event.provenanceName} (${event.provenanceNameHebrew})` : event.provenanceName);
  }
  if (event.secondaryDateLabel) contextParts.push(event.secondaryDateLabel);
  return {
    key: `date:${event.id}`,
    donorId: event.donorId,
    donorName: event.donorName,
    donorCode: event.donorCode,
    headline: `${event.relationshipPhrase} today`,
    context: contextParts.length ? contextParts.join(" · ") : null,
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

export function buildAgenda(brief: WorkspaceBrief, options: BuildAgendaOptions): Agenda {
  const { now, baseUrl } = options;

  const overdueRaw = brief.relationshipQueue.overdue.map((priority) => priorityToItem(priority, baseUrl));
  const todayPriorityRaw = brief.relationshipQueue.today.map((priority) => priorityToItem(priority, baseUrl));
  const importantDateRaw = [
    ...brief.todayRelationshipDates.map((event) => dateEventToItem(event, baseUrl)),
    ...brief.todaySchedule.map((activity) => scheduledActivityToItem(activity, baseUrl)),
  ];
  const suggestedRaw = brief.relationshipQueue.upcoming
    .filter((priority) => priority.dueAt === null)
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
