export type AIContext = {
  userId: string;
  donorId?: string;
  interactionIds?: string[];
};

export type AIRequest = {
  task: "relationship-summary" | "meeting-brief" | "draft" | "next-action";
  prompt: string;
  context: AIContext;
};

export type AIResult = {
  content: string;
  rationale: string[];
  confidence: number;
  sourceIds: string[];
};

export interface AIService {
  complete(request: AIRequest): Promise<AIResult>;
}
