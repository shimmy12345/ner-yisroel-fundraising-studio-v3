"use client";

import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { BriefExperience } from "../components/BriefExperience";
import type { WorkspaceBrief } from "../../lib/workspace/live-data";

// Ask Fundraising OS -- real AI assistant chat interface (docs/
// AI-HANDOFF.md, "Upgrade Ask Fundraising OS to a Real AI Assistant").
// Conversation history and the donors most recently discussed are kept in
// this component's own state and sent back with every request (bounded,
// client-held context -- lib/assistant/conversation-state.ts does the
// actual bounding/validation server-side; nothing here is trusted as
// authorization, only as "what was discussed," re-verified every turn).

type DonorRef = { donorId: string; name: string; href: string };

type AssistantAnswer = {
  available: true;
  answer: string;
  suggestedNextQuestions: string[];
  referencedDonors: DonorRef[];
  donorRefs: DonorRef[];
  capabilitiesUsed: string[];
};
type AssistantClarification = { available: true; clarification: true; message: string; candidates: DonorRef[] };
type AssistantUnavailable = { available: false; error: string };
type AssistantResult = AssistantAnswer | AssistantClarification | AssistantUnavailable;

type ChatMessage =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; referencedDonors: DonorRef[]; suggestedNextQuestions: string[] }
  | { id: string; role: "assistant-clarification"; content: string; candidates: DonorRef[] }
  | { id: string; role: "assistant-error"; content: string };

const tools: Array<{ task: "meeting-brief" | "draft" | "lapsed-relationships" | "executive-summary"; icon: string; label: string }> = [
  { task: "meeting-brief", icon: "☼", label: "Prepare me for my next donor meeting" },
  { task: "draft", icon: "✎", label: "Draft a thank-you for a recent gift" },
  { task: "lapsed-relationships", icon: "◌", label: "Who haven’t I spoken with recently?" },
  { task: "executive-summary", icon: "↗", label: "Summarize this month for the president" },
];

let nextMessageId = 0;
function messageId() {
  nextMessageId += 1;
  return `m${nextMessageId}`;
}

export function AssistantExperience({ brief, timezone }: { brief: WorkspaceBrief; timezone: string }) {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastDonorRefs, setLastDonorRefs] = useState<DonorRef[]>([]);
  const [loading, setLoading] = useState(false);
  const inFlightRef = useRef(false);

  async function send(task: "custom" | "meeting-brief" | "draft" | "lapsed-relationships" | "executive-summary", text: string) {
    if (inFlightRef.current) return;
    const value = text.trim();
    if (task === "custom" && !value) return;

    inFlightRef.current = true;
    setLoading(true);
    if (task === "custom") {
      setMessages((prev) => [...prev, { id: messageId(), role: "user", content: value }]);
      setPrompt("");
    }

    try {
      const history = messages
        .filter((m): m is Extract<ChatMessage, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, prompt: value, conversation: { history, lastDonorRefs } }),
      });
      const result = await response.json() as AssistantResult;

      if (!result.available) {
        setMessages((prev) => [...prev, { id: messageId(), role: "assistant-error", content: result.error }]);
        return;
      }
      if ("clarification" in result) {
        setMessages((prev) => [...prev, { id: messageId(), role: "assistant-clarification", content: result.message, candidates: result.candidates }]);
        return;
      }
      setMessages((prev) => [...prev, { id: messageId(), role: "assistant", content: result.answer, referencedDonors: result.referencedDonors, suggestedNextQuestions: result.suggestedNextQuestions }]);
      setLastDonorRefs(result.donorRefs);
    } catch {
      setMessages((prev) => [...prev, { id: messageId(), role: "assistant-error", content: "The Assistant could not reach current workspace data. Your message is still here -- try again." }]);
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  function submitPrompt(event: FormEvent) {
    event.preventDefault();
    void send("custom", prompt);
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void send("custom", prompt);
    }
  }

  return (
    <div className="assistant-experience">
      <BriefExperience surface="assistant" data={brief} timezone={timezone} />

      <section className="suggestions" aria-label="Suggested prompts">
        {tools.map((tool) => (
          <button type="button" key={tool.task} onClick={() => void send(tool.task, tool.label)} disabled={loading}>
            <span>{tool.icon}</span>
            {tool.label}
          </button>
        ))}
      </section>

      <section className="assistant-chat" aria-live="polite" aria-label="Conversation with the Assistant">
        {messages.length === 0 && (
          <p className="assistant-result-empty">Ask a fundraising question in your own words -- “who should I call today?”, “summarize my relationship with a donor,” “which payment plans need attention?” Every answer is grounded in your actual CRM data, never invented.</p>
        )}
        {messages.map((message) => {
          if (message.role === "user") {
            return <div key={message.id} className="assistant-message assistant-message-user"><p>{message.content}</p></div>;
          }
          if (message.role === "assistant-error") {
            return <div key={message.id} className="assistant-message assistant-message-error" role="alert"><strong>Assistant unavailable</strong><p>{message.content}</p></div>;
          }
          if (message.role === "assistant-clarification") {
            return (
              <div key={message.id} className="assistant-message assistant-message-clarification">
                <p>{message.content}</p>
                <ul className="assistant-donor-candidates">
                  {message.candidates.map((donor) => (
                    <li key={donor.donorId}>
                      <button type="button" onClick={() => void send("custom", `Tell me about ${donor.name}`)}>{donor.name}</button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }
          return (
            <div key={message.id} className="assistant-message assistant-message-assistant">
              <div className="assistant-verified-label">Grounded in your CRM data</div>
              <p>{message.content}</p>
              {message.referencedDonors.length > 0 && (
                <div className="assistant-donor-links">
                  {message.referencedDonors.map((donor) => (
                    <a key={donor.donorId} href={donor.href}>{donor.name} →</a>
                  ))}
                </div>
              )}
              {message.suggestedNextQuestions.length > 0 && (
                <div className="assistant-suggested-questions">
                  {message.suggestedNextQuestions.map((q) => (
                    <button type="button" key={q} onClick={() => void send("custom", q)} disabled={loading}>{q}</button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {loading && (
          <div className="assistant-result-state" role="status">
            <span className="assistant-result-spinner" aria-hidden="true" />
            <div><strong>Checking your live workspace</strong><p>Retrieving the real donor, gift, pledge, and priority records this answer needs.</p></div>
          </div>
        )}
      </section>

      <div>
        <form className="assistant-composer" onSubmit={submitPrompt}>
          <textarea
            aria-label="Message the Assistant"
            placeholder="Ask about a donor, meeting, or fundraising priority…"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handlePromptKeyDown}
          />
          <div className="composer-row">
            <span className="context-chip">Cloudflare Workers AI · Live workspace data</span>
            <button className="send-button" type="submit" aria-label="Send message" disabled={loading} aria-busy={loading}>
              {loading ? "…" : "↑"}
            </button>
          </div>
        </form>
        <p className="assistant-note">Answers are generated from your real, current CRM records -- never invented. Review drafts before sending. The Assistant cannot create, edit, or send anything on its own.</p>
      </div>
    </div>
  );
}
