import { getChatGPTUser } from "../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../lib/auth/profile";
import { selectTripProspect, addManualProspect, getTrip } from "../../../../../lib/relationships/trips-data";
import {
  validateManualProspectName, validateManualProspectCity, validateManualProspectRegionId,
  validateManualProspectPhone, validateManualProspectEmail, validateManualProspectNotes,
} from "../../../../../lib/relationships/trip-model";
import { isValidTravelRegionId } from "../../../../../lib/relationships/travel-regions";
import { logger } from "../../../../../lib/logger";

// Deliberate Prospect Selection (2026-10-18) -- the one, explicit "Add to
// trip" action, called identically from Find Prospects whether the donor
// matched the trip's region or was found via an out-of-region search.
// selectTripProspect() itself decides added_method and whether this
// reuses an existing, never-selected candidate row or inserts a new one.
//
// Manually Added Prospects (2026-10-25, see docs/AI-HANDOFF.md): the
// SAME endpoint also accepts a brand-new, not-yet-in-FOS prospect --
// discriminated by the body shape (a `donorId` selects an existing
// donor; a `manualName` with no `donorId` adds an unlinked one) rather
// than a second URL, since both are the same conceptual action from the
// fundraiser's point of view: "add this person to my trip."
type AddProspectBody = { donorId?: string; manualName?: string; manualCity?: string; manualRegionId?: string; manualPhone?: string; manualEmail?: string; manualNotes?: string };

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

  const now = Math.floor(Date.now() / 1000);

  if (!body.donorId) {
    const nameResult = validateManualProspectName(body.manualName);
    if (!nameResult.ok) return Response.json({ error: "A name is required to add a prospect manually." }, { status: 422 });
    const cityResult = validateManualProspectCity(body.manualCity);
    if (!cityResult.ok) return Response.json({ error: "City is too long." }, { status: 422 });
    const regionResult = validateManualProspectRegionId(body.manualRegionId, isValidTravelRegionId);
    if (!regionResult.ok) return Response.json({ error: "Choose a valid region." }, { status: 422 });
    const phoneResult = validateManualProspectPhone(body.manualPhone);
    if (!phoneResult.ok) return Response.json({ error: "Enter a valid phone number." }, { status: 422 });
    const emailResult = validateManualProspectEmail(body.manualEmail);
    if (!emailResult.ok) return Response.json({ error: "Enter a valid email address." }, { status: 422 });
    const notesResult = validateManualProspectNotes(body.manualNotes);
    if (!notesResult.ok) return Response.json({ error: "Notes are too long." }, { status: 422 });

    const result = await addManualProspect(profile.id, id, {
      name: nameResult.name, city: cityResult.city, regionId: regionResult.regionId, phone: phoneResult.phone, email: emailResult.email, notes: notesResult.notes,
    }, now);
    if (!result.ok) return Response.json({ error: "Trip not found" }, { status: 404 });
    logger.info("trip_manual_prospect_added", { userId: profile.id, tripId: id, prospectId: result.prospectId });
    return Response.json({ prospectId: result.prospectId }, { status: 201 });
  }

  const donorId = body.donorId;
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
