import assert from "node:assert/strict";
import { callWorkersAI, DEFAULT_WORKERS_AI_MODEL } from "../lib/ai/workers-ai-client.ts";

// Shared Workers AI call wrapper (docs/AI-HANDOFF.md, "Upgrade Ask
// Fundraising OS to a Real AI Assistant") -- extracted from Meeting Notes'
// own provider once the Assistant became a second real caller. Runs
// entirely against a mocked AiBinding -- no real Workers AI call, no
// network, no cost.

{
  const ai = {
    run: async (model, inputs) => {
      assert.equal(model, DEFAULT_WORKERS_AI_MODEL, "defaults to the already-proven model when none is given");
      assert.equal(inputs.messages[0].role, "system");
      assert.equal(inputs.messages[1].content, "Hello");
      assert.equal(inputs.max_tokens, 1500, "defaults to 1500 when not given");
      assert.equal(inputs.response_format, undefined, "no response_format when no jsonSchema is passed");
      return { response: "Hi there." };
    },
  };
  const result = await callWorkersAI({ ai, messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hello" }] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "Hi there.");
}

{
  // The OpenAI-compatible response envelope some catalog models return
  // instead of the plain {response} shape must also be handled.
  const ai = { run: async () => ({ choices: [{ message: { content: "From choices." } }] }) };
  const result = await callWorkersAI({ ai, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(result.ok, true);
  assert.equal(result.text, "From choices.");
}

{
  // Neither recognized shape -- never guessed at, never thrown.
  const ai = { run: async () => ({ somethingElse: true }) };
  const result = await callWorkersAI({ ai, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /empty response/i);
}

{
  // A binding/model error must never surface the raw provider error text
  // (it could echo request content) -- only a safe, generic message.
  const ai = { run: async () => { throw new Error("some internal provider detail, possibly including the prompt"); } };
  const result = await callWorkersAI({ ai, messages: [{ role: "user", content: "Hi" }] });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error, /internal provider detail/);
  assert.match(result.error, /could not be reached/i);
}

{
  // A call that never resolves must still return promptly once the
  // timeout elapses, not hang forever.
  const ai = { run: () => new Promise(() => {}) };
  const result = await callWorkersAI({ ai, messages: [{ role: "user", content: "Hi" }], timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.match(result.error, /took too long/i);
}

{
  // A custom model id and maxTokens are passed through unchanged.
  const ai = {
    run: async (model, inputs) => {
      assert.equal(model, "@cf/some/other-model");
      assert.equal(inputs.max_tokens, 400);
      return { response: "ok" };
    },
  };
  await callWorkersAI({ ai, model: "@cf/some/other-model", maxTokens: 400, messages: [{ role: "user", content: "Hi" }] });
}

{
  // A jsonSchema hint is passed through as response_format.
  const schema = { type: "object", properties: { x: { type: "string" } } };
  const ai = {
    run: async (_model, inputs) => {
      assert.equal(inputs.response_format.type, "json_schema");
      assert.deepEqual(inputs.response_format.json_schema, schema);
      return { response: "{}" };
    },
  };
  await callWorkersAI({ ai, messages: [{ role: "user", content: "Hi" }], jsonSchema: schema });
}

console.log("ai-workers-ai-client.test.mjs: all assertions passed");
