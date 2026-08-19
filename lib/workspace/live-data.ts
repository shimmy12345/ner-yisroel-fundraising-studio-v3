import { env } from "cloudflare:workers";
import type { DataMode } from "./mode";
import { scheduleBucket } from "./scheduled-activity";
import { dedupeRelationshipQueue, groupRelationshipQueue, isRecentPastEvent, relationshipQueueBucket, type RelationshipQueueBucket } from "./relationship-queue";
import { financialDateLabel } from "../financial-date.ts";
import { donorInitials, numericDonorCode } from "../relationships/donor-identity.ts";
import { buildRecommendationEvidence } from "../relationships/recommendation-evidence.ts";
import { buildDonorRecommendation } from "../relationships/recommendation-rank.ts";
import type { RecommendationCandidateKind } from "../relationships/recommendation-candidates.ts";
import type { GiftAcknowledgmentStatus, GiftSource } from "../giving/acknowledgment.ts";
import type { HebrewMonthName } from "../calendar/hebrew-date.ts";
import { selectSuggestionDonorIds, HOMEPAGE_MAX_RESULTS } from "./suggestion-candidates.ts";
import { buildYahrtzeitRelationshipDateEvents, buildImportantDateRelationshipEvents, type WorkspaceRelationshipDateEvent } from "./relationship-date-events.ts";
import type { ImportantDateType } from "../important-dates/validation.ts";

type IdentityRow = { display_name: string; primary_first_name: string | null; last_name: string | null; donor_code: string | null; external_id: string | null };
type PriorityRow = IdentityRow & { recommendation_id: string; donor_id: string; action: string; reason: string; score: number; due_at: number | null; updated_at: number };
type GivingRow = IdentityRow & { id: string; donor_id: string; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; description: string | null; item_type: string | null; updated_at: number };
type ContactRow = IdentityRow & { id: string; last_contact: number | null; recent_activity: number | null };
type DonorRow = IdentityRow & { id: string; updated_at: number; relationship_summary: string | null; institutional_memory: string | null };
type DonorDateRow = { donor_id: string; value: number | null };
type ScheduledActivityRow = IdentityRow & { id: string; donor_id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number; updated_at: number };
type DonorLinkRow = IdentityRow & { donor_id: string; event_at: number };
type DismissalRow = { item_key: string };
type LatestInteractionRow = { donor_id: string; type: string; occurred_at: number; summary: string };
type HistoricalContextRow = { donor_id: string; text: string; source: string; source_date: number | null };
type AcknowledgmentRow = { gift_source: GiftSource; gift_id: string; status: GiftAcknowledgmentStatus };
type YahrtzeitRow = { id: string; donor_id: string; deceased_name_english: string; deceased_name_hebrew: string | null; relationship: string; hebrew_month: string; hebrew_day: number };
type ImportantDateRow = { id: string; donor_id: string; type: ImportantDateType; person_name: string | null; relationship: string | null; month: number; day: number; year: number | null };

export type WorkspacePriority = { queueId: string; recommendationId?: string; donorId: string; name: string; initials: string; donorCode: string | null; label: string; signal: "warm" | "steady" | "cool"; reason: string; why: string; action: string; href: string; dueAt: number | null; dueLabel: string; bucket: RelationshipQueueBucket; giftSource?: GiftSource; giftId?: string };
export type WorkspaceMeeting = { donorId: string; time: string; period: string; title: string; donorCode: string | null; detail: string };
export type WorkspaceScheduledActivity = { id: string; donorId: string; type: string; typeLabel: string; time: string; period: string; date: string; donorName: string; donorCode: string | null; initials: string; subject: string; note: string; prepareHref: string | null; openHref: string; editHref: string; logOutcomeHref: string | null; canCancel: boolean };
export type WorkspaceGift = { id: string; donorId: string; name: string; initials: string; donorCode: string | null; amount: string; detail: string };
export type WorkspaceDonorLink = { donorId: string; name: string; initials: string; donorCode: string | null; detail: string; href: string };
export type WorkspaceMorningBrief = { meetingsToday: number; overdueFollowUps: number; recentGifts: number; upcomingReminders: number; suggestedPriority: WorkspacePriority | null };
export type WorkspaceBrief = { overview: string; recommendation: string; priorities: WorkspacePriority[]; priorityCount: number; relationshipQueue: Record<RelationshipQueueBucket, WorkspacePriority[]>; morningBrief: WorkspaceMorningBrief; recentlyViewed: WorkspaceDonorLink[]; recentlyUpdated: WorkspaceDonorLink[]; todaySchedule: WorkspaceScheduledActivity[]; upcomingActivities: WorkspaceScheduledActivity[]; meetings: WorkspaceMeeting[]; gifts: WorkspaceGift[]; upcomingRelationshipDates: WorkspaceRelationshipDateEvent[]; generatedAt: number };

function identity(item: IdentityRow) {
  return {
    initials: donorInitials({ displayName: item.display_name, primaryFirstName: item.primary_first_name, lastName: item.last_name }),
    donorCode: numericDonorCode({ donorCode: item.donor_code, externalId: item.external_id }),
  };
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
  return ({ call: "Call", email: "Email", meeting: "Meeting", visit: "Visit", note: "Note", personal: "Personal interaction", text: "Text Message" } as Record<string, string>)[type] ?? "Activity";
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
    ...identity(item),
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
  const [reminders, giving, donors, lastContacts, substantiveContacts, lastActivities, scheduledActivities, dismissals, recentViews, recentUpdates, latestInteractions, historicalContextRows, acknowledgments, yahrtzeitRows, importantDateRows] = await Promise.all([
    env.DB.prepare(`SELECT r.id AS recommendation_id, r.donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, r.action, r.reason, r.score, r.due_at, r.updated_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE ${demo ? "" : "r.user_id = ? AND"} r.status = 'open' AND ${donorScope}
      ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at, r.score DESC LIMIT 50`).bind(...(demo ? [] : [userId, userId])).all<PriorityRow>(),
    env.DB.prepare(`SELECT ga.id, ga.donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description, ga.item_type, ga.updated_at
      FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
      WHERE ${demo ? "ga.record_origin = 'sample' AND" : "ga.owner_user_id = ? AND ga.record_origin = 'live' AND"} ${donorScope} AND ga.workspace_status = 'active' AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
      ORDER BY ga.activity_date DESC LIMIT 300`).bind(...(demo ? [] : [userId, userId])).all<GivingRow>(),
    env.DB.prepare(`SELECT d.id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, d.updated_at, d.relationship_summary, d.institutional_memory FROM donors d WHERE ${donorScope} ORDER BY d.display_name LIMIT 500`).bind(...(demo ? [] : [userId])).all<DonorRow>(),
    env.DB.prepare(`SELECT donor_id, MAX(occurred_at) AS value FROM interactions ${demo ? "WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample') AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))" : "WHERE user_id = ? AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at))"} GROUP BY donor_id`).bind(...(demo ? [now] : [userId, now])).all<DonorDateRow>(),
    // Same as lastContacts above, but excluding role='recipient' rows -- a
    // donor merely receiving a broadcast text/email/photo (one shared
    // outreach logged once, linked to many donors) never by itself counts as
    // "substantive" contact. Feeds reconnect_contact_gap only; Last Contact
    // display (lastContacts/contactByDonor above) is unaffected and still
    // counts every completed interaction, recipient touches included -- see
    // lastSubstantiveContactAt's doc comment in recommendation-evidence.ts.
    env.DB.prepare(`SELECT donor_id, MAX(occurred_at) AS value FROM interactions ${demo ? "WHERE donor_id IN (SELECT id FROM donors WHERE data_source = 'sample') AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at)) AND (role IS NULL OR role != 'recipient')" : "WHERE user_id = ? AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at)) AND (role IS NULL OR role != 'recipient')"} GROUP BY donor_id`).bind(...(demo ? [now] : [userId, now])).all<DonorDateRow>(),
    env.DB.prepare(`SELECT donor_id, MAX(activity_date) AS value FROM giving_activities ${demo ? "WHERE record_origin = 'sample' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift') AND donor_id IN (SELECT id FROM donors WHERE data_source = 'sample')" : "WHERE owner_user_id = ? AND record_origin = 'live' AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift')"} GROUP BY donor_id`).bind(...(demo ? [] : [userId])).all<DonorDateRow>(),
    env.DB.prepare(`SELECT i.id, i.donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, i.type, i.occurred_at, i.summary, i.source, i.created_at, i.updated_at
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE ${demo ? "d.data_source = 'sample'" : "i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL"}
        AND (i.source LIKE 'capture-scheduled:%' OR i.occurred_at > i.created_at)
        AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%' AND i.source NOT LIKE 'capture-completed:%'
        AND i.occurred_at >= ? ORDER BY i.occurred_at LIMIT 500`).bind(...(demo ? [now - 86400] : [userId, userId, now - 86400])).all<ScheduledActivityRow>(),
    demo ? Promise.resolve({ results: [] as DismissalRow[] }) : env.DB.prepare("SELECT item_key FROM relationship_queue_dismissals WHERE user_id = ?").bind(userId).all<DismissalRow>(),
    demo ? Promise.resolve({ results: [] as DonorLinkRow[] }) : env.DB.prepare(`SELECT d.id AS donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, v.viewed_at AS event_at
      FROM donor_views v JOIN donors d ON d.id = v.donor_id
      WHERE v.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL
      ORDER BY v.viewed_at DESC LIMIT 6`).bind(userId, userId).all<DonorLinkRow>(),
    env.DB.prepare(`SELECT d.id AS donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id,
        MAX(d.updated_at,
          COALESCE((SELECT MAX(i.updated_at) FROM interactions i WHERE i.donor_id=d.id ${demo ? "" : "AND i.user_id=?"}),0),
          COALESCE((SELECT MAX(r.updated_at) FROM recommendations r WHERE r.donor_id=d.id ${demo ? "" : "AND r.user_id=?"}),0),
          COALESCE((SELECT MAX(ga.updated_at) FROM giving_activities ga WHERE ga.donor_id=d.id ${demo ? "AND ga.record_origin='sample'" : "AND ga.owner_user_id=? AND ga.record_origin='live'"}),0)
        ) AS event_at
      FROM donors d WHERE ${donorScope}
      ORDER BY event_at DESC, d.display_name COLLATE NOCASE LIMIT 6`).bind(...(demo ? [] : [userId, userId, userId, userId])).all<DonorLinkRow>(),
    // Latest completed interaction TEXT per donor -- same completed-
    // interaction filter as lastContacts above (which only has the date),
    // needed so the shared recommendation engine can build
    // continue_conversation candidates here too, exactly as the donor
    // page/Meeting Brief already do.
    env.DB.prepare(`SELECT i.donor_id, i.type, i.occurred_at, i.summary
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE ${demo ? "d.data_source = 'sample'" : "i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL"}
        AND i.occurred_at <= ? AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%'
        AND (i.source LIKE 'capture-completed:%' OR (i.source NOT LIKE 'capture-scheduled:%' AND i.occurred_at <= i.created_at))
        AND i.occurred_at = (SELECT MAX(i2.occurred_at) FROM interactions i2
          WHERE i2.donor_id = i.donor_id ${demo ? "" : "AND i2.user_id = i.user_id"}
            AND i2.occurred_at <= ? AND i2.source NOT LIKE 'cancelled:%' AND i2.source NOT LIKE 'archived:%'
            AND (i2.source LIKE 'capture-completed:%' OR (i2.source NOT LIKE 'capture-scheduled:%' AND i2.occurred_at <= i2.created_at)))
      `).bind(...(demo ? [now, now] : [userId, userId, now, now])).all<LatestInteractionRow>(),
    // Unconfirmed historical context for every in-scope donor -- kept in
    // its own query, never joined into the interactions results above, so
    // it can only ever feed the recommendation engine's own
    // historicalContext field, never masquerade as a completed contact.
    demo ? Promise.resolve({ results: [] as HistoricalContextRow[] }) : env.DB.prepare(`SELECT donor_id, text, source, source_date FROM donor_historical_context WHERE user_id = ? AND status = 'unconfirmed' ORDER BY donor_id, created_at DESC LIMIT 1000`).bind(userId).all<HistoricalContextRow>(),
    // Newest row per (gift_source, gift_id) is "current status"; a JL
    // re-import never references this table, so it survives every refresh.
    demo ? Promise.resolve({ results: [] as AcknowledgmentRow[] }) : env.DB.prepare(`SELECT gift_source, gift_id, status FROM gift_acknowledgments WHERE user_id = ? ORDER BY created_at DESC LIMIT 5000`).bind(userId).all<AcknowledgmentRow>(),
    // Every in-scope donor's yahrtzeits -- feeds yahrtzeit_outreach the
    // same way historicalContextRows feeds solicit/relationship_opportunity
    // above. Never joined into interactions/recommendations.
    demo ? Promise.resolve({ results: [] as YahrtzeitRow[] }) : env.DB.prepare(`SELECT id, donor_id, deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day FROM yahrtzeits WHERE user_id = ? LIMIT 5000`).bind(userId).all<YahrtzeitRow>(),
    // Every in-scope donor's birthdays/anniversaries -- same cheap,
    // unbounded-by-donor-count fetch as yahrtzeitRows above, feeding
    // birthday_outreach/anniversary_outreach the same way. Never joined
    // into interactions/recommendations.
    demo ? Promise.resolve({ results: [] as ImportantDateRow[] }) : env.DB.prepare(`SELECT id, donor_id, type, person_name, relationship, month, day, year FROM important_dates WHERE user_id = ? LIMIT 5000`).bind(userId).all<ImportantDateRow>(),
  ]);

  const contactByDonor = new Map(lastContacts.results.map((item) => [item.donor_id, item.value]));
  // Excludes role='recipient' -- see the substantiveContacts query above.
  // Used only for contact-gap candidate selection/scoring below, never for
  // Last Contact display (which stays on contactByDonor, unchanged).
  const substantiveContactByDonor = new Map(substantiveContacts.results.map((item) => [item.donor_id, item.value]));
  const activityByDonor = new Map(lastActivities.results.map((item) => [item.donor_id, item.value]));
  const contacts: ContactRow[] = donors.results.map((item) => ({ ...item, last_contact: contactByDonor.get(item.id) ?? null, recent_activity: Math.max(item.updated_at, contactByDonor.get(item.id) ?? 0, activityByDonor.get(item.id) ?? 0) }));
  type RankedPriority = Omit<WorkspacePriority, "bucket"> & { rank: number; sortAt: number };
  const ranked: RankedPriority[] = [];
  const todayKey = dayKey(now, timezone);

  for (const item of reminders.results) {
    const overdue = item.due_at != null && dayKey(item.due_at, timezone) < todayKey;
    const dueToday = item.due_at != null && dayKey(item.due_at, timezone) === todayKey;
    const dueSoon = item.due_at != null && item.due_at <= now + 7 * 86400;
    ranked.push({ queueId: `reminder:${item.recommendation_id}:${item.updated_at}`, rank: overdue ? 0 : dueToday ? 2 : 5, sortAt: item.due_at ?? Number.MAX_SAFE_INTEGER, recommendationId: item.recommendation_id, donorId: item.donor_id, name: item.display_name, ...identity(item), label: overdue ? "Overdue follow-up" : dueToday ? "Due today" : dueSoon ? "Due this week" : "Upcoming reminder", signal: overdue ? "cool" : "steady", reason: item.action, why: item.due_at ? `${overdue ? "Was due" : "Due"} ${dateLabel(item.due_at, timezone)}. ${item.reason}` : item.reason, action: "Open donor", href: `/donors/${encodeURIComponent(item.donor_id)}`, dueAt: item.due_at, dueLabel: item.due_at ? `${overdue ? "Overdue" : "Due"} ${dateLabel(item.due_at, timezone)}` : "No due date recorded" });
  }

  for (const item of scheduledActivities.results) {
    const bucket = scheduleBucket(item.source, item.occurred_at, item.created_at, now, timezone);
    if (!bucket) continue;
    const time = timeParts(item.occurred_at, timezone);
    const isToday = bucket === "today";
    ranked.push({ queueId: `activity:${item.id}:${item.updated_at}`, rank: isToday ? 1 : 5, sortAt: item.occurred_at, donorId: item.donor_id, name: item.display_name, ...identity(item), label: `${activityTypeLabel(item.type)} ${isToday ? "today" : "scheduled"}`, signal: "warm", reason: item.summary.split("\n")[0] || `Scheduled ${activityTypeLabel(item.type).toLowerCase()}`, why: `Scheduled for ${dateLabel(item.occurred_at, timezone)} at ${time.time} ${time.period}.`, action: item.type === "meeting" ? "Prepare" : "Open", href: item.type === "meeting" ? `/donors/${encodeURIComponent(item.donor_id)}/meeting-brief` : `/donors/${encodeURIComponent(item.donor_id)}`, dueAt: item.occurred_at, dueLabel: `${isToday ? "Today" : dateLabel(item.occurred_at, timezone)} at ${time.time} ${time.period}` });
  }

  // Recent gift / open commitment / contact gap: these three used to be
  // independent template-generated buckets (a donor could show up in more
  // than one, with conflicting text). Membership is unchanged -- the same
  // three thresholds decide which donors qualify -- but each qualifying
  // donor now gets exactly ONE synthesized suggestion, computed by the
  // same shared recommendation engine the donor page/Meeting Brief/
  // Assistant use, so the wording can never disagree across surfaces.
  const recentGiftByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) {
    const recent = isRecentPastEvent(item.activity_date, now, 30);
    const contactedAfterGift = (contactByDonor.get(item.donor_id) ?? 0) >= (item.activity_date ?? 0);
    if ((item.paid_cents ?? 0) > 0 && recent && !contactedAfterGift && !recentGiftByDonor.has(item.donor_id)) recentGiftByDonor.set(item.donor_id, item);
  }
  const openPledgeByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) if ((item.balance_cents ?? 0) > 0 && !openPledgeByDonor.has(item.donor_id)) openPledgeByDonor.set(item.donor_id, item);
  const yahrtzeitsByDonor = new Map<string, YahrtzeitRow[]>();
  for (const row of yahrtzeitRows.results) {
    if (!yahrtzeitsByDonor.has(row.donor_id)) yahrtzeitsByDonor.set(row.donor_id, []);
    yahrtzeitsByDonor.get(row.donor_id)!.push(row);
  }
  const importantDatesByDonor = new Map<string, ImportantDateRow[]>();
  for (const row of importantDateRows.results) {
    if (!importantDatesByDonor.has(row.donor_id)) importantDatesByDonor.set(row.donor_id, []);
    importantDatesByDonor.get(row.donor_id)!.push(row);
  }
  // At real scale, "no recent contact" is most of the donor roster (247 of
  // 248 in the incident that prompted this bound), so it's the only
  // category below that's bounded -- every donor with a real gift, pledge,
  // or a yahrtzeit/birthday/anniversary actually inside its own lead window
  // is kept in full, unbounded. See lib/workspace/suggestion-candidates.ts
  // for the monotonicity argument this bound relies on.
  const suggestionDonorIds = selectSuggestionDonorIds({
    giftDonorIds: recentGiftByDonor.keys(),
    pledgeDonorIds: openPledgeByDonor.keys(),
    yahrtzeitRows: yahrtzeitRows.results.map((row) => ({ donorId: row.donor_id, hebrewMonth: row.hebrew_month as HebrewMonthName, hebrewDay: row.hebrew_day })),
    importantDateRows: importantDateRows.results.map((row) => ({ donorId: row.donor_id, month: row.month, day: row.day })),
    // Substantive (non-recipient) contact, not the display Last Contact
    // value -- otherwise a donor who only ever received a broadcast would
    // look "recently contacted" here and never even enter the pool that
    // reconnectContactGapCandidate is generated from.
    contactGapCandidates: contacts.map((item) => {
      const substantive = substantiveContactByDonor.get(item.id) ?? null;
      return { donorId: item.id, daysSinceLastContact: substantive ? Math.floor((now - substantive) / 86400) : null };
    }),
    timezone,
    now,
  });

  const reminderByDonor = new Map(reminders.results.map((item) => [item.donor_id, item]));
  const donorById = new Map(donors.results.map((item) => [item.id, item]));
  const latestInteractionByDonor = new Map(latestInteractions.results.map((item) => [item.donor_id, item]));
  const historicalContextByDonor = new Map<string, HistoricalContextRow[]>();
  for (const row of historicalContextRows.results) {
    if (!historicalContextByDonor.has(row.donor_id)) historicalContextByDonor.set(row.donor_id, []);
    historicalContextByDonor.get(row.donor_id)!.push(row);
  }
  const suggestionHrefByKind: Partial<Record<RecommendationCandidateKind, string>> = { acknowledge_gift: "capture" };
  // yahrtzeit_outreach/birthday_outreach/anniversary_outreach have no entry
  // here -- they're excluded from this ranked path entirely (see the
  // continue below) and never look this map up.
  const suggestionLabelByKind: Partial<Record<RecommendationCandidateKind, string>> = { acknowledge_gift: "Recent gift", follow_up_pledge: "Open commitment", solicit: "Relationship opportunity", relationship_opportunity: "Relationship opportunity", continue_conversation: "Continue the conversation", reconnect_contact_gap: "Contact gap" };
  const suggestionRankByKind: Partial<Record<RecommendationCandidateKind, number>> = { acknowledge_gift: 2, follow_up_pledge: 3 };
  // live-data.ts's own "recent gift" bucket only ever draws from
  // giving_activities (never the legacy gifts table -- see GivingRow),
  // so gift_source is always "giving_activity" here.
  const acknowledgedGivingActivityIds = new Set(acknowledgments.results.filter((row) => row.gift_source === "giving_activity").map((row) => row.gift_id));

  for (const donorId of suggestionDonorIds) {
    const donorRow = donorById.get(donorId);
    if (!donorRow) continue;
    const gift = recentGiftByDonor.get(donorId);
    const pledge = openPledgeByDonor.get(donorId);
    const reminder = reminderByDonor.get(donorId);
    const lastInteractionRow = latestInteractionByDonor.get(donorId);
    const evidence = buildRecommendationEvidence({
      donorId,
      mostRecentPaidGift: gift ? { giftSource: "giving_activity", giftId: gift.id, amountCents: gift.paid_cents ?? 0, occurredAt: gift.activity_date!, campaign: null, description: gift.description || gift.item_type, acknowledged: acknowledgedGivingActivityIds.has(gift.id) } : null,
      openPledge: pledge ? { balanceCents: pledge.balance_cents ?? 0, campaign: null, description: pledge.description || pledge.item_type, activityDate: pledge.activity_date } : null,
      lastCompletedInteraction: lastInteractionRow ? { type: lastInteractionRow.type, summary: lastInteractionRow.summary, occurredAt: lastInteractionRow.occurred_at } : null,
      lastContactAt: contactByDonor.get(donorId) ?? null,
      lastSubstantiveContactAt: substantiveContactByDonor.get(donorId) ?? null,
      openReminder: reminder ? { action: reminder.action, reason: reminder.reason, dueAt: reminder.due_at } : null,
      relationshipSummary: donorRow.relationship_summary,
      institutionalMemory: donorRow.institutional_memory,
      historicalContext: (historicalContextByDonor.get(donorId) ?? []).map((row) => ({ text: row.text, source: row.source, sourceDate: row.source_date })),
      yahrtzeits: (yahrtzeitsByDonor.get(donorId) ?? []).map((row) => ({ deceasedNameEnglish: row.deceased_name_english, deceasedNameHebrew: row.deceased_name_hebrew, relationship: row.relationship, hebrewMonth: row.hebrew_month as HebrewMonthName, hebrewDay: row.hebrew_day })),
      importantDates: (importantDatesByDonor.get(donorId) ?? []).map((row) => ({ type: row.type, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year })),
    }, now, timezone);
    const recommendation = buildDonorRecommendation(evidence);
    if (!recommendation) continue;
    // A donor whose open reminder is itself the winning suggestion is
    // already shown by the reminder loop above -- never a second,
    // duplicate card for the same donor.
    if (recommendation.kind === "honor_reminder") continue;
    // No relationship-date outreach candidate (yahrtzeit, birthday,
    // anniversary) ever competes for a homepage slot through this ranked/
    // relationshipQueue path -- none of them need to beat a gift
    // acknowledgment, pledge follow-up, or contact-gap candidate to be
    // visible on the homepage. Each is surfaced unconditionally instead via
    // upcomingRelationshipDates below (Coming Up), built directly from the
    // same lead-window fact, independent of this ranking. Suppressing them
    // here only prevents a duplicate Coming Up card; the candidates
    // themselves are untouched and still used for the donor's Suggested
    // Action elsewhere (donor profile, Meeting Brief, Assistant).
    if (recommendation.kind === "yahrtzeit_outreach" || recommendation.kind === "birthday_outreach" || recommendation.kind === "anniversary_outreach") continue;
    // yahrtzeit_outreach/birthday_outreach/anniversary_outreach are all
    // excluded above, so none of them ever reach this branch -- their
    // Coming Up placement/sorting is entirely handled by
    // upcomingRelationshipDates instead.
    const sortAt = recommendation.kind === "acknowledge_gift" ? -(gift?.activity_date ?? 0)
      : recommendation.kind === "follow_up_pledge" ? (pledge?.activity_date ?? 0)
      // reconnect_contact_gap sorts by the same substantive-contact measure
      // its own candidate score is based on (see reconnectContactGapCandidate),
      // so displayed order never disagrees with the "why" text. Every other
      // kind (continue_conversation, relationship_opportunity, solicit) is
      // unaffected -- still the all-contact-types value, unchanged.
      : recommendation.kind === "reconnect_contact_gap" ? -(evidence.contact.daysSinceSubstantiveContact ?? Number.MAX_SAFE_INTEGER)
      : -(evidence.contact.daysSinceLastContact ?? Number.MAX_SAFE_INTEGER);
    ranked.push({
      queueId: `recommendation:${donorId}:${recommendation.kind}`,
      donorId,
      name: donorRow.display_name,
      ...identity(donorRow),
      label: suggestionLabelByKind[recommendation.kind] ?? "Relationship opportunity",
      signal: recommendation.kind === "acknowledge_gift" || recommendation.kind === "follow_up_pledge" ? "warm" : recommendation.confidence === "low" ? "cool" : "warm",
      reason: recommendation.action,
      why: recommendation.why,
      action: suggestionHrefByKind[recommendation.kind] === "capture" ? "Follow up" : "Review",
      href: suggestionHrefByKind[recommendation.kind] === "capture" ? `/capture?donorId=${encodeURIComponent(donorId)}&returnTo=%2F` : `/donors/${encodeURIComponent(donorId)}`,
      dueAt: recommendation.kind === "acknowledge_gift" ? now : null,
      dueLabel: recommendation.timing ?? (recommendation.kind === "acknowledge_gift" ? "Suggested today" : "No due date recorded"),
      rank: suggestionRankByKind[recommendation.kind] ?? 4,
      sortAt,
      giftSource: recommendation.giftSource,
      giftId: recommendation.giftId,
    });
  }

  const activeQueue = dedupeRelationshipQueue(ranked, new Set(dismissals.results.map((item) => item.item_key)));
  const allPriorities: WorkspacePriority[] = activeQueue.map(({ rank: _rank, sortAt: _sortAt, ...item }) => ({ ...item, bucket: relationshipQueueBucket(item.dueAt, now, timezone) }));
  const deduped = allPriorities.slice(0, Math.max(5, Math.min(priorityLimit, HOMEPAGE_MAX_RESULTS)));
  const relationshipQueue = groupRelationshipQueue(deduped.map((item, index) => ({ ...item, rank: index, sortAt: item.dueAt ?? Number.MAX_SAFE_INTEGER })), now, timezone);

  const scheduled = scheduledActivities.results.map((item) => ({ row: item, activity: scheduledActivity(item, timezone, now) }));
  const todaySchedule = scheduled.filter(({ row }) => scheduleBucket(row.source, row.occurred_at, row.created_at, now, timezone) === "today").map(({ activity }) => activity);
  const upcomingActivities = scheduled.filter(({ row }) => scheduleBucket(row.source, row.occurred_at, row.created_at, now, timezone) === "upcoming").slice(0, 10).map(({ activity }) => activity);
  const meetings = scheduled.filter(({ row }) => row.type === "meeting" && row.occurred_at >= now).slice(0, 5).map(({ row, activity }) => ({ donorId: row.donor_id, time: activity.time, period: activity.period, title: activity.donorName, donorCode: activity.donorCode, detail: `${activity.date} · ${activity.subject}` }));
  const recentGiving = giving.results.filter((item) => (item.paid_cents ?? 0) > 0 && isRecentPastEvent(item.activity_date, now, 30));
  const gifts = recentGiving.slice(0, 8).map((item) => ({ id: item.id, donorId: item.donor_id, name: item.display_name, ...identity(item), amount: money(item.paid_cents ?? 0), detail: `${item.description || item.item_type || "Gift"}${item.activity_date ? ` · ${financialDateLabel(item.activity_date)}` : ""}` }));
  const donorLinks = (rows: DonorLinkRow[], verb: string): WorkspaceDonorLink[] => rows.map((item) => ({ donorId: item.donor_id, name: item.display_name, ...identity(item), detail: `${verb} ${dateLabel(item.event_at, timezone)}`, href: `/donors/${encodeURIComponent(item.donor_id)}` }));
  const recentlyViewed = donorLinks(recentViews.results, "Viewed");
  const recentlyUpdated = donorLinks(recentUpdates.results.filter((item) => item.event_at > 0), "Updated");

  // Coming Up's date-driven relationship events: built directly from the
  // yahrtzeit/important-date rows already fetched above, independent of the
  // suggestionDonorIds/ranked path -- every donor with a relationship date
  // inside its lead window gets an event here, whether or not they were
  // even selected into the bounded recommendation pool for other reasons.
  // The two builders are concatenated and re-sorted together so Yahrtzeit,
  // Birthday, and Anniversary events interleave in one chronological list
  // -- including when two fall on the exact same date, both remain.
  const identityByDonor = new Map(donors.results.map((item) => [item.id, { donorName: item.display_name, ...identity(item) }]));
  const upcomingRelationshipDates = [
    ...buildYahrtzeitRelationshipDateEvents(
      yahrtzeitRows.results.map((row) => ({ id: row.id, donorId: row.donor_id, deceasedNameEnglish: row.deceased_name_english, deceasedNameHebrew: row.deceased_name_hebrew, relationship: row.relationship, hebrewMonth: row.hebrew_month as HebrewMonthName, hebrewDay: row.hebrew_day })),
      identityByDonor,
      timezone,
      now,
    ),
    ...buildImportantDateRelationshipEvents(
      importantDateRows.results.map((row) => ({ id: row.id, donorId: row.donor_id, type: row.type, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year })),
      identityByDonor,
      timezone,
      now,
    ),
  ].sort((a, b) => a.dateEpoch - b.dateEpoch);
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
  return { overview, recommendation, priorities: deduped, priorityCount: allPriorities.length, relationshipQueue, morningBrief, recentlyViewed, recentlyUpdated, todaySchedule, upcomingActivities, meetings, gifts, upcomingRelationshipDates, generatedAt: now };
}
