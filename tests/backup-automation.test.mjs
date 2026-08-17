import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Regression coverage for the automated D1 backup pipeline (nightly export
// -> R2, monthly restore verification). These are GitHub Actions workflow
// YAML files and a Node script, not application code the D1-dependent-route
// convention applies to -- but the same "verify via source inspection"
// pattern used throughout this test suite still applies well here, since
// the actual scheduled runs can only be proven live once the one-time
// Cloudflare/GitHub setup in docs/DEPLOYMENT.md is complete.

const nightly = await readFile(new URL("../.github/workflows/d1-backup-nightly.yml", import.meta.url), "utf8");
const monthly = await readFile(new URL("../.github/workflows/d1-restore-verify-monthly.yml", import.meta.url), "utf8");
const verifyScript = await readFile(new URL("../scripts/verify-remote-restore.mjs", import.meta.url), "utf8");
const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const deployment = await readFile(new URL("../docs/DEPLOYMENT.md", import.meta.url), "utf8");

// --- The deployed Worker must never gain the ability to touch backups --
// this is the actual, executable proof behind "the deployed application
// itself has no credentials capable of deleting or modifying backups". If
// anyone ever adds an r2_buckets binding to the Worker's own config, this
// fails immediately rather than silently weakening the isolation the
// backup design depends on. ---
assert.doesNotMatch(wranglerStaging, /r2_buckets/, "the Worker must never be bound to the R2 backup bucket");

// --- Nightly backup: full remote export, encrypted before it ever leaves
// the runner, uploaded with a write-only (not admin) R2 credential, never
// committed to the repository. ---
assert.match(nightly, /d1 export/);
assert.match(nightly, /--remote/);
assert.match(nightly, /gpg .*--symmetric --cipher-algo AES256/);
assert.match(nightly, /R2_BACKUP_WRITE_ACCESS_KEY_ID/, "nightly upload must use the write-scoped R2 credential, not a broader one");
assert.doesNotMatch(nightly, /R2_BACKUP_READ_ACCESS_KEY_ID/, "nightly job has no reason to hold the read-only verification credential");
assert.doesNotMatch(nightly, /CLOUDFLARE_R2_TOKEN|Workers R2 Storage.*Edit/i, "nightly upload must not use a broad account-wide R2/Workers token");
{
  const encryptStepIndex = nightly.indexOf("cipher-algo AES256");
  const uploadStepIndex = nightly.indexOf("Upload dated backup to R2");
  assert.ok(encryptStepIndex > 0 && uploadStepIndex > encryptStepIndex, "encryption must happen before the upload step, not after");
}
assert.match(nightly, /shred -u/, "plaintext/ciphertext scratch files must be shredded, not merely left for the runner to discard");
for (const workflow of [nightly, monthly]) {
  assert.doesNotMatch(workflow, /git add|git commit|git push/, "backup artifacts must never be committed into the application source repository");
}

// --- Monthly restore verification: separate, read-only R2 credential;
// always restores into a throwaway database, never the real one; always
// cleans up, even on failure; fails the job on any integrity problem. ---
assert.match(monthly, /R2_BACKUP_READ_ACCESS_KEY_ID/);
assert.doesNotMatch(monthly, /R2_BACKUP_WRITE_ACCESS_KEY_ID/, "the monthly verification job must not hold write access to the backup bucket");
assert.match(monthly, /verify-remote-restore\.mjs/);
assert.match(verifyScript, /d1", "create"/);
assert.doesNotMatch(verifyScript, /fundraising-os-staging-db/, "the scratch database must never reuse the real database's name");
assert.match(verifyScript, /\bfinally\b/, "cleanup (deleting the scratch database) must run even when a check throws");
assert.match(verifyScript, /d1", "delete".*scratchDatabaseName/s);
assert.match(verifyScript, /PRAGMA integrity_check/);
assert.match(verifyScript, /PRAGMA foreign_key_check/);
assert.match(verifyScript, /compareSchemaObjects/, "restore verification must validate schema, not just that SQL executed without error");
assert.match(verifyScript, /FUNDRAISING_DATA_TABLES/, "restore verification must check every fundraising table is present and queryable, not a hand-picked subset");

// --- Status publication (backup/restore-verification status objects for
// Workspace Health) is additive and must never weaken either workflow's
// real failure semantics. continue-on-error may appear ONLY within the
// dedicated "Publish ... status" step -- never on any step that does real
// export/encrypt/upload/restore/verification work. This narrows (does not
// loosen) the original guardrail above: a failed integrity check must
// still fail the workflow; only the separate, best-effort status write
// may swallow its own failure. ---
for (const [workflow, label] of [[nightly, "nightly"], [monthly, "monthly"]]) {
  // Split at the comment block preceding the status-publish step, not at
  // the step's own `name:` line -- the comment block itself legitimately
  // discusses continue-on-error in prose, so it must be excluded from the
  // "before" half too, or this guardrail would trip on its own commentary.
  const publishStepIndex = workflow.indexOf("Additive, best-effort status reporting");
  assert.ok(publishStepIndex > 0, `${label} workflow must have a status-publish step`);
  const beforePublish = workflow.slice(0, publishStepIndex);
  const fromPublish = workflow.slice(publishStepIndex);
  assert.doesNotMatch(beforePublish, /continue-on-error/, `${label}: no real backup/restore/verification step may use continue-on-error`);
  assert.match(fromPublish, /continue-on-error: true/, `${label}: the status-publish step itself must use continue-on-error so publication failure can never fail the job`);
  assert.match(fromPublish, /if: always\(\)/, `${label}: status must be published regardless of whether the real work succeeded or failed`);
}

// --- Status objects are written with a credential distinct from both the
// backup bucket's write and read credentials -- a leaked status-write
// credential must never grant any access to real backup content. ---
for (const workflow of [nightly, monthly]) {
  assert.match(workflow, /R2_STATUS_WRITE_ACCESS_KEY_ID/, "status publication must use its own, separately-scoped credential");
}
assert.doesNotMatch(nightly.split("Publish backup status")[0], /R2_STATUS_WRITE_ACCESS_KEY_ID/, "the status-write credential must not appear before the status-publish step in the nightly workflow");
assert.doesNotMatch(monthly.split("Publish restore-verification status")[0], /R2_STATUS_WRITE_ACCESS_KEY_ID/, "the status-write credential must not appear before the status-publish step in the monthly workflow");

// --- The status-worker (and only the status-worker) may hold read access
// to the status bucket; it must never gain any credential or binding
// reaching the real backup bucket, and the main app must never gain any
// R2 binding at all (see the r2_buckets guardrail above, unchanged). ---
const statusWorkerSrc = await readFile(new URL("../status-worker/src/index.ts", import.meta.url), "utf8");
const statusWorkerConfig = await readFile(new URL("../status-worker/wrangler.jsonc", import.meta.url), "utf8");
assert.doesNotMatch(statusWorkerConfig, /fundraising-os-staging-backups/, "the status-worker must never be bound to the real backup bucket");
assert.match(statusWorkerConfig, /workers_dev.*false/, "the status-worker must have no public URL of its own -- reachable only via a service binding");
assert.doesNotMatch(statusWorkerConfig, /"routes"/, "the status-worker must not be given a public route");
assert.doesNotMatch(statusWorkerSrc, /\.put\(|\.delete\(|\.list\(/, "the status-worker's own code must never call R2 write/delete/list -- read-only by construction, not just by binding scope");
assert.match(statusWorkerSrc, /pathname !== "\/status"/, "the status-worker must reject any path other than the one fixed status route -- never a passthrough to arbitrary keys");
assert.match(statusWorkerSrc, /method !== "GET"/, "the status-worker must reject non-GET requests");

// --- The main app gets a Worker-to-Worker service binding to the
// status-worker -- never an R2 binding, never a credential of its own. ---
assert.match(wranglerStaging, /"services"/, "the main Worker must reach the status-worker only via a service binding");
assert.match(wranglerStaging, /STATUS_WORKER/);
assert.doesNotMatch(wranglerStaging, /AWS_ACCESS_KEY_ID|R2_STATUS|R2_BACKUP/, "the main Worker must never hold any R2 credential, status or backup");

// --- The runbook must actually document the one-time setup this pipeline
// depends on, including a retention window of at least 60 days. ---
assert.match(deployment, /Automated D1 backup/i);
assert.match(deployment, /lifecycle add/);
const expireDaysMatch = deployment.match(/--expire-days[= ](\d+)/);
assert.ok(expireDaysMatch, "the documented lifecycle rule must specify --expire-days");
assert.ok(Number(expireDaysMatch[1]) >= 60, `retention must be at least 60 days, found ${expireDaysMatch?.[1]}`);
assert.match(deployment, /CLOUDFLARE_D1_API_TOKEN/);
assert.match(deployment, /R2_BACKUP_WRITE_ACCESS_KEY_ID/);
assert.match(deployment, /R2_BACKUP_READ_ACCESS_KEY_ID/);
assert.match(deployment, /BACKUP_ENCRYPTION_PASSPHRASE/);
assert.match(deployment, /staging-before-real-import-2026-08-06\.sql/, "the pre-existing manual export must stay documented, distinct from workspace_backup_audits' zero rows");

// --- Status-reporting setup must be documented with its own, distinct
// credential and bucket -- never reusing the backup bucket's names. ---
assert.match(deployment, /Backup\/restore status reporting/i);
assert.match(deployment, /R2_STATUS_WRITE_ACCESS_KEY_ID/);
assert.match(deployment, /R2_STATUS_BUCKET/);
assert.match(deployment, /fundraising-os-backup-status/);
assert.doesNotMatch(deployment.split("Backup/restore status reporting")[1] ?? "", /R2_BACKUP_WRITE_SECRET_ACCESS_KEY|R2_BACKUP_READ_SECRET_ACCESS_KEY/, "the status-reporting section must document its own credentials, not point back at the backup bucket's");

process.stdout.write("Backup automation checks passed.\n");
