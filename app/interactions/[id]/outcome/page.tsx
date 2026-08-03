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
    plannedAt: planned.toISOString(),
    subject,
    notes: noteParts.join("\n") || subject,
  }} initialNow={now.toISOString()} initialRescheduleAt={reschedule.toISOString()} /></AppShell>;
}
