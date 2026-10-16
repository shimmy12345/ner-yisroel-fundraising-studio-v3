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
//
// The actual binding call, response-shape handling, and timeout now live in
// the shared ../../ai/workers-ai-client.ts (extracted during "Upgrade Ask
// Fundraising OS to a Real AI Assistant", the Assistant being the second
// real caller) -- this module keeps only what's specific to Meeting Notes:
// the transcript length cap and turning the shared client's result into an
// OrganizeResult via parseOrganizedResponse.

import { callWorkersAI, DEFAULT_WORKERS_AI_MODEL, type AiBinding } from "../../ai/workers-ai-client.ts";
import { buildSystemPrompt, buildUserMessage, parseOrganizedResponse, MAX_TRANSCRIPT_LENGTH, MEETING_NOTES_JSON_SCHEMA, type OrganizeResult } from "../organize.ts";

export { DEFAULT_WORKERS_AI_MODEL, type AiBinding };

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

  const result = await callWorkersAI({
    ai: params.ai,
    model: params.model,
    timeoutMs: params.timeoutMs,
    maxTokens: 1500,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserMessage(bounded) },
    ],
    // Native structured-output mode -- confirmed live against the default
    // model to reliably produce schema-conforming JSON with no markdown
    // fences. This is a best-effort hint to the model, never a substitute
    // for parseOrganizedResponse below, which still independently
    // validates whatever text actually comes back (a differently-
    // configured model may not honor this at all).
    jsonSchema: MEETING_NOTES_JSON_SCHEMA,
  });

  if (!result.ok) {
    // Preserve this provider's own wording for the two Meeting-Notes-
    // specific failure cases its tests already assert on.
    if (result.error === "AI request took too long and was cancelled.") {
      return { ok: false, error: "AI organization took too long and was cancelled." };
    }
    if (result.error === "AI returned an empty response.") {
      return { ok: false, error: "AI organization returned an empty response." };
    }
    return { ok: false, error: "AI organization could not be reached." };
  }
  return parseOrganizedResponse(result.text);
}
