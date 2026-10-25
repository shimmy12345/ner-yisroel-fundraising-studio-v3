// Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md).
// The one D1-touching module for this feature, matching the established
// split (lib/relationships/meeting-brief.ts vs. meeting-brief-model.ts):
// every rule/validation/status-string decision lives in the pure
// trip-model.ts; this file only ever reads/writes D1 and calls that pure
// logic, same convention app/api/asks/route.ts and meeting-brief.ts both
// already follow.

import { env } from "cloudflare:workers";
import { loadMeetingBrief } from "./meeting-brief.ts";
import { regionsForCityState, travelRegionById, type TravelRegionId } from "./travel-regions.ts";
import { searchDonors, type DonorSearchRecord } from "./donor-search.ts";
import { zonedTimeToUtc } from "../workspace/local-time.ts";
import { insertPendingGift, insertPendingPledge } from "../giving/pending-records.ts";
import { pendingGiftInput, pendingPledgeInput } from "../giving/management.ts";
import { normalizeDonorContact, changedContactFields, type DonorContactInput } from "../donors/contact.ts";
import {
  buildSuggestionSnapshot, findCrossTripConflicts, parseLocalDateTimeInput,
  statusRequiresInteraction, timezoneForState, tripCancelledInteractionSource, tripCompletedInteractionSource,
  tripMeetingInteractionId, tripScheduledInteractionSource, validateMeetingCompletion, validateMeetingScheduling,
  matchExistingGivingActivityForCommitment,
  type AddedMethod, type CrossTripConflict, type TripProspectStatus, type TripStatus, type TripCommitmentKind,
} from "./trip-model.ts";
import { REAL_COMMITMENT_CATEGORIES } from "./pledge-payment-plan.ts";
import {
  attemptImmediateTripCalendarSync, buildTripMeetingCancelledStatements,
  getTripMeetingCalendarLink, googleCalendarEventViewUrl, isUniqueConstraintViolation, loadCalendarConnectionStatus,
  planTripMeetingScheduledIntent, reconcileTripMeetingCalendarLink, setCalendarSyncEnabledForUser as setCalendarSyncEnabledForUserRow,
  type CalendarConnectionStatus,
} from "./trip-calendar-sync.ts";
import { logger } from "../logger.ts";

// Integration safety (2026-10-19, second follow-up review): bounded
// retries for the one race that is genuinely safe and correct to retry
// -- the calendar-sync intent's own guarded statement matching zero rows
// because its precondition (the link state read moments earlier) went
// stale under a concurrent transition. Each retry re-reads the link
// fresh and rebuilds the correct statement from scratch, so it converges
// rather than looping on a config/schema problem; a cap bounds the
// (never observed, but never assumed impossible) pathological case of
// continuous contention.
const MAX_CALENDAR_INTENT_ATTEMPTS = 5;

// Google Calendar sync narrowed first release (2026-10-19, see
// docs/AI-HANDOFF.md) -- the thin env-reading layer over
// trip-calendar-sync.ts's own testable, env-agnostic functions (see that
// file's own header for why the split exists). This is the one place in
// this feature that reads GOOGLE_CALENDAR_OAUTH_*/CALENDAR_SYNC_STAGING_
// TEST_CALENDAR_ID/__FUNDRAISING_OS_ENVIRONMENT__ -- trips-data.ts already
// imports "cloudflare:workers" for every other D1 access this feature
// makes, so this is not a new import boundary.
function calendarEnvCredentials(): { clientId: string; clientSecret: string; refreshToken: string } | null {
  if (!env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID || !env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET || !env.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN) return null;
  return { clientId: env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET, refreshToken: env.GOOGLE_CALENDAR_OAUTH_REFRESH_TOKEN };
}
// Production's own destination is always its owner's real primary
// calendar; Staging's is the explicit, non-"primary" test calendar id
// (absent means Staging sync stays refused -- calendar-sync-guard.ts's
// own job, not this function's) -- never any other environment value.
function calendarDestinationId(): string {
  return __FUNDRAISING_OS_ENVIRONMENT__ === "staging-independent" ? (env.CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID ?? "") : "primary";
}
function fosBaseUrl(): string {
  return env.APP_BASE_URL ?? "";
}

async function isCalendarSyncEnabledForUserInternal(userId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT calendar_sync_enabled FROM users WHERE id = ?").bind(userId).first<{ calendar_sync_enabled: number }>();
  return row?.calendar_sync_enabled === 1;
}

// Integration safety (2026-10-19, second follow-up review -- replaces
// this round's own earlier, incorrect design): scheduleProspectMeeting/
// setSimpleProspectStatus below used to wrap buildTripMeetingScheduled
// Statements/buildTripMeetingCancelledStatements in a try/catch that
// swallowed a database-read failure and returned an empty statement
// array -- silently losing the calendar intent while still saving (and
// reporting success for) the meeting change. Independently reproduced:
// a thrown error from the read inside either builder left the meeting
// saved with calendar intent unchanged, no error surfaced anywhere a
// caller could act on. Neither function exists anymore; both call sites
// now call the builders DIRECTLY and catch only at the point where they
// decide the function's own return value -- a read failure aborts that
// attempt with an actionable `calendar_unavailable` result BEFORE any
// db.batch() runs, never after a save has already committed. This is
// unrelated to -- and does not weaken -- "preserve ordinary scheduling
// when Calendar is disabled": disabling sync (`calendar_sync_enabled`)
// only gates attemptBestEffortCalendarReconcile's own live network
// attempt, never whether the durable intent is read/built at all, so a
// disabled user's scheduling still succeeds exactly as before (the
// builders' own read is a plain, always-attempted SELECT, independent
// of that flag).

// The one remaining non-atomic step: an actual best-effort attempt to
// REACH Google, run only AFTER the meeting change and the durable intent
// have already committed together (see the two functions above). This
// can never be folded into the same D1 batch -- it is a real network
// call, not a database write -- so it stays exactly what every prior
// round already documented: a separate step whose own failure is caught
// and logged, never surfaced as a failure of the already-successful
// save. Owner-scoped (passes `userId` through to
// attemptImmediateTripCalendarSync's own `args.userId`), so this can
// never attempt to reconcile any OTHER owner's pending work as a side
// effect of this one owner's action.
async function attemptBestEffortCalendarReconcile(userId: string, now: number): Promise<void> {
  try {
    const calendarId = calendarDestinationId();
    await attemptImmediateTripCalendarSync({
      db: env.DB, userId, environment: __FUNDRAISING_OS_ENVIRONMENT__,
      calendarSyncEnabled: await isCalendarSyncEnabledForUserInternal(userId),
      credentials: calendarEnvCredentials(), calendarId, stagingTestCalendarId: env.CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID ?? null,
      fosBaseUrl: fosBaseUrl(), now,
    });
  } catch (error) {
    logger.error("trip_calendar_sync_failed", { userId, error: error instanceof Error ? error.message : String(error) });
  }
}

// Safe Retry (2026-10-19 review, follow-up): reconciles this one meeting's
// CURRENT desired state only -- never recordTripMeetingScheduled/
// recordTripMeetingCancelled, which could reopen a canceled meeting as a
// side effect (see trip-calendar-sync.ts's reconcileTripMeetingCalendarLink
// doc comment). Never throws: same "a calendar-sync problem must never
// surface as a failure of an otherwise-successful request" rule as every
// other calendar call site in this file.
async function reconcileTripMeetingCalendarSync(interactionId: string, userId: string, now: number): Promise<void> {
  try {
    const calendarId = calendarDestinationId();
    await reconcileTripMeetingCalendarLink({
      db: env.DB, userId, environment: __FUNDRAISING_OS_ENVIRONMENT__,
      calendarSyncEnabled: await isCalendarSyncEnabledForUserInternal(userId),
      credentials: calendarEnvCredentials(), calendarId, stagingTestCalendarId: env.CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID ?? null,
      fosBaseUrl: fosBaseUrl(), now, interactionId,
    });
  } catch (error) {
    logger.error("trip_calendar_retry_failed", { interactionId, userId, error: error instanceof Error ? error.message : String(error) });
  }
}

// Exposed for the Retry action (app/api/trips/.../calendar-retry) and the
// Trip row's own status display -- a thin, owner-scope-enforced read of
// this one meeting's calendar link, never a bare store call a route could
// reach for any interactionId.
export type TripMeetingCalendarStatus = { syncStatus: string; googleEventId: string | null; googleCalendarId: string | null; lastError: string | null } | null;

export async function tripMeetingCalendarStatus(userId: string, tripId: string, prospectId: string): Promise<TripMeetingCalendarStatus> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect || !prospect.linkedInteractionId) return null;
  const link = await getTripMeetingCalendarLink(env.DB, prospect.linkedInteractionId);
  if (!link) return null;
  return { syncStatus: link.syncStatus, googleEventId: link.googleEventId, googleCalendarId: link.googleCalendarId, lastError: link.lastError };
}

// The Retry action -- "safe" because it only ever re-attempts reconciling
// this one owner-scoped meeting's EXISTING recorded intent (never writes
// a new intent, never calls scheduling logic that could reopen a
// canceled meeting -- see reconcileTripMeetingCalendarSync's own doc
// comment above).
export async function retryTripMeetingCalendarSync(userId: string, tripId: string, prospectId: string, now: number): Promise<boolean> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect || !prospect.linkedInteractionId) return false;
  await reconcileTripMeetingCalendarSync(prospect.linkedInteractionId, userId, now);
  return true;
}

export async function getCalendarConnectionStatusForUser(userId: string): Promise<CalendarConnectionStatus> {
  return loadCalendarConnectionStatus({
    db: env.DB, userId, environment: __FUNDRAISING_OS_ENVIRONMENT__, credentials: calendarEnvCredentials(),
    calendarId: calendarDestinationId(), stagingTestCalendarId: env.CALENDAR_SYNC_STAGING_TEST_CALENDAR_ID ?? null,
  });
}

export async function setCalendarSyncEnabledForUser(userId: string, enabled: boolean, now: number): Promise<void> {
  await setCalendarSyncEnabledForUserRow(env.DB, userId, enabled, now);
}

// Independent-review correction (2026-10-15): resolves a `datetime-local`
// input value into a real UTC epoch using the PROSPECT'S OWN donor state
// to pick the destination timezone (timezoneForState()), falling back to
// the fundraiser's own home timezone only when the donor has none on
// file -- never the browser's ambient timezone. Returns null for a
// malformed input string; the caller turns that into a clear validation
// error rather than guessing. See trip-model.ts's own header comment on
// parseLocalDateTimeInput() for why a strict regex parse (never `new
// Date()`) is what makes this safe to call with untrusted request-body
// text at all.
async function resolveMeetingEpoch(donorId: string, localDateTime: unknown, fallbackTimezone: string): Promise<number | null> {
  const fields = parseLocalDateTimeInput(localDateTime);
  if (!fields) return null;
  const donor = await env.DB.prepare("SELECT state FROM donors WHERE id = ?").bind(donorId).first<{ state: string | null }>();
  const timezone = timezoneForState(donor?.state ?? null, fallbackTimezone);
  const utc = zonedTimeToUtc(fields.year, fields.month, fields.day, fields.hour, fields.minute, timezone);
  return Math.floor(utc.getTime() / 1000);
}

type DonorSearchRow = {
  id: string; display_name: string; primary_first_name: string | null; last_name: string | null;
  spouse: string | null; spouse_first_name: string | null; donor_code: string | null; external_id: string | null;
  email: string | null; phone: string | null; city: string | null; state: string | null;
};

async function liveOwnedDonorRows(userId: string): Promise<DonorSearchRow[]> {
  const result = await env.DB.prepare(`SELECT id, display_name, primary_first_name, last_name, spouse, spouse_first_name, donor_code, external_id, email, phone, city, state
      FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL`).bind(userId).all<DonorSearchRow>();
  return result.results;
}

function toDonorSearchRecord(row: DonorSearchRow): DonorSearchRecord & { city: string | null; state: string | null } {
  return {
    id: row.id, name: row.display_name, primaryFirstName: row.primary_first_name, lastName: row.last_name,
    spouse: row.spouse || row.spouse_first_name, code: row.external_id || row.donor_code, email: row.email, phone: row.phone,
    city: row.city, state: row.state,
  };
}

export type TripListItem = { id: string; name: string; destinationRegionLabel: string | null; startDate: number; endDate: number; status: TripStatus; prospectCount: number };

export async function listTrips(userId: string): Promise<TripListItem[]> {
  // `prospectCount` counts only SELECTED prospects (Deliberate Prospect
  // Selection, 2026-10-18) -- a regional candidate the owner hasn't
  // acted on yet was never a real outreach target, so it must never
  // inflate this trip card's own count.
  const result = await env.DB.prepare(`SELECT t.id, t.name, t.destination_region_label, t.start_date, t.end_date, t.status,
      (SELECT COUNT(*) FROM trip_prospects WHERE trip_id = t.id AND selected_at IS NOT NULL) AS prospect_count
    FROM trips t WHERE t.owner_user_id = ? ORDER BY t.start_date DESC`).bind(userId).all<{ id: string; name: string; destination_region_label: string | null; start_date: number; end_date: number; status: TripStatus; prospect_count: number }>();
  return result.results.map((row) => ({ id: row.id, name: row.name, destinationRegionLabel: row.destination_region_label, startDate: row.start_date, endDate: row.end_date, status: row.status, prospectCount: row.prospect_count }));
}

export type CreateTripInput = { name: string; destinationRegionId: TravelRegionId | null; startDate: number; endDate: number; goalCents: number | null; notes: string | null };

// Creates the trip row only. Deliberate Prospect Selection (2026-10-18,
// see docs/AI-HANDOFF.md) -- a destination region is still stored on the
// trip and still drives "Find prospects"' default region, but no
// trip_prospects row is ever inserted here, even when a region is
// chosen. Conflating "lives in the destination region" with "a deliberate
// outreach target the owner actually picked" was exactly the problem
// this round fixes -- regional donors are surfaced live, read-only, via
// listDonorsForTripSearch() below, and a row is only ever created (with
// selected_at set immediately) through the explicit "Add to trip" action
// (selectTripProspect()).
export async function createTrip(userId: string, input: CreateTripInput, now: number): Promise<{ tripId: string }> {
  const tripId = crypto.randomUUID();
  const region = input.destinationRegionId ? travelRegionById(input.destinationRegionId) : null;
  await env.DB.prepare(`INSERT INTO trips (id, owner_user_id, name, destination_region_id, destination_region_label, start_date, end_date, fundraising_goal_cents, notes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?)`)
    .bind(tripId, userId, input.name, region?.id ?? null, region?.label ?? null, input.startDate, input.endDate, input.goalCents, input.notes, now, now).run();
  return { tripId };
}

export type TripRecord = { id: string; name: string; destinationRegionId: TravelRegionId | null; destinationRegionLabel: string | null; startDate: number; endDate: number; goalCents: number | null; notes: string | null; status: TripStatus; createdAt: number; updatedAt: number };

export async function getTrip(userId: string, tripId: string): Promise<TripRecord | null> {
  const row = await env.DB.prepare(`SELECT id, name, destination_region_id, destination_region_label, start_date, end_date, fundraising_goal_cents, notes, status, created_at, updated_at
      FROM trips WHERE id = ? AND owner_user_id = ?`).bind(tripId, userId)
    .first<{ id: string; name: string; destination_region_id: string | null; destination_region_label: string | null; start_date: number; end_date: number; fundraising_goal_cents: number | null; notes: string | null; status: TripStatus; created_at: number; updated_at: number }>();
  if (!row) return null;
  return { id: row.id, name: row.name, destinationRegionId: row.destination_region_id as TravelRegionId | null, destinationRegionLabel: row.destination_region_label, startDate: row.start_date, endDate: row.end_date, goalCents: row.fundraising_goal_cents, notes: row.notes, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}

// Collapsed, display-only summary of the full SyncStatus union (Minimal
// controls: "Pending, Synced, or actionable failure, safe Retry") -- the
// underlying calendar_event_links row still carries the precise status;
// this is deliberately the one simplified shape the Trip row UI needs.
// null means "never scheduled/no link exists" (planned outreach,
// meeting_requested, declined, etc. -- these create nothing, see
// trip-model.ts's statusRequiresInteraction()).
export type TripMeetingCalendarSummary = { status: "pending" | "synced" | "failed"; viewUrl: string | null } | null;

// Manually Added Prospects (2026-10-25, see docs/AI-HANDOFF.md): `donorId`
// is null exactly when this prospect is NOT yet in FOS -- `isLinked` is a
// convenience mirror of that same fact, never an independent source of
// truth. `displayName`/`city`/`state` are always populated (from the real
// donor row when linked, from the manual_* columns otherwise) so every
// UI surface can render a prospect identically either way; `manualPhone`/
// `manualEmail`/`manualNotes`/`manualRegionLabel` are populated only for
// an unlinked prospect (null once linked -- the real donor record is the
// source of truth for contact details at that point, even though the
// manual_* columns themselves are left in place in the database as a
// harmless historical record).
export type TripProspectRecord = {
  id: string; donorId: string | null; isLinked: boolean; donorDisplayName: string; donorCity: string | null; donorState: string | null; donorCode: string | null;
  manualPhone: string | null; manualEmail: string | null; manualNotes: string | null; manualRegionLabel: string | null;
  addedMethod: AddedMethod; status: TripProspectStatus; selectedAt: number;
  suggestedReason: string | null; suggestedScore: number | null; suggestedGeneratedAt: number | null;
  manualRank: number | null; meetingAt: number | null; meetingLocation: string | null; nextAction: string | null; trip_notes: string | null;
  linkedInteractionId: string | null; crossTripConflicts: CrossTripConflict[]; calendarSync: TripMeetingCalendarSummary;
};

// "My trip prospects" (Deliberate Prospect Selection, 2026-10-18) -- only
// rows the owner has explicitly selected (`selected_at IS NOT NULL`),
// never every regional candidate. A candidate row that exists in
// trip_prospects but was never selected (a legacy auto-inserted row the
// owner hasn't acted on, or one not yet picked in "Find prospects") is
// deliberately excluded here -- see listDonorsForTripSearch() below for
// where it DOES surface.
export async function listTripProspects(userId: string, tripId: string): Promise<TripProspectRecord[]> {
  // LEFT JOIN donors (never an INNER JOIN) so an unlinked prospect
  // (donor_id IS NULL) is still returned -- ownership is checked via an
  // explicit trips join instead of (as before) incidentally through the
  // donor join, since an unlinked row has no donor row to check against.
  const prospectRows = await env.DB.prepare(`SELECT tp.id, tp.donor_id, COALESCE(d.display_name, tp.manual_name) AS display_name,
        COALESCE(d.city, tp.manual_city) AS city, d.state AS donor_state, d.external_id, d.donor_code,
        tp.manual_region_id, tp.manual_phone, tp.manual_email, tp.manual_notes,
        tp.added_method, tp.status, tp.selected_at, tp.suggested_reason, tp.suggested_score, tp.suggested_generated_at, tp.manual_rank,
        tp.meeting_at, tp.meeting_location, tp.next_action, tp.trip_notes, tp.linked_interaction_id
      FROM trip_prospects tp
      JOIN trips t ON t.id = tp.trip_id
      LEFT JOIN donors d ON d.id = tp.donor_id
      WHERE tp.trip_id = ? AND t.owner_user_id = ? AND tp.selected_at IS NOT NULL
      ORDER BY (tp.manual_rank IS NULL), tp.manual_rank, tp.suggested_score IS NULL, tp.suggested_score DESC, display_name`)
    .bind(tripId, userId).all<{
      id: string; donor_id: string | null; display_name: string; city: string | null; donor_state: string | null;
      external_id: string | null; donor_code: string | null; manual_region_id: string | null; manual_phone: string | null; manual_email: string | null; manual_notes: string | null;
      added_method: AddedMethod; status: TripProspectStatus; selected_at: number; suggested_reason: string | null; suggested_score: number | null; suggested_generated_at: number | null;
      manual_rank: number | null; meeting_at: number | null; meeting_location: string | null; next_action: string | null; trip_notes: string | null; linked_interaction_id: string | null;
    }>();
  if (prospectRows.results.length === 0) return [];

  const donorIds = [...new Set(prospectRows.results.map((row) => row.donor_id).filter((id): id is string => id !== null))];
  // Cross-trip conflicts (Section C): every OTHER trip's SELECTED
  // prospect row for any donor on THIS trip, across every one of this
  // owner's trips -- one query, not one per prospect. A candidate on
  // another trip that was never selected is not a real scheduling
  // conflict (nothing was actually planned there).
  const rowsByDonor = new Map<string, Array<{ tripId: string; tripName: string; status: TripProspectStatus; meetingAt: number | null }>>();
  // An unlinked prospect has no donor_id to check for cross-trip
  // conflicts against -- skip the query entirely rather than bind an
  // empty IN (), which is invalid SQL.
  if (donorIds.length > 0) {
    const conflictRows = await env.DB.prepare(`SELECT tp.donor_id, tp.trip_id, t.name AS trip_name, tp.status, tp.meeting_at
        FROM trip_prospects tp JOIN trips t ON t.id = tp.trip_id
        WHERE t.owner_user_id = ? AND tp.trip_id != ? AND tp.selected_at IS NOT NULL AND tp.donor_id IN (${donorIds.map(() => "?").join(",")})`)
      .bind(userId, tripId, ...donorIds).all<{ donor_id: string; trip_id: string; trip_name: string; status: TripProspectStatus; meeting_at: number | null }>();
    for (const row of conflictRows.results) {
      const list = rowsByDonor.get(row.donor_id) ?? [];
      list.push({ tripId: row.trip_id, tripName: row.trip_name, status: row.status, meetingAt: row.meeting_at });
      rowsByDonor.set(row.donor_id, list);
    }
  }
  // The SQL above already excludes this trip's own rows (`tp.trip_id !=
  // ?`), but findCrossTripConflicts() still takes `excludeTripId`
  // explicitly -- the one real filtering decision (which STATUSES count
  // as a conflict) stays in the pure, unit-tested function, never
  // duplicated here.
  const conflictsByDonor = new Map<string, CrossTripConflict[]>([...rowsByDonor.entries()].map(([donorId, rows]) => [donorId, findCrossTripConflicts(rows, tripId)]));

  // Calendar sync status (Minimal controls) -- one extra query over every
  // linked interaction id on this page, merged in JS, same "separate
  // query, never a speculative JOIN into this feature's own schema"
  // convention as crossTripConflicts above. A prospect with no linked
  // interaction at all (never scheduled) never appears here.
  const interactionIds = [...new Set(prospectRows.results.map((row) => row.linked_interaction_id).filter((id): id is string => id !== null))];
  const linksByInteraction = new Map<string, { syncStatus: string; googleEventId: string | null; googleCalendarId: string }>();
  if (interactionIds.length > 0) {
    const linkRows = await env.DB.prepare(`SELECT interaction_id, sync_status, google_event_id, google_calendar_id FROM calendar_event_links WHERE interaction_id IN (${interactionIds.map(() => "?").join(",")})`)
      .bind(...interactionIds).all<{ interaction_id: string; sync_status: string; google_event_id: string | null; google_calendar_id: string }>();
    for (const row of linkRows.results) linksByInteraction.set(row.interaction_id, { syncStatus: row.sync_status, googleEventId: row.google_event_id, googleCalendarId: row.google_calendar_id });
  }
  const calendarSyncFor = (linkedInteractionId: string | null): TripMeetingCalendarSummary => {
    if (!linkedInteractionId) return null;
    const link = linksByInteraction.get(linkedInteractionId);
    if (!link) return null;
    const status = link.syncStatus === "synced" ? "synced" : link.syncStatus === "pending" ? "pending" : "failed";
    const viewUrl = status === "synced" && link.googleEventId ? googleCalendarEventViewUrl(link.googleEventId, link.googleCalendarId) : null;
    return { status, viewUrl };
  };

  return prospectRows.results.map((row) => ({
    id: row.id, donorId: row.donor_id, isLinked: row.donor_id !== null,
    donorDisplayName: row.display_name, donorCity: row.city, donorState: row.donor_state, donorCode: row.external_id || row.donor_code,
    manualPhone: row.donor_id === null ? row.manual_phone : null, manualEmail: row.donor_id === null ? row.manual_email : null, manualNotes: row.donor_id === null ? row.manual_notes : null,
    manualRegionLabel: row.donor_id === null ? (travelRegionById(row.manual_region_id)?.label ?? null) : null,
    addedMethod: row.added_method, status: row.status, selectedAt: row.selected_at, suggestedReason: row.suggested_reason, suggestedScore: row.suggested_score, suggestedGeneratedAt: row.suggested_generated_at,
    manualRank: row.manual_rank, meetingAt: row.meeting_at, meetingLocation: row.meeting_location, nextAction: row.next_action, trip_notes: row.trip_notes,
    linkedInteractionId: row.linked_interaction_id, crossTripConflicts: row.donor_id !== null ? (conflictsByDonor.get(row.donor_id) ?? []) : [], calendarSync: calendarSyncFor(row.linked_interaction_id),
  }));
}

// "Find prospects" (Deliberate Prospect Selection, 2026-10-18) -- every
// live, owned donor, annotated with this trip's own selection state.
// Always the FULL list (never truncated, never paginated) -- region and
// text-search narrowing both happen client-side over this same array,
// reusing searchDonors()/filterByGeo() exactly as the donor directory
// does, never a second search implementation. A donor already selected
// on this trip is marked `alreadySelected` (never hidden -- "clearly
// identify already-added people"); a donor with an existing but
// unselected trip_prospects row (a legacy auto-inserted candidate, or
// one offered here a moment ago) carries `existingProspectId` so
// selectTripProspect() can reuse that exact row instead of inserting a
// second one.
export type FindProspectDonor = DonorSearchRecord & { city: string | null; state: string | null; alreadySelected: boolean; existingProspectId: string | null };

export async function listDonorsForTripSearch(userId: string, tripId: string): Promise<FindProspectDonor[]> {
  const [donorRows, trackedRows] = await Promise.all([
    liveOwnedDonorRows(userId),
    env.DB.prepare("SELECT id, donor_id, selected_at FROM trip_prospects WHERE trip_id = ?").bind(tripId).all<{ id: string; donor_id: string; selected_at: number | null }>(),
  ]);
  const trackedByDonor = new Map(trackedRows.results.map((row) => [row.donor_id, row]));
  return donorRows.map((row) => {
    const tracked = trackedByDonor.get(row.id);
    return { ...toDonorSearchRecord(row), alreadySelected: Boolean(tracked && tracked.selected_at !== null), existingProspectId: tracked?.id ?? null };
  });
}

export type SelectProspectResult = { ok: true; prospectId: string; created: boolean } | { ok: false; reason: "donor_not_found" | "trip_not_found" | "already_selected" };

// The explicit "Add to trip" action (Section 1/5) -- the ONLY way a
// trip_prospects row is ever created or selected going forward, whether
// the donor came from a regional match or an out-of-region search. If a
// trip_prospects row already exists for this donor (a fresh insert from
// a moment ago, or a legacy candidate from before this feature shipped)
// and was never selected, THAT SAME ROW is reused (its id, notes,
// status, meeting/interaction links, and financial attributions are
// never touched or recreated) -- this is also the explicit, non-
// destructive mechanism for picking an existing ambiguous candidate into
// "My trip prospects" that Section 5 requires. `added_method` is only
// ever decided at INSERT time (by whether the donor is currently in the
// trip's own destination region) and is never rewritten when reusing an
// existing row, preserving how it was originally added.
export async function selectTripProspect(userId: string, tripId: string, donorId: string, timezone: string, now: number): Promise<SelectProspectResult> {
  const trip = await getTrip(userId, tripId);
  if (!trip) return { ok: false, reason: "trip_not_found" };
  const donor = await env.DB.prepare("SELECT id, city, state FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL").bind(donorId, userId).first<{ id: string; city: string | null; state: string | null }>();
  if (!donor) return { ok: false, reason: "donor_not_found" };

  const existing = await env.DB.prepare("SELECT id, selected_at FROM trip_prospects WHERE trip_id = ? AND donor_id = ?").bind(tripId, donorId).first<{ id: string; selected_at: number | null }>();
  if (existing) {
    if (existing.selected_at !== null) return { ok: false, reason: "already_selected" };
    await env.DB.prepare("UPDATE trip_prospects SET selected_at = ?, updated_at = ? WHERE id = ?").bind(now, now, existing.id).run();
    return { ok: true, prospectId: existing.id, created: false };
  }

  const addedMethod: AddedMethod = trip.destinationRegionId && regionsForCityState(donor.city, donor.state).includes(trip.destinationRegionId) ? "auto_region" : "manual";
  const brief = await loadMeetingBrief(userId, donorId, timezone, now);
  const snapshot = buildSuggestionSnapshot(brief?.recommendation ?? null, now);
  const prospectId = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, added_method, status, suggested_reason, suggested_score, suggested_generated_at, selected_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'not_contacted', ?, ?, ?, ?, ?, ?)`)
      .bind(prospectId, tripId, donorId, addedMethod, snapshot.reason, snapshot.score, snapshot.generatedAt, now, now, now).run();
  } catch {
    // UNIQUE(trip_id, donor_id) caught a race (two concurrent selections
    // for the same donor) that the pre-check above missed -- structurally
    // impossible to double-insert, matching every other UNIQUE-
    // constraint-as-the-real-guarantee pattern in this app.
    return { ok: false, reason: "already_selected" };
  }
  return { ok: true, prospectId, created: true };
}

// Removal (Section C): deletes only the trip_prospects row. Deliberately
// never touches the donor record, interactions, or any other trip's own
// prospect rows -- the owner's own explicit "without changing their CRM
// records" instruction. If the removed prospect had a real scheduled
// meeting (linked_interaction_id set, not yet completed), that
// interaction is left exactly as it is; cancelling an actual meeting is
// a status decision (see updateProspectStatus below), never an implicit
// side effect of removing it from this trip's list.
export async function removeProspect(userId: string, tripId: string, prospectId: string): Promise<boolean> {
  const result = await env.DB.prepare(`DELETE FROM trip_prospects WHERE id = ? AND trip_id = ? AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(prospectId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0;
}

type ExistingProspect = { id: string; donorId: string; status: TripProspectStatus; linkedInteractionId: string | null };

async function ownedProspect(userId: string, tripId: string, prospectId: string): Promise<ExistingProspect | null> {
  const row = await env.DB.prepare(`SELECT tp.id, tp.donor_id, tp.status, tp.linked_interaction_id
      FROM trip_prospects tp JOIN trips t ON t.id = tp.trip_id
      WHERE tp.id = ? AND tp.trip_id = ? AND t.owner_user_id = ?`).bind(prospectId, tripId, userId)
    .first<{ id: string; donor_id: string; status: TripProspectStatus; linked_interaction_id: string | null }>();
  return row ? { id: row.id, donorId: row.donor_id, status: row.status, linkedInteractionId: row.linked_interaction_id } : null;
}

// `calendar_unavailable` (2026-10-19, second follow-up review): reading
// the current calendar-sync intent failed (a genuine database error,
// never merely "sync is disabled") -- the meeting change was NOT saved;
// retrying the exact same request is the correct, actionable response.
// `calendar_conflict`: the calendar intent's own guarded statement kept
// matching zero rows across every retry attempt (a competing transition
// kept winning the race) -- the meeting change WAS NOT saved either (see
// scheduleProspectMeeting's own retry loop, which only reports success
// once both halves are confirmed consistent); retrying is again the
// correct response.
// `notes_conflict` (2026-10-21, second follow-up review -- "lost notes
// during concurrent saves"): completeProspectMeeting's own compare-and-
// swap write (see its own doc comment) could not land after repeated
// retries against persistent, genuine contention -- the meeting was NOT
// marked completed and no notes were overwritten; retrying is the
// correct response, exactly like `calendar_conflict` above.
export type StatusUpdateResult = { ok: true } | { ok: false; reason: "not_found" | "conflict" | "confirmation_required" | "already_completed" | "invalid_meeting_time" | "calendar_unavailable" | "calendar_conflict" | "notes_conflict" };

// A simple status move -- not_contacted/contacted/meeting_requested/
// declined/unable_to_schedule. Never writes to `interactions` (Section
// D's explicit "must not automatically create false donor interactions"
// / "Contacted must not claim a completed interaction occurred"). If the
// prospect is moving AWAY from meeting_scheduled (to any status other
// than meeting_completed) and has a linked interaction still in its
// scheduled state, that interaction is cancelled (wrapped with the same
// `cancelled:` prefix the existing outcome route already uses) so it
// stops appearing as an upcoming meeting anywhere else in the CRM --
// directly satisfies "do not allow a cancelled or declined meeting to
// remain incorrectly represented as upcoming".
export async function setSimpleProspectStatus(userId: string, tripId: string, prospectId: string, nextStatus: TripProspectStatus, now: number): Promise<StatusUpdateResult> {
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  const statements: D1PreparedStatement[] = [];
  let cancelCalendarForInteractionId: string | null = null;
  // Integration safety (2026-10-19, second follow-up review -- "prevent
  // stale actions from canceling... a later transition"): this guard --
  // "trip_prospects still has the EXACT status this request read" --
  // catches a stale request racing a concurrent STATUS change (e.g. to
  // meeting_completed, which never touches the calendar link at all).
  const statusGuardSql = "EXISTS (SELECT 1 FROM trip_prospects WHERE id = ? AND status = ?)";
  const statusGuardParams: ReadonlyArray<string | number> = [prospectId, existing.status];
  // `guardSql`/`guardParams` start as just the status guard above, and
  // gain a second clause below once a calendar link is actually
  // involved. Applied uniformly to EVERY write this function makes when
  // canceling (the meeting/interaction write, the trip_prospects write,
  // and the calendar-intent + cleanup writes), so all of them succeed or
  // fail together -- never a partial result.
  let guardSql = statusGuardSql;
  let guardParams: ReadonlyArray<string | number> = statusGuardParams;
  if (existing.status === "meeting_scheduled" && nextStatus !== "meeting_completed" && existing.linkedInteractionId) {
    const interaction = await env.DB.prepare("SELECT source FROM interactions WHERE id = ? AND user_id = ?").bind(existing.linkedInteractionId, userId).first<{ source: string }>();
    if (interaction && !interaction.source.startsWith("capture-completed:") && !interaction.source.startsWith("cancelled:")) {
      // Integration safety (2026-10-19, third follow-up review --
      // "bind cancellation to the generation/revision ... it originally
      // observed"): independently reproduced the exact gap a
      // status-only guard leaves open. A stale cancellation reads
      // status "meeting_scheduled" and starts preparing; a competing
      // request cancels this same generation AND reopens it (a new
      // generation) before the stale request's own batch runs --
      // trip_prospects.status and the interaction's own source both
      // return to their ORIGINAL "scheduled" values as part of that
      // reopen, so the status-only guard above, re-checked later, sees
      // the SAME status it read and wrongly believes nothing changed.
      // The calendar link's own `generation`, read here at the SAME
      // moment as the interaction's source, is the durable transition
      // identity a status LABEL cannot provide (a status round-trips
      // back to the same value; a generation never does). Expressed as
      // a self-contained EXISTS clause (not a bare `generation` column
      // reference), so the SAME fragment is safe to AND onto
      // `interactions`/`trip_prospects` too, neither of which has a
      // `generation` column of their own.
      //
      // Deliberately checks `generation` ALONE, never ALSO
      // `desired_state = 'present'`: a real regression, caught by CI,
      // showed why. The cancel statements this guard is also applied to
      // run in order within the SAME batch -- the main link UPDATE
      // (which flips desired_state to 'absent') BEFORE the history
      // cleanup-flag UPDATE -- and later statements in a D1 batch
      // observe earlier statements' own writes. A guard additionally
      // requiring `desired_state = 'present'` would therefore check its
      // OWN just-applied effect by the time the cleanup statement ran,
      // failing even on the ordinary, non-racing path. `generation`
      // alone is both necessary and sufficient: cancel itself never
      // changes it (only reopen does), so it stays a stable identity
      // across the very operation this guard protects.
      const link = await getTripMeetingCalendarLink(env.DB, existing.linkedInteractionId);
      if (link) {
        guardSql = `${statusGuardSql} AND EXISTS (SELECT 1 FROM calendar_event_links WHERE interaction_id = ? AND generation = ?)`;
        guardParams = [...statusGuardParams, existing.linkedInteractionId, link.generation];
      }
      statements.push(
        env.DB.prepare(`UPDATE interactions SET source = ?, updated_at = ?
            WHERE id = ? AND user_id = ? AND source = ? AND ${guardSql}`)
          .bind(tripCancelledInteractionSource(interaction.source), now, existing.linkedInteractionId, userId, interaction.source, ...guardParams),
      );
      cancelCalendarForInteractionId = existing.linkedInteractionId;
    }
  }
  // "Canceling removes only its linked FOS-created event," committed as
  // ONE atomic D1 operation together with the meeting/status change below
  // -- never a separate batch call after this one commits (see
  // trip-calendar-sync.ts's own buildTripMeetingCancelledStatements doc
  // comment for exactly what this makes atomic). A failure reading the
  // current calendar link state aborts the WHOLE request before any
  // batch runs -- the status change is not saved either -- rather than
  // silently losing the calendar intent while the status change succeeds.
  //
  // MUST be built and pushed BEFORE the trip_prospects update below, not
  // after: these statements' own guard re-checks state that update is
  // about to change, and D1 batch statements observe EARLIER statements'
  // own writes within the SAME batch (confirmed by an earlier version of
  // this function pushing the trip_prospects update FIRST, which made
  // the guard permanently, silently false). Pushed first, the guard
  // still observes the PRE-update state, exactly as intended.
  if (cancelCalendarForInteractionId) {
    let calendarStatements: D1PreparedStatement[];
    try {
      calendarStatements = await buildTripMeetingCancelledStatements(env.DB, cancelCalendarForInteractionId, now, { sql: guardSql, params: guardParams });
    } catch (error) {
      logger.error("trip_calendar_intent_read_failed", { interactionId: cancelCalendarForInteractionId, userId, error: error instanceof Error ? error.message : String(error) });
      return { ok: false, reason: "calendar_unavailable" };
    }
    statements.push(...calendarStatements);
  }
  // Integration safety, atomic persistence: the trip_prospects status
  // update's own result (at this fixed index, regardless of how many
  // calendar statements were pushed before it above) is what "did the
  // update actually apply" is judged on -- never `.at(-1)`. ANDing the
  // SAME `guardSql` here too (not just its own simpler `status = ?`)
  // means a stale request's generation mismatch also prevents the
  // PROSPECT's own status from being overwritten -- "enforce that
  // identity across the meeting, prospect, Calendar intent, and cleanup
  // writes," not just the calendar-facing ones. Harmless, verified
  // redundancy with this statement's own `status = ?` when no calendar
  // link is involved (guardSql is then just the same status check,
  // self-referentially true).
  const prospectUpdateIndex = statements.length;
  statements.push(
    env.DB.prepare(`UPDATE trip_prospects SET status = ?, updated_at = ? WHERE id = ? AND status = ? AND ${guardSql}`)
      .bind(nextStatus, now, prospectId, existing.status, ...guardParams),
  );
  const results = await env.DB.batch(statements) as unknown as Array<{ meta: { changes?: number } }>;
  if ((results[prospectUpdateIndex]?.meta.changes ?? 0) === 0) return { ok: false, reason: "conflict" };
  if (cancelCalendarForInteractionId) await attemptBestEffortCalendarReconcile(userId, now);
  return { ok: true };
}

// "Scheduling a meeting may create a real scheduled interaction ...
// but only after explicit user confirmation" -- `confirmed` is the
// caller's own explicit flag from the request body, checked by the
// route before this is ever called; this function itself still refuses
// to proceed without it; the real write is idempotent (deterministic
// interaction id, ON CONFLICT DO UPDATE) so a retried request can never
// create a second interaction for the same prospect.
//
// Independent-review correction (2026-10-15): refuses once the prospect
// is already `meeting_completed`. Without this, re-selecting "Meeting
// Scheduled" on an already-completed prospect (reachable through the
// ordinary status dropdown, not just a crafted request) would silently
// overwrite the SAME linked interaction's `summary`/`source` back to a
// generic "scheduled" placeholder -- erasing the real completed
// meeting's own notes, not merely relabeling a status. Rescheduling
// before completion (declined -> scheduled, or scheduled -> a new time)
// is unaffected; only the completed -> scheduled direction is blocked.
// A fundraiser who genuinely needs a second, later meeting with the
// same donor on the same trip must remove and re-add the prospect
// (documented as a known MVP limitation, not silently worked around
// here) rather than risk this function ever discarding a real record
// of what already happened.
// `meetingAtLocal` is the exact, untrusted `<input type="datetime-local">`
// string from the request body -- resolved to a real UTC epoch via
// resolveMeetingEpoch() (the donor's own destination timezone, DST-safe,
// never the browser's ambient zone) before anything else runs.
// `durationMinutes` is already validated by the caller (trip-model.ts's
// validateMeetingDurationMinutes, defaulting to
// DEFAULT_MEETING_DURATION_MINUTES) -- "show an editable duration,
// default 30 minutes," stored explicitly in `interactions.end_at` (never
// silently applied and hidden), since this is the one column migration
// 0048 already added for exactly this purpose and never previously
// populated by this function.
export async function scheduleProspectMeeting(userId: string, tripId: string, prospectId: string, meetingAtLocal: unknown, location: string | null, durationMinutes: number, confirmed: boolean, fallbackTimezone: string, now: number): Promise<StatusUpdateResult> {
  if (!confirmed) return { ok: false, reason: "confirmation_required" };
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (existing.status === "meeting_completed") return { ok: false, reason: "already_completed" };
  const meetingAt = await resolveMeetingEpoch(existing.donorId, meetingAtLocal, fallbackTimezone);
  if (meetingAt === null || !validateMeetingScheduling(meetingAt, now).ok) return { ok: false, reason: "invalid_meeting_time" };
  const endAt = meetingAt + durationMinutes * 60;
  const interactionId = tripMeetingInteractionId(prospectId);
  const source = tripScheduledInteractionSource(tripId);
  const donor = await env.DB.prepare("SELECT display_name FROM donors WHERE id = ?").bind(existing.donorId).first<{ display_name: string }>();
  const summary = `Trip meeting scheduled with ${donor?.display_name ?? "donor"}.`;

  // Integration safety (2026-10-19, second follow-up review -- "fix
  // conflicting meeting/Calendar transitions"): independently reproduced
  // the exact race this guards against -- read the present link, start
  // building a reschedule, let a competing cancellation commit first
  // (flipping desired_state to absent), then resume: the meeting upsert
  // and trip_prospects update used to have NO precondition tied to the
  // calendar read at all, so they always committed, leaving FOS saying
  // "meeting scheduled" while the calendar intent stayed "absent."
  // `planTripMeetingScheduledIntent` returns BOTH the calendar's own
  // statements and a `guard` (D1CrossTableGuard) expressing exactly "the
  // calendar link's state is still what this decision assumed" -- ANDed
  // here into the interactions upsert's own DO UPDATE WHERE clause and
  // into the trip_prospects UPDATE's WHERE clause too, so EVERY
  // statement in the combined batch shares the identical, freshly-
  // re-verified precondition: either all of them affect a row together,
  // or (the precondition went stale) none of them do -- never the
  // partial outcome the race used to produce. A guard mismatch means
  // nothing committed, so retrying the WHOLE transition against a fresh
  // read (which will correctly re-decide enroll/reschedule/reopen) is
  // always safe; scheduling's own intent ("make this meeting scheduled
  // at this time") remains valid regardless of the calendar's prior
  // state, unlike cancellation's conditional intent (see
  // setSimpleProspectStatus's own guard, which reports conflict instead
  // of retrying).
  for (let attempt = 1; attempt <= MAX_CALENDAR_INTENT_ATTEMPTS; attempt++) {
    let intent;
    try {
      intent = await planTripMeetingScheduledIntent(env.DB, interactionId, userId, calendarDestinationId(), now);
    } catch (error) {
      // A genuine database-read failure -- never merely "sync is
      // disabled" (disabling only gates the live network attempt below,
      // never this read). The meeting change is NOT saved; the caller
      // gets an actionable, retryable failure instead of a save that
      // silently lost its calendar intent.
      logger.error("trip_calendar_intent_read_failed", { interactionId, userId, error: error instanceof Error ? error.message : String(error) });
      return { ok: false, reason: "calendar_unavailable" };
    }
    const { guard } = intent;
    const statements: D1PreparedStatement[] = [
      // AI Meeting Notes preservation (2026-10-21, see docs/AI-HANDOFF.md):
      // `summary` is deliberately NOT in the DO UPDATE SET list below --
      // rescheduling (or reopening after a decline) reuses this SAME
      // deterministic interaction id, and must never stomp on real notes
      // already saved here (via either meeting-notes save route) back to
      // this generic "scheduled" placeholder. The placeholder is still
      // written in full on the very first schedule (the INSERT branch,
      // which this ON CONFLICT clause has no effect on).
      env.DB.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, end_at, location, summary, source, created_at, updated_at)
          VALUES (?, ?, ?, 'meeting', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET occurred_at = excluded.occurred_at, end_at = excluded.end_at, location = excluded.location, source = excluded.source, updated_at = excluded.updated_at
          WHERE ${guard.sql}`)
        .bind(interactionId, existing.donorId, userId, meetingAt, endAt, location, summary, source, now, now, ...guard.params),
      env.DB.prepare(`UPDATE trip_prospects SET status = 'meeting_scheduled', meeting_at = ?, meeting_location = ?, linked_interaction_id = ?, updated_at = ? WHERE id = ? AND ${guard.sql}`)
        .bind(meetingAt, location, interactionId, now, prospectId, ...guard.params),
    ];
    const prospectUpdateIndex = statements.length - 1;
    statements.push(...intent.statements);

    let results: Array<{ meta: { changes?: number } }>;
    try {
      results = await env.DB.batch(statements) as unknown as Array<{ meta: { changes?: number } }>;
    } catch (error) {
      // A concurrent FIRST-time enroll for this same interaction won the
      // race (a real UNIQUE(interaction_id) collision on the calendar
      // statement, which rolls back this whole batch, meeting change
      // included) -- retry against a fresh read, which will now
      // correctly dispatch to reschedule/reopen instead of enroll.
      if (isUniqueConstraintViolation(error)) continue;
      throw error;
    }
    if ((results[prospectUpdateIndex]?.meta.changes ?? 0) >= 1) {
      // The meeting change and the calendar intent both committed
      // together, confirmed. The one remaining non-atomic step: an
      // actual best-effort attempt to reach Google, run only after the
      // above has already committed.
      await attemptBestEffortCalendarReconcile(userId, now);
      return { ok: true };
    }
    // The shared guard matched zero rows everywhere -- a concurrent
    // transition moved the calendar link's state out from under this
    // attempt before the batch ran. Nothing committed (every statement
    // shares the identical precondition), so looping to retry against a
    // fresh read is always safe.
  }
  return { ok: false, reason: "calendar_conflict" };
}

// AI Meeting Notes preservation (2026-10-21, see docs/AI-HANDOFF.md): true
// only when `summary` holds real content worth protecting -- empty/null,
// or exactly scheduleProspectMeeting's own generic placeholder for this
// donor, is nothing a later write could meaningfully destroy.
function isMeaningfulMeetingSummary(summary: string | null, donorDisplayName: string): boolean {
  if (!summary) return false;
  const trimmed = summary.trim();
  if (trimmed.length === 0) return false;
  return trimmed !== `Trip meeting scheduled with ${donorDisplayName}.`;
}

// "Marking a meeting Completed must require explicit confirmation of the
// outcome, including an actual meeting date and meaningful notes" --
// `meetingAt`/`notes` are already validated by the caller
// (trip-model.ts's validateMeetingCompletion) before this runs; this
// function additionally requires the same explicit `confirmed` flag as
// scheduling. Reuses the SAME linked interaction (upserted by id, exactly
// like scheduling above) when one already exists from a prior "Meeting
// Scheduled" step; creates one directly in the completed state when the
// fundraiser jumps straight to "Meeting Completed" without having
// scheduled it first (a real, legitimate case -- an impromptu meeting).
// Concurrency safety (2026-10-21, second follow-up review -- "lost notes
// during concurrent saves"): bounded, since a genuine, persistent
// collision (rather than a single losing race) must eventually surface
// as `notes_conflict` rather than retry forever.
const MAX_MEETING_NOTES_WRITE_ATTEMPTS = 5;

export async function completeProspectMeeting(userId: string, tripId: string, prospectId: string, meetingAtLocal: unknown, notes: string, confirmed: boolean, fallbackTimezone: string, now: number): Promise<StatusUpdateResult> {
  if (!confirmed) return { ok: false, reason: "confirmation_required" };
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  const meetingAt = await resolveMeetingEpoch(existing.donorId, meetingAtLocal, fallbackTimezone);
  if (meetingAt === null || !validateMeetingCompletion(meetingAt, notes, now).ok) return { ok: false, reason: "invalid_meeting_time" };
  const interactionId = existing.linkedInteractionId ?? tripMeetingInteractionId(prospectId);
  const originalSource = tripScheduledInteractionSource(tripId);
  const completedSource = tripCompletedInteractionSource(meetingAt, originalSource);
  const donor = await env.DB.prepare("SELECT display_name FROM donors WHERE id = ?").bind(existing.donorId).first<{ display_name: string }>();
  const donorDisplayName = donor?.display_name ?? "donor";
  const trimmedNotes = notes.trim();

  // Concurrency safety (2026-10-21, second follow-up review -- "lost
  // notes during concurrent saves"): the previous version of this
  // function read `summary`, computed an appended value in application
  // code, then wrote it back unconditionally -- a donor-profile edit or
  // a trip AI-notes save landing in that read-write gap would be
  // silently discarded. Every attempt below re-reads the CURRENT summary
  // immediately before writing, and the write is a compare-and-swap keyed
  // on that EXACT value (bound into the UPDATE's own WHERE clause) -- a
  // write only ever applies against the summary THIS attempt actually
  // saw, never a stale one. A CAS miss is not an error: it means someone
  // else wrote first, so this loops, re-reads the now-current value, and
  // recomputes its own append against THAT -- two genuinely concurrent
  // completions (or a completion racing a notes edit) both end up
  // applied, in whichever order their writes actually land, never one
  // silently destroying the other. The companion trip_prospects write
  // shares the identical precondition (an EXISTS check against the
  // POST-write summary, visible to it because D1 batch statements
  // observe earlier statements' own writes within the same batch -- the
  // same property scheduleProspectMeeting's own calendar guard already
  // relies on) -- so the meeting is never recorded/reported as completed
  // unless the notes write itself actually committed.
  for (let attempt = 1; attempt <= MAX_MEETING_NOTES_WRITE_ATTEMPTS; attempt++) {
    // Re-read by `interactionId` (the stable id this whole function
    // writes under -- either the real linked id, or, when there was
    // none, the SAME deterministic fallback the INSERT below uses),
    // fresh on EVERY attempt -- never by `existing.linkedInteractionId`,
    // which is a snapshot taken once before this loop even started.
    // Fourth follow-up review fix: a first-time completion (no prior
    // "Meeting Scheduled" step, so `existing.linkedInteractionId` is
    // null) that loses the INSERT race below to a concurrent first-time
    // completion must see that THAT interaction now exists on its very
    // next attempt and switch to the append branch -- re-checking the
    // stale pre-loop `null` forever would repeat the same failing
    // INSERT until this loop's attempts ran out, silently losing this
    // attempt's own notes.
    const existingInteraction = await env.DB.prepare("SELECT summary FROM interactions WHERE id = ? AND user_id = ? AND donor_id = ?")
      .bind(interactionId, userId, existing.donorId).first<{ summary: string | null }>();

    if (!existingInteraction) {
      // Nothing exists for this interaction id yet -- a plain INSERT,
      // deliberately never ON CONFLICT DO UPDATE, so a genuinely
      // concurrent first-time completion (no prior "Meeting Scheduled"
      // step -- an impromptu meeting) for this SAME prospect conflicts
      // loudly on the shared deterministic id rather than one silently
      // overwriting the other's notes.
      const summary = `Trip meeting with ${donorDisplayName}.\n${notes}`;
      try {
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
              VALUES (?, ?, ?, 'meeting', ?, ?, ?, ?, ?)`)
            .bind(interactionId, existing.donorId, userId, meetingAt, summary, completedSource, now, now),
          env.DB.prepare("UPDATE trip_prospects SET status = 'meeting_completed', meeting_at = ?, linked_interaction_id = ?, updated_at = ? WHERE id = ?")
            .bind(meetingAt, interactionId, now, prospectId),
        ]);
        return { ok: true };
      } catch (error) {
        // A concurrent first-time completion (or a concurrent
        // scheduleProspectMeeting call) won the race on this exact id.
        // Retry against a fresh read, which will now correctly take the
        // "existing interaction" branch below and append rather than
        // trying (and failing) to insert again.
        if (isUniqueConstraintViolation(error)) continue;
        throw error;
      }
    }

    // AI Meeting Notes preservation (2026-10-21, see docs/AI-HANDOFF.md):
    // this required "what happened" note must never silently replace
    // real notes already saved on this SAME linked interaction -- only
    // ever append alongside them. Only the two cases with nothing real
    // to lose -- empty, or exactly scheduleProspectMeeting's own generic
    // placeholder -- write the summary in full, exactly as before.
    const priorSummary = existingInteraction.summary ?? "";
    const hasExistingNotes = isMeaningfulMeetingSummary(existingInteraction.summary, donorDisplayName);
    // Retry-safety: an identical retry (same notes text, already applied
    // by an earlier attempt of THIS loop, or a genuine network-level
    // retry of the whole request) must never append a second, duplicate
    // block -- checked by whether the existing summary's own tail
    // already ends with this exact notes text, independent of the
    // timestamp in the appended marker (which would otherwise differ
    // across attempts and defeat a naive whole-string comparison).
    const alreadyAppended = hasExistingNotes && priorSummary.trimEnd().endsWith(trimmedNotes);
    const summary = !hasExistingNotes
      ? `Trip meeting with ${donorDisplayName}.\n${notes}`
      : alreadyAppended
        ? priorSummary
        : `${priorSummary}\n\n--- Marked completed ${new Date(now * 1000).toISOString().slice(0, 10)} ---\n${notes}`;

    if (alreadyAppended) {
      // Nothing to write -- the current row already reflects this exact
      // save. Still move the prospect's own status forward (a plain,
      // unconditional, idempotent update -- there is no notes write to
      // guard here).
      await env.DB.prepare("UPDATE trip_prospects SET status = 'meeting_completed', meeting_at = ?, linked_interaction_id = ?, updated_at = ? WHERE id = ?")
        .bind(meetingAt, interactionId, now, prospectId).run();
      return { ok: true };
    }

    // Concurrency safety (2026-10-21, fourth follow-up review -- closing
    // a real atomicity bug the third follow-up review's own fix
    // introduced). That fix ran the interactions UPDATE ALONE via
    // `.run()`, then -- only once its own rowcount proved the CAS
    // applied -- ran the trip_prospects UPDATE as a SEPARATE `.run()`
    // call, reasoning that a bare EXISTS-on-end-state guard could not be
    // trusted (correct) but missing that two separate commits are not
    // one transaction either: had the trip_prospects write somehow
    // failed, the notes UPDATE would already have committed with
    // nothing to undo it. The two writes now run in ONE `env.DB.batch()`
    // call -- one real transaction -- with the trip_prospects write
    // gated on `write_token`, the SAME fresh-per-attempt-random-value
    // mechanism lib/meeting-notes/concurrent-save.ts and
    // lib/capture/interaction-edit.ts use (see drizzle/0052): the
    // interactions UPDATE stamps it as part of its own CAS'd SET clause,
    // and the trip_prospects UPDATE proves that EXACT statement applied,
    // in this SAME transaction, via
    // `EXISTS (... interactions WHERE id = ? AND write_token = ?)` --
    // never by matching the computed summary TEXT (two unrelated writes
    // can coincidentally produce the same text) and never by chaining
    // the SQL `changes()` function past an intervening statement.
    // The primary statement's own CAS also requires the target
    // trip_prospects row to still exist -- so that if it vanished (e.g.
    // a concurrent "Remove from trip") between this attempt's read and
    // this write, the interactions UPDATE itself does not apply either.
    // Without this, the companion write below could fail to match for a
    // reason that has nothing to do with the write_token gate (the
    // row's own `WHERE id = ?` finding nothing), leaving the notes
    // UPDATE committed alone with no prospect to mark completed.
    const writeToken = crypto.randomUUID();
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE interactions SET summary = ?, occurred_at = ?, source = ?, write_token = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND donor_id = ? AND summary = ? AND EXISTS (SELECT 1 FROM trip_prospects WHERE id = ?)`)
        .bind(summary, meetingAt, completedSource, writeToken, now, interactionId, userId, existing.donorId, priorSummary, prospectId),
      env.DB.prepare(`UPDATE trip_prospects SET status = 'meeting_completed', meeting_at = ?, linked_interaction_id = ?, updated_at = ?
          WHERE id = ? AND EXISTS (SELECT 1 FROM interactions WHERE id = ? AND write_token = ?)`)
        .bind(meetingAt, interactionId, now, prospectId, interactionId, writeToken),
    ]) as unknown as Array<{ meta: { changes?: number } }>;

    if ((results[0]?.meta.changes ?? 0) > 0) {
      // Proven to have applied, together with the prospect's status in
      // the SAME transaction. "Completion retains calendar history" --
      // deliberately no calendar call here at all (the core's own
      // recordComplete() is an intentional no-op; see
      // calendar-sync-reconciler.ts's own doc comment). The meeting's
      // existing calendar link/history, if any, is left completely
      // untouched by marking it completed.
      return { ok: true };
    }
    // The summary changed between our read and this write (a competing
    // completion, or a donor-profile/trip-notes edit) -- nothing
    // committed (the trip_prospects write's own gate read false too, in
    // this SAME transaction, so it never reports a completion the notes
    // write itself did not actually land). Loop and retry against the
    // now-current value.
  }
  return { ok: false, reason: "notes_conflict" };
}

// AI Meeting Notes, reachable from a trip prospect's own card (2026-10-21,
// see docs/AI-HANDOFF.md). The SAME `interactions` row the trip meeting
// flow already created/links via `trip_prospects.linked_interaction_id`
// (scheduleProspectMeeting/completeProspectMeeting above) -- never a
// second, trip-only copy of the notes, and never guessed by donor/date.
// `linked_interaction_id` is only ever set once the prospect reaches
// meeting_scheduled/meeting_completed (the two statuses that write a real
// interaction -- see statusRequiresInteraction()); a prospect that hasn't
// reached either yet has no reliable interaction to attach notes to, so
// this returns `{ ok: false, reason: "no_meeting_yet" }` rather than
// fabricating one -- the caller (the API route and the page) must not
// create an interaction here.
export type ProspectMeetingNotesTarget =
  | { ok: true; donorId: string; donorDisplayName: string; interactionId: string; existingSummary: string }
  | { ok: false; reason: "not_found" | "no_meeting_yet" };

export async function getProspectMeetingNotesTarget(userId: string, tripId: string, prospectId: string): Promise<ProspectMeetingNotesTarget> {
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (!existing.linkedInteractionId) return { ok: false, reason: "no_meeting_yet" };
  // Re-confirmed directly (not merely trusted from trip_prospects) --
  // the same "never guess, always re-verify the real row" discipline
  // every other write path in this file already uses for its own linked
  // interaction (e.g. setSimpleProspectStatus's own re-read above).
  const interaction = await env.DB.prepare("SELECT summary FROM interactions WHERE id = ? AND user_id = ? AND donor_id = ?")
    .bind(existing.linkedInteractionId, userId, existing.donorId).first<{ summary: string }>();
  if (!interaction) return { ok: false, reason: "no_meeting_yet" };
  const donor = await env.DB.prepare("SELECT display_name FROM donors WHERE id = ?").bind(existing.donorId).first<{ display_name: string }>();
  return { ok: true, donorId: existing.donorId, donorDisplayName: donor?.display_name ?? "Donor", interactionId: existing.linkedInteractionId, existingSummary: interaction.summary };
}

export type ProspectFieldUpdate = { tripNotes?: string | null; nextAction?: string | null; manualRank?: number | null; meetingLocation?: string | null };

export async function updateProspectFields(userId: string, tripId: string, prospectId: string, update: ProspectFieldUpdate, now: number): Promise<boolean> {
  const existing = await ownedProspect(userId, tripId, prospectId);
  if (!existing) return false;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if ("tripNotes" in update) { sets.push("trip_notes = ?"); values.push(update.tripNotes ?? null); }
  if ("nextAction" in update) { sets.push("next_action = ?"); values.push(update.nextAction ?? null); }
  if ("manualRank" in update) { sets.push("manual_rank = ?"); values.push(update.manualRank ?? null); }
  if ("meetingLocation" in update) { sets.push("meeting_location = ?"); values.push(update.meetingLocation ?? null); }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  values.push(now);
  await env.DB.prepare(`UPDATE trip_prospects SET ${sets.join(", ")} WHERE id = ?`).bind(...values, prospectId).run();
  return true;
}

export async function updateTrip(userId: string, tripId: string, update: { name?: string; status?: TripStatus; goalCents?: number | null; notes?: string | null; startDate?: number; endDate?: number }, now: number): Promise<boolean> {
  const existing = await getTrip(userId, tripId);
  if (!existing) return false;
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (update.name !== undefined) { sets.push("name = ?"); values.push(update.name); }
  if (update.status !== undefined) { sets.push("status = ?"); values.push(update.status); }
  if (update.goalCents !== undefined) { sets.push("fundraising_goal_cents = ?"); values.push(update.goalCents); }
  if (update.notes !== undefined) { sets.push("notes = ?"); values.push(update.notes); }
  if (update.startDate !== undefined) { sets.push("start_date = ?"); values.push(update.startDate); }
  if (update.endDate !== undefined) { sets.push("end_date = ?"); values.push(update.endDate); }
  if (sets.length === 0) return true;
  sets.push("updated_at = ?");
  values.push(now);
  await env.DB.prepare(`UPDATE trips SET ${sets.join(", ")} WHERE id = ? AND owner_user_id = ?`).bind(...values, tripId, userId).run();
  return true;
}

// Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
// This section is the only place this file writes to giving_activities
// (via the shared lib/giving/pending-records.ts helpers, reused
// verbatim, never a parallel insert) or to the new, additive
// trip_financial_attributions link table (drizzle/0046) -- it NEVER
// writes to committed_cents/paid_cents/balance_cents on an EXISTING
// giving_activities row; attributing/removing only changes which trip a
// record is linked to, never the financial record itself.

export type EligibleGivingActivity = {
  id: string; category: string; workspaceStatus: string;
  committedCents: number | null; paidCents: number | null; balanceCents: number | null;
  activityDate: number | null; description: string | null;
};

// A donor's own giving_activities rows that are real financial records
// (REAL_COMMITMENT_CATEGORIES) or an unconfirmed pending gift/pledge, and
// are NOT already actively attributed to any trip (the trip_financial_
// attributions unique-partial-index is the actual structural guard; this
// query exists only so the "associate existing" picker never even offers
// an already-attributed record). owner_user_id-scoped, matching every
// other donor-financial query in this codebase.
export async function listEligibleGivingActivitiesForDonor(userId: string, donorId: string): Promise<EligibleGivingActivity[]> {
  const result = await env.DB.prepare(`SELECT ga.id, ga.category, ga.workspace_status, ga.committed_cents, ga.paid_cents, ga.balance_cents, ga.activity_date, ga.description
      FROM giving_activities ga
      WHERE ga.owner_user_id = ? AND ga.donor_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active'
        AND ga.category IN ('open_pledge','partially_paid_pledge','completed_gift','pending_gift','pending_pledge')
        AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa WHERE tfa.giving_activity_id = ga.id AND tfa.removed_at IS NULL)
        -- Pending-Gift Reconciliation Fix (2026-10-15, see docs/AI-HANDOFF.md):
        -- never offer a record that is the JL-import confirmation target
        -- (confirmed_by_activity_id) of an ALREADY-attributed pending gift
        -- as if it were a separate, unattributed opportunity. Without this,
        -- "Associate existing" could double-attribute the same real dollars
        -- under two attribution rows -- one via the merged pending_gift
        -- record (resolved at read time to this same confirmed activity's
        -- figures, see listTripFinancialAttributions below), one directly.
        AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa JOIN giving_activities pending ON pending.id = tfa.giving_activity_id WHERE pending.confirmed_by_activity_id = ga.id AND tfa.removed_at IS NULL)
      ORDER BY ga.activity_date DESC`).bind(userId, donorId)
    .all<{ id: string; category: string; workspace_status: string; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; description: string | null }>();
  return result.results.map((row) => ({ id: row.id, category: row.category, workspaceStatus: row.workspace_status, committedCents: row.committed_cents, paidCents: row.paid_cents, balanceCents: row.balance_cents, activityDate: row.activity_date, description: row.description }));
}

export type ReconcilableAttribution = { attributionId: string; category: string; committedCents: number | null; donorConfirmedAt: number | null; createdAt: number };

export type AttributeResult =
  | { ok: true; attributionId: string }
  | { ok: false; reason: "prospect_not_found" | "giving_activity_not_found" | "already_attributed" | "invalid_commitment_kind" | "reconciliation_target_not_found" }
  // Ambiguous-match guard (2026-10-20, see docs/AI-HANDOFF.md): returned
  // instead of silently picking a candidate, every time at least one
  // active pending (not-yet-JL) trip entry exists for this same donor on
  // this same trip when a REAL record is being attributed -- the task's
  // own "do not automatically match solely by donor and amount where
  // multiple records could qualify." `candidates` is attached so the
  // caller can present the exact choice without a second round trip.
  | { ok: false; reason: "reconciliation_choice_required"; candidates: ReconcilableAttribution[] };

export type AttributeGivingActivityOptions = {
  // Defaults to "new_commitment" -- every attribution made before this
  // round behaves identically under that default.
  commitmentKind?: TripCommitmentKind;
  // Only meaningful (and only ever persisted) when commitmentKind is
  // "preexisting_pledge_collection" -- see trip-financial-attribution.ts's
  // own doc comment on why this is never read from or written to the
  // underlying giving_activities row.
  reportedCashCollectedCents?: number | null;
  // "none": an explicit choice that this is a deliberate, separate,
  // additional commitment -- never reconciling any existing pending
  // entry for this donor on this trip. A specific attributionId: the
  // exact pending entry (from listReconcilableTripAttributions) this new,
  // real attribution reconciles -- that entry is atomically soft-removed
  // (reason "Reconciled with JL-imported record") in the SAME write, so
  // the commitment counts exactly once. Omitted entirely is only valid
  // when zero reconcilable candidates exist for this donor+trip.
  reconcilesAttributionId?: string | "none" | null;
};

// Attributes an EXISTING giving_activities row to a trip, scoped to one
// trip_prospects row (so the donor must already be a tracked prospect on
// this trip -- the "ownership checks" the task asks for). The giving
// activity must belong to the SAME donor and the SAME owner. The unique
// partial index on trip_financial_attributions (giving_activity_id WHERE
// removed_at IS NULL) is the real double-counting guard -- caught here
// as `already_attributed` rather than a raw constraint error surfacing
// to the caller.
export async function attributeGivingActivityToTrip(userId: string, tripId: string, prospectId: string, givingActivityId: string, note: string | null, now: number, options: AttributeGivingActivityOptions = {}): Promise<AttributeResult> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  const givingActivity = await env.DB.prepare("SELECT id, category FROM giving_activities WHERE id = ? AND owner_user_id = ? AND donor_id = ?").bind(givingActivityId, userId, prospect.donorId).first<{ id: string; category: string }>();
  if (!givingActivity) return { ok: false, reason: "giving_activity_not_found" };
  // Pending-Gift Reconciliation Fix (2026-10-15, see docs/AI-HANDOFF.md):
  // the real structural guard against double-attributing one confirmed
  // record under two rows -- never rely on listEligibleGivingActivitiesForDonor's
  // exclusion alone, since this endpoint can be called directly with any
  // givingActivityId. Rejected exactly like an already-attributed record.
  const shadowOfAttributedPending = await env.DB.prepare(`SELECT 1 FROM trip_financial_attributions tfa JOIN giving_activities pending ON pending.id = tfa.giving_activity_id WHERE pending.confirmed_by_activity_id = ? AND tfa.removed_at IS NULL LIMIT 1`).bind(givingActivityId).first();
  if (shadowOfAttributedPending) return { ok: false, reason: "already_attributed" };

  const commitmentKind: TripCommitmentKind = options.commitmentKind ?? "new_commitment";
  // A record that does not exist in JL yet (pending_gift/pending_pledge)
  // cannot be "pre-existing" -- recordPendingGiftAndAttribute/
  // recordPendingPledgeAndAttribute always create a brand-new row by
  // construction, so this only ever guards a direct/misused call.
  if (commitmentKind === "preexisting_pledge_collection" && !REAL_COMMITMENT_CATEGORIES.has(givingActivity.category)) {
    return { ok: false, reason: "invalid_commitment_kind" };
  }

  // Ambiguous-match guard: attributing a REAL record never silently
  // reconciles an existing pending trip entry solely by donor and amount.
  // The caller's own explicit choice (not "whether candidates happen to
  // still be non-empty") is what decides this -- an explicitly-named
  // target that is no longer among the freshly-read candidates (already
  // reconciled or removed by someone else since the caller last saw the
  // list) is rejected outright, never silently reinterpreted as "no
  // candidates, so this must be a separate commitment" (Reconciliation
  // Concurrency Fix, 2026-10-21, see docs/AI-HANDOFF.md -- a real
  // defect this round fixes: the previous version gated this ENTIRE
  // block on `candidates.length > 0`, so a stale explicit
  // reconcilesAttributionId silently fell through to "new, separate
  // commitment" the moment candidates had already emptied out).
  let reconciles: ReconcilableAttribution | null = null;
  if (REAL_COMMITMENT_CATEGORIES.has(givingActivity.category)) {
    const candidates = await listReconcilableTripAttributions(userId, tripId, prospect.donorId);
    const requestedReconcileId = options.reconcilesAttributionId;
    if (requestedReconcileId === undefined || requestedReconcileId === null) {
      if (candidates.length > 0) return { ok: false, reason: "reconciliation_choice_required", candidates };
    } else if (requestedReconcileId !== "none") {
      reconciles = candidates.find((candidate) => candidate.attributionId === requestedReconcileId) ?? null;
      if (!reconciles) return { ok: false, reason: "reconciliation_target_not_found" };
    }
  }

  const id = crypto.randomUUID();
  const reportedCashCollectedCents = commitmentKind === "preexisting_pledge_collection" ? (options.reportedCashCollectedCents ?? 0) : null;
  try {
    // Reconciliation Concurrency Fix (2026-10-21, see docs/AI-HANDOFF.md):
    // the read above can go stale before this write runs -- two
    // concurrent requests can both read the SAME pending attribution as
    // a valid candidate, then each try to reconcile it under a
    // DIFFERENT new real attribution. An atomic batch alone does not
    // stop this: it only guarantees THIS request's own insert-and-retire
    // happen together, never that the thing it read moments earlier is
    // still true. Two real, database-enforced mechanisms close it,
    // together, at the write boundary itself, never trusting the
    // earlier read:
    //   1. The INSERT is conditional (`WHERE EXISTS`) on the target
    //      pending attribution STILL being active, re-checked fresh
    //      inside this SAME transaction -- if it vanished for ANY
    //      reason (reconciled by a competing request, or separately
    //      removed) between the read above and now, the INSERT itself
    //      inserts zero rows, checked below.
    //   2. `trip_financial_attributions_active_reconciled_pending_uidx`
    //      (drizzle/0051) is a real UNIQUE index: at most one ACTIVE
    //      attribution can ever claim to reconcile a given pending id.
    //      If this request's own EXISTS check raced past a competitor's
    //      (impossible under D1's serialized writes, but never assumed
    //      true by construction alone), the second INSERT still fails
    //      on this constraint, and the whole batch rolls back -- never
    //      a moment with two active attributions for one commitment.
    // The retiring UPDATE uses the identical `WHERE ... removed_at IS
    // NULL` guard, so it can only ever retire the SAME row the INSERT's
    // own EXISTS check just confirmed was still active -- both read the
    // same consistent transactional snapshot, so the INSERT succeeding
    // guarantees the UPDATE affects exactly the one row intended.
    const statements = reconciles
      ? [
          env.DB.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, note, commitment_kind, reported_cash_collected_cents, reconciled_pending_attribution_id, created_at)
              SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM trip_financial_attributions WHERE id = ? AND removed_at IS NULL)`)
            .bind(id, userId, tripId, prospect.donorId, givingActivityId, note, commitmentKind, reportedCashCollectedCents, reconciles.attributionId, now, reconciles.attributionId),
          env.DB.prepare(`UPDATE trip_financial_attributions SET removed_at = ?, removed_reason = 'Reconciled with JL-imported record' WHERE id = ? AND removed_at IS NULL`)
            .bind(now, reconciles.attributionId),
        ]
      : [
          env.DB.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, note, commitment_kind, reported_cash_collected_cents, reconciled_pending_attribution_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(id, userId, tripId, prospect.donorId, givingActivityId, note, commitmentKind, reportedCashCollectedCents, null, now),
        ];
    const results = await env.DB.batch(statements) as unknown as Array<{ meta: { changes?: number } }>;
    if (reconciles && (results[0]?.meta.changes ?? 0) === 0) {
      // The EXISTS check failed -- the chosen target stopped being a
      // valid reconciliation target between the read above and this
      // write (reconciled by a competing request, or separately
      // removed). Nothing was inserted (the conditional INSERT is a
      // true no-op in this case) and nothing needs cleaning up; this is
      // reported exactly like a target that was already stale at read
      // time, never silently treated as a separate commitment.
      return { ok: false, reason: "reconciliation_target_not_found" };
    }
    return { ok: true, attributionId: id };
  } catch (error) {
    // The backstop half of the concurrency fix above: a UNIQUE
    // constraint violation on reconciled_pending_attribution_id means a
    // competing request's own insert already claimed this exact
    // reconciliation target (the two-different-real-records-racing-for-
    // the-same-pending-entry case) -- reported the same way as any other
    // reason the target is no longer valid, never the unrelated
    // "already_attributed" (which means the giving_activity_id itself,
    // not the reconciliation target, is already claimed).
    if (reconciles && isReconciledPendingUniqueViolation(error)) return { ok: false, reason: "reconciliation_target_not_found" };
    return { ok: false, reason: "already_attributed" };
  }
}

const RECONCILED_PENDING_UNIQUE_VIOLATION_PATTERN = /UNIQUE constraint failed.*reconciled_pending_attribution_id/i;
function isReconciledPendingUniqueViolation(error: unknown): boolean {
  if (error instanceof Error) {
    if (RECONCILED_PENDING_UNIQUE_VIOLATION_PATTERN.test(error.message)) return true;
    if (error.cause instanceof Error && RECONCILED_PENDING_UNIQUE_VIOLATION_PATTERN.test(error.cause.message)) return true;
  }
  return false;
}

// Reconciliation candidates (2026-10-20, see docs/AI-HANDOFF.md): every
// ACTIVE attribution on this SAME trip, for this SAME donor, whose
// underlying (possibly import-resolved) category is still pending_gift/
// pending_pledge -- i.e. every not-yet-JL-confirmed trip entry for this
// donor that a newly attributed REAL record could be reconciling. Reuses
// the exact same merge-resolution CASE/LEFT JOIN as
// listTripFinancialAttributions, so a pending_gift that has ALREADY
// auto-resolved via JL's own pending-gift reconciliation (lib/giving/
// management.ts's CONFIRM_PENDING_GIFT_SQL) is correctly excluded here
// too -- it is no longer "pending" at all, so a fundraiser is never asked
// to manually reconcile something that already reconciled itself.
export async function listReconcilableTripAttributions(userId: string, tripId: string, donorId: string): Promise<ReconcilableAttribution[]> {
  const result = await env.DB.prepare(`SELECT tfa.id AS attribution_id,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.category ELSE ga.category END AS category,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.committed_cents ELSE ga.committed_cents END AS committed_cents,
        tfa.donor_confirmed_at, tfa.created_at
      FROM trip_financial_attributions tfa
      JOIN giving_activities ga ON ga.id = tfa.giving_activity_id
      LEFT JOIN giving_activities confirmed ON confirmed.id = ga.confirmed_by_activity_id AND confirmed.owner_user_id = tfa.user_id
      WHERE tfa.trip_id = ? AND tfa.donor_id = ? AND tfa.user_id = ? AND tfa.removed_at IS NULL
      ORDER BY tfa.created_at ASC`).bind(tripId, donorId, userId)
    .all<{ attribution_id: string; category: string; committed_cents: number | null; donor_confirmed_at: number | null; created_at: number }>();
  return result.results
    .filter((row) => row.category === "pending_gift" || row.category === "pending_pledge")
    .map((row) => ({ attributionId: row.attribution_id, category: row.category, committedCents: row.committed_cents, donorConfirmedAt: row.donor_confirmed_at, createdAt: row.created_at }));
}

export type ConfirmAttributionResult = { ok: true } | { ok: false; reason: "not_found" | "not_applicable" };

// Marks an EXISTING pending trip entry donor-confirmed WITHOUT recreating
// it (2026-10-20, see docs/AI-HANDOFF.md) -- the task's own explicit
// "provide a way to mark an existing entry confirmed without recreating
// it." Idempotent: confirming an already-confirmed entry is a no-op
// success, never an error. Restricted to attributions whose underlying
// (possibly import-resolved) category is still pending_gift/pending_pledge
// -- an already-real category is already confirmed by JL itself and has
// nothing for this action to do. Never changes any existing entry's
// confirmation on its own; only an explicit call does.
export async function confirmTripAttribution(userId: string, tripId: string, attributionId: string, now: number): Promise<ConfirmAttributionResult> {
  const row = await env.DB.prepare(`SELECT tfa.id, tfa.donor_confirmed_at,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.category ELSE ga.category END AS category
      FROM trip_financial_attributions tfa
      JOIN giving_activities ga ON ga.id = tfa.giving_activity_id
      LEFT JOIN giving_activities confirmed ON confirmed.id = ga.confirmed_by_activity_id AND confirmed.owner_user_id = tfa.user_id
      JOIN trips t ON t.id = tfa.trip_id
      WHERE tfa.id = ? AND tfa.trip_id = ? AND tfa.removed_at IS NULL AND t.owner_user_id = ?`)
    .bind(attributionId, tripId, userId).first<{ id: string; donor_confirmed_at: number | null; category: string }>();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.category !== "pending_gift" && row.category !== "pending_pledge") return { ok: false, reason: "not_applicable" };
  if (row.donor_confirmed_at) return { ok: true };
  await env.DB.prepare("UPDATE trip_financial_attributions SET donor_confirmed_at = ? WHERE id = ?").bind(now, attributionId).run();
  return { ok: true };
}

// The reverse of confirmTripAttribution -- correcting a confirmation
// made in error, without recreating or removing the attribution itself.
// Same restriction and idempotence (unconfirming an already-unconfirmed
// entry is a no-op success).
export async function unconfirmTripAttribution(userId: string, tripId: string, attributionId: string): Promise<ConfirmAttributionResult> {
  const row = await env.DB.prepare(`SELECT tfa.id, tfa.donor_confirmed_at,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.category ELSE ga.category END AS category
      FROM trip_financial_attributions tfa
      JOIN giving_activities ga ON ga.id = tfa.giving_activity_id
      LEFT JOIN giving_activities confirmed ON confirmed.id = ga.confirmed_by_activity_id AND confirmed.owner_user_id = tfa.user_id
      JOIN trips t ON t.id = tfa.trip_id
      WHERE tfa.id = ? AND tfa.trip_id = ? AND tfa.removed_at IS NULL AND t.owner_user_id = ?`)
    .bind(attributionId, tripId, userId).first<{ id: string; donor_confirmed_at: number | null; category: string }>();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.category !== "pending_gift" && row.category !== "pending_pledge") return { ok: false, reason: "not_applicable" };
  if (!row.donor_confirmed_at) return { ok: true };
  await env.DB.prepare("UPDATE trip_financial_attributions SET donor_confirmed_at = NULL WHERE id = ?").bind(attributionId).run();
  return { ok: true };
}

export type TripFinancialAttributionRow = {
  attributionId: string; givingActivityId: string; donorId: string | null; prospectId: string; donorDisplayName: string;
  category: string; workspaceStatus: string; committedCents: number | null; paidCents: number | null; balanceCents: number | null;
  note: string | null; createdAt: number;
  // True for a commitment recorded against an unlinked (not-yet-in-FOS)
  // prospect (lib/relationships/trips-data.ts's trip_prospect_commitments
  // table) -- never a real giving_activities row. Presentation-only, same
  // convention as resolvedViaImportMatch below: summarizeTripFinancials
  // never reads it, and every money/status field above already carries
  // the right value either way.
  isUnlinkedProspectCommitment: boolean;
  // Pending-Gift Reconciliation Fix (2026-10-15, see docs/AI-HANDOFF.md):
  // true when the attributed record was itself a pending_gift that the JL
  // import's own reconciliation (CONFIRM_PENDING_GIFT_SQL, lib/giving/
  // management.ts) has since matched to a confirmed donation -- every
  // other field above is already the CONFIRMED record's own live figures
  // in that case (see the function below that fills this type), never the
  // stale pending snapshot. Presentation-only -- summarizeTripFinancials
  // never reads this flag.
  resolvedViaImportMatch: boolean;
  // Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md) --
  // see trip-financial-attribution.ts's AttributedGivingRecord for the
  // exact meaning of each of these three fields.
  donorConfirmedAt: number | null;
  commitmentKind: TripCommitmentKind;
  reportedCashCollectedCents: number | null;
  reconciledPendingAttributionId: string | null;
};

// Every ACTIVE (removed_at IS NULL) attribution for this trip, with every
// financial field read LIVE from giving_activities at query time -- never
// a snapshot, so a later payment, correction, or category change on the
// underlying record is reflected automatically with zero extra code.
//
// Pending-Gift Reconciliation Fix (2026-10-15, independent review, see
// docs/AI-HANDOFF.md): a pending_gift this feature attributed to a trip
// can later be matched by the JL import's own pending-gift reconciliation
// (lib/giving/management.ts's CONFIRM_PENDING_GIFT_SQL) to a brand-new,
// separate giving_activities row -- the import NEVER rewrites or deletes
// the original pending_gift row; it only flips that SAME row to
// workspace_status='merged' and stamps confirmed_by_activity_id with the
// new row's id (see app/api/import/route.ts's pendingMergeStatements).
// The trip_financial_attributions row keeps pointing at the original
// (now-merged) id -- deliberately NEVER rewritten here, since that would
// be an unnecessary write against a record the sensitive import pipeline
// also manages, and would dangle if the import were later rolled back
// (app/api/import/rollback/route.ts deletes the new row and restores the
// old one to active). Instead this LEFT JOIN resolves, AT READ TIME ONLY,
// to the confirmed row's own live category/workspace_status/committed_
// paid_/balance_cents whenever the attributed row has been merged and its
// confirmation target still exists -- so a trip's results reflect the
// real, now-confirmed gift automatically, with zero writes and nothing to
// go wrong if that import is ever rolled back (the LEFT JOIN simply stops
// matching and the original pending figures reappear, exactly as the
// rollback itself restores them). `confirmed.owner_user_id = tfa.user_id`
// defends against ever resolving to a record outside this same owner's
// workspace, even though CONFIRM_PENDING_GIFT_SQL can only ever stamp a
// same-owner, same-donor id by construction.
export async function listTripFinancialAttributions(userId: string, tripId: string): Promise<TripFinancialAttributionRow[]> {
  const result = await env.DB.prepare(`SELECT tfa.id AS attribution_id, tfa.giving_activity_id, tfa.donor_id, tp.id AS prospect_id, d.display_name AS donor_display_name,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.category ELSE ga.category END AS category,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.workspace_status ELSE ga.workspace_status END AS workspace_status,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.committed_cents ELSE ga.committed_cents END AS committed_cents,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.paid_cents ELSE ga.paid_cents END AS paid_cents,
        CASE WHEN ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL THEN confirmed.balance_cents ELSE ga.balance_cents END AS balance_cents,
        (ga.workspace_status = 'merged' AND confirmed.id IS NOT NULL) AS resolved_via_import_match,
        tfa.donor_confirmed_at, tfa.commitment_kind, tfa.reported_cash_collected_cents, tfa.reconciled_pending_attribution_id,
        tfa.note, tfa.created_at
      FROM trip_financial_attributions tfa
      JOIN giving_activities ga ON ga.id = tfa.giving_activity_id
      LEFT JOIN giving_activities confirmed ON confirmed.id = ga.confirmed_by_activity_id AND confirmed.owner_user_id = tfa.user_id
      JOIN donors d ON d.id = tfa.donor_id
      JOIN trips t ON t.id = tfa.trip_id
      JOIN trip_prospects tp ON tp.trip_id = tfa.trip_id AND tp.donor_id = tfa.donor_id
      WHERE tfa.trip_id = ? AND tfa.removed_at IS NULL AND t.owner_user_id = ?
      ORDER BY tfa.created_at DESC`).bind(tripId, userId)
    .all<{ attribution_id: string; giving_activity_id: string; donor_id: string; prospect_id: string; donor_display_name: string; category: string; workspace_status: string; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; resolved_via_import_match: number; donor_confirmed_at: number | null; commitment_kind: TripCommitmentKind; reported_cash_collected_cents: number | null; reconciled_pending_attribution_id: string | null; note: string | null; created_at: number }>();
  const realAttributions: TripFinancialAttributionRow[] = result.results.map((row) => ({
    attributionId: row.attribution_id, givingActivityId: row.giving_activity_id, donorId: row.donor_id, prospectId: row.prospect_id, donorDisplayName: row.donor_display_name,
    category: row.category, workspaceStatus: row.workspace_status, committedCents: row.committed_cents, paidCents: row.paid_cents, balanceCents: row.balance_cents,
    resolvedViaImportMatch: Boolean(row.resolved_via_import_match), isUnlinkedProspectCommitment: false,
    donorConfirmedAt: row.donor_confirmed_at, commitmentKind: row.commitment_kind, reportedCashCollectedCents: row.reported_cash_collected_cents,
    reconciledPendingAttributionId: row.reconciled_pending_attribution_id,
    note: row.note, createdAt: row.created_at,
  }));
  const unlinkedCommitments = await listActiveUnlinkedProspectCommitments(userId, tripId);
  return [...realAttributions, ...unlinkedCommitments].sort((a, b) => b.createdAt - a.createdAt);
}

// Unlinked-Prospect Fundraising (2026-10-25, see docs/AI-HANDOFF.md).
// Every ACTIVE, not-yet-migrated trip_prospect_commitments row for this
// trip, mapped into the exact same TripFinancialAttributionRow shape a
// real attribution uses -- "using the existing trip fundraising
// workflow," literally: summarizeTripFinancials (lib/relationships/
// trip-financial-attribution.ts) reads only plain fields already present
// on this shape and has no idea whether a given record came from here or
// from a real giving_activities join.
async function listActiveUnlinkedProspectCommitments(userId: string, tripId: string): Promise<TripFinancialAttributionRow[]> {
  const result = await env.DB.prepare(`SELECT c.id, c.prospect_id, tp.manual_name, c.category, c.committed_cents, c.note, c.donor_confirmed_at, c.created_at
      FROM trip_prospect_commitments c
      JOIN trip_prospects tp ON tp.id = c.prospect_id
      JOIN trips t ON t.id = c.trip_id
      WHERE c.trip_id = ? AND t.owner_user_id = ? AND c.removed_at IS NULL AND c.migrated_at IS NULL`)
    .bind(tripId, userId).all<{ id: string; prospect_id: string; manual_name: string | null; category: string; committed_cents: number; note: string | null; donor_confirmed_at: number | null; created_at: number }>();
  return result.results.map((row) => ({
    attributionId: row.id, givingActivityId: row.id, donorId: null, prospectId: row.prospect_id, donorDisplayName: row.manual_name ?? "Unlinked prospect",
    category: row.category, workspaceStatus: "unlinked_prospect", committedCents: row.committed_cents, paidCents: null, balanceCents: null,
    resolvedViaImportMatch: false, isUnlinkedProspectCommitment: true,
    donorConfirmedAt: row.donor_confirmed_at, commitmentKind: "new_commitment", reportedCashCollectedCents: null,
    reconciledPendingAttributionId: null, note: row.note, createdAt: row.created_at,
  }));
}

// Removes (soft) an attribution -- the task's own "view and correct trip
// attribution without modifying the underlying financial transaction":
// this NEVER touches the giving_activities row, only this link table.
// Scoped by trip ownership, never a bare attributionId lookup.
export async function removeTripFinancialAttribution(userId: string, tripId: string, attributionId: string, reason: string | null, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE trip_financial_attributions SET removed_at = ?, removed_reason = ?
      WHERE id = ? AND trip_id = ? AND removed_at IS NULL
        AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(now, reason, attributionId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0;
}

export type RecordAndAttributeResult =
  | { ok: true; activityId: string; attributionId: string }
  // The gift/pledge WAS recorded (a real giving_activities row exists)
  // but the automatic attribution step failed -- never silently dropped.
  // The caller shows this as "recorded, but use Associate Existing to
  // link it to this trip" rather than a bare failure, since
  // listEligibleGivingActivitiesForDonor will already offer it.
  | { ok: false; reason: "prospect_not_found"; activityId: null }
  | { ok: false; reason: "input_invalid"; error: string; activityId: null }
  | { ok: false; reason: "recorded_but_not_attributed"; activityId: string };

// "Record a new donation/pledge using the existing CRM financial
// workflow" (the task's own wording), from a trip prospect. Validates
// the prospect BEFORE recording anything, so an invalid trip/prospect
// never leaves an orphaned giving_activities row. Delegates the actual
// insert to lib/giving/pending-records.ts's insertPendingGift/
// insertPendingPledge -- the exact same code path the standalone
// app/api/giving/pending[-pledge] endpoints use -- then attributes the
// resulting record to this trip.
// Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md): the
// task's own core requirement -- "a confirmed pledge or donation counts
// toward trip results and goal progress immediately, even before it is
// imported from JL." `rawInput.confirmed === true` is the fundraiser's
// own explicit statement that the donor has confirmed this, made at the
// moment of recording it; anything else (omitted, false, any other
// value) leaves it an unconfirmed opportunity -- never assumed confirmed
// by default. confirmTripAttribution is called only after the record and
// its attribution both already exist, so a confirmation is never applied
// to a record that failed to attribute.
function donorConfirmedFlag(rawInput: unknown): boolean {
  return (rawInput as Record<string, unknown> | null)?.confirmed === true;
}

export async function recordPendingGiftAndAttribute(userId: string, tripId: string, prospectId: string, rawInput: unknown, now: number): Promise<RecordAndAttributeResult> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found", activityId: null };
  const inserted = await insertPendingGift(userId, { ...(rawInput as Record<string, unknown>), donorId: prospect.donorId });
  if (!inserted.ok) return { ok: false, reason: "input_invalid", error: inserted.error, activityId: null };
  const attribution = await attributeGivingActivityToTrip(userId, tripId, prospectId, inserted.activityId, null, now);
  if (!attribution.ok) return { ok: false, reason: "recorded_but_not_attributed", activityId: inserted.activityId };
  if (donorConfirmedFlag(rawInput)) await confirmTripAttribution(userId, tripId, attribution.attributionId, now);
  return { ok: true, activityId: inserted.activityId, attributionId: attribution.attributionId };
}

export async function recordPendingPledgeAndAttribute(userId: string, tripId: string, prospectId: string, rawInput: unknown, now: number): Promise<RecordAndAttributeResult> {
  const prospect = await ownedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found", activityId: null };
  const inserted = await insertPendingPledge(userId, { ...(rawInput as Record<string, unknown>), donorId: prospect.donorId });
  if (!inserted.ok) return { ok: false, reason: "input_invalid", error: inserted.error, activityId: null };
  const attribution = await attributeGivingActivityToTrip(userId, tripId, prospectId, inserted.activityId, null, now);
  if (!attribution.ok) return { ok: false, reason: "recorded_but_not_attributed", activityId: inserted.activityId };
  if (donorConfirmedFlag(rawInput)) await confirmTripAttribution(userId, tripId, attribution.attributionId, now);
  return { ok: true, activityId: inserted.activityId, attributionId: attribution.attributionId };
}

// ============================================================================
// Manually Added Prospects (2026-10-25, see docs/AI-HANDOFF.md). A trip
// prospect that is NOT yet in FOS -- donor_id IS NULL, identified only by
// the manual_* columns added by drizzle/0054. Everything below is scoped
// to exactly that case; every function above this point continues to
// operate only on linked (donor_id IS NOT NULL) prospects exactly as
// before -- none of them are modified by this round.
// ============================================================================

export type ManualProspectInput = { name: string; city: string | null; regionId: TravelRegionId | null; phone: string | null; email: string | null; notes: string | null };
export type AddManualProspectResult = { ok: true; prospectId: string } | { ok: false; reason: "trip_not_found" };

// The one, explicit "Add a prospect manually" action -- parallels
// selectTripProspect()'s own role for a real FOS donor. `added_method`
// is 'manual' for the same reason an out-of-region donor search result
// is: this was never auto-matched to the trip's destination region.
// `selected_at` is set immediately, same convention as every other
// deliberate add this feature already makes (selectTripProspect's own
// doc comment) -- a manually entered prospect is, by construction,
// always a deliberate outreach target, never an ambiguous candidate.
export type ProspectLinkState = "linked" | "unlinked" | "not_found";

// A thin, read-only check used by the route layer to decide which pair
// of functions (the real, donor-linked ones above, or the unlinked-
// prospect ones below) a status/meeting-scheduling request belongs to.
export async function prospectLinkState(userId: string, tripId: string, prospectId: string): Promise<ProspectLinkState> {
  const row = await env.DB.prepare(`SELECT tp.donor_id FROM trip_prospects tp JOIN trips t ON t.id = tp.trip_id
      WHERE tp.id = ? AND tp.trip_id = ? AND t.owner_user_id = ?`).bind(prospectId, tripId, userId)
    .first<{ donor_id: string | null }>();
  if (!row) return "not_found";
  return row.donor_id === null ? "unlinked" : "linked";
}

export async function addManualProspect(userId: string, tripId: string, input: ManualProspectInput, now: number): Promise<AddManualProspectResult> {
  const trip = await getTrip(userId, tripId);
  if (!trip) return { ok: false, reason: "trip_not_found" };
  const prospectId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO trip_prospects (id, trip_id, donor_id, manual_name, manual_city, manual_region_id, manual_phone, manual_email, manual_notes, added_method, status, selected_at, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'manual', 'not_contacted', ?, ?, ?)`)
    .bind(prospectId, tripId, input.name, input.city, input.regionId, input.phone, input.email, input.notes, now, now, now).run();
  return { ok: true, prospectId };
}

type UnlinkedProspect = {
  id: string; manualName: string; manualCity: string | null; manualRegionId: string | null; manualPhone: string | null; manualEmail: string | null; manualNotes: string | null;
};

// Scoped by `donor_id IS NULL` directly in the WHERE clause (never just
// checked afterward) -- an already-linked prospect id, or one belonging
// to another owner's trip, both return null identically, exactly like
// ownedProspect()'s own ownership scoping above.
async function ownedUnlinkedProspect(userId: string, tripId: string, prospectId: string): Promise<UnlinkedProspect | null> {
  const row = await env.DB.prepare(`SELECT tp.id, tp.manual_name, tp.manual_city, tp.manual_region_id, tp.manual_phone, tp.manual_email, tp.manual_notes
      FROM trip_prospects tp JOIN trips t ON t.id = tp.trip_id
      WHERE tp.id = ? AND tp.trip_id = ? AND t.owner_user_id = ? AND tp.donor_id IS NULL`).bind(prospectId, tripId, userId)
    .first<{ id: string; manual_name: string; manual_city: string | null; manual_region_id: string | null; manual_phone: string | null; manual_email: string | null; manual_notes: string | null }>();
  if (!row) return null;
  return { id: row.id, manualName: row.manual_name, manualCity: row.manual_city, manualRegionId: row.manual_region_id, manualPhone: row.manual_phone, manualEmail: row.manual_email, manualNotes: row.manual_notes };
}

export type DonorMatchCandidate = { donorId: string; name: string; city: string | null; state: string | null; code: string | null; email: string | null; phone: string | null };

// Duplicate detection (the task's own explicit requirement) -- reuses
// searchDonors() (lib/relationships/donor-search.ts), the SAME matching
// logic the donor directory and "Find prospects" both already use,
// never a bespoke fuzzy-match implementation. Tries the prospect's own
// name, phone, and email as three separate queries (a donor matching
// ANY of them is a plausible duplicate) and merges the results, since
// searchDonors() only ever takes one query string at a time.
async function searchLiveDonorsFor(userId: string, queries: readonly string[]): Promise<DonorMatchCandidate[]> {
  const donorRows = await liveOwnedDonorRows(userId);
  const records = donorRows.map(toDonorSearchRecord);
  // searchDonors() is typed over the plain DonorSearchRecord shape, so
  // its result loses city/state at the type level even though they
  // still exist at runtime -- resolved back by id, same pattern
  // TripDashboardExperience.tsx's own findProspectDonorById already
  // uses for the identical reason.
  const recordById = new Map(records.map((record) => [record.id, record]));
  const byId = new Map<string, DonorMatchCandidate>();
  for (const query of queries) {
    if (!query.trim()) continue;
    for (const match of searchDonors(records, query, 5)) {
      if (byId.has(match.id)) continue;
      const full = recordById.get(match.id)!;
      byId.set(match.id, { donorId: match.id, name: match.name, city: full.city, state: full.state, code: match.code, email: match.email, phone: match.phone });
    }
  }
  return [...byId.values()].slice(0, 5);
}

export async function findPossibleDonorMatches(userId: string, tripId: string, prospectId: string): Promise<DonorMatchCandidate[]> {
  const prospect = await ownedUnlinkedProspect(userId, tripId, prospectId);
  if (!prospect) return [];
  return searchLiveDonorsFor(userId, [prospect.manualName, prospect.manualPhone ?? "", prospect.manualEmail ?? ""]);
}

// Unlinked-Prospect Fundraising migration (shared by linkProspectToDonor
// and convertProspectToNewDonor below): every active, not-yet-migrated
// trip_prospect_commitments row for this prospect is attributed to the
// now-known donor -- preferring an EXISTING real record over ever
// creating a duplicate.
//
// JL-duplicate fix (2026-10-26, see docs/AI-HANDOFF.md's "Verification:
// Manual-Prospect JL Duplicate Risk" entry): if this donor already has
// a real, unattributed, already-JL-imported giving_activities row that
// unambiguously matches this commitment (matchExistingGivingActivityForCommitment,
// lib/relationships/trip-model.ts -- same category/committed_cents/
// activity_date-window matching JL import's own pendingGiftMatches/
// pendingPledgeMatches already use), THAT record is attributed to the
// trip directly -- never a second, parallel "pending" row for a pledge
// or gift that is, in reality, already real. Before this fix, every
// commitment unconditionally created a brand-new pending_gift/
// pending_pledge giving_activities row, which is correct ONLY when no
// matching real record exists yet (the common case, still handled
// below exactly as before) -- when the real record predates linking,
// nothing in JL import's own reconciliation would ever have caught the
// resulting duplicate, since that reconciliation only ever compares a
// FRESH import batch against existing pending rows, never re-scans
// already-imported history against a pending row created later.
//
// Falls back to creating a new pending record (the exact same insert
// shape lib/giving/pending-records.ts's insertPendingGift/
// insertPendingPledge already use for a brand-new pending record --
// deliberately re-implemented here, not called, since those two
// validate and re-parse a raw string amount/date, and this commitment's
// own committed_cents/activity_date are already-validated numbers) when
// no unambiguous real match exists. Either way, the commitment row
// itself is marked migrated, never deleted -- every future read of this
// trip's financial totals (listActiveUnlinkedProspectCommitments above)
// excludes a migrated commitment, so the attributed record (real or
// newly-created-pending) represents that exact dollar amount exactly
// once -- never double-counted.
async function migrateProspectCommitments(userId: string, tripId: string, prospectId: string, donorId: string, now: number): Promise<void> {
  const commitments = await env.DB.prepare(`SELECT id, category, committed_cents, activity_date, designation, note, donor_confirmed_at
      FROM trip_prospect_commitments WHERE prospect_id = ? AND removed_at IS NULL AND migrated_at IS NULL`)
    .bind(prospectId).all<{ id: string; category: "pending_gift" | "pending_pledge"; committed_cents: number; activity_date: number | null; designation: string | null; note: string | null; donor_confirmed_at: number | null }>();
  if (commitments.results.length === 0) return;
  const donor = await env.DB.prepare("SELECT id, external_id, donor_code FROM donors WHERE id = ? AND owner_user_id = ?").bind(donorId, userId).first<{ id: string; external_id: string | null; donor_code: string | null }>();
  if (!donor) return; // defensive: the caller only ever reaches here immediately after confirming donorId is a real, owned donor

  // Every real, currently-unattributed giving_activities row for this
  // donor -- fetched once, then narrowed in memory as each commitment
  // below claims at most one, so two commitments in the SAME migration
  // can never both claim the SAME real record (the partial UNIQUE index
  // on trip_financial_attributions.giving_activity_id is the database-
  // level backstop if that narrowing were ever bypassed by a race).
  const realCandidatesResult = await env.DB.prepare(`SELECT id, category, committed_cents, activity_date FROM giving_activities
      WHERE owner_user_id = ? AND donor_id = ? AND record_origin = 'live' AND workspace_status = 'active'
        AND category IN ('completed_gift','open_pledge','partially_paid_pledge')
        AND NOT EXISTS (SELECT 1 FROM trip_financial_attributions tfa WHERE tfa.giving_activity_id = giving_activities.id AND tfa.removed_at IS NULL)`)
    .bind(userId, donor.id).all<{ id: string; category: string; committed_cents: number | null; activity_date: number | null }>();
  let availableRealCandidates = realCandidatesResult.results.map((row) => ({ id: row.id, category: row.category, committedCents: row.committed_cents, activityDate: row.activity_date }));

  for (const commitment of commitments.results) {
    const matched = matchExistingGivingActivityForCommitment(
      { category: commitment.category, committedCents: commitment.committed_cents, activityDate: commitment.activity_date },
      availableRealCandidates,
    );
    if (matched) {
      const attributionId = crypto.randomUUID();
      try {
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, note, commitment_kind, reported_cash_collected_cents, reconciled_pending_attribution_id, donor_confirmed_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'new_commitment', NULL, NULL, ?, ?)`)
            .bind(attributionId, userId, tripId, donor.id, matched.id, commitment.note || null, commitment.donor_confirmed_at, now),
          env.DB.prepare(`UPDATE trip_prospect_commitments SET migrated_giving_activity_id = ?, migrated_attribution_id = ?, migrated_at = ? WHERE id = ?`)
            .bind(matched.id, attributionId, now, commitment.id),
        ]);
        availableRealCandidates = availableRealCandidates.filter((candidate) => candidate.id !== matched.id);
        continue;
      } catch {
        // The matched record was attributed elsewhere between the read
        // above and this write (a genuine race) -- fall through to the
        // pending-record path below exactly as if no match had been
        // found, never left half-migrated.
      }
    }

    const givingActivityId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const attributionId = crypto.randomUUID();
    const isGift = commitment.category === "pending_gift";
    const paidCents = 0; // matches insertPendingGift/insertPendingPledge exactly -- a brand-new pending record always starts with nothing paid
    const balanceCents = isGift ? 0 : commitment.committed_cents; // matches insertPendingGift (gift: balance 0) / insertPendingPledge (pledge: balance = committed) exactly
    const fingerprintPrefix = isGift ? "pending" : "pending-pledge";
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO giving_activities
          (id,owner_user_id,donor_id,external_source,external_household_id,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,item_type,description,source_campaign,category,record_origin,workspace_status,private_note,source_snapshot,created_at,updated_at)
          VALUES (?,?,?,'Fundraising OS',?,?,?,?,?,?,?,?,?,?,'live','active',?,'{}',?,?)`)
        .bind(givingActivityId, userId, donor.id, donor.external_id || donor.donor_code || donor.id, `${fingerprintPrefix}:${givingActivityId}`, commitment.activity_date, commitment.committed_cents, paidCents, balanceCents, isGift ? "Pending gift" : "Pending pledge", commitment.designation || null, commitment.designation || null, commitment.category, commitment.note || null, now, now),
      env.DB.prepare(`INSERT INTO giving_activity_management_audits
          (id,user_id,activity_id,action,next_donor_id,next_status,next_note,created_at)
          VALUES (?,?,?,?,?,'active',?,?)`).bind(auditId, userId, givingActivityId, isGift ? "pending_created" : "pending_pledge_created", donor.id, commitment.note || null, now),
      env.DB.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, note, commitment_kind, reported_cash_collected_cents, reconciled_pending_attribution_id, donor_confirmed_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'new_commitment', NULL, NULL, ?, ?)`)
        .bind(attributionId, userId, tripId, donor.id, givingActivityId, commitment.note || null, commitment.donor_confirmed_at, now),
      env.DB.prepare(`UPDATE trip_prospect_commitments SET migrated_giving_activity_id = ?, migrated_attribution_id = ?, migrated_at = ? WHERE id = ?`)
        .bind(givingActivityId, attributionId, now, commitment.id),
    ]);
  }
}

export type LinkProspectResult = { ok: true } | { ok: false; reason: "prospect_not_found" | "donor_not_found" | "donor_already_on_trip" };

// Links an unlinked prospect to an EXISTING FOS donor -- a plain UPDATE
// of donor_id on the SAME trip_prospects row (see drizzle/0054's own doc
// comment for why this is the one and only state transition). The row's
// id, status, trip_notes, next_action, meeting_at/meeting_location, and
// manual_rank are every one of them left completely untouched, so "this
// trip's meeting notes and trip history survive linking" is true by
// construction, not by any copying logic here. Never creates or
// modifies a donor record -- the donor must already exist.
export async function linkProspectToDonor(userId: string, tripId: string, prospectId: string, donorId: string, now: number): Promise<LinkProspectResult> {
  const prospect = await ownedUnlinkedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  const donor = await env.DB.prepare("SELECT id FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL").bind(donorId, userId).first<{ id: string }>();
  if (!donor) return { ok: false, reason: "donor_not_found" };

  try {
    const result = await env.DB.prepare("UPDATE trip_prospects SET donor_id = ?, updated_at = ? WHERE id = ? AND donor_id IS NULL")
      .bind(donorId, now, prospectId).run() as unknown as { meta: { changes?: number } };
    if ((result.meta.changes ?? 0) === 0) return { ok: false, reason: "prospect_not_found" }; // linked or removed concurrently since the read above
  } catch {
    // UNIQUE(trip_id, donor_id) caught this donor already having its own
    // (separate) trip_prospects row on this same trip.
    return { ok: false, reason: "donor_already_on_trip" };
  }
  await migrateProspectCommitments(userId, tripId, prospectId, donorId, now);
  return { ok: true };
}

export type ConvertProspectResult =
  | { ok: true; donorId: string }
  | { ok: false; reason: "prospect_not_found" }
  | { ok: false; reason: "input_invalid"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "possible_duplicates"; candidates: DonorMatchCandidate[] };

// Converts an unlinked prospect into a brand-new FOS donor account --
// "Do not automatically create donor accounts ... until the normal
// import or reconciliation process confirms the transactions": this is
// never automatic -- it is the one explicit, fundraiser-initiated action
// that creates a donor from this feature, deliberately mirroring
// app/api/donors/route.ts's own manual-donor-creation insert exactly
// (same convention lib/giving/pending-records.ts's own header comment
// documents: a sensitive, already-tested endpoint is duplicated rather
// than refactored to share code with a brand-new caller). Duplicate
// detection (findPossibleDonorMatches, reused) runs BEFORE creating
// anything, unless the fundraiser already explicitly confirmed via
// `force` that this is not a duplicate.
export async function convertProspectToNewDonor(userId: string, tripId: string, prospectId: string, contactInput: DonorContactInput, options: { force?: boolean }, now: number): Promise<ConvertProspectResult> {
  const prospect = await ownedUnlinkedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  const { contact, errors, valid } = normalizeDonorContact(contactInput);
  if (!valid) return { ok: false, reason: "input_invalid", fieldErrors: errors };

  if (!options.force) {
    const candidates = await searchLiveDonorsFor(userId, [contact.householdName, contact.mobilePhone, contact.email]);
    if (candidates.length > 0) return { ok: false, reason: "possible_duplicates", candidates };
  }

  const donorId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const after = JSON.stringify(contact);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO donors
      (id,owner_user_id,data_source,display_name,email,phone,donor_code,spouse,address,external_source,external_id,last_name,primary_first_name,spouse_first_name,home_phone,address_line_1,city,state,postal_code,country,contact_note,created_at,updated_at)
      VALUES (?,?,'live',?,?,?,?,?,?,'Manual',NULL,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(donorId, userId, contact.householdName, contact.email || null, contact.mobilePhone || null, null, contact.spouseName || null, contact.address || null, contact.lastName || null, contact.primaryFirstName || null, contact.spouseName || null, contact.homePhone || null, contact.address || null, contact.city || null, contact.state || null, contact.postalCode || null, contact.country || null, contact.note || null, now, now),
    env.DB.prepare(`INSERT INTO donor_contact_audits (id,user_id,donor_id,action,changed_fields,before_json,after_json,created_at)
      VALUES (?,?,?,'created',?,NULL,?,?)`).bind(auditId, userId, donorId, JSON.stringify(changedContactFields(null, contact)), after, now),
    env.DB.prepare("INSERT INTO onboarding_preferences (user_id, sample_data_acknowledged, data_mode, updated_at) VALUES (?, 1, 'live', ?) ON CONFLICT(user_id) DO UPDATE SET data_mode = 'live', updated_at = excluded.updated_at").bind(userId, now),
  ]);
  logger.info("manual_donor_created_from_trip_prospect", { donorId, userId, tripId, prospectId });

  // Concurrency fix (2026-10-26, see docs/AI-HANDOFF.md's "Verification:
  // Manual-Prospect JL Duplicate Risk" entry): a real defect this round
  // fixes. Two concurrent convert requests for the SAME prospect both
  // pass the ownedUnlinkedProspect check above (both read donor_id IS
  // NULL), both create their OWN brand-new donor, and -- before this
  // fix -- both unconditionally called migrateProspectCommitments with
  // their OWN donorId, even the one that lost this race. That request's
  // donor_id UPDATE affects zero rows (the winner already set it), but
  // migrateProspectCommitments still ran, attributing this prospect's
  // commitments to the LOSING request's own orphaned donor -- a donor
  // the prospect itself is not actually linked to, while also leaving
  // that orphaned donor permanently in the workspace for no reason.
  // Checked and handled exactly like linkProspectToDonor's own identical
  // guard: 0 rows changed means a concurrent request already linked (or
  // converted) this prospect first -- delete the donor this losing
  // request just created (nothing else can reference it yet: the write
  // above is the only thing that ever pointed anything at it) and report
  // the same "prospect_not_found" a concurrent plain link would.
  const updateResult = await env.DB.prepare("UPDATE trip_prospects SET donor_id = ?, updated_at = ? WHERE id = ? AND donor_id IS NULL")
    .bind(donorId, now, prospectId).run() as unknown as { meta: { changes?: number } };
  if ((updateResult.meta.changes ?? 0) === 0) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM donor_contact_audits WHERE id = ?").bind(auditId),
      env.DB.prepare("DELETE FROM donors WHERE id = ?").bind(donorId),
    ]);
    logger.info("manual_donor_created_from_trip_prospect_race_discarded", { donorId, userId, tripId, prospectId });
    return { ok: false, reason: "prospect_not_found" };
  }
  await migrateProspectCommitments(userId, tripId, prospectId, donorId, now);
  return { ok: true, donorId };
}

// Unlinked-Prospect Fundraising (2026-10-25, see docs/AI-HANDOFF.md) --
// "record trip pledges and donations using the existing trip fundraising
// workflow" for a prospect with no FOS donor yet. Reuses pendingGiftInput/
// pendingPledgeInput (lib/giving/management.ts) for the EXACT SAME
// amount/date/designation/note validation "record a new donation/pledge"
// already uses -- a placeholder donorId satisfies that validator's own
// "Choose a donor" check (which is irrelevant here and never surfaced:
// this path never reads the validator's own returned donorId at all,
// and a non-empty placeholder means that one error condition never
// fires). NEVER writes to giving_activities -- this is the one
// structural guarantee behind "do not automatically create donor
// accounts or modify official donor financial records": there is no
// real financial record anywhere for an unlinked prospect's commitment
// until migrateProspectCommitments runs, which only ever happens once a
// real donor exists (linkProspectToDonor/convertProspectToNewDonor).
export type RecordUnlinkedCommitmentResult = { ok: true; commitmentId: string } | { ok: false; reason: "prospect_not_found" } | { ok: false; reason: "input_invalid"; error: string };

export async function recordUnlinkedProspectCommitment(userId: string, tripId: string, prospectId: string, category: "pending_gift" | "pending_pledge", rawInput: unknown, now: number): Promise<RecordUnlinkedCommitmentResult> {
  const prospect = await ownedUnlinkedProspect(userId, tripId, prospectId);
  if (!prospect) return { ok: false, reason: "prospect_not_found" };
  const input = category === "pending_gift"
    ? pendingGiftInput({ ...(rawInput as Record<string, unknown>), donorId: "unlinked-prospect-placeholder" })
    : pendingPledgeInput({ ...(rawInput as Record<string, unknown>), donorId: "unlinked-prospect-placeholder" });
  if (input.errors.length) return { ok: false, reason: "input_invalid", error: input.errors.join(" ") };

  const commitmentId = crypto.randomUUID();
  const donorConfirmedAt = donorConfirmedFlag(rawInput) ? now : null;
  await env.DB.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, activity_date, designation, note, donor_confirmed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(commitmentId, userId, tripId, prospectId, category, input.amountCents, input.activityDate, input.designation || null, input.note || null, donorConfirmedAt, now).run();
  logger.info("trip_unlinked_prospect_commitment_recorded", { userId, tripId, prospectId, category, commitmentId, confirmed: donorConfirmedAt !== null });
  return { ok: true, commitmentId };
}

export type UnlinkedCommitmentActionResult = { ok: true } | { ok: false; reason: "not_found" };

export async function confirmUnlinkedProspectCommitment(userId: string, tripId: string, commitmentId: string, now: number): Promise<UnlinkedCommitmentActionResult> {
  const result = await env.DB.prepare(`UPDATE trip_prospect_commitments SET donor_confirmed_at = ?
      WHERE id = ? AND trip_id = ? AND removed_at IS NULL AND migrated_at IS NULL AND donor_confirmed_at IS NULL
        AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(now, commitmentId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  if ((result.meta.changes ?? 0) > 0) return { ok: true };
  // Idempotent: already confirmed is a no-op success, same convention as
  // confirmTripAttribution. Only a genuinely missing/foreign/migrated/
  // removed commitment is reported not_found.
  const existing = await env.DB.prepare(`SELECT 1 FROM trip_prospect_commitments c JOIN trips t ON t.id = c.trip_id
      WHERE c.id = ? AND c.trip_id = ? AND t.owner_user_id = ? AND c.removed_at IS NULL AND c.migrated_at IS NULL`)
    .bind(commitmentId, tripId, userId).first();
  return existing ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function unconfirmUnlinkedProspectCommitment(userId: string, tripId: string, commitmentId: string): Promise<UnlinkedCommitmentActionResult> {
  const result = await env.DB.prepare(`UPDATE trip_prospect_commitments SET donor_confirmed_at = NULL
      WHERE id = ? AND trip_id = ? AND removed_at IS NULL AND migrated_at IS NULL
        AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(commitmentId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  if ((result.meta.changes ?? 0) > 0) return { ok: true };
  const existing = await env.DB.prepare(`SELECT 1 FROM trip_prospect_commitments c JOIN trips t ON t.id = c.trip_id
      WHERE c.id = ? AND c.trip_id = ? AND t.owner_user_id = ? AND c.removed_at IS NULL AND c.migrated_at IS NULL`)
    .bind(commitmentId, tripId, userId).first();
  return existing ? { ok: true } : { ok: false, reason: "not_found" };
}

// Removes (soft) an unlinked prospect's commitment -- mirrors
// removeTripFinancialAttribution's own "never touches the underlying
// record" guarantee exactly, trivially true here since there IS no
// underlying giving_activities record for an unlinked commitment yet.
export async function removeUnlinkedProspectCommitment(userId: string, tripId: string, commitmentId: string, reason: string | null, now: number): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE trip_prospect_commitments SET removed_at = ?, removed_reason = ?
      WHERE id = ? AND trip_id = ? AND removed_at IS NULL
        AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(now, reason, commitmentId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0;
}

export type ScheduleUnlinkedMeetingResult = { ok: true } | { ok: false; reason: "not_found" | "invalid_meeting_time" };

// Meeting scheduling/completion for an unlinked prospect (the task's own
// "support meeting scheduling, meeting notes, and follow-up tracking"):
// deliberately a SEPARATE, much simpler pair of functions rather than
// widening scheduleProspectMeeting/completeProspectMeeting's own already
// heavily concurrency-guarded internals (see those functions' own doc
// comments) -- an unlinked prospect has no donor and therefore can never
// have a real `interactions` row or Google Calendar sync (both require
// donor_id), so there is no scheduled/completed DONOR INTERACTION to
// create here, only the trip's own workflow fields. Trip notes and next
// action already work for any prospect via updateProspectFields above,
// unchanged -- this only ever sets meeting_at/meeting_location/status.
// `fallbackTimezone` (the fundraiser's own profile timezone) is used
// directly -- never resolved per-city like resolveMeetingEpoch() does
// for a real donor's own state, since there is no donor row to read a
// state from; picking an arbitrary representative city out of the
// prospect's own chosen region would risk being MORE misleading than
// an honest fallback, not less.
export async function scheduleUnlinkedProspectMeeting(userId: string, tripId: string, prospectId: string, meetingAtLocal: unknown, location: string | null, fallbackTimezone: string, now: number): Promise<ScheduleUnlinkedMeetingResult> {
  const fields = parseLocalDateTimeInput(meetingAtLocal);
  if (!fields) return { ok: false, reason: "invalid_meeting_time" };
  const meetingAt = Math.floor(zonedTimeToUtc(fields.year, fields.month, fields.day, fields.hour, fields.minute, fallbackTimezone).getTime() / 1000);
  const validated = validateMeetingScheduling(meetingAt, now);
  if (!validated.ok) return { ok: false, reason: "invalid_meeting_time" };
  const result = await env.DB.prepare(`UPDATE trip_prospects SET status = 'meeting_scheduled', meeting_at = ?, meeting_location = ?, updated_at = ?
      WHERE id = ? AND trip_id = ? AND donor_id IS NULL AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(validated.meetingAt, location, now, prospectId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

export async function completeUnlinkedProspectMeeting(userId: string, tripId: string, prospectId: string, meetingAtLocal: unknown, notes: string, fallbackTimezone: string, now: number): Promise<ScheduleUnlinkedMeetingResult> {
  const fields = parseLocalDateTimeInput(meetingAtLocal);
  if (!fields) return { ok: false, reason: "invalid_meeting_time" };
  const meetingAt = Math.floor(zonedTimeToUtc(fields.year, fields.month, fields.day, fields.hour, fields.minute, fallbackTimezone).getTime() / 1000);
  const validated = validateMeetingCompletion(meetingAt, notes, now);
  if (!validated.ok) return { ok: false, reason: "invalid_meeting_time" };
  // Appends to trip_notes rather than overwriting it -- there is no
  // separate `interactions` row to hold these notes for an unlinked
  // prospect (unlike completeProspectMeeting's real donor-linked path),
  // so trip_notes is the only place they can live; overwriting it would
  // silently destroy anything already saved there, same "never replace,
  // only append alongside" rule this codebase's real AI Meeting Notes
  // preservation logic already follows for the linked case.
  const result = await env.DB.prepare(`UPDATE trip_prospects SET status = 'meeting_completed', meeting_at = ?,
        trip_notes = CASE WHEN trip_notes IS NULL OR trip_notes = '' THEN ? ELSE trip_notes || char(10) || char(10) || ? END,
        updated_at = ?
      WHERE id = ? AND trip_id = ? AND donor_id IS NULL AND trip_id IN (SELECT id FROM trips WHERE owner_user_id = ?)`)
    .bind(validated.meetingAt, validated.notes, validated.notes, now, prospectId, tripId, userId).run() as unknown as { meta: { changes?: number } };
  return (result.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

export { statusRequiresInteraction, timezoneForState };
