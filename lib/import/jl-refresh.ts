export type DatedActivity = { activityDate: number | null };

const DAY_SECONDS = 86400;

export function donationExportRange(activities: DatedActivity[]) {
  const dates = activities.map((activity) => activity.activityDate).filter((date): date is number => date !== null && Number.isFinite(date));
  return dates.length ? { start: Math.min(...dates), end: Math.max(...dates) } : { start: null, end: null };
}

export function suggestedDonationRange(lastRangeEnd: number | null, now = new Date()) {
  const end = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
  if (!lastRangeEnd) return { start: null, end, overlapDays: 7 };
  return { start: Math.max(0, lastRangeEnd - (6 * DAY_SECONDS)), end, overlapDays: 7 };
}

export function isoDate(epoch: number | null) {
  return epoch ? new Date(epoch * 1000).toISOString().slice(0, 10) : null;
}
