// Pure decision logic for the Backup Scheduling Reliability Stage 3 email
// alert (docs/BACKUP-SCHEDULING-RELIABILITY.md). No I/O -- no D1, no
// fetch, no Cloudflare bindings -- matching this repo's established
// pure-decision-function convention (status-worker/src/watchdog.ts,
// lib/data-health/model.ts's pipelineStatusCheck). The Workers-runtime
// shell (STATUS_WORKER read, D1 dedupe read/write, Gmail send) lives in
// run.ts and calls this.
//
// Reuses the SAME shared freshness constants/helper the dashboard
// (lib/data-health/model.ts) and the recovery watchdog
// (status-worker/src/watchdog.ts) already ship (lib/backup-status/
// freshness.ts) -- this module never invents a second, competing
// freshness model or threshold.
import { BACKUP_FRESHNESS_CRITICAL_MS, BACKUP_FRESHNESS_HEALTHY_MS, BACKUP_RECOVERY_THRESHOLD_MS, hasNewerFailedAttempt } from "../backup-status/freshness.ts";

export type BackupAlertSuccessInput = { completedAt: string } | null;
export type BackupAlertAttemptInput = { attemptAt: string; attemptStatus: string } | null;

// The identity of "no successful backup has ever been recorded, or the
// record is malformed/missing" -- both present identically here (see
// parseTimestampMs below), matching the safe-by-default convention this
// repo's other status consumers already use (status-worker/src/watchdog.ts,
// lib/data-health/model.ts's pipelineStatusCheck).
export const NO_SUCCESS_INCIDENT_KEY = "no-success-ever";

export type BackupAlertDecision =
  | { shouldSend: false; reason: string }
  | {
      shouldSend: true;
      // The identity of the incident being alerted on -- either the
      // alerted-on success's own completedAt, or NO_SUCCESS_INCIDENT_KEY.
      // A caller stores this after sending; the NEXT invocation suppresses
      // an identical incidentKey and only alerts again once a new
      // successful backup changes it (or it goes stale again under a new
      // completedAt).
      incidentKey: string;
      tier: "attention" | "critical";
      // null only when incidentKey is NO_SUCCESS_INCIDENT_KEY -- there is
      // no success timestamp to measure age from.
      ageMs: number | null;
      newerFailedAttempt: boolean;
      reason: string;
    };

function parseTimestampMs(value: string | undefined | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateBackupAlert(input: {
  now: number;
  // false means the STATUS_WORKER read itself failed or was malformed --
  // this must never be treated as evidence of anything, healthy or
  // unhealthy (see docs/BACKUP-SCHEDULING-RELIABILITY.md Section 7: "fail
  // safely... don't send a misleading email").
  reachable: boolean;
  success: BackupAlertSuccessInput;
  attempt: BackupAlertAttemptInput;
  // The incidentKey stored from the last time an alert was actually sent
  // for this owner, or null if none has ever been sent (or a prior
  // incident has since been superseded).
  lastAlertedIncidentKey: string | null;
}): BackupAlertDecision {
  if (!input.reachable) return { shouldSend: false, reason: "status-worker unreachable or returned a malformed response -- never alert on unknown state" };

  const successCompletedAt = input.success?.completedAt ?? null;
  const successAtMs = parseTimestampMs(successCompletedAt);

  if (successAtMs === null) {
    if (input.lastAlertedIncidentKey === NO_SUCCESS_INCIDENT_KEY) return { shouldSend: false, reason: "already alerted for the no-verified-successful-backup incident" };
    return {
      shouldSend: true,
      incidentKey: NO_SUCCESS_INCIDENT_KEY,
      tier: "critical",
      ageMs: null,
      newerFailedAttempt: false,
      reason: "no successful backup has ever been recorded, or the record is malformed/missing",
    };
  }

  const ageMs = input.now - successAtMs;
  const newerFailedAttempt = hasNewerFailedAttempt(successAtMs, input.attempt);
  const escalate = ageMs >= BACKUP_FRESHNESS_HEALTHY_MS || newerFailedAttempt;

  if (!escalate) {
    return { shouldSend: false, reason: ageMs >= BACKUP_RECOVERY_THRESHOLD_MS ? "within the recovery window -- the status-worker watchdog may still self-heal this" : "fresh" };
  }

  const incidentKey = successCompletedAt as string;
  if (input.lastAlertedIncidentKey === incidentKey) return { shouldSend: false, reason: "already alerted for this incident" };

  return {
    shouldSend: true,
    incidentKey,
    tier: ageMs >= BACKUP_FRESHNESS_CRITICAL_MS ? "critical" : "attention",
    ageMs,
    newerFailedAttempt,
    reason: newerFailedAttempt && ageMs < BACKUP_FRESHNESS_HEALTHY_MS ? "the most recent attempt failed after the last recorded success" : "stale beyond the 36h escalation threshold",
  };
}
