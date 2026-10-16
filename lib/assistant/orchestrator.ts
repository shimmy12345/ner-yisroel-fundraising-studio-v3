// Ask Fundraising OS -- the real AI assistant's orchestration (docs/
// AI-HANDOFF.md, "Upgrade Ask Fundraising OS to a Real AI Assistant").
//
// Exactly two AI calls per user turn, never more (no agentic looping, no
// unbounded tool-call chain):
//   1. PLAN -- given the question and bounded conversation context, the
//      model selects up to MAX_CAPABILITIES_PER_TURN names from the fixed
//      capability registry (./capabilities.ts) and a donor reference, as
//      structured JSON (./protocol.ts owns the prompt and the strict
//      parsing/clamping of this response). The model never writes a query
//      and never sees a donor id it didn't already have from this same
//      conversation -- it only ever names a donor, which this module then
//      resolves deterministically (./conversation.ts).
//   2. COMPOSE -- the selected capabilities are executed for real (plain
//      function calls, no AI involved), and their REAL, verified output is
//      handed back to the model as a clearly-delimited, "data not
//      instructions" block, with an explicit instruction never to state
//      anything not present in that block. The model's only job here is to
//      explain and phrase what was actually retrieved.
//
// If the plan step selects a donor reference that resolves to more than
// one real donor, or to none, this module answers directly from that
// resolution -- never a third AI call, never a guess at which donor was
// meant.
//
// This is the one file in lib/assistant/ that ties the pure protocol
// (./protocol.ts) to both the AI client (../ai/workers-ai-client.ts) and
// the `cloudflare:workers`-dependent capability/conversation layers,
// which is why it -- like them -- cannot be imported directly in a Node
// test process. Its own logic is kept thin specifically so almost
// everything it calls is independently tested elsewhere:
// tests/assistant-protocol.test.mjs for parsing/prompt construction,
// tests/assistant-conversation-state.test.mjs for context bounding, and
// live Staging verification (docs/AI-HANDOFF.md) for the real database
// and AI behavior this module wires together.

import { callWorkersAI, type AiBinding } from "../ai/workers-ai-client.ts";
import {
  CAPABILITY_DESCRIPTIONS,
  getTodaysPriorities,
  getThisWeekPriorities,
  getLapsedRelationships,
  getOutstandingPledges,
  getPaymentPlansAttention,
  getDonorSummary,
  getFundraisingProgress,
  type AssistantContext,
  type DonorRef,
} from "./capabilities.ts";
import { resolveDonorReference, donorHref, type ConversationState } from "./conversation.ts";
import {
  buildPlanSystemPrompt,
  buildComposeSystemPrompt,
  delimited,
  formatHistoryForPrompt,
  parsePlanResponse,
  parseComposeResponse,
  appendFinancialLimitations,
  PLAN_JSON_SCHEMA,
  ANSWER_JSON_SCHEMA,
  type ParsedPlan,
} from "./protocol.ts";

import { MAX_QUESTION_LENGTH } from "./conversation-state.ts";
export { MAX_QUESTION_LENGTH } from "./conversation-state.ts";
export { MAX_CAPABILITIES_PER_TURN } from "./protocol.ts";

export const PLAN_TIMEOUT_MS = 12000;
export const COMPOSE_TIMEOUT_MS = 20000;

async function planTurn(ai: AiBinding, model: string | undefined, question: string, state: ConversationState): Promise<ParsedPlan | null> {
  const result = await callWorkersAI({
    ai,
    model,
    timeoutMs: PLAN_TIMEOUT_MS,
    maxTokens: 300,
    jsonSchema: PLAN_JSON_SCHEMA,
    messages: [
      { role: "system", content: buildPlanSystemPrompt(CAPABILITY_DESCRIPTIONS) },
      { role: "user", content: [delimited("CONVERSATION_HISTORY", formatHistoryForPrompt(state.history)), "", `Fundraiser's current question: ${question}`].join("\n") },
    ],
  });
  if (!result.ok) return null;
  return parsePlanResponse(result.text);
}

// Reads fundraising_progress's own disclosed `limitations` back out of
// the retrieved data, defensively (this is the one capability whose
// result is always treated as carrying a critical financial disclosure
// -- see appendFinancialLimitations's own caller). Never throws on an
// unexpected shape; simply finds nothing to enforce.
function financialLimitationsFrom(data: Record<string, unknown>): string[] {
  const progress = data.fundraising_progress;
  if (!progress || typeof progress !== "object") return [];
  const limitations = (progress as { limitations?: unknown }).limitations;
  return Array.isArray(limitations) ? limitations.filter((l): l is string => typeof l === "string") : [];
}

// Executes exactly the capabilities the plan step named -- a fixed
// dispatch over the known registry, never a dynamic call built from AI
// output. donorId is only ever passed to a capability that the dispatch
// below explicitly wires it to (today, only donor_summary); a capability
// with no use for a donor id never receives one.
async function runCapabilities(names: string[], ctx: AssistantContext, donor: DonorRef | null): Promise<{ data: Record<string, unknown>; donorRefs: DonorRef[] }> {
  const data: Record<string, unknown> = {};
  const donorRefs: DonorRef[] = [];
  const seen = new Set<string>();
  const addRefs = (refs: DonorRef[]) => {
    for (const ref of refs) {
      if (seen.has(ref.donorId)) continue;
      seen.add(ref.donorId);
      donorRefs.push(ref);
    }
  };

  for (const name of names) {
    if (name === "todays_priorities") {
      const r = await getTodaysPriorities(ctx);
      data.todays_priorities = r.items;
      addRefs(r.donorRefs);
    } else if (name === "this_week_priorities") {
      const r = await getThisWeekPriorities(ctx);
      data.this_week_priorities = r.items;
      addRefs(r.donorRefs);
    } else if (name === "lapsed_relationships") {
      const r = await getLapsedRelationships(ctx);
      data.lapsed_relationships = r.items;
      addRefs(r.donorRefs);
    } else if (name === "outstanding_pledges") {
      const r = await getOutstandingPledges(ctx);
      data.outstanding_pledges = r.items;
      addRefs(r.donorRefs);
    } else if (name === "payment_plans_attention") {
      const r = await getPaymentPlansAttention(ctx);
      data.payment_plans_attention = r.items;
      addRefs(r.donorRefs);
    } else if (name === "fundraising_progress") {
      data.fundraising_progress = await getFundraisingProgress(ctx);
    } else if (name === "donor_summary") {
      if (donor) {
        const summary = await getDonorSummary(ctx, donor.donorId);
        data.donor_summary = summary ?? { note: "No data could be found for this donor." };
        if (summary) addRefs([{ donorId: summary.donorId, name: summary.name, href: summary.href }]);
      } else {
        data.donor_summary = { note: "No specific donor was identified for this question." };
      }
    }
    // "search_donors" has no standalone data output -- it only ever acts
    // through donor-reference resolution (./conversation.ts), which runs
    // separately before this dispatch.
  }

  return { data, donorRefs };
}

export type AssistantAnswer = {
  available: true;
  answer: string;
  suggestedNextQuestions: string[];
  referencedDonors: DonorRef[];
  // The exact set of donors this turn actually retrieved and could speak
  // to -- becomes next turn's conversation.lastDonorRefs client-side, so
  // "the second one" keeps working across turns without re-sending every
  // donor the whole conversation has ever touched.
  donorRefs: DonorRef[];
  capabilitiesUsed: string[];
};

export type AssistantClarification = {
  available: true;
  clarification: true;
  message: string;
  candidates: DonorRef[];
};

export type AssistantUnavailable = { available: false; error: string };

export type AssistantTurnResult = AssistantAnswer | AssistantClarification | AssistantUnavailable;

export async function runAssistantTurn(params: {
  ai: AiBinding | null;
  model?: string;
  question: string;
  conversation: ConversationState;
  ctx: AssistantContext;
  // Set only by the legacy quick-tool buttons (Prepare for meeting / Draft
  // thank-you / etc.), which have always implicitly operated on the
  // fundraiser's single most relevant donor rather than a named one --
  // bypasses the planner's own name/ordinal resolution and uses this
  // donor directly. Still re-validated for ownership exactly like any
  // other donor reference (inside resolveDonorReference's own owner-
  // scoped query) -- never trusted blindly just because it was
  // pre-supplied.
  presetDonorId?: string | null;
}): Promise<AssistantTurnResult> {
  const question = params.question.trim().slice(0, MAX_QUESTION_LENGTH);
  if (question.length === 0) return { available: false, error: "Ask a question to get started." };
  if (!params.ai) return { available: false, error: "The AI assistant isn't available right now." };

  const plan = await planTurn(params.ai, params.model, question, params.conversation);
  if (!plan) return { available: false, error: "The AI assistant could not be reached." };

  // Donor reference resolution happens BEFORE the compose call, entirely
  // outside the AI -- an ambiguous or unresolvable reference is answered
  // directly, never guessed at by either AI step.
  let donor: DonorRef | null = null;
  if (params.presetDonorId) {
    const resolution = await resolveDonorReference({ kind: "ordinal", value: 1 }, { history: [], lastDonorRefs: [{ donorId: params.presetDonorId, name: "", href: donorHref(params.presetDonorId) }] }, params.ctx);
    if (resolution.kind === "resolved") donor = resolution.donor;
  } else if (plan.donorReference.kind !== "none") {
    const resolution = await resolveDonorReference(plan.donorReference, params.conversation, params.ctx);
    if (resolution.kind === "ambiguous") {
      return {
        available: true,
        clarification: true,
        message: "I found more than one donor matching that -- which one did you mean?",
        candidates: resolution.candidates,
      };
    }
    if (resolution.kind === "resolved") donor = resolution.donor;
    // "not_found" deliberately falls through with donor = null -- the
    // compose step is told plainly that no matching donor was found
    // (via the donor_summary capability's own "No data could be found"
    // note) rather than this function guessing or silently dropping the
    // question.
  }

  // A plan that named a donor but selected no data capability at all
  // (e.g. a bare "tell me about the Kleins") still needs their summary.
  const capabilities = plan.capabilities.length === 0 && donor ? ["donor_summary"] : plan.capabilities;

  const { data, donorRefs } = await runCapabilities(capabilities, params.ctx, donor);

  const composeResult = await callWorkersAI({
    ai: params.ai,
    model: params.model,
    timeoutMs: COMPOSE_TIMEOUT_MS,
    maxTokens: 900,
    jsonSchema: ANSWER_JSON_SCHEMA,
    messages: [
      { role: "system", content: buildComposeSystemPrompt() },
      {
        role: "user",
        content: [
          delimited("CONVERSATION_HISTORY", formatHistoryForPrompt(params.conversation.history)),
          "",
          delimited("VERIFIED_CRM_DATA", JSON.stringify(data)),
          "",
          `Fundraiser's current question: ${question}`,
        ].join("\n"),
      },
    ],
  });

  if (!composeResult.ok) return { available: false, error: "The AI assistant could not be reached." };
  const answer = parseComposeResponse(composeResult.text);
  if (!answer) return { available: false, error: "The AI assistant returned an unexpected response." };

  const referencedIds = new Set(answer.referencedDonorIds);
  const referencedDonors = donorRefs.filter((ref) => referencedIds.has(ref.donorId));

  // A critical financial disclosure (e.g. fundraising_progress's
  // "payments without a recorded date are not included") is enforced
  // here, deterministically, regardless of whether the model's own
  // answer already mentioned it -- never left to the prompt alone
  // (independent review, "Final Payment Accuracy and Financial Data
  // Integrity Review", 2026-10-16).
  const financialLimitations = financialLimitationsFrom(data);
  const finalAnswer = appendFinancialLimitations(answer.answer, financialLimitations);

  return {
    available: true,
    answer: finalAnswer,
    suggestedNextQuestions: answer.suggestedNextQuestions,
    referencedDonors,
    donorRefs,
    capabilitiesUsed: capabilities,
  };
}
