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
const emailSendGuard = await readFile(new URL("../lib/agenda/email-send-guard.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/agenda/preview/route.ts", import.meta.url), "utf8");
// Comment-stripped view, for checks that must inspect real code only --
// this file's own top-of-file documentation comment legitimately names
// "sendGmail"/"gmail-client" while explaining that neither is used.
const previewRouteCode = previewRoute.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
// Same comment-stripping, for gmail-client.ts -- its own header comment
// legitimately names `error_description` while explaining that this file
// never reads it, which would otherwise trip that exact check below.
const gmailClientCode = gmailClient.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
const wranglerProduction = await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");
const wranglerProductionCode = wranglerProduction.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const wranglerStagingCode = wranglerStaging.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
const workerIndex = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

async function run() {
  // --- Never read/log a raw Gmail/OAuth response body -- `response.text()`
  // is never used anywhere in this file, and the one place this file does
  // read a parsed body (the token-refresh failure branch, via
  // `response.json()`) must route it through oauth-error-code.ts's fixed
  // allowlist, never interpolate it directly. ---
  assert.doesNotMatch(gmailClient, /response\.text\(\)/, "the failure paths must never read the response body as raw text");
  assert.doesNotMatch(gmailClient, /console\.(log|error|info)/, "gmail-client.ts must route through lib/logger.ts, never log directly itself");
  assert.doesNotMatch(gmailClientCode, /error_description/, "error_description (Google's own free-text field) must never be read in this file");
  assert.match(
    gmailClient,
    /import\s*\{\s*extractAllowlistedOAuthErrorCode\s*\}\s*from\s*["']\.\/oauth-error-code\.ts["']/,
    "the token-refresh failure branch must derive its error code exclusively through oauth-error-code.ts's allowlist, never parse the body inline",
  );
  // The one spot this file calls response.json() on a failure path must be
  // immediately passed into the allowlist function, never assigned to a
  // variable used for anything else.
  assert.match(
    gmailClient,
    /extractAllowlistedOAuthErrorCode\(await response\.json\(\)\)/,
    "the parsed token-refresh failure body must flow straight into the allowlist function",
  );

  // Every thrown Error in this file is built from status/statusText (plus,
  // for the token-refresh failure, the allowlisted code above) only -- grep
  // for the three known throw sites and confirm none interpolates a raw
  // body/payload/credential.
  const throwLines = gmailClient.split("\n").filter((line) => line.includes("throw new Error("));
  assert.equal(throwLines.length, 3, "exactly the three expected throw sites (token refresh HTTP failure, missing access_token, send HTTP failure) -- update this test if a new one is deliberately added, and re-check it stays status/allowlisted-code-only");
  for (const line of throwLines) {
    assert.doesNotMatch(line, /body|payload\.error|access_token\}|error_description/, `thrown Error must not interpolate response content: ${line}`);
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

  // --- The Cron Trigger is APPROVED and ACTIVE on Production (moved from
  // Staging in the 2026-10-12 Production Daily Email Cutover round):
  // exactly the approved hourly schedule, nothing broader (e.g. a fixed
  // once-daily UTC cron, which would be the DST bug this whole design
  // avoids) and nothing else registered alongside it, on exactly one
  // Worker -- never both at once (duplicate send) or neither (gap). ---
  assert.match(wranglerProductionCode, /"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[\s*"0 \* \* \* \*"\s*\]\s*\}/, "Production's cron must be exactly the approved hourly schedule (\"0 * * * *\")");
  const productionCronMatches = wranglerProductionCode.match(/"crons"\s*:/g) ?? [];
  assert.equal(productionCronMatches.length, 1, "exactly one crons entry on Production -- no duplicate or additional schedule");
  // Staging's "crons" key must be present AND EXPLICITLY EMPTY, not merely
  // absent -- the 2026-10-13 incident (docs/AI-HANDOFF.md) found that
  // deleting the "triggers" key entirely does NOT clear a Worker's
  // previously-registered Cron Trigger on a later deploy; Staging kept
  // sending the real daily email for a full day after the key was removed.
  // An explicit "crons": [] is the verifiable way to actually turn it off.
  const stagingCronMatches = wranglerStagingCode.match(/"crons"\s*:/g) ?? [];
  assert.equal(stagingCronMatches.length, 1, "Staging must carry exactly one crons entry -- an explicit empty array, not an absent key");
  assert.match(wranglerStagingCode, /"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[\s*\]\s*\}/, "Staging's crons entry must be explicitly empty -- the daily email has exactly one sender, not two, and not zero by accident");

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

  // --- October 14 2026 email incident (docs/AI-HANDOFF.md): the
  // fail-closed environment allowlist must be enforced inside sendGmail()
  // itself, before anything else in that function -- including before
  // credentials are even read -- so that no current or future caller can
  // ever reach a real Gmail API call from a non-production environment,
  // regardless of whether that caller remembers to check first. ---
  assert.match(gmailClient, /import\s*\{\s*deploymentEnvironment\s*\}\s*from\s*["']\.\.\/environment\.ts["']/, "gmail-client.ts must import the real, build-time-resolved deploymentEnvironment -- never a runtime config value like APP_BASE_URL");
  assert.match(gmailClient, /isRealEmailSendAllowed/, "sendGmail must consult the fail-closed allowlist");
  const sendGmailBody = gmailClient.slice(gmailClient.indexOf("export async function sendGmail("));
  const guardCheckIndex = sendGmailBody.search(/isRealEmailSendAllowed/);
  const credentialsCheckIndex = sendGmailBody.search(/requireGmailCredentials\(\)/);
  assert.ok(guardCheckIndex >= 0 && credentialsCheckIndex >= 0 && guardCheckIndex < credentialsCheckIndex, "sendGmail must check the environment allowlist BEFORE reading any Gmail credential");
  assert.match(gmailClient, /throw new EmailSendBlockedError/, "a blocked environment must throw, never silently return, so a stale Staging trigger firing is visible in Observability instead of a silent no-op");

  // --- The allowlist itself: exactly one allowed literal, never a
  // denylist of known-bad values (see email-send-guard.ts's own header
  // comment for why that distinction is the whole point). ---
  assert.match(emailSendGuard, /===\s*EMAIL_SEND_ALLOWED_ENVIRONMENT/, "the guard must compare for equality against exactly one allowed value (an allowlist), not test for membership in a denylist");
  assert.match(emailSendGuard, /EMAIL_SEND_ALLOWED_ENVIRONMENT\s*=\s*"production-independent"/, "the one allowed environment must be exactly \"production-independent\"");

  // --- Idempotency claim must happen BEFORE the real send is attempted,
  // so a lost claim race never reaches Gmail at all. ---
  const runScheduledBody = sendAgenda.slice(sendAgenda.indexOf("export async function runScheduledAgendaSend("));
  const claimIndex = runScheduledBody.search(/buildAgendaClaimQuery/);
  const sendDailyAgendaCallIndex = runScheduledBody.search(/await sendDailyAgenda\(/);
  assert.ok(claimIndex >= 0 && sendDailyAgendaCallIndex >= 0 && claimIndex < sendDailyAgendaCallIndex, "runScheduledAgendaSend must attempt the idempotency claim before calling sendDailyAgenda");
  assert.match(runScheduledBody, /changes\s*\?\?\s*0\)\s*===\s*0/, "a lost claim (zero rows changed) must cause an early return, never fall through to a send");

  // --- Production's email links must point at the real custom domain,
  // not a workers.dev placeholder -- the second, independent bug found
  // during the October 14 investigation (docs/AI-HANDOFF.md). Source-only
  // check: this does NOT assert the change has been deployed. ---
  assert.match(wranglerProductionCode, /"APP_BASE_URL"\s*:\s*"https:\/\/shimmydonors\.org"/, "wrangler.production.jsonc's APP_BASE_URL must be the real custom domain, not a workers.dev placeholder");

  console.log("agenda-safety: all assertions passed");
}

await run();
