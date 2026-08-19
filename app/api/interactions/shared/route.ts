import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";
import type { InteractionKind } from "../../../../lib/capture/interaction";
import { ensureUserProfile } from "../../../../lib/auth/profile";

// Logs ONE outreach activity (a shared meeting, or a broadcast text/email/
// photo) and links it to MULTIPLE donors -- see db/schema.ts's
// sharedActivities/interactions.sharedActivityId doc comments for the full
// design. Deliberately a separate route from POST /api/interactions rather
// than an extension of it: that route's single-donor contract (extractInteraction's
// subject/next-action extraction, the optional relationship-snapshot update,
// the optional reminder) stays completely untouched, and running that same
// per-conversation NLP extraction identically N times over one shared note
// would be both wasteful and semantically wrong here -- the summary text is
// authored once and shared verbatim.
//
// No reminder/recommendation row is ever created here, for any recipient --
// intentional, not an oversight. Auto-creating N identical follow-ups
// because an activity was shared would be exactly the outcome this feature
// was designed to avoid; a follow-up (if wanted) is a separate, later,
// explicitly opt-in action per recipient, same as the single-donor route.

type RequestBody = {
  donorIds?: string[];
  type?: InteractionKind;
  role?: "participant" | "recipient";
  summary?: string;
  occurredAt?: string;
};

const KINDS = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);
const ROLES = new Set(["participant", "recipient"]);

// Comfortably above the largest example this feature was designed around
// (100 recipients), while keeping one D1 batch (1 shared_activities insert +
// N interactions inserts + N recipient-audit inserts) well within a single
// bounded transaction rather than open-ended.
const MAX_RECIPIENTS = 200;

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const donorIds = Array.isArray(body.donorIds) ? body.donorIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const summary = body.summary?.trim() ?? "";

  if (donorIds.length < 2) return Response.json({ error: "A shared activity needs at least two donors -- use POST /api/interactions for a single donor" }, { status: 422 });
  if (donorIds.length > MAX_RECIPIENTS) return Response.json({ error: `A shared activity can link at most ${MAX_RECIPIENTS} donors` }, { status: 422 });
  if (new Set(donorIds).size !== donorIds.length) return Response.json({ error: "Duplicate donor in recipient list" }, { status: 422 });
  if (!body.type || !KINDS.has(body.type)) return Response.json({ error: "Invalid interaction type" }, { status: 422 });
  if (!body.role || !ROLES.has(body.role)) return Response.json({ error: "role must be 'participant' or 'recipient'" }, { status: 422 });
  if (summary.length < 4 || summary.length > 5000) return Response.json({ error: "A summary is required" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const capturedAt = new Date();
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : capturedAt;
  if (!Number.isFinite(occurredAt.getTime())) return Response.json({ error: "Choose a valid activity date" }, { status: 422 });

  // Every requested donor must resolve to one this user owns -- never
  // silently drop an unresolvable id from the batch (matches the
  // single-donor route's "donor not found" -> 404, applied here to the
  // whole set rather than one id).
  const placeholders = donorIds.map(() => "?").join(",");
  const ownedRows = await env.DB.prepare(`SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND id IN (${placeholders})`).bind(userId, ...donorIds).all<{ id: string }>();
  const ownedIds = new Set(ownedRows.results.map((row) => row.id));
  const missing = donorIds.filter((id) => !ownedIds.has(id));
  if (missing.length > 0) return Response.json({ error: "One or more donors were not found", donorIds: missing }, { status: 404 });

  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const now = Math.floor(capturedAt.getTime() / 1000);
  const sharedActivityId = crypto.randomUUID();
  const source = "manual";

  const statements = [
    env.DB.prepare("INSERT INTO shared_activities (id, user_id, type, occurred_at, summary, source, recipient_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(sharedActivityId, userId, body.type, occurredAtEpoch, summary, source, donorIds.length, now, now),
  ];
  const interactionIds: string[] = [];
  for (const donorId of donorIds) {
    const interactionId = crypto.randomUUID();
    interactionIds.push(interactionId);
    statements.push(
      env.DB.prepare("INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, shared_activity_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(interactionId, donorId, userId, body.type, occurredAtEpoch, summary, source, sharedActivityId, body.role, now, now),
    );
    statements.push(
      env.DB.prepare("INSERT INTO shared_activity_recipient_audits (id, shared_activity_id, donor_id, user_id, action, created_at) VALUES (?, ?, ?, ?, 'added', ?)")
        .bind(crypto.randomUUID(), sharedActivityId, donorId, userId, now),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    logger.error("shared_activity_capture_failed", error, { userId, donorCount: donorIds.length });
    return Response.json({ error: "Shared activity could not be saved" }, { status: 500 });
  }

  logger.info("shared_activity_captured", { userId, sharedActivityId, donorCount: donorIds.length, role: body.role });
  return Response.json({
    sharedActivityId,
    interactionIds,
    recipientCount: donorIds.length,
    occurredAt: occurredAt.toISOString(),
  }, { status: 201 });
}
