import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { reminderDueAt, type ReminderChoice } from "../../../../../lib/capture/interaction";
import { askFollowUpAction, type AskStatus } from "../../../../../lib/capture/ask";
import { logger } from "../../../../../lib/logger";

// "Add follow-up" for an ask that ALREADY exists and has no reminder yet
// (Ask/Solicitation v1's own deferred item 2 -- see docs/AI-HANDOFF.md).
// Reuses the exact same reminder mechanism every other ask/interaction
// reminder already uses -- a `recommendations` row whose id carries the
// "ask-<askId>-" prefix convention (app/api/asks/route.ts, app/api/asks/
// [id]/route.ts's own status-change completion query) -- never a second
// reminder system, never a new schema column. Only ever writes to
// `recommendations`; never touches the `asks` row itself, so the ask's
// amount/purpose/asked date/status are structurally guaranteed unchanged
// by this route (it has no UPDATE asks statement at all).
type AskRow = { id: string; donor_id: string; user_id: string; amount_cents: number | null; purpose: string | null; status: AskStatus };
type RequestBody = { reminder?: ReminderChoice; customDate?: string };

const reminderChoices = new Set<ReminderChoice>(["tomorrow", "next-week", "custom"]);

async function ownedPendingAsk(id: string, userId: string) {
  return env.DB.prepare(`SELECT a.id, a.donor_id, a.user_id, a.amount_cents, a.purpose, a.status
    FROM asks a JOIN donors d ON d.id = a.donor_id
    WHERE a.id = ? AND a.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live' LIMIT 1`)
    .bind(id, userId, userId).first<AskRow>();
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const { id } = await params;

  const ask = await ownedPendingAsk(id, userId);
  if (!ask) return Response.json({ error: "Ask not found" }, { status: 404 });
  // Only a still-pending ask can receive a new follow-up -- a committed/
  // declined/withdrawn ask is closed, and its own status-change already
  // completed every reminder it had (see app/api/asks/[id]/route.ts);
  // adding a new one for a closed ask would contradict that.
  if (ask.status !== "pending") return Response.json({ error: "This ask is no longer pending" }, { status: 409 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
  if (!body.reminder || !reminderChoices.has(body.reminder)) return Response.json({ error: "Choose a follow-up date" }, { status: 422 });

  const now = new Date();
  const dueAt = reminderDueAt(body.reminder, body.customDate, now, profile.timezone);
  if (!dueAt) return Response.json({ error: "Choose a valid follow-up date" }, { status: 422 });

  // Fail closed against a duplicate rather than blindly inserting a
  // second open reminder for the same ask -- "the smallest coherent
  // behavior" per the approved scope: an ask with an active follow-up
  // already shows it and offers rescheduling (POST /api/recommendations/
  // [id]/reschedule, the existing generic reminder-edit path -- see
  // app/components/RescheduleButton.tsx), never a second, competing
  // reminder. This same pre-check also covers the common double-submit/
  // retry case (the client itself also disables the trigger while
  // saving, matching every other write action in this app -- neither
  // layer alone is a hard transactional guarantee against a true race,
  // which no reminder-creation path in this app has ever provided).
  const existing = await env.DB.prepare(`SELECT id, due_at FROM recommendations
    WHERE user_id = ? AND status = 'open' AND id LIKE ? ESCAPE '\\' LIMIT 1`)
    .bind(userId, `ask-${id.replace(/[\\%_]/g, "\\$&")}-%`).first<{ id: string; due_at: number | null }>();
  if (existing) return Response.json({ error: "This ask already has an active follow-up", reminderId: existing.id, dueAt: existing.due_at }, { status: 409 });

  const nowEpoch = Math.floor(now.getTime() / 1000);
  const reminderId = `ask-${id}-${crypto.randomUUID()}`;
  try {
    await env.DB.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 94, 'open', ?, ?, ?)`)
      .bind(reminderId, ask.donor_id, userId, askFollowUpAction(ask.amount_cents, ask.purpose), "Follow-up reminder added for this ask.", Math.floor(dueAt.getTime() / 1000), nowEpoch, nowEpoch)
      .run();
  } catch (error) {
    logger.error("ask_reminder_create_failed", error, { askId: id, userId });
    return Response.json({ error: "Follow-up could not be saved" }, { status: 500 });
  }

  logger.info("ask_reminder_created", { askId: id, donorId: ask.donor_id, userId, reminderId });
  return Response.json({ reminderId, askId: id, donorId: ask.donor_id, dueAt: dueAt.toISOString() }, { status: 201 });
}
