// Pure backup-freshness decision logic for the backup watchdog
// (docs/BACKUP-SCHEDULING-RELIABILITY.md). No I/O of any kind -- no R2, no
// fetch, no Cloudflare bindings -- so this is trivially unit-testable
// against synthetic fixtures, matching this repo's established
// pure-decision-function convention (lib/data-health/model.ts's
// pipelineStatusCheck, lib/portfolio-focus/attention-type.ts's
// resolveAttentionType). The Worker-specific I/O shell (R2 reads, GitHub
// API calls) lives in index.ts/github-dispatch.ts and calls this.
//
// Reuses the SAME threshold constants and the SAME freshnessStatus tiering
// the Workspace Health dashboard already ships (lib/backup-status/
// freshness.ts) -- this module never invents a second, competing
// freshness model.
import { BACKUP_FRESHNESS_CRITICAL_MS, BACKUP_FRESHNESS_HEALTHY_MS, BACKUP_RECOVERY_THRESHOLD_MS, freshnessStatus } from "../../lib/backup-status/freshness.ts";

export type BackupSuccessStatus = { completedAt: string } | null;
export type BackupAttemptStatus = { attemptAt: string; attemptStatus: string } | null;

// Only "recovery_needed" is actionable (dispatch-worthy). "fresh" and
// "already_recovering" both mean "do nothing this invocation" -- the
// distinction exists purely for observability (Section 16 of the
// investigation doc).
export type WatchdogAction = "fresh" | "recovery_needed" | "already_recovering";

export type WatchdogEvaluation = {
  action: WatchdogAction;
  // Informational only, reusing the dashboard's own healthy/attention/
  // critical tiering -- never itself the dispatch trigger (the 26h
  // recovery threshold is a distinct, tighter boundary than the 36h
  // "attention"/dashboard tier -- see docs/BACKUP-SCHEDULING-RELIABILITY.md
  // Section 2).
  tier: "healthy" | "attention" | "critical";
  // null only when there has never been a parseable successful backup at
  // all -- never a stand-in for "zero", which would misrepresent a
  // brand-new/never-run pipeline as maximally fresh.
  ageMs: number | null;
  reason: string;
};

function parseTimestampMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

// Pure. Given already-parsed-from-JSON status facts (malformed/missing
// JSON must already have been normalized to `null` by the caller -- see
// index.ts's readBackupStatus -- so this function never has to guess at a
// parse failure vs. a genuinely absent record; both present identically
// here, which is the correct behavior per docs/BACKUP-SCHEDULING-
// RELIABILITY.md Section 5/7: "malformed/missing status must never be
// interpreted as healthy").
export function evaluateBackupFreshness(input: {
  now: number;
  success: BackupSuccessStatus;
  attempt: BackupAttemptStatus;
  // Whether a GitHub Actions run for the backup workflow is already
  // in_progress/queued -- omit (or false) when this hasn't been checked
  // (Stage 1 never checks; Stage 2 checks only when otherwise stale, per
  // Section 12's "this optimization must not be required for safety").
  hasActiveRun?: boolean;
}): WatchdogEvaluation {
  const successAt = parseTimestampMs(input.success?.completedAt ?? null);

  if (successAt === null) {
    return {
      action: input.hasActiveRun ? "already_recovering" : "recovery_needed",
      tier: "critical",
      ageMs: null,
      reason: "no successful backup has ever been recorded (or the record is malformed/missing)",
    };
  }

  const ageMs = input.now - successAt;
  const tier = freshnessStatus(ageMs, BACKUP_FRESHNESS_HEALTHY_MS, BACKUP_FRESHNESS_CRITICAL_MS);

  const attemptAt = parseTimestampMs(input.attempt?.attemptAt ?? null);
  // Same "a newer failed attempt must prevent an older success from
  // reading as healthy" rule as lib/data-health/model.ts's
  // pipelineStatusCheck (attemptIsNewerFailure), applied to the
  // watchdog's own recovery decision rather than the dashboard's display
  // tier. A malformed attempt record (attemptAt fails to parse) is
  // treated as "no attempt on record" -- it can never itself manufacture
  // a false "newer failed attempt" signal.
  const newerFailedAttempt = attemptAt !== null && input.attempt?.attemptStatus !== "success" && attemptAt > successAt;

  const stale = ageMs >= BACKUP_RECOVERY_THRESHOLD_MS || newerFailedAttempt;
  if (!stale) {
    return { action: "fresh", tier, ageMs, reason: "within the recovery threshold, no newer failed attempt" };
  }

  return {
    action: input.hasActiveRun ? "already_recovering" : "recovery_needed",
    tier,
    ageMs,
    reason: newerFailedAttempt ? "most recent attempt failed after the last recorded success" : "stale beyond the recovery threshold",
  };
}
