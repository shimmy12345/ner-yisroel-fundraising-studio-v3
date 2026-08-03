import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { loadWorkspaceBrief } from "../../../lib/workspace/live-data";
import { classifyAssistantPrompt, RuleBasedAIService } from "../../../lib/ai/rule-based";
import type { AssistantContextSnapshot, AssistantTask } from "../../../lib/ai/types";
import { logger } from "../../../lib/logger";
import { getDataMode } from "../../../lib/workspace/mode";

type RequestBody = { task?: AssistantTask | "custom"; prompt?: string };
type DonorRow = { id: string; display_name: string; relationship_summary: string | null; institutional_memory: string | null };
type InteractionRow = { id: string; summary: string; occurred_at: number };
type RecommendationRow = { id: string; action: string; reason: string; due_at: number | null };
const supported = new Set(["custom", "relationship-summary", "meeting-brief", "draft", "next-action", "lapsed-relationships", "executive-summary"]);

export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const body = await request.json().catch(() => null) as RequestBody | null;
  if (!body) return Response.json({ error: "Invalid request" }, { status: 400 });
  const prompt = body.prompt?.trim() ?? "";
  const requested = body.task ?? "custom";
  if (!supported.has(requested) || prompt.length > 4000) return Response.json({ error: "Unsupported Assistant request" }, { status: 422 });
  if (requested === "custom" && !prompt) return Response.json({ error: "Enter a fundraising question" }, { status: 422 });
  const profile = await ensureUserProfile(identity);
  try {
    const mode = await getDataMode(profile.id);
    const now = Math.floor(Date.now() / 1000);
    const brief = await loadWorkspaceBrief(profile.id, profile.timezone, mode, now);
    const primaryId = brief.priorities[0]?.donorId ?? brief.gifts[0]?.donorId ?? null;
    const [donor, interactions, recommendations] = primaryId ? await Promise.all([
      env.DB.prepare(`SELECT id, display_name, relationship_summary, institutional_memory FROM donors WHERE id = ? AND ${mode === "demo" ? "data_source = 'sample'" : "owner_user_id = ? AND data_source = 'live'"}`).bind(...(mode === "demo" ? [primaryId] : [primaryId, profile.id])).first<DonorRow>(),
      env.DB.prepare(`SELECT id, summary, occurred_at FROM interactions WHERE donor_id = ? ${mode === "demo" ? "" : "AND user_id = ?"} AND occurred_at <= ? AND source NOT LIKE 'cancelled:%' AND source NOT LIKE 'archived:%' AND (source LIKE 'capture-completed:%' OR (source NOT LIKE 'capture-scheduled:%' AND occurred_at <= created_at)) ORDER BY occurred_at DESC LIMIT 1`).bind(...(mode === "demo" ? [primaryId, now] : [primaryId, profile.id, now])).all<InteractionRow>(),
      env.DB.prepare(`SELECT id, action, reason, due_at FROM recommendations WHERE donor_id = ? ${mode === "demo" ? "" : "AND user_id = ?"} AND status = 'open' ORDER BY due_at LIMIT 10`).bind(...(mode === "demo" ? [primaryId] : [primaryId, profile.id])).all<RecommendationRow>(),
    ]) : [null, { results: [] }, { results: [] }];
    const latest = interactions.results[0];
    const snapshot: AssistantContextSnapshot = {
      donor: { id: donor?.id ?? "", name: donor?.display_name ?? "No donor selected", summary: donor?.relationship_summary ?? "No relationship summary is available.", memory: donor?.institutional_memory ?? "No institutional memory is available." },
      latestInteraction: latest ? { id: latest.id, summary: latest.summary.replace("\n", ": "), occurredAt: new Date(latest.occurred_at * 1000).toISOString() } : null,
      recommendations: recommendations.results.map((item) => ({ id: item.id, action: item.action, reason: item.reason, dueAt: item.due_at ? new Date(item.due_at * 1000).toISOString() : null })),
      priorities: brief.priorities.map(({ name, label, reason, why, action }) => ({ name, label, reason, why, action })), meetings: brief.meetings, gifts: brief.gifts.map(({ id, name, amount, detail }) => ({ id, name, amount, detail })),
    };
    const task = requested === "custom" ? classifyAssistantPrompt(prompt) : requested as AssistantTask;
    const result = await new RuleBasedAIService().complete({ task, prompt, context: { userId: profile.id, donorId: donor?.id, interactionIds: latest ? [latest.id] : [], snapshot } });
    logger.info("assistant_rule_completed", { task, userId: profile.id, sourceCount: result.sourceIds.length });
    return Response.json(result);
  } catch (error) {
    logger.error("assistant_rule_failed", error, { userId: profile.id, task: requested });
    return Response.json({ error: "The Assistant could not load your live workspace" }, { status: 500 });
  }
}
