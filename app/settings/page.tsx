import { AppShell } from "../components/AppShell";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { SettingsExperience } from "./SettingsExperience";
import { DataHealthDashboard } from "./DataHealthDashboard";
import { StagingResetPanel } from "./StagingResetPanel";
import { loadDataHealth } from "../../lib/data-health/read";

export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const identity = await requireChatGPTUser("/settings");
  const profile = await ensureUserProfile(identity);
  const dataHealth = await loadDataHealth(profile.id);
  const isStagingIndependent = dataHealth.platform.deploymentEnvironment === "staging-independent";
  return <AppShell active="settings"><main className="support-page"><p className="eyebrow">SETTINGS</p><h1>Workspace settings</h1><p className="support-lede">Keep your identity and live relationship workspace current.</p><nav className="settings-section-links" aria-label="Settings sections"><a href="#data-health">Data Health</a><a href="#workspace-preferences">Workspace preferences</a>{isStagingIndependent && <a href="#developer">Developer</a>}</nav><DataHealthDashboard initialReport={dataHealth} /><div id="workspace-preferences"><SettingsExperience initialProfile={profile} /></div><section className="support-card settings-import"><div><h2>Data import</h2><p>Import or refresh JL household and donation data without changing your logged interactions, reminders, summaries, or memory. Also home to the Monday.com historical-context import, row by row, with your explicit approval.</p></div><a href="/onboarding/import">Open Import Center</a></section><section className="support-card"><h2>Data safety</h2><p>Donor information stays inside the authenticated Cloudflare application and is not sent to an external AI provider.</p><a href="/api/import/backup">Download current D1 backup</a></section>{isStagingIndependent && <section id="developer" className="support-card"><h2>Developer</h2><StagingResetPanel /></section>}</main></AppShell>;
}
