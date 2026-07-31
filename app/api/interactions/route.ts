import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { logger } from "../../../lib/logger";
import {
  extractInteraction,
  reminderDueAt,
  type InteractionKind,
  type ReminderChoice,
} from "../../../lib/capture/interaction";
import { ensureUserProfile } from "../../../lib/auth/profile";

type RequestBody = {
  donorId?: string;
  note?: string;
  type?: InteractionKind;
  subject?: string;
  reminder?: ReminderChoice;
  customDate?: string;
};

const kinds = new Set<InteractionKind>(["call", "email", "meeting", "note", "personal"]);
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

  const reminder = reminders.has(body.reminder ?? "none") ? body.reminder ?? "none" : "none";
  const occurredAt = new Date();
  const dueAt = reminderDueAt(reminder, body.customDate, occurredAt);
  if (reminder === "custom" && !dueAt) return Response.json({ error: "Choose a custom reminder date" }, { status: 422 });

  const extracted = extractInteraction(note, body.type, body.subject);
  const now = Math.floor(occurredAt.getTime() / 1000);
  const interactionId = crypto.randomUUID();
  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const ownedDonor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, userId).first<{ id: string }>();
  if (!ownedDonor) return Response.json({ error: "Donor not found" }, { status: 404 });
  const storedType = extracted.type === "personal" ? "note" : extracted.type;
  const statements = [
    env.DB.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(interactionId, donorId, userId, storedType, now, `${extracted.subject}\n${extracted.summary}`, `capture:${extracted.type}`, now, now),
    env.DB.prepare("UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = ?, updated_at = ? WHERE id = ? AND owner_user_id = ? AND data_source = 'live'")
      .bind(extracted.relationshipSummary, extracted.memory, 86, now, donorId, userId),
  ];

  if (dueAt || extracted.commitments.length > 0) {
    statements.push(
      env.DB.prepare("INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(
          crypto.randomUUID(),
          donorId,
          userId,
          extracted.nextAction,
          dueAt ? "Reminder requested while logging the interaction." : "Commitment detected in the interaction.",
          94,
          "open",
          Math.floor((dueAt ?? new Date(occurredAt.getTime() + 7 * 86400000)).getTime() / 1000),
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

  logger.info("interaction_captured", { donorId, userId, interactionId });
  return Response.json({
    interactionId,
    occurredAt: occurredAt.toISOString(),
    reminderAt: dueAt?.toISOString() ?? null,
    extracted,
  }, { status: 201 });
}
