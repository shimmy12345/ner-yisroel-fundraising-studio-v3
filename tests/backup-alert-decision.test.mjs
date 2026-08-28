import assert from "node:assert/strict";
import { evaluateBackupAlert, NO_SUCCESS_INCIDENT_KEY } from "../lib/backup-alert/decision.ts";
import { BACKUP_FRESHNESS_HEALTHY_MS, BACKUP_FRESHNESS_CRITICAL_MS, BACKUP_RECOVERY_THRESHOLD_MS, HOUR_MS } from "../lib/backup-status/freshness.ts";

// Backup alert -- pure decision function tests
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Stage 3, Section 9/10).
// `evaluateBackupAlert` has no I/O of any kind; every case here is a
// plain, deterministic input/output check, matching this repo's
// established pure-decision-function convention (status-worker/src/
// watchdog.ts, lib/data-health/model.ts).

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const base = { now: NOW, reachable: true, attempt: null, lastAlertedIncidentKey: null };

// ---- 1. Fresh (<26h): no email ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(2 * HOUR_MS) } });
  assert.equal(r.shouldSend, false);
  assert.match(r.reason, /fresh/);
}

// ---- 2. 26h - <36h (recovery window): no email ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(BACKUP_RECOVERY_THRESHOLD_MS) } });
  assert.equal(r.shouldSend, false, "the recovery window (>=26h, <36h) must never itself trigger a human email");
  assert.match(r.reason, /recovery window/);
}
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(BACKUP_FRESHNESS_HEALTHY_MS - 60_000) } });
  assert.equal(r.shouldSend, false, "just under 36h must still be within the recovery window, not escalated");
}

// ---- 3. Exactly 36h: one alert (>= threshold, not >) ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(BACKUP_FRESHNESS_HEALTHY_MS) } });
  assert.equal(r.shouldSend, true, "exactly 36h old must already be alert-eligible (>= threshold)");
  assert.equal(r.tier, "attention");
}

// ---- 4. >36h: alert ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(BACKUP_FRESHNESS_HEALTHY_MS + HOUR_MS) } });
  assert.equal(r.shouldSend, true);
  assert.equal(r.tier, "attention");
}

// ---- 5. >72h: critical semantics, without creating a duplicate/second incident for the same underlying success ----
{
  const success = { completedAt: iso(BACKUP_FRESHNESS_CRITICAL_MS + HOUR_MS) };
  const first = evaluateBackupAlert({ ...base, success });
  assert.equal(first.shouldSend, true);
  assert.equal(first.tier, "critical");
  const second = evaluateBackupAlert({ ...base, success, lastAlertedIncidentKey: first.incidentKey });
  assert.equal(second.shouldSend, false, "crossing from attention into critical for the SAME success must never itself re-trigger a second alert for the same incident");
}

// ---- 6. Newer failed attempt floors an older (otherwise-fresh) success ----
{
  const r = evaluateBackupAlert({
    now: NOW,
    reachable: true,
    lastAlertedIncidentKey: null,
    success: { completedAt: iso(2 * HOUR_MS) },
    attempt: { attemptAt: iso(HOUR_MS), attemptStatus: "failure" },
  });
  assert.equal(r.shouldSend, true, "a newer failed attempt must escalate even while the last success is well within its healthy window");
  assert.equal(r.newerFailedAttempt, true);
  assert.equal(r.tier, "attention", "the age-based tier alone would be healthy/fresh, so a newer-failure-only escalation must read as attention, not critical");
}
{
  // A newer SUCCESSFUL attempt must never itself escalate.
  const r = evaluateBackupAlert({
    ...base,
    success: { completedAt: iso(2 * HOUR_MS) },
    attempt: { attemptAt: iso(HOUR_MS), attemptStatus: "success" },
  });
  assert.equal(r.shouldSend, false);
}

// ---- 7. Missing success: safe alert semantics, never fabricates a timestamp ----
{
  const r = evaluateBackupAlert({ ...base, success: null });
  assert.equal(r.shouldSend, true, "no successful backup ever recorded must be alert-eligible, never silently healthy");
  assert.equal(r.incidentKey, NO_SUCCESS_INCIDENT_KEY);
  assert.equal(r.ageMs, null);
  assert.equal(r.tier, "critical");
}

// ---- 8. Malformed status (unparseable completedAt): same safe behavior as missing ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: "not-a-real-date" } });
  assert.equal(r.shouldSend, true);
  assert.equal(r.incidentKey, NO_SUCCESS_INCIDENT_KEY);
  assert.equal(r.ageMs, null);
}

// ---- 9. STATUS_WORKER unreachable: never a misleading email either way ----
{
  const r = evaluateBackupAlert({ ...base, reachable: false, success: { completedAt: iso(40 * HOUR_MS) } });
  assert.equal(r.shouldSend, false, "an unreachable status read must never itself produce an alert, even if the (unread) underlying data would otherwise be stale");
  assert.match(r.reason, /unreachable/);
}

// ---- 11. First stale invocation: one send (no prior incidentKey) ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(40 * HOUR_MS) }, lastAlertedIncidentKey: null });
  assert.equal(r.shouldSend, true);
}

// ---- 12 & 13. Same incident (this hour, or a day later): suppressed regardless of how much later ----
{
  const success = { completedAt: iso(40 * HOUR_MS) };
  const first = evaluateBackupAlert({ ...base, success });
  const sameHourLater = evaluateBackupAlert({ ...base, success, lastAlertedIncidentKey: first.incidentKey });
  assert.equal(sameHourLater.shouldSend, false, "the very next hourly check for the identical incident must be suppressed");
  const dayLater = evaluateBackupAlert({ now: NOW + 24 * HOUR_MS, reachable: true, attempt: null, success, lastAlertedIncidentKey: first.incidentKey });
  assert.equal(dayLater.shouldSend, false, "the same incident a full day later, with no reminder policy implemented, must still be suppressed");
}

// ---- 14. A new successful backup resolves the incident (no email, healthy) ----
{
  const r = evaluateBackupAlert({ ...base, success: { completedAt: iso(1 * HOUR_MS) }, lastAlertedIncidentKey: iso(40 * HOUR_MS) });
  assert.equal(r.shouldSend, false, "a fresh new success must read as healthy regardless of what incident was previously alerted on");
}

// ---- 15. A later, independent new stale incident is newly alert-eligible ----
{
  const oldIncidentKey = iso(60 * HOUR_MS);
  const newSuccess = { completedAt: iso(37 * HOUR_MS) };
  const r = evaluateBackupAlert({ ...base, success: newSuccess, lastAlertedIncidentKey: oldIncidentKey });
  assert.equal(r.shouldSend, true, "a different (newer) success that has itself since gone stale must be a new incident, eligible for its own alert");
  assert.notEqual(r.incidentKey, oldIncidentKey);
}

// ---- 16. DST boundary: pure millisecond math ----
{
  const beforeDst = Date.parse("2026-11-01T04:00:00.000Z");
  const afterDst = beforeDst + 40 * HOUR_MS;
  const straddling = evaluateBackupAlert({ now: afterDst, reachable: true, attempt: null, lastAlertedIncidentKey: null, success: { completedAt: new Date(beforeDst).toISOString() } });
  const nonStraddling = evaluateBackupAlert({ ...base, success: { completedAt: iso(40 * HOUR_MS) } });
  assert.equal(straddling.ageMs, nonStraddling.ageMs, "elapsed time across a DST boundary must equal the same elapsed time on an ordinary day");
  assert.equal(straddling.shouldSend, nonStraddling.shouldSend);
}

// ---- Idempotency: identical input always produces identical output ----
{
  const input = { now: NOW, reachable: true, success: { completedAt: iso(40 * HOUR_MS) }, attempt: { attemptAt: iso(39 * HOUR_MS), attemptStatus: "failure" }, lastAlertedIncidentKey: null };
  assert.deepEqual(evaluateBackupAlert(input), evaluateBackupAlert(input));
}

process.stdout.write("Backup alert decision-function checks passed.\n");
