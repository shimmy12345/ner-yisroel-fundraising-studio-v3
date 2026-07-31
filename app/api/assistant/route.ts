import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { donor, todayData } from "../../data";
import { classifyAssistantPrompt, RuleBasedAIService } from "../../../lib/ai/rule-based";
import type { AssistantContextSnapshot, AssistantTask } from "../../../lib/ai/types";
import { logger } from "../../../lib/logger";

type RequestBody = {
  task?: AssistantTask | "custom";
  prompt?: string;
};

type DonorRow = { id: string; display_name: string; relationship_summary: string | null; institutional_memory: string | null };
type InteractionRow = { id: string; summary: string; occurred_at: number };
type GiftRow = { id: string; amount_cents: number; fund: string; received_at: number };
type RecommendationRow = { id: string; action: string; reason: string };

const supportedTasks = new Set<AssistantTask | "custom">([
  "custom",
  "relationship-summary",
  "meeting-brief",
  "draft",
  "next-action",
  "lapsed-relationships",
  "executive-summary",
]);

function dollars(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try {
    body = await request.json() as RequestBody;
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const prompt = body.prompt?.trim() ?? "";
  const requestedTask = body.task ?? "custom";
  if (!supportedTasks.has(requestedTask)) return Response.json({ error: "Unsupported Assistant tool" }, { status: 422 });
  if (prompt.length > 4000) return Response.json({ error: "Prompt is too long" }, { status: 422 });
  if (requestedTask === "custom" && !prompt) return Response.json({ error: "Enter a fundraising question" }, { status: 422 });

  try {
    const [donorRow, interactionResult, giftResult, recommendationResult] = await Promise.all([
      env.DB.prepare("SELECT id, display_name, relationship_summary, institutional_memory FROM donors WHERE id = ?")
        .bind("elena-chen").first<DonorRow>(),
      env.DB.prepare("SELECT id, summary, occurred_at FROM interactions WHERE donor_id = ? ORDER BY occurred_at DESC LIMIT 1")
        .bind("elena-chen").all<InteractionRow>(),
      env.DB.prepare("SELECT id, amount_cents, fund, received_at FROM gifts WHERE donor_id = ? ORDER BY received_at DESC LIMIT 5")
        .bind("elena-chen").all<GiftRow>(),
      env.DB.prepare("SELECT id, action, reason FROM recommendations WHERE donor_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 5")
        .bind("elena-chen").all<RecommendationRow>(),
    ]);

    const latestInteraction = interactionResult.results[0];
    const databaseGifts = giftResult.results.map((gift) => ({
      id: gift.id,
      name: donorRow?.display_name ?? donor.name,
      amount: dollars(gift.amount_cents),
      detail: `${gift.fund} · ${new Date(gift.received_at * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    }));
    const todayGifts = todayData.gifts.map((gift) => ({
      id: `today:gift:${gift.name.toLowerCase().replaceAll(" ", "-")}`,
      name: gift.name,
      amount: gift.amount,
      detail: gift.detail,
    }));
    const snapshot: AssistantContextSnapshot = {
      donor: {
        id: donorRow?.id ?? "elena-chen",
        name: donorRow?.display_name ?? donor.name,
        summary: donorRow?.relationship_summary ?? donor.summary,
        memory: donorRow?.institutional_memory ?? donor.memory.map((item) => item.body).join(" "),
      },
      latestInteraction: latestInteraction ? {
        id: latestInteraction.id,
        summary: latestInteraction.summary.replace("\n", ": "),
        occurredAt: new Date(latestInteraction.occurred_at * 1000).toISOString(),
      } : null,
      recommendations: recommendationResult.results,
      priorities: todayData.priorities.map(({ name, label, reason, why, action }) => ({ name, label, reason, why, action })),
      meetings: todayData.meetings.map(({ time, period, title, detail }) => ({ time, period, title, detail })),
      gifts: [...todayGifts, ...databaseGifts.filter((gift) => !todayGifts.some((item) => item.name === gift.name && item.amount === gift.amount))],
    };
    const task = requestedTask === "custom" ? classifyAssistantPrompt(prompt) : requestedTask;
    const service = new RuleBasedAIService();
    const userId = `user_${user.email.toLowerCase()}`;
    const result = await service.complete({
      task,
      prompt,
      context: {
        userId,
        donorId: snapshot.donor.id,
        interactionIds: latestInteraction ? [latestInteraction.id] : [],
        snapshot,
      },
    });

    logger.info("assistant_rule_completed", { task, userId, sourceCount: result.sourceIds.length });
    return Response.json(result);
  } catch (error) {
    logger.error("assistant_rule_failed", error, { task: requestedTask });
    return Response.json({ error: "The Assistant could not load current staging context" }, { status: 500 });
  }
}
