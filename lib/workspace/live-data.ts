import { env } from "cloudflare:workers";
import type { DataMode } from "./mode";

type PriorityRow = { id: string; display_name: string; action: string; reason: string; score: number; due_at: number | null };
type GivingRow = { id: string; donor_id: string; display_name: string; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; description: string | null; item_type: string | null };
type ContactRow = { id: string; display_name: string; last_contact: number | null; recent_activity: number | null };

export type WorkspacePriority = { donorId: string; name: string; initials: string; label: string; signal: "warm" | "steady" | "cool"; reason: string; why: string; action: string; href: string };
export type WorkspaceMeeting = { donorId: string; time: string; period: string; title: string; detail: string };
export type WorkspaceGift = { id: string; donorId: string; name: string; initials: string; amount: string; detail: string };
export type WorkspaceBrief = { overview: string; recommendation: string; priorities: WorkspacePriority[]; meetings: WorkspaceMeeting[]; gifts: WorkspaceGift[]; generatedAt: number };

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

export async function loadWorkspaceBrief(userId: string, timezone: string, mode: DataMode = "live", now = Math.floor(Date.now() / 1000)): Promise<WorkspaceBrief> {
  const demo = mode === "demo";
  const donorScope = demo ? "d.data_source = 'sample'" : "d.owner_user_id = ? AND d.data_source = 'live'";
  const [reminders, giving, contacts] = await Promise.all([
    env.DB.prepare(`SELECT r.donor_id AS id, d.display_name, r.action, r.reason, r.score, r.due_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE ${demo ? "" : "r.user_id = ? AND"} r.status = 'open' AND ${donorScope}
      ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at, r.score DESC LIMIT 50`).bind(...(demo ? [] : [userId, userId])).all<PriorityRow>(),
    env.DB.prepare(`SELECT ga.id, ga.donor_id, d.display_name, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description, ga.item_type
      FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
      WHERE ${demo ? "" : "ga.owner_user_id = ? AND"} ${donorScope} AND ga.category NOT IN ('needs_review','nonfinancial_entry')
      ORDER BY ga.activity_date DESC LIMIT 300`).bind(...(demo ? [] : [userId, userId])).all<GivingRow>(),
    env.DB.prepare(`SELECT d.id, d.display_name,
      (SELECT MAX(i.occurred_at) FROM interactions i WHERE i.donor_id = d.id ${demo ? "" : "AND i.user_id = ?"}) AS last_contact,
      MAX(d.updated_at,
        COALESCE((SELECT MAX(i2.occurred_at) FROM interactions i2 WHERE i2.donor_id = d.id ${demo ? "" : "AND i2.user_id = ?"}), 0),
        COALESCE((SELECT MAX(ga.activity_date) FROM giving_activities ga WHERE ga.donor_id = d.id ${demo ? "" : "AND ga.owner_user_id = ?"}), 0)
      ) AS recent_activity
      FROM donors d WHERE ${donorScope} ORDER BY last_contact LIMIT 500`).bind(...(demo ? [] : [userId, userId, userId, userId])).all<ContactRow>(),
  ]);

  const priorities: WorkspacePriority[] = [];
  for (const item of reminders.results) {
    const overdue = item.due_at != null && item.due_at < now;
    const dueSoon = item.due_at != null && item.due_at <= now + 7 * 86400;
    priorities.push({ donorId: item.id, name: item.display_name, initials: initials(item.display_name), label: overdue ? "Overdue" : dueSoon ? "Due soon" : "Next action", signal: overdue ? "cool" : "steady", reason: item.action, why: item.due_at ? `${overdue ? "Was due" : "Due"} ${dateLabel(item.due_at, timezone)}. ${item.reason}` : item.reason, action: "Open", href: `/donors/${encodeURIComponent(item.id)}` });
  }
  const openByDonor = new Map<string, GivingRow>();
  for (const item of giving.results) if ((item.balance_cents ?? 0) > 0 && !openByDonor.has(item.donor_id)) openByDonor.set(item.donor_id, item);
  for (const item of openByDonor.values()) priorities.push({ donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), label: "Open pledge", signal: "warm", reason: `${money(item.balance_cents ?? 0)} remains open`, why: `${item.description || item.item_type || "Commitment"}${item.activity_date ? ` from ${dateLabel(item.activity_date, timezone)}` : ""}.`, action: "Review", href: `/donors/${encodeURIComponent(item.donor_id)}` });
  for (const item of contacts.results) {
    const days = item.last_contact ? Math.floor((now - item.last_contact) / 86400) : null;
    if (days == null || days >= 90) priorities.push({ donorId: item.id, name: item.display_name, initials: initials(item.display_name), label: "Needs contact", signal: "cool", reason: days == null ? "No meaningful contact recorded" : `${days} days since meaningful contact`, why: item.recent_activity ? `Workspace activity was last recorded ${dateLabel(item.recent_activity, timezone)}.` : "No recent activity is available.", action: "Review", href: `/donors/${encodeURIComponent(item.id)}` });
  }
  const deduped = [...new Map(priorities.map((item) => [item.donorId, item])).values()].slice(0, 8);
  const meetings = reminders.results.filter((item) => item.due_at && /meet|call|visit|appointment/i.test(`${item.action} ${item.reason}`) && item.due_at >= now - 86400 && item.due_at <= now + 7 * 86400).slice(0, 5).map((item) => ({ donorId: item.id, ...timeParts(item.due_at!, timezone), title: item.display_name, detail: item.action }));
  const gifts = giving.results.filter((item) => (item.paid_cents ?? 0) > 0 && (item.activity_date ?? 0) >= now - 30 * 86400).slice(0, 8).map((item) => ({ id: item.id, donorId: item.donor_id, name: item.display_name, initials: initials(item.display_name), amount: money(item.paid_cents ?? 0), detail: `${item.description || item.item_type || "Gift"}${item.activity_date ? ` · ${dateLabel(item.activity_date, timezone)}` : ""}` }));
  const overview = deduped.length || gifts.length ? `${deduped.length} relationship priorit${deduped.length === 1 ? "y" : "ies"}, ${meetings.length} upcoming meeting${meetings.length === 1 ? "" : "s"}, and ${gifts.length} recent gift${gifts.length === 1 ? "" : "s"} are visible from your live workspace.` : "Your live workspace has no time-sensitive priorities yet. Import data or log an interaction to build today’s brief.";
  const recommendation = deduped[0] ? `Start with ${deduped[0].name}: ${deduped[0].reason}.` : "No recommended action is available until your workspace contains a due reminder, open pledge, recent gift, or relationship activity.";
  return { overview, recommendation, priorities: deduped, meetings, gifts, generatedAt: now };
}
