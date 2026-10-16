import assert from "node:assert/strict";
import { organizeWithWorkersAI, DEFAULT_WORKERS_AI_MODEL } from "../lib/meeting-notes/providers/workers-ai.ts";
import { MAX_TRANSCRIPT_LENGTH } from "../lib/meeting-notes/organize.ts";

// Cloudflare Workers AI is the DEFAULT provider (docs/AI-HANDOFF.md,
// "Implement Cloudflare AI Meeting Notes on Staging"). These tests run
// entirely against a mocked AiBinding -- no real Workers AI call, no
// network, no cost. Live inference accuracy is verified separately on
// Staging, not here.

const validResponse = JSON.stringify({
  summary: "Discussed the building fund campaign.",
  donorInterests: ["Building fund"],
  fundraisingOpportunities: [],
  confirmedCommitments: [],
  possibleCommitments: [],
  followUpActions: [],
  relationshipContext: "",
});

{
  const ai = { run: async () => { throw new Error("must never be called"); } };
  const result = await organizeWithWorkersAI({ transcript: "   ", ai });
  assert.equal(result.ok, false, "an empty transcript must never be sent to the provider");
}

{
  // Successful call against the plain {response: "..."} shape most
  // catalog models (including the default, Mistral Small 3.1 24B) return.
  // The mock asserts the request shape: model id, delimited transcript,
  // and the native structured-output hint.
  let calls = 0;
  const ai = {
    run: async (model, inputs) => {
      calls += 1;
      assert.equal(model, DEFAULT_WORKERS_AI_MODEL);
      assert.equal(inputs.messages[0].role, "system");
      assert.match(inputs.messages[1].content, /<<<MEETING_NOTES_START>>>/);
      assert.equal(inputs.response_format.type, "json_schema");
      assert.ok(inputs.response_format.json_schema, "the json_schema hint must be the shared OrganizedMeetingNotes schema");
      return { response: validResponse };
    },
  };
  const result = await organizeWithWorkersAI({ transcript: "Met with the Kleins.", ai });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.summary, "Discussed the building fund campaign.");
}

{
  // The OpenAI-compatible response envelope some catalog models (e.g. the
  // gpt-oss family) return instead must also be handled, not just the
  // plain {response} shape -- confirmed live during the 2026-10-15
  // evaluation that both shapes actually occur.
  const ai = {
    run: async () => ({
      choices: [{ message: { content: validResponse } }],
    }),
  };
  const result = await organizeWithWorkersAI({ transcript: "Met with the Kleins.", ai });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary, "Discussed the building fund campaign.");
}

{
  // A response with neither recognized shape (e.g. reasoning consumed the
  // whole token budget and content came back null -- observed live with
  // a reasoning-style catalog model) must degrade safely, never throw.
  const ai = { run: async () => ({ choices: [{ message: { content: null } }] }) };
  const result = await organizeWithWorkersAI({ transcript: "Met with the Kleins.", ai });
  assert.equal(result.ok, false);
  assert.match(result.error, /empty response/i);
}

{
  // Configurable model id must actually be sent, never hardcoded past the
  // caller's override.
  const ai = {
    run: async (model) => {
      assert.equal(model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
      return { response: validResponse };
    },
  };
  const result = await organizeWithWorkersAI({ transcript: "Met with the Kleins.", ai, model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
  assert.equal(result.ok, true);
}

{
  // A binding error (missing/unavailable model, misconfigured id) must
  // degrade to a safe fallback message, never throw past this function and
  // never echo the raw provider error, which could include the input.
  const ai = { run: async () => { throw new Error("some provider error that must never be echoed, with donor content in it"); } };
  const result = await organizeWithWorkersAI({ transcript: "Met with the Kleins.", ai });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /must never be echoed/);
}

{
  // A slow/hanging binding call must be cancelled by the timeout, not hang
  // the request (and the fundraiser's browser) indefinitely.
  const ai = { run: () => new Promise(() => {}) }; // never resolves
  const result = await organizeWithWorkersAI({ transcript: "Met with the Kleins.", ai, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/i);
}

{
  // A transcript longer than the cap must be truncated before being sent,
  // never rejected outright and never sent in full.
  const longTranscript = "a".repeat(MAX_TRANSCRIPT_LENGTH + 500);
  const ai = {
    run: async (_model, inputs) => {
      const sentTranscript = inputs.messages[1].content;
      assert.ok(sentTranscript.length < longTranscript.length + 100, "the oversized transcript must have been truncated before sending");
      return { response: validResponse };
    },
  };
  const result = await organizeWithWorkersAI({ transcript: longTranscript, ai });
  assert.equal(result.ok, true);
}

assert.equal(DEFAULT_WORKERS_AI_MODEL, "@cf/mistralai/mistral-small-3.1-24b-instruct");

console.log("meeting-notes-workers-ai-provider.test.mjs: all assertions passed");
