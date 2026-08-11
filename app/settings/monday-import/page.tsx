import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { getDataMode } from "../../../lib/workspace/mode";
import { MondayImportExperience } from "./MondayImportExperience";

export const dynamic = "force-dynamic";
export default async function MondayImportPage() {
  const identity = await requireChatGPTUser("/settings/monday-import");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  return <AppShell active="settings"><main className="support-page">
    <p className="eyebrow">SETTINGS</p>
    <h1>Import Monday.com historical context</h1>
    <p className="support-lede">Bring confirmed historical contact and genuinely future planned actions into this workspace from a Monday.com pipeline export. Every write requires your explicit, per-row approval -- nothing is imported automatically.</p>
    {mode !== "live"
      ? <section className="support-card"><p>Historical import is only available in your live workspace.</p></section>
      : <MondayImportExperience />}
  </main></AppShell>;
}
