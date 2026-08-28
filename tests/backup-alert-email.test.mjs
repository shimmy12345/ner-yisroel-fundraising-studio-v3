import assert from "node:assert/strict";
import { buildBackupAlertEmail } from "../lib/backup-alert/email.ts";

// Backup alert -- pure email-content tests
// (docs/BACKUP-SCHEDULING-RELIABILITY.md Stage 3, Section 4). No D1, no
// network, no Gmail dependency -- matching mime-message.ts/
// agenda-render.ts's own directly-testable convention.

// ---- Normal stale case: names the timestamp, the age, both thresholds, and points at Workspace Health ----
{
  const email = buildBackupAlertEmail({
    lastSuccessCompletedAt: "2026-08-27T00:00:00.000Z",
    ageMs: 40 * 3_600_000,
    latestAttempt: { attemptAt: "2026-08-27T00:00:00.000Z", attemptStatus: "success" },
    newerFailedAttempt: false,
    tier: "attention",
  });
  assert.equal(email.subject, "Fundraising OS backup alert: backup is overdue");
  assert.match(email.text, /2026-08-27T00:00:00\.000Z/);
  assert.match(email.text, /40 hour/);
  assert.match(email.text, /26 hours/);
  assert.match(email.text, /36-hour/);
  assert.match(email.text, /Workspace Health/);
  assert.match(email.text, /GitHub Actions/);
  assert.match(email.text, /not evidence of data loss/i);
  assert.doesNotMatch(email.text, /72 hours/, "the 72h critical framing must only appear for the critical tier");
}

// ---- Critical tier: mentions the missed full cycle ----
{
  const email = buildBackupAlertEmail({
    lastSuccessCompletedAt: "2026-08-24T00:00:00.000Z",
    ageMs: 80 * 3_600_000,
    latestAttempt: null,
    newerFailedAttempt: false,
    tier: "critical",
  });
  assert.match(email.text, /72 hours/);
  assert.match(email.text, /No backup attempt record is available/);
}

// ---- Missing/malformed success: never fabricates a timestamp ----
{
  const email = buildBackupAlertEmail({
    lastSuccessCompletedAt: null,
    ageMs: null,
    latestAttempt: null,
    newerFailedAttempt: false,
    tier: "critical",
  });
  assert.match(email.text, /cannot verify a recent successful backup/i);
  assert.doesNotMatch(email.text, /\d{4}-\d{2}-\d{2}/, "must never invent a date when none is known");
}

// ---- Newer failed attempt: called out explicitly ----
{
  const email = buildBackupAlertEmail({
    lastSuccessCompletedAt: "2026-08-27T00:00:00.000Z",
    ageMs: 5 * 3_600_000,
    latestAttempt: { attemptAt: "2026-08-28T10:00:00.000Z", attemptStatus: "failure" },
    newerFailedAttempt: true,
    tier: "attention",
  });
  assert.match(email.text, /newer than the last recorded success and did not succeed/);
  assert.match(email.text, /"failure"/);
}

// ---- Never contains a credential, token, or anything resembling backup/donor content ----
{
  const email = buildBackupAlertEmail({
    lastSuccessCompletedAt: "2026-08-27T00:00:00.000Z",
    ageMs: 40 * 3_600_000,
    latestAttempt: { attemptAt: "2026-08-27T00:00:00.000Z", attemptStatus: "failure" },
    newerFailedAttempt: true,
    tier: "attention",
  });
  for (const surface of [email.subject, email.text, email.html]) {
    assert.doesNotMatch(surface, /ghp_|github_pat_|Bearer |token/i, "no credential/token of any kind may appear in the email");
    assert.doesNotMatch(surface, /donor|pledge|gift|giving/i, "no fundraising/donor data may appear in the email");
    assert.doesNotMatch(surface, /gpg|encrypt/i, "no reference to encrypted backup contents may appear in the email");
  }
}

// ---- HTML escapes attempt-status content (defense in depth, even though it is a controlled enum today) ----
{
  const email = buildBackupAlertEmail({
    lastSuccessCompletedAt: "2026-08-27T00:00:00.000Z",
    ageMs: 40 * 3_600_000,
    latestAttempt: { attemptAt: "2026-08-27T00:00:00.000Z", attemptStatus: "<script>bad()</script>" },
    newerFailedAttempt: true,
    tier: "attention",
  });
  assert.doesNotMatch(email.html, /<script>/);
  assert.match(email.html, /&lt;script&gt;/);
}

process.stdout.write("Backup alert email-content checks passed.\n");
