import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "cloudflare:workers";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { MeetingNotesExperience } from "./MeetingNotesExperience";

export const metadata: Metadata = { title: "Add meeting notes" };
export const dynamic = "force-dynamic";

export default async function MeetingNotesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const identity = await requireChatGPTUser(`/donors/${encodeURIComponent(id)}/meeting-notes`);
  const profile = await ensureUserProfile(identity);

  // Same ownership + live-data-only check every donor-scoped mutation in
  // this app uses -- a fundraiser can only add meeting notes to a donor
  // that is their own, real, live record (never a demo/sample donor).
  const donor = await env.DB.prepare("SELECT id, display_name FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
    .bind(id, profile.id).first<{ id: string; display_name: string }>();
  if (!donor) notFound();

  return <AppShell active="donors">
    <MeetingNotesExperience
      donorId={donor.id}
      donorName={donor.display_name}
      returnTo={`/donors/${encodeURIComponent(donor.id)}`}
      initialNow={new Date().toISOString()}
    />
  </AppShell>;
}
