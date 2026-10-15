import { getChatGPTUser } from "../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../lib/auth/profile";
import { getTrip, removeProspect, setSimpleProspectStatus, scheduleProspectMeeting, completeProspectMeeting, updateProspectFields } from "../../../../../../lib/relationships/trips-data";
import { isValidProspectStatus, statusRequiresInteraction, validateMeetingScheduling, validateMeetingCompletion, validateMeetingLocation, validateNextAction, validateNotes } from "../../../../../../lib/relationships/trip-model";
import { logger } from "../../../../../../lib/logger";

// Trip-specific status/notes/meeting tracking (Section D). The two
// statuses that touch a real `interactions` row (meeting_scheduled,
// meeting_completed) each require their own explicit confirmation flag
// in the request body -- "Scheduling a meeting may create a real
// scheduled interaction ... but only after explicit user confirmation"
// / "Marking a meeting Completed must require explicit confirmation" --
// checked here, before lib/relationships/trips-data.ts's own functions
// (which also refuse without it, so this is deliberately defense in
// depth, not the only gate).
type UpdateProspectBody = {
  status?: string;
  meetingAt?: number;
  meetingLocation?: string | null;
  completionNotes?: string;
  confirmScheduling?: boolean;
  confirmCompletion?: boolean;
  tripNotes?: string | null;
  nextAction?: string | null;
  manualRank?: number | null;
};

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  const trip = await getTrip(profile.id, id);
  if (!trip) return Response.json({ error: "Trip not found" }, { status: 404 });

  let body: UpdateProspectBody;
  try { body = await request.json() as UpdateProspectBody; }
  catch { return Response.json({ error: "Invalid request" }, { status: 400 }); }

  const now = Math.floor(Date.now() / 1000);

  if (body.status !== undefined) {
    if (!isValidProspectStatus(body.status)) return Response.json({ error: "Choose a valid prospect status" }, { status: 422 });

    if (body.status === "meeting_scheduled") {
      const meetingResult = validateMeetingScheduling(body.meetingAt, now);
      if (!meetingResult.ok) return Response.json({ error: "Choose a future meeting date and time" }, { status: 422 });
      const locationResult = validateMeetingLocation(body.meetingLocation);
      if (!locationResult.ok) return Response.json({ error: "Meeting location is too long" }, { status: 422 });
      if (body.confirmScheduling !== true) return Response.json({ error: "Confirm the meeting time before scheduling it" }, { status: 422 });
      const result = await scheduleProspectMeeting(profile.id, id, prospectId, meetingResult.meetingAt, locationResult.location, true, now);
      if (!result.ok) return statusErrorResponse(result.reason);
      logger.info("trip_prospect_meeting_scheduled", { userId: profile.id, tripId: id, prospectId });
    } else if (body.status === "meeting_completed") {
      const completionResult = validateMeetingCompletion(body.meetingAt, body.completionNotes, now);
      if (!completionResult.ok) return Response.json({ error: "Record an actual meeting date and meaningful notes before marking this meeting completed" }, { status: 422 });
      if (body.confirmCompletion !== true) return Response.json({ error: "Confirm the meeting outcome before marking it completed" }, { status: 422 });
      const result = await completeProspectMeeting(profile.id, id, prospectId, completionResult.meetingAt, completionResult.notes, true, now);
      if (!result.ok) return statusErrorResponse(result.reason);
      logger.info("trip_prospect_meeting_completed", { userId: profile.id, tripId: id, prospectId });
    } else {
      // not_contacted/contacted/meeting_requested/declined/
      // unable_to_schedule -- never touches `interactions` (see
      // setSimpleProspectStatus's own doc comment). statusRequiresInteraction()
      // is asserted false here purely as a belt-and-suspenders guard against
      // a future status being added to TRIP_PROSPECT_STATUSES without also
      // updating this branch.
      if (statusRequiresInteraction(body.status)) return Response.json({ error: "This status requires its own confirmation step" }, { status: 422 });
      const result = await setSimpleProspectStatus(profile.id, id, prospectId, body.status, now);
      if (!result.ok) return statusErrorResponse(result.reason);
      logger.info("trip_prospect_status_changed", { userId: profile.id, tripId: id, prospectId, status: body.status });
    }
  }

  const fieldUpdate: Parameters<typeof updateProspectFields>[3] = {};
  if (body.tripNotes !== undefined) {
    const result = validateNotes(body.tripNotes);
    if (!result.ok) return Response.json({ error: "Trip notes are too long" }, { status: 422 });
    fieldUpdate.tripNotes = result.notes;
  }
  if (body.nextAction !== undefined) {
    const result = validateNextAction(body.nextAction);
    if (!result.ok) return Response.json({ error: "Next action is too long" }, { status: 422 });
    fieldUpdate.nextAction = result.nextAction;
  }
  if (body.manualRank !== undefined) {
    if (body.manualRank !== null && (typeof body.manualRank !== "number" || !Number.isInteger(body.manualRank))) return Response.json({ error: "Priority override must be a whole number, or cleared" }, { status: 422 });
    fieldUpdate.manualRank = body.manualRank;
  }
  if (Object.keys(fieldUpdate).length > 0) {
    const updated = await updateProspectFields(profile.id, id, prospectId, fieldUpdate, now);
    if (!updated) return Response.json({ error: "Prospect not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}

function statusErrorResponse(reason: "not_found" | "conflict" | "confirmation_required") {
  if (reason === "not_found") return Response.json({ error: "Prospect not found" }, { status: 404 });
  if (reason === "confirmation_required") return Response.json({ error: "Confirmation is required for this change" }, { status: 422 });
  return Response.json({ error: "This prospect was updated elsewhere. Refresh and try again." }, { status: 409 });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  const removed = await removeProspect(profile.id, id, prospectId);
  if (!removed) return Response.json({ error: "Prospect not found" }, { status: 404 });
  logger.info("trip_prospect_removed", { userId: profile.id, tripId: id, prospectId });
  return Response.json({ ok: true });
}
