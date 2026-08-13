import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { getDataMode } from "../../../../lib/workspace/mode";
import { YahrtzeitImportExperience } from "./YahrtzeitImportExperience";

export const dynamic = "force-dynamic";
export default async function YahrtzeitImportPage() {
  const identity = await requireChatGPTUser("/onboarding/import/yahrtzeit");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  return <AppShell active="import"><main className="support-page">
    <p className="eyebrow">IMPORT CENTER</p>
    <h1>Import yahrtzeits</h1>
    <p className="support-lede">Bring donor relatives' yahrtzeits in from a workbook, matched by donor Code only -- never by name. Nothing is written until you review the preview and commit. Never touches gifts, pledges, interactions, or Last Contact.</p>
    {mode !== "live"
      ? <section className="support-card"><p>Yahrtzeit import is only available in your live workspace.</p></section>
      : <YahrtzeitImportExperience />}
  </main></AppShell>;
}
