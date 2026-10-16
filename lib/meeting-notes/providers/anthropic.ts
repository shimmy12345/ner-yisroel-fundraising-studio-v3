// AI Meeting Notes -- Anthropic Claude provider (docs/AI-HANDOFF.md,
// "Voice Dictation and AI Meeting Notes" / "Evaluate Cloudflare Workers AI
// as an Alternative to Anthropic"). Kept as a configurable, currently
// INACTIVE alternative to the default Cloudflare Workers AI provider
// (../workers-ai.ts) -- selected only if an operator explicitly sets
// AI_PROVIDER="anthropic" on a deployment AND configures the
// ANTHROPIC_API_KEY secret, neither of which is done on any environment as
// of this round. This module itself never reads an env var or secret; it
// takes apiKey/model as explicit arguments so it stays trivially testable
// with a mock fetchImpl and never needs a real secret in a test process.

import { buildSystemPrompt, buildUserMessage, parseOrganizedResponse, MAX_TRANSCRIPT_LENGTH, type OrganizeResult } from "../organize.ts";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-5-5";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Never throws -- every failure path (network error, timeout, non-200,
// malformed body) resolves to {ok:false, error}, so a caller can always
// fall back to manual entry.
export async function organizeWithAnthropic(params: {
  transcript: string;
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<OrganizeResult> {
  const transcript = params.transcript.trim();
  if (transcript.length === 0) return { ok: false, error: "There is no meeting text to organize yet." };
  const bounded = transcript.length > MAX_TRANSCRIPT_LENGTH ? transcript.slice(0, MAX_TRANSCRIPT_LENGTH) : transcript;

  const fetchImpl = params.fetchImpl ?? fetch;
  const model = params.model && params.model.trim().length > 0 ? params.model.trim() : DEFAULT_ANTHROPIC_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 25000);

  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": params.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: buildUserMessage(bounded) }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Never surface the raw provider error body (it could echo request
      // content back) -- only the status, which is safe and useful enough
      // for an operator reading logs to know "it's failing", not why in
      // donor-content terms.
      return { ok: false, error: `AI organization is temporarily unavailable (provider returned ${response.status}).` };
    }

    const body = await response.json() as { content?: Array<{ type?: string; text?: string }> };
    const textBlock = body.content?.find((block) => block.type === "text");
    if (!textBlock?.text) return { ok: false, error: "AI organization returned an empty response." };
    return parseOrganizedResponse(textBlock.text);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: "AI organization took too long and was cancelled." };
    }
    return { ok: false, error: "AI organization could not be reached." };
  } finally {
    clearTimeout(timeout);
  }
}
