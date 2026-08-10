import { appearsInGivingTimeline } from "../giving/management.ts";
import { activityStatus, completedPlannedAt, isNoResponseActivity } from "../workspace/scheduled-activity.ts";
import { normalizeFinancialDate } from "../financial-date.ts";

export type TimelineFilter = "all" | "gifts" | "pledges" | "payments" | "calls" | "emails" | "meetings" | "notes" | "reminders" | "other";
export type TimelineStatus = "scheduled" | "completed" | "cancelled" | "pending" | "open" | "overdue" | "needs-review" | "excluded";

export type TimelineGiving = { id: string; donor_id: string; external_source: string; activity_date: number | null; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; item_type: string | null; description: string | null; source_campaign: string | null; category: string; workspace_status: string; private_note: string | null; updated_at: number };
export type TimelineLegacyGift = { id: string; received_at: number; amount_cents: number; fund: string };
export type TimelinePayment = { id: string; payment_date: number; applied_cents: number; remaining_balance_cents: number | null; pledge_activity_id: string; pledge_description: string | null; pledge_campaign: string | null };
export type TimelineInteraction = { id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number; status_changed_at?: number | null };
export type TimelineReminder = { id: string; action: string; reason: string; status: string; due_at: number | null; created_at: number; updated_at: number };

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
}) {
  const interactionIds = new Set(input.interactions.map((item) => item.id));
  const givingIds = new Set(input.giving.map((item) => item.id));
  const seenPaymentIds = new Set<string>();
  const items: UnifiedTimelineItem[] = [];

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
    items.push({ key: `reminder:${reminder.id}`, kind: "reminder", filter: "reminders", status: completed ? "completed" : reminder.due_at !== null && reminder.due_at < input.now ? "overdue" : "scheduled", eventAt, reminder });
  }
  return items.sort((a, b) => b.eventAt - a.eventAt || a.key.localeCompare(b.key));
}

export const TIMELINE_FILTERS: Array<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "All" }, { id: "gifts", label: "Gifts" }, { id: "pledges", label: "Pledges" },
  { id: "payments", label: "Payments" }, { id: "calls", label: "Calls" }, { id: "emails", label: "Emails" },
  { id: "meetings", label: "Meetings" }, { id: "notes", label: "Notes" }, { id: "reminders", label: "Reminders" }, { id: "other", label: "Other" },
];
