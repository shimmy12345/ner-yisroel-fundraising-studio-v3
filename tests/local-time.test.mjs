import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localHour, localDayKey, timeOfDayGreeting, localMonthBoundaries } from "../lib/workspace/local-time.ts";

// Bug: the homepage always said "Good morning" regardless of the actual
// time of day -- app/page.tsx had it as a hardcoded literal, with no
// time-of-day logic at all (not even a UTC-based one). Root cause traced
// via direct code search: no other greeting-computing code existed
// anywhere in the app. Fixed by adding a single reusable, timezone-aware
// helper (this file) and wiring it to the user's stored profile.timezone
// (defaulting to "America/New_York", confirmed already the default in
// lib/auth/profile.ts) -- never the Cloudflare Worker's own UTC runtime
// clock and never the browser's timezone.

const ET = "America/New_York";
// 2026-08-10 falls within US Daylight Saving Time (EDT, UTC-4) --
// second Sunday of March through the first Sunday of November.
const utcEpoch = (hour, minute = 0) => Date.UTC(2026, 7, 10, hour, minute, 0) / 1000;

async function run() {
  // ---- Boundaries, evaluated in America/New_York local time. ----
  assert.equal(timeOfDayGreeting(utcEpoch(8, 59), ET), "Good evening", "04:59 ET -> evening");
  assert.equal(timeOfDayGreeting(utcEpoch(9, 0), ET), "Good morning", "05:00 ET -> morning");
  assert.equal(timeOfDayGreeting(utcEpoch(15, 59), ET), "Good morning", "11:59 ET -> morning");
  assert.equal(timeOfDayGreeting(utcEpoch(16, 0), ET), "Good afternoon", "12:00 ET -> afternoon");
  assert.equal(timeOfDayGreeting(utcEpoch(20, 59), ET), "Good afternoon", "16:59 ET -> afternoon");
  assert.equal(timeOfDayGreeting(utcEpoch(21, 0), ET), "Good evening", "17:00 ET -> evening");

  // Midnight and just-before-5am both remain "evening" (5pm - 4:59am spans
  // midnight), and noon itself is the afternoon boundary, not still morning.
  assert.equal(timeOfDayGreeting(utcEpoch(4, 0), ET), "Good evening", "midnight ET -> still evening");
  assert.equal(timeOfDayGreeting(utcEpoch(8, 30), ET), "Good evening", "4:30am ET -> still evening");

  // ---- UTC/local-time mismatch: a naive implementation that read the
  // hour directly off a UTC Date (or ran in the Worker's own UTC runtime
  // clock without ever converting to the user's timezone) gets these
  // exactly backwards. ----
  // 05:00 UTC is 01:00 ET (EDT, UTC-4) -- a UTC-naive read would call this
  // "Good morning" (hour 5); the real answer, in the user's actual local
  // time, is "Good evening".
  assert.equal(localHour(utcEpoch(5, 0), "UTC"), 5);
  assert.equal(localHour(utcEpoch(5, 0), ET), 1);
  assert.equal(timeOfDayGreeting(utcEpoch(5, 0), ET), "Good evening", "UTC says morning (hour 5); America/New_York is still evening (hour 1)");

  // Vice versa (the mirror direction -- a 4-hour offset can't literally
  // flip morning<->evening both ways, so this proves the other direction
  // of the same class of bug): 17:00 UTC is 13:00 ET -- a UTC-naive read
  // would call this "Good evening" (hour 17); the real local answer is
  // "Good afternoon".
  assert.equal(localHour(utcEpoch(17, 0), "UTC"), 17);
  assert.equal(localHour(utcEpoch(17, 0), ET), 13);
  assert.equal(timeOfDayGreeting(utcEpoch(17, 0), ET), "Good afternoon", "UTC says evening (hour 17); America/New_York is still afternoon (hour 13)");

  // ---- localDayKey: used for the Morning Brief's "completed today" state
  // -- must reflect the user's local calendar day, not UTC's. Just before
  // midnight UTC is already the next calendar day in a timezone west of
  // UTC only when far enough behind; for America/New_York (behind UTC),
  // late evening UTC is still the same or an earlier local calendar day.
  assert.equal(localDayKey(utcEpoch(2, 0), ET), "2026-08-09", "02:00 UTC is still 2026-08-09 in America/New_York (22:00 the prior evening)");
  assert.equal(localDayKey(utcEpoch(5, 0), ET), "2026-08-10", "05:00 UTC is 2026-08-10 01:00 in America/New_York -- already the new local day");
  assert.notEqual(localDayKey(utcEpoch(2, 0), "UTC"), localDayKey(utcEpoch(2, 0), ET), "the same instant must resolve to different calendar days in different timezones");

  // ---- Source wiring: no hardcoded greeting remains, and the shared
  // helper -- not a duplicated one -- is what every surface uses. ----
  const homepage = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const briefExperience = await readFile(new URL("../app/components/BriefExperience.tsx", import.meta.url), "utf8");
  const assistantExperience = await readFile(new URL("../app/assistant/AssistantExperience.tsx", import.meta.url), "utf8");
  const assistantPage = await readFile(new URL("../app/assistant/page.tsx", import.meta.url), "utf8");
  const localDateComponent = await readFile(new URL("../app/components/LocalDate.tsx", import.meta.url), "utf8");
  const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
  const scheduledActivity = await readFile(new URL("../lib/workspace/scheduled-activity.ts", import.meta.url), "utf8");
  const relationshipQueue = await readFile(new URL("../lib/workspace/relationship-queue.ts", import.meta.url), "utf8");

  assert.doesNotMatch(homepage, /Good morning, \{profile\.preferredFirstName\}/, "the hardcoded literal greeting must be gone");
  assert.match(homepage, /timeOfDayGreeting\(/);
  assert.match(homepage, /import \{ timeOfDayGreeting \} from "\.\.\/lib\/workspace\/local-time"/);
  assert.match(homepage, /profile\.timezone/, "the greeting must use the stored user timezone, not a hardcoded one");

  // The Morning Brief's own timezone-sensitive bug: "completed today" was
  // keyed by the browser's local date (new Date().toLocaleDateString()
  // with no timeZone), not the user's stored timezone.
  assert.doesNotMatch(briefExperience, /new Date\(\)\.toLocaleDateString/, "the Morning Brief completion key must never read the browser's own local date");
  assert.match(briefExperience, /localDayKey\(/);
  assert.match(briefExperience, /timezone: string/, "BriefExperience must require an explicit timezone, not infer one");
  assert.match(assistantExperience, /timezone/);
  assert.match(assistantPage, /timezone=\{profile\.timezone\}/);

  // Already-correct surfaces, reconfirmed here as part of the audit: the
  // homepage date heading (LocalDate), Today's Agenda scheduling bucket,
  // and reminder due-state bucketing all already take an explicit
  // timezone parameter through Intl.DateTimeFormat, never the runtime's
  // own clock or a hardcoded zone.
  assert.match(localDateComponent, /timeZone: timezone/);
  assert.match(liveData, /function dayKey\(epoch: number, timezone: string\)/);
  assert.match(scheduledActivity, /function localDay\(epoch: number, timezone: string\)/);
  assert.match(relationshipQueue, /function relationshipQueueBucket\(dueAt: number \| null, now: number, timezone: string\)/);

  // ---- localMonthBoundaries: monthly fundraising totals must use the
  // fundraiser's LOCAL calendar month, never UTC's own current month
  // (independent code review, monthly fundraising totals and timezone
  // boundaries, 2026-10-16: lib/assistant/capabilities.ts's
  // getFundraisingProgress previously truncated `now` straight to UTC
  // midnight of the 1st, so a gift or contact near local midnight could
  // be silently counted in the wrong reporting month). ----

  // Plain midday case, no boundary trickiness: Oct 15, 2026 15:00 UTC is
  // Oct 15 11:00 EDT (UTC-4) -- squarely inside October both ways.
  {
    const b = localMonthBoundaries(Date.UTC(2026, 9, 15, 15, 0, 0) / 1000, ET);
    assert.equal(b.periodLabel, "October 2026");
    assert.equal(b.dateOnlyStartEpoch, Date.UTC(2026, 9, 1) / 1000, "date-only boundary is Oct 1 at UTC midnight -- the same convention activity_date itself uses");
    assert.equal(b.instantStartEpoch, Date.UTC(2026, 9, 1, 4, 0, 0) / 1000, "instant boundary is the real UTC moment of Oct 1 00:00 EDT (UTC-4)");
  }

  // THE regression this fix targets: it is already Nov 1 in UTC, but
  // still Oct 31 evening in America/New_York -- a UTC-naive boundary
  // would wrongly treat this moment as "November," closing out October's
  // totals roughly 4-5 hours early every single month.
  {
    const nowUtcNov1Early = Date.UTC(2026, 10, 1, 2, 0, 0) / 1000; // Nov 1 02:00 UTC = Oct 31 22:00 EDT
    const b = localMonthBoundaries(nowUtcNov1Early, ET);
    assert.equal(b.periodLabel, "October 2026", "the fundraiser's own local calendar day is still Oct 31 -- this must still report October, not November");
    assert.equal(b.dateOnlyStartEpoch, Date.UTC(2026, 9, 1) / 1000);
  }

  // Mirror sanity check, just inside the new local month: Nov 1 06:00 UTC
  // is Nov 1 02:00 EDT (EDT ends later that same day) -- genuinely
  // November locally, so the boundary must have already rolled over.
  {
    const nowJustAfterRollover = Date.UTC(2026, 10, 1, 6, 0, 0) / 1000;
    const b = localMonthBoundaries(nowJustAfterRollover, ET);
    assert.equal(b.periodLabel, "November 2026");
    assert.equal(b.dateOnlyStartEpoch, Date.UTC(2026, 10, 1) / 1000);
  }

  // Year rollover: Jan 1, 2026 03:00 UTC is Dec 31, 2025 22:00 EST
  // (winter, UTC-5) -- still December of the PRIOR year, not January.
  {
    const nowNewYearUtc = Date.UTC(2026, 0, 1, 3, 0, 0) / 1000;
    const b = localMonthBoundaries(nowNewYearUtc, ET);
    assert.equal(b.periodLabel, "December 2025");
    assert.equal(b.dateOnlyStartEpoch, Date.UTC(2025, 11, 1) / 1000);
    assert.equal(b.instantStartEpoch, Date.UTC(2025, 11, 1, 5, 0, 0) / 1000, "Dec 1 2025 00:00 EST (UTC-5, winter) is Dec 1 05:00 UTC");
  }

  // DST transition inside the month itself: March 2026's 1st falls BEFORE
  // that year's "spring forward" (2026-03-08), so the month-start instant
  // must use the EARLIER (EST, UTC-5) offset even when "now" is evaluated
  // well after the transition, later in the same month.
  {
    const nowLateMarchAfterDstStart = Date.UTC(2026, 2, 20, 12, 0, 0) / 1000; // Mar 20, well after spring-forward
    const b = localMonthBoundaries(nowLateMarchAfterDstStart, ET);
    assert.equal(b.periodLabel, "March 2026");
    assert.equal(b.dateOnlyStartEpoch, Date.UTC(2026, 2, 1) / 1000);
    assert.equal(b.instantStartEpoch, Date.UTC(2026, 2, 1, 5, 0, 0) / 1000, "Mar 1 2026 00:00 is still EST (UTC-5) -- DST does not start until Mar 8");
  }

  // The two epoch conventions must never collapse into the same value for
  // a timezone with a real offset -- a "fix" that quietly merges them
  // back into one UTC-midnight boundary would reintroduce this exact bug
  // for occurred_at-based counts (e.g. donorsContacted).
  {
    const b = localMonthBoundaries(Date.UTC(2026, 9, 15, 15, 0, 0) / 1000, ET);
    assert.notEqual(b.dateOnlyStartEpoch, b.instantStartEpoch, "date-only and true-instant month boundaries must differ for a non-UTC timezone");
  }

  // A genuinely UTC fundraiser (sanity check, not the production policy)
  // collapses both conventions to the same value, since there is no
  // offset to create a mismatch.
  {
    const b = localMonthBoundaries(Date.UTC(2026, 9, 15, 15, 0, 0) / 1000, "UTC");
    assert.equal(b.dateOnlyStartEpoch, b.instantStartEpoch);
    assert.equal(b.periodLabel, "October 2026");
  }

  process.stdout.write("Local time-of-day checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
