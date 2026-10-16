import assert from "node:assert/strict";
import { organizeWithAnthropic, DEFAULT_ANTHROPIC_MODEL } from "../lib/meeting-notes/providers/anthropic.ts";
import { MAX_TRANSCRIPT_LENGTH } from "../lib/meeting-notes/organize.ts";

// The Anthropic provider is kept as a configurable, currently INACTIVE
// alternative (docs/AI-HANDOFF.md, "Implement Cloudflare AI Meeting Notes
// on Staging") -- these tests are unchanged in substance from before the
// provider split, just moved to their own file and import path, and run
// entirely against a mocked fetchImpl. No real Anthropic call is ever made.

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
  const result = await organizeWithAnthropic({ transcript: "   ", apiKey: "test-key" });
  assert.equal(result.ok, false, "an empty transcript must never be sent to the provider");
}

{
  // Successful call: the mock asserts the request shape (model, headers,
  // delimited transcript) and returns a realistic Anthropic Messages API
  // response envelope.
  const fetchImpl = async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/messages");
    assert.equal(init.headers["x-api-key"], "test-key");
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    const sentBody = JSON.parse(init.body);
    assert.equal(sentBody.model, "claude-haiku-5-5");
    assert.match(sentBody.messages[0].content, /<<<MEETING_NOTES_START>>>/);
    return new Response(JSON.stringify({ content: [{ type: "text", text: validResponse }] }), { status: 200 });
  };
  const result = await organizeWithAnthropic({ transcript: "Met with the Kleins.", apiKey: "test-key", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.data.summary, "Discussed the building fund campaign.");
}

{
  // Configurable model id must actually be sent, never hardcoded past the
  // caller's override.
  const fetchImpl = async (_url, init) => {
    const sentBody = JSON.parse(init.body);
    assert.equal(sentBody.model, "claude-haiku-custom-test");
    return new Response(JSON.stringify({ content: [{ type: "text", text: validResponse }] }), { status: 200 });
  };
  const result = await organizeWithAnthropic({ transcript: "Met with the Kleins.", apiKey: "test-key", model: "claude-haiku-custom-test", fetchImpl });
  assert.equal(result.ok, true);
}

{
  // Provider error (e.g. rate limit, auth failure) must degrade to a safe
  // fallback message, never throw or leak the raw error body.
  const fetchImpl = async () => new Response("some provider error body that must never be echoed", { status: 429 });
  const result = await organizeWithAnthropic({ transcript: "Met with the Kleins.", apiKey: "test-key", fetchImpl });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /must never be echoed/);
}

{
  // A network-level throw (not just a non-200) must also degrade safely.
  const fetchImpl = async () => { throw new Error("network down"); };
  const result = await organizeWithAnthropic({ transcript: "Met with the Kleins.", apiKey: "test-key", fetchImpl });
  assert.equal(result.ok, false);
}

{
  // A slow/hanging provider must be cancelled by the timeout, not hang the
  // request indefinitely.
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const result = await organizeWithAnthropic({ transcript: "Met with the Kleins.", apiKey: "test-key", fetchImpl, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/i);
}

{
  // A transcript longer than the cap must be truncated before being sent,
  // never rejected outright and never sent in full.
  const longTranscript = "a".repeat(MAX_TRANSCRIPT_LENGTH + 500);
  const fetchImpl = async (_url, init) => {
    const sentBody = JSON.parse(init.body);
    const sentTranscript = sentBody.messages[0].content;
    assert.ok(sentTranscript.length < longTranscript.length + 100, "the oversized transcript must have been truncated before sending");
    return new Response(JSON.stringify({ content: [{ type: "text", text: validResponse }] }), { status: 200 });
  };
  const result = await organizeWithAnthropic({ transcript: longTranscript, apiKey: "test-key", fetchImpl });
  assert.equal(result.ok, true);
}

assert.equal(DEFAULT_ANTHROPIC_MODEL, "claude-haiku-5-5");

console.log("meeting-notes-anthropic-provider.test.mjs: all assertions passed");
