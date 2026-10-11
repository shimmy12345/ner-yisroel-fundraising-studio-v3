// GitHub Actions I/O for the backup watchdog -- isolated here, behind a
// small interface, so status-worker/watchdog.ts's own decision logic never
// touches the network directly and every unit test in
// tests/status-worker-github-dispatch.test.mjs can inject a fake `fetch`
// instead of making a real call (docs/BACKUP-SCHEDULING-RELIABILITY.md
// Section 18/16 -- "isolate GitHub API interaction behind a small
// interface/helper").
//
// Two calls only, both scoped to exactly this repository:
//   - checkActiveBackupRun: an UNAUTHENTICATED GET (this repository is
//     public) -- never sends the dispatch token, so a check-only failure
//     can never leak or misuse the write-scoped credential.
//   - dispatchBackupWorkflow: the one authenticated call, using the
//     narrowly-scoped token (Actions: Read and write, this repo only --
//     see docs/DEPLOYMENT.md's "Backup watchdog" section for the exact
//     PAT setup). Never logs the token itself.
const REPO = "shimmy12345/ner-yisroel-fundraising-studio-v3";
const BACKUP_REF = "main";
const API_BASE = "https://api.github.com";
// GitHub requires a User-Agent on every REST API request; this identifies
// the caller in GitHub's own request logs, nothing more.
const USER_AGENT = "fundraising-os-backup-watchdog";

// Explicit, closed allowlist: the ONLY two workflow filenames this watchdog
// is ever permitted to dispatch, each pinned to exactly one deployed
// environment identity. This is deliberately a static map, never a string
// built from the environment value (e.g. `d1-backup-nightly${suffix}.yml`)
// -- an unexpected/mistyped environment identity can then only ever fail to
// resolve (see resolveBackupWorkflowFile below), never silently resolve to
// an unintended filename. Verified against the actual repository
// (.github/workflows/) 2026-10-11.
const WORKFLOW_FILE_ALLOWLIST = {
  "staging-independent": "d1-backup-nightly.yml",
  "production-independent": "d1-backup-nightly-production.yml",
} as const;

export type BackupWorkflowEnvironment = keyof typeof WORKFLOW_FILE_ALLOWLIST;

export type WorkflowFileResolution = { ok: true; workflowFile: string } | { ok: false; reason: string };

// Fail-closed environment-to-workflow resolution (docs/PRODUCTION-BACKUP-
// WATCHDOG-CORRECTION.md). Missing, unknown, or otherwise unrecognized
// environment identity never falls back to any default workflow -- it can
// only ever return `ok: false`, which callers must treat as "do not
// dispatch." There is no code path from a Production environment identity
// to the Staging filename, or vice versa: each identity maps to exactly one
// allowlisted filename, and the resolved filename is re-validated against
// the same allowlist's values before ever being returned.
export function resolveBackupWorkflowFile(environment: string | undefined): WorkflowFileResolution {
  if (!environment) {
    return { ok: false, reason: "no backup workflow environment identity configured (BACKUP_WORKFLOW_ENVIRONMENT is unset)" };
  }
  if (!Object.prototype.hasOwnProperty.call(WORKFLOW_FILE_ALLOWLIST, environment)) {
    return { ok: false, reason: `unrecognized backup workflow environment identity: "${environment}"` };
  }
  const workflowFile = WORKFLOW_FILE_ALLOWLIST[environment as BackupWorkflowEnvironment];
  // Defense in depth: re-validate the resolved filename is itself one of
  // the allowlisted values, never trusting the lookup alone.
  const allowedFiles: readonly string[] = Object.values(WORKFLOW_FILE_ALLOWLIST);
  if (!allowedFiles.includes(workflowFile)) {
    return { ok: false, reason: `resolved workflow file is not in the allowlist: "${workflowFile}"` };
  }
  return { ok: true, workflowFile };
}

export type ActiveRunCheck =
  | { hasActiveRun: true }
  | { hasActiveRun: false }
  // The check itself failed (network error, unexpected status, malformed
  // body) -- deliberately distinct from `false`. Per Section 12: "if the
  // read/check itself fails, do not incorrectly conclude the system is
  // healthy" -- callers must treat this the same as "unknown," never as
  // "no active run."
  | { hasActiveRun: null; error: string };

export type DispatchResult = { ok: true } | { ok: false; status: number | null; error: string };

export async function checkActiveBackupRun(fetchImpl: typeof fetch, workflowFile: string): Promise<ActiveRunCheck> {
  try {
    const response = await fetchImpl(`${API_BASE}/repos/${REPO}/actions/workflows/${workflowFile}/runs?per_page=5`, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": USER_AGENT },
    });
    if (!response.ok) return { hasActiveRun: null, error: `GitHub runs list returned HTTP ${response.status}` };
    const body = (await response.json()) as { workflow_runs?: Array<{ status?: string }> };
    if (!Array.isArray(body.workflow_runs)) return { hasActiveRun: null, error: "GitHub runs list response had no workflow_runs array" };
    const hasActiveRun = body.workflow_runs.some((run) => run.status === "in_progress" || run.status === "queued");
    return { hasActiveRun };
  } catch (cause) {
    return { hasActiveRun: null, error: cause instanceof Error ? cause.message : "unknown error checking for an active run" };
  }
}

export async function dispatchBackupWorkflow(fetchImpl: typeof fetch, token: string, workflowFile: string): Promise<DispatchResult> {
  try {
    const response = await fetchImpl(`${API_BASE}/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: BACKUP_REF }),
    });
    // GitHub returns 204 No Content on success -- never a JSON body to parse.
    if (response.status === 204 || response.ok) return { ok: true };
    return { ok: false, status: response.status, error: `GitHub dispatch returned HTTP ${response.status}` };
  } catch (cause) {
    return { ok: false, status: null, error: cause instanceof Error ? cause.message : "unknown error dispatching the backup workflow" };
  }
}
