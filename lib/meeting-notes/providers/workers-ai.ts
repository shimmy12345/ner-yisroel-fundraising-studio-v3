// AI Meeting Notes -- Cloudflare Workers AI provider (docs/AI-HANDOFF.md,
// "Evaluate Cloudflare Workers AI as an Alternative to Anthropic for AI
// Meeting Notes"). This is the DEFAULT provider: it uses the `AI` binding
// already available on the same Cloudflare account that runs this Worker --
// no separate API key, account, or billing setup, unlike the Anthropic
// provider (../anthropic.ts), which stays available but inactive.
//
// Called server-side only, from app/api/meeting-notes/organize/route.ts,
// which holds the binding; this module never reads env itself (takes the
// binding as an explicit argument), so it stays trivially testable with a
// mock AiBinding and never needs a real binding in a test process.
//
// Workers AI is a BINDING call (env.AI.run), not a fetch() to an external
// URL -- there is no request body to log and no secret header to ever leak,
// and the transcript never leaves Cloudflare's own infrastructure.

import { buildSystemPrompt, buildUserMessage, parseOrganizedResponse, MAX_TRANSCRIPT_LENGTH, MEETING_NOTES_JSON_SCHEMA, type OrganizeResult } from "../organize.ts";

export const DEFAULT_WORKERS_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

// The narrow slice of the real Workers AI `Ai` binding this module actually
// calls -- kept separate from the global `Ai` type (declared in
// cloudflare-env.d.ts) so this module stays decoupled and testable with a
// plain mock object, the same convention lib/data-health/remote-
// migrations.ts uses for D1Database.
export type AiBinding = {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
};

// Workers AI's response shape differs by model family (confirmed live
// during the 2026-10-15 evaluation): most catalog models return
// {response: "..."}; OpenAI-compatible models (e.g. the gpt-oss family)
// return an OpenAI chat-completions envelope, {choices:[{message:
// {content:"..."}}]}. Neither shape is assumed -- both are checked, and
// anything else is treated as an empty response rather than guessed at.
function extractResponseText(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const record = result as Record<string, unknown>;

  if (typeof record.response === "string" && record.response.trim().length > 0) {
    return record.response;
  }

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object" && choices[0] !== null) {
    const message = (choices[0] as Record<string, unknown>).message;
    if (typeof message === "object" && message !== null) {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string" && content.trim().length > 0) return content;
    }
  }

  return null;
}

// A timer-based race, not an AbortController -- the Workers AI binding's
// run() call takes no AbortSignal. A timeout here only stops this function
// from waiting forever; it does not cancel the in-flight inference request
// itself (Workers AI has no cancellation API), but it still guarantees the
// caller (and the fundraiser waiting on the "Organize Notes" button) is
// never left hanging past the timeout.
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("workers-ai-timeout")), ms));
}

// Never throws -- every failure path (binding missing/misconfigured model,
// malformed or empty response, timeout) resolves to {ok:false, error}, so a
// caller can always fall back to manual entry, exactly like the Anthropic
// provider.
export async function organizeWithWorkersAI(params: {
  transcript: string;
  ai: AiBinding;
  model?: string;
  timeoutMs?: number;
}): Promise<OrganizeResult> {
  const transcript = params.transcript.trim();
  if (transcript.length === 0) return { ok: false, error: "There is no meeting text to organize yet." };
  const bounded = transcript.length > MAX_TRANSCRIPT_LENGTH ? transcript.slice(0, MAX_TRANSCRIPT_LENGTH) : transcript;

  const model = params.model && params.model.trim().length > 0 ? params.model.trim() : DEFAULT_WORKERS_AI_MODEL;

  try {
    const result = await Promise.race([
      params.ai.run(model, {
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: buildUserMessage(bounded) },
        ],
        max_tokens: 1500,
        // Native structured-output mode -- confirmed live against the
        // default model to reliably produce schema-conforming JSON with no
        // markdown fences. This is a best-effort hint to the model, never a
        // substitute for parseOrganizedResponse below, which still
        // independently validates whatever text actually comes back
        // (a differently-configured model may not honor this at all).
        response_format: { type: "json_schema", json_schema: MEETING_NOTES_JSON_SCHEMA },
      }),
      timeoutAfter(params.timeoutMs ?? 25000),
    ]);

    const text = extractResponseText(result);
    if (!text) return { ok: false, error: "AI organization returned an empty response." };
    return parseOrganizedResponse(text);
  } catch (error) {
    if (error instanceof Error && error.message === "workers-ai-timeout") {
      return { ok: false, error: "AI organization took too long and was cancelled." };
    }
    // Never surface the raw provider error (it could echo request content,
    // and Workers AI error messages can include the input) -- only a safe,
    // generic notice. Covers an unavailable/misconfigured model id, a
    // binding error, or any other failure.
    return { ok: false, error: "AI organization could not be reached." };
  }
}
