import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import {
  getTrip, listTripProspects, listEligibleGivingActivitiesForDonor, listReconcilableTripAttributions, attributeGivingActivityToTrip,
  recordPendingGiftAndAttribute, recordPendingPledgeAndAttribute, recordUnlinkedProspectCommitment, type AttributeResult,
} from "../../../../../../../lib/relationships/trips-data";
import { isValidCommitmentKind, validateReportedCashCollectedCents } from "../../../../../../../lib/relationships/trip-model";
import { logger } from "../../../../../../../lib/logger";

// Trip Fundraising Results Dashboard (Section 3, see docs/AI-HANDOFF.md).
// GET: the donor's own eligible (unattributed) giving_activities rows,
// for the "associate an existing donation/pledge" picker, plus every
// still-pending (not-yet-JL) trip entry for this donor on this trip that
// a newly attributed real record could reconcile (2026-10-20 donor-
// confirmation correction) -- so the UI can offer that explicit choice
// up front, before the fundraiser even picks a record to associate.
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

  // An unlinked (not-yet-in-FOS) prospect has no donor to read an
  // eligible/reconcilable giving_activities list for -- "Associate an
  // existing donation or pledge" is not applicable to it at all, since
  // there is no existing donor record for anything to already exist
  // against. Reported as empty, never an error -- the UI already hides
  // that action for an unlinked prospect, but this guards the endpoint
  // itself the same way, independent of the UI.
  if (!prospect.donorId) return Response.json({ eligible: [], reconcilable: [] });

  const eligible = await listEligibleGivingActivitiesForDonor(profile.id, prospect.donorId);
  const reconcilable = await listReconcilableTripAttributions(profile.id, id, prospect.donorId);
  return Response.json({ eligible, reconcilable });
}

type AttributionRequestBody = {
  action?: "associate_existing" | "record_donation" | "record_pledge";
  givingActivityId?: string;
  note?: string;
  amount?: number | string;
  date?: string;
  designation?: string;
  confirmed?: boolean;
  commitmentKind?: string;
  reportedCashCollected?: number | string;
  reconcilesAttributionId?: string;
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

  // Unlinked-Prospect Fundraising (2026-10-25, see docs/AI-HANDOFF.md):
  // "record trip pledges and donations using the existing trip
  // fundraising workflow" for a prospect with no FOS donor yet --
  // same action names, same request shape, routed to the separate
  // trip_prospect_commitments-backed path instead of a real
  // giving_activities row. "Associate an existing donation or pledge"
  // has no meaning here (there is no donor for anything to already
  // exist against), so it is rejected outright rather than silently
  // matching nothing.
  const prospects = await listTripProspects(profile.id, id);
  const prospect = prospects.find((item) => item.id === prospectId);
  if (!prospect) return Response.json({ error: "Prospect not found" }, { status: 404 });

  if (!prospect.donorId) {
    if (body.action === "associate_existing") return Response.json({ error: "This prospect is not yet linked to a donor account, so there is nothing existing to associate. Link or convert this prospect to a donor first." }, { status: 422 });
    if (body.action === "record_donation" || body.action === "record_pledge") {
      const category = body.action === "record_donation" ? "pending_gift" : "pending_pledge";
      const result = await recordUnlinkedProspectCommitment(profile.id, id, prospectId, category, { amount: body.amount, date: body.date, designation: body.designation, note: body.note, confirmed: body.confirmed === true }, now);
      if (!result.ok) {
        if (result.reason === "prospect_not_found") return Response.json({ error: "Prospect not found" }, { status: 404 });
        return Response.json({ error: result.error }, { status: 422 });
      }
      logger.info("trip_unlinked_prospect_commitment_recorded", { userId: profile.id, tripId: id, prospectId, action: body.action, commitmentId: result.commitmentId, confirmed: body.confirmed === true });
      return Response.json({ ok: true, attributionId: result.commitmentId }, { status: 201 });
    }
    return Response.json({ error: "Choose a valid action." }, { status: 422 });
  }

  if (body.action === "associate_existing") {
    if (typeof body.givingActivityId !== "string" || !body.givingActivityId) return Response.json({ error: "Choose a donation or pledge to associate." }, { status: 422 });
    if (body.commitmentKind !== undefined && !isValidCommitmentKind(body.commitmentKind)) return Response.json({ error: "Choose whether this was secured on this trip or is a pre-existing pledge." }, { status: 422 });
    const commitmentKind = isValidCommitmentKind(body.commitmentKind) ? body.commitmentKind : undefined;
    const reportedCash = validateReportedCashCollectedCents(body.reportedCashCollected);
    if (!reportedCash.ok) return Response.json({ error: "Enter a valid reported cash amount." }, { status: 422 });
    const result = await attributeGivingActivityToTrip(profile.id, id, prospectId, body.givingActivityId, body.note?.trim().slice(0, 2000) || null, now, {
      commitmentKind,
      reportedCashCollectedCents: reportedCash.cents,
      reconcilesAttributionId: body.reconcilesAttributionId,
    });
    if (!result.ok) return attributionErrorResponse(result);
    logger.info("trip_financial_attribution_associated", { userId: profile.id, tripId: id, prospectId, givingActivityId: body.givingActivityId, commitmentKind: commitmentKind ?? "new_commitment" });
    return Response.json({ ok: true, attributionId: result.attributionId }, { status: 201 });
  }

  if (body.action === "record_donation" || body.action === "record_pledge") {
    const recordFn = body.action === "record_donation" ? recordPendingGiftAndAttribute : recordPendingPledgeAndAttribute;
    const result = await recordFn(profile.id, id, prospectId, { amount: body.amount, date: body.date, designation: body.designation, note: body.note, confirmed: body.confirmed === true }, now);
    if (!result.ok) {
      if (result.reason === "prospect_not_found") return Response.json({ error: "Prospect not found" }, { status: 404 });
      if (result.reason === "input_invalid") return Response.json({ error: result.error }, { status: 422 });
      // recorded_but_not_attributed -- the financial record IS real; it
      // just didn't link automatically. Never reported as a bare
      // failure -- the fundraiser can finish the link via "associate
      // existing," which will already offer it.
      return Response.json({ ok: false, activityId: result.activityId, error: "Recorded, but it could not be automatically linked to this trip. Use \"Associate an existing donation or pledge\" to finish linking it." }, { status: 207 });
    }
    logger.info("trip_financial_attribution_recorded", { userId: profile.id, tripId: id, prospectId, action: body.action, activityId: result.activityId, confirmed: body.confirmed === true });
    return Response.json({ ok: true, activityId: result.activityId, attributionId: result.attributionId }, { status: 201 });
  }

  return Response.json({ error: "Choose a valid action." }, { status: 422 });
}

type AssociateFailure = Exclude<AttributeResult, { ok: true }>;

function attributionErrorResponse(result: AssociateFailure) {
  // Checked first, and on its own, so this single-literal reason narrows
  // cleanly to the one variant that carries `candidates` -- NOT
  // automatically matched solely by donor and amount: the fundraiser
  // must explicitly say whether this new, real record reconciles one of
  // these pending entries, or is a separate, additional commitment.
  if (result.reason === "reconciliation_choice_required") {
    return Response.json({
      error: "This donor has an existing, not-yet-confirmed trip entry. Choose whether this record reconciles it, or is a separate, additional commitment.",
      reconciliationChoiceRequired: true,
      candidates: result.candidates,
    }, { status: 409 });
  }
  if (result.reason === "prospect_not_found") return Response.json({ error: "Prospect not found" }, { status: 404 });
  if (result.reason === "giving_activity_not_found") return Response.json({ error: "Choose a donation or pledge that belongs to this donor." }, { status: 422 });
  if (result.reason === "already_attributed") return Response.json({ error: "This donation or pledge is already attributed to a trip. Remove the existing attribution first." }, { status: 409 });
  if (result.reason === "invalid_commitment_kind") return Response.json({ error: "A donation or pledge that has not yet been imported from JL cannot be a pre-existing pledge collection -- choose \"secured on this trip\" instead, or wait until the real JL record is imported." }, { status: 422 });
  // "reconciliation_target_not_found"
  return Response.json({ error: "The pending entry you chose to reconcile no longer matches. Refresh and try again." }, { status: 409 });
}
