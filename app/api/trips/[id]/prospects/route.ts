import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { addManualProspect, getTrip } from "../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../lib/logger";

// Manual add (Section C) -- also the one route the "New prospects
// available" panel's own "Add" action calls, by donor id, exactly like
// any other manual add. Both are `added_method: 'manual'`: a donor
// pulled in from the live region-match panel was still an explicit,
// one-at-a-time fundraiser decision, never an automatic insert.
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
    const result = await addManualProspect(profile.id, id, donorId, "manual", profile.timezone, now);
    if (!result.ok) {
      if (result.reason === "donor_not_found") return Response.json({ error: "Donor not found" }, { status: 404 });
      return Response.json({ error: "This donor is already on this trip" }, { status: 409 });
    }
    logger.info("trip_prospect_added", { userId: profile.id, tripId: id, donorId, addedMethod: "manual" });
    return Response.json({ prospectId: result.prospectId }, { status: 201 });
  } catch (error) {
    logger.error("trip_prospect_add_failed", error, { userId: profile.id, tripId: id, donorId });
    return Response.json({ error: "Donor could not be added to this trip" }, { status: 500 });
  }
}
