import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { logger } from "../../../lib/logger";
import {
  extractInteraction,
  reminderDueAt,
  type InteractionKind,
  type ReminderChoice,
} from "../../../lib/capture/interaction";
import { validateAskAmountCents, validateAskPurpose, validateAskNote, askFollowUpAction } from "../../../lib/capture/ask";
import { ensureUserProfile } from "../../../lib/auth/profile";

type RequestBody = {
  donorId?: string;
  note?: string;
  type?: InteractionKind;
  subject?: string;
  reminder?: ReminderChoice;
  customDate?: string;
  occurredAt?: string;
  acceptRelationshipSnapshot?: boolean;
  // "Did you make an ask?" -- single-donor capture only (this route is
  // never used for shared/multi-donor activities; see
  // app/api/interactions/shared/route.ts, a deliberately separate route
  // this feature does not touch). Ask creation requires explicit user
  // action (madeAsk === true) -- never inferred from note text containing
  // "$"/"solicited"/"asked"/etc.
  madeAsk?: boolean;
  askAmountCents?: number | null;
  askPurpose?: string;
  askNote?: string;
};

const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);
const reminders = new Set<ReminderChoice>(["none", "tomorrow", "next-week", "custom"]);

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const note = body.note?.trim() ?? "";
  const donorId = body.donorId ?? "";
  if (!donorId || note.length < 4 || note.length > 5000) {
    return Response.json({ error: "A donor and interaction note are required" }, { status: 422 });
  }
  if (body.type && !kinds.has(body.type)) return Response.json({ error: "Invalid interaction type" }, { status: 422 });

  // Explicit user action only -- madeAsk must be exactly true; the note's
  // own text is never inspected for "$"/"solicited"/"asked"/etc. to infer
  // an ask.
  const madeAsk = body.madeAsk === true;
  const askAmount = madeAsk ? validateAskAmountCents(body.askAmountCents) : { ok: true as const, amountCents: null };
  if (!askAmount.ok) return Response.json({ error: "Ask amount must be a positive whole number of cents, or left blank" }, { status: 422 });
  const askPurposeResult = madeAsk ? validateAskPurpose(body.askPurpose) : { ok: true as const, purpose: null };
  if (!askPurposeResult.ok) return Response.json({ error: "Ask purpose is too long" }, { status: 422 });
  const askNoteResult = madeAsk ? validateAskNote(body.askNote) : { ok: true as const, note: null };
  if (!askNoteResult.ok) return Response.json({ error: "Ask note is too long" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const extracted = extractInteraction(note, body.type, body.subject);
  const capturedAt = new Date();
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : capturedAt;
  if (!Number.isFinite(occurredAt.getTime())) return Response.json({ error: "Choose a valid interaction date and time" }, { status: 422 });
  const scheduled = occurredAt.getTime() > capturedAt.getTime();
  const reminder = reminders.has(body.reminder ?? "none") ? body.reminder ?? "none" : "none";
  const dueAt = reminderDueAt(reminder, body.customDate, capturedAt, profile.timezone);
  if (reminder === "custom" && !dueAt) return Response.json({ error: "Choose a custom reminder date" }, { status: 422 });

  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const now = Math.floor(capturedAt.getTime() / 1000);
  const interactionId = crypto.randomUUID();
  const ownedDonor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, userId).first<{ id: string }>();
  if (!ownedDonor) return Response.json({ error: "Donor not found" }, { status: 404 });
  const storedType = extracted.type;
  const source = `${scheduled ? "capture-scheduled" : "capture"}:${extracted.type}`;
  const statements = [
    env.DB.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(interactionId, donorId, userId, storedType, occurredAtEpoch, `${extracted.subject}\n${extracted.summary}`, source, now, now),
  ];

  if (!scheduled && body.acceptRelationshipSnapshot === true) {
    statements.push(
      env.DB.prepare("UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
        .bind(extracted.relationshipSummary, extracted.memory, 86, now, donorId, userId),
    );
  }

  const askId = madeAsk ? crypto.randomUUID() : null;
  if (askId) {
    const afterJson = { amountCents: askAmount.amountCents, purpose: askPurposeResult.purpose, status: "pending", askedAt: occurredAtEpoch, note: askNoteResult.note, sourceInteractionId: interactionId };
    statements.push(
      env.DB.prepare(`INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, note, source_interaction_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
        .bind(askId, userId, donorId, askAmount.amountCents, askPurposeResult.purpose, occurredAtEpoch, askNoteResult.note, interactionId, now, now),
      env.DB.prepare(`INSERT INTO ask_changes (id, ask_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
        VALUES (?, ?, ?, ?, 'created', ?, NULL, ?, ?)`)
        .bind(crypto.randomUUID(), askId, userId, donorId, JSON.stringify(["amountCents", "purpose", "status", "askedAt", "note", "sourceInteractionId"]), JSON.stringify(afterJson), now),
    );
  }

  // One shared reminder picker (per design -- no duplicate reminder UI):
  // if an ask was made, the reminder is about following up on THAT ask
  // (id prefix "ask-<askId>-", same convention app/api/asks/route.ts
  // uses, so app/api/asks/[id]/route.ts can retire it on a status
  // change); otherwise it's the existing generic activity follow-up
  // ("activity-<interactionId>"), unchanged from before this feature.
  if (dueAt) {
    statements.push(
      env.DB.prepare("INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(
          askId ? `ask-${askId}-${crypto.randomUUID()}` : `activity-${interactionId}`,
          donorId,
          userId,
          askId ? askFollowUpAction(askAmount.amountCents, askPurposeResult.purpose) : extracted.nextAction,
          askId ? "Follow-up reminder requested when this ask was logged." : "Reminder requested for this activity.",
          94,
          "open",
          Math.floor(dueAt.getTime() / 1000),
          now,
          now,
        ),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("interaction_capture_failed", error, { donorId, userId });
    return Response.json({ error: "Interaction could not be saved" }, { status: 500 });
  }

  logger.info("interaction_captured", { donorId, userId, interactionId, askCreated: askId !== null });
  return Response.json({
    interactionId,
    occurredAt: occurredAt.toISOString(),
    scheduled,
    reminderAt: dueAt?.toISOString() ?? null,
    relationshipUpdated: !scheduled && body.acceptRelationshipSnapshot === true,
    askId,
    extracted,
  }, { status: 201 });
}
