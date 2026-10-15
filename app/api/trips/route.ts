import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { listTrips, createTrip } from "../../../lib/relationships/trips-data";
import { validateTripName, validateTripDates, validateFundraisingGoalCents, validateNotes } from "../../../lib/relationships/trip-model";
import { travelRegionById } from "../../../lib/relationships/travel-regions";
import { logger } from "../../../lib/logger";

// Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md).
// Same auth + ownership-scoping + validation shape app/api/asks/route.ts
// already uses -- getChatGPTUser() -> ensureUserProfile() -> validate ->
// write, never a bespoke pattern for this one feature.

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const trips = await listTrips(profile.id);
  return Response.json({ trips });
}

type CreateTripBody = {
  name?: string;
  destinationRegionId?: string | null;
  startDate?: number;
  endDate?: number;
  goalCents?: number | null;
  notes?: string | null;
};

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  let body: CreateTripBody;
  try { body = await request.json() as CreateTripBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const nameResult = validateTripName(body.name);
  if (!nameResult.ok) return Response.json({ error: "Trip name is required (200 characters or fewer)" }, { status: 422 });

  const datesResult = validateTripDates(body.startDate, body.endDate);
  if (!datesResult.ok) return Response.json({ error: "Choose a valid start and end date -- the end date must not be before the start date" }, { status: 422 });

  // A region id is optional (a trip can be created with only manually-
  // added prospects), but if one is supplied it must be one of the 15
  // approved regions -- never trusted as free text, matching the donor
  // directory's own `travelRegionById()` fallback-to-null convention for
  // an unknown/stale id (lib/navigation convention, app/donors/page.tsx).
  const region = body.destinationRegionId ? travelRegionById(body.destinationRegionId) : null;
  if (body.destinationRegionId && !region) return Response.json({ error: "Choose a valid travel region" }, { status: 422 });

  const goalResult = validateFundraisingGoalCents(body.goalCents);
  if (!goalResult.ok) return Response.json({ error: "Fundraising goal must be a positive whole number of cents, or left blank" }, { status: 422 });

  const notesResult = validateNotes(body.notes);
  if (!notesResult.ok) return Response.json({ error: "Notes are too long" }, { status: 422 });

  const profile = await ensureUserProfile(user);
  const now = Math.floor(Date.now() / 1000);

  try {
    const { tripId, autoAddedCount } = await createTrip(
      profile.id,
      { name: nameResult.name, destinationRegionId: region?.id ?? null, startDate: datesResult.startDate, endDate: datesResult.endDate, goalCents: goalResult.goalCents, notes: notesResult.notes },
      profile.timezone,
      now,
    );
    logger.info("trip_created", { userId: profile.id, tripId, autoAddedCount });
    return Response.json({ tripId, autoAddedCount }, { status: 201 });
  } catch (error) {
    logger.error("trip_create_failed", error, { userId: profile.id });
    return Response.json({ error: "Trip could not be saved" }, { status: 500 });
  }
}
