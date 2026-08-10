import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reminderDueAt } from "../lib/capture/interaction.ts";

// Bug: reminderDueAt() interpreted "tomorrow"/"next-week"/a custom date
// using the Cloudflare Worker's own UTC runtime clock (new Date(now) plus
// .setHours()/.setDate(), which operate in whatever timezone the process
// itself runs in -- UTC in a Worker) instead of the user's stored
// profile.timezone. Fixed to resolve the target local calendar day first
// (in the user's timezone), then convert that local 9:00 AM wall-clock
// time to UTC only for storage (zonedTimeToUtc, lib/workspace/local-time.ts),
// DST-safe.

const ET = "America/New_York";
const LA = "America/Los_Angeles";

// Reads back an absolute Date's wall-clock hour/minute in a given
// timezone, so assertions never depend on the test runner's own local
// timezone (unlike Date.prototype.getHours()/getDate()).
function wallClock(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

async function run() {
  // ---- "tomorrow at 9am" near a UTC/local date boundary: 23:30 in
  // America/New_York (EDT, UTC-4) is already 03:30 the next UTC day. A
  // Worker running its own UTC clock would compute "tomorrow" from the
  // UTC calendar day and land a full day too late. ----
  const nearMidnightEdtButNextDayUtc = new Date(Date.UTC(2026, 6, 31, 3, 30, 0)); // 2026-07-30 23:30 EDT
  const tomorrowNearBoundary = reminderDueAt("tomorrow", undefined, nearMidnightEdtButNextDayUtc, ET);
  assert.equal(wallClock(tomorrowNearBoundary, ET), "2026-07-31 09:00", "tomorrow must be the user's next LOCAL calendar day, not the UTC one");
  assert.equal(tomorrowNearBoundary.toISOString(), "2026-07-31T13:00:00.000Z", "9:00 AM EDT stores as 13:00 UTC");

  // ---- DST spring-forward: 2026-03-08 is the day America/New_York jumps
  // from EST (UTC-5) to EDT (UTC-4) at 2:00 AM local. A reminder for
  // "tomorrow at 9am" created the evening before must still land on
  // exactly 9:00 AM local wall-clock time on the transition day itself
  // (which only has 23 hours). ----
  const eveningBeforeSpringForward = new Date(Date.UTC(2026, 2, 8, 1, 0, 0)); // 2026-03-07 20:00 EST
  const springForwardReminder = reminderDueAt("tomorrow", undefined, eveningBeforeSpringForward, ET);
  assert.equal(wallClock(springForwardReminder, ET), "2026-03-08 09:00", "must land on 9:00 AM local time on the spring-forward day itself");
  assert.equal(springForwardReminder.toISOString(), "2026-03-08T13:00:00.000Z", "9am EDT (already in effect by 9am) stores as 13:00 UTC, not 14:00");

  // ---- DST fall-back: 2026-11-01 is the day America/New_York falls back
  // from EDT (UTC-4) to EST (UTC-5) at 2:00 AM local (clocks read 1:00 AM
  // twice). A reminder for "tomorrow at 9am" the evening before must still
  // land on 9:00 AM on the (25-hour) transition day. ----
  const eveningBeforeFallBack = new Date(Date.UTC(2026, 10, 1, 0, 0, 0)); // 2026-10-31 20:00 EDT
  const fallBackReminder = reminderDueAt("tomorrow", undefined, eveningBeforeFallBack, ET);
  assert.equal(wallClock(fallBackReminder, ET), "2026-11-01 09:00", "must land on 9:00 AM local time on the fall-back day itself");
  assert.equal(fallBackReminder.toISOString(), "2026-11-01T14:00:00.000Z", "9am EST (already in effect by 9am) stores as 14:00 UTC, not 13:00");

  // ---- today/tomorrow across local midnight: one minute before and one
  // minute after midnight in America/New_York must resolve to different
  // "tomorrow" targets, exactly one local calendar day apart each time --
  // proving the boundary is local midnight, not UTC midnight (which falls
  // hours earlier in the evening for this timezone). ----
  const oneMinuteBeforeLocalMidnight = new Date(Date.UTC(2026, 6, 31, 3, 59, 0)); // 2026-07-30 23:59 EDT
  const oneMinuteAfterLocalMidnight = new Date(Date.UTC(2026, 6, 31, 4, 1, 0)); // 2026-07-31 00:01 EDT
  assert.equal(wallClock(reminderDueAt("tomorrow", undefined, oneMinuteBeforeLocalMidnight, ET), ET), "2026-07-31 09:00");
  assert.equal(wallClock(reminderDueAt("tomorrow", undefined, oneMinuteAfterLocalMidnight, ET), ET), "2026-08-01 09:00");

  // ---- America/New_York is the default when no timezone is supplied
  // (matching lib/auth/profile.ts's stored default). ----
  const now = new Date(Date.UTC(2026, 6, 30, 16, 0, 0)); // 2026-07-30 12:00 EDT
  const defaultResult = reminderDueAt("tomorrow", undefined, now);
  const explicitEtResult = reminderDueAt("tomorrow", undefined, now, ET);
  assert.equal(defaultResult.toISOString(), explicitEtResult.toISOString(), "omitting timezone must behave exactly like passing America/New_York");
  assert.equal(wallClock(defaultResult, ET), "2026-07-31 09:00");

  // ---- Another valid IANA timezone entirely (America/Los_Angeles, PDT =
  // UTC-7 in summer) -- proves the fix is genuinely timezone-parameterized,
  // not hardcoded to Eastern. ----
  const noonPacific = new Date(Date.UTC(2026, 6, 30, 19, 0, 0)); // 2026-07-30 12:00 PDT
  const pacificReminder = reminderDueAt("tomorrow", undefined, noonPacific, LA);
  assert.equal(wallClock(pacificReminder, LA), "2026-07-31 09:00", "9am must mean 9am in the SUPPLIED timezone");
  assert.equal(pacificReminder.toISOString(), "2026-07-31T16:00:00.000Z", "9am PDT stores as 16:00 UTC");
  // The same absolute instant, read back in a different timezone, is a
  // different local hour -- confirming the stored value is a genuine UTC
  // instant, not a mislabeled local time.
  assert.notEqual(wallClock(pacificReminder, ET), "2026-07-31 09:00");

  // ---- Stored UTC instant converts back to the intended local wall-clock
  // time -- the round trip that actually matters for the user: whatever
  // gets written to D1 (an epoch second) must format back to exactly
  // 9:00 AM in the timezone the reminder was created for. ----
  for (const [timezone, label] of [[ET, "America/New_York"], [LA, "America/Los_Angeles"]]) {
    const created = reminderDueAt("tomorrow", undefined, now, timezone);
    const storedEpochSeconds = Math.floor(created.getTime() / 1000);
    const roundTripped = new Date(storedEpochSeconds * 1000);
    assert.equal(wallClock(roundTripped, timezone).endsWith("09:00"), true, `${label}: the stored epoch must format back to 9:00 AM local`);
  }

  // ---- Existing behavior preserved for every other supported choice:
  // next-week is still +7 calendar days, custom still parses its Y-M-D
  // date, "none" and a missing/invalid custom date are unchanged. ----
  assert.equal(wallClock(reminderDueAt("next-week", undefined, now, ET), ET), "2026-08-06 09:00");
  assert.equal(wallClock(reminderDueAt("custom", "2026-08-15", now, ET), ET), "2026-08-15 09:00");
  assert.equal(reminderDueAt("none", undefined, now, ET), null);
  assert.equal(reminderDueAt("custom", undefined, now, ET), null);
  assert.equal(reminderDueAt("custom", "not-a-date", now, ET), null);

  // ---- Source wiring: both write paths must pass the authenticated
  // owner's stored timezone, and profile must be resolved before
  // reminderDueAt is called. ----
  const interactionsRoute = await readFile(new URL("../app/api/interactions/route.ts", import.meta.url), "utf8");
  const interactionByIdRoute = await readFile(new URL("../app/api/interactions/[id]/route.ts", import.meta.url), "utf8");
  const interactionLib = await readFile(new URL("../lib/capture/interaction.ts", import.meta.url), "utf8");
  assert.match(interactionsRoute, /reminderDueAt\(reminder, body\.customDate, capturedAt, profile\.timezone\)/);
  assert.match(interactionByIdRoute, /reminderDueAt\(reminder, body\.customDate, nowDate, profile\.timezone\)/);
  assert.match(interactionLib, /zonedTimeToUtc/);
  assert.doesNotMatch(interactionLib, /due\.setHours|due\.setDate|due\.setFullYear/, "must never mutate a Date in the runtime's own local/UTC timezone again");
  assert.match(interactionLib, /timezone = "America\/New_York"/, "the default must match the stored-profile default");

  process.stdout.write("Reminder timezone checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
