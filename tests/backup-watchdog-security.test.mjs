import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Backup watchdog -- security-boundary regression coverage
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Section 6/22). Complements
// tests/backup-automation.test.mjs (which owns the original backup/
// restore pipeline's own guardrails, unchanged by this feature) with
// assertions specific to the new watchdog: the main app Worker must gain
// nothing, status-worker must gain only the one narrow capability, and
// the real backup mechanics must remain byte-for-byte untouched.

const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const workerIndex = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const statusWorkerConfig = await readFile(new URL("../status-worker/wrangler.jsonc", import.meta.url), "utf8");
const statusWorkerIndex = await readFile(new URL("../status-worker/src/index.ts", import.meta.url), "utf8");
const nightly = await readFile(new URL("../.github/workflows/d1-backup-nightly.yml", import.meta.url), "utf8");
const monthly = await readFile(new URL("../.github/workflows/d1-restore-verify-monthly.yml", import.meta.url), "utf8");
const deployment = await readFile(new URL("../docs/DEPLOYMENT.md", import.meta.url), "utf8");

// --- The main application Worker must gain absolutely nothing from this
// feature: no GitHub credential, no new binding, no new secret name. ---
assert.doesNotMatch(wranglerStaging, /GITHUB_BACKUP_DISPATCH_TOKEN|GITHUB_TOKEN|github/i, "the main app Worker's config must never reference any GitHub credential");
assert.doesNotMatch(workerIndex, /GITHUB_BACKUP_DISPATCH_TOKEN|workflow_dispatch|api\.github\.com/i, "the main app Worker's own source must never gain any GitHub-dispatch capability");
assert.doesNotMatch(wranglerStaging, /r2_buckets/, "the main app Worker must still never be bound to any R2 bucket (unchanged guardrail)");

// --- status-worker gains exactly one new secret shape, an hourly Cron
// Trigger, and nothing else -- still no D1, still no real-backup-bucket
// access, still no write/delete/list capability of any kind. ---
assert.match(statusWorkerConfig, /"triggers":\s*\{\s*"crons":\s*\[/, "status-worker must declare a Cron Trigger");
assert.doesNotMatch(statusWorkerConfig, /"17 \* \* \* \*".*"17 \* \* \* \*"/s, "exactly one cron schedule, not several");
assert.doesNotMatch(statusWorkerConfig, /d1_databases|"DB"/, "status-worker must never gain a D1 binding");
assert.doesNotMatch(statusWorkerConfig, /fundraising-os-staging-backups/, "status-worker must never be bound to the real backup bucket (unchanged guardrail)");
assert.doesNotMatch(statusWorkerConfig, /"routes"/, "status-worker must still have no public route (unchanged guardrail)");
assert.match(statusWorkerConfig, /workers_dev.*false/, "status-worker must still have no public URL (unchanged guardrail)");
assert.doesNotMatch(statusWorkerIndex, /\.put\(|\.delete\(|\.list\(/, "status-worker's own code must still never call R2 write/delete/list (unchanged guardrail)");
assert.match(statusWorkerIndex, /GITHUB_BACKUP_DISPATCH_TOKEN\?:\s*string/, "the dispatch token must be declared as an OPTIONAL env field -- its absence must be a valid, supported (Stage 1) configuration");

// --- The dispatch credential is never logged, and the active-run check
// is unauthenticated by design (this repo is public). ---
assert.doesNotMatch(statusWorkerIndex, /console\.log\([^)]*token/i, "no log call may reference the token directly");
const githubDispatchSrc = await readFile(new URL("../status-worker/src/github-dispatch.ts", import.meta.url), "utf8");
{
  const activeRunFnBody = githubDispatchSrc.split("export async function checkActiveBackupRun")[1]?.split("export async function dispatchBackupWorkflow")[0] ?? "";
  assert.doesNotMatch(activeRunFnBody, /authorization/i, "checkActiveBackupRun must never send an Authorization header -- it is deliberately unauthenticated");
}
assert.match(githubDispatchSrc, /Bearer \$\{token\}/, "dispatchBackupWorkflow must send the token only as a bearer credential, never as a query parameter or logged value");

// --- The real backup pipeline is untouched: same schedule, same
// concurrency group, same encryption, same every real step. ---
assert.match(nightly, /cron: "0 8 \* \* \*"/, "the nightly backup schedule must remain unchanged by this feature");
assert.match(nightly, /group: d1-nightly-backup/);
assert.match(nightly, /cancel-in-progress: false/);
assert.match(nightly, /gpg --batch --yes --symmetric --cipher-algo AES256/, "encryption must be unchanged");
assert.match(monthly, /cron: "0 9 1 \* \*"/, "the monthly restore-verification schedule must remain unchanged");

// --- The shared freshness module has zero D1/Cloudflare-specific
// dependencies, so it stays safely importable from both the main app and
// status-worker's separate, minimal bundle. ---
const freshnessSrc = await readFile(new URL("../lib/backup-status/freshness.ts", import.meta.url), "utf8");
assert.doesNotMatch(freshnessSrc, /^import /m, "the shared freshness module must have zero imports -- pure constants/logic only");

// --- Documentation covers the exact permission shape, never a secret
// value. ---
assert.match(deployment, /Backup scheduling watchdog/);
assert.match(deployment, /GITHUB_BACKUP_DISPATCH_TOKEN/);
assert.match(deployment, /Actions: Read and write/);
assert.doesNotMatch(deployment, /ghp_|github_pat_/, "the runbook must never contain a real-looking token value");

process.stdout.write("Backup watchdog security-boundary checks passed.\n");
