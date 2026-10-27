// DST-safe wall-clock helpers for the Daily Fundraising Agenda email.
//
// The whole point of these two functions: never encode a fixed UTC offset
// for "9 AM Eastern" anywhere. Both always ask Intl for the current local
// time in America/New_York at the moment they're called, so the correct
// answer automatically shifts across the March/November DST boundaries --
// the caller (the scheduled handler) is expected to run on an hourly
// cron and check `currentEasternHour(now) === 9` at execution time, not to
// pre-compute a UTC hour once and reuse it.

export const AGENDA_TIMEZONE = "America/New_York";

// The local hour (0-23) in America/New_York for the given epoch second.
// Used by the scheduled handler's DST-safe 9 AM guard: an hourly cron
// checking this against 9 fires exactly once per day regardless of
// whether EST or EDT is in effect that day.
export function currentEasternHour(nowSeconds: number): number {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENDA_TIMEZONE,
    hour: "numeric",
    hour12: false,
  }).format(new Date(nowSeconds * 1000));
  // Intl can format midnight as "24" with hour12: false in some engines --
  // normalize to the conventional 0-23 range.
  const hour = Number.parseInt(formatted, 10);
  return hour === 24 ? 0 : hour;
}

// The scheduled handler's whole DST-safety guard, in one named, directly
// testable function: an hourly cron checking this is true exactly once
// per calendar day, at whatever UTC instant happens to be 9 AM local that
// day (EST or EDT) -- never a fixed UTC hour baked into the cron string.
export function isDailyAgendaSendHour(nowSeconds: number): boolean {
  return currentEasternHour(nowSeconds) === 9;
}

// Same-day recovery window (2026-10-27 missed-send investigation --
// docs/AI-HANDOFF.md) -- the two hourly ticks immediately after the
// normal 9 AM send hour, reserved for automatically recovering a day
// whose 9 AM attempt never even reached its first database write (see
// send-agenda.ts's own header comment for exactly which condition
// qualifies). 10 and 11 only: the 12 PM tick is deliberately the first
// one that does NOT attempt recovery, so the window has a firm, visible
// close rather than drifting forward indefinitely. Like
// isDailyAgendaSendHour, this reads the real local hour at call time, so
// it stays correct across both DST transitions without any UTC-instant
// arithmetic of its own.
export const AGENDA_RECOVERY_WINDOW_START_HOUR = 10;
export const AGENDA_RECOVERY_WINDOW_END_HOUR = 12; // exclusive

export function isDailyAgendaRecoveryHour(nowSeconds: number): boolean {
  const hour = currentEasternHour(nowSeconds);
  return hour >= AGENDA_RECOVERY_WINDOW_START_HOUR && hour < AGENDA_RECOVERY_WINDOW_END_HOUR;
}

// "Wednesday, August 26" -- the weekday/month/day phrase used in the email
// subject and heading, computed from America/New_York's calendar date
// (which can differ from UTC's date near midnight), not the server's own
// local time or a fixed offset.
export function easternDateLabel(nowSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: AGENDA_TIMEZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(nowSeconds * 1000));
}

// YYYY-MM-DD in America/New_York -- used only by tests to assert which
// local calendar date a given epoch second falls on across a DST boundary.
export function easternDateKey(nowSeconds: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENDA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowSeconds * 1000));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
