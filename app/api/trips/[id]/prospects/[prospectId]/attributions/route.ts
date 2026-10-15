import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import {
  getTrip, listTripProspects, listEligibleGivingActivitiesForDonor, attributeGivingActivityToTrip,
  recordPendingGiftAndAttribute, recordPendingPledgeAndAttribute,
} from "../../../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../../../lib/logger";

// Trip Fundraising Results Dashboard (Section 3, see docs/AI-HANDOFF.md).
// GET: the donor's own eligible (unattributed) giving_activities rows,
// for the "associate an existing donation/pledge" picker.
// POST: one of three actions, discriminated by `action` in the body --
//   "associate_existing" -- link an ALREADY-REAL giving_activities row.
//   "record_donation"    -- record a new pending_gift and attribute it.
//   "record_pledge"      -- record a new pending_pledge and attribute it.
// Every action is scoped to this exact (tripId, prospectId) pair --
// ownership/trip-prospect-membership checked inside trips-data.ts, never
// trusted from the request body.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  const trip = await getTrip(profile.id, id);
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });
  const prospects = await listTripProspects(profile.id, id);
  const prospect = prospects.find((item) => item.id === prospectId);
  if (!prospect) return Response.json({ error: "Prospect not found" }, { status: 404 });

  const eligible = await listEligibleGivingActivitiesForDonor(profile.id, prospect.donorId);
  return Response.json({ eligible });
}

type AttributionRequestBody = {
  action?: "associate_existing" | "record_donation" | "record_pledge";
  givingActivityId?: string;
  note?: string;
  amount?: number | string;
  date?: string;
  designation?: string;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  const trip = await getTrip(profile.id, id);
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });

  let body: AttributionRequestBody;
  try { body = await request.json() as AttributionRequestBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const now = Math.floor(Date.now() / 1000);

  if (body.action === "associate_existing") {
    if (typeof body.givingActivityId !== "string" || !body.givingActivityId) return Response.json({ error: "Choose a donation or pledge to associate." }, { status: 422 });
    const result = await attributeGivingActivityToTrip(profile.id, id, prospectId, body.givingActivityId, body.note?.trim().slice(0, 2000) || null, now);
    if (!result.ok) return attributionErrorResponse(result.reason);
    logger.info("trip_financial_attribution_associated", { userId: profile.id, tripId: id, prospectId, givingActivityId: body.givingActivityId });
    return Response.json({ ok: true, attributionId: result.attributionId }, { status: 201 });
  }

  if (body.action === "record_donation" || body.action === "record_pledge") {
    const recordFn = body.action === "record_donation" ? recordPendingGiftAndAttribute : recordPendingPledgeAndAttribute;
    const result = await recordFn(profile.id, id, prospectId, { amount: body.amount, date: body.date, designation: body.designation, note: body.note }, now);
    if (!result.ok) {
      if (result.reason === "prospect_not_found") return Response.json({ error: "Prospect not found" }, { status: 404 });
      if (result.reason === "input_invalid") return Response.json({ error: result.error }, { status: 422 });
      // recorded_but_not_attributed -- the financial record IS real; it
      // just didn't link automatically. Never reported as a bare
      // failure -- the fundraiser can finish the link via "associate
      // existing," which will already offer it.
      return Response.json({ ok: false, activityId: result.activityId, error: "Recorded, but it could not be automatically linked to this trip. Use \"Associate an existing donation or pledge\" to finish linking it." }, { status: 207 });
    }
    logger.info("trip_financial_attribution_recorded", { userId: profile.id, tripId: id, prospectId, action: body.action, activityId: result.activityId });
    return Response.json({ ok: true, activityId: result.activityId, attributionId: result.attributionId }, { status: 201 });
  }

  return Response.json({ error: "Choose a valid action." }, { status: 422 });
}

function attributionErrorResponse(reason: "prospect_not_found" | "giving_activity_not_found" | "already_attributed") {
  if (reason === "prospect_not_found") return Response.json({ error: "Prospect not found" }, { status: 404 });
  if (reason === "giving_activity_not_found") return Response.json({ error: "Choose a donation or pledge that belongs to this donor." }, { status: 422 });
  return Response.json({ error: "This donation or pledge is already attributed to a trip. Remove the existing attribution first." }, { status: 409 });
}
