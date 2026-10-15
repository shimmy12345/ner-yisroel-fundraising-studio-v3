import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { getTrip, listTripProspects, findNewlyMatchingProspects, updateTrip } from "../../../../lib/relationships/trips-data";
import { validateTripName, validateTripDates, validateFundraisingGoalCents, validateNotes, isValidTripStatus } from "../../../../lib/relationships/trip-model";
import { logger } from "../../../../lib/logger";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id } = await params;

  const trip = await getTrip(profile.id, id);
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });

  const [prospects, newlyMatching] = await Promise.all([
    listTripProspects(profile.id, id),
    findNewlyMatchingProspects(profile.id, id),
  ]);
  return Response.json({ trip, prospects, newlyMatchingDonors: newlyMatching });
}

type UpdateTripBody = {
  name?: string;
  status?: string;
  goalCents?: number | null;
  notes?: string | null;
  startDate?: number;
  endDate?: number;
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id } = await params;

  let body: UpdateTripBody;
  try { body = await request.json() as UpdateTripBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const existing = await getTrip(profile.id, id);
  if (!existing) return Response.json({ error: "Trip not found" }, { status: 404 });

  const update: Parameters<typeof updateTrip>[2] = {};

  if (body.name !== undefined) {
    const result = validateTripName(body.name);
    if (!result.ok) return Response.json({ error: "Trip name is required (200 characters or fewer)" }, { status: 422 });
    update.name = result.name;
  }
  if (body.status !== undefined) {
    if (!isValidTripStatus(body.status)) return Response.json({ error: "Choose a valid trip status" }, { status: 422 });
    update.status = body.status;
  }
  if (body.goalCents !== undefined) {
    const result = validateFundraisingGoalCents(body.goalCents);
    if (!result.ok) return Response.json({ error: "Fundraising goal must be a positive whole number of cents, or left blank" }, { status: 422 });
    update.goalCents = result.goalCents;
  }
  if (body.notes !== undefined) {
    const result = validateNotes(body.notes);
    if (!result.ok) return Response.json({ error: "Notes are too long" }, { status: 422 });
    update.notes = result.notes;
  }
  if (body.startDate !== undefined || body.endDate !== undefined) {
    const datesResult = validateTripDates(body.startDate ?? existing.startDate, body.endDate ?? existing.endDate);
    if (!datesResult.ok) return Response.json({ error: "Choose a valid start and end date -- the end date must not be before the start date" }, { status: 422 });
    update.startDate = datesResult.startDate;
    update.endDate = datesResult.endDate;
  }

  const now = Math.floor(Date.now() / 1000);
  try {
    await updateTrip(profile.id, id, update, now);
  } catch (error) {
    logger.error("trip_update_failed", error, { userId: profile.id, tripId: id });
    return Response.json({ error: "Trip could not be updated" }, { status: 500 });
  }
  const trip = await getTrip(profile.id, id);
  return Response.json({ trip });
}
