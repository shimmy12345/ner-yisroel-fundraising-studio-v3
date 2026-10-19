import { getChatGPTUser } from "../../../../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../../../../lib/auth/profile";
import { retryTripMeetingCalendarSync, tripMeetingCalendarStatus } from "../../../../../../../lib/relationships/trips-data";
import { logger } from "../../../../../../../lib/logger";

// Minimal controls (2026-10-19, see docs/AI-HANDOFF.md): "Trip row: ...
// safe Retry". Safe because this only ever re-attempts reconciling the
// ALREADY-recorded intent for this one owner-scoped meeting -- it can
// never create a new calendar link, change what the meeting itself says,
// or bypass the isCalendarSyncAllowed() guard every attempt already goes
// through. A no-op (not an error) when sync is disabled or no
// credentials are configured, same as every other sync attempt this
// round -- the response's own status still tells the caller why.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string; prospectId: string }> }) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(user);
  const { id, prospectId } = await params;

  const now = Math.floor(Date.now() / 1000);
  try {
    const found = await retryTripMeetingCalendarSync(profile.id, id, prospectId, now);
    if (!found) return Response.json({ error: "This prospect has no scheduled meeting to retry" }, { status: 404 });
    const status = await tripMeetingCalendarStatus(profile.id, id, prospectId);
    logger.info("trip_calendar_retry_attempted", { userId: profile.id, tripId: id, prospectId, syncStatus: status?.syncStatus ?? null });
    return Response.json({ calendarSync: status });
  } catch (error) {
    logger.error("trip_calendar_retry_failed", error, { userId: profile.id, tripId: id, prospectId });
    return Response.json({ error: "Could not retry the calendar sync for this meeting" }, { status: 500 });
  }
}
