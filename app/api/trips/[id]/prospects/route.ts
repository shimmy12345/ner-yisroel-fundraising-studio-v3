import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { selectTripProspect, getTrip } from "../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../lib/logger";

// Deliberate Prospect Selection (2026-10-18) -- the one, explicit "Add to
// trip" action, called identically from Find Prospects whether the donor
// matched the trip's region or was found via an out-of-region search.
// selectTripProspect() itself decides added_method and whether this
// reuses an existing, never-selected candidate row or inserts a new one.
type AddProspectBody = { donorId?: string };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id } = await params;

  const trip = await getTrip(profile.id, id);
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });

  let body: AddProspectBody;
  try { body = await request.json() as AddProspectBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }
  const donorId = body.donorId ?? "";
  if (!donorId) return Response.json({ error: "A donor is required" }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  try {
    const result = await selectTripProspect(profile.id, id, donorId, profile.timezone, now);
    if (!result.ok) {
      if (result.reason === "donor_not_found") return Response.json({ error: "Donor not found" }, { status: 404 });
      if (result.reason === "trip_not_found") return Response.json({ error: "Trip not found" }, { status: 404 });
      return Response.json({ error: "This donor is already a selected prospect on this trip" }, { status: 409 });
    }
    logger.info("trip_prospect_selected", { userId: profile.id, tripId: id, donorId, created: result.created });
    return Response.json({ prospectId: result.prospectId }, { status: result.created ? 201 : 200 });
  } catch (error) {
    logger.error("trip_prospect_select_failed", error, { userId: profile.id, tripId: id, donorId });
    return Response.json({ error: "Donor could not be added to this trip" }, { status: 500 });
  }
}
