// Ask Fundraising OS -- pure conversation-state types and bounding logic
// (docs/AI-HANDOFF.md, "Upgrade Ask Fundraising OS to a Real AI
// Assistant"). Deliberately has NO `cloudflare:workers` import, unlike
// ./conversation.ts (which adds donor-reference resolution on top of
// this) -- every route/lib file in this codebase that imports `env`
// cannot be invoked directly in a Node test process (confirmed:
// `cloudflare:workers` has no Node-resolvable specifier), so the pure
// parts of conversation handling live here specifically so they stay
// directly, cheaply unit-testable.

export const MAX_HISTORY_TURNS = 6;
export const MAX_HISTORY_CHARS = 4000;
export const MAX_QUESTION_LENGTH = 1000;

export type ConversationTurn = { role: "user" | "assistant"; content: string };

// A donor the assistant has already shown or discussed -- id, display
// name, and the exact profile href the rest of the app already uses for
// that donor. This is what an ordinal reference ("the second one")
// resolves against, and what the UI renders as a "View donor" link.
export type DonorRef = { donorId: string; name: string; href: string };

export type ConversationState = {
  history: ConversationTurn[];
  lastDonorRefs: DonorRef[];
};

export type DonorReference =
  | { kind: "none" }
  | { kind: "name"; value: string }
  | { kind: "ordinal"; value: number };

// Keeps only the most recent MAX_HISTORY_TURNS turns, and drops further
// oldest ones if the combined text would exceed MAX_HISTORY_CHARS -- a
// bounded context, not an ever-growing transcript. Also strips anything
// that isn't a plain {role, content} string pair and truncates an
// individual message, so a malformed or oversized client payload can
// never inflate the prompt or crash this function.
export function boundConversationState(input: unknown): ConversationState {
  const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const rawHistory = Array.isArray(raw.history) ? raw.history : [];
  const turns: ConversationTurn[] = [];
  for (const item of rawHistory) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
    if (!role || typeof row.content !== "string") continue;
    const content = row.content.trim();
    if (content.length === 0) continue;
    turns.push({ role, content: content.slice(0, MAX_QUESTION_LENGTH) });
  }
  const recent = turns.slice(-MAX_HISTORY_TURNS);

  let budget = MAX_HISTORY_CHARS;
  const bounded: ConversationTurn[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const turn = recent[i];
    if (turn.content.length > budget) break;
    budget -= turn.content.length;
    bounded.unshift(turn);
  }

  const rawDonorRefs = Array.isArray(raw.lastDonorRefs) ? raw.lastDonorRefs : [];
  const lastDonorRefs: DonorRef[] = [];
  for (const item of rawDonorRefs) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    if (typeof row.donorId !== "string" || typeof row.name !== "string" || typeof row.href !== "string") continue;
    lastDonorRefs.push({ donorId: row.donorId, name: row.name, href: row.href });
    if (lastDonorRefs.length >= 10) break;
  }

  return { history: bounded, lastDonorRefs };
}
