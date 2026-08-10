import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { localHour, localDayKey, timeOfDayGreeting } from "../lib/workspace/local-time.ts";

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

  process.stdout.write("Local time-of-day checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
