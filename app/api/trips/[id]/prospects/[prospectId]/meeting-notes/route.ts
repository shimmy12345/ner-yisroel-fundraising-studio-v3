import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import { logger } from "../../../../../../../lib/logger";
import { getProspectMeetingNotesTarget } from "../../../../../../../lib/relationships/trips-data";
import { type FollowUpContent } from "../../../../../../../lib/meeting-notes/idempotency";
import { saveConcurrentSummaryAndFollowUps } from "../../../../../../../lib/meeting-notes/concurrent-save";

type FollowUpInput = { description?: string; dueAt?: string | null };
type RequestBody = {
  summary?: string;
  aiOrganized?: boolean;
  idempotencyKey?: string;
  followUps?: FollowUpInput[];
  // Concurrency safety (2026-10-21, second follow-up review -- "a stale
  // editor must not silently overwrite newer saved notes"): the summary
  // this editing session actually started from (MeetingNotesExperience's
  // own `initialSummaryText`, captured once when the page loaded). When
  // present, the save below is a compare-and-swap against this EXACT
  // value, never the row's current value re-read moments before writing
  // -- the real risk here is a browser tab left open across someone
  // else's completion or edit, not a sub-second race within this one
  // request. Optional only so a client that omits it still gets the
  // same CAS protection this route already had before this round (a
  // fresh read at request time) -- never a regression, just narrower
  // protection than an explicit baseline provides.
  expectedSummary?: string;
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
  const expectedSummary = typeof body.expectedSummary === "string" ? body.expectedSummary : undefined;
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

  // Concurrency safety (2026-10-21, third follow-up review): the
  // compare-and-swap baseline is the client's own `expectedSummary` when
  // provided (what this editing session actually started from), never
  // just this request's own fresh read -- see this field's own doc
  // comment above for why that distinction is the whole point.
  const casBaseline = expectedSummary ?? target.existingSummary;
  const followUpInputs = followUps.map((followUp) => ({ id: `meeting-note-${idempotencyKey}-${followUp.index}`, donorId, index: followUp.index, description: followUp.description, dueAtEpoch: followUp.dueAtEpoch }));

  try {
    const outcome = await saveConcurrentSummaryAndFollowUps(env.DB, interactionId, donorId, userId, summary, casBaseline, now, followUpInputs);
    if (outcome.status === "applied") {
      logger.info("trip_meeting_notes_saved", { donorId, userId, tripId, prospectId, followUpsCreated: outcome.followUpsCreated });
      return Response.json({ interactionId, saved: true, followUpsCreated: outcome.followUpsCreated }, { status: 200 });
    }
    if (outcome.status === "replayed") {
      logger.info("trip_meeting_notes_save_replayed", { donorId, userId, interactionId });
      return Response.json({ interactionId, saved: true, followUpsCreated: 0 }, { status: 200 });
    }
    if (outcome.reason === "summary_stale") {
      logger.info("trip_meeting_notes_save_stale", { donorId, userId, interactionId });
      return Response.json({
        error: "This meeting's notes were updated elsewhere since you opened this page. Your unsaved text has not been discarded -- copy it if you want to keep it, then reload to see the latest before saving again.",
        conflict: true,
      }, { status: 409 });
    }
    logger.info("trip_meeting_notes_save_conflict", { donorId, userId, interactionId });
    return Response.json({
      error: "This meeting note was already saved with different content. Nothing was changed. Reload the page to start a new save.",
    }, { status: 409 });
  } catch (error) {
    logger.error("trip_meeting_notes_save_failed", error, { donorId, userId, tripId, prospectId });
    return Response.json({ error: "The meeting notes could not be saved" }, { status: 500 });
  }
}
