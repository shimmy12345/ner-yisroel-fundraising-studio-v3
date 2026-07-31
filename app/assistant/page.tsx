import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { AssistantExperience } from "./AssistantExperience";
import { requireChatGPTUser } from "../chatgpt-auth";
import { ensureUserProfile } from "../../lib/auth/profile";
import { loadWorkspaceBrief } from "../../lib/workspace/live-data";
import { getDataMode } from "../../lib/workspace/mode";

export const metadata: Metadata = { title: "Assistant" };

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const identity = await requireChatGPTUser("/assistant");
  const profile = await ensureUserProfile(identity);
  const brief = await loadWorkspaceBrief(profile.id, profile.timezone, await getDataMode(profile.id));
  return (
    <AppShell active="assistant">
      <main className="assistant-page">
        <header className="assistant-hero">
          <div className="ai-orb">✦</div>
          <h1>What can I help with?</h1>
          <p>I use your live donor, gift, interaction, and reminder records.</p>
        </header>
        <AssistantExperience brief={brief} />
      </main>
    </AppShell>
  );
}
