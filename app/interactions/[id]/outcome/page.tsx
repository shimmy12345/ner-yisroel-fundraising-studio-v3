import { env } from "cloudflare:workers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { isScheduledActivity } from "../../../../lib/workspace/scheduled-activity";
import { OutcomeExperience } from "./OutcomeExperience";

export const dynamic = "force-dynamic";

type ActivityRow = {
  id: string;
  donor_id: string;
  display_name: string;
  type: string;
  occurred_at: number;
  summary: string;
  source: string;
  created_at: number;
};

function localDateTimeValue(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function dateTimeLabel(date: Date, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default async function ActivityOutcomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireChatGPTUser(`/interactions/${encodeURIComponent(id)}/outcome`);
  const profile = await ensureUserProfile(identity);
  const activity = await env.DB.prepare(`SELECT i.id, i.donor_id, d.display_name, i.type, i.occurred_at, i.summary, i.source, i.created_at
    FROM interactions i JOIN donors d ON d.id = i.donor_id
    WHERE i.id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`)
    .bind(id, profile.id, profile.id).first<ActivityRow>();
  if (!activity || !isScheduledActivity(activity.source, activity.occurred_at, activity.created_at)) notFound();
  const [subject = "Interaction", ...noteParts] = activity.summary.split("\n");
  const now = new Date();
  const planned = new Date(activity.occurred_at * 1000);
  const reschedule = planned.getTime() > now.getTime() ? planned : new Date(now.getTime() + 86400000);
  return <AppShell active="donors"><OutcomeExperience activity={{
    id: activity.id,
    donorId: activity.donor_id,
    donorName: activity.display_name,
    type: activity.type,
    plannedLabel: dateTimeLabel(planned, profile.timezone),
    subject,
    notes: noteParts.join("\n") || subject,
  }} initialCompletedValue={localDateTimeValue(now, profile.timezone)} initialRescheduleValue={localDateTimeValue(reschedule, profile.timezone)} /></AppShell>;
}
