// Shared Cloudflare Workers AI call wrapper (docs/AI-HANDOFF.md, "Upgrade
// Ask Fundraising OS to a Real AI Assistant"). Extracted from
// lib/meeting-notes/providers/workers-ai.ts, which was the first and, until
// this round, only caller -- that round's own comment already named this
// extraction as the right thing to do "once a second real AI feature is
// actually planned," which the Assistant now is. Both Meeting Notes and the
// Assistant call this one module; neither duplicates the response-shape
// handling, the timeout race, or the binding type.
//
// Deliberately thin: this module knows nothing about meeting notes,
// donors, or the assistant's capabilities. It takes a model id, a message
// list, and optional generation controls, and returns either the model's
// raw text or a typed failure -- callers own all prompt construction and
// response parsing, exactly as lib/meeting-notes/organize.ts already did.

export const DEFAULT_WORKERS_AI_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";

// The narrow slice of the real Workers AI `Ai` binding this module actually
// calls -- kept separate from the global `Ai` type (declared in
// cloudflare-env.d.ts) so this module stays decoupled and testable with a
// plain mock object, the same convention lib/data-health/remote-
// migrations.ts uses for D1Database.
export type AiBinding = {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
};

export type WorkersAiMessage = { role: "system" | "user" | "assistant"; content: string };

export type WorkersAiCallResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

// Workers AI's response shape differs by model family (confirmed live
// during the 2026-10-15 Meeting Notes evaluation): most catalog models
// return {response: "..."}; OpenAI-compatible models (e.g. the gpt-oss
// family) return an OpenAI chat-completions envelope,
// {choices:[{message:{content:"..."}}]}. Neither shape is assumed -- both
// are checked, and anything else is treated as an empty response rather
// than guessed at.
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
// caller is never left hanging past the timeout.
function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("workers-ai-timeout")), ms));
}

// Never throws -- every failure path (binding missing/misconfigured model,
// malformed or empty response, timeout) resolves to {ok:false, error}, so a
// caller can always fall back to a deterministic path, exactly like Meeting
// Notes' own provider-unavailable handling.
export async function callWorkersAI(params: {
  ai: AiBinding;
  messages: WorkersAiMessage[];
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  // A JSON Schema description for providers that support constraining
  // generation natively (response_format: json_schema) -- an extra
  // reliability hint only. The caller must still independently validate
  // whatever text actually comes back; schema-constrained generation is a
  // provider-side best effort, never a substitute for real validation.
  jsonSchema?: Record<string, unknown>;
}): Promise<WorkersAiCallResult> {
  const model = params.model && params.model.trim().length > 0 ? params.model.trim() : DEFAULT_WORKERS_AI_MODEL;

  try {
    const inputs: Record<string, unknown> = {
      messages: params.messages,
      max_tokens: params.maxTokens ?? 1500,
    };
    if (params.jsonSchema) {
      inputs.response_format = { type: "json_schema", json_schema: params.jsonSchema };
    }

    const result = await Promise.race([
      params.ai.run(model, inputs),
      timeoutAfter(params.timeoutMs ?? 25000),
    ]);

    const text = extractResponseText(result);
    if (!text) return { ok: false, error: "AI returned an empty response." };
    return { ok: true, text };
  } catch (error) {
    if (error instanceof Error && error.message === "workers-ai-timeout") {
      return { ok: false, error: "AI request took too long and was cancelled." };
    }
    // Never surface the raw provider error (it could echo request content,
    // and Workers AI error messages can include the input) -- only a safe,
    // generic notice. Covers an unavailable/misconfigured model id, a
    // binding error, or any other failure.
    return { ok: false, error: "AI could not be reached." };
  }
}
