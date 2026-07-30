import type { Metadata } from "next";
import { AppShell } from "../components/AppShell";

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
        <section className="suggestions" aria-label="Suggested prompts">
          <button><span>☼</span>Prepare me for today’s meeting with the Chens</button>
          <button><span>✎</span>Draft a personal thank-you for Marcus Williams</button>
          <button><span>◌</span>Who haven’t I spoken with recently?</button>
          <button><span>↗</span>Summarize this month for the president</button>
        </section>
        <div>
          <form className="assistant-composer">
            <textarea aria-label="Message the Assistant" placeholder="Ask about a donor, meeting, or fundraising priority…" />
            <div className="composer-row">
              <span className="context-chip">✦ Using today’s context</span>
              <button className="send-button" type="submit" aria-label="Send message">↑</button>
            </div>
          </form>
          <p className="assistant-note">Review drafts before sending. Recommendations always include their reasoning.</p>
        </div>
      </main>
    </AppShell>
  );
}
