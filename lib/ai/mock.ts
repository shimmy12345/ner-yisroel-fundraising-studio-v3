import type { AIRequest, AIResult, AIService } from "./types";

export class MockAIService implements AIService {
  async complete(request: AIRequest): Promise<AIResult> {
    return {
      content: `Mock response for ${request.task}`,
      rationale: ["Recent engagement", "Relationship timing"],
      confidence: 0.82,
      sourceIds: request.context.interactionIds ?? [],
    };
  }
}
