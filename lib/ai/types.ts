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
