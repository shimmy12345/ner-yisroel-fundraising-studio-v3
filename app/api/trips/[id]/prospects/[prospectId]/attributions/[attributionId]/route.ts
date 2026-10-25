import { getChatGPTUser } from "../../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../../lib/auth/profile";
import {
  removeTripFinancialAttribution, confirmTripAttribution, unconfirmTripAttribution,
  removeUnlinkedProspectCommitment, confirmUnlinkedProspectCommitment, unconfirmUnlinkedProspectCommitment,
} from "../../../../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../../../../lib/logger";

// Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md): the
// task's own explicit "provide a way to mark an existing entry confirmed
// without recreating it." Marks (or un-marks, to correct a mistake) an
// EXISTING pending trip entry donor-confirmed -- never recreates the
// attribution or touches the underlying giving_activities row.
//
// Unlinked-Prospect Fundraising (2026-10-25, see docs/AI-HANDOFF.md): a
// real attribution and an unlinked prospect's own commitment share this
// one URL/id space in the UI (TripFinancialAttributionRow.attributionId
// is each record's own id either way), so this tries the real
// attribution first and falls back to the commitment-equivalent action
// only on "not_found" -- never both, and never guessing which table an
// id belongs to from its shape (both are plain random UUIDs).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; prospectId: string; attributionId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, attributionId } = await params;

  let body: { donorConfirmed?: boolean };
  try { body = await request.json() as { donorConfirmed?: boolean }; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
  if (typeof body.donorConfirmed !== "boolean") return Response.json({ error: "Specify donorConfirmed as true or false." }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  let result = body.donorConfirmed
    ? await confirmTripAttribution(profile.id, id, attributionId, now)
    : await unconfirmTripAttribution(profile.id, id, attributionId);
  if (!result.ok && result.reason === "not_found") {
    result = body.donorConfirmed
      ? await confirmUnlinkedProspectCommitment(profile.id, id, attributionId, now)
      : await unconfirmUnlinkedProspectCommitment(profile.id, id, attributionId);
  }
  if (!result.ok) {
    if (result.reason === "not_found") return Response.json({ error: "Attribution not found" }, { status: 404 });
    return Response.json({ error: "This record is already confirmed by JL -- there is nothing to confirm or unconfirm here." }, { status: 422 });
  }
  logger.info("trip_financial_attribution_confirmation_changed", { userId: profile.id, tripId: id, attributionId, donorConfirmed: body.donorConfirmed });
  return Response.json({ ok: true });
}

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
  const removed = await removeTripFinancialAttribution(profile.id, id, attributionId, reason, now)
    || await removeUnlinkedProspectCommitment(profile.id, id, attributionId, reason, now);
  if (!removed) return Response.json({ error: "Attribution not found" }, { status: 404 });
  logger.info("trip_financial_attribution_removed", { userId: profile.id, tripId: id, attributionId });
  return Response.json({ ok: true });
}
