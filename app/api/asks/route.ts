import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { reminderDueAt, type ReminderChoice } from "../../../lib/capture/interaction";
import { validateAskAmountCents, validateAskPurpose, validateAskNote, askFollowUpAction } from "../../../lib/capture/ask";
import { logger } from "../../../lib/logger";

// Direct "+ Log ask" creation -- no interaction required. The other Ask
// creation path (from interaction capture, "Did you make an ask?") lives
// in app/api/interactions/route.ts, which sets source_interaction_id;
// asks created here always have a null source_interaction_id. Status is
// always 'pending' on create -- never a caller-supplied choice, per
// design (no stage selector).
type RequestBody = {
  donorId?: string;
  amountCents?: number | null;
  purpose?: string;
  askedAt?: string;
  note?: string;
  reminder?: ReminderChoice;
  customDate?: string;
};

const reminders = new Set<ReminderChoice>(["none", "tomorrow", "next-week", "custom"]);

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const donorId = body.donorId ?? "";
  if (!donorId) return Response.json({ error: "A donor is required" }, { status: 422 });

  const amount = validateAskAmountCents(body.amountCents);
  if (!amount.ok) return Response.json({ error: "Amount must be a positive whole number of cents, or left blank" }, { status: 422 });

  const purposeResult = validateAskPurpose(body.purpose);
  if (!purposeResult.ok) return Response.json({ error: "Purpose is too long" }, { status: 422 });
  const purpose = purposeResult.purpose;

  const noteResult = validateAskNote(body.note);
  if (!noteResult.ok) return Response.json({ error: "Note is too long" }, { status: 422 });
  const note = noteResult.note;

  const capturedAt = new Date();
  const askedAt = body.askedAt ? new Date(body.askedAt) : capturedAt;
  if (!Number.isFinite(askedAt.getTime())) return Response.json({ error: "Choose a valid ask date" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const reminder = reminders.has(body.reminder ?? "none") ? body.reminder ?? "none" : "none";
  const dueAt = reminderDueAt(reminder, body.customDate, capturedAt, profile.timezone);
  if (reminder === "custom" && !dueAt) return Response.json({ error: "Choose a custom reminder date" }, { status: 422 });
  const ownedDonor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, userId).first<{ id: string }>();
  if (!ownedDonor) return Response.json({ error: "Donor not found" }, { status: 404 });

  const now = Math.floor(capturedAt.getTime() / 1000);
  const askId = crypto.randomUUID();
  const askedAtEpoch = Math.floor(askedAt.getTime() / 1000);
  const afterJson = { amountCents: amount.amountCents, purpose, status: "pending", askedAt: askedAtEpoch, note, sourceInteractionId: null };

  const statements = [
    env.DB.prepare(`INSERT INTO asks (id, user_id, donor_id, amount_cents, purpose, status, asked_at, note, source_interaction_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?)`)
      .bind(askId, userId, donorId, amount.amountCents, purpose, askedAtEpoch, note, now, now),
    env.DB.prepare(`INSERT INTO ask_changes (id, ask_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'created', ?, NULL, ?, ?)`)
      .bind(crypto.randomUUID(), askId, userId, donorId, JSON.stringify(["amountCents", "purpose", "status", "askedAt", "note"]), JSON.stringify(afterJson), now),
  ];

  if (dueAt) {
    // Id prefix "ask-<askId>-" (not a real FK -- recommendations has no
    // ask_id column, matching how interactions' own reminder link is also
    // just an id convention, "activity-<interactionId>") lets
    // app/api/asks/[id]/route.ts retire every reminder for this ask on a
    // status change, even if "Add follow-up" was used more than once.
    statements.push(
      env.DB.prepare("INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(`ask-${askId}-${crypto.randomUUID()}`, donorId, userId, askFollowUpAction(amount.amountCents, purpose), "Follow-up reminder requested when this ask was logged.", 94, "open", Math.floor(dueAt.getTime() / 1000), now, now),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("ask_create_failed", error, { donorId, userId });
    return Response.json({ error: "Ask could not be saved" }, { status: 500 });
  }

  logger.info("ask_created", { donorId, userId, askId });
  return Response.json({ askId, donorId, amountCents: amount.amountCents, purpose, status: "pending", askedAt: askedAt.toISOString(), reminderAt: dueAt?.toISOString() ?? null }, { status: 201 });
}
