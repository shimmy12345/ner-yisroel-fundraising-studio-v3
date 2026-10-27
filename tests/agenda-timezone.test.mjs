import assert from "node:assert/strict";
import { currentEasternHour, isDailyAgendaSendHour, isDailyAgendaRecoveryHour, easternDateLabel, easternDateKey } from "../lib/agenda/timezone.ts";

// DST-safety for the Daily Fundraising Agenda's 9 AM America/New_York
// guard. The whole point of these tests: prove the guard tracks the
// *local* clock, not a fixed UTC instant, across both 2026 DST
// transitions (spring forward March 8, fall back November 1).

function epoch(iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

async function run() {
  // --- Same UTC hour means different local hours depending on season --
  // the core proof this isn't a fixed-UTC-time implementation. ---
  assert.equal(currentEasternHour(epoch("2026-01-15T14:00:00Z")), 9, "14:00 UTC in January (EST, UTC-5) is 9 AM local");
  assert.equal(currentEasternHour(epoch("2026-07-15T14:00:00Z")), 10, "the identical 14:00 UTC in July (EDT, UTC-4) is 10 AM local, not 9");
  assert.equal(currentEasternHour(epoch("2026-07-15T13:00:00Z")), 9, "13:00 UTC in July (EDT) is 9 AM local");
  assert.equal(currentEasternHour(epoch("2026-01-15T13:00:00Z")), 8, "the identical 13:00 UTC in January (EST) is 8 AM local, not 9");

  // --- isDailyAgendaSendHour: true only at the real local 9 AM instant,
  // in both seasons. ---
  assert.equal(isDailyAgendaSendHour(epoch("2026-01-15T14:00:00Z")), true);
  assert.equal(isDailyAgendaSendHour(epoch("2026-01-15T13:00:00Z")), false);
  assert.equal(isDailyAgendaSendHour(epoch("2026-01-15T15:00:00Z")), false);
  assert.equal(isDailyAgendaSendHour(epoch("2026-07-15T13:00:00Z")), true);
  assert.equal(isDailyAgendaSendHour(epoch("2026-07-15T12:00:00Z")), false);
  assert.equal(isDailyAgendaSendHour(epoch("2026-07-15T14:00:00Z")), false);

  // --- Spring-forward boundary (2026-03-08, clocks jump 2 AM EST ->
  // 3 AM EDT at the instant 07:00 UTC). The day before is still EST all
  // day; the transition day itself is EDT by the time local clocks read
  // 9 AM (long after the 2-3 AM jump). The UTC instant for "9 AM local"
  // moves an hour earlier, day over day. ---
  assert.equal(currentEasternHour(epoch("2026-03-07T14:00:00Z")), 9, "day before spring-forward: 14:00 UTC is still 9 AM EST");
  assert.equal(currentEasternHour(epoch("2026-03-08T13:00:00Z")), 9, "spring-forward day itself: 13:00 UTC is now 9 AM EDT");
  assert.equal(isDailyAgendaSendHour(epoch("2026-03-07T14:00:00Z")), true);
  assert.equal(isDailyAgendaSendHour(epoch("2026-03-08T13:00:00Z")), true);
  // The OLD "9 AM" UTC instant (14:00) on the transition day itself is
  // now 10 AM local -- proving the guard does not fire twice.
  assert.equal(currentEasternHour(epoch("2026-03-08T14:00:00Z")), 10);
  assert.equal(isDailyAgendaSendHour(epoch("2026-03-08T14:00:00Z")), false);

  // --- Fall-back boundary (2026-11-01, clocks fall back 2 AM EDT ->
  // 1 AM EST at the instant 06:00 UTC). The sharpest proof: the exact
  // same UTC hour (13:00) is 9 AM local the day before, but only 8 AM
  // local the day of/after the fallback -- one calendar day apart. ---
  assert.equal(currentEasternHour(epoch("2026-10-31T13:00:00Z")), 9, "day before fall-back: 13:00 UTC is still 9 AM EDT");
  assert.equal(currentEasternHour(epoch("2026-11-01T13:00:00Z")), 8, "fall-back day itself: the SAME 13:00 UTC is now only 8 AM EST");
  assert.equal(currentEasternHour(epoch("2026-11-01T14:00:00Z")), 9, "fall-back day itself: 9 AM EST now lands an hour later in UTC, at 14:00");
  assert.equal(isDailyAgendaSendHour(epoch("2026-10-31T13:00:00Z")), true);
  assert.equal(isDailyAgendaSendHour(epoch("2026-11-01T13:00:00Z")), false, "must not re-fire at the old UTC instant on the fall-back day");
  assert.equal(isDailyAgendaSendHour(epoch("2026-11-01T14:00:00Z")), true);

  // --- Same-day recovery window (10-11 AM Eastern, [10, 12) exclusive at
  // the top end) -- 2026-10-27 missed-send investigation, docs/
  // AI-HANDOFF.md. Same DST-safety requirement as the 9 AM guard above,
  // checked across both 2026 transitions. ---
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-01-15T14:00:00Z")), false, "9 AM EST (the primary hour) must not also be the recovery window");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-01-15T15:00:00Z")), true, "10 AM EST");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-01-15T16:00:00Z")), true, "11 AM EST");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-01-15T17:00:00Z")), false, "noon EST must be the firm close, not a third recovery tick");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-07-15T14:00:00Z")), true, "10 AM EDT");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-07-15T15:00:00Z")), true, "11 AM EDT");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-07-15T16:00:00Z")), false, "noon EDT must be the firm close, not a third recovery tick");
  // Fall-back day itself (2026-11-01): the window must follow the real
  // local clock across the transition, not a fixed UTC instant. The
  // sharpest proof: the SAME 15:00 UTC instant is 11 AM EDT the day
  // before (already inside the window) but only 10 AM EST the day of
  // (still inside the window, just for a different local reason) --
  // while 14:00 UTC flips from "10 AM EDT, inside the window" the day
  // before to "9 AM EST, the primary hour, not recovery" the day of.
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-10-31T14:00:00Z")), true, "day before fall-back: 14:00 UTC is 10 AM EDT");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-10-31T15:00:00Z")), true, "day before fall-back: 15:00 UTC is 11 AM EDT");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-11-01T14:00:00Z")), false, "fall-back day itself: the SAME 14:00 UTC is now 9 AM EST, the primary hour, not recovery");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-11-01T15:00:00Z")), true, "fall-back day itself: 15:00 UTC is now 10 AM EST");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-11-01T16:00:00Z")), true, "fall-back day itself: 16:00 UTC is now 11 AM EST");
  assert.equal(isDailyAgendaRecoveryHour(epoch("2026-11-01T17:00:00Z")), false, "fall-back day itself: 17:00 UTC is now noon EST, the firm close");

  // --- Midnight UTC edge case (date boundary correctness) --
  // America/New_York is always behind UTC, so a UTC-midnight instant is
  // still the *previous* calendar day in New York. ---
  assert.equal(easternDateKey(epoch("2026-08-26T02:00:00Z")), "2026-08-25", "02:00 UTC on the 26th is still 10 PM EDT on the 25th");
  assert.equal(easternDateKey(epoch("2026-08-26T05:00:00Z")), "2026-08-26", "05:00 UTC on the 26th is already 1 AM EDT on the 26th");

  // --- Subject/heading date label: real weekday/month/day text, not a
  // raw ISO date, and computed from the New York calendar date. ---
  assert.equal(easternDateLabel(epoch("2026-08-26T14:00:00Z")), "Wednesday, August 26");
  assert.equal(easternDateLabel(epoch("2026-01-15T14:00:00Z")), "Thursday, January 15");

  console.log("agenda-timezone: all assertions passed");
}

await run();
