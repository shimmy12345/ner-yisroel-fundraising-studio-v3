import assert from "node:assert/strict";
import { evaluateBackupFreshness } from "../status-worker/src/watchdog.ts";
import { BACKUP_RECOVERY_THRESHOLD_MS, BACKUP_FRESHNESS_HEALTHY_MS, BACKUP_FRESHNESS_CRITICAL_MS, HOUR_MS } from "../lib/backup-status/freshness.ts";

// Backup watchdog -- pure decision function tests
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Section 6/8/9). `evaluateBackupFreshness`
// has no I/O of any kind; every case here is a plain, deterministic
// input/output check, matching this repo's established pure-decision-
// function convention (lib/data-health/model.ts, lib/portfolio-focus/).

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ---- Basic freshness boundary (26h recovery threshold) ----
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(2 * HOUR_MS) }, attempt: null });
  assert.equal(r.action, "fresh", "a 2h-old success must read as fresh");
  assert.equal(r.tier, "healthy");
}
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(25 * HOUR_MS + 59 * 60_000) }, attempt: null });
  assert.equal(r.action, "fresh", "25h59m must still be fresh -- just under the 26h recovery threshold");
}
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(BACKUP_RECOVERY_THRESHOLD_MS) }, attempt: null });
  assert.equal(r.action, "recovery_needed", "exactly 26h old must already be recovery_needed (>= threshold, not >)");
}
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(27 * HOUR_MS) }, attempt: null });
  assert.equal(r.action, "recovery_needed");
  assert.equal(r.tier, "healthy", "27h is stale enough to need recovery but still within the dashboard's own 36h healthy tier -- these are two independent axes");
}

// ---- Tier reporting (reused from the dashboard's own freshnessStatus, informational only) ----
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(BACKUP_FRESHNESS_HEALTHY_MS + HOUR_MS) }, attempt: null });
  assert.equal(r.action, "recovery_needed");
  assert.equal(r.tier, "attention", ">36h must report the escalation/attention tier");
}
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(BACKUP_FRESHNESS_CRITICAL_MS + HOUR_MS) }, attempt: null });
  assert.equal(r.action, "recovery_needed");
  assert.equal(r.tier, "critical", ">72h must report the critical tier");
}

// ---- Newer failed attempt floors the decision, even independent of the success's own age ----
{
  const r = evaluateBackupFreshness({
    now: NOW,
    success: { completedAt: iso(40 * HOUR_MS) },
    attempt: { attemptAt: iso(1 * HOUR_MS), attemptStatus: "failure" },
  });
  assert.equal(r.action, "recovery_needed", "a newer failed attempt on an old success must be recovery_needed");
  assert.match(r.reason, /most recent attempt failed/);
}
{
  // A newer SUCCESSFUL attempt must never itself trigger recovery -- only
  // a newer FAILED one does. (backup-latest-success.json would already
  // reflect it as the success record in real data, but the decision
  // function must not misread a success-status attempt as a red flag.)
  const r = evaluateBackupFreshness({
    now: NOW,
    success: { completedAt: iso(2 * HOUR_MS) },
    attempt: { attemptAt: iso(2 * HOUR_MS), attemptStatus: "success" },
  });
  assert.equal(r.action, "fresh");
}

// ---- Missing / malformed success ----
{
  const r = evaluateBackupFreshness({ now: NOW, success: null, attempt: null });
  assert.equal(r.action, "recovery_needed", "no successful backup ever recorded must be recovery_needed, never fresh");
  assert.equal(r.ageMs, null);
}
{
  // Simulates what a malformed backup-latest-success.json normalizes to
  // once index.ts's readBackupStatus has already turned invalid JSON into
  // `null` -- the pure function itself never sees raw JSON.
  const r = evaluateBackupFreshness({ now: NOW, success: null, attempt: { attemptAt: iso(HOUR_MS), attemptStatus: "success" } });
  assert.equal(r.action, "recovery_needed", "a malformed/missing success record must be recovery_needed even if the most recent attempt claims success");
}

// ---- Malformed attempt must degrade safely, never crash, never invent a false failure signal ----
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(2 * HOUR_MS) }, attempt: null });
  assert.equal(r.action, "fresh", "a missing/malformed attempt record alongside a fresh success must still read as fresh, not stale");
}

// ---- Already-recovering suppresses dispatch-worthiness in the caller's eyes ----
{
  const r = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(30 * HOUR_MS) }, attempt: null, hasActiveRun: true });
  assert.equal(r.action, "already_recovering");
}
{
  const r = evaluateBackupFreshness({ now: NOW, success: null, attempt: null, hasActiveRun: true });
  assert.equal(r.action, "already_recovering", "even with no success ever recorded, an active run in flight must suppress a second dispatch");
}

// ---- DST boundary: pure millisecond math, no timezone-aware parsing anywhere ----
{
  // 2026-11-01 America/New_York falls back from EDT (UTC-4) to EST
  // (UTC-5) in the US. A pair of real-world instants exactly 25 hours
  // apart, straddling that boundary, must produce the identical ageMs (and
  // therefore identical decision) as an equivalent non-boundary pair --
  // proving the calculation never re-derives or re-interprets a local
  // wall-clock time.
  const beforeDst = Date.parse("2026-11-01T04:00:00.000Z");
  const afterDst = beforeDst + 25 * HOUR_MS;
  const straddling = evaluateBackupFreshness({ now: afterDst, success: { completedAt: new Date(beforeDst).toISOString() }, attempt: null });
  const nonStraddling = evaluateBackupFreshness({ now: NOW, success: { completedAt: iso(25 * HOUR_MS) }, attempt: null });
  assert.equal(straddling.ageMs, nonStraddling.ageMs, "elapsed time across a DST boundary must equal the same elapsed time on an ordinary day");
  assert.equal(straddling.action, nonStraddling.action);
}

// ---- Idempotency: identical input always produces identical output (safe under duplicate/overlapping Cron evaluations) ----
{
  const input = { now: NOW, success: { completedAt: iso(30 * HOUR_MS) }, attempt: { attemptAt: iso(29 * HOUR_MS), attemptStatus: "failure" } };
  const first = evaluateBackupFreshness(input);
  const second = evaluateBackupFreshness(input);
  assert.deepEqual(first, second, "the same input must always produce the same decision -- no hidden mutable state");
}

process.stdout.write("Backup watchdog decision-function checks passed.\n");
