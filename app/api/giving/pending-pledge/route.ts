import { getChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { insertPendingPledge } from "../../../../lib/giving/pending-records";
import { logger } from "../../../../lib/logger";

// The pending_pledge counterpart to app/api/giving/pending/route.ts --
// same shape, same safeguards (active-donor check, no partial writes on
// failure), category='pending_pledge' instead of 'pending_gift'. The
// actual insert lives in lib/giving/pending-records.ts's insertPendingPledge
// so the Trip Fundraising Results Dashboard's "record a new pledge"
// action reuses this exact same code path. See lib/giving/management.ts's
// own doc comment on COUNTED_GIVING_SQL for why this is deliberately NOT
// wired into the import route's auto-confirm reconciliation the way
// pending_gift is.
export async function POST(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null);
  const result = await insertPendingPledge(profile.id, body);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.error.includes("could not be recorded") ? 500 : 422 });
  logger.info("pending_pledge_recorded", { activityId: result.activityId, userId: profile.id });
  return Response.json({ activityId: result.activityId, message: "Pending pledge recorded as unconfirmed." }, { status: 201 });
}
