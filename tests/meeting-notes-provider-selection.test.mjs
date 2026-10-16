import assert from "node:assert/strict";
import { selectMeetingNotesProvider } from "../lib/meeting-notes/provider-selection.ts";

// app/api/meeting-notes/organize/route.ts delegates its provider choice to
// this pure function instead of deciding inline, so the decision itself is
// unit-testable without mocking cloudflare:workers (docs/AI-HANDOFF.md,
// "Implement Cloudflare AI Meeting Notes on Staging").

// Cloudflare Workers AI is the default -- an absent AI_PROVIDER var (the
// state on every environment unless an operator explicitly opts into
// Anthropic) must resolve to "workers-ai".
assert.equal(selectMeetingNotesProvider(undefined), "workers-ai");

// Explicitly selecting Anthropic must be honored exactly.
assert.equal(selectMeetingNotesProvider("anthropic"), "anthropic");

// Any other value (typo, stale config, future provider not yet
// implemented) must fail safe to the default rather than erroring or
// selecting something unintended.
assert.equal(selectMeetingNotesProvider("workers-ai"), "workers-ai");
assert.equal(selectMeetingNotesProvider(""), "workers-ai");
assert.equal(selectMeetingNotesProvider("Anthropic"), "workers-ai", "selection must be exact-match, not case-insensitive, to avoid silently matching a typo");
assert.equal(selectMeetingNotesProvider("something-else"), "workers-ai");

console.log("meeting-notes-provider-selection.test.mjs: all assertions passed");
