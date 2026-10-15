// AI Meeting Notes save idempotency (docs/AI-HANDOFF.md, "Meeting Notes
// Final Safeguards and AI Readiness"). Pure comparison helpers used by
// app/api/meeting-notes/route.ts to tell an identical retry (safe to
// re-confirm, write nothing new) apart from a same-key-different-content
// retry (must be rejected, write nothing at all) -- without a new table:
// the already-saved interactions/recommendations rows ARE the record of
// "what was actually completed under this key."

export type InteractionContent = {
  donorId: string;
  type: string;
  occurredAtEpoch: number;
  occurredAtDateOnly: boolean;
  summary: string;
};

export type FollowUpContent = { index: number; description: string; dueAtEpoch: number | null };

export function interactionContentMatches(existing: InteractionContent, incoming: InteractionContent): boolean {
  return existing.donorId === incoming.donorId
    && existing.type === incoming.type
    && existing.occurredAtEpoch === incoming.occurredAtEpoch
    && existing.occurredAtDateOnly === incoming.occurredAtDateOnly
    && existing.summary === incoming.summary;
}

// Order-sensitive by design: a follow-up's index IS part of its identity
// (it is literally embedded in the recommendation row's own id), so "the
// same two follow-ups in a different order" is correctly treated as
// different content, not a cosmetic reordering -- the client always
// submits follow-ups in the same on-screen order every time regardless.
export function followUpListsMatch(existing: FollowUpContent[], incoming: FollowUpContent[]): boolean {
  if (existing.length !== incoming.length) return false;
  const existingByIndex = new Map(existing.map((item) => [item.index, item]));
  return incoming.every((item) => {
    const match = existingByIndex.get(item.index);
    return match !== undefined && match.description === item.description && match.dueAtEpoch === item.dueAtEpoch;
  });
}
