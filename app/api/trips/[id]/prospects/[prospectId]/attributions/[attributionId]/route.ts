import { getChatGPTUser } from "../../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../../lib/auth/profile";
import { removeTripFinancialAttribution } from "../../../../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../../../../lib/logger";

// Removes a trip financial attribution -- "view and correct trip
// attribution without modifying the underlying financial transaction."
// Soft-delete only (removeTripFinancialAttribution sets removed_at); the
// linked giving_activities row is never touched, never deleted.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; prospectId: string; attributionId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, attributionId } = await params;

  let reason: string | null = null;
  try {
    const body = await request.json() as { reason?: string };
    reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 2000) || null : null;
  } catch {
    // A body is optional for this action.
  }

  const now = Math.floor(Date.now() / 1000);
  const removed = await removeTripFinancialAttribution(profile.id, id, attributionId, reason, now);
  if (!removed) return Response.json({ error: "Attribution not found" }, { status: 404 });
  logger.info("trip_financial_attribution_removed", { userId: profile.id, tripId: id, attributionId });
  return Response.json({ ok: true });
}
