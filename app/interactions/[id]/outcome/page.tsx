import { env } from "cloudflare:workers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { activityStatus, completedPlannedAt, isArchivedActivity } from "../../../../lib/workspace/scheduled-activity";
import { OutcomeExperience } from "./OutcomeExperience";

export const dynamic = "force-dynamic";
type ActivityRow = { id: string; donor_id: string; display_name: string; primary_first_name: string | null; last_name: string | null; donor_code: string | null; external_id: string | null; type: string; occurred_at: number; summary: string; source: string; created_at: number };
type AuditRow = { id: string; action: string; from_status: string; to_status: string; created_at: number; undone_at: number | null };

function localDateTimeValue(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
const dateTimeLabel = (date: Date, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(date);

export default async function ActivityOutcomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireChatGPTUser(`/interactions/${encodeURIComponent(id)}/outcome`);
  const profile = await ensureUserProfile(identity);
  const activity = await env.DB.prepare(`SELECT i.id, i.donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, i.type, i.occurred_at, i.summary, i.source, i.created_at
    FROM interactions i JOIN donors d ON d.id = i.donor_id
    WHERE i.id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`).bind(id, profile.id, profile.id).first<ActivityRow>();
  if (!activity || isArchivedActivity(activity.source)) notFound();
  const followUp = await env.DB.prepare(`SELECT id, type, occurred_at, summary, source FROM interactions WHERE id = ? AND user_id = ? LIMIT 1`)
    .bind(`activity-followup-${id}`, profile.id).first<{ id: string; type: string; occurred_at: number; summary: string; source: string }>();
  const auditResult = await env.DB.prepare(`SELECT id, action, from_status, to_status, created_at, undone_at FROM activity_status_audits
    WHERE interaction_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 10`).bind(id, profile.id).all<AuditRow>();
  const [subject = "Interaction", ...summaryParts] = activity.summary.split("\n");
  const outcome = summaryParts.find((line) => line.startsWith("Outcome: "))?.slice(9) ?? "";
  const notes = summaryParts.filter((line) => !line.startsWith("Outcome: ")).join("\n") || subject;
  const status = activityStatus(activity.source, activity.occurred_at, activity.created_at);
  const plannedEpoch = completedPlannedAt(activity.source) ?? activity.occurred_at;
  const now = new Date();
  const reschedule = plannedEpoch * 1000 > now.getTime() ? new Date(plannedEpoch * 1000) : new Date(now.getTime() + 86400000);
  const followSummary = followUp?.summary.split("\n") ?? [];
  return <AppShell active="donors"><OutcomeExperience activity={{
    id: activity.id, donorId: activity.donor_id, donorName: activity.display_name, primaryFirstName: activity.primary_first_name, lastName: activity.last_name, donorCode: activity.external_id || activity.donor_code, type: activity.type, status,
    plannedLabel: dateTimeLabel(new Date(plannedEpoch * 1000), profile.timezone), subject, notes, outcome,
    completedLabel: status === "completed" || status === "no-response" ? dateTimeLabel(new Date(activity.occurred_at * 1000), profile.timezone) : null,
  }} initialCompletedValue={localDateTimeValue(status === "completed" || status === "no-response" ? new Date(activity.occurred_at * 1000) : now, profile.timezone)}
    initialRescheduleValue={localDateTimeValue(reschedule, profile.timezone)} followUp={followUp && !followUp.source.startsWith("cancelled:") ? {
      id: followUp.id, type: followUp.type, at: localDateTimeValue(new Date(followUp.occurred_at * 1000), profile.timezone), subject: followSummary[0] ?? "", notes: followSummary.slice(1).join("\n")
    } : null} audits={(auditResult.results ?? []).map((audit) => ({ ...audit, createdLabel: dateTimeLabel(new Date(audit.created_at * 1000), profile.timezone) }))} /></AppShell>;
}
