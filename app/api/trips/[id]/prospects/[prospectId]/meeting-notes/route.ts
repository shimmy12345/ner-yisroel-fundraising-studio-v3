import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import { logger } from "../../../../../../../lib/logger";
import { getProspectMeetingNotesTarget } from "../../../../../../../lib/relationships/trips-data";
import { followUpListsMatch, type FollowUpContent } from "../../../../../../../lib/meeting-notes/idempotency";

type FollowUpInput = { description?: string; dueAt?: string | null };
type RequestBody = {
  summary?: string;
  aiOrganized?: boolean;
  idempotencyKey?: string;
  followUps?: FollowUpInput[];
};

const MAX_SUMMARY_LENGTH = 8000;
const MAX_FOLLOW_UP_DESCRIPTION = 300;
const MAX_FOLLOW_UPS = 20;

// AI meeting notes from Trip Planning (2026-10-21, see docs/AI-HANDOFF.md).
// Shares the donor profile's own Organize-with-AI review screen and
// writes the exact same two tables app/api/meeting-notes/route.ts does
// (interactions, recommendations) -- but this save ALWAYS targets the
// SAME interaction the trip meeting flow already created and links via
// trip_prospects.linked_interaction_id (never a new, trip-only
// interaction, never guessed by donor/date -- see
// getProspectMeetingNotesTarget's own doc comment). A separate route
// file, not a branch of app/api/meeting-notes/route.ts, specifically so
// it lives under /api/trips/** -- the one path prefix lib/operations/
// staging-write-guard.ts's Trip Planning carve-out covers (see that
// file's own header comment and tests/staging-write-guard.test.mjs's
// repo-wide route walk) -- rather than silently losing that Staging
// testability by hanging off the donor-profile route instead.
//
// Deliberately touches ONLY `summary` on the interaction row:
// occurred_at/end_at/location/type/source all belong to the real meeting
// (set by scheduleProspectMeeting/completeProspectMeeting) and are
// load-bearing for the Add-to-Google-Calendar sync on that same
// interaction -- never re-derived or overwritten here.
//
// Idempotency: the client's own per-review-session idempotencyKey
// prefixes every follow-up's recommendation id (never the target
// interaction id, which is a STABLE id that already existed before this
// save and will still exist after it -- see this route's own follow-up
// id construction below). The interaction UPDATE can never itself
// PRIMARY KEY-conflict (it is an UPDATE, not an INSERT); only a follow-up
// INSERT can, meaning a reused idempotencyKey from a double-click/retry
// of this exact save. The whole batch (interaction UPDATE included)
// rolls back together on that conflict; re-reading the follow-ups saved
// under this exact key tells an identical retry (safe no-op replay)
// apart from a changed-payload retry (rejected, nothing changed) -- the
// same two outcomes app/api/meeting-notes/route.ts's own idempotency
// handling guarantees for the donor-profile flow.
export async function POST(request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id: tripId, prospectId } = await params;

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const summary = body.summary?.trim() ?? "";
  const idempotencyKey = body.idempotencyKey?.trim() ?? "";
  if (summary.length < 4 || !idempotencyKey) {
    return Response.json({ error: "Meeting notes and a save key are required" }, { status: 422 });
  }
  if (summary.length > MAX_SUMMARY_LENGTH) {
    return Response.json({ error: `Meeting notes are too long (max ${MAX_SUMMARY_LENGTH} characters)` }, { status: 422 });
  }
  // The idempotency key becomes part of a database primary key below --
  // bound, not interpolated, but still capped to a sane length
  // defensively, matching app/api/meeting-notes/route.ts's own check.
  if (idempotencyKey.length > 200) return Response.json({ error: "Invalid save key" }, { status: 422 });

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
    followUps.push({ index: followUps.length, description, dueAtEpoch });
  }

  const profile = await ensureUserProfile(user);
  const userId = profile.id;

  const target = await getProspectMeetingNotesTarget(userId, tripId, prospectId);
  if (!target.ok) {
    return target.reason === "no_meeting_yet"
      ? Response.json({ error: "This meeting doesn't have a saved interaction yet. Schedule or complete the meeting first." }, { status: 409 })
      : Response.json({ error: "Trip prospect not found" }, { status: 404 });
  }
  const { donorId, interactionId } = target;
  const now = Math.floor(Date.now() / 1000);

  const statements = [
    env.DB.prepare("UPDATE interactions SET summary = ?, updated_at = ? WHERE id = ? AND donor_id = ? AND user_id = ?")
      .bind(summary, now, interactionId, donorId, userId),
    ...followUps.map((followUp) =>
      env.DB.prepare(`INSERT INTO recommendations (id, donor_id, user_id, action, reason, score, status, due_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
        .bind(`meeting-note-${idempotencyKey}-${followUp.index}`, donorId, userId, followUp.description, "Follow-up proposed from meeting notes.", 90, followUp.dueAtEpoch, now, now)),
  ];

  try {
    await env.DB.batch(statements);
    logger.info("trip_meeting_notes_saved", { donorId, userId, tripId, prospectId, followUpsCreated: followUps.length });
    return Response.json({ interactionId, saved: true, followUpsCreated: followUps.length }, { status: 200 });
  } catch (error) {
    // The interaction UPDATE above cannot itself conflict -- a batch
    // failure here only ever means a follow-up's id (prefixed by THIS
    // idempotencyKey) was already used, i.e. a double-click/retry of
    // this exact save. With no follow-ups at all, nothing in the batch
    // could conflict, so this is always a genuine, unexpected failure.
    if (followUps.length === 0) {
      logger.error("trip_meeting_notes_save_failed", error, { donorId, userId, tripId, prospectId });
      return Response.json({ error: "The meeting notes could not be saved" }, { status: 500 });
    }
    const candidateIds = Array.from({ length: MAX_FOLLOW_UPS }, (_, index) => `meeting-note-${idempotencyKey}-${index}`);
    const existingFollowUpRows = await env.DB.prepare(
      `SELECT id, action, due_at FROM recommendations WHERE id IN (${candidateIds.map(() => "?").join(",")})`,
    ).bind(...candidateIds).all<{ id: string; action: string; due_at: number | null }>();
    const existingFollowUps: FollowUpContent[] = existingFollowUpRows.results.map((row) => ({
      index: candidateIds.indexOf(row.id),
      description: row.action,
      dueAtEpoch: row.due_at,
    }));
    if (existingFollowUps.length === 0) {
      // This exact key was never used before -- not a replay/conflict,
      // a genuine unexpected failure.
      logger.error("trip_meeting_notes_save_failed", error, { donorId, userId, tripId, prospectId });
      return Response.json({ error: "The meeting notes could not be saved" }, { status: 500 });
    }
    if (followUpListsMatch(existingFollowUps, followUps)) {
      logger.info("trip_meeting_notes_save_replayed", { donorId, userId, interactionId });
      return Response.json({ interactionId, saved: true, followUpsCreated: 0 }, { status: 200 });
    }
    logger.info("trip_meeting_notes_save_conflict", { donorId, userId, interactionId });
    return Response.json({
      error: "This meeting note was already saved with different content. Nothing was changed. Reload the page to start a new save.",
    }, { status: 409 });
  }
}
