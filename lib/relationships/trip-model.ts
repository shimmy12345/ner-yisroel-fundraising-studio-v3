// Trip-Based Meeting Planning -- Phase 2 (2026-10-15, see docs/AI-HANDOFF.md
// for the full audit and the independent-review refinements this module
// implements). Pure, framework-free, no D1 access of its own -- matching
// this codebase's own established split (compare lib/relationships/
// meeting-brief-model.ts vs. meeting-brief.ts, lib/capture/ask.ts's
// validators) between "pure logic, directly unit-testable" and "the one
// D1-touching loader that calls it" (lib/relationships/trips-data.ts).

import type { DonorRecommendation } from "./recommendation-rank.ts";

export type TripStatus = "planning" | "active" | "completed" | "cancelled";
export const TRIP_STATUSES: readonly TripStatus[] = ["planning", "active", "completed", "cancelled"];
export function isValidTripStatus(value: unknown): value is TripStatus {
  return typeof value === "string" && (TRIP_STATUSES as readonly string[]).includes(value);
}

// Seven trip-specific statuses (Section D) -- deliberately NOT required
// to move in one direction only: the owner's own independent-review
// instruction is "allow status changes in either direction where
// reasonable" (e.g. a scheduled meeting that falls through moves back to
// "Contacted", not forced to "Declined"). This is a workflow label, not
// the real record of what happened -- see trips-data.ts for how a
// transition to/from meeting_scheduled/meeting_completed is the ONLY
// thing that ever touches a real `interactions` row.
export type TripProspectStatus =
  | "not_contacted" | "contacted" | "meeting_requested" | "meeting_scheduled"
  | "meeting_completed" | "declined" | "unable_to_schedule";
export const TRIP_PROSPECT_STATUSES: readonly TripProspectStatus[] = [
  "not_contacted", "contacted", "meeting_requested", "meeting_scheduled",
  "meeting_completed", "declined", "unable_to_schedule",
];
export function isValidProspectStatus(value: unknown): value is TripProspectStatus {
  return typeof value === "string" && (TRIP_PROSPECT_STATUSES as readonly string[]).includes(value);
}

export type AddedMethod = "auto_region" | "manual";

// A real `interactions` row is written ONLY for these two statuses
// (Section D's explicit interaction safeguards) -- every other status
// (not_contacted/contacted/meeting_requested/declined/unable_to_schedule)
// is a trip-workflow label only and must never fabricate a donor touch.
// "Contacted" in particular must never, by itself, create an interaction
// -- the owner's own explicit "must not automatically claim that a
// completed donor interaction occurred" instruction.
const STATUSES_REQUIRING_INTERACTION: ReadonlySet<TripProspectStatus> = new Set(["meeting_scheduled", "meeting_completed"]);
export function statusRequiresInteraction(status: TripProspectStatus): boolean {
  return STATUSES_REQUIRING_INTERACTION.has(status);
}

// Cross-trip conflict detection (Section C): a caution, never a block.
// Only an ACTIVE, still-pending meeting plan on a different trip counts
// -- a completed, declined, or not-yet-requested prospect on another
// trip is not a scheduling conflict.
const CONFLICTING_STATUSES: ReadonlySet<TripProspectStatus> = new Set(["meeting_requested", "meeting_scheduled"]);
export function isConflictingProspectStatus(status: TripProspectStatus): boolean {
  return CONFLICTING_STATUSES.has(status);
}
export type CrossTripConflict = { tripId: string; tripName: string; status: TripProspectStatus; meetingAt: number | null };
// `excludeTripId` is always the trip currently being viewed/edited -- a
// donor's own row on THIS trip is never its own "conflict".
export function findCrossTripConflicts<T extends { tripId: string; tripName: string; status: TripProspectStatus; meetingAt: number | null }>(rows: readonly T[], excludeTripId: string): CrossTripConflict[] {
  return rows.filter((row) => row.tripId !== excludeTripId && isConflictingProspectStatus(row.status))
    .map((row) => ({ tripId: row.tripId, tripName: row.tripName, status: row.status, meetingAt: row.meetingAt }));
}

// Suggestion snapshot (Section B's independent-review refinement):
// captured ONCE, when a donor is auto-added from the destination region,
// from the exact real DonorRecommendation the shared recommendation
// engine (lib/relationships/recommendation-rank.ts, called via
// loadMeetingBrief() -- see trips-data.ts) produced at that moment --
// never a separate trip-prioritization score. `generatedAt` is always
// set, even for the neutral case, so the UI can always honestly label
// "suggested on <date>" rather than imply a live, current fact. A donor
// with no actionable evidence at all is still a legitimate prospect --
// being in the destination region is itself the reason -- so this never
// manufactures urgency or invents a score for them.
export type SuggestionSnapshot = { reason: string | null; score: number | null; generatedAt: number };
const NEUTRAL_SUGGESTION_REASON = "No specific evidence on file for this donor yet -- included because of their location in the destination region.";
export function buildSuggestionSnapshot(recommendation: DonorRecommendation | null, now: number): SuggestionSnapshot {
  if (!recommendation) return { reason: NEUTRAL_SUGGESTION_REASON, score: null, generatedAt: now };
  return { reason: `${recommendation.action} ${recommendation.why}`.trim(), score: recommendation.score, generatedAt: now };
}

// Destination-timezone handling (Section D's explicit instruction to use
// "the appropriate destination timezone and existing timezone conversion
// utilities"). No US-state-to-timezone mapping exists anywhere else in
// this codebase (confirmed by a repo-wide, read-only search) -- this is
// a small, narrowly-scoped addition, covering only the states that
// actually appear in lib/relationships/travel-regions.ts's 15 approved
// regions, plus Ontario/Israel for the two non-US entries there. An
// unrecognized state (or no state at all) falls back to the caller's own
// home timezone (the fundraiser's `profile.timezone`) rather than
// guessing -- never silently assuming a specific city's offset for data
// this module cannot actually confirm.
const STATE_TIMEZONES: Readonly<Record<string, string>> = {
  CA: "America/Los_Angeles",
  FL: "America/New_York",
  GA: "America/New_York",
  IL: "America/Chicago",
  MD: "America/New_York",
  MI: "America/New_York",
  MN: "America/Chicago",
  MO: "America/Chicago",
  NJ: "America/New_York",
  NY: "America/New_York",
  OH: "America/New_York",
  PA: "America/New_York",
  ON: "America/Toronto",
};
export function timezoneForState(state: string | null | undefined, fallback: string): string {
  if (!state) return fallback;
  return STATE_TIMEZONES[state.trim().toUpperCase()] ?? fallback;
}

// Independent-review correction (2026-10-15): `timezoneForState` above
// was defined and unit-tested but never actually wired into the live
// scheduling flow -- the UI was parsing the `<input type="datetime-
// local">` value with the BROWSER's own `Date()` constructor, which
// resolves wall-clock text in the DEVICE's local timezone, not the
// donor's destination timezone. A fundraiser in Baltimore scheduling a
// Chicago meeting would have had it recorded an hour off; this is
// exactly the class of bug the owner's explicit "handle DST transitions
// correctly" requirement exists to prevent, and a browser-Date parse
// cannot be trusted to get either the base offset or a DST boundary
// right for a city the browser itself knows nothing about.
//
// A `datetime-local` input's value is always exactly `YYYY-MM-DDTHH:mm`
// (the HTML spec guarantees this format) -- parsed here with a strict
// regex, never `new Date()`, so the five numeric fields are extracted
// with zero implicit timezone interpretation at all. The caller then
// feeds them to the REAL `zonedTimeToUtc()` (lib/workspace/local-time.ts,
// already DST-safe and already used elsewhere in this codebase) together
// with the correct destination timezone from `timezoneForState()` above
// -- never a second date-parsing/conversion implementation.
const LOCAL_DATETIME_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
export type LocalDateTimeFields = { year: number; month: number; day: number; hour: number; minute: number };
export function parseLocalDateTimeInput(value: unknown): LocalDateTimeFields | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_DATETIME_INPUT_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText), minute = Number(minuteText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

// Interaction source-string builders -- deliberately produce EXACTLY the
// shapes lib/workspace/scheduled-activity.ts's existing, UNMODIFIED
// activityStatus()/completedPlannedAt()/originalActivitySource()/
// isScheduledActivity() already parse, so a trip-originated meeting is
// indistinguishable, to the rest of the CRM, from any other scheduled or
// completed activity -- no new status-derivation logic anywhere, per the
// owner's own "use the existing interaction creation/outcome mechanisms
// rather than creating a parallel permanent meeting-history system"
// instruction.
export function tripScheduledInteractionSource(tripId: string): string {
  return `capture-scheduled:trip:${tripId}:meeting`;
}
// `plannedEpoch` is the meeting's own `occurred_at` at the moment it was
// scheduled (matches completedPlannedAt()'s own `capture-completed:
// (\d+):` regex); `originalSource` is this same prospect's own
// tripScheduledInteractionSource() result, preserved verbatim inside the
// completed source string so originalActivitySource() can always recover
// it later (e.g. if the meeting is reopened).
export function tripCompletedInteractionSource(plannedEpoch: number, originalSource: string): string {
  return `capture-completed:${plannedEpoch}:completed:${originalSource}`;
}
// Wrapping with a `cancelled:` prefix is the SAME mechanism the existing
// outcome route already uses for cancellation (lib/workspace/
// scheduled-activity.ts's isCancelledActivity/isScheduledActivity both
// already treat this prefix as authoritative) -- this is what the owner's
// own "do not allow a cancelled or declined meeting to remain incorrectly
// represented as an upcoming scheduled meeting" instruction maps onto:
// moving a prospect to 'declined'/'unable_to_schedule' after a real
// scheduled interaction already exists wraps that interaction's source
// with this prefix, so every existing "upcoming activity" surface
// (Today's page, scheduleBucket()) stops showing it, with zero new logic
// on their end.
export function tripCancelledInteractionSource(existingSource: string): string {
  return existingSource.startsWith("cancelled:") ? existingSource : `cancelled:${existingSource}`;
}

// A deterministic id, derived from the prospect row's own id -- never
// `crypto.randomUUID()` -- is what makes "prevent duplicate interactions
// if a user retries, refreshes, or changes status repeatedly" true by
// construction: every write for this exact prospect's meeting targets
// the SAME interaction id, so an `INSERT ... ON CONFLICT(id) DO UPDATE`
// (the same idempotent-upsert shape app/api/interactions/[id]/outcome/
// route.ts already uses for its own follow-up interaction) can never
// create a second row for a retried request.
export function tripMeetingInteractionId(prospectId: string): string {
  return `trip-meeting-${prospectId}`;
}

// Validation -- same `{ ok: true; <field> } | { ok: false }` shape
// lib/capture/ask.ts's own validators already use, for the same reason:
// one obvious, already-proven pattern for every API route in this app to
// branch on, never a bespoke shape per feature.
const MAX_TRIP_NAME_LENGTH = 200;
const MAX_NOTES_LENGTH = 5000;
const MAX_TRIP_SPAN_DAYS = 90;

export function validateTripName(value: unknown): { ok: true; name: string } | { ok: false } {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_TRIP_NAME_LENGTH) return { ok: false };
  return { ok: true, name };
}

export function validateTripDates(startDate: unknown, endDate: unknown): { ok: true; startDate: number; endDate: number } | { ok: false } {
  if (typeof startDate !== "number" || !Number.isInteger(startDate)) return { ok: false };
  if (typeof endDate !== "number" || !Number.isInteger(endDate)) return { ok: false };
  if (endDate < startDate) return { ok: false };
  // A sanity ceiling, not a product rule -- catches an obviously malformed
  // payload (e.g. end_date a decade later by a unit mistake) without
  // guessing at a "real" maximum trip length.
  if ((endDate - startDate) / 86400 > MAX_TRIP_SPAN_DAYS) return { ok: false };
  return { ok: true, startDate, endDate };
}

export function validateFundraisingGoalCents(value: unknown): { ok: true; goalCents: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, goalCents: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return { ok: false };
  return { ok: true, goalCents: value };
}

export function validateNotes(value: unknown): { ok: true; notes: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, notes: null };
  if (typeof value !== "string") return { ok: false };
  const notes = value.trim() || null;
  if (notes && notes.length > MAX_NOTES_LENGTH) return { ok: false };
  return { ok: true, notes };
}

export function validateMeetingLocation(value: unknown): { ok: true; location: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, location: null };
  if (typeof value !== "string") return { ok: false };
  const location = value.trim() || null;
  if (location && location.length > 300) return { ok: false };
  return { ok: true, location };
}

export function validateNextAction(value: unknown): { ok: true; nextAction: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, nextAction: null };
  if (typeof value !== "string") return { ok: false };
  const nextAction = value.trim() || null;
  if (nextAction && nextAction.length > 500) return { ok: false };
  return { ok: true, nextAction };
}

// "Marking a meeting Completed must require explicit confirmation of the
// outcome, including an actual meeting date and meaningful notes" --
// enforced here, once, rather than re-checked inconsistently per caller.
const MIN_MEANINGFUL_NOTES_LENGTH = 2;
export function validateMeetingCompletion(meetingAt: unknown, notes: unknown, now: number): { ok: true; meetingAt: number; notes: string } | { ok: false } {
  if (typeof meetingAt !== "number" || !Number.isInteger(meetingAt)) return { ok: false };
  // A completed meeting's own recorded time may not be more than 5
  // minutes in the future -- same tolerance app/api/interactions/[id]/
  // outcome/route.ts already uses for completedAt, reused verbatim.
  if (meetingAt > now + 300) return { ok: false };
  if (typeof notes !== "string") return { ok: false };
  const trimmedNotes = notes.trim();
  if (trimmedNotes.length < MIN_MEANINGFUL_NOTES_LENGTH || trimmedNotes.length > MAX_NOTES_LENGTH) return { ok: false };
  return { ok: true, meetingAt, notes: trimmedNotes };
}

// "Scheduling a meeting may create a real scheduled interaction ... but
// only after explicit user confirmation" -- a future meeting time is the
// one hard requirement; location/notes are optional at scheduling time.
export function validateMeetingScheduling(meetingAt: unknown, now: number): { ok: true; meetingAt: number } | { ok: false } {
  if (typeof meetingAt !== "number" || !Number.isInteger(meetingAt)) return { ok: false };
  if (meetingAt <= now) return { ok: false };
  return { ok: true, meetingAt };
}

// Google Calendar sync narrowed first release (2026-10-19, see
// docs/AI-HANDOFF.md): "show an editable duration, default 30 minutes."
// Omitted/undefined/null means "use the default", never a validation
// error -- an existing caller that doesn't send this field at all must
// keep working exactly as before. The sanity ceiling (24h) is the same
// kind of "catch an obviously malformed payload" guard as
// MAX_TRIP_SPAN_DAYS above, not a product rule about real meeting length.
export const DEFAULT_MEETING_DURATION_MINUTES = 30;
const MAX_MEETING_DURATION_MINUTES = 24 * 60;
export function validateMeetingDurationMinutes(value: unknown): { ok: true; durationMinutes: number } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, durationMinutes: DEFAULT_MEETING_DURATION_MINUTES };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > MAX_MEETING_DURATION_MINUTES) return { ok: false };
  return { ok: true, durationMinutes: value };
}

// Trip Fundraising Results Dashboard -- donor-confirmation correction
// (2026-10-20, see docs/AI-HANDOFF.md). "Was this pledge/gift secured on
// this trip, or is this attributing an already-real pledge from before
// the trip (collecting on it, or just linking it for visibility)?" --
// never assumed; every "associate an existing donation or pledge" action
// must choose explicitly. Defaults to the ordinary case (secured on this
// trip) only when the caller omits the field entirely, matching every
// existing attribution made before this round.
export type TripCommitmentKind = "new_commitment" | "preexisting_pledge_collection";
export function isValidCommitmentKind(value: unknown): value is TripCommitmentKind {
  return value === "new_commitment" || value === "preexisting_pledge_collection";
}

// A fundraiser-reported, trip-scoped cash figure for a
// preexisting_pledge_collection attribution -- deliberately mirrors
// pendingGiftInput/pendingPledgeInput's own amount-parsing shape (lib/
// giving/management.ts) for a consistent "$1,234.56" input experience,
// but allows exactly 0 (unlike a new gift/pledge amount): linking an
// existing pledge for visibility, with nothing collected on this trip
// yet, is a legitimate, non-error case.
const MAX_REPORTED_CASH_COLLECTED_DOLLARS = 100_000_000;
export function validateReportedCashCollectedCents(value: unknown): { ok: true; cents: number } | { ok: false } {
  if (value === undefined || value === null || value === "") return { ok: true, cents: 0 };
  const amount = typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(amount) || amount < 0 || amount > MAX_REPORTED_CASH_COLLECTED_DOLLARS) return { ok: false };
  return { ok: true, cents: Math.round(amount * 100) };
}
