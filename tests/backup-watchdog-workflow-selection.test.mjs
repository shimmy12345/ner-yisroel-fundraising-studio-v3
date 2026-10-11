import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveBackupWorkflowFile } from "../status-worker/src/github-dispatch.ts";

// Backup watchdog -- environment-to-workflow selection regression coverage
// (docs/PRODUCTION-BACKUP-WATCHDOG-CORRECTION.md). Fixes the previously
// hardcoded `WORKFLOW_FILE = "d1-backup-nightly.yml"` constant, which would
// have made a Production-deployed watchdog dispatch Staging's own nightly
// backup workflow once a GITHUB_BACKUP_DISPATCH_TOKEN secret ever existed
// for it. resolveBackupWorkflowFile() is a pure function -- no fetch, no R2,
// no Cloudflare bindings -- so every case here is exercised directly,
// without mocking any network call. tests/backup-watchdog-scheduled.test.mjs
// covers the same resolver wired into the full runBackupWatchdog()
// orchestration (including that no GitHub call of any kind is made when
// resolution fails).

// --- Independent Staging resolves to its own, existing workflow filename ---
{
  const result = resolveBackupWorkflowFile("staging-independent");
  assert.deepEqual(result, { ok: true, workflowFile: "d1-backup-nightly.yml" });
}

// --- Independent Production resolves to its own, dedicated workflow filename ---
{
  const result = resolveBackupWorkflowFile("production-independent");
  assert.deepEqual(result, { ok: true, workflowFile: "d1-backup-nightly-production.yml" });
}

// --- Missing environment identity fails closed ---
{
  const result = resolveBackupWorkflowFile(undefined);
  assert.equal(result.ok, false, "an unset environment identity must never resolve to any workflow");
  assert.match(result.reason, /no backup workflow environment identity configured/i);
}
{
  const result = resolveBackupWorkflowFile("");
  assert.equal(result.ok, false, "an empty-string environment identity must also fail closed, not be treated as a distinct unknown value");
}

// --- Unknown environment identity fails closed (never guesses the closest match) ---
for (const unknown of ["production", "staging", "qa", "Production-Independent", "production-independent "]) {
  const result = resolveBackupWorkflowFile(unknown);
  assert.equal(result.ok, false, `"${unknown}" must fail closed -- it is not an exact allowlisted key`);
  assert.match(result.reason, /unrecognized backup workflow environment identity/i);
}

// --- Conflicting/malformed environment configuration fails closed ---
// (e.g. a value that is neither allowlisted key exactly, such as both
// identities concatenated or whitespace-padded input) -- proves the
// resolver does substring/prefix matching nowhere, only exact lookup.
for (const conflicting of ["staging-independent,production-independent", "production-independentstaging-independent", " production-independent"]) {
  const result = resolveBackupWorkflowFile(conflicting);
  assert.equal(result.ok, false, `conflicting/malformed identity "${conflicting}" must fail closed`);
}

// --- Production can never select Staging's workflow, and vice versa --
// every resolution for one identity must differ from the other's, and
// neither can ever fall back to the other. ---
{
  const staging = resolveBackupWorkflowFile("staging-independent");
  const production = resolveBackupWorkflowFile("production-independent");
  assert.ok(staging.ok && production.ok);
  assert.notEqual(staging.workflowFile, production.workflowFile, "Staging and Production must never resolve to the same workflow filename");
  assert.equal(production.workflowFile, "d1-backup-nightly-production.yml");
  assert.notEqual(production.workflowFile, "d1-backup-nightly.yml", "a Production identity must never resolve to Staging's filename under any input");
}

// --- The resolved filename is always re-validated against the allowlist's
// own values (defense in depth) -- proven indirectly: every ok:true result
// above is one of exactly the two allowlisted filenames, nothing else. ---
{
  const allowed = new Set(["d1-backup-nightly.yml", "d1-backup-nightly-production.yml"]);
  for (const identity of ["staging-independent", "production-independent"]) {
    const result = resolveBackupWorkflowFile(identity);
    assert.ok(result.ok && allowed.has(result.workflowFile));
  }
}

// --- Both allowlisted filenames actually exist in the repository's GitHub
// Actions workflows -- a resolver that passes its own unit tests but points
// at a filename GitHub doesn't have would still be a silent failure. ---
{
  const files = await Promise.all([
    readFile(new URL("../.github/workflows/d1-backup-nightly.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/d1-backup-nightly-production.yml", import.meta.url), "utf8"),
  ]);
  assert.ok(files[0].length > 0 && files[1].length > 0);
}

process.stdout.write("Backup watchdog workflow-selection checks passed.\n");
