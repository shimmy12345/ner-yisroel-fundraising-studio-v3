import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Backup alert -- Workers-runtime orchestration safety
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Stage 3, Sections 7/8/12/15).
// run.ts imports "cloudflare:workers" and so cannot be imported/unit-
// tested directly outside a real Workers runtime (matching gmail-
// client.ts/send-agenda.ts's own established constraint -- see
// tests/agenda-safety.test.mjs). This file guards, by source inspection,
// the specific safety properties that matter most: failures are logged
// and swallowed (never rethrown, never crash the shared scheduled()
// invocation), no new credential/binding is introduced, no Dashboard/UI
// state is added, and the existing hourly Cron Trigger is reused rather
// than a second one being registered.

const run = await readFile(new URL("../lib/backup-alert/run.ts", import.meta.url), "utf8");
const decision = await readFile(new URL("../lib/backup-alert/decision.ts", import.meta.url), "utf8");
const email = await readFile(new URL("../lib/backup-alert/email.ts", import.meta.url), "utf8");
const workerIndex = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const wranglerStagingCode = wranglerStaging.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

async function run_() {
  // --- decision.ts and email.ts are pure: zero "cloudflare:workers"
  // dependency, so they stay directly unit-testable (see
  // tests/backup-alert-decision.test.mjs / tests/backup-alert-email.test.mjs)
  // and importable from status-worker's separate minimal bundle if ever
  // needed, matching lib/backup-status/freshness.ts's own convention. ---
  assert.doesNotMatch(decision, /cloudflare:workers/, "decision.ts must stay pure -- no Workers runtime dependency");
  assert.doesNotMatch(email, /cloudflare:workers/, "email.ts must stay pure -- no Workers runtime dependency");

  // --- run.ts never throws out of runScheduledBackupAlertCheck -- this is
  // downstream observability layered on the real backup pipeline, and
  // must never affect whether the Daily Agenda (or anything else sharing
  // this invocation) runs. Unlike send-agenda.ts's own deliberate
  // log-then-rethrow, this function's try/catch must swallow. ---
  const catchBody = run.split("} catch (error) {")[1] ?? "";
  assert.ok(catchBody.includes("logger.error("), "the top-level catch must log the failure");
  assert.doesNotMatch(catchBody, /\bthrow\b/, "the top-level catch must never rethrow");
  const throwCount = (run.match(/\bthrow\b/g) ?? []).length;
  assert.equal(throwCount, 0, "run.ts must never throw at all -- every failure path must log and return");
  assert.doesNotMatch(run, /console\.(log|error|info)/, "run.ts must route through lib/logger.ts, never log directly itself");

  // --- Reuses existing infrastructure -- never a second STATUS_WORKER
  // read implementation, never a second Gmail-sending implementation,
  // never a hardcoded/new recipient address. ---
  assert.match(run, /import \{ fetchBackupStatus \} from "\.\.\/data-health\/read\.ts"/, "must reuse the existing STATUS_WORKER read, not a second implementation");
  assert.match(run, /import \{ sendGmail \} from "\.\.\/agenda\/gmail-client\.ts"/, "must reuse the existing Gmail send path, not a second implementation");
  assert.match(run, /env\.STAGING_OWNER_EMAIL/, "must reuse the existing canonical owner-email config");
  assert.doesNotMatch(run, /@\w+\.\w+/, "must never contain a hardcoded literal email address");

  // --- Dedupe persistence uses the real D1 binding, never in-memory
  // module-level state (which would not survive across Worker
  // invocations/isolates anyway, but must not even be attempted). ---
  assert.match(run, /env\.DB\.prepare/, "dedupe state must be read/written via the real D1 binding");
  assert.doesNotMatch(run, /^\s*(let|const)\s+\w*[Ii]ncident\w*\s*=.*;\s*$/m, "must never declare a module-level mutable variable to hold dedupe state");
  assert.match(run, /ON CONFLICT\(user_id\)/i, "the dedupe row must be upserted, never blindly inserted a second time for the same user");

  // --- Gmail send happens BEFORE the dedupe row is written, so a Gmail
  // failure leaves no incident_key recorded and the next hourly
  // invocation can naturally retry -- never marks an incident "alerted"
  // without having actually sent anything. ---
  const sendIndex = run.indexOf("await sendGmail(");
  const upsertIndex = run.indexOf("INSERT INTO backup_alert_state");
  assert.ok(sendIndex > 0 && upsertIndex > sendIndex, "the D1 dedupe write must happen strictly after the Gmail send succeeds");

  // --- No expensive relationship/recommendation/portfolio computation is
  // pulled in -- this check must stay cheap. ---
  for (const forbidden of ["loadWorkspaceBrief", "buildAgenda", "portfolio-focus", "recommendation"]) {
    assert.doesNotMatch(run, new RegExp(forbidden, "i"), `run.ts must never import/compute ${forbidden} -- this check must stay independent and cheap`);
  }

  // --- Security boundary: this Worker gains nothing new from this
  // feature -- no GitHub credential, no dispatch call, no real-backup-
  // bucket concept. Complements tests/backup-watchdog-security.test.mjs's
  // own main-Worker-side assertions with checks scoped to this feature's
  // own new files specifically. ---
  for (const source of [run, decision, email]) {
    assert.doesNotMatch(source, /GITHUB_BACKUP_DISPATCH_TOKEN|workflow_dispatch|api\.github\.com/i, "no file in lib/backup-alert/ may reference the GitHub dispatch credential or API");
    assert.doesNotMatch(source, /R2Bucket|\.put\(|\.list\(/, "no file in lib/backup-alert/ may reference an R2 bucket binding or write/list capability");
  }

  // --- worker/index.ts: reuses the existing hourly Cron Trigger (no
  // second trigger registered), wires the new check through its own
  // independent waitUntil() so a failure in one can never affect the
  // other, and still gates the Daily Agenda on its own DST-safe guard
  // unchanged. ---
  const cronMatches = wranglerStagingCode.match(/"crons"\s*:/g) ?? [];
  assert.equal(cronMatches.length, 1, "exactly one crons entry -- Stage 3 must not add a second Cron Trigger");
  assert.match(workerIndex, /runScheduledBackupAlertCheck/, "the scheduled handler must call the new backup-alert check");
  const waitUntilCalls = workerIndex.match(/ctx\.waitUntil\(/g) ?? [];
  assert.equal(waitUntilCalls.length, 2, "the Daily Agenda send and the backup-alert check must each get their own independent waitUntil()");
  assert.doesNotMatch(workerIndex, /ctx\.waitUntil\(\s*Promise\.all/, "the two scheduled jobs must not be coupled through a single combined promise -- each waitUntil() must be independent");
}

await run_();
process.stdout.write("Backup alert safety checks passed.\n");
