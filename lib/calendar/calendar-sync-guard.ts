// Issue 4 ("verify the authorized account/calendar through Google rather
// than a manually entered label; refuse Production sync if it does not
// match sgoldstein@nirc.edu's primary calendar") and Issue 6 ("require an
// explicit test-calendar ID and reject primary/the Production destination
// even when the Staging opt-in is enabled"). Pure decision function --
// the actual live Google identity check (resolving `verifiedEmail`) and
// the actual `calendar_sync_enabled` read happen one layer up; this
// module only decides, given those already-resolved facts, whether a
// sync attempt may proceed. Mirrors `lib/agenda/email-send-guard.ts`'s
// own call-site-enforced, config-independent allowlist shape.

export const PRODUCTION_OWNER_EMAIL = "sgoldstein@nirc.edu";
export const PRIMARY_CALENDAR_ID = "primary";

export type CalendarSyncGuardInput = {
  environment: string; // deploymentEnvironment, e.g. "production-independent" | "staging-independent"
  calendarSyncEnabled: boolean; // the persisted, real disconnect flag (users.calendar_sync_enabled)
  credentialsPresent: boolean; // the three GOOGLE_CALENDAR_OAUTH_* secrets are configured
  verifiedEmail: string | null; // resolved live via Google's userinfo endpoint; null if not yet verified/unavailable
  calendarId: string; // the configured destination, e.g. "primary" or a Staging test calendar id
  stagingTestCalendarId: string | null; // CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID, if set
};

export type CalendarSyncGuardResult = { allowed: true } | { allowed: false; reason: string };

export function isCalendarSyncAllowed(input: CalendarSyncGuardInput): CalendarSyncGuardResult {
  if (!input.calendarSyncEnabled) return { allowed: false, reason: "calendar sync is disconnected (calendar_sync_enabled=false)" };
  if (!input.credentialsPresent) return { allowed: false, reason: "no Google Calendar OAuth credentials are configured" };
  if (!input.verifiedEmail) return { allowed: false, reason: "the authorized Google account could not be verified" };

  if (input.environment === "production-independent") {
    if (input.verifiedEmail !== PRODUCTION_OWNER_EMAIL) return { allowed: false, reason: `Production sync refused: authorized account "${input.verifiedEmail}" is not ${PRODUCTION_OWNER_EMAIL}` };
    if (input.calendarId !== PRIMARY_CALENDAR_ID) return { allowed: false, reason: `Production sync refused: destination calendar "${input.calendarId}" is not the owner's primary calendar` };
    return { allowed: true };
  }

  if (input.environment === "staging-independent") {
    if (!input.stagingTestCalendarId) return { allowed: false, reason: "Staging sync refused: no explicit test calendar is configured" };
    if (input.calendarId === PRIMARY_CALENDAR_ID) return { allowed: false, reason: "Staging sync refused: destination calendar must never be \"primary\"" };
    if (input.calendarId !== input.stagingTestCalendarId) return { allowed: false, reason: `Staging sync refused: destination calendar "${input.calendarId}" does not match the configured test calendar` };
    // Belt-and-braces: even if Production's credentials were accidentally
    // copied onto Staging, refuse outright rather than trusting the
    // calendar id check alone.
    if (input.verifiedEmail === PRODUCTION_OWNER_EMAIL) return { allowed: false, reason: "Staging sync refused: the authorized account is the real Production owner's account" };
    return { allowed: true };
  }

  return { allowed: false, reason: `calendar sync refused: unrecognized environment "${input.environment}"` };
}
