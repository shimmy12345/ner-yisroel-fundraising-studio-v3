import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// Regression coverage for the additive backup/restore-verification status
// publication added to the two automated D1 workflows. This is source
// inspection of GitHub Actions YAML + a Node script, matching the existing
// convention in this repo (see test/d1-restore-order.test.mjs) rather than
// a live GitHub Actions run.
//
// Ported narrowly from feature/independent-cloudflare-sandbox: only the
// two workflow files change. scripts/verify-remote-restore.mjs is
// untouched -- the restore-verification status-publish step reads only
// ${{ job.status }} (set by the workflow runtime after the real
// verification step already ran), never anything computed inside that
// script, so there is nothing in it to port or adapt.

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const nightly = read(".github/workflows/d1-backup-nightly.yml");
const monthly = read(".github/workflows/d1-restore-verify-monthly.yml");
const verifyScript = read("scripts/verify-remote-restore.mjs");

test("scripts/verify-remote-restore.mjs is untouched by status publication -- no reference to it or its internals", () => {
  assert.doesNotMatch(verifyScript, /R2_STATUS|status-worker|backup-latest|restore-latest/i, "status publication must be implemented entirely in the workflow YAML, never inside the restore verifier itself");
});

test("both workflows have a dedicated status-publish step, run after the real work", () => {
  assert.match(nightly, /- name: Publish backup status/);
  assert.match(monthly, /- name: Publish restore-verification status/);
  // The status-publish step must come after the real upload/verification
  // step in each file (source order = execution order for GitHub Actions
  // steps), never before.
  const nightlyUploadIndex = nightly.indexOf("Upload dated backup to R2");
  const nightlyPublishIndex = nightly.indexOf("Publish backup status");
  assert.ok(nightlyUploadIndex > 0 && nightlyPublishIndex > nightlyUploadIndex, "nightly: status publication must run after the real R2 upload, not before or instead of it");
  const monthlyVerifyIndex = monthly.indexOf("Restore into a scratch D1 database and run every integrity check");
  const monthlyPublishIndex = monthly.indexOf("Publish restore-verification status");
  assert.ok(monthlyVerifyIndex > 0 && monthlyPublishIndex > monthlyVerifyIndex, "monthly: status publication must run after the real restore-verification step, not before or instead of it");
});

// The core invariant: continue-on-error may appear ONLY within the
// status-publish step's own block in each file -- never on any step that
// does real export/encrypt/upload/download/decrypt/restore/verification
// work. A real backup or restore-verification failure must still fail the
// workflow. Split at the step's distinctive comment block (not its `name:`
// line) so the guardrail isn't defeated by its own explanatory prose.
for (const [workflow, label, anchor] of [
  [nightly, "nightly", "Additive, best-effort status reporting -- deliberately separate"],
  [monthly, "monthly", "Additive, best-effort status reporting -- deliberately separate"],
]) {
  test(`${label}: continue-on-error appears only within the status-publish step, never on real work`, () => {
    const anchorIndex = workflow.indexOf(anchor);
    assert.ok(anchorIndex > 0, `${label}: expected comment anchor not found -- update this test if the comment wording changes`);
    const beforePublish = workflow.slice(0, anchorIndex);
    const fromPublish = workflow.slice(anchorIndex);
    assert.doesNotMatch(beforePublish, /continue-on-error/, `${label}: no real backup/restore/verification step may use continue-on-error`);
    assert.match(fromPublish, /continue-on-error: true/, `${label}: the status-publish step itself must use continue-on-error so publication failure can never fail the job`);
    assert.match(fromPublish, /if: always\(\)/, `${label}: status must be attempted regardless of whether the real work succeeded or failed`);
  });
}

test("status publication uses a credential distinct from both backup-bucket credentials", () => {
  for (const workflow of [nightly, monthly]) {
    assert.match(workflow, /R2_STATUS_WRITE_ACCESS_KEY_ID/, "status publication must use its own, separately-scoped write credential");
    assert.match(workflow, /R2_STATUS_WRITE_SECRET_ACCESS_KEY/);
  }
  assert.doesNotMatch(nightly.split("Publish backup status")[0], /R2_STATUS_WRITE_ACCESS_KEY_ID/, "nightly: the status-write credential must not appear before the status-publish step");
  assert.doesNotMatch(monthly.split("Publish restore-verification status")[0], /R2_STATUS_WRITE_ACCESS_KEY_ID/, "monthly: the status-write credential must not appear before the status-publish step");
  // The nightly job's write-scoped backup credential and the monthly job's
  // read-only backup credential are both untouched and distinct from the
  // new status credential -- this was already true before this change and
  // must remain so.
  assert.match(nightly, /R2_BACKUP_WRITE_ACCESS_KEY_ID/);
  assert.doesNotMatch(nightly, /R2_BACKUP_READ_ACCESS_KEY_ID/);
  assert.match(monthly, /R2_BACKUP_READ_ACCESS_KEY_ID/);
  assert.doesNotMatch(monthly, /R2_BACKUP_WRITE_ACCESS_KEY_ID/);
});

test("exactly four status object keys are published, matching the real backup/verified object keys", () => {
  assert.match(nightly, /"backup-latest-attempt\.json"/);
  assert.match(nightly, /"backup-latest-success\.json"/);
  assert.doesNotMatch(nightly, /restore-latest/, "the nightly workflow must never publish restore-verification status");
  assert.match(monthly, /"restore-latest-attempt\.json"/);
  assert.match(monthly, /"restore-latest-success\.json"/);
  assert.doesNotMatch(monthly, /backup-latest/, "the monthly workflow must never publish backup status");
  // The published backupObjectKey/verifiedBackupObjectKey must be derived
  // from the same values the real upload/download steps already use, not
  // an independently-constructed (and potentially inconsistent) key.
  assert.match(nightly, /BACKUP_OBJECT_KEY="daily\/\$\{DATABASE_NAME\}-\$\{\{ steps\.stamp\.outputs\.value \}\}\.sql\.gz\.gpg"/);
  assert.match(monthly, /VERIFIED_KEY="latest\/\$\{DATABASE_NAME\}\.sql\.gz\.gpg"/);
});

test("status publication is additive JSON metadata only -- never D1 data, never application deployment", () => {
  for (const workflow of [nightly, monthly]) {
    const anchor = workflow === nightly ? "Publish backup status" : "Publish restore-verification status";
    const publishStep = workflow.slice(workflow.indexOf(anchor));
    assert.doesNotMatch(publishStep, /wrangler d1|d1", "execute"|d1", "create"|d1", "delete"/i, "the status-publish step must never touch D1");
    assert.doesNotMatch(publishStep, /wrangler deploy/i, "the status-publish step must never deploy the application Worker");
  }
});

test("success status is only published when the job actually succeeded, matching JOB_STATUS", () => {
  for (const workflow of [nightly, monthly]) {
    const successBlockMatch = workflow.match(/if \[ "\$\{JOB_STATUS\}" = "success" \]; then([\s\S]*?)\r?\n\s*fi\r?\n/);
    assert.ok(successBlockMatch, "the success object must be gated on JOB_STATUS being exactly \"success\"");
    assert.match(successBlockMatch[1], /-success\.json/, "the gated block must be the one publishing the *-success.json object");
  }
});
