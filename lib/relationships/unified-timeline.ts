import { appearsInGivingTimeline } from "../giving/management.ts";
import { activityStatus, completedPlannedAt, isNoResponseActivity } from "../workspace/scheduled-activity.ts";
import { normalizeFinancialDate } from "../financial-date.ts";
import { localDayKey } from "../workspace/local-time.ts";

export type TimelineFilter = "all" | "gifts" | "pledges" | "payments" | "calls" | "emails" | "meetings" | "notes" | "reminders" | "other";
export type TimelineStatus = "scheduled" | "completed" | "cancelled" | "pending" | "open" | "overdue" | "needs-review" | "excluded";

export type TimelineGiving = { id: string; donor_id: string; external_source: string; activity_date: number | null; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; item_type: string | null; description: string | null; source_campaign: string | null; category: string; workspace_status: string; private_note: string | null; updated_at: number };
export type TimelineLegacyGift = { id: string; received_at: number; amount_cents: number; fund: string };
export type TimelinePayment = { id: string; payment_date: number; applied_cents: number; remaining_balance_cents: number | null; pledge_activity_id: string; pledge_description: string | null; pledge_campaign: string | null };
// D1's raw driver (not the drizzle query builder) returns SQLite integer
// booleans as plain 0/1, not real booleans -- these stay `number` to match
// every row this component reads.
export type TimelineInteraction = { id: string; type: string; occurred_at: number; occurred_at_date_only?: number; summary: string; source: string; created_at: number; status_changed_at?: number | null };
export type TimelineReminder = { id: string; action: string; reason: string; status: string; due_at: number | null; due_at_date_only?: number; created_at: number; updated_at: number };

export type UnifiedTimelineItem =
  | { key: string; kind: "giving"; filter: "gifts" | "pledges"; status: TimelineStatus; eventAt: number; giving: TimelineGiving }
  | { key: string; kind: "legacy-gift"; filter: "gifts"; status: "completed"; eventAt: number; gift: TimelineLegacyGift }
  | { key: string; kind: "payment"; filter: "payments"; status: "completed"; eventAt: number; linkedPledgeExists: boolean; payment: TimelinePayment }
  | { key: string; kind: "interaction"; filter: Exclude<TimelineFilter, "all" | "gifts" | "pledges" | "payments" | "reminders">; status: TimelineStatus; eventAt: number; plannedAt: number | null; noResponse: boolean; interaction: TimelineInteraction }
  | { key: string; kind: "reminder"; filter: "reminders"; status: TimelineStatus; eventAt: number; reminder: TimelineReminder };

function givingFilter(activity: TimelineGiving): "gifts" | "pledges" {
  return (activity.balance_cents ?? 0) > 0 || /pledge/i.test(activity.category) || /pledge/i.test(activity.item_type ?? "") ? "pledges" : "gifts";
}

function givingStatus(activity: TimelineGiving): TimelineStatus {
  if (activity.workspace_status === "needs_review") return "needs-review";
  if (activity.workspace_status !== "active") return "excluded";
  if (activity.category === "pending_gift") return "pending";
  return givingFilter(activity) === "pledges" && (activity.balance_cents ?? 0) > 0 ? "open" : "completed";
}

function interactionFilter(type: string): "calls" | "emails" | "meetings" | "notes" | "other" {
  if (type === "call") return "calls";
  if (type === "email") return "emails";
  if (type === "meeting") return "meetings";
  if (type === "note") return "notes";
  return "other";
}

export function buildUnifiedTimeline(input: {
  giving: TimelineGiving[];
  legacyGifts: TimelineLegacyGift[];
  payments: TimelinePayment[];
  interactions: TimelineInteraction[];
  reminders: TimelineReminder[];
  now: number;
  // Optional (defaults to UTC) so call sites that never exercise the
  // overdue/date boundary (most existing tests) don't need to change.
  // The one real caller (UnifiedRelationshipTimeline.tsx) always passes
  // the donor's/owner's actual profile timezone, which it already has.
  timezone?: string;
}) {
  const interactionIds = new Set(input.interactions.map((item) => item.id));
  const givingIds = new Set(input.giving.map((item) => item.id));
  const seenPaymentIds = new Set<string>();
  const items: UnifiedTimelineItem[] = [];
  // Calendar-day (not raw-instant) overdue comparison, matching the same
  // timezone-aware pattern already proven in lib/workspace/live-data.ts
  // and lib/workspace/relationship-queue.ts: a reminder due on a given
  // local calendar day stays "due today" for that entire day, regardless
  // of what time within that day due_at is anchored to (e.g. a
  // Monday.com-imported date-only value stored at UTC noon). It becomes
  // overdue only once the local calendar date has actually advanced past
  // it -- never mid-day.
  const todayKey = localDayKey(input.now, input.timezone ?? "UTC");

  for (const giving of input.giving.filter(appearsInGivingTimeline)) {
    items.push({ key: `giving:${giving.id}`, kind: "giving", filter: givingFilter(giving), status: givingStatus(giving), eventAt: giving.activity_date === null ? -1 : normalizeFinancialDate(giving.activity_date), giving });
  }
  for (const gift of input.legacyGifts) items.push({ key: `legacy-gift:${gift.id}`, kind: "legacy-gift", filter: "gifts", status: "completed", eventAt: normalizeFinancialDate(gift.received_at), gift });
  for (const payment of input.payments) {
    if (seenPaymentIds.has(payment.id)) continue;
    seenPaymentIds.add(payment.id);
    items.push({ key: `payment:${payment.id}`, kind: "payment", filter: "payments", status: "completed", eventAt: normalizeFinancialDate(payment.payment_date), linkedPledgeExists: givingIds.has(payment.pledge_activity_id), payment });
  }
  for (const interaction of input.interactions) {
    const rawStatus = activityStatus(interaction.source, interaction.occurred_at, interaction.created_at);
    if (rawStatus === "archived") continue;
    const status: TimelineStatus = rawStatus === "scheduled" ? "scheduled" : rawStatus === "cancelled" ? "cancelled" : "completed";
    items.push({ key: `interaction:${interaction.id}`, kind: "interaction", filter: interactionFilter(interaction.type), status, eventAt: status === "cancelled" ? interaction.status_changed_at ?? interaction.occurred_at : interaction.occurred_at, plannedAt: completedPlannedAt(interaction.source), noResponse: isNoResponseActivity(interaction.source), interaction });
  }
  for (const reminder of input.reminders) {
    if (reminder.status === "dismissed" || (reminder.id.startsWith("activity-") && interactionIds.has(reminder.id.slice("activity-".length)))) continue;
    const completed = reminder.status === "completed";
    const eventAt = completed ? reminder.updated_at : reminder.due_at ?? reminder.created_at;
    const overdue = !completed && reminder.due_at !== null && localDayKey(reminder.due_at, input.timezone ?? "UTC") < todayKey;
    items.push({ key: `reminder:${reminder.id}`, kind: "reminder", filter: "reminders", status: completed ? "completed" : overdue ? "overdue" : "scheduled", eventAt, reminder });
  }
  return items.sort((a, b) => b.eventAt - a.eventAt || a.key.localeCompare(b.key));
}

export const TIMELINE_FILTERS: Array<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "gifts", label: "Gifts" }, { id: "pledges", label: "Pledges" },
  { id: "payments", label: "Payments" }, { id: "calls", label: "Calls" }, { id: "emails", label: "Emails" },
  { id: "meetings", label: "Meetings" }, { id: "notes", label: "Notes" }, { id: "reminders", label: "Reminders" }, { id: "other", label: "Other" },
];
