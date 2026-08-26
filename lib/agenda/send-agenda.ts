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
import { isDailyAgendaSendHour, AGENDA_TIMEZONE } from "./timezone.ts";
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

// A high priorityLimit (loadWorkspaceBrief's own cap is 50, see
// lib/workspace/suggestion-candidates.ts's HOMEPAGE_MAX_RESULTS) so the
// email never silently truncates real due/overdue items the way the
// homepage's own default limit of 8 would -- overdue and due-today items
// still sort first within that cap either way, so a suggestion is always
// what gets squeezed out first if 50 is ever exceeded.
const AGENDA_PRIORITY_LIMIT = 50;

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

// Called from worker/index.ts's scheduled() handler, intended to run on
// an hourly Cron Trigger (see wrangler.staging.jsonc's comment on why no
// `triggers.crons` entry exists yet). Checking the current
// America/New_York wall-clock hour at execution time -- rather than
// relying on the cron string itself to mean "9 AM Eastern" -- is what
// makes this correct across the DST boundary: the same "0 * * * *"
// schedule fires at a different UTC instant in EST vs. EDT, and this
// guard is what picks out the one invocation per day where the *local*
// time actually reads 9, whichever UTC offset that happens to be. Every
// other hourly invocation is an intentional, silent no-op -- 23 out of
// every 24 calls do nothing, correctly.
//
// Failure handling: never swallowed. A failure here is logged via
// logger.error (safe -- see gmail-client.ts's own comment on why nothing
// it throws can contain a secret) AND rethrown, so Cloudflare records the
// scheduled invocation itself as failed in Observability -- there is no
// path in this function that turns a real failure into a quiet success.
export async function runScheduledAgendaSend(now: number): Promise<void> {
  if (!isDailyAgendaSendHour(now)) return;
  try {
    await sendDailyAgenda(now);
    logger.info("daily_agenda_sent", { now });
  } catch (error) {
    logger.error("daily_agenda_send_failed", error);
    throw error;
  }
}
