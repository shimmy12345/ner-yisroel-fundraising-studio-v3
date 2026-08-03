import { env } from "cloudflare:workers";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { CaptureExperience } from "../../../capture/CaptureExperience";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import type { InteractionKind } from "../../../../lib/capture/interaction";

export const dynamic = "force-dynamic";

type InteractionRow = { id: string; donor_id: string; type: string; occurred_at: number; summary: string; source: string };
type ReminderRow = { due_at: number | null };
type DonorRow = { id: string; display_name: string; last_name: string | null; spouse: string | null; spouse_first_name: string | null; donor_code: string | null; external_id: string | null; email: string | null; phone: string | null; home_phone: string | null; alternate_mobile_phone: string | null };
const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal"]);

export default async function EditActivityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ returnTo?: string }> }) {
  const { id } = await params;
  const identity = await requireChatGPTUser(`/interactions/${encodeURIComponent(id)}/edit`);
  const profile = await ensureUserProfile(identity);
  const [activity, reminder, donors] = await Promise.all([
    env.DB.prepare(`SELECT i.id, i.donor_id, i.type, i.occurred_at, i.summary, i.source FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE i.id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%' LIMIT 1`).bind(id, profile.id, profile.id).first<InteractionRow>(),
    env.DB.prepare("SELECT due_at FROM recommendations WHERE id = ? AND user_id = ? AND status = 'open' LIMIT 1").bind(`activity-${id}`, profile.id).first<ReminderRow>(),
    env.DB.prepare(`SELECT id, display_name, last_name, spouse, spouse_first_name, donor_code, external_id, email, phone, home_phone, alternate_mobile_phone FROM donors
      WHERE owner_user_id = ? AND data_source = 'live' ORDER BY COALESCE(NULLIF(last_name, ''), display_name) COLLATE NOCASE, display_name COLLATE NOCASE LIMIT 1000`).bind(profile.id).all<DonorRow>(),
  ]);
  if (!activity) notFound();
  const [subject = "Interaction", ...noteParts] = activity.summary.split("\n");
  const kind = kinds.has(activity.type as InteractionKind) ? activity.type as InteractionKind : "note";
  const reminderDate = reminder?.due_at ? new Date(reminder.due_at * 1000).toISOString().slice(0, 10) : null;
  const requestedReturn = (await searchParams).returnTo;
  const returnTo = requestedReturn === "/" ? "/" : `/donors/${encodeURIComponent(activity.donor_id)}`;
  return <AppShell active="donors"><CaptureExperience donors={donors.results.map((item) => ({
    id: item.id, name: item.display_name, lastName: item.last_name, spouse: item.spouse || item.spouse_first_name,
    code: item.external_id || item.donor_code, email: item.email, phone: item.phone || item.alternate_mobile_phone || item.home_phone,
  }))} initialDonorId={activity.donor_id} initialKind={kind} returnTo={returnTo} initialActivity={{
    id: activity.id, donorId: activity.donor_id, kind, subject, note: noteParts.join("\n") || subject,
    occurredAt: new Date(activity.occurred_at * 1000).toISOString(), reminderDate,
  }} /></AppShell>;
}
