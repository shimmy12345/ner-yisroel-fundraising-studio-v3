import { extractInteraction, type InteractionKind } from "../capture/interaction.ts";

export type ScheduleBucket = "today" | "upcoming" | "past";
export type ActivityStatus = "scheduled" | "completed" | "no-response" | "cancelled" | "archived" | "logged";
export type ScheduledContextActivity = { type: string; summary: string; source: string; occurredAt: number; createdAt: number };

export function isScheduledActivity(source: string, occurredAt: number, createdAt: number) {
  if (isCancelledActivity(source) || isArchivedActivity(source) || isCompletedActivity(source)) return false;
  return source.startsWith("capture-scheduled:") || occurredAt > createdAt;
}

export function isCancelledActivity(source: string) { return source.startsWith("cancelled:"); }
export function isArchivedActivity(source: string) { return source.startsWith("archived:"); }
export function isCompletedActivity(source: string) { return source.startsWith("capture-completed:"); }
export function completedPlannedAt(source: string) {
  let value = source;
  while (value.startsWith("cancelled:")) value = value.slice("cancelled:".length);
  const match = /^capture-completed:(\d+):/.exec(value);
  return match ? Number(match[1]) : null;
}
export function isNoResponseActivity(source: string) { return /^capture-completed:\d+:no-response:/.test(source); }

export function activityStatus(source: string, occurredAt: number, createdAt: number): ActivityStatus {
  if (isArchivedActivity(source)) return "archived";
  if (isCancelledActivity(source)) return "cancelled";
  if (isNoResponseActivity(source)) return "no-response";
  if (isCompletedActivity(source)) return "completed";
  if (isScheduledActivity(source, occurredAt, createdAt)) return "scheduled";
  return "logged";
}

export function originalActivitySource(source: string) {
  let value = source;
  while (value.startsWith("cancelled:")) value = value.slice("cancelled:".length);
  const completed = /^capture-completed:\d+:(?:completed|no-response):(.*)$/.exec(value);
  return completed?.[1] ?? value;
}

export function reopenActivitySource(source: string, type: string) {
  const original = originalActivitySource(source);
  return original.startsWith("capture-scheduled:") ? original : `capture-scheduled:reopened:${type}`;
}

function localDay(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epoch * 1000));
}

export function scheduleBucket(source: string, occurredAt: number, createdAt: number, now: number, timezone: string): ScheduleBucket | null {
  if (!isScheduledActivity(source, occurredAt, createdAt)) return null;
  if (localDay(occurredAt, timezone) === localDay(now, timezone)) return "today";
  return occurredAt > now ? "upcoming" : "past";
}

export function sanitizeScheduledRelationshipContext(summary: string | null, memory: string | null, activities: ScheduledContextActivity[]) {
  let safeSummary = summary;
  let safeMemory = memory;
  const allowedKinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal"]);
  for (const activity of activities) {
    if (!isScheduledActivity(activity.source, activity.occurredAt, activity.createdAt)) continue;
    const [subject = "Activity", ...noteParts] = activity.summary.split("\n");
    const kind = allowedKinds.has(activity.type as InteractionKind) ? activity.type as InteractionKind : "note";
    const extracted = extractInteraction(noteParts.join("\n") || subject, kind, subject);
    if (safeSummary === extracted.relationshipSummary) safeSummary = null;
    if (safeMemory === extracted.memory) safeMemory = null;
  }
  return { summary: safeSummary, memory: safeMemory };
}
