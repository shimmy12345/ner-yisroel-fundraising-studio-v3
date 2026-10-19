// Google Calendar sync wiring for Trip Planning -- the narrowed first
// release (2026-10-19, see docs/AI-HANDOFF.md and
// docs/GOOGLE-CALENDAR-INTEGRATION-DESIGN.md). Capture/donor scheduling,
// all-day meetings, group meetings, and existing-meeting backfill are all
// explicitly deferred; this file only ever wires a CONFIRMED, TIMED Trip
// Planning meeting to lib/calendar/'s already-proven, unmodified core.
//
// Deliberately takes `db`/credentials/environment as explicit parameters,
// never importing "cloudflare:workers" itself -- the exact same
// testability reasoning google-calendar-client.ts's own header already
// states ("so it can be fully unit-tested in plain Node with a mocked
// transport"). lib/relationships/trips-data.ts (which already imports
// "cloudflare:workers" for every other D1 access this feature makes) is
// the one place that reads real env values and forwards them in -- this
// module is the testable, env-agnostic half of that split, matching this
// codebase's own established pure/impure sibling-file convention.
//
// Isolation (required by this round's own instruction): nothing here
// imports from lib/agenda/ (the Gmail agenda-email path) or is imported
// by it, in either direction -- the same invariant
// tests/calendar-sweep-agenda-independence.test.mjs already proves for
// lib/calendar/ itself.
//
// Atomicity (honest limitation, reported, not hidden): D1 has no cross-
// statement transaction (d1-calendar-store.ts's own header), and the
// calendar link's own atomic primitives (insertLinkWithHistory/
// applyReschedule/applyCancel/applyReopen) are each their own separate
// db.batch() call, already internally atomic. Merging them into trips-
// data.ts's own interactions/trip_prospects batch would require changing
// CalendarLinkStore's frozen interface, which this round's "do not
// rebuild or expand the architecture" instruction rules out. What is
// actually guaranteed instead: the meeting change commits FIRST (its own
// complete, already-proven batch, completely unchanged); the calendar-
// intent write happens immediately after, with no intervening awaited
// work; and (enforced at every call site in trips-data.ts, not in this
// file) a calendar-intent write failure is caught and logged, never
// surfaced as a failure of the meeting-change request itself. The one gap
// this leaves -- a crash between the two writes -- means a meeting could
// be saved with no calendar link ever created for it; no cron exists yet
// to retry that case, and an explicit Retry cannot help either, since no
// link row would exist to retry. Documented in docs/AI-HANDOFF.md, not
// hidden.

import { D1CalendarStore } from "../calendar/d1-calendar-store.ts";
import {
  createGoogleCalendarClient, realHttpTransport, resolveVerifiedGoogleAccountEmail,
  type CalendarOAuthCredentials, type HttpTransport,
} from "../calendar/google-calendar-client.ts";
import { isCalendarSyncAllowed } from "../calendar/calendar-sync-guard.ts";
import { enrollMeetingForSync, recordReschedule, recordCancel, recordReopen, runReconciliationSweep, type SweepResult } from "../calendar/calendar-sync-reconciler.ts";
import type { CalendarLinkRow, GoogleCalendarClient, MeetingDesiredFields } from "../calendar/calendar-sync-types.ts";
import { timezoneForState } from "./trip-model.ts";

const DEFAULT_FALLBACK_TIMEZONE = "America/New_York";

// Re-reads the current `interactions` row fresh -- never a value captured
// at scheduling time -- matching every other getMeetingFields() the core
// already requires (see calendar-sync-reconciler.ts's own header: "always
// re-read the current intent fresh at the moment they build a payload").
// Timezone is recomputed the same way trips-data.ts's own
// resolveMeetingEpoch() derives it at scheduling time (donor's own state,
// falling back to the owner's profile timezone) rather than stored on
// `interactions` itself -- no new column, and it can never go stale
// relative to the donor's own record.
export async function loadTripMeetingFields(db: D1Database, interactionId: string, fosBaseUrl: string): Promise<MeetingDesiredFields | null> {
  const row = await db.prepare(`SELECT i.id, i.occurred_at, i.end_at, i.location, i.all_day, i.all_day_date, i.user_id, d.id AS donor_id, d.display_name AS donor_display_name, d.state AS donor_state
      FROM interactions i JOIN donors d ON d.id = i.donor_id WHERE i.id = ?`).bind(interactionId)
    .first<{ id: string; occurred_at: number; end_at: number | null; location: string | null; all_day: number; all_day_date: string | null; user_id: string; donor_id: string; donor_display_name: string; donor_state: string | null }>();
  if (!row) return null;
  const owner = await db.prepare("SELECT timezone FROM users WHERE id = ?").bind(row.user_id).first<{ timezone: string | null }>();
  const allDay = Boolean(row.all_day);
  return {
    interactionId: row.id,
    donorDisplayName: row.donor_display_name,
    allDay,
    allDayDate: row.all_day_date,
    occurredAt: allDay ? null : row.occurred_at,
    endAt: allDay ? null : row.end_at,
    timezone: allDay ? null : timezoneForState(row.donor_state, owner?.timezone ?? DEFAULT_FALLBACK_TIMEZONE),
    location: row.location,
    fosUrl: `${fosBaseUrl}/donors/${row.donor_id}/meeting-brief`,
  };
}

// --- Durable intent (never touches the network) --------------------------

// Dispatches to the correct one of the core's three recordXxx() entry
// points, exactly the choice a caller already has to make (see each
// function's own doc comment in calendar-sync-reconciler.ts): no link
// yet -> enroll; link exists but desiredState is 'absent' -> reopen
// (a prospect moved back to meeting_scheduled after being
// declined/unable_to_schedule, see trip-model.ts's own "allow status
// changes in either direction" comment); link exists and is 'present'
// -> an ordinary reschedule.
export async function recordTripMeetingScheduled(db: D1Database, interactionId: string, userId: string, googleCalendarId: string, now: number): Promise<void> {
  const store = new D1CalendarStore(db);
  const existingLink = await store.getLinkByInteraction(interactionId);
  if (!existingLink) { await enrollMeetingForSync(store, now, { interactionId, userId, googleCalendarId }); return; }
  if (existingLink.desiredState === "absent") { await recordReopen(store, now, interactionId); return; }
  await recordReschedule(store, now, interactionId);
}

// "Canceling removes only its linked FOS-created event" -- a pure
// pass-through to the core's own recordCancel, which is itself a no-op
// (never touches the network, never fails) if no link exists at all, so
// this is always safe to call even for a meeting that was never enrolled.
export async function recordTripMeetingCancelled(db: D1Database, interactionId: string, now: number): Promise<void> {
  const store = new D1CalendarStore(db);
  await recordCancel(store, now, interactionId);
}

// --- Enable/disable (Settings' persisted, enforced disconnect flag) ------

export async function isCalendarSyncEnabledForUser(db: D1Database, userId: string): Promise<boolean> {
  const row = await db.prepare("SELECT calendar_sync_enabled FROM users WHERE id = ?").bind(userId).first<{ calendar_sync_enabled: number }>();
  return row?.calendar_sync_enabled === 1;
}

export async function setCalendarSyncEnabledForUser(db: D1Database, userId: string, enabled: boolean, now: number): Promise<void> {
  await db.prepare("UPDATE users SET calendar_sync_enabled = ?, updated_at = ? WHERE id = ?").bind(enabled ? 1 : 0, now, userId).run();
}

// --- Best-effort immediate reconcile (no cron wired this round) ----------

export type ImmediateSyncArgs = {
  db: D1Database;
  userId: string;
  environment: string;
  calendarSyncEnabled: boolean;
  credentials: CalendarOAuthCredentials | null;
  calendarId: string;
  stagingTestCalendarId: string | null;
  fosBaseUrl: string;
  now: number;
  transport?: HttpTransport;
  // Test-only seam: when provided, used for every actual get/insert/
  // update/delete instead of the real createGoogleCalendarClient(credentials,
  // transport) -- lets a test exercise this function against
  // StatefulCalendarClient (lib/calendar/testing/stateful-calendar-client.ts,
  // real create/409/412/404 semantics across a full schedule/reschedule/
  // cancel cycle) while `transport` still supplies just the identity
  // (userinfo) check's own scripted response. Never set by any real
  // caller -- trips-data.ts's own wiring never passes this.
  client?: GoogleCalendarClient;
};

// Attempts to actually reach Google for every link needing attention
// (reusing the core's own runReconciliationSweep unmodified, never a
// per-interaction reimplementation of its dispatch logic) -- gated by the
// EXACT SAME isCalendarSyncAllowed() guard every round of this feature's
// design has required, checked here, not only in a UI display. Returns
// null (no attempt made at all, not even a Google identity check) when
// sync is disabled or no credentials are configured -- true on every
// environment as of this round, which is exactly "preserve existing
// scheduling when Calendar is disabled or unavailable": the meeting
// itself was already saved by the caller before this ever runs, and this
// function cannot affect that outcome either way.
export async function attemptImmediateTripCalendarSync(args: ImmediateSyncArgs): Promise<SweepResult | null> {
  if (!args.calendarSyncEnabled || !args.credentials) return null;
  const transport = args.transport ?? realHttpTransport;
  const client = args.client ?? createGoogleCalendarClient(args.credentials, transport);
  const verifiedEmail = await resolveVerifiedGoogleAccountEmail(args.credentials, transport);
  const guard = isCalendarSyncAllowed({
    environment: args.environment, calendarSyncEnabled: args.calendarSyncEnabled, credentialsPresent: true,
    verifiedEmail, calendarId: args.calendarId, stagingTestCalendarId: args.stagingTestCalendarId,
  });
  if (!guard.allowed) return null;
  const store = new D1CalendarStore(args.db);
  return runReconciliationSweep(store, client, (interactionId) => loadTripMeetingFields(args.db, interactionId, args.fosBaseUrl), `trip:${args.userId}`, args.now);
}

// --- Read-only status, for the Trip row and Settings ----------------------

export async function getTripMeetingCalendarLink(db: D1Database, interactionId: string): Promise<CalendarLinkRow | null> {
  return new D1CalendarStore(db).getLinkByInteraction(interactionId);
}

export type CalendarConnectionStatus = {
  enabled: boolean;
  credentialsConfigured: boolean;
  verifiedEmail: string | null;
  calendarId: string;
  allowed: boolean;
  reason: string | null;
};

// Settings' "live-verified connection status" (design doc S5.3: "re-
// checked each page load, cheap read, not a value the owner typed in
// once"). Makes a real Google identity check only when credentials are
// actually configured -- true on no environment as of this round, so this
// currently always reports credentialsConfigured:false without ever
// attempting a network call, exactly the "no credential installed, never
// attempt a call" rule calendar-sync-guard.ts's own header already states.
export async function loadCalendarConnectionStatus(args: {
  db: D1Database; userId: string; environment: string; credentials: CalendarOAuthCredentials | null;
  calendarId: string; stagingTestCalendarId: string | null; transport?: HttpTransport;
}): Promise<CalendarConnectionStatus> {
  const enabled = await isCalendarSyncEnabledForUser(args.db, args.userId);
  if (!args.credentials) return { enabled, credentialsConfigured: false, verifiedEmail: null, calendarId: args.calendarId, allowed: false, reason: "no Google Calendar OAuth credentials are configured" };
  const transport = args.transport ?? realHttpTransport;
  const verifiedEmail = await resolveVerifiedGoogleAccountEmail(args.credentials, transport);
  const guard = isCalendarSyncAllowed({ environment: args.environment, calendarSyncEnabled: enabled, credentialsPresent: true, verifiedEmail, calendarId: args.calendarId, stagingTestCalendarId: args.stagingTestCalendarId });
  return { enabled, credentialsConfigured: true, verifiedEmail, calendarId: args.calendarId, allowed: guard.allowed, reason: guard.allowed ? null : guard.reason };
}

// "View on Google Calendar" link (design doc S2: "a View on Google
// Calendar link appears once synced"). Mirrors the permalink format
// Google's own Calendar UI produces for "Event URL" (base64 of
// "<eventId> <calendarId>") -- unverified against a real live event
// (honestly flagged, same discipline as every other live-Google claim in
// this feature): if the exact encoding Google expects differs, the
// practical failure mode is the link not opening the right event, never a
// data-safety issue, and it is confirmed/corrected during Staging's live
// verification pass, not assumed correct here.
export function googleCalendarEventViewUrl(googleEventId: string, googleCalendarId: string): string {
  const eid = btoa(`${googleEventId} ${googleCalendarId}`).replace(/=+$/, "");
  return `https://calendar.google.com/calendar/event?eid=${eid}`;
}
