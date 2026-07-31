import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { SettingsExperience } from "./SettingsExperience";

export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const identity = await requireChatGPTUser("/settings");
  const profile = await ensureUserProfile(identity);
  return <AppShell active="settings"><main className="support-page"><p className="eyebrow">SETTINGS</p><h1>Workspace settings</h1><p className="support-lede">Keep your identity and live relationship workspace current.</p><SettingsExperience initialProfile={profile} /><section className="support-card settings-import"><div><h2>Data import</h2><p>Import or refresh JL household and donation data without changing your logged interactions, reminders, summaries, or memory.</p></div><a href="/onboarding/import">Open data import</a></section><section className="support-card"><h2>Data safety</h2><p>Donor information stays inside the authenticated Cloudflare application and is not sent to an external AI provider.</p><a href="/api/import/backup">Download current D1 backup</a></section></main></AppShell>;
}
