import assert from "node:assert/strict";
import { isCalendarSyncAllowed } from "../lib/calendar/calendar-sync-guard.ts";

const base = { environment: "production-independent", calendarSyncEnabled: true, credentialsPresent: true, verifiedEmail: "sgoldstein@nirc.edu", calendarId: "primary", stagingTestCalendarId: null };

// --- The happy path, for sanity ---
assert.equal(isCalendarSyncAllowed(base).allowed, true);

// --- Issue 4: real disconnect and verified-account refusal ---
assert.equal(isCalendarSyncAllowed({ ...base, calendarSyncEnabled: false }).allowed, false, "a persisted disabled flag must refuse sync outright, regardless of anything else");
assert.equal(isCalendarSyncAllowed({ ...base, credentialsPresent: false }).allowed, false);
assert.equal(isCalendarSyncAllowed({ ...base, verifiedEmail: null }).allowed, false, "an unverified account must refuse sync -- never trust a cached/typed label");
assert.equal(isCalendarSyncAllowed({ ...base, verifiedEmail: "someone-else@gmail.com" }).allowed, false, "Production must refuse sync for any account other than the owner's");
assert.equal(isCalendarSyncAllowed({ ...base, calendarId: "some-other-calendar@group.calendar.google.com" }).allowed, false, "Production must refuse any destination other than the owner's primary calendar");

// --- Issue 6: Staging requires an explicit test calendar, "primary" is always refused ---
const staging = { environment: "staging-independent", calendarSyncEnabled: true, credentialsPresent: true, verifiedEmail: "test-account@example.test", calendarId: "test-cal-123@group.calendar.google.com", stagingTestCalendarId: "test-cal-123@group.calendar.google.com" };
assert.equal(isCalendarSyncAllowed(staging).allowed, true, "Staging with a properly configured, explicit, non-primary test calendar must be allowed");

assert.equal(isCalendarSyncAllowed({ ...staging, stagingTestCalendarId: null }).allowed, false, "Staging with no explicit test calendar configured must refuse sync outright");
assert.equal(isCalendarSyncAllowed({ ...staging, calendarId: "primary", stagingTestCalendarId: "primary" }).allowed, false, "Staging must refuse \"primary\" even if someone configured the opt-in var to literally be \"primary\"");
assert.equal(isCalendarSyncAllowed({ ...staging, calendarId: "some-other-cal@group.calendar.google.com" }).allowed, false, "Staging's calendar id must match the configured test calendar exactly");

// Belt-and-braces: even with a correctly-configured test calendar AND the
// Staging opt-in enabled, if the authorized token somehow resolves to the
// real Production owner's account (e.g. Production secrets accidentally
// copied onto Staging), refuse outright.
assert.equal(isCalendarSyncAllowed({ ...staging, verifiedEmail: "sgoldstein@nirc.edu" }).allowed, false, "Staging must refuse sync even with a valid test calendar if the account is the real Production owner's");

// --- Unrecognized environment: refuse, never fall through to allowed ---
assert.equal(isCalendarSyncAllowed({ ...base, environment: "something-unexpected" }).allowed, false);

process.stdout.write("calendar-sync-guard.test.mjs: all assertions passed\n");
