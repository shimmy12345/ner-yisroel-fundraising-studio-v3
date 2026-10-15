import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { logger } from "../../../lib/logger";
import type { InteractionKind } from "../../../lib/capture/interaction";
import { interactionContentMatches, followUpListsMatch, type FollowUpContent } from "../../../lib/meeting-notes/idempotency";

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
// Idempotency, strengthened (docs/AI-HANDOFF.md, "Meeting Notes Final
// Safeguards and AI Readiness"): the client generates one idempotencyKey
// per review session, used as the interaction's own deterministic primary
// key and the prefix of every follow-up's recommendation id. The
// interaction and every approved follow-up are written as ONE plain
// (non-"OR IGNORE") D1 batch -- D1 runs a batch as a single transaction, so
// a PRIMARY KEY conflict on any statement rolls back the entire batch,
// never a partial write. A conflict means this exact key was already used:
// this route then re-reads what was actually saved under that key and
// compares it to the current request.
//   - Identical content -> treated as a successful no-op replay (200,
//     nothing written again) -- a double-click, a dropped response, or a
//     network-level retry of the exact same save can never create a
//     second interaction or duplicate follow-ups.
//   - Different content under the same key -> rejected outright (409),
//     nothing written at all -- a changed-payload retry can never create
//     additional tasks or silently alter what was already saved. The
//     fundraiser must start a new review session (a fresh page load gets a
//     fresh key) to save something different.
// This is enforced here, server-side, regardless of whether the browser's
// own Save-button-disable-while-saving guard did its job -- never relied
// on as the only protection.
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
  const followUps: FollowUpContent[] = [];
  for (let index = 0; index < rawFollowUps.length; index += 1) {
    const item = rawFollowUps[index];
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
    // Re-indexed 0..N-1 over only the follow-ups that survived validation
    // (a blank description is simply dropped, not counted) -- this index
    // is what both the saved recommendation id and the later idempotency
    // comparison key on.
    followUps.push({ index: followUps.length, description, dueAtEpoch });
  }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const ownedDonor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live'").bind(donorId, userId).first<{ id: string }>();
  if (!ownedDonor) return Response.json({ error: "Donor not found" }, { status: 404 });

  const interactionId = idempotencyKey;
  const now = Math.floor(Date.now() / 1000);
  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const source = body.aiOrganized === true ? "meeting-notes:ai-organized" : "meeting-notes:manual";

  const incomingContent = { donorId, type, occurredAtEpoch, occurredAtDateOnly: isDateOnly, summary };

  const statements = [
    env.DB.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, occurred_at_date_only, summary, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(interactionId, donorId, userId, type, occurredAtEpoch, isDateOnly ? 1 : 0, summary, source, now, now),
    ...followUps.map((followUp) =>
      env.DB.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .bind(`meeting-note-${interactionId}-${followUp.index}`, donorId, userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now)),
  ];

  try {
    await env.DB.batch(statements);
    logger.info("meeting_notes_saved", { donorId, userId, interactionCreated: true, followUpsCreated: followUps.length, totalFollowUps: followUps.length });
    return Response.json({ interactionId, saved: true, followUpsCreated: followUps.length }, { status: 201 });
  } catch (error) {
    // Any batch failure (PRIMARY KEY conflict from a reused idempotency
    // key, or a genuine unexpected error) rolls the whole batch back --
    // nothing from this request was written. Re-read what, if anything,
    // already exists under this exact key to tell those two cases apart.
    const existingInteraction = await env.DB.prepare(
      "SELECT donor_id, type, occurred_at, occurred_at_date_only, summary FROM interactions WHERE id = ?",
    ).bind(interactionId).first<{ donor_id: string; type: string; occurred_at: number; occurred_at_date_only: number; summary: string }>();

    if (!existingInteraction) {
      // The key was never used before, so this is not a replay/conflict at
      // all -- a genuine, unexpected failure.
      logger.error("meeting_notes_save_failed", error, { donorId, userId });
      return Response.json({ error: "The meeting notes could not be saved" }, { status: 500 });
    }

    const existingContent = {
      donorId: existingInteraction.donor_id,
      type: existingInteraction.type,
      occurredAtEpoch: existingInteraction.occurred_at,
      occurredAtDateOnly: existingInteraction.occurred_at_date_only === 1,
      summary: existingInteraction.summary,
    };

    const candidateIds = Array.from({ length: MAX_FOLLOW_UPS }, (_, index) => `meeting-note-${interactionId}-${index}`);
    const existingFollowUpRows = await env.DB.prepare(
      `SELECT id, action, due_at FROM recommendations WHERE id IN (${candidateIds.map(() => "?").join(",")})`,
    ).bind(...candidateIds).all<{ id: string; action: string; due_at: number | null }>();
    const existingFollowUps: FollowUpContent[] = existingFollowUpRows.results.map((row) => ({
      index: candidateIds.indexOf(row.id),
      description: row.action,
      dueAtEpoch: row.due_at,
    }));

    const isExactReplay = interactionContentMatches(existingContent, incomingContent) && followUpListsMatch(existingFollowUps, followUps);

    if (isExactReplay) {
      logger.info("meeting_notes_save_replayed", { donorId, userId, interactionId });
      return Response.json({ interactionId, saved: true, followUpsCreated: 0 }, { status: 200 });
    }

    logger.info("meeting_notes_save_conflict", { donorId, userId, interactionId });
    return Response.json({
      error: "This meeting note was already saved with different content. Nothing was changed. Reload the page to start a new save.",
    }, { status: 409 });
  }
}
