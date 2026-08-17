import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { getDataMode } from "../../../../lib/workspace/mode";
import { DobImportExperience } from "./DobImportExperience";

export const dynamic = "force-dynamic";
export default async function DobImportPage() {
  const identity = await requireChatGPTUser("/onboarding/import/dob");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  return <AppShell active="import"><main className="support-page">
    <p className="eyebrow">IMPORT CENTER</p>
    <h1>Import dates of birth</h1>
    <p className="support-lede">Bring donors' own birthdays in from a spreadsheet, matched by donor Code only -- never by name. Nothing is written until you review the preview and commit. Only updates each donor's own Birthday Important Date -- never touches gifts, pledges, interactions, or Last Contact.</p>
    {mode !== "live"
      ? <section className="support-card"><p>Date of birth import is only available in your live workspace.</p></section>
      : <DobImportExperience />}
  </main></AppShell>;
}
