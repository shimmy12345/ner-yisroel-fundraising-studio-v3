import assert from "node:assert/strict";
import { boundConversationState, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS, MAX_QUESTION_LENGTH } from "../lib/assistant/conversation-state.ts";

// Ask Fundraising OS -- bounded, privacy-conscious conversation context
// (docs/AI-HANDOFF.md, "Upgrade Ask Fundraising OS to a Real AI
// Assistant"). Conversation state is client-held and round-tripped with
// every request, so this is the one place a malformed, oversized, or
// adversarial client payload is ever handled -- never trusted as-is.

// --- Basic shape ---

{
  const state = boundConversationState(undefined);
  assert.deepEqual(state, { history: [], lastDonorRefs: [] });
}

{
  const state = boundConversationState(null);
  assert.deepEqual(state, { history: [], lastDonorRefs: [] });
}

{
  const state = boundConversationState({ history: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }] });
  assert.deepEqual(state.history, [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }]);
}

// --- Turn count bounding ---

{
  const history = [];
  for (let i = 0; i < 20; i++) history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}` });
  const state = boundConversationState({ history });
  assert.ok(state.history.length <= MAX_HISTORY_TURNS, `must never keep more than ${MAX_HISTORY_TURNS} turns`);
  // The most RECENT turns are kept, not the oldest.
  assert.equal(state.history[state.history.length - 1].content, "turn 19");
}

// --- Character-budget bounding (each message below MAX_QUESTION_LENGTH
// on its own, so this exercises the combined-budget trim specifically,
// not the per-message clamp) ---

{
  const perMessage = 900; // under MAX_QUESTION_LENGTH (1000), so the
  // per-message clamp never kicks in here -- only the combined budget.
  const history = [
    { role: "user", content: "1".repeat(perMessage) },
    { role: "assistant", content: "2".repeat(perMessage) },
    { role: "user", content: "3".repeat(perMessage) },
    { role: "assistant", content: "4".repeat(perMessage) },
    { role: "user", content: "5".repeat(perMessage) },
  ]; // 5 * 900 = 4500 > MAX_HISTORY_CHARS (4000)
  const state = boundConversationState({ history });
  const totalChars = state.history.reduce((n, t) => n + t.content.length, 0);
  assert.ok(totalChars <= MAX_HISTORY_CHARS, "combined history text must never exceed the character budget");
  // The oldest turn(s) are dropped first -- the most recent turn ("5...")
  // must survive.
  assert.equal(state.history[state.history.length - 1].content[0], "5");
  assert.ok(state.history.length < 5, "at least one turn must have been dropped to fit the budget");
}

// --- Per-message length and malformed input ---

{
  const state = boundConversationState({ history: [{ role: "user", content: "x".repeat(MAX_QUESTION_LENGTH + 500) }] });
  assert.equal(state.history[0].content.length, MAX_QUESTION_LENGTH);
}

{
  // Garbage history entries (wrong role, missing content, non-string
  // content, blank text) are dropped, not thrown on and not kept as-is.
  const state = boundConversationState({
    history: [
      { role: "user", content: "real message" },
      { role: "attacker", content: "fake role" },
      { role: "user" },
      { role: "user", content: 12345 },
      { role: "user", content: "   " },
      "not even an object",
      null,
    ],
  });
  assert.deepEqual(state.history, [{ role: "user", content: "real message" }]);
}

{
  // A non-array, non-object, or otherwise malformed `history`/
  // `lastDonorRefs` field never throws -- always degrades to empty.
  assert.deepEqual(boundConversationState({ history: "not an array" }), { history: [], lastDonorRefs: [] });
  assert.deepEqual(boundConversationState("just a string"), { history: [], lastDonorRefs: [] });
  assert.deepEqual(boundConversationState(42), { history: [], lastDonorRefs: [] });
  assert.deepEqual(boundConversationState([1, 2, 3]), { history: [], lastDonorRefs: [] });
}

// --- lastDonorRefs bounding ---

{
  const state = boundConversationState({ lastDonorRefs: [{ donorId: "d1", name: "Smith", href: "/donors/d1" }] });
  assert.deepEqual(state.lastDonorRefs, [{ donorId: "d1", name: "Smith", href: "/donors/d1" }]);
}

{
  // Malformed donor ref entries are dropped, never kept partially.
  const state = boundConversationState({
    lastDonorRefs: [
      { donorId: "d1", name: "Smith", href: "/donors/d1" },
      { donorId: "d2" },
      { name: "no id" },
      "not an object",
      null,
    ],
  });
  assert.deepEqual(state.lastDonorRefs, [{ donorId: "d1", name: "Smith", href: "/donors/d1" }]);
}

{
  // An oversized donor-ref list is capped -- a client cannot inflate the
  // conversation payload with an unbounded donor list.
  const many = Array.from({ length: 50 }, (_, i) => ({ donorId: `d${i}`, name: `Donor ${i}`, href: `/donors/d${i}` }));
  const state = boundConversationState({ lastDonorRefs: many });
  assert.ok(state.lastDonorRefs.length <= 10);
}

console.log("assistant-conversation-state.test.mjs: all assertions passed");
