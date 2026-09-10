import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { logger } from "../../../../lib/logger";
import type { InteractionKind } from "../../../../lib/capture/interaction";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { chunk } from "../../../../lib/collections";

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

// D1's own hard limit is 100 bound parameters per statement (confirmed
// live against Independent Staging: a 101-donor ownership lookup -- 1 for
// owner_user_id plus 101 for the IN clause, 102 total -- failed with
// "D1_ERROR: too many SQL variables at offset 280: SQLITE_ERROR"; a
// 99-donor lookup, 100 bound params total, succeeded). MAX_RECIPIENTS
// (200) is comfortably above this, so the ownership lookup must be
// chunked rather than sent as one IN clause. Leaves room for the
// owner_user_id bind (1) plus a safety margin under the 100-param wall,
// so this never needs to be retuned if D1's own limit shifts slightly.
const OWNERSHIP_QUERY_CHUNK_SIZE = 90;

// Idempotent-retry window (docs/AI-HANDOFF.md, the "Unexpected end of JSON
// input" incident): there is no client-generated idempotency key, so an
// identical resubmission is instead recognized by exact content match
// (user, type, occurred_at, summary, recipient_count) within this window.
// Long enough to cover a genuine "I got an error, let me try again"
// re-click; short enough that two real, unrelated activities would need to
// share every one of those fields byte-for-byte AND land in the same
// 5-minute window to be mistaken for each other, which does not happen in
// practice for free-text summaries.
const DEDUPE_WINDOW_SECONDS = 300;

// Every application-controlled response from this route carries `ok` and
// `databaseChangesMade` explicitly -- see docs/AI-HANDOFF.md. `ok: false`
// is this route's own promise that nothing was written; the client only
// ever treats a failure as "safe to retry" when it sees this shape.
function failure(error: string, status: number, extra: Record<string, unknown> = {}) {
  return Response.json({ ok: false, error, databaseChangesMade: false, ...extra }, { status });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return failure("Authentication required", 401);

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return failure("Invalid request", 400); }

  const donorIds = Array.isArray(body.donorIds) ? body.donorIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  const summary = body.summary?.trim() ?? "";

  if (donorIds.length < 2) return failure("A shared activity needs at least two donors -- use POST /api/interactions for a single donor", 422);
  if (donorIds.length > MAX_RECIPIENTS) return failure(`A shared activity can link at most ${MAX_RECIPIENTS} donors`, 422);
  if (new Set(donorIds).size !== donorIds.length) return failure("Duplicate donor in recipient list", 422);
  if (!body.type || !KINDS.has(body.type)) return failure("Invalid interaction type", 422);
  if (!body.role || !ROLES.has(body.role)) return failure("role must be 'participant' or 'recipient'", 422);
  if (summary.length < 4 || summary.length > 5000) return failure("A summary is required", 422);

  const capturedAt = new Date();
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : capturedAt;
  if (!Number.isFinite(occurredAt.getTime())) return failure("Choose a valid activity date", 422);
  const occurredAtEpoch = Math.floor(occurredAt.getTime() / 1000);
  const now = Math.floor(capturedAt.getTime() / 1000);

  // Everything from here through the ownership check is read-only -- no
  // write statement has run yet, so ANY exception in this block (a
  // transient D1 error, a network blip to D1, or anything else) is still
  // provably a zero-write failure. Caught explicitly rather than left to
  // propagate uncaught: an uncaught exception's response is controlled by
  // the Workers runtime, not this route, and is not guaranteed to be JSON
  // (or even a non-empty body) -- exactly the "Unexpected end of JSON
  // input" incident this fixes. The profile upsert and the donor-ownership
  // lookup are two DIFFERENT operations with two DIFFERENT failure modes,
  // so they get two DIFFERENT log events -- collapsing them into one, as
  // the first version of this fix did, is exactly what made the follow-up
  // "too many SQL variables" incident ambiguous to diagnose from logs
  // alone.
  let userId: string;
  try {
    const profile = await ensureUserProfile(user);
    userId = profile.id;
  } catch (error) {
    logger.error("shared_activity_profile_precheck_failed", error, { donorCount: donorIds.length });
    return failure("The shared activity could not be validated. Nothing was saved.", 500);
  }

  // Every requested donor must resolve to one this user owns -- never
  // silently drop an unresolvable id from the batch (matches the
  // single-donor route's "donor not found" -> 404, applied here to the
  // whole set rather than one id). Chunked because D1 caps a single
  // statement at 100 bound parameters total (owner_user_id + the IN
  // clause) -- see OWNERSHIP_QUERY_CHUNK_SIZE above for the live-confirmed
  // proof. Each chunk is an independent read, so they run concurrently
  // rather than round-tripping one at a time.
  let ownedIds: Set<string>;
  try {
    const chunks = chunk(donorIds, OWNERSHIP_QUERY_CHUNK_SIZE);
    const chunkResults = await Promise.all(chunks.map((idsInChunk) => {
      const placeholders = idsInChunk.map(() => "?").join(",");
      return env.DB.prepare(`SELECT id FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND id IN (${placeholders})`).bind(userId, ...idsInChunk).all<{ id: string }>();
    }));
    ownedIds = new Set(chunkResults.flatMap((result) => result.results.map((row) => row.id)));
  } catch (error) {
    logger.error("shared_activity_ownership_precheck_failed", error, { donorCount: donorIds.length });
    return failure("The shared activity could not be validated. Nothing was saved.", 500);
  }
  const missing = donorIds.filter((id) => !ownedIds.has(id));
  if (missing.length > 0) return failure("One or more donors were not found", 404, { donorIds: missing });

  // Idempotent retry guard -- see DEDUPE_WINDOW_SECONDS above. Also
  // read-only, so an exception here is likewise a provable zero-write
  // failure.
  let existingActivityId: string | null = null;
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM shared_activities WHERE user_id = ? AND type = ? AND occurred_at = ? AND summary = ? AND recipient_count = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(userId, body.type, occurredAtEpoch, summary, donorIds.length, now - DEDUPE_WINDOW_SECONDS).first<{ id: string }>();
    existingActivityId = existing?.id ?? null;
  } catch (error) {
    logger.error("shared_activity_dedupe_check_failed", error, { userId, donorCount: donorIds.length });
    return failure("The shared activity could not be validated. Nothing was saved.", 500);
  }
  if (existingActivityId) {
    let priorInteractionIds: string[];
    try {
      const priorInteractions = await env.DB.prepare("SELECT id FROM interactions WHERE shared_activity_id = ? ORDER BY created_at").bind(existingActivityId).all<{ id: string }>();
      priorInteractionIds = priorInteractions.results.map((row) => row.id);
    } catch (error) {
      logger.error("shared_activity_dedupe_lookup_failed", error, { userId, sharedActivityId: existingActivityId });
      return failure("The shared activity could not be validated. Nothing was saved.", 500);
    }
    logger.info("shared_activity_duplicate_retry_returned_existing", { userId, sharedActivityId: existingActivityId, donorCount: donorIds.length });
    return Response.json({
      ok: true,
      sharedActivityId: existingActivityId,
      interactionIds: priorInteractionIds,
      recipientCount: donorIds.length,
      occurredAt: occurredAt.toISOString(),
      databaseChangesMade: false,
    }, { status: 200 });
  }

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
    // D1's batch() is all-or-nothing (see docs/AI-HANDOFF.md) -- a thrown
    // error here means NONE of these statements committed.
    logger.error("shared_activity_capture_failed", error, { userId, donorCount: donorIds.length });
    return failure("Shared activity could not be saved", 500);
  }

  // The write above already succeeded -- everything past this point must
  // never report databaseChangesMade: false, no matter what happens. A
  // logging failure is swallowed rather than allowed to mask a successful
  // save; the final Response.json() call below only ever serializes
  // already-validated primitives (plain strings/numbers), which does not
  // throw in practice.
  try {
    logger.info("shared_activity_captured", { userId, sharedActivityId, donorCount: donorIds.length, role: body.role });
  } catch { /* never let a logging failure mask a successful write */ }

  return Response.json({
    ok: true,
    sharedActivityId,
    interactionIds,
    recipientCount: donorIds.length,
    occurredAt: occurredAt.toISOString(),
    databaseChangesMade: true,
  }, { status: 201 });
}
