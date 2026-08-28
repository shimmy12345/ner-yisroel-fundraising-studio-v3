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
const WORKFLOW_FILE = "d1-backup-nightly.yml";
const BACKUP_REF = "main";
const API_BASE = "https://api.github.com";
// GitHub requires a User-Agent on every REST API request; this identifies
// the caller in GitHub's own request logs, nothing more.
const USER_AGENT = "fundraising-os-backup-watchdog";

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

export async function checkActiveBackupRun(fetchImpl: typeof fetch): Promise<ActiveRunCheck> {
  try {
    const response = await fetchImpl(`${API_BASE}/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`, {
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

export async function dispatchBackupWorkflow(fetchImpl: typeof fetch, token: string): Promise<DispatchResult> {
  try {
    const response = await fetchImpl(`${API_BASE}/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
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
