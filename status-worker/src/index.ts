// Minimal, dedicated status Worker for the D1 backup/restore-verification
// pipeline. This Worker exists to answer "GET /status" with four fixed,
// non-secret JSON objects read from a bucket that contains status
// metadata alone -- never backup data, never credentials -- and, as of
// docs/BACKUP-SCHEDULING-RELIABILITY.md's approved architecture, to run
// an independent backup-freshness watchdog on its own Cloudflare Cron
// Trigger.
//
// Isolation properties, all load-bearing (see tests/status-worker.test.mjs
// and tests/backup-automation.test.mjs):
//   - Its R2 binding points at the STATUS bucket only. It has no binding,
//     credential, or code path that can reach the real backup bucket
//     (fundraising-os-staging-backups) at all -- the watchdog reads only
//     the same status bucket the /status route already reads, nothing new.
//   - It never calls R2's list/delete/put APIs -- read-only .get() on
//     four hardcoded keys, nothing derived from request input. Adding the
//     watchdog does not change this: it never writes to R2 (docs/BACKUP-
//     SCHEDULING-RELIABILITY.md Section 17 -- new dashboard write states
//     are explicitly deferred, not built here).
//   - It has no public route (see wrangler.jsonc: no `routes`,
//     `workers_dev: false`). It is reachable only via a Cloudflare Worker
//     Service Binding from another Worker explicitly configured to call
//     it -- there is no public URL to secure, so no authentication
//     scheme is needed or implemented here. The Cron Trigger below is a
//     separate invocation path (scheduled(), not fetch()) and does not
//     change this.
//   - Any path other than exactly "/status", or any method other than
//     GET, is rejected before touching R2 at all.
//   - The one new secret this Worker can hold (GITHUB_BACKUP_DISPATCH_TOKEN)
//     is scoped to exactly one GitHub permission (Actions: Read and
//     write) on exactly one repository -- see docs/DEPLOYMENT.md's
//     "Backup watchdog" section. It is never logged, never returned in
//     any response, and never reaches the main application Worker.
import { evaluateBackupFreshness, type BackupAttemptStatus, type BackupSuccessStatus } from "./watchdog.ts";
import { checkActiveBackupRun, dispatchBackupWorkflow } from "./github-dispatch.ts";

export interface Env {
  STATUS_BUCKET: R2Bucket;
  // Cloudflare Worker secret (`wrangler secret put`), Stage 2 only.
  // Its ABSENCE is what keeps this Worker in Stage 1 (detection-only)
  // behavior -- there is no separate feature flag; the watchdog can
  // physically only dispatch once this secret exists. See
  // docs/BACKUP-SCHEDULING-RELIABILITY.md Section 15.
  GITHUB_BACKUP_DISPATCH_TOKEN?: string;
}

// Minimal shape of Cloudflare's real ExecutionContext -- only the one
// method this Worker actually uses, matching worker/index.ts's own
// hand-rolled-interface convention rather than pulling in
// @cloudflare/workers-types.
interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Minimal shape of Cloudflare's real ScheduledController. Unlike
// worker/index.ts's Daily Agenda handler (which needs scheduledTime to
// identify "which calendar hour is this," so a delayed Cron Trigger still
// maps to the intended send window), this watchdog's own freshness math
// only ever needs "what time is it right now" -- using the real
// invocation-time clock (Date.now()) below, not the nominal scheduled
// time, is deliberately more accurate for "how many hours has it
// actually been."
interface ScheduledController {
  scheduledTime: number;
}

const STATUS_KEYS = {
  backupSuccess: "backup-latest-success.json",
  backupAttempt: "backup-latest-attempt.json",
  restoreSuccess: "restore-latest-success.json",
  restoreAttempt: "restore-latest-attempt.json",
} as const;

async function readStatusObject(bucket: R2Bucket, key: string): Promise<{ value: unknown; error: string | null }> {
  try {
    const object = await bucket.get(key);
    if (!object) return { value: null, error: null };
    const text = await object.text();
    try {
      return { value: JSON.parse(text), error: null };
    } catch {
      return { value: null, error: `${key}: object exists but is not valid JSON` };
    }
  } catch (cause) {
    return { value: null, error: `${key}: read failed (${cause instanceof Error ? cause.message : "unknown error"})` };
  }
}

// Reads only the two backup-relevant status objects (never
// restore-latest-*, which the watchdog has no reason to touch). Malformed
// JSON and a genuinely missing object both normalize to `null` here --
// deliberately indistinguishable to the pure decision function in
// watchdog.ts, which must treat both identically ("malformed/missing
// status must never be interpreted as healthy").
async function readBackupStatus(bucket: R2Bucket): Promise<{ success: BackupSuccessStatus; attempt: BackupAttemptStatus }> {
  const [success, attempt] = await Promise.all([readStatusObject(bucket, STATUS_KEYS.backupSuccess), readStatusObject(bucket, STATUS_KEYS.backupAttempt)]);
  return {
    success: (success.value as BackupSuccessStatus) ?? null,
    attempt: (attempt.value as BackupAttemptStatus) ?? null,
  };
}

// Structured, low-noise logging (docs/BACKUP-SCHEDULING-RELIABILITY.md
// Section 16): one compact JSON line per invocation for the routine
// "fresh" case (cheap, and still proves the watchdog ran during Stage 1
// verification), a fuller line for anything actionable. Never logs the
// dispatch token or any backup content -- there is none to log here.
function logWatchdogEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: "info", source: "backup-watchdog", event, ...fields }));
}

// Orchestrates one watchdog invocation. Stage 1 (no GITHUB_BACKUP_DISPATCH_TOKEN
// configured): reads status, evaluates freshness, logs the decision, and
// returns -- it never calls GitHub at all. Stage 2 (token configured):
// additionally checks for an already-active run, re-reads status
// immediately before dispatching (Section 13's race-avoidance re-check),
// and dispatches the existing backup workflow only if still stale.
export async function runBackupWatchdog(env: Env, now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    const status = await readBackupStatus(env.STATUS_BUCKET);
    const evaluation = evaluateBackupFreshness({ now, success: status.success, attempt: status.attempt });

    if (evaluation.action === "fresh") {
      logWatchdogEvent("fresh", { ageMs: evaluation.ageMs, tier: evaluation.tier });
      return;
    }

    // action is "recovery_needed" or "already_recovering" -- hasActiveRun
    // was never set on this first evaluation (Stage 1 never checks; Stage
    // 2 only checks once it already knows it's otherwise stale, per
    // Section 12), so "already_recovering" cannot occur here yet.
    logWatchdogEvent("recovery_needed", { ageMs: evaluation.ageMs, tier: evaluation.tier, reason: evaluation.reason });

    if (!env.GITHUB_BACKUP_DISPATCH_TOKEN) {
      logWatchdogEvent("recovery_needed_detection_only", { note: "Stage 1: no GITHUB_BACKUP_DISPATCH_TOKEN configured -- GitHub is never called" });
      return;
    }

    const activeRunCheck = await checkActiveBackupRun(fetchImpl);
    if (activeRunCheck.hasActiveRun === true) {
      logWatchdogEvent("already_recovering", { note: "a backup workflow run is already in_progress/queued" });
      return;
    }
    if (activeRunCheck.hasActiveRun === null) {
      // Section 12: a failed check must never be read as "must be
      // healthy" -- proceed to the dispatch path (with its own immediate
      // re-check immediately below) rather than silently skipping
      // recovery because we couldn't confirm whether a run was active.
      logWatchdogEvent("active_run_check_failed", { error: activeRunCheck.error, note: "proceeding to dispatch path conservatively" });
    }

    // Immediate re-check (Section 13): a delayed scheduled run may have
    // completed between the first read above and now. Re-reading fresh
    // rather than reusing the earlier result avoids an unnecessary
    // duplicate dispatch without needing any shared mutable state.
    const recheckedStatus = await readBackupStatus(env.STATUS_BUCKET);
    const recheckedEvaluation = evaluateBackupFreshness({ now: Date.now(), success: recheckedStatus.success, attempt: recheckedStatus.attempt });
    if (recheckedEvaluation.action === "fresh") {
      logWatchdogEvent("recovered_on_recheck", { ageMs: recheckedEvaluation.ageMs });
      return;
    }

    const dispatchResult = await dispatchBackupWorkflow(fetchImpl, env.GITHUB_BACKUP_DISPATCH_TOKEN);
    if (dispatchResult.ok) {
      // A successful dispatch response means GitHub accepted the
      // request -- it does NOT mean the backup succeeded (Section 15).
      // Nothing here writes backup-latest-success.json or claims
      // recovery is complete; the next hourly invocation independently
      // observes whatever the dispatched run actually publishes.
      logWatchdogEvent("recovery_dispatch_requested", {});
    } else {
      logWatchdogEvent("recovery_dispatch_failed", { status: dispatchResult.status, error: dispatchResult.error });
    }
  } catch (cause) {
    // Defensive: nothing above should throw (every I/O call already
    // catches its own errors), but an uncaught exception here must never
    // propagate in a way that could be confused with the separate
    // fetch() handler below -- scheduled() and fetch() are independent
    // Worker entry points, but logging defensively costs nothing.
    logWatchdogEvent("unexpected_error", { error: cause instanceof Error ? cause.message : "unknown error" });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/status") return new Response("Not found", { status: 404 });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET" } });

    const [backupSuccess, backupAttempt, restoreSuccess, restoreAttempt] = await Promise.all([
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.backupSuccess),
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.backupAttempt),
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.restoreSuccess),
      readStatusObject(env.STATUS_BUCKET, STATUS_KEYS.restoreAttempt),
    ]);

    const readErrors = [backupSuccess.error, backupAttempt.error, restoreSuccess.error, restoreAttempt.error].filter((error): error is string => error !== null);

    return Response.json(
      {
        backup: { success: backupSuccess.value, attempt: backupAttempt.value },
        restore: { success: restoreSuccess.value, attempt: restoreAttempt.value },
        readErrors,
      },
      { headers: { "cache-control": "no-store" } },
    );
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBackupWatchdog(env, Date.now()));
  },
};
