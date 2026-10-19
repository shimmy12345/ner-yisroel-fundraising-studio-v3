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
// Atomicity (2026-10-19, second follow-up review -- supersedes this
// file's own earlier, now-incorrect "guard mismatch is never a failure"
// claim, and the round before that's own "meeting change commits first,
// calendar intent happens after" design): the meeting change and the
// durable calendar intent commit in the SAME db.batch() call, but a
// guarded calendar statement matching zero rows (its precondition went
// stale between the caller's read and the batch actually running --
// e.g. a competing cancellation landed first) does NOT, by itself, stop
// an UNGUARDED meeting-side statement in the SAME batch from committing
// anyway -- independently reproduced: scheduleProspectMeeting's own
// trip_prospects/interactions writes used to have no precondition tied
// to the calendar read at all, so they always committed regardless, even
// when the calendar statement's own guard failed, leaving FOS saying
// "meeting scheduled" while the calendar intent stayed "absent."
//
// Fixed by making the decision ITSELF exportable as a reusable
// cross-table guard (planTripMeetingScheduledIntent/`guard` below, and
// buildTripMeetingCancelledStatements'/applyCancelStatements' own
// `guard` parameter) -- the SAME boolean SQL fragment the calendar
// statement's own WHERE clause encodes, re-verified fresh at EXECUTION
// time, that the caller (trips-data.ts) ALSO ANDs into its own meeting-
// side statements' WHERE clauses. This makes the whole combined batch a
// true all-or-nothing unit: either every statement's shared precondition
// still holds and everything commits together, or it does not and
// NOTHING commits (every statement -- calendar and meeting alike --
// independently matches zero rows). Scheduling's own intent remains
// valid regardless of the calendar's prior state (it is always correct
// to retry "make this meeting scheduled at this time" against a fresh
// read), so trips-data.ts retries the whole transition, bounded, on a
// guard mismatch; cancellation's own intent is conditional (it is only
// ever correct to decline a meeting that really is still scheduled), so
// a guard mismatch there is reported as a conflict, not retried.

import { randomUUID } from "node:crypto";
import { D1CalendarStore, isUniqueConstraintViolation, type D1CrossTableGuard } from "../calendar/d1-calendar-store.ts";
import {
  createGoogleCalendarClient, realHttpTransport, resolveVerifiedGoogleAccountEmail,
  type CalendarOAuthCredentials, type HttpTransport,
} from "../calendar/google-calendar-client.ts";
import { isCalendarSyncAllowed } from "../calendar/calendar-sync-guard.ts";
import {
  DEFAULT_LEASE_TTL_SECONDS, enrollMeetingForSync, reconcilePresentAbsent, recordReschedule, recordCancel, recordReopen,
  runReconciliationSweep, type Clock, type ReconcileOutcome, type SweepResult,
} from "../calendar/calendar-sync-reconciler.ts";
import type { CalendarLinkRow, GoogleCalendarClient, MeetingDesiredFields } from "../calendar/calendar-sync-types.ts";
import { timezoneForState } from "./trip-model.ts";

// Re-exported so trips-data.ts (which never imports lib/calendar/
// directly, only through this file's own testable/env-agnostic layer)
// can recognize "a concurrent enroll won the race" inside its own
// calendar-intent retry loop without a second copy of the regex.
export { isUniqueConstraintViolation };
export type { D1CrossTableGuard };

const DEFAULT_FALLBACK_TIMEZONE = "America/New_York";

// Lease protection (2026-10-19 review, follow-up): every production call
// into the reconciler must pass a REAL, advancing clock, read fresh at
// each expiry-sensitive check -- never the single frozen `now` number a
// caller captured once at the top of a request. Before this fix,
// attemptImmediateTripCalendarSync passed no `clock` at all, which meant
// runReconciliationSweep (and reconcilePresentAbsent/
// reconcileGenerationCleanup underneath it) defaulted to `() => now` --
// a clock that NEVER advances, so a lease's own genuine real-world
// expiry while this attempt was suspended on a network call could never
// be detected by this same attempt's own later checks (exactly the bug
// commit 1fffef2 fixed inside the core reconciler itself, but which
// remained live at this production call site because nothing here ever
// supplied the fix's own advancing clock). `realClock` is the one actual
// production clock this module uses; `ImmediateSyncArgs.clock` is a
// test-only override, mirroring the existing `transport`/`client` seams.
const realClock: Clock = () => Math.floor(Date.now() / 1000);

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

// --- Atomic persistence (2026-10-19 review, follow-up; corrected in the
// second follow-up review -- see this file's own header) -------------------
//
// "Commit the Trip meeting change and durable Calendar intent atomically
// using supported D1 operations." recordTripMeetingScheduled/
// recordTripMeetingCancelled above each execute their own db.batch() call
// immediately -- correct in isolation, but a SEPARATE D1 round trip from
// whatever wrote the meeting change itself (trips-data.ts's own
// interactions/trip_prospects batch), which is exactly the atomicity gap
// prior rounds of this feature reported rather than hid.
//
// `decideTripMeetingScheduledIntent` below makes the exact same dispatch
// decision recordTripMeetingScheduled already makes (no link yet ->
// enroll; link absent -> reopen; link present -> reschedule), using
// D1CalendarStore's own *Statements() builders -- never a second copy of
// that SQL -- and additionally returns a `guard`: a D1CrossTableGuard
// expressing "the calendar link's state is still exactly what this
// decision assumed," re-verified fresh at EXECUTION time. The two
// exported functions below are both thin views over this one decision:
// `buildTripMeetingScheduledStatements` (unchanged shape, for an existing
// caller that only needs the calendar's own statements) and
// `planTripMeetingScheduledIntent` (new: also returns `guard`, for a
// caller -- trips-data.ts -- that ANDs it into its OWN meeting-side
// statements too, so the whole combined batch succeeds or fails
// together; see this file's own header for exactly what this fixes).
type ScheduleIntentDecision = { statements: D1PreparedStatement[]; guard: D1CrossTableGuard };

async function decideTripMeetingScheduledIntent(db: D1Database, interactionId: string, userId: string, googleCalendarId: string, now: number): Promise<ScheduleIntentDecision> {
  const store = new D1CalendarStore(db);
  const existingLink = await store.getLinkByInteraction(interactionId);
  if (!existingLink) {
    return {
      statements: store.insertLinkWithHistoryStatements(
        {
          id: randomUUID(), interactionId, userId, googleCalendarId, generation: 0, googleEventId: null, googleEtag: null,
          desiredState: "present", desiredRevision: 1, syncedRevision: 0, syncStatus: "pending", lastError: null,
          attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, nextRetryAt: null,
        },
        now,
      ),
      guard: { sql: "NOT EXISTS (SELECT 1 FROM calendar_event_links WHERE interaction_id = ?)", params: [interactionId] },
    };
  }
  if (existingLink.desiredState === "absent") {
    return {
      statements: store.applyReopenStatements(existingLink.id, existingLink.interactionId, existingLink.generation, now),
      guard: { sql: "EXISTS (SELECT 1 FROM calendar_event_links WHERE interaction_id = ? AND desired_state = 'absent' AND generation = ?)", params: [interactionId, existingLink.generation] },
    };
  }
  return {
    statements: store.applyRescheduleStatements(existingLink.id, now),
    guard: { sql: "EXISTS (SELECT 1 FROM calendar_event_links WHERE interaction_id = ? AND desired_state = 'present')", params: [interactionId] },
  };
}

// Unchanged shape/behavior from every prior round -- used by the
// existing CI integration test, which exercises these statements
// directly against a stand-in meeting-change statement without needing
// the cross-table guard (see that test file's own atomic-persistence
// block).
export async function buildTripMeetingScheduledStatements(db: D1Database, interactionId: string, userId: string, googleCalendarId: string, now: number): Promise<D1PreparedStatement[]> {
  return (await decideTripMeetingScheduledIntent(db, interactionId, userId, googleCalendarId, now)).statements;
}

// Integration safety (2026-10-19, second follow-up review): the real fix
// for "conflicting meeting/Calendar transitions." Returns the calendar's
// own statements AND the reusable guard trips-data.ts ANDs into its own
// interactions/trip_prospects statements in the SAME combined batch --
// see this file's own header for exactly what this makes atomic and why
// a result-index check alone (this round's own earlier, insufficient
// attempt) cannot substitute for it.
export async function planTripMeetingScheduledIntent(db: D1Database, interactionId: string, userId: string, googleCalendarId: string, now: number): Promise<ScheduleIntentDecision> {
  return decideTripMeetingScheduledIntent(db, interactionId, userId, googleCalendarId, now);
}

// Same shape as buildTripMeetingScheduledStatements above, for the
// cancel path. Returns an empty array (not an error) when no link was
// ever enrolled for this interaction -- recordCancel's own existing
// "nothing to cancel" no-op, preserved exactly, just expressed as
// "contribute nothing to the caller's batch" instead of "run nothing."
// `guard`, when provided, is forwarded verbatim to
// D1CalendarStore.applyCancelStatements -- see its
// own doc comment (d1-calendar-store.ts) for exactly what this prevents.
export async function buildTripMeetingCancelledStatements(db: D1Database, interactionId: string, now: number, guard?: D1CrossTableGuard): Promise<D1PreparedStatement[]> {
  const store = new D1CalendarStore(db);
  const existingLink = await store.getLinkByInteraction(interactionId);
  if (!existingLink) return [];
  return store.applyCancelStatements(existingLink.id, now, guard);
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
  // Test-only seam (2026-10-19 review, follow-up): an advancing, test-
  // controlled Clock, overriding `realClock`. Never set by any real
  // caller -- trips-data.ts's own wiring never passes this, so every
  // production call always reads the real wall clock fresh at each
  // expiry-sensitive check, exactly as "lease protection" requires.
  clock?: Clock;
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
//
// Owner isolation (2026-10-19 review, follow-up): `args.userId` is passed
// through to runReconciliationSweep's own `scopeUserId`, so this sweep
// -- triggered by ONE authenticated owner's own scheduling/cancel/Retry
// action -- can never see, acquire a lease on, or mutate another owner's
// pending link or cleanup row. Before this fix, every owner's own action
// triggered an UNSCOPED sweep that would also attempt to reconcile every
// OTHER owner's pending work as a side effect.
export async function attemptImmediateTripCalendarSync(args: ImmediateSyncArgs): Promise<SweepResult | null> {
  if (!args.calendarSyncEnabled || !args.credentials) return null;
  const transport = args.transport ?? realHttpTransport;
  const client = args.client ?? createGoogleCalendarClient(args.credentials, transport);
  const clock = args.clock ?? realClock;
  const verifiedEmail = await resolveVerifiedGoogleAccountEmail(args.credentials, transport);
  const guard = isCalendarSyncAllowed({
    environment: args.environment, calendarSyncEnabled: args.calendarSyncEnabled, credentialsPresent: true,
    verifiedEmail, calendarId: args.calendarId, stagingTestCalendarId: args.stagingTestCalendarId,
  });
  if (!guard.allowed) return null;
  const store = new D1CalendarStore(args.db);
  return runReconciliationSweep(store, client, (interactionId) => loadTripMeetingFields(args.db, interactionId, args.fosBaseUrl), `trip:${args.userId}`, args.now, clock, args.userId);
}

// Safe Retry (2026-10-19 review, follow-up): reconciles ONE already-
// enrolled meeting's CURRENT desired state -- whatever it already is,
// present or absent -- without ever touching durable intent. Deliberately
// never calls enrollMeetingForSync/recordReschedule/recordCancel/
// recordReopen (the functions attemptImmediateTripCalendarSync's own
// sibling, the scheduling path, dispatches through): those are the
// "scheduling logic" this round's own instruction says Retry must never
// call, since recordTripMeetingScheduled's dispatch would REOPEN a
// canceled meeting purely as a side effect of retrying its sync -- a real
// bug this function exists to not have. Calling the core's own
// reconcilePresentAbsent directly for just this one interaction's link
// means: a 'present' link is retried toward being created/updated on
// Google (ordinary retry); an 'absent' (canceled) link is retried toward
// being DELETED from Google (reconcilePresentAbsent's own "absent" branch
// already does this, including cleanup) -- cancellation is always
// preserved, never reopened, and any cleanup still owed is still finished.
// Returns null under the exact same "never even attempt" conditions as
// attemptImmediateTripCalendarSync (disabled, no credentials, or the
// guard refuses) or when no link has ever been enrolled for this
// interaction at all (nothing to retry).
export async function reconcileTripMeetingCalendarLink(args: ImmediateSyncArgs & { interactionId: string }): Promise<ReconcileOutcome | null> {
  if (!args.calendarSyncEnabled || !args.credentials) return null;
  const transport = args.transport ?? realHttpTransport;
  const client = args.client ?? createGoogleCalendarClient(args.credentials, transport);
  const clock = args.clock ?? realClock;
  const verifiedEmail = await resolveVerifiedGoogleAccountEmail(args.credentials, transport);
  const guard = isCalendarSyncAllowed({
    environment: args.environment, calendarSyncEnabled: args.calendarSyncEnabled, credentialsPresent: true,
    verifiedEmail, calendarId: args.calendarId, stagingTestCalendarId: args.stagingTestCalendarId,
  });
  if (!guard.allowed) return null;
  const store = new D1CalendarStore(args.db);
  const existingLink = await store.getLinkByInteraction(args.interactionId);
  if (!existingLink) return null; // nothing enrolled for this meeting yet -- never created here, only an explicit schedule does that
  // Unique per acquisition (same reason as runReconciliationSweep's own
  // randomUUID() suffix) -- a fresh token every call, never reused.
  const leaseOwner = `trip-retry:${args.userId}:${args.interactionId}:${randomUUID()}`;
  return reconcilePresentAbsent(store, client, (interactionId) => loadTripMeetingFields(args.db, interactionId, args.fosBaseUrl), args.interactionId, leaseOwner, args.now, DEFAULT_LEASE_TTL_SECONDS, clock);
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
