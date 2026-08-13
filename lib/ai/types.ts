import type { DonorRecommendation } from "../relationships/recommendation-rank.ts";

export type AssistantTask =
  | "relationship-summary"
  | "meeting-brief"
  | "draft"
  | "next-action"
  | "lapsed-relationships"
  | "executive-summary";

export type AssistantContextSnapshot = {
  donor: {
    id: string;
    name: string;
    summary: string;
    memory: string;
    // Separate from summary/memory on purpose -- these are unconfirmed,
    // never established relationship fact, and must never be merged into
    // either field.
    unconfirmedHistoricalContext: string[];
    // The one canonical, evidence-driven recommendation for this donor --
    // the exact same value lib/relationships/meeting-brief.ts and the
    // homepage/Today queue compute, never re-derived here. null only when
    // there's genuinely no evidence to suggest anything (or in demo mode).
    recommendation: DonorRecommendation | null;
    // Pre-formatted family-yahrtzeit lines, always present regardless of
    // how far away the date is -- background context, never implying
    // outreach occurred. Separate from recommendation, which only reflects
    // yahrtzeit_outreach when it's the winning candidate within its lead window.
    familyYahrtzeits: string[];
  };
  latestInteraction: {
    id: string;
    summary: string;
    occurredAt: string;
  } | null;
  recommendations: Array<{ id: string; action: string; reason: string; dueAt: string | null }>;
  priorities: Array<{ name: string; label: string; reason: string; why: string; action: string }>;
  meetings: Array<{ time: string; period: string; title: string; detail: string }>;
  gifts: Array<{ id: string; name: string; amount: string; detail: string }>;
};

export type AIContext = {
  userId: string;
  donorId?: string;
  interactionIds?: string[];
  snapshot: AssistantContextSnapshot;
};

export type AIRequest = {
  task: AssistantTask;
  prompt: string;
  context: AIContext;
};

export type AIResult = {
  mode: "rule-based";
  title: string;
  content: string;
  rationale: string[];
  confidence: number;
  sourceIds: string[];
};

export interface AIService {
  complete(request: AIRequest): Promise<AIResult>;
}
