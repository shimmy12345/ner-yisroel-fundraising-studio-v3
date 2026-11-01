// "Add to Google Calendar" -- a plain Google Calendar template link for
// a confirmed, timed Trip Planning meeting. Pure, framework-free, no D1
// access, no network call of its own -- matching this codebase's own
// established split between pure logic (here, directly unit-testable)
// and the "use client" component that renders it
// (app/travel-planning/[id]/TripDashboardExperience.tsx).
//
// Deliberately NOT an OAuth flow, a Google API call, a background job,
// or any form of sync -- this only ever builds a URL the fundraiser
// opens themselves; Google Calendar itself decides whether/when the
// event is actually saved. FOS never learns the outcome and must never
// claim one.
//
// Restored 2026-11-01 (see docs/AI-HANDOFF.md's "CORRECTION" and
// "Restore Original Trip Planner Calendar Features" entries) after this
// exact module, and its only two call sites, were silently dropped by
// an unrelated 2026-10-25 deployment from a branch that had never
// incorporated the original commit (`adb97c0`, 2026-10-19). Restored
// byte-for-byte except `computeMeetingDurationMinutes` below, which is
// new: the original release had no persisted meeting duration to read
// (no `interactions.end_at` column existed yet at its base commit), so
// it used an unsaved, client-only duration input instead. That column
// now exists (migration 0048) and is populated by the real scheduling
// flow, so the restored version reads the REAL, already-saved duration
// instead of reintroducing a second, redundant, unsaved input.
//
// `meetingAtEpoch` is a real UTC instant (Unix epoch seconds) -- already
// correctly resolved against the donor's own destination timezone and
// DST by the server at save time (trips-data.ts's resolveMeetingEpoch(),
// the same value TripDashboardExperience.tsx's dateTimeLabelInZone()
// already displays) -- so formatting it as a Z-suffixed UTC "dates"
// param is sufficient for Google Calendar to render it correctly in the
// VIEWER's own timezone; no separate timezone handling belongs here.
export const DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES = 30;

export function toGoogleCalendarUtcStamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Deliberately excludes: donor financial information, private trip/
// meeting notes, attendees, and any invitation -- only the donor's
// display name (as an event title), the already-saved meeting time, and
// the already-saved meeting location ever reach this URL. No `details`
// param (nothing to say that isn't already private), no `add`
// (attendee/invite) param. `URLSearchParams` handles percent-encoding
// for every value, including names/locations with spaces, ampersands,
// or other reserved characters.
export function googleCalendarTemplateUrl(donorDisplayName: string, meetingAtEpoch: number, durationMinutes: number, meetingLocation: string | null): string {
  const start = toGoogleCalendarUtcStamp(meetingAtEpoch);
  const end = toGoogleCalendarUtcStamp(meetingAtEpoch + durationMinutes * 60);
  const params = new URLSearchParams({ action: "TEMPLATE", text: `Meeting with ${donorDisplayName}`, dates: `${start}/${end}` });
  if (meetingLocation) params.set("location", meetingLocation);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// The real, already-saved meeting duration (derived from
// `interactions.end_at - trip_prospects.meeting_at`, both real,
// persisted values) when one exists, never a guessed or re-entered one.
// Falls back to the fixed default for a manually-added (unlinked)
// prospect, which has no `interactions` row and therefore no `end_at`
// at all, or for any other case where a real duration can't be derived
// (non-finite, zero, or negative -- never a backwards or zero-length
// event).
export function computeMeetingDurationMinutes(meetingAtEpoch: number | null, endAtEpoch: number | null): number {
  if (meetingAtEpoch === null || endAtEpoch === null) return DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES;
  const minutes = Math.round((endAtEpoch - meetingAtEpoch) / 60);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES;
}

// "Use donor address" -- combines the donor's OWN already-on-file
// street/city/state/ZIP (never fetched or looked up anywhere new; the
// same address_line_1/city/state/postal_code columns
// lib/relationships/meeting-brief.ts's own loadMeetingBrief() already
// reads) into one single-line string suitable for the meeting-location
// text field. Blank/missing fields are omitted entirely -- never a
// stray ", ," from an empty segment. Returns null (never an empty
// string) when NOTHING is on file, so the caller can show an explicit
// "no address on file" explanation instead of silently doing nothing.
export function formatDonorAddress(addressLine1: string | null, city: string | null, state: string | null, postalCode: string | null): string | null {
  const cityStateZip = [city, [state, postalCode].filter(Boolean).join(" ") || null].filter(Boolean).join(", ");
  const parts = [addressLine1, cityStateZip || null].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}
