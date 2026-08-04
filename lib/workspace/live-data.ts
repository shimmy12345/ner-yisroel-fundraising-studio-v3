import { env } from "cloudflare:workers";
import type { DataMode } from "./mode";
import { scheduleBucket } from "./scheduled-activity";

type PriorityRow = { recommendation_id: string; donor_id: string; display_name: string; action: string; reason: string; score: number; due_at: number | null };
type GivingRow = { id: string; donor_id: string; display_name: string; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; description: string | null; item_type: string | null };
type ContactRow = { id: string; display_name: string; last_contact: number | null; recent_activity: number | null };
type DonorRow = { id: string; display_name: string; updated_at: number };
type DonorDateRow = { donor_id: string; value: number | null };
type ScheduledActivityRow = { id: string; donor_id: string; display_name: string; type: string; occurred_at: number; summary: string; source: string; created_at: number };

export type WorkspacePriority = { recommendationId?: string; donorId: string; name: string; initials: string; label: string; signal: "warm" | "steady" | "cool"; reason: string; why: string; action: string; href: string };
export type WorkspaceMeeting = { donorId: string; time: string; period: string; title: string; detail: string };
export type WorkspaceScheduledActivity = { id: string; donorId: string; type: string; typeLabel: string; time: string; period: string; date: string; donorName: string; subject: string; note: string; prepareHref: string | null; openHref: string; editHref: string; logOutcomeHref: string | null; canCancel: boolean };
export type WorkspaceGift = { id: string; donorId: string; name: string; initials: string; amount: string; detail: string };
export type WorkspaceBrief = { overview: string; recommendation: string; priorities: WorkspacePriority[]; priorityCount: number; todaySchedule: WorkspaceScheduledActivity[]; upcomingActivities: WorkspaceScheduledActivity[]; meetings: WorkspaceMeeting[]; gifts: WorkspaceGift[]; generatedAt: number };

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

function dateLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(new Date(epoch * 1000));
}

function timeParts(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(epoch * 1000));
  return { time: `${parts.find((p) => p.type === "hour")?.value}:${parts.find((p) => p.type === "minute")?.value}`, period: parts.find((p) => p.type === "dayPeriod")?.value ?? "" };
}

function dayKey(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch * 1000));
}

function activityTypeLabel(type: string) {
  return ({ call: "Call", email: "Email", meeting: "Meeting", visit: "Visit", note: "Note", personal: "Personal interaction" } as Record<string, string>)[type] ?? "Activity";
}

function scheduledActivity(item: ScheduledActivityRow, timezone: string, now: number): WorkspaceScheduledActivity {
  const [subject = activityTypeLabel(item.type), ...noteParts] = item.summary.split("\n");
  return {
    id: item.id,
    donorId: item.donor_id,
    type: item.type,
    typeLabel: activityTypeLabel(item.type),
    ...timeParts(item.occurred_at, timezone),
    date: dateLabel(item.occurred_at, timezone),
    donorName: item.display_name,
    subject: subject || activityTypeLabel(item.type),
    note: noteParts.join("\n") || subject || "No additional note recorded.",
    prepareHref: item.type === "meeting" ? `/donors/${encodeURIComponent(item.donor_id)}/meeting-brief` : null,
    openHref: `/donors/${encodeURIComponent(item.donor_id)}`,
    editHref: `/interactions/${encodeURIComponent(item.id)}/edit?returnTo=%2F`,
    logOutcomeHref: `/interactions/${encodeURIComponent(item.id)}/outcome`,
    canCancel: item.occurred_at > now,
  };
}

export async function loadWorkspaceBrief(userId: string, timezone: string, mode: DataMode = "live", now = Math.floor(Date.now() / 1000), priorityLimit = 8): Promise<WorkspaceBrief> {
  const demo = mode === "demo";
  const donorScope = demo ? "d.data_source = 'sample'" : "d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL";
  const [reminders, giving, donors, lastContacts, lastActivities, scheduledActivities] = await Promise.all([
    env.DB.prepare(`SELECT r.id AS recommendation_id, r.donor_id, d.display_name, r.action, r.reason, r.score, r.due_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE ${demo ? "" : "r.user_id = ? AND"} r.status = 'open' AND ${donorScope}
      ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at, r.score DESC LIMIT 50`).bind(...(demo ? [] : [userId, userId])).all<PriorityRow>(),
    env.DB.prepare(`SELECT ga.id, ga.donor_id, d.display_name, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description, ga.item_type
      FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
      WHERE ${demo ? "ga.record_origin = 'sample' AND" : "ga.owner_user_id = ? AND ga.record_origin = 'live' AND"} ${donorScope} AND ga.workspace_status = 'active' AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
      ORDER BY ga.activity_date DESC LIMIT 300`).bind(...(demo ? [] : [userId, userId])).all<GivingRow>(),
    env.DB.prepare(`SELECT d.id, d.display_name, d.updated_at FROM donors d WHERE ${donorScope} ORDER BY d.display_name LIMIT 500`).bind(...(demo ? [] : [userId])).all<DonorRow>(),
    env.DB.prepare(`SELECT donor_id, MAX(occurred_at) AS value FROM interactions ${demo ? "WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample') AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))" : "WHERE user_id = ? AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))"} GROUP BY donor_id`).bind(...(demo ? [now] : [userId, now])).all<DonorDateRow>(),
    env.DB.prepare(`SELECT donor_id, MAX(activity_date) AS value FROM giving_activities ${demo ? "WHERE record_origin = 'sample' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift') AND donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')" : "WHERE owner_user_id = ? AND record_origin = 'live' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift')"} GROUP BY donor_id`).bind(...(demo ? [] : [userId])).all<DonorDateRow>(),
    env.DB.prepare(`SELECT i.id, i.donor_id, d.display_name, i.type, i.occurred_at, i.summary, i.source, i.created_at
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE ${demo ? "d.data_source = 'sample'" : "i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'"}
        AND (i.source LIKE 'capture-scheduled:%' OR i.occurred_at > i.created_at)
        AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%'
        AND i.source NOT LIKE 'capture-completed:%'
        AND i.occurred_at >= ?
      ORDER BY i.occurred_at LIMIT 500`).bind(...(demo ? [now - 86400] : [userId, userId, now - 86400])).all<ScheduledActivityRow>(),
  ]);
  const contactByDonor = new Map(lastContacts.results.map((item) => [item.donor_id, item.value]));
  const activityByDonor = new Map(lastActivities.results.map((item) => [item.donor_id, item.value]));
  const contacts: ContactRow[] = donors.results.map((item) => ({ id: item.id, display_name: item.display_name, last_contact: contactByDonor.get(item.id) ?? null, recent_activity: Math.max(item.updated_at, contactByDonor.get(item.id) ?? 0, activityByDonor.get(item.id) ?? 0) }));

  type RankedPriority = WorkspacePriority & { rank: number; sortAt: number };
  const ranked: RankedPriority[] = [];
  const todayKey = dayKey(now, timezone);
  for (const item of reminders.results) {
    const overdue = item.due_at != null && item.due_at < now;
    const dueToday = item.due_at != null && dayKey(item.due_at, timezone) === todayKey;
    const dueSoon = item.due_at != null && item.due_at <= now + 7 * 86400;
    ranked.push({ rank: overdue ? 0 : dueToday ? 2 : 5, sortAt: item.due_at ?? Number.MAX_SAFE_INTEGER, recommendationId: item.recommendation_id, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: overdue ? "Overdue reminder" : dueToday ? "Due today" : dueSoon ? "Due soon" : "Next action", signal: overdue ? "cool" : "steady", reason: item.action, why: item.due_at ? `${overdue ? "Was due" : "Due"} ${dateLabel(item.due_at, timezone)}. ${item.reason}` : item.reason, action: "Open donor", href: `/donors/${encodeURIComponent(item.donor_id)}` });
  }
  for (const item of scheduledActivities.results) {
    if (dayKey(item.occurred_at, timezone) !== todayKey) continue;
    ranked.push({ rank: 1, sortAt: item.occurred_at, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: `${activityTypeLabel(item.type)} today`, signal: "warm", reason: item.summary.split("\n")[0] || `Scheduled ${activityTypeLabel(item.type).toLowerCase()}`, why: `Scheduled for ${timeParts(item.occurred_at, timezone).time} ${timeParts(item.occurred_at, timezone).period} today.`, action: item.type === "meeting" ? "Prepare" : "Open", href: item.type === "meeting" ? `/donors/${encodeURIComponent(item.donor_id)}/meeting-brief` : `/donors/${encodeURIComponent(item.donor_id)}` });
  }
  const recentGiftByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) {
    const recent = (item.activity_date ?? 0) >= now - 30 * 86400;
    const contactedAfterGift = (contactByDonor.get(item.donor_id) ?? 0) >= (item.activity_date ?? 0);
    if ((item.paid_cents ?? 0) > 0 && recent && !contactedAfterGift && !recentGiftByDonor.has(item.donor_id)) recentGiftByDonor.set(item.donor_id, item);
  }
  for (const item of recentGiftByDonor.values()) {
    ranked.push({ rank: 2, sortAt: -(item.activity_date ?? 0), donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: "Recent gift", signal: "warm", reason: `${money(item.paid_cents ?? 0)} gift needs acknowledgment`, why: `${item.description || item.item_type || "Paid gift"} was recorded ${item.activity_date ? dateLabel(item.activity_date, timezone) : "recently"}. No interaction is recorded after the gift.`, action: "Follow up", href: `/capture?donorId=${encodeURIComponent(item.donor_id)}&returnTo=%2F` });
  }
  const openByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) if ((item.balance_cents ?? 0) > 0 && !openByDonor.has(item.donor_id)) openByDonor.set(item.donor_id, item);
  for (const item of openByDonor.values()) ranked.push({ rank: 3, sortAt: item.activity_date ?? 0, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: "Open commitment", signal: "warm", reason: `${money(item.balance_cents ?? 0)} remains open`, why: `${item.description || item.item_type || "Commitment"}${item.activity_date ? ` from ${dateLabel(item.activity_date, timezone)}` : ""}.`, action: "Review", href: `/donors/${encodeURIComponent(item.donor_id)}` });
  for (const item of contacts) {
    const days = item.last_contact ? Math.floor((now - item.last_contact) / 86400) : null;
    if (days == null || days >= 90) ranked.push({ rank: 4, sortAt: days == null ? Number.MAX_SAFE_INTEGER : -days, donorId: item.id, name: item.display_name, initials: initials(item.display_name), label: "Contact gap", signal: "cool", reason: days == null ? "No meaningful contact recorded" : `${days} days since meaningful contact`, why: item.recent_activity ? `Workspace activity was last recorded ${dateLabel(item.recent_activity, timezone)}.` : "No recent activity is available.", action: "Review", href: `/donors/${encodeURIComponent(item.id)}` });
  }
  const ordered = ranked.sort((a, b) => a.rank - b.rank || a.sortAt - b.sortAt);
  const allPriorities = [...new Map(ordered.map((item) => [item.donorId, item])).values()].map(({ rank: _rank, sortAt: _sortAt, ...priority }) => priority);
  const deduped = allPriorities.slice(0, Math.max(5, Math.min(priorityLimit, 50)));
  const scheduled = scheduledActivities.results.map((item) => ({ row: item, activity: scheduledActivity(item, timezone, now) }));
  const todaySchedule = scheduled.filter(({ row }) => scheduleBucket(row.source, row.occurred_at, row.created_at, now, timezone) === "today").map(({ activity }) => activity);
  const upcomingActivities = scheduled.filter(({ row }) => scheduleBucket(row.source, row.occurred_at, row.created_at, now, timezone) === "upcoming").slice(0, 10).map(({ activity }) => activity);
  const meetings = scheduled.filter(({ row }) => row.type === "meeting" && row.occurred_at >= now).slice(0, 5).map(({ row, activity }) => ({ donorId: row.donor_id, time: activity.time, period: activity.period, title: activity.donorName, detail: `${activity.date} · ${activity.subject}` }));
  const gifts = giving.results.filter((item) => (item.paid_cents ?? 0) > 0 && (item.activity_date ?? 0) >= now - 30 * 86400).slice(0, 8).map((item) => ({ id: item.id, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), amount: money(item.paid_cents ?? 0), detail: `${item.description || item.item_type || "Gift"}${item.activity_date ? ` · ${dateLabel(item.activity_date, timezone)}` : ""}` }));
  const scheduledCount = todaySchedule.length + upcomingActivities.length;
  const overview = deduped.length || gifts.length || scheduledCount ? `${deduped.length} relationship priorit${deduped.length === 1 ? "y" : "ies"}, ${scheduledCount} scheduled activit${scheduledCount === 1 ? "y" : "ies"}, and ${gifts.length} recent gift${gifts.length === 1 ? "" : "s"} are visible from your live workspace.` : "Your live workspace has no time-sensitive priorities yet. Import data or log an interaction to build today’s brief.";
  const recommendation = deduped[0] ? `Start with ${deduped[0].name}: ${deduped[0].reason}.` : "No recommended action is available until your workspace contains a due reminder, open pledge, recent gift, or relationship activity.";
  return { overview, recommendation, priorities: deduped, priorityCount: allPriorities.length, todaySchedule, upcomingActivities, meetings, gifts, generatedAt: now };
}
