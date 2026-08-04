export type RelationshipQueueBucket = "overdue" | "today" | "thisWeek" | "upcoming";

export type QueueCandidate = {
  queueId: string;
  donorId: string;
  dueAt: number | null;
  rank: number;
  sortAt: number;
};

const dayKey = (epoch: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epoch * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

export function relationshipQueueBucket(dueAt: number | null, now: number, timezone: string): RelationshipQueueBucket {
  if (dueAt == null) return "upcoming";
  const today = dayKey(now, timezone);
  const due = dayKey(dueAt, timezone);
  if (due < today) return "overdue";
  if (due === today) return "today";
  if (dueAt <= now + 7 * 86400) return "thisWeek";
  return "upcoming";
}

export function isRecentPastEvent(eventAt: number | null, now: number, days: number) {
  return eventAt != null && eventAt <= now && eventAt >= now - days * 86400;
}

export function dedupeRelationshipQueue<T extends QueueCandidate>(items: T[], dismissedKeys: Set<string>) {
  const ordered = items
    .filter((item) => !dismissedKeys.has(item.queueId))
    .sort((a, b) => a.rank - b.rank || a.sortAt - b.sortAt || a.queueId.localeCompare(b.queueId));
  const seenDonors = new Set<string>();
  return ordered.filter((item) => {
    if (seenDonors.has(item.donorId)) return false;
    seenDonors.add(item.donorId);
    return true;
  });
}

export function groupRelationshipQueue<T extends QueueCandidate>(items: T[], now: number, timezone: string) {
  const groups: Record<RelationshipQueueBucket, T[]> = { overdue: [], today: [], thisWeek: [], upcoming: [] };
  for (const item of items) groups[relationshipQueueBucket(item.dueAt, now, timezone)].push(item);
  return groups;
}
