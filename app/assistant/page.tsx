import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";
import { AssistantExperience } from "./AssistantExperience";

export const metadata: Metadata = { title: "Assistant" };

export default function AssistantPage() {
  return (
    <AppShell active="assistant">
      <main className="assistant-page">
        <header className="assistant-hero">
          <div className="ai-orb">✦</div>
          <h1>What can I help with?</h1>
          <p>I understand your relationships, calendar, and recent activity.</p>
        </header>
        <AssistantExperience />
      </main>
    </AppShell>
  );
}
