import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

// Requirement 5: "a future five-minute calendar sweep cannot trigger
// extra agenda emails." The calendar sweep is not wired into any cron
// yet (explicitly out of this round's authorized scope), so this proves
// the INDEPENDENCE property structurally, the same way
// tests/agenda-safety.test.mjs proves its own safety invariants: by
// source inspection of the actual shipped files, not by executing a real
// scheduled handler -- mirroring this repo's own established convention
// for `cloudflare:workers`-touching code that can't run outside a
// Workers runtime.

async function run() {
  const calendarDir = new URL("../lib/calendar/", import.meta.url);
  const calendarFiles = (await readdir(calendarDir, { recursive: true })).filter((name) => name.endsWith(".ts"));
  assert.ok(calendarFiles.length > 0, "sanity: the calendar module must actually exist");

  // --- No file under lib/calendar/ imports anything from lib/agenda/ --
  // the two feature's dependency graphs are completely disjoint, so a
  // calendar sweep literally has no code path by which it could call
  // sendGmail/sendDailyAgenda/runScheduledAgendaSend, however it is
  // eventually wired into a cron. ---
  for (const file of calendarFiles) {
    const source = await readFile(new URL(file, calendarDir), "utf8");
    assert.doesNotMatch(source, /from ["'].*\/agenda\//, `${file} must never import anything from lib/agenda/`);
    assert.doesNotMatch(source, /\bsendGmail\b|\bsendDailyAgenda\b|\brunScheduledAgendaSend\b/, `${file} must never reference the Gmail/agenda send functions by name`);
  }

  // --- The reverse must also hold: lib/agenda/ must not import anything
  // from lib/calendar/ (Google Calendar) -- this round added calendar
  // sync without modifying the existing, already-reviewed agenda code at
  // all. ---
  const agendaDir = new URL("../lib/agenda/", import.meta.url);
  const agendaFiles = (await readdir(agendaDir, { recursive: true })).filter((name) => name.endsWith(".ts"));
  for (const file of agendaFiles) {
    const source = await readFile(new URL(file, agendaDir), "utf8");
    assert.doesNotMatch(source, /from ["'].*\/calendar\//, `${file} must never import anything from lib/calendar/ -- the existing, already-reviewed Gmail agenda path must stay completely untouched by this round`);
  }

  // --- worker/index.ts (the one place a real cron handler would dispatch
  // both features) must be COMPLETELY untouched by this round -- no
  // calendar sweep is wired into it yet, confirming "do not enable cron
  // yet" was honored, and (as a consequence) nothing can call BOTH
  // features from the same invocation today. ---
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(workerSource, /calendar/i, "worker/index.ts must not yet reference calendar sync in any way -- wiring it in is explicitly out of this round's scope");
  assert.match(workerSource, /runScheduledAgendaSend/, "the existing agenda cron dispatch must remain exactly as it was");

  // --- wrangler.production.jsonc / wrangler.staging.jsonc must not yet
  // carry any new cron entry for calendar sync -- only the existing,
  // already-approved agenda schedule. ---
  for (const config of ["../wrangler.production.jsonc", "../wrangler.staging.jsonc"]) {
    const text = await readFile(new URL(config, import.meta.url), "utf8");
    const cronMatches = [...text.matchAll(/"crons"\s*:\s*\[([^\]]*)\]/g)];
    for (const match of cronMatches) assert.doesNotMatch(match[1], /\*\/5/, `${config} must not yet carry a 5-minute (calendar sweep) cron entry -- cron activation is explicitly out of this round's scope`);
  }

  process.stdout.write("calendar-sweep-agenda-independence.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
