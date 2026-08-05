import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { CaptureExperience } from "./CaptureExperience";
import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";

export const metadata: Metadata = { title: "Log an interaction" };

export const dynamic = "force-dynamic";

export default async function CapturePage({ searchParams }: { searchParams: Promise<{ donorId?: string; type?: string; returnTo?: string }> }) {
  const identity = await requireChatGPTUser("/capture");
  const profile = await ensureUserProfile(identity);
  const donors = await env.DB.prepare(`SELECT id, display_name, primary_first_name, last_name, spouse, spouse_first_name, donor_code, external_id, email, phone, home_phone, alternate_mobile_phone
    FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL
    ORDER BY COALESCE(NULLIF(last_name, ''), display_name) COLLATE NOCASE, display_name COLLATE NOCASE LIMIT 1000`)
    .bind(profile.id).all<{ id: string; display_name: string; primary_first_name: string | null; last_name: string | null; spouse: string | null; spouse_first_name: string | null; donor_code: string | null; external_id: string | null; email: string | null; phone: string | null; home_phone: string | null; alternate_mobile_phone: string | null }>();
  const requestedParams = await searchParams;
  const requested = requestedParams.donorId;
  const initialDonorId = requested && donors.results.some((item) => item.id === requested) ? requested : "";
  const allowedKinds = new Set(["call", "email", "meeting", "visit", "note", "personal"]);
  const initialKind = allowedKinds.has(requestedParams.type ?? "") ? requestedParams.type as "call" | "email" | "meeting" | "visit" | "note" | "personal" : null;
  return <AppShell active="donors"><CaptureExperience donors={donors.results.map((item) => ({
    id: item.id,
    name: item.display_name,
    primaryFirstName: item.primary_first_name,
    lastName: item.last_name,
    spouse: item.spouse || item.spouse_first_name,
    code: item.external_id || item.donor_code,
    email: item.email,
    phone: item.phone || item.alternate_mobile_phone || item.home_phone,
  }))} initialDonorId={initialDonorId} initialKind={initialKind} returnTo={requestedParams.returnTo === "/" ? "/" : null} initialNow={new Date().toISOString()} /></AppShell>;
}
