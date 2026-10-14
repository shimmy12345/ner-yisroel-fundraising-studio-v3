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
import { isDailyAgendaSendHour, easternDateKey, AGENDA_TIMEZONE } from "./timezone.ts";
import { buildAgendaClaimQuery, buildAgendaSentCommitQuery } from "./send-log.ts";
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

export async function sendDailyAgenda(now = Math.floor(Date.now() / 1000)): Promise<void> {
  const ownerEmail = requireOwnerEmail();
  const agenda = await generateAgenda(now);
  await sendGmail({
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
export async function runScheduledAgendaSend(now: number): Promise<void> {
  if (!isDailyAgendaSendHour(now)) return;
  const ownerEmail = requireOwnerEmail();
  const userId = userIdForEmail(ownerEmail);
  const sendDate = easternDateKey(now);
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
    logger.info("daily_agenda_sent", { now });
  } catch (error) {
    logger.error("daily_agenda_send_failed", error);
    throw error;
  }
}
