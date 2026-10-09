import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { validatePlanNote } from "../../../../lib/capture/pledge-payment-plan";
import { logger } from "../../../../lib/logger";

// Reverses an active Manual Pledge Balance Correction (see
// docs/AI-HANDOFF.md) -- "remove the active correction and return to
// the normal imported balance." Never deletes the row (preserves the
// full audit trail/history); never touches giving_activities or any
// other financial record.
type RequestBody = { reverse?: boolean; reason?: string };
type CorrectionRow = { id: string; donor_id: string; pledge_activity_id: string; reversed_at: number | null };

async function ownedCorrection(id: string, userId: string) {
  return env.DB.prepare(`SELECT id, donor_id, pledge_activity_id, reversed_at FROM pledge_balance_corrections WHERE id = ? AND user_id = ? LIMIT 1`)
    .bind(id, userId).first<CorrectionRow>();
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { id } = await params;

  let body: RequestBody;
  try { body = await request.json() as RequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  if (body.reverse !== true) return Response.json({ error: "Invalid request" }, { status: 400 });

  // Reuses the exact same reason-length validator every other free-text
  // note field in this app already uses -- reversal reason is optional
  // (unlike the correction's own reason, which is required before it
  // can be applied at all).
  const reasonResult = validatePlanNote(body.reason);
  if (!reasonResult.ok) return Response.json({ error: "Reversal reason is too long" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const userId = profile.id;
  const correction = await ownedCorrection(id, userId);
  if (!correction) return Response.json({ error: "Correction not found" }, { status: 404 });

  // Duplicate-safety (same pattern already established for Mark Renewal
  // Addressed, see docs/AI-HANDOFF.md): a repeated/retried reversal
  // request against an already-reversed correction is a safe, idempotent
  // no-op -- never a confusing error, never a second write.
  if (correction.reversed_at !== null) {
    return Response.json({ id, pledgeActivityId: correction.pledge_activity_id, alreadyReversed: true });
  }

  const now = Math.floor(Date.now() / 1000);
  const result = await env.DB.prepare(`UPDATE pledge_balance_corrections SET reversed_at = ?, reversal_reason = ? WHERE id = ? AND user_id = ? AND reversed_at IS NULL`)
    .bind(now, reasonResult.note, id, userId)
    .run() as { meta: { changes: number } };

  // Concurrency guard: if a concurrent request reversed this same
  // correction between the read above and this write, `changes` is 0 --
  // treated the same as the already-reversed case above, never an
  // error, never a second conflicting write.
  if (result.meta.changes === 0) {
    const refreshed = await ownedCorrection(id, userId);
    return Response.json({ id, pledgeActivityId: correction.pledge_activity_id, alreadyReversed: true, reversedAt: refreshed?.reversed_at ?? now });
  }

  // No separate audit-log write is needed here: the
  // pledge_balance_corrections row itself IS the audit record -- this
  // same UPDATE just set its own reversedAt/reversalReason, which is
  // already a complete, permanent, queryable record of the reversal
  // (same append-only-history discipline the table's own schema
  // comment documents).
  logger.info("pledge_balance_correction_reversed", { correctionId: id, pledgeActivityId: correction.pledge_activity_id, donorId: correction.donor_id, userId });
  return Response.json({ id, pledgeActivityId: correction.pledge_activity_id, reversedAt: now });
}
