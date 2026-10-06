import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { getDataMode } from "../../../../lib/workspace/mode";
import { RebbeimImportExperience } from "./RebbeimImportExperience";

export const dynamic = "force-dynamic";
export default async function RebbeimImportPage() {
  const identity = await requireChatGPTUser("/onboarding/import/rebbeim");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  return <AppShell active="import"><main className="support-page">
    <p className="eyebrow">IMPORT CENTER</p>
    <h1>Import donor Rebbeim</h1>
    <p className="support-lede">Connect donors to existing Rebbeim in the canonical directory, matched by donor Code only -- never by name. Nothing is written until you review the preview and choose to add. An unrecognized Rebbi name is never created automatically.</p>
    {mode !== "live"
      ? <section className="support-card"><p>Rebbeim import is only available in your live workspace.</p></section>
      : <RebbeimImportExperience />}
  </main></AppShell>;
}
