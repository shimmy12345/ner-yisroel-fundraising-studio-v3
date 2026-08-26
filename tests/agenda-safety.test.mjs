import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// gmail-client.ts and send-agenda.ts both import "cloudflare:workers" and
// so cannot be imported/unit-tested directly outside a real Workers
// runtime (matching this codebase's established fact-accept.ts
// constraint -- see tests/relationship-fact-accept-core.test.mjs's own
// comment on the same limitation). This file instead guards, by source
// inspection, the specific safety properties that matter most for this
// feature: no secret/response-body logging, no silent failure swallowing,
// and (now that the cron is approved and active, 2026-08-26) that the
// exact approved hourly Cron Trigger is registered and still gated by
// the DST-safe 9 AM America/New_York guard, never a bare/unguarded send.

const gmailClient = await readFile(new URL("../lib/agenda/gmail-client.ts", import.meta.url), "utf8");
const sendAgenda = await readFile(new URL("../lib/agenda/send-agenda.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/agenda/preview/route.ts", import.meta.url), "utf8");
// Comment-stripped view, for checks that must inspect real code only --
// this file's own top-of-file documentation comment legitimately names
// "sendGmail"/"gmail-client" while explaining that neither is used.
const previewRouteCode = previewRoute.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const wranglerStagingCode = wranglerStaging.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
const workerIndex = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

async function run() {
  // --- Never read/log a Gmail API response body on failure -- only
  // response.status/response.statusText may be used, both of which are
  // safe (never echo request/response content). ---
  assert.doesNotMatch(gmailClient, /response\.text\(\)/, "the failure paths must never read the response body at all");
  assert.doesNotMatch(gmailClient, /console\.(log|error|info)/, "gmail-client.ts must route through lib/logger.ts, never log directly itself");
  // Every thrown Error in this file is built from status/statusText only
  // -- grep for the two known throw sites and confirm neither interpolates
  // anything else (e.g. a captured body variable) into the message.
  const throwLines = gmailClient.split("\n").filter((line) => line.includes("throw new Error("));
  assert.equal(throwLines.length, 3, "exactly the three expected throw sites (token refresh HTTP failure, missing access_token, send HTTP failure) -- update this test if a new one is deliberately added, and re-check it stays status-only");
  for (const line of throwLines) {
    assert.doesNotMatch(line, /body|payload\.error|access_token\}/, `thrown Error must not interpolate response content: ${line}`);
  }

  // --- The three OAuth secret names are read from the Worker's env
  // binding, never given fallback/default literal values (which would
  // otherwise silently mask a missing secret) and never logged. ---
  for (const name of ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"]) {
    assert.match(gmailClient, new RegExp(`env\\.${name}`), `${name} must be read from the Worker's own env binding`);
    assert.doesNotMatch(gmailClient, new RegExp(`${name}\\s*=\\s*["'\`]`), `${name} must never be given a literal fallback value in source`);
  }

  // --- Scheduled send failure handling: logged AND rethrown, never
  // swallowed -- this is what makes a failure visible in Cloudflare
  // Observability instead of silently vanishing. ---
  assert.match(sendAgenda, /catch \(error\) \{[\s\S]*logger\.error\([\s\S]*throw error;/, "a caught send failure must be logged, then rethrown -- never swallowed");

  // --- The preview route never imports the real sender -- there is no
  // code path from "preview" to "actually send an email". Checked against
  // real import statements only (not this test's own comments, which
  // legitimately name the module for documentation). ---
  const previewImports = previewRouteCode.split("\n").filter((line) => line.trim().startsWith("import "));
  assert.ok(previewImports.every((line) => !line.includes("gmail-client")), "the preview route must have zero import of the Gmail-sending module");
  assert.doesNotMatch(previewRouteCode, /sendGmail\(|sendDailyAgenda\(/, "the preview route must never call a real-send function");
  assert.match(previewRouteCode, /generateAgenda/, "the preview route must use the same generateAgenda() the real send uses, so preview content matches exactly");

  // --- Preview route requires authentication, same as every other API
  // route in this app -- not a new, separate auth mechanism. ---
  assert.match(previewRouteCode, /getChatGPTUser/);
  assert.match(previewRouteCode, /status: 401/);

  // --- The Cron Trigger is APPROVED and ACTIVE (2026-08-26): exactly the
  // approved hourly schedule, nothing broader (e.g. a fixed once-daily
  // UTC cron, which would be the DST bug this whole design avoids) and
  // nothing else registered alongside it. ---
  assert.match(wranglerStagingCode, /"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[\s*"0 \* \* \* \*"\s*\]\s*\}/, "the cron must be exactly the approved hourly schedule (\"0 * * * *\")");
  const cronMatches = wranglerStagingCode.match(/"crons"\s*:/g) ?? [];
  assert.equal(cronMatches.length, 1, "exactly one crons entry -- no duplicate or additional schedule");

  // --- The scheduled handler exists, is wired to the DST-safe guard, and
  // extends the Worker's lifetime -- the cron firing hourly must never by
  // itself cause a send; only runScheduledAgendaSend()'s own
  // isDailyAgendaSendHour() check (verified independently in
  // agenda-timezone.test.mjs) decides that. ---
  assert.match(workerIndex, /async scheduled\(/, "the scheduled() handler itself must exist and be exported");
  assert.match(workerIndex, /runScheduledAgendaSend/, "the handler must delegate to the guarded sender, never call sendDailyAgenda/sendGmail directly");
  assert.doesNotMatch(workerIndex, /sendDailyAgenda\(|sendGmail\(/, "the Worker entry point must never bypass the DST guard by calling the sender directly");
  assert.match(workerIndex, /ctx\.waitUntil\(/, "the scheduled handler must extend the Worker's lifetime with waitUntil, not return before the send completes");
  assert.match(sendAgenda, /isDailyAgendaSendHour\(now\)/, "runScheduledAgendaSend must still gate on the real DST-safe local-hour guard, not an unconditional send");

  console.log("agenda-safety: all assertions passed");
}

await run();
