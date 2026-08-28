import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { loadWorkspaceBrief } from "../../../lib/workspace/live-data";
import { classifyAssistantPrompt, RuleBasedAIService } from "../../../lib/ai/rule-based";
import type { AssistantContextSnapshot, AssistantTask } from "../../../lib/ai/types";
import { importedContextLine } from "../../../lib/relationships/historical-context";
import { loadMeetingBrief } from "../../../lib/relationships/meeting-brief";
import { familyDateLine, askLine } from "../../../lib/relationships/meeting-brief-model";
import { logger } from "../../../lib/logger";
import { getDataMode } from "../../../lib/workspace/mode";

type RequestBody = { task?: AssistantTask | "custom"; prompt?: string };
type DonorRow = { id: string; display_name: string; relationship_summary: string | null; institutional_memory: string | null };
type InteractionRow = { id: string; summary: string; occurred_at: number; role: string | null; shared_activity_recipient_count: number | null; shared_activity_summary: string | null };
type RecommendationRow = { id: string; action: string; reason: string; due_at: number | null };
type HistoricalContextRow = { text: string; source: string; source_date: number | null };
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
    const brief = await loadWorkspaceBrief(profile.id, profile.timezone, mode, now, undefined, "assistant_api");
    const primaryId = brief.priorities[0]?.donorId ?? brief.gifts[0]?.donorId ?? null;
    // The canonical, evidence-driven recommendation for the primary donor
    // -- reuses lib/relationships/meeting-brief.ts's own loader so this can
    // never diverge from what the actual Meeting Brief page shows for the
    // same donor. Live mode only; demo mode has no owner-scoped donor rows
    // for it to read.
    const primaryMeetingBrief = mode === "live" && primaryId ? await loadMeetingBrief(profile.id, primaryId, profile.timezone, now) : null;
    const primaryRecommendation = primaryMeetingBrief?.recommendation ?? null;
    const familyImportantDates = (primaryMeetingBrief?.familyImportantDates ?? []).map(familyDateLine);
    const [donor, interactions, recommendations, historicalContext] = primaryId ? await Promise.all([
      env.DB.prepare(`SELECT id, display_name, relationship_summary, institutional_memory FROM donors WHERE id = ? AND ${mode === "demo" ? "data_source = 'sample'" : "owner_user_id = ? AND data_source = 'live'"}`).bind(...(mode === "demo" ? [primaryId] : [primaryId, profile.id])).first<DonorRow>(),
      env.DB.prepare(`SELECT interactions.id, interactions.summary, interactions.occurred_at, interactions.role, shared_activities.recipient_count AS shared_activity_recipient_count, shared_activities.summary AS shared_activity_summary
        FROM interactions
        LEFT JOIN shared_activities ON shared_activities.id = interactions.shared_activity_id
        WHERE interactions.donor_id = ? ${mode === "demo" ? "" : "AND interactions.user_id = ?"} AND interactions.occurred_at <= ? AND interactions.source NOT LIKE 'cancelled:%' AND interactions.source NOT LIKE 'archived:%' AND (interactions.source LIKE 'capture-completed:%' OR (interactions.source NOT LIKE 'capture-scheduled:%' AND interactions.occurred_at <= interactions.created_at)) ORDER BY interactions.occurred_at DESC LIMIT 1`).bind(...(mode === "demo" ? [primaryId, now] : [primaryId, profile.id, now])).all<InteractionRow>(),
      env.DB.prepare(`SELECT id, action, reason, due_at FROM recommendations WHERE donor_id = ? ${mode === "demo" ? "" : "AND user_id = ?"} AND status = 'open' ORDER BY due_at LIMIT 10`).bind(...(mode === "demo" ? [primaryId] : [primaryId, profile.id])).all<RecommendationRow>(),
      // Text only for the few most recent unconfirmed rows -- kept in its
      // own query, never joined into the interactions/recommendations
      // results above, so it can only ever land in the separate
      // unconfirmedHistoricalContext field below.
      mode === "demo" ? Promise.resolve({ results: [] as HistoricalContextRow[] }) : env.DB.prepare(`SELECT text, source, source_date FROM donor_historical_context WHERE donor_id = ? AND user_id = ? AND status = 'unconfirmed' ORDER BY created_at DESC LIMIT 5`).bind(primaryId, profile.id).all<HistoricalContextRow>(),
    ]) : [null, { results: [] }, { results: [] }, { results: [] }];
    const latest = interactions.results[0];
    const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { timeZone: profile.timezone, month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
    // Same shared formatter Meeting Brief/the donor page would use for this
    // exact donor -- confirmed evidence (a real asks row), never called an
    // "opportunity."
    const openAsks = (primaryMeetingBrief?.openAsks ?? []).map((item) => askLine(item, dateLabel));
    // Relationship Snapshot Architecture Stage 3 -- reuse Meeting Brief's
    // already-resolved live Snapshot (lib/relationships/fact-synthesis.ts's
    // resolveRelationshipSnapshot(), same shared path the donor page uses)
    // rather than the raw donors.relationship_summary/institutional_memory
    // columns fetched by the query below. Never a separate Assistant-only
    // resolution: checked on `primaryMeetingBrief` itself (was a Meeting
    // Brief actually loaded for this donor?), not on its snapshot fields --
    // a fact-backed donor whose current synthesis is legitimately null
    // (e.g. their only fact is archived/superseded) must show that honest
    // null, never silently fall back to stale cached text. The `donor`
    // query's own relationship_summary/institutional_memory below remain
    // the correct source only for demo mode or the rare case with no
    // primary donor at all, where loadMeetingBrief was never called.
    const resolvedSummary = primaryMeetingBrief ? primaryMeetingBrief.relationshipSnapshot.relationshipSummary : (donor?.relationship_summary ?? null);
    const resolvedMemory = primaryMeetingBrief ? primaryMeetingBrief.relationshipSnapshot.institutionalMemory : (donor?.institutional_memory ?? null);
    const snapshot: AssistantContextSnapshot = {
      donor: { id: donor?.id ?? "", name: donor?.display_name ?? "No donor selected", summary: resolvedSummary ?? "No relationship summary is available.", memory: resolvedMemory ?? "No institutional memory is available.", unconfirmedHistoricalContext: historicalContext.results.map((item) => importedContextLine(item.text, item.source, item.source_date ? dateLabel(item.source_date) : null)), recommendation: primaryRecommendation, familyImportantDates, openAsks },
      // Prefer the shared_activities parent's summary when linked (same
      // single-canonical-copy rule as the timeline/Meeting Brief), and
      // append a count-only note for a shared activity -- "sent to N
      // donors" / "N participants" -- never the other donors' names here.
      latestInteraction: latest ? {
        id: latest.id,
        summary: `${(latest.shared_activity_summary ?? latest.summary).replace("\n", ": ")}${latest.shared_activity_recipient_count ? ` (${latest.role === "recipient" ? `sent to ${latest.shared_activity_recipient_count} donors` : `${latest.shared_activity_recipient_count} participants`})` : ""}`,
        occurredAt: new Date(latest.occurred_at * 1000).toISOString(),
      } : null,
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
