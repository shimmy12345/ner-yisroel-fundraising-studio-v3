// Pure email-content construction for the backup-alert message -- no D1
// access, no network call, no Gmail dependency. Kept separate from
// decision.ts (what to decide) and run.ts (the Workers-runtime shell that
// actually sends it), matching this repo's agenda-model.ts/agenda-render.ts/
// gmail-client.ts split. Content requirements are from
// docs/BACKUP-SCHEDULING-RELIABILITY.md's Stage 3 spec: concise,
// operational, and never containing a credential, token, encrypted backup
// content, or any donor/fundraising data.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function formatAge(ageMs: number): string {
  const hours = ageMs / 3_600_000;
  const roundedHours = Math.round(hours);
  if (hours < 48) return `${roundedHours} hour${roundedHours === 1 ? "" : "s"}`;
  return `${(hours / 24).toFixed(1)} days`;
}

export type BackupAlertEmailInput = {
  // null exactly when no successful backup has ever been recorded, or the
  // recorded status could not be read -- see decision.ts's
  // NO_SUCCESS_INCIDENT_KEY. Never a fabricated timestamp in that case.
  lastSuccessCompletedAt: string | null;
  ageMs: number | null;
  latestAttempt: { attemptAt: string; attemptStatus: string } | null;
  newerFailedAttempt: boolean;
  tier: "attention" | "critical";
};

export type BackupAlertEmail = { subject: string; text: string; html: string };

export function buildBackupAlertEmail(input: BackupAlertEmailInput): BackupAlertEmail {
  const subject = "Fundraising OS backup alert: backup is overdue";

  const paragraphs: string[] = [];
  if (input.lastSuccessCompletedAt === null || input.ageMs === null) {
    paragraphs.push("Fundraising OS cannot verify a recent successful backup.");
    paragraphs.push("No successful backup completion has been recorded, or the recorded backup status could not be read.");
  } else {
    paragraphs.push(`The last successful backup completed at ${input.lastSuccessCompletedAt}, which is now ${formatAge(input.ageMs)} ago.`);
    paragraphs.push("Automatic recovery was expected once the backup reached 26 hours old. Freshness now exceeds the 36-hour escalation threshold, which is why this alert was sent.");
    if (input.tier === "critical") paragraphs.push("This has now exceeded 72 hours -- a full backup cycle has clearly been missed.");
  }

  if (input.latestAttempt) {
    paragraphs.push(`The most recent backup attempt was at ${input.latestAttempt.attemptAt} (status: "${input.latestAttempt.attemptStatus}").${input.newerFailedAttempt ? " This attempt is newer than the last recorded success and did not succeed." : ""}`);
  } else {
    paragraphs.push("No backup attempt record is available.");
  }

  paragraphs.push("Please check Workspace Health and the GitHub Actions backup workflow to confirm the current state.");
  paragraphs.push("This is an operational warning about backup scheduling. It is not evidence of data loss.");

  const text = paragraphs.join("\n\n");
  const html = `<!doctype html>
<html>
  <body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:16px;">
    <h1 style="font-size:18px;margin:0 0 16px;">Fundraising OS backup alert</h1>
    ${paragraphs.map((paragraph) => `<p style="margin:0 0 12px;">${escapeHtml(paragraph)}</p>`).join("\n    ")}
  </body>
</html>`;

  return { subject, text, html };
}
