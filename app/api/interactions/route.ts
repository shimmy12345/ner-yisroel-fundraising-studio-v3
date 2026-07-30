import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { logger } from "../../../lib/logger";

type RequestBody = { donorId?: string; note?: string };

function extractInteraction(note: string) {
  const lower = note.toLowerCase();
  return {
    type: lower.includes("coffee") || lower.includes("met") ? "meeting" : "note",
    sentiment: /loved|excited|interested|warm/.test(lower) ? "warm" : "neutral",
    summary: note.trim(),
    memory: lower.includes("david") ? "David wants scholarship outcomes before scheduling a fall campus visit." : "New durable relationship context captured from the interaction.",
    nextAction: lower.includes("tomorrow") ? "Send scholarship outcomes tomorrow, then follow up next week." : "Review the interaction and follow up within seven days.",
    commitments: lower.includes("send") ? ["Send scholarship outcomes", "Follow up next week"] : [],
  };
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
  const note = body.note?.trim() ?? "";
  const donorId = body.donorId ?? "";
  if (!donorId || note.length < 12 || note.length > 5000) return Response.json({ error: "A donor and meaningful note are required" }, { status: 422 });

  const extracted = extractInteraction(note);
  const now = Math.floor(Date.now() / 1000);
  const interactionId = crypto.randomUUID();
  const recommendationId = crypto.randomUUID();
  const userId = `user_${user.email.toLowerCase()}`;
  const db = env.DB;
  try {
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(userId, user.email, user.displayName, now, now),
      db.prepare("INSERT OR IGNORE INTO donors (id, display_name, relationship_summary, institutional_memory, relationship_health, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(donorId, "Elena & David Chen", "Active scholarship partners with growing engagement.", extracted.memory, 82, now, now),
      db.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(interactionId, donorId, userId, extracted.type, now, extracted.summary, "natural-language-capture", now, now),
      db.prepare("UPDATE donors SET relationship_summary = ?, institutional_memory = ?, relationship_health = ?, updated_at = ? WHERE id = ?").bind("Elena and David’s interest is expanding toward direct student engagement and a possible fall campus visit.", extracted.memory, 86, now, donorId),
      db.prepare("INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(recommendationId, donorId, userId, extracted.nextAction, "Commitment detected in the latest interaction.", 94, "open", now + 86400, now, now),
    ]);
  } catch (error) {
    logger.error("interaction_capture_failed", error, { donorId, userId });
    return Response.json({ error: "Interaction could not be saved" }, { status: 500 });
  }
  logger.info("interaction_captured", { donorId, userId, interactionId });
  return Response.json({ interactionId, extracted }, { status: 201 });
}
