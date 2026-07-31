"use client";

import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { BriefExperience } from "../components/BriefExperience";
import type { AIResult, AssistantTask } from "../../lib/ai/types";
import type { WorkspaceBrief } from "../../lib/workspace/live-data";

type SubmissionState = "idle" | "loading" | "success" | "empty" | "error";

const tools: Array<{ task: AssistantTask; icon: string; label: string }> = [
  { task: "meeting-brief", icon: "☼", label: "Prepare me for my next donor meeting" },
  { task: "draft", icon: "✎", label: "Draft a thank-you for a recent gift" },
  { task: "lapsed-relationships", icon: "◌", label: "Who haven’t I spoken with recently?" },
  { task: "executive-summary", icon: "↗", label: "Summarize this month for the president" },
];

export function AssistantExperience({ brief }: { brief: WorkspaceBrief }) {
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<SubmissionState>("idle");
  const [result, setResult] = useState<AIResult | null>(null);
  const [error, setError] = useState("");
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  async function submit(task: AssistantTask | "custom", submittedPrompt: string) {
    if (inFlightRef.current) return;
    const value = submittedPrompt.trim();
    if (task === "custom" && !value) {
      setResult(null);
      setState("empty");
      setError("");
      return;
    }

    inFlightRef.current = true;
    setState("loading");
    setError("");
    setActiveTool(task);

    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, prompt: value }),
      });
      const payload = await response.json() as AIResult | { error?: string };
      if (!response.ok) throw new Error("error" in payload ? payload.error : "Assistant request failed");
      const nextResult = payload as AIResult;
      if (!nextResult.content?.trim()) {
        setResult(null);
        setState("empty");
      } else {
        setResult(nextResult);
        setState("success");
      }
    } catch (requestError) {
      setResult(null);
      setState("error");
      setError(requestError instanceof Error && requestError.message !== "Failed to fetch"
        ? requestError.message
        : "The Assistant could not reach current staging data. Your prompt is still here—try again.");
    } finally {
      inFlightRef.current = false;
      setActiveTool(null);
    }
  }

  function submitPrompt(event: FormEvent) {
    event.preventDefault();
    void submit("custom", prompt);
  }

  function handlePromptKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit("custom", prompt);
    }
  }

  const loading = state === "loading";

  return (
    <div className="assistant-experience">
      <BriefExperience surface="assistant" data={brief} />

      <section className="suggestions" aria-label="Suggested prompts">
        {tools.map((tool) => (
          <button
            type="button"
            key={tool.task}
            onClick={() => void submit(tool.task, tool.label)}
            disabled={loading}
            aria-busy={loading && activeTool === tool.task}
          >
            <span>{tool.icon}</span>
            {loading && activeTool === tool.task ? "Working…" : tool.label}
          </button>
        ))}
      </section>

      <section className="assistant-result" aria-live="polite" aria-label="Assistant result">
        {state === "idle" && (
          <p className="assistant-result-empty">Choose a tool or ask a fundraising question. Results use current staging records and transparent rules.</p>
        )}
        {state === "loading" && (
          <div className="assistant-result-state" role="status">
            <span className="assistant-result-spinner" aria-hidden="true" />
            <div><strong>Working from current context</strong><p>Checking donor, gift, interaction, reminder, timeline, and priority data.</p></div>
          </div>
        )}
        {state === "empty" && (
          <div className="assistant-result-state" role="status">
            <div><strong>Enter a fundraising question</strong><p>Your prompt was not submitted because it was empty.</p></div>
          </div>
        )}
        {state === "error" && (
          <div className="assistant-result-state error" role="alert">
            <div><strong>Assistant unavailable</strong><p>{error}</p></div>
          </div>
        )}
        {state === "success" && result && (
          <article className="assistant-result-card">
            <div className="assistant-result-heading">
              <div><span>Rule-based response</span><h2>{result.title}</h2></div>
              <span>{result.sourceIds.length} source{result.sourceIds.length === 1 ? "" : "s"}</span>
            </div>
            <div className="assistant-result-content">{result.content}</div>
            <div className="assistant-result-rationale">
              <strong>Why this result</strong>
              <ul>{result.rationale.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            </div>
          </article>
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
            <span className="context-chip">Rule-based · Live workspace data</span>
            <button className="send-button" type="submit" aria-label="Send message" disabled={loading} aria-busy={loading}>
              {loading ? "…" : "↑"}
            </button>
          </div>
        </form>
        <p className="assistant-note">Responses are rule-based from your current live workspace. Review drafts before sending.</p>
      </div>
    </div>
  );
}
