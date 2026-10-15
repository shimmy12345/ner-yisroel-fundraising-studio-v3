import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { logger } from "../../../lib/logger";
import type { InteractionKind } from "../../../lib/capture/interaction";

type FollowUpInput = { description?: string; dueAt?: string | null };
type RequestBody = {
  donorId?: string;
  occurredAt?: string;
  type?: InteractionKind;
  summary?: string;
  aiOrganized?: boolean;
  idempotencyKey?: string;
  followUps?: FollowUpInput[];
};

const kinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);
const MAX_SUMMARY_LENGTH = 8000;
const MAX_FOLLOW_UP_DESCRIPTION = 300;
const MAX_FOLLOW_UPS = 20;

// Saves an approved meeting note to the donor's existing interaction
// history, plus any approved follow-up actions to the existing
// recommendations table (the same two tables and the same donor-ownership
// check app/api/interactions/route.ts uses -- no new table, no new
// migration). Nothing here is written until the fundraiser explicitly
// clicks Save on the review screen; this route performs no AI call of its
// own.
//
// Idempotent by construction: the client generates one idempotencyKey per
// review session (stable across repeated clicks or a retried request) and
// this route uses it as the interaction's own deterministic primary key,
// with INSERT OR IGNORE on both the interaction and every follow-up
// recommendation row. A retried request with the same key can never create
// a second interaction or duplicate follow-ups -- it simply re-confirms the
// same already-saved rows.
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const donorId = body.donorId ?? "";
  const summary = body.summary?.trim() ?? "";
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (!donorId || summary.length < 4 || !idempotencyKey) {
    return Response.json({ error: "A donor, meeting notes, and a save key are required" }, { status: 422 });
  }
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return Response.json({ error: `Meeting notes are too long (max ${MAX_SUMMARY_LENGTH} characters)` }, { status: 422 });
  }
  // The idempotency key becomes a database primary key below -- bound,
  // not interpolated, but still capped to a sane length defensively.
  if (idempotencyKey.length > 200) return Response.json({ error: "Invalid save key" }, { status: 422 });

  const type = body.type && kinds.has(body.type) ? body.type : "meeting";
  // This feature only ever asks for a DATE, never a time (see this
  // route's own doc comment) -- a plain "YYYY-MM-DD" is anchored at UTC
  // noon, the same date-only convention already used for Monday.com-
  // imported rows (see db/schema.ts's occurredAtDateOnly comment), so the
  // chosen calendar day can never shift across a timezone boundary.
  const isDateOnly = typeof body.occurredAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.occurredAt);
  const occurredAt = isDateOnly ? new Date(`${body.occurredAt}T12:00:00Z`) : body.occurredAt ? new Date(body.occurredAt) : new Date();
  if (!Number.isFinite(occurredAt.getTime())) return Response.json({ error: "Choose a valid meeting date" }, { status: 422 });

  const rawFollowUps = Array.isArray(body.followUps) ? body.followUps.slice(0, MAX_FOLLOW_UPS) : [];
  const followUps: Array<{ description: string; dueAtEpoch: number | null }> = [];
  for (const item of rawFollowUps) {
    const description = item?.description?.trim() ?? "";
    if (description.length === 0) continue;
    if (description.length > MAX_FOLLOW_UP_DESCRIPTION) {
      return Response.json({ error: `A follow-up action is too long (max ${MAX_FOLLOW_UP_DESCRIPTION} characters)` }, { status: 422 });
    }
    let dueAtEpoch: number | null = null;
    if (item?.dueAt) {
      const dueAtIsDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(item.dueAt);
      const parsed = dueAtIsDateOnly ? new Date(`${item.dueAt}T12:00:00Z`) : new Date(item.dueAt);
      if (!Number.isFinite(parsed.getTime())) return Response.json({ error: "A follow-up action has an invalid date" }, { status: 422 });
      dueAtEpoch = Math.floor(parsed.getTime() / 1000);
    }
    followUps.push({ description, dueAtEpoch });
  }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const ownedDonor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, userId).first<{ id: string }>();
  if (!ownedDonor) return Response.json({ error: "Donor not found" }, { status: 404 });

  const interactionId = idempotencyKey;
  const now = Math.floor(Date.now() / 1000);
  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const source = body.aiOrganized === true ? "meeting-notes:ai-organized" : "meeting-notes:manual";

  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO interactions (id, donor_id, user_id, type, occurred_at, occurred_at_date_only, summary, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(interactionId, donorId, userId, type, occurredAtEpoch, isDateOnly ? 1 : 0, summary, source, now, now),
  ];
  followUps.forEach((followUp, index) => {
    statements.push(
      env.DB.prepare(`INSERT OR IGNORE INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .bind(`meeting-note-${interactionId}-${index}`, donorId, userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now),
    );
  });

  let results: Array<{ meta?: { changes?: number } }>;
  try {
    results = await env.DB.batch(statements) as unknown as Array<{ meta?: { changes?: number } }>;
  } catch (error) {
    logger.error("meeting_notes_save_failed", error, { donorId, userId });
    return Response.json({ error: "The meeting notes could not be saved" }, { status: 500 });
  }

  const interactionCreated = (results[0]?.meta?.changes ?? 0) > 0;
  const followUpsCreated = results.slice(1).filter((result) => (result.meta?.changes ?? 0) > 0).length;

  logger.info("meeting_notes_saved", { donorId, userId, interactionCreated, followUpsCreated, totalFollowUps: followUps.length });
  return Response.json({ interactionId, saved: true, followUpsCreated }, { status: 201 });
}
