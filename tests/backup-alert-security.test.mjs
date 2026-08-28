import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildBackupAlertEmail } from "../lib/backup-alert/email.ts";

// Backup alert -- security-boundary regression coverage
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Stage 3, Section 11/12).
// Complements tests/backup-watchdog-security.test.mjs (which already
// guards the main-Worker-side boundary established in Stages 1/2) with
// assertions specific to this feature: the main app Worker still gains
// nothing beyond its existing STATUS_WORKER read and Gmail send, the
// dispatch credential remains status-worker-only, and no new public
// endpoint or dashboard state was introduced.

const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const workerIndex = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const statusWorkerConfig = await readFile(new URL("../status-worker/wrangler.jsonc", import.meta.url), "utf8");
const run = await readFile(new URL("../lib/backup-alert/run.ts", import.meta.url), "utf8");
const decision = await readFile(new URL("../lib/backup-alert/decision.ts", import.meta.url), "utf8");
const email = await readFile(new URL("../lib/backup-alert/email.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0035_backup_alert_state.sql", import.meta.url), "utf8");
const dataHealthRead = await readFile(new URL("../lib/data-health/read.ts", import.meta.url), "utf8");

// --- The main application Worker still gains nothing GitHub-shaped from
// this feature (unchanged from Stages 1/2, re-verified here scoped to
// the new Stage 3 files specifically). ---
assert.doesNotMatch(wranglerStaging, /GITHUB_BACKUP_DISPATCH_TOKEN/i, "the main app Worker's config must never reference the GitHub dispatch credential");
for (const source of [run, decision, email]) {
  assert.doesNotMatch(source, /GITHUB_BACKUP_DISPATCH_TOKEN|GITHUB_TOKEN/i, "no Stage 3 file may reference any GitHub credential");
}

// --- status-worker remains the ONLY component holding the GitHub
// dispatch credential -- Stage 3 must not duplicate or relocate it. ---
assert.match(statusWorkerConfig, /"triggers":\s*\{\s*"crons":\s*\[/, "status-worker must still declare its own Cron Trigger (unchanged by Stage 3)");
assert.doesNotMatch(run, /workflow_dispatch|api\.github\.com|dispatchBackupWorkflow|checkActiveBackupRun/, "the main app's backup-alert code must never import or reimplement status-worker's GitHub-dispatch logic");

// --- The main app Worker gains no new binding of any kind from this
// feature -- no R2 bucket, no new D1 database, only the new table inside
// its EXISTING D1 binding. ---
assert.doesNotMatch(wranglerStaging, /r2_buckets/, "the main app Worker must still never be bound to any R2 bucket");
const d1Matches = wranglerStaging.match(/"d1_databases"\s*:/g) ?? [];
assert.equal(d1Matches.length, 1, "Stage 3 must not add a second D1 binding -- backup_alert_state lives in the existing DB binding");

// --- The alert email content builder's actual OUTPUT never contains a
// token/secret/credential -- checked against real rendered output, not
// the source file's own doc comments (which legitimately name these
// concepts to describe what must never leak). ---
{
  const rendered = buildBackupAlertEmail({
    lastSuccessCompletedAt: "2026-08-27T00:00:00.000Z",
    ageMs: 40 * 3_600_000,
    latestAttempt: { attemptAt: "2026-08-27T00:00:00.000Z", attemptStatus: "failure" },
    newerFailedAttempt: true,
    tier: "critical",
  });
  for (const surface of [rendered.subject, rendered.text, rendered.html]) {
    assert.doesNotMatch(surface, /token|secret|authorization|ghp_|github_pat_|bearer /i, "the rendered email must never reference a credential-shaped concept");
  }
}
// The email module's INPUT TYPE is structurally limited to plain
// strings/timestamps/an attempt-status enum (see BackupAlertEmailInput) --
// it has no parameter shape through which a token or encrypted backup
// object could even be passed in.
assert.doesNotMatch(email, /R2Object|ArrayBuffer|Uint8Array/, "the email content builder must never accept anything shaped like raw backup/object content");

// --- No new public HTTP endpoint was introduced by this feature: the
// only new export surface is the scheduled-handler function itself, never
// a route file. ---
assert.doesNotMatch(run, /export async function (GET|POST|PUT|DELETE|PATCH)/, "backup-alert must never expose an HTTP route handler");

// --- The dedupe table holds no donor/fundraising columns -- structural
// check against the actual CREATE TABLE statement itself (comments above
// it legitimately use words like "email" to describe the FEATURE, which
// is not the same as the table having an email/donor-shaped column). ---
assert.match(migration, /CREATE TABLE `backup_alert_state`/);
const createTableStatement = migration.slice(migration.indexOf("CREATE TABLE `backup_alert_state`"));
assert.doesNotMatch(createTableStatement, /donor|gift|pledge|giving|amount|email|token|secret/i, "backup_alert_state's own DDL must contain no donor/fundraising/credential-shaped column");
assert.deepEqual([...createTableStatement.matchAll(/`(\w+)`(?=\s+(?:text|integer))/g)].map((m) => m[1]), ["user_id", "incident_key", "first_alerted_at", "last_alerted_at"], "the table must have exactly these four columns, nothing more");

// --- Stage 3 reuses the exact existing STATUS_WORKER read function
// rather than adding a second, parallel service-binding call site. ---
const statusWorkerFetchSites = (dataHealthRead.match(/env\.STATUS_WORKER\.fetch\(/g) ?? []).length + (run.match(/env\.STATUS_WORKER\.fetch\(/g) ?? []).length;
assert.equal(statusWorkerFetchSites, 1, "there must be exactly one STATUS_WORKER fetch call site in the whole app -- Stage 3 must reuse it, never add a second");

// --- No Workspace Health / dashboard UI state was added for this stage
// (Section 15 -- no "Recovery triggered"/"Alert sent" dashboard states). ---
const dataHealthModel = await readFile(new URL("../lib/data-health/model.ts", import.meta.url), "utf8");
assert.doesNotMatch(dataHealthModel, /Alert sent|Watchdog dispatched|Recovery triggered/i, "Stage 3 must not add any new dashboard status wording");

process.stdout.write("Backup alert security-boundary checks passed.\n");
