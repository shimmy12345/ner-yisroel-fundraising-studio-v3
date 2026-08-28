// Workers-runtime orchestration shell for the Backup Scheduling
// Reliability Stage 3 email alert. Imports "cloudflare:workers" (for
// STAGING_OWNER_EMAIL and env.DB), which means -- matching this
// codebase's established fact-accept.ts/fact-supersession.ts and
// gmail-client.ts split -- this file cannot be imported outside a
// Workers runtime, so it is exercised only via source inspection and the
// live-verify step, never a direct unit test. decision.ts (what to
// decide) and email.ts (what to say) are the two pure, directly
// unit-tested pieces this file calls.
//
// Deliberately reuses existing infrastructure rather than adding
// anything new to this Worker's credential surface:
//   - fetchBackupStatus() (lib/data-health/read.ts) -- the exact same
//     STATUS_WORKER service-binding read the Workspace Health dashboard
//     already performs. This Worker never gains a GitHub credential or a
//     real-backup-bucket binding as a result of this feature.
//   - sendGmail() (lib/agenda/gmail-client.ts) -- the exact same Gmail
//     secrets and send path the Daily Agenda already uses.
//   - env.STAGING_OWNER_EMAIL -- the same single canonical recipient the
//     Daily Agenda already sends to, never a new/hardcoded address.
//   - env.DB -- already bound to this Worker; only a new table
//     (backup_alert_state, drizzle/0035_backup_alert_state.sql) is added,
//     never a new binding.
//
// Failure handling is deliberately NOT the Daily Agenda's rethrow
// pattern: this check is downstream observability layered on top of the
// real backup pipeline (docs/BACKUP-SCHEDULING-RELIABILITY.md Section 7),
// so a STATUS_WORKER read failure, a D1 error, or a Gmail send failure
// must never fail the shared scheduled() invocation or prevent the Daily
// Agenda (or any other scheduled work sharing that invocation) from
// running. Every failure is logged via logger.error and swallowed here;
// a transient failure simply gets re-evaluated on the next hourly tick.
import { env } from "cloudflare:workers";
import { fetchBackupStatus } from "../data-health/read.ts";
import { userIdForEmail } from "../auth/profile.ts";
import { sendGmail } from "../agenda/gmail-client.ts";
import { evaluateBackupAlert } from "./decision.ts";
import { buildBackupAlertEmail } from "./email.ts";
import { logger } from "../logger.ts";

// `now` is epoch MILLISECONDS (worker/index.ts passes
// controller.scheduledTime directly) -- matching lib/backup-status/
// freshness.ts's and status-worker/src/watchdog.ts's convention, not the
// Daily Agenda's own epoch-seconds `now` (lib/agenda/timezone.ts).
export async function runScheduledBackupAlertCheck(now: number): Promise<void> {
  try {
    const ownerEmail = env.STAGING_OWNER_EMAIL;
    if (!ownerEmail) {
      logger.error("backup_alert_owner_not_configured", new Error("STAGING_OWNER_EMAIL is not configured on this Worker"), { now });
      return;
    }
    const userId = userIdForEmail(ownerEmail);

    const status = await fetchBackupStatus();
    const priorRow = await env.DB.prepare("SELECT incident_key FROM backup_alert_state WHERE user_id = ?").bind(userId).first<{ incident_key: string }>();

    const decision = evaluateBackupAlert({
      now,
      reachable: status.backupStatusReachable,
      success: status.backupSuccess ? { completedAt: status.backupSuccess.completedAt } : null,
      attempt: status.backupAttempt ? { attemptAt: status.backupAttempt.attemptAt, attemptStatus: status.backupAttempt.attemptStatus } : null,
      lastAlertedIncidentKey: priorRow?.incident_key ?? null,
    });

    if (!decision.shouldSend) {
      logger.info("backup_alert_check_no_alert", { now, reason: decision.reason });
      return;
    }

    const email = buildBackupAlertEmail({
      lastSuccessCompletedAt: status.backupSuccess?.completedAt ?? null,
      ageMs: decision.ageMs,
      latestAttempt: status.backupAttempt ? { attemptAt: status.backupAttempt.attemptAt, attemptStatus: status.backupAttempt.attemptStatus } : null,
      newerFailedAttempt: decision.newerFailedAttempt,
      tier: decision.tier,
    });

    await sendGmail({ from: ownerEmail, to: ownerEmail, subject: email.subject, text: email.text, html: email.html });

    await env.DB.prepare(
      `INSERT INTO backup_alert_state (user_id, incident_key, first_alerted_at, last_alerted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET incident_key = excluded.incident_key, first_alerted_at = excluded.first_alerted_at, last_alerted_at = excluded.last_alerted_at`,
    ).bind(userId, decision.incidentKey, now, now).run();

    logger.info("backup_alert_sent", { now, tier: decision.tier });
  } catch (error) {
    // Never rethrown -- see this file's header comment. A Gmail failure,
    // a D1 error, or any other unexpected failure here must never affect
    // the Daily Agenda or any other scheduled work sharing this
    // invocation, and must never be misreported as a sent (or unsent)
    // alert either way.
    logger.error("backup_alert_check_failed", error, { now });
  }
}
