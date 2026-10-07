import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { isValidPledgeReviewStatus } from "../../../../lib/relationships/pledge-review";
import { logger } from "../../../../lib/logger";

// Saves/clears a pledge payment-plan CLEANUP REVIEW decision -- "I
// manually reviewed this pledge and chose this outcome." This route
// NEVER creates, edits, or ends a pledge_payment_plans row, never
// touches giving_activities/donors/jl_payment_assignment_audits, and
// never creates a reminder/recommendation. pledgeActivityId is trusted
// only after being independently re-verified as one of THIS user's own
// live giving_activities rows (never taken on faith from the URL) --
// same structural pattern as /api/pledge-payment-plans. Deliberately NOT
// restricted to currently-qualifying (open/partially-paid, no active
// plan) pledges: a review made while a pledge qualified must remain
// readable/clearable even after it stops qualifying (see
// lib/relationships/pledge-review.ts's file header).
type RequestBody = { reviewStatus?: unknown };

async function ownedLivePledge(pledgeActivityId: string, userId: string) {
  return env.DB.prepare(`SELECT id FROM giving_activities WHERE id = ? AND owner_user_id = ? AND record_origin = 'live' LIMIT 1`)
    .bind(pledgeActivityId, userId).first<{ id: string }>();
}

export async function PUT(request: Request, { params }: { params: Promise<{ pledgeActivityId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { pledgeActivityId } = await params;

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  if (!isValidPledgeReviewStatus(body.reviewStatus)) {
    return Response.json({ error: "review_status must be one of: needs_payment_plan, no_payment_plan_needed, need_to_investigate" }, { status: 422 });
  }
  const reviewStatus = body.reviewStatus;

  const profile = await ensureUserProfile(user);
  const userId = profile.id;

  const pledge = await ownedLivePledge(pledgeActivityId, userId);
  if (!pledge) return Response.json({ error: "Pledge not found" }, { status: 404 });

  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`INSERT INTO pledge_payment_plan_reviews (id, user_id, pledge_activity_id, review_status, reviewed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, pledge_activity_id) DO UPDATE SET review_status = excluded.review_status, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at`)
      .bind(crypto.randomUUID(), userId, pledgeActivityId, reviewStatus, now, now, now).run();
  } catch (error) {
    logger.error("pledge_payment_plan_review_save_failed", error, { pledgeActivityId, userId });
    return Response.json({ error: "The review decision could not be saved" }, { status: 500 });
  }

  logger.info("pledge_payment_plan_review_saved", { pledgeActivityId, userId, reviewStatus });
  return Response.json({ pledgeActivityId, reviewStatus, reviewedAt: now });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ pledgeActivityId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { pledgeActivityId } = await params;
  const profile = await ensureUserProfile(user);
  const userId = profile.id;

  try {
    await env.DB.prepare(`DELETE FROM pledge_payment_plan_reviews WHERE user_id = ? AND pledge_activity_id = ?`).bind(userId, pledgeActivityId).run();
  } catch (error) {
    logger.error("pledge_payment_plan_review_clear_failed", error, { pledgeActivityId, userId });
    return Response.json({ error: "The review decision could not be cleared" }, { status: 500 });
  }

  logger.info("pledge_payment_plan_review_cleared", { pledgeActivityId, userId });
  return Response.json({ pledgeActivityId, reviewStatus: null });
}
