// Orchestration for the Daily Fundraising Agenda email: builds the
// agenda from live D1 data and, separately, actually sends it via Gmail.
// Kept as two exported functions (generateAgenda / sendDailyAgenda) so
// the preview route can call generateAgenda() alone and never touch
// gmail-client.ts at all -- there is no code path from the preview route
// to an actual send.

import { env } from "cloudflare:workers";
import { loadWorkspaceBrief } from "../workspace/live-data.ts";
import { userIdForEmail } from "../auth/profile.ts";
import { buildAgenda, type Agenda } from "./agenda-model.ts";
import { renderAgendaHtml, renderAgendaText } from "./agenda-render.ts";
import { sendGmail } from "./gmail-client.ts";
import { isDailyAgendaSendHour, isDailyAgendaRecoveryHour, easternDateKey, AGENDA_TIMEZONE } from "./timezone.ts";
import {
  buildAgendaClaimQuery,
  buildAgendaSentCommitQuery,
  buildAgendaSendStateQuery,
  resolveAgendaSendState,
  decideAgendaSendAction,
  type AgendaSendState,
} from "./send-log.ts";
import { logger } from "../logger.ts";

export class AgendaOwnerNotConfiguredError extends Error {
  constructor() {
    super("STAGING_OWNER_EMAIL is not configured on this Worker");
    this.name = "AgendaOwnerNotConfiguredError";
  }
}

// The single fundraiser this whole app is scoped to (see
// wrangler.staging.jsonc's STAGING_OWNER_EMAIL) -- reused as-is, never a
// new/hardcoded address, per the existing-config-location finding in
// docs/AI-HANDOFF.md's "Daily Fundraising Agenda Email" section.
function requireOwnerEmail(): string {
  const ownerEmail = env.STAGING_OWNER_EMAIL;
  if (!ownerEmail) throw new AgendaOwnerNotConfiguredError();
  return ownerEmail;
}

// loadWorkspaceBrief's "daily-agenda" context (passed below) skips the
// homepage's HOMEPAGE_MAX_RESULTS=50 clamp entirely, so this limit is the
// email's own real cap. 500 is comfortably above the current donor roster
// (248, one recommendation-kind candidate per donor at most) plus reminders/
// scheduled activities, so it is not expected to truncate real candidates in
// practice -- a concrete bounded number rather than an unbounded/Infinity
// sentinel, per the smallest-safe-fix scoping for this correction. Overdue
// and due-today items still sort first regardless, so a suggestion is always
// what would get squeezed out first if this limit were ever exceeded.
const AGENDA_PRIORITY_LIMIT = 500;

export async function generateAgenda(now = Math.floor(Date.now() / 1000)): Promise<Agenda> {
  const ownerEmail = requireOwnerEmail();
  const userId = userIdForEmail(ownerEmail);
  const brief = await loadWorkspaceBrief(userId, AGENDA_TIMEZONE, "live", now, AGENDA_PRIORITY_LIMIT, "daily-agenda");
  return buildAgenda(brief, { now, baseUrl: env.APP_BASE_URL ?? "" });
}

// Return value is Gmail's own message id when available (see
// gmail-client.ts's own header comment on why that one field alone is
// safe to surface) -- `runScheduledAgendaSend` below ignores it entirely;
// it exists for the controlled-test route, which reports it as delivery
// evidence.
export async function sendDailyAgenda(now = Math.floor(Date.now() / 1000)): Promise<string | undefined> {
  const ownerEmail = requireOwnerEmail();
  const agenda = await generateAgenda(now);
  return sendGmail({
    from: ownerEmail,
    to: ownerEmail,
    subject: agenda.subject,
    text: renderAgendaText(agenda),
    html: renderAgendaHtml(agenda),
  });
}

// Called from worker/index.ts's scheduled() handler. Registered ONLY on
// Independent Production's hourly Cron Trigger (wrangler.production.jsonc,
// `"triggers": { "crons": ["0 * * * *"] }`) -- Independent Staging's own
// copy of this same wrangler.jsonc field is explicitly `[]`. See
// docs/AI-HANDOFF.md's "October 14 Email Incident" entry for why that
// config fact alone is NOT what actually prevents a real send from
// Staging: email-send-guard.ts's fail-closed allowlist, enforced inside
// sendGmail() itself regardless of which Worker's scheduled() handler
// called it, is what does. Checking the current America/New_York
// wall-clock hour at execution time -- rather than relying on the cron
// string itself to mean "9 AM Eastern" -- is what makes this correct
// across the DST boundary: the same "0 * * * *" schedule fires at a
// different UTC instant in EST vs. EDT, and this guard is what picks out
// the one invocation per day where the *local* time actually reads 9,
// whichever UTC offset that happens to be. Every other hourly invocation
// is an intentional, silent no-op -- 23 out of every 24 calls do nothing,
// correctly.
//
// Idempotency: see send-log.ts's own header comment for the full
// delivery-semantics writeup (deliberately at-least-once) and the
// disclosed remaining duplicate/missed-delivery risk. The claim is
// attempted AFTER the hour gate (so 23 of 24 hourly ticks touch D1 not at
// all) and BEFORE sendDailyAgenda (so a lost claim race never reaches
// Gmail). This claim/commit state is per-environment (each D1 has its own
// agenda_send_log) -- it is Staging/Production environment SEPARATION
// that would make it look, on casual inspection, like cross-environment
// state can never collide, but that is not what is actually relied on
// here: email-send-guard.ts's allowlist is what ensures only ONE
// environment's claim table can ever matter, by ensuring only one
// environment can ever reach a real send at all.
//
// Failure handling: never swallowed. A failure here is logged via
// logger.error (safe -- see gmail-client.ts's own comment on why nothing
// it throws can contain a secret) AND rethrown, so Cloudflare records the
// scheduled invocation itself as failed in Observability -- there is no
// path in this function that turns a real failure into a quiet success.
// A claimed-but-failed attempt deliberately leaves its row 'pending' (see
// send-log.ts) rather than releasing it, so crash recovery and
// explicit-failure recovery share the same staleness-based reclaim path.
//
// Same-day recovery window (2026-10-27 missed-send investigation --
// docs/AI-HANDOFF.md): on that date, the 9 AM tick never reached the
// claim INSERT below at all, for a reason that remains unconfirmed
// (most likely a one-time missed Cron Trigger invocation or a transient
// D1 failure before this function's first database write -- Cloudflare
// Observability access, unavailable to this investigation, would be
// needed to say which). isDailyAgendaRecoveryHour (timezone.ts) extends
// eligibility to the 10 and 11 AM Eastern ticks on the SAME calendar
// day, but ONLY to recover that exact, unambiguous failure mode: no
// agenda_send_log row exists for today at all, which can only mean the
// claim was never attempted, which in turn can only mean no send was
// ever attempted (a real send is never reachable without first
// claiming). When a row DOES exist and is still 'pending', the actual
// outcome is genuinely unknowable from this table alone -- Gmail's send
// may have already succeeded moments before whatever stopped this
// function from reaching the commit -- so per this round's explicit
// requirement, the recovery path never attempts the claim+send sequence
// again in that case; it logs a distinct, alerting error instead and
// leaves the row exactly as it is for manual investigation. A 'sent' row
// is simply left alone. This reuses the exact same claim/send/commit
// calls the 9 AM path already uses -- the recovery window changes only
// WHEN this function is willing to run them, never HOW. The actual
// branch taken is decided by decideAgendaSendAction (send-log.ts), a
// pure function kept separate specifically so this round's required
// test scenarios can exercise it directly, without a Workers runtime.
export async function runScheduledAgendaSend(now: number): Promise<void> {
  const isSendHour = isDailyAgendaSendHour(now);
  const isRecoveryHour = isDailyAgendaRecoveryHour(now);
  if (!isSendHour && !isRecoveryHour) return;
  const ownerEmail = requireOwnerEmail();
  const userId = userIdForEmail(ownerEmail);
  const sendDate = easternDateKey(now);

  let state: AgendaSendState | null = null;
  if (isRecoveryHour) {
    const stateQuery = buildAgendaSendStateQuery(userId, sendDate);
    const stateRow = await env.DB.prepare(stateQuery.sql).bind(...stateQuery.params).first<{ status: string }>();
    state = resolveAgendaSendState(stateRow);
  }

  const action = decideAgendaSendAction({ isSendHour, isRecoveryHour, state });
  if (action === "skip_already_sent") {
    logger.info("daily_agenda_recovery_already_sent", { now });
    return;
  }
  if (action === "skip_uncertain_status") {
    logger.error(
      "daily_agenda_recovery_skipped_uncertain_status",
      new Error("A claim exists for today whose outcome cannot be confirmed as sent or not sent; refusing to auto-retry -- this requires manual investigation."),
      { now },
    );
    return;
  }
  if (isRecoveryHour) logger.info("daily_agenda_recovery_attempt", { now });

  const claim = buildAgendaClaimQuery(userId, sendDate, now);
  const claimResult = await env.DB.prepare(claim.sql).bind(...claim.params).run() as { meta: { changes?: number } };
  if ((claimResult.meta.changes ?? 0) === 0) {
    logger.info("daily_agenda_send_already_claimed", { now });
    return;
  }
  try {
    await sendDailyAgenda(now);
    const commit = buildAgendaSentCommitQuery(userId, sendDate, now);
    await env.DB.prepare(commit.sql).bind(...commit.params).run();
    logger.info(isRecoveryHour ? "daily_agenda_recovered" : "daily_agenda_sent", { now });
  } catch (error) {
    logger.error("daily_agenda_send_failed", error, { now, recoveryHour: isRecoveryHour });
    throw error;
  }
}
