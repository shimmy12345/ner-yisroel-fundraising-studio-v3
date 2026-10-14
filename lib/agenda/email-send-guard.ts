// Fail-closed guard for every real outbound email this Worker can send --
// the Daily Fundraising Agenda (lib/agenda/send-agenda.ts) and the Backup
// Scheduling Reliability Stage 3 alert (lib/backup-alert/run.ts), and any
// future scheduled email -- enforced at sendGmail()'s own call site
// (lib/agenda/gmail-client.ts), not at each individual caller. See
// docs/AI-HANDOFF.md's "October 14 Email Incident" entry for why this
// exists: Independent Staging sent a real "Fundraising Agenda" email on
// 2026-10-14 despite wrangler.staging.jsonc carrying an explicit, three-
// times-redeployed empty `triggers.crons` array -- proving that a
// wrangler.jsonc config change, however many times it is redeployed and
// however correct its own deploy output looks, cannot be trusted alone to
// guarantee Staging's scheduled() handler never runs. This guard makes
// "Staging cannot send a real email" true by construction in application
// code, independent of whatever Cloudflare's own Cron Trigger state
// actually is.
//
// Deliberately an ALLOWLIST of exactly one value, not a denylist of known
// non-production values. deploymentEnvironment (lib/environment.ts) is a
// closed four-way union today, but a denylist silently fails OPEN for any
// value it has not been taught to deny -- a typo, a new build script, a
// fifth environment added later and never wired into this file. An
// allowlist fails CLOSED for every value it has not been taught to allow,
// including one it has never seen before.
//
// Reads deploymentEnvironment, a pure, build-time-resolved constant baked
// into the bundle by the specific build script invoked (see
// lib/environment.ts's own header comment: scripts/build-production-
// independent.mjs sets __FUNDRAISING_OS_ENVIRONMENT__ to
// "production-independent", scripts/build-staging.mjs to
// "staging-independent", etc.) -- never a runtime config value like
// APP_BASE_URL, which the October 14 incident showed can be wrong
// independent of which Worker is actually running, and never anything
// derived from a request (there is no request in a scheduled() invocation
// to derive anything from).
const EMAIL_SEND_ALLOWED_ENVIRONMENT = "production-independent";

export function isRealEmailSendAllowed(environment: string): boolean {
  return environment === EMAIL_SEND_ALLOWED_ENVIRONMENT;
}

export class EmailSendBlockedError extends Error {
  constructor(environment: string) {
    super(`Real email sending is blocked on deployment environment "${environment}" -- only "${EMAIL_SEND_ALLOWED_ENVIRONMENT}" may send a real email. See lib/agenda/email-send-guard.ts.`);
    this.name = "EmailSendBlockedError";
  }
}
