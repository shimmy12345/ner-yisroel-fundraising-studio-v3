import { getChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { getCalendarConnectionStatusForUser, setCalendarSyncEnabledForUser } from "../../../lib/relationships/trips-data";
import { logger } from "../../../lib/logger";

// Settings' Google Calendar section (Minimal controls, 2026-10-19 --
// "verified connected account, enable/disable, and clear one-way-sync
// disclosure"). GET re-checks the live connection status on every load
// (design doc S5.3: "not a value the owner typed in once") -- cheap, and
// makes no Google call at all unless credentials are actually configured
// (true on no environment as of this round, so this currently always
// reports credentialsConfigured:false immediately).
export async function GET() {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  try {
    const status = await getCalendarConnectionStatusForUser(profile.id);
    return Response.json(status);
  } catch (error) {
    logger.error("calendar_sync_status_failed", error, { userId: profile.id });
    return Response.json({ error: "Could not load Google Calendar sync status" }, { status: 500 });
  }
}

type PatchBody = { enabled?: boolean };

// "Disconnect" is this same toggle, flipped off -- the real, enforced
// stop (users.calendar_sync_enabled, checked at every call site that
// could reach Google), not merely a display change. Flippable even when
// no credentials are configured yet, matching the persisted flag's own
// documented independence from whether credentials exist.
export async function PATCH(request: Request) {
  const identity = await getChatGPTUser();
  if (!identity) return Response.json({ error: "Authentication required" }, { status: 401 });
  const profile = await ensureUserProfile(identity);
  const body = await request.json().catch(() => null) as PatchBody | null;
  if (!body || typeof body.enabled !== "boolean") return Response.json({ error: "Choose whether Google Calendar sync should be enabled" }, { status: 422 });

  const now = Math.floor(Date.now() / 1000);
  try {
    await setCalendarSyncEnabledForUser(profile.id, body.enabled, now);
    logger.info("calendar_sync_enabled_changed", { userId: profile.id, enabled: body.enabled });
    const status = await getCalendarConnectionStatusForUser(profile.id);
    return Response.json(status);
  } catch (error) {
    logger.error("calendar_sync_enable_failed", error, { userId: profile.id });
    return Response.json({ error: "Could not update Google Calendar sync" }, { status: 500 });
  }
}
