import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES,
  toGoogleCalendarUtcStamp, googleCalendarTemplateUrl, computeMeetingDurationMinutes, formatDonorAddress,
} from "../lib/relationships/trip-calendar-link.ts";
import { zonedTimeToUtc } from "../lib/workspace/local-time.ts";

// "Add to Google Calendar" -- restored 2026-11-01 (originally commit
// `adb97c0`, 2026-10-19 -- see docs/AI-HANDOFF.md's "CORRECTION" and
// "Restore Original Trip Planner Calendar Features" entries) after it
// was silently dropped by an unrelated 2026-10-25 deployment from a
// branch that had never incorporated it. Exercises the pure link-
// building logic directly (no D1, no network, no browser) -- matching
// this codebase's own established convention (see
// tests/trip-model.test.mjs's own header comment). The UI-gating and
// scope-limit checks below source-inspect the "use client" component as
// text instead (no React/DOM test runner in this codebase -- see
// tests/activity-editing.test.mjs's own established pattern).
const tripDashboard = await readFile(new URL("../app/travel-planning/[id]/TripDashboardExperience.tsx", import.meta.url), "utf8");

async function run() {
  // --- toGoogleCalendarUtcStamp: a real Unix epoch -> Google's required
  // Z-suffixed "YYYYMMDDTHHMMSSZ" form, exactly, with no separators. ---
  assert.equal(toGoogleCalendarUtcStamp(0), "19700101T000000Z");
  assert.equal(toGoogleCalendarUtcStamp(1577880000), "20200101T120000Z"); // 2020-01-01 12:00:00 UTC

  // --- Correct dates/times across Eastern, Central, and Pacific, each
  // across its own DST boundary -- meetingAtEpoch is produced by
  // zonedTimeToUtc() exactly the way trips-data.ts's
  // resolveMeetingEpoch() produces the real, stored meeting_at value;
  // this proves the Google Calendar link reproduces the SAME instant,
  // not a re-derived or re-guessed one. ---
  const epochFor = (year, month, day, hour, minute, zone) => Math.floor(zonedTimeToUtc(year, month, day, hour, minute, zone).getTime() / 1000);
  const cases = [
    // [year, month, day, hour, minute, zone, expected UTC stamp]
    [2026, 7, 15, 14, 0, "America/New_York", "20260715T180000Z"], // EDT (UTC-4)
    [2026, 12, 15, 14, 0, "America/New_York", "20261215T190000Z"], // EST (UTC-5)
    [2026, 7, 15, 14, 0, "America/Chicago", "20260715T190000Z"], // CDT (UTC-5)
    [2026, 12, 15, 14, 0, "America/Chicago", "20261215T200000Z"], // CST (UTC-6)
    [2026, 7, 15, 14, 0, "America/Los_Angeles", "20260715T210000Z"], // PDT (UTC-7)
    [2026, 12, 15, 14, 0, "America/Los_Angeles", "20261215T220000Z"], // PST (UTC-8)
    // DST SPRING-FORWARD boundary -- 2026-03-08 02:00 America/New_York
    // jumps straight to 03:00 (no 2:30am exists); a meeting booked just
    // before and just after the jump must land on opposite sides of it.
    [2026, 3, 8, 1, 30, "America/New_York", "20260308T063000Z"], // still EST (UTC-5)
    [2026, 3, 8, 3, 30, "America/New_York", "20260308T073000Z"], // now EDT (UTC-4)
    // DST FALL-BACK boundary -- 2026-11-01 02:00 America/New_York falls
    // back to 01:00; zonedTimeToUtc() resolves the ambiguous 1:30am wall
    // clock to its EARLIER (still-EDT) instant -- this test only needs
    // the link to reproduce whatever resolveMeetingEpoch() itself
    // already decided, which is exactly what it does here.
    [2026, 11, 1, 1, 30, "America/New_York", "20261101T053000Z"], // EDT (UTC-4), the first/earlier occurrence
  ];
  for (const [year, month, day, hour, minute, zone, expected] of cases) {
    const epoch = epochFor(year, month, day, hour, minute, zone);
    assert.equal(toGoogleCalendarUtcStamp(epoch), expected, `${year}-${month}-${day} ${hour}:${minute} in ${zone}`);
  }

  // --- googleCalendarTemplateUrl: correct shape, correct encoding, and
  // the privacy exclusions this feature requires. ---
  const meetingAt = epochFor(2026, 10, 20, 19, 0, "America/New_York"); // EDT
  {
    const url = new URL(googleCalendarTemplateUrl("Mr. & Mrs. Alan Tabacznik", meetingAt, 30, "his home"));
    assert.equal(url.origin + url.pathname, "https://calendar.google.com/calendar/render");
    assert.equal(url.searchParams.get("action"), "TEMPLATE");
    assert.equal(url.searchParams.get("text"), "Meeting with Mr. & Mrs. Alan Tabacznik", "URLSearchParams must correctly decode the '&' back out -- proving it was percent-encoded, not left raw, in the actual URL string");
    assert.equal(url.searchParams.get("dates"), "20261020T230000Z/20261020T233000Z", "a real 30-minute duration, start and end");
    assert.equal(url.searchParams.get("location"), "his home");
    // Nothing else is ever present: no details/description, no attendee/
    // invite param, nothing from financial or private-notes data.
    assert.deepEqual([...url.searchParams.keys()].sort(), ["action", "dates", "location", "text"]);
  }
  {
    // A location containing characters that must themselves be
    // percent-encoded correctly (space, ampersand, quote).
    const url = new URL(googleCalendarTemplateUrl("Rabbi & Mrs. Dovid Bashevkin", meetingAt, 45, "Zula Café & Grill, \"back room\""));
    assert.equal(url.searchParams.get("location"), 'Zula Café & Grill, "back room"');
    assert.equal(url.searchParams.get("dates"), "20261020T230000Z/20261020T234500Z");
    assert.match(url.toString(), /location=Zula\+Caf%C3%A9\+%26\+Grill/, "the raw URL string itself must be percent-encoded, not merely decode back correctly");
  }
  {
    // No location on file -- the param must be omitted entirely, never
    // sent as an empty string (which Google Calendar would still treat
    // as a present, if blank, location field).
    const url = new URL(googleCalendarTemplateUrl("Mr. & Mrs. Shai Gerson", meetingAt, 30, null));
    assert.equal(url.searchParams.has("location"), false);
  }

  // --- computeMeetingDurationMinutes: BEHAVIORAL, not just text search
  // -- proves the actual arithmetic chain a real scheduled meeting goes
  // through (meeting_at/end_at, both real persisted D1 values) produces
  // the correct Google Calendar "dates" end time end to end. ---
  {
    // A real linked meeting: 30-minute duration, derived from a real
    // end_at exactly 1800 seconds after meeting_at.
    const duration = computeMeetingDurationMinutes(meetingAt, meetingAt + 1800);
    assert.equal(duration, 30);
    const url = new URL(googleCalendarTemplateUrl("Mrs. Test Donor", meetingAt, duration, null));
    assert.equal(url.searchParams.get("dates"), "20261020T230000Z/20261020T233000Z", "the full chain -- real end_at minus real meeting_at, fed into the real URL builder -- must land on the correct wall-clock end time");
  }
  {
    // A longer, non-default real duration (90 minutes) -- proves this
    // isn't hardcoded to the 30-minute default.
    assert.equal(computeMeetingDurationMinutes(meetingAt, meetingAt + 90 * 60), 90);
  }
  // An unlinked (manually added) prospect has no interaction and
  // therefore no end_at at all -- must fall back to the fixed default,
  // never throw or produce a backwards/zero-length event.
  assert.equal(computeMeetingDurationMinutes(meetingAt, null), DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES);
  assert.equal(computeMeetingDurationMinutes(null, null), DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES);
  // A corrupt/backwards end_at (end before start, or identical) must
  // never produce a zero-length or negative-length event -- falls back
  // to the default instead of propagating the bad value.
  assert.equal(computeMeetingDurationMinutes(meetingAt, meetingAt), DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES);
  assert.equal(computeMeetingDurationMinutes(meetingAt, meetingAt - 600), DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES);
  assert.equal(DEFAULT_GOOGLE_CALENDAR_DURATION_MINUTES, 30);

  // --- formatDonorAddress: "Use donor address" -- combine whatever's on
  // file, omit blanks, single line, never a stray ", ,". ---
  assert.equal(formatDonorAddress("123 Main St", "Teaneck", "NJ", "07666"), "123 Main St, Teaneck, NJ 07666");
  assert.equal(formatDonorAddress(null, "Teaneck", "NJ", "07666"), "Teaneck, NJ 07666", "missing street -- no leading stray separator");
  assert.equal(formatDonorAddress("123 Main St", null, "NJ", "07666"), "123 Main St, NJ 07666", "missing city -- state/ZIP still join correctly");
  assert.equal(formatDonorAddress("123 Main St", "Teaneck", null, null), "123 Main St, Teaneck", "missing state/ZIP -- no stray trailing separator");
  assert.equal(formatDonorAddress("123 Main St", "Teaneck", "NJ", null), "123 Main St, Teaneck, NJ", "state with no ZIP -- no stray trailing space");
  assert.equal(formatDonorAddress("123 Main St", "Teaneck", null, "07666"), "123 Main St, Teaneck, 07666", "ZIP with no state");
  assert.equal(formatDonorAddress(null, null, null, null), null, "nothing on file -- null, never an empty string, so the caller can show an explicit explanation");
  assert.equal(formatDonorAddress(null, null, "NJ", null), "NJ", "only a bare state on file");
  assert.equal(formatDonorAddress("", "", "", ""), null, "empty strings must be treated exactly like missing values, never joined as blank segments");

  // --- Status-based visibility: the Google Calendar link must be gated
  // on `prospect.status === "meeting_scheduled"` specifically -- never
  // shown for meeting_requested, declined, meeting_completed, or
  // unable_to_schedule. ---
  assert.match(tripDashboard, /prospect\.status === "meeting_scheduled" && prospect\.meetingAt && !scheduling && !completing &&\s*\n\s*<AddToGoogleCalendarLink/, "the Add to Google Calendar link must be gated on status === 'meeting_scheduled', not merely on meetingAt being present (which is also true for meeting_completed)");

  // --- Scope limits for this feature: no OAuth, no Google API call, no
  // background job, no sync, no event/click tracking. The only Google
  // domain referenced anywhere in the AddToGoogleCalendarLink component
  // must be the plain, user-opened calendar.google.com/calendar/render
  // template endpoint (built in lib/relationships/trip-calendar-link.ts,
  // imported here) -- never googleapis.com, never an OAuth
  // authorize/token endpoint. The file as a whole DOES reference
  // googleapis.com/OAuth elsewhere (the separate, pre-existing, still-
  // inactive CalendarSyncBadge/Retry feature this restoration must not
  // touch) -- so this check scopes to the new component's own source
  // only, not the whole file. ---
  const addToCalendarComponentMatch = tripDashboard.match(/function AddToGoogleCalendarLink\([\s\S]*?\n\}/);
  assert.ok(addToCalendarComponentMatch, "AddToGoogleCalendarLink component must exist");
  assert.doesNotMatch(addToCalendarComponentMatch[0], /googleapis\.com|oauth|OAuth|client_secret|refresh_token|setInterval|setTimeout/, "the restored Add-to-Google-Calendar component must never reference Google OAuth, the Google API, a credential, or a background job/poll of any kind -- a plain template link only");

  // --- "Use donor address": present, explicit (never auto-fills on
  // mount -- only inside its own onClick handler), explains itself when
  // nothing is on file, and is never shown for an unlinked prospect
  // (which has no donor address to use at all). ---
  assert.match(tripDashboard, /Use donor address/);
  assert.match(tripDashboard, /prospect\.isLinked && <p className="travel-planning-use-address">/, "the Use donor address control must only ever render for a linked prospect");
  assert.match(tripDashboard, /onClick=\{\(\) => setLocationDraft\(donorAddress \?\? ""\)\}/, "must only ever set the location from an explicit button click, never automatically");
  assert.match(tripDashboard, /No address on file for this donor/);
  assert.doesNotMatch(tripDashboard.replace(/onClick=\{\(\) => setLocationDraft\(donorAddress \?\? ""\)\}/, ""), /setLocationDraft\(donorAddress/, "donorAddress must never be written into locationDraft anywhere outside that one explicit click handler (e.g. never in a useEffect/useState initializer, which would auto-overwrite an already-entered location)");
  assert.match(tripDashboard, /const donorAddress = prospect\.isLinked \? formatDonorAddress\(/, "donorAddress itself must be null for an unlinked prospect, not merely hidden in the UI");

  console.log("trip-calendar-link: ok");
}

await run();
