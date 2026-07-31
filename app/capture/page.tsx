import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { CaptureExperience } from "./CaptureExperience";
import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";

export const metadata: Metadata = { title: "Log an interaction" };

export const dynamic = "force-dynamic";

export default async function CapturePage({ searchParams }: { searchParams: Promise<{ donorId?: string }> }) {
  const identity = await requireChatGPTUser("/capture");
  const profile = await ensureUserProfile(identity);
  const donors = await env.DB.prepare("SELECT id, display_name FROM donors WHERE owner_user_id = ? AND data_source = 'live' ORDER BY display_name LIMIT 1000").bind(profile.id).all<{ id: string; display_name: string }>();
  const requested = (await searchParams).donorId;
  const initialDonorId = donors.results.some((item) => item.id === requested) ? requested! : donors.results[0]?.id ?? "";
  return <AppShell active="donors"><CaptureExperience donors={donors.results.map((item) => ({ id: item.id, name: item.display_name }))} initialDonorId={initialDonorId} /></AppShell>;
}
