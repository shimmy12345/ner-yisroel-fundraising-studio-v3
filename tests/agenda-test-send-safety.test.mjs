import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Temporary Production Gmail OAuth verification mechanism (October 14
// 2026 incident -- docs/AI-HANDOFF.md). app/api/agenda/test-send/route.ts
// imports "cloudflare:workers" and so cannot be imported/unit-tested
// directly outside a real Workers runtime, matching this codebase's
// established gmail-client.ts/send-agenda.ts constraint (see
// tests/agenda-safety.test.mjs's own header comment). This file guards,
// by source inspection, the specific safety properties the owner's own
// authorization explicitly required.

const route = await readFile(new URL("../app/api/agenda/test-send/route.ts", import.meta.url), "utf8");
const testSendLog = await readFile(new URL("../lib/agenda/test-send-log.ts", import.meta.url), "utf8");

async function run() {
  // --- Exactly one exported handler, POST only -- no GET, so this
  // action can never be triggered by a bookmark, a crawler, or an
  // accidental link click. ---
  assert.match(route, /export async function POST\(/, "the route must export a POST handler");
  assert.doesNotMatch(route, /export (async )?function GET\(/, "the route must never export a GET handler for this mutating action");

  // --- Authentication alone is explicitly insufficient: a separate,
  // visible comparison against the one configured Production owner email
  // must exist, distinct from merely checking that getChatGPTUser()
  // returned non-null. ---
  assert.match(route, /getChatGPTUser/, "the route must require real authentication");
  assert.match(route, /identity\.email\s*!==\s*ownerEmail/, "the route must explicitly compare the authenticated identity's email against the configured owner email -- authentication alone must never be treated as sufficient");
  assert.match(route, /env\.STAGING_OWNER_EMAIL/, "the owner-email comparison must read the real configured value, never a hardcoded literal");
  assert.doesNotMatch(route, /ownerEmail\s*=\s*["'][^"']+@/, "the owner email must never be hardcoded as a string literal in this file");

  // --- The real, unmodified send function is reused -- never a second,
  // parallel implementation of agenda generation or sending. ---
  assert.match(route, /import\s*\{\s*sendDailyAgenda\s*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/\.\.\/lib\/agenda\/send-agenda["']/, "the route must import and reuse the real sendDailyAgenda, never reimplement it");
  assert.doesNotMatch(route, /sendGmail\(|fetch\(\s*["']https:\/\/gmail/, "the route must never call the Gmail API directly -- only through the real, shared sendDailyAgenda/sendGmail chokepoint");

  // --- Atomic, persistent claim: a real D1 INSERT via the dedicated
  // module, executed and its result checked, strictly before the send is
  // attempted -- never an in-memory flag, never a read-only preflight
  // check with no actual claim. ---
  assert.match(route, /import\s*\{\s*buildTestSendClaimQuery/, "the route must use the real, dedicated claim-query builder");
  assert.doesNotMatch(route, /\blet\s+\w*claimed\w*\s*=\s*(true|false)/i, "the route must never use an in-memory boolean flag for the claim");
  const claimIndex = route.search(/buildTestSendClaimQuery/);
  const sendCallIndex = route.search(/await sendDailyAgenda\(/);
  assert.ok(claimIndex >= 0 && sendCallIndex >= 0 && claimIndex < sendCallIndex, "the claim must be attempted strictly before sendDailyAgenda is ever called");
  assert.match(route, /changes\s*\?\?\s*0\)\s*===\s*0/, "a lost claim (zero rows changed) must cause an early refusal, never fall through to a send");
  assert.match(route, /status:\s*409/, "a lost claim must be reported with 409 Conflict, a real, meaningful HTTP status");

  // --- This mechanism must never touch the REAL scheduled send's own
  // idempotency table -- confirmed by source, not just by the separate
  // migration existing. ---
  assert.doesNotMatch(route, /agenda_send_log/i, "the test-send route must never reference agenda_send_log -- it must be structurally incapable of marking any real scheduled date as sent");
  assert.doesNotMatch(testSendLog, /\bagenda_send_log\b/, "the test-send claim module must never reference the real agenda_send_log table either");

  // --- No credential, token, or response-body leakage -- the recorded
  // failure outcome is always error.message only, matching gmail-
  // client.ts's own established discipline. ---
  assert.doesNotMatch(route, /console\.(log|error|info)/, "the route must never log directly -- only through the structured error handling already present");
  assert.match(route, /error instanceof Error \? error\.message/, "a caught error's recorded outcome must be .message only, never the raw error object or a response body");
  assert.doesNotMatch(route, /response\.text\(\)|response\.json\(\).*catch/, "the route must never attempt to read a raw Gmail/OAuth response body itself");

  // --- Failure is recorded, not silently swallowed -- the claim's
  // terminal state must always reflect what actually happened. ---
  assert.match(route, /buildTestSendFailureQuery/, "a failed send attempt must be recorded via the dedicated failure-query builder, never silently dropped");
  assert.match(route, /buildTestSendCommitQuery/, "a successful send must be committed to the claim's terminal 'sent' state");

  console.log("agenda-test-send-safety: all assertions passed");
}

await run();
