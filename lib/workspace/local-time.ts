// Time-of-day helpers for the user's own wall-clock experience of the app
// (greetings, "today" boundaries for daily UI state) -- never the browser's
// or the Cloudflare Worker's own timezone, and never the financial-date
// rules in lib/financial-date.ts, which govern stored transaction dates,
// not "what time is it right now for this user". Every function here takes
// an explicit IANA timezone (the caller's stored profile.timezone) so the
// result is identical regardless of where the code executes -- server or
// browser, in any timezone.

export type TimeOfDayGreeting = "Good morning" | "Good afternoon" | "Good evening";

// Hour of day (0-23) in the given timezone, for an absolute Unix timestamp
// (seconds).
export function localHour(epochSeconds: number, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(epochSeconds * 1000)));
}

// Calendar day key (YYYY-MM-DD) in the given timezone -- for anything that
// needs to know "is this still the same local day" (e.g. the Morning
// Brief's once-per-day completion state).
export function localDayKey(epochSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epochSeconds * 1000));
}

// Good morning: 5:00 AM - 11:59 AM. Good afternoon: 12:00 PM - 4:59 PM.
// Good evening: 5:00 PM - 4:59 AM.
export function timeOfDayGreeting(epochSeconds: number, timezone: string): TimeOfDayGreeting {
  const hour = localHour(epochSeconds, timezone);
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 17) return "Good afternoon";
  return "Good evening";
}
