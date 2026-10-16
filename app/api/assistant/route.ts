import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { loadWorkspaceBrief } from "../../../lib/workspace/live-data";
import { getDataMode } from "../../../lib/workspace/mode";
import { runAssistantTurn, MAX_QUESTION_LENGTH } from "../../../lib/assistant/orchestrator.ts";
import { boundConversationState } from "../../../lib/assistant/conversation.ts";
import { logger } from "../../../lib/logger";

// Ask Fundraising OS (docs/AI-HANDOFF.md, "Upgrade Ask Fundraising OS to a
// Real AI Assistant"). Replaces the prior round's keyword-classified,
// fixed-template RuleBasedAIService (lib/ai/rule-based.ts, kept in the
// repository but no longer called from here) with a genuinely
// natural-language assistant: Cloudflare Workers AI selects from a fixed,
// read-only capability registry (lib/assistant/capabilities.ts), those
// capabilities run for real against this user's own owner-scoped data, and
// a second AI call explains only what was actually retrieved. See
// lib/assistant/orchestrator.ts for the full two-call design and its
// grounding/injection-defense rules.
//
// The four legacy quick-tool buttons (meeting-brief/draft/lapsed-
// relationships/executive-summary) still work -- translated here into a
// natural-language question so they go through the exact same real
// pipeline as a typed question, not a second/hardcoded path.

type RequestBody = {
  task?: "meeting-brief" | "draft" | "lapsed-relationships" | "executive-summary" | "next-action" | "custom";
  prompt?: string;
  conversation?: unknown;
};

const TASK_QUESTIONS: Record<string, string> = {
  "meeting-brief": "Prepare me for my next donor meeting.",
  draft: "Draft a thank-you message for a recent gift.",
  "lapsed-relationships": "Which donors haven't I spoken with recently?",
  "executive-summary": "Summarize this month's fundraising progress for me.",
  "next-action": "What should I focus on next?",
};

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => null) as RequestBody | null;
  if (!body) return Response.json({ error: "Invalid request" }, { status: 400 });

  const requested = body.task ?? "custom";
  const prompt = requested === "custom" ? (body.prompt?.trim() ?? "") : (TASK_QUESTIONS[requested] ?? "");
  if (!prompt) return Response.json({ error: "Enter a fundraising question" }, { status: 422 });
  if (prompt.length > MAX_QUESTION_LENGTH) return Response.json({ error: `Keep your question under ${MAX_QUESTION_LENGTH} characters` }, { status: 422 });

  const profile = await ensureUserProfile(identity);
  try {
    const mode = await getDataMode(profile.id);
    const now = Math.floor(Date.now() / 1000);

    // The legacy quick-tool buttons have always implicitly meant "my
    // single most relevant donor right now" -- preserved exactly, using
    // the same primary-donor resolution the prior rule-based version used
    // (first priority, else most recent gift), rather than requiring the
    // fundraiser to name someone for a one-click button to work.
    let presetDonorId: string | null = null;
    if (requested === "meeting-brief" || requested === "draft") {
      const brief = await loadWorkspaceBrief(profile.id, profile.timezone, mode, now, undefined, "assistant_api");
      presetDonorId = brief.priorities[0]?.donorId ?? brief.gifts[0]?.donorId ?? null;
    }

    const conversation = boundConversationState(body.conversation);

    const result = await runAssistantTurn({
      ai: env.AI ?? null,
      model: env.WORKERS_AI_MODEL,
      question: prompt,
      conversation,
      presetDonorId,
      ctx: { userId: profile.id, timezone: profile.timezone, mode, now },
    });

    // Never log the prompt, the retrieved CRM data, or the AI's response --
    // only that a turn happened, whether it succeeded, and (when
    // available) which capabilities were used. Same discipline as Meeting
    // Notes' own logging (app/api/meeting-notes/organize/route.ts).
    logger.info("assistant_turn_completed", {
      userId: profile.id,
      task: requested,
      available: result.available,
      capabilitiesUsed: result.available && "capabilitiesUsed" in result ? result.capabilitiesUsed.join(",") : "",
    });

    return Response.json(result);
  } catch (error) {
    logger.error("assistant_turn_failed", error, { userId: profile.id, task: requested });
    return Response.json({ available: false, error: "The Assistant could not load your live workspace" }, { status: 500 });
  }
}
