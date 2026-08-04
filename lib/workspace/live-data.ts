import { env } from "cloudflare:workers";
import type { DataMode } from "./mode";
import { scheduleBucket } from "./scheduled-activity";
import { dedupeRelationshipQueue, groupRelationshipQueue, isRecentPastEvent, relationshipQueueBucket, type RelationshipQueueBucket } from "./relationship-queue";

type PriorityRow = { recommendation_id: string; donor_id: string; display_name: string; action: string; reason: string; score: number; due_at: number | null; updated_at: number };
type GivingRow = { id: string; donor_id: string; display_name: string; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; description: string | null; item_type: string | null; updated_at: number };
type ContactRow = { id: string; display_name: string; last_contact: number | null; recent_activity: number | null };
type DonorRow = { id: string; display_name: string; updated_at: number };
type DonorDateRow = { donor_id: string; value: number | null };
type ScheduledActivityRow = { id: string; donor_id: string; display_name: string; type: string; occurred_at: number; summary: string; source: string; created_at: number; updated_at: number };
type DonorLinkRow = { donor_id: string; display_name: string; event_at: number };
type DismissalRow = { item_key: string };

export type WorkspacePriority = { queueId: string; recommendationId?: string; donorId: string; name: string; initials: string; label: string; signal: "warm" | "steady" | "cool"; reason: string; why: string; action: string; href: string; dueAt: number | null; dueLabel: string; bucket: RelationshipQueueBucket };
export type WorkspaceMeeting = { donorId: string; time: string; period: string; title: string; detail: string };
export type WorkspaceScheduledActivity = { id: string; donorId: string; type: string; typeLabel: string; time: string; period: string; date: string; donorName: string; subject: string; note: string; prepareHref: string | null; openHref: string; editHref: string; logOutcomeHref: string | null; canCancel: boolean };
export type WorkspaceGift = { id: string; donorId: string; name: string; initials: string; amount: string; detail: string };
export type WorkspaceDonorLink = { donorId: string; name: string; initials: string; detail: string; href: string };
export type WorkspaceMorningBrief = { meetingsToday: number; overdueFollowUps: number; recentGifts: number; upcomingReminders: number; suggestedPriority: WorkspacePriority | null };
export type WorkspaceBrief = { overview: string; recommendation: string; priorities: WorkspacePriority[]; priorityCount: number; relationshipQueue: Record<RelationshipQueueBucket, WorkspacePriority[]>; morningBrief: WorkspaceMorningBrief; recentlyViewed: WorkspaceDonorLink[]; recentlyUpdated: WorkspaceDonorLink[]; todaySchedule: WorkspaceScheduledActivity[]; upcomingActivities: WorkspaceScheduledActivity[]; meetings: WorkspaceMeeting[]; gifts: WorkspaceGift[]; generatedAt: number };

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
  return { time: `${parts.find((part) => part.type === "hour")?.value}:${parts.find((part) => part.type === "minute")?.value}`, period: parts.find((part) => part.type === "dayPeriod")?.value ?? "" };
}

function dayKey(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(epoch * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
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
  const [reminders, giving, donors, lastContacts, lastActivities, scheduledActivities, dismissals, recentViews, recentUpdates] = await Promise.all([
    env.DB.prepare(`SELECT r.id AS recommendation_id, r.donor_id, d.display_name, r.action, r.reason, r.score, r.due_at, r.updated_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE ${demo ? "" : "r.user_id = ? AND"} r.status = 'open' AND ${donorScope}
      ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at, r.score DESC LIMIT 50`).bind(...(demo ? [] : [userId, userId])).all<PriorityRow>(),
    env.DB.prepare(`SELECT ga.id, ga.donor_id, d.display_name, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description, ga.item_type, ga.updated_at
      FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
      WHERE ${demo ? "ga.record_origin = 'sample' AND" : "ga.owner_user_id = ? AND ga.record_origin = 'live' AND"} ${donorScope} AND ga.workspace_status = 'active' AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
      ORDER BY ga.activity_date DESC LIMIT 300`).bind(...(demo ? [] : [userId, userId])).all<GivingRow>(),
    env.DB.prepare(`SELECT d.id, d.display_name, d.updated_at FROM donors d WHERE ${donorScope} ORDER BY d.display_name LIMIT 500`).bind(...(demo ? [] : [userId])).all<DonorRow>(),
    env.DB.prepare(`SELECT donor_id, MAX(occurred_at) AS value FROM interactions ${demo ? "WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample') AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))" : "WHERE user_id = ? AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))"} GROUP BY donor_id`).bind(...(demo ? [now] : [userId, now])).all<DonorDateRow>(),
    env.DB.prepare(`SELECT donor_id, MAX(activity_date) AS value FROM giving_activities ${demo ? "WHERE record_origin = 'sample' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift') AND donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')" : "WHERE owner_user_id = ? AND record_origin = 'live' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift')"} GROUP BY donor_id`).bind(...(demo ? [] : [userId])).all<DonorDateRow>(),
    env.DB.prepare(`SELECT i.id, i.donor_id, d.display_name, i.type, i.occurred_at, i.summary, i.source, i.created_at, i.updated_at
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE ${demo ? "d.data_source = 'sample'" : "i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL"}
        AND (i.source LIKE 'capture-scheduled:%' OR i.occurred_at > i.created_at)
        AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%' AND i.source NOT LIKE 'capture-completed:%'
        AND i.occurred_at >= ? ORDER BY i.occurred_at LIMIT 500`).bind(...(demo ? [now - 86400] : [userId, userId, now - 86400])).all<ScheduledActivityRow>(),
    demo ? Promise.resolve({ results: [] as DismissalRow[] }) : env.DB.prepare("SELECT item_key FROM relationship_queue_dismissals WHERE user_id = ?").bind(userId).all<DismissalRow>(),
    demo ? Promise.resolve({ results: [] as DonorLinkRow[] }) : env.DB.prepare(`SELECT d.id AS donor_id, d.display_name, v.viewed_at AS event_at
      FROM donor_views v JOIN donors d ON d.id = v.donor_id
      WHERE v.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL
      ORDER BY v.viewed_at DESC LIMIT 6`).bind(userId, userId).all<DonorLinkRow>(),
    env.DB.prepare(`SELECT d.id AS donor_id, d.display_name,
        MAX(d.updated_at,
          COALESCE((SELECT MAX(i.updated_at) FROM interactions i WHERE i.donor_id=d.id ${demo ? "" : "AND i.user_id=?"}),0),
          COALESCE((SELECT MAX(r.updated_at) FROM recommendations r WHERE r.donor_id=d.id ${demo ? "" : "AND r.user_id=?"}),0),
          COALESCE((SELECT MAX(ga.updated_at) FROM giving_activities ga WHERE ga.donor_id=d.id ${demo ? "AND ga.record_origin='sample'" : "AND ga.owner_user_id=? AND ga.record_origin='live'"}),0)
        ) AS event_at
      FROM donors d WHERE ${donorScope}
      ORDER BY event_at DESC, d.display_name COLLATE NOCASE LIMIT 6`).bind(...(demo ? [] : [userId, userId, userId, userId])).all<DonorLinkRow>(),
  ]);

  const contactByDonor = new Map(lastContacts.results.map((item) => [item.donor_id, item.value]));
  const activityByDonor = new Map(lastActivities.results.map((item) => [item.donor_id, item.value]));
  const contacts: ContactRow[] = donors.results.map((item) => ({ id: item.id, display_name: item.display_name, last_contact: contactByDonor.get(item.id) ?? null, recent_activity: Math.max(item.updated_at, contactByDonor.get(item.id) ?? 0, activityByDonor.get(item.id) ?? 0) }));
  type RankedPriority = Omit<WorkspacePriority, "bucket"> & { rank: number; sortAt: number };
  const ranked: RankedPriority[] = [];
  const todayKey = dayKey(now, timezone);

  for (const item of reminders.results) {
    const overdue = item.due_at != null && dayKey(item.due_at, timezone) < todayKey;
    const dueToday = item.due_at != null && dayKey(item.due_at, timezone) === todayKey;
    const dueSoon = item.due_at != null && item.due_at <= now + 7 * 86400;
    ranked.push({ queueId: `reminder:${item.recommendation_id}:${item.updated_at}`, rank: overdue ? 0 : dueToday ? 2 : 5, sortAt: item.due_at ?? Number.MAX_SAFE_INTEGER, recommendationId: item.recommendation_id, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: overdue ? "Overdue follow-up" : dueToday ? "Due today" : dueSoon ? "Due this week" : "Upcoming reminder", signal: overdue ? "cool" : "steady", reason: item.action, why: item.due_at ? `${overdue ? "Was due" : "Due"} ${dateLabel(item.due_at, timezone)}. ${item.reason}` : item.reason, action: "Open donor", href: `/donors/${encodeURIComponent(item.donor_id)}`, dueAt: item.due_at, dueLabel: item.due_at ? `${overdue ? "Overdue" : "Due"} ${dateLabel(item.due_at, timezone)}` : "No due date recorded" });
  }

  for (const item of scheduledActivities.results) {
    const bucket = scheduleBucket(item.source, item.occurred_at, item.created_at, now, timezone);
    if (!bucket) continue;
    const time = timeParts(item.occurred_at, timezone);
    const isToday = bucket === "today";
    ranked.push({ queueId: `activity:${item.id}:${item.updated_at}`, rank: isToday ? 1 : 5, sortAt: item.occurred_at, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: `${activityTypeLabel(item.type)} ${isToday ? "today" : "scheduled"}`, signal: "warm", reason: item.summary.split("\n")[0] || `Scheduled ${activityTypeLabel(item.type).toLowerCase()}`, why: `Scheduled for ${dateLabel(item.occurred_at, timezone)} at ${time.time} ${time.period}.`, action: item.type === "meeting" ? "Prepare" : "Open", href: item.type === "meeting" ? `/donors/${encodeURIComponent(item.donor_id)}/meeting-brief` : `/donors/${encodeURIComponent(item.donor_id)}`, dueAt: item.occurred_at, dueLabel: `${isToday ? "Today" : dateLabel(item.occurred_at, timezone)} at ${time.time} ${time.period}` });
  }

  const recentGiftByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) {
    const recent = isRecentPastEvent(item.activity_date, now, 30);
    const contactedAfterGift = (contactByDonor.get(item.donor_id) ?? 0) >= (item.activity_date ?? 0);
    if ((item.paid_cents ?? 0) > 0 && recent && !contactedAfterGift && !recentGiftByDonor.has(item.donor_id)) recentGiftByDonor.set(item.donor_id, item);
  }
  for (const item of recentGiftByDonor.values()) ranked.push({ queueId: `gift:${item.id}:${item.updated_at}`, rank: 2, sortAt: -(item.activity_date ?? 0), donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: "Recent gift", signal: "warm", reason: `${money(item.paid_cents ?? 0)} gift needs acknowledgment`, why: `${item.description || item.item_type || "Paid gift"} was recorded ${item.activity_date ? dateLabel(item.activity_date, timezone) : "recently"}. No interaction is recorded after the gift.`, action: "Follow up", href: `/capture?donorId=${encodeURIComponent(item.donor_id)}&returnTo=%2F`, dueAt: now, dueLabel: "Suggested today" });

  const openByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) if ((item.balance_cents ?? 0) > 0 && !openByDonor.has(item.donor_id)) openByDonor.set(item.donor_id, item);
  for (const item of openByDonor.values()) ranked.push({ queueId: `commitment:${item.id}:${item.updated_at}`, rank: 3, sortAt: item.activity_date ?? 0, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: "Open commitment", signal: "warm", reason: `${money(item.balance_cents ?? 0)} remains open`, why: `${item.description || item.item_type || "Commitment"}${item.activity_date ? ` from ${dateLabel(item.activity_date, timezone)}` : ""}.`, action: "Review", href: `/donors/${encodeURIComponent(item.donor_id)}`, dueAt: null, dueLabel: "No due date recorded" });

  for (const item of contacts) {
    const days = item.last_contact ? Math.floor((now - item.last_contact) / 86400) : null;
    if (days == null || days >= 90) ranked.push({ queueId: `contact-gap:${item.id}:${item.last_contact ?? 0}`, rank: 4, sortAt: days == null ? Number.MAX_SAFE_INTEGER : -days, donorId: item.id, name: item.display_name, initials: initials(item.display_name), label: "Contact gap", signal: "cool", reason: days == null ? "No meaningful contact recorded" : `${days} days since meaningful contact`, why: item.recent_activity ? `Workspace activity was last recorded ${dateLabel(item.recent_activity, timezone)}.` : "No recent activity is available.", action: "Review", href: `/donors/${encodeURIComponent(item.id)}`, dueAt: null, dueLabel: "Review when able" });
  }

  const activeQueue = dedupeRelationshipQueue(ranked, new Set(dismissals.results.map((item) => item.item_key)));
  const allPriorities: WorkspacePriority[] = activeQueue.map(({ rank: _rank, sortAt: _sortAt, ...item }) => ({ ...item, bucket: relationshipQueueBucket(item.dueAt, now, timezone) }));
  const deduped = allPriorities.slice(0, Math.max(5, Math.min(priorityLimit, 50)));
  const relationshipQueue = groupRelationshipQueue(deduped.map((item, index) => ({ ...item, rank: index, sortAt: item.dueAt ?? Number.MAX_SAFE_INTEGER })), now, timezone);

  const scheduled = scheduledActivities.results.map((item) => ({ row: item, activity: scheduledActivity(item, timezone, now) }));
  const todaySchedule = scheduled.filter(({ row }) => scheduleBucket(row.source, row.occurred_at, row.created_at, now, timezone) === "today").map(({ activity }) => activity);
  const upcomingActivities = scheduled.filter(({ row }) => scheduleBucket(row.source, row.occurred_at, row.created_at, now, timezone) === "upcoming").slice(0, 10).map(({ activity }) => activity);
  const meetings = scheduled.filter(({ row }) => row.type === "meeting" && row.occurred_at >= now).slice(0, 5).map(({ row, activity }) => ({ donorId: row.donor_id, time: activity.time, period: activity.period, title: activity.donorName, detail: `${activity.date} · ${activity.subject}` }));
  const recentGiving = giving.results.filter((item) => (item.paid_cents ?? 0) > 0 && isRecentPastEvent(item.activity_date, now, 30));
  const gifts = recentGiving.slice(0, 8).map((item) => ({ id: item.id, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), amount: money(item.paid_cents ?? 0), detail: `${item.description || item.item_type || "Gift"}${item.activity_date ? ` · ${dateLabel(item.activity_date, timezone)}` : ""}` }));
  const donorLinks = (rows: DonorLinkRow[], verb: string): WorkspaceDonorLink[] => rows.map((item) => ({ donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), detail: `${verb} ${dateLabel(item.event_at, timezone)}`, href: `/donors/${encodeURIComponent(item.donor_id)}` }));
  const recentlyViewed = donorLinks(recentViews.results, "Viewed");
  const recentlyUpdated = donorLinks(recentUpdates.results.filter((item) => item.event_at > 0), "Updated");
  const morningBrief: WorkspaceMorningBrief = {
    meetingsToday: todaySchedule.filter((item) => item.type === "meeting").length,
    overdueFollowUps: reminders.results.filter((item) => item.due_at != null && dayKey(item.due_at, timezone) < todayKey).length,
    recentGifts: recentGiving.length,
    upcomingReminders: reminders.results.filter((item) => item.due_at != null && item.due_at >= now && item.due_at <= now + 7 * 86400).length,
    suggestedPriority: deduped[0] ?? null,
  };
  const scheduledCount = todaySchedule.length + upcomingActivities.length;
  const overview = deduped.length || gifts.length || scheduledCount ? `${deduped.length} relationship priorit${deduped.length === 1 ? "y" : "ies"}, ${scheduledCount} scheduled activit${scheduledCount === 1 ? "y" : "ies"}, and ${gifts.length} recent gift${gifts.length === 1 ? "" : "s"} are visible from your live workspace.` : "Your live workspace has no time-sensitive priorities yet. Import data or log an interaction to build today's brief.";
  const recommendation = deduped[0] ? `Start with ${deduped[0].name}: ${deduped[0].reason}.` : "No recommended action is available until your workspace contains a due reminder, open pledge, recent gift, or relationship activity.";
  return { overview, recommendation, priorities: deduped, priorityCount: allPriorities.length, relationshipQueue, morningBrief, recentlyViewed, recentlyUpdated, todaySchedule, upcomingActivities, meetings, gifts, generatedAt: now };
}
