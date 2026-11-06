import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Trip Planning Usability Fixes -- Back Navigation and Edit Trip Dates
// (2026-11-06, see docs/AI-HANDOFF.md). Source-inspection tests (no
// React/DOM test runner in this codebase -- see tests/trip-archive-
// delete-ui.test.mjs's own established pattern) proving: (1) a real
// back link to the Trip Planning list exists, and (2) editing trip
// dates reuses the existing PATCH endpoint, enforces end>=start,
// warns -- without ever deleting or rescheduling -- when a scheduled
// meeting would fall outside the new range, and never touches any
// other trip data (prospects, meetings, pledges, donations).

const dashboardSource = await readFile(new URL("../app/travel-planning/[id]/TripDashboardExperience.tsx", import.meta.url), "utf8");
const tripsDataSource = await readFile(new URL("../lib/relationships/trips-data.ts", import.meta.url), "utf8");

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(start !== -1, `${functionName} must exist in the source`);
  let parenDepth = 0, i = source.indexOf("(", start);
  for (; i < source.length; i++) {
    if (source[i] === "(") parenDepth++;
    else if (source[i] === ")") { parenDepth--; if (parenDepth === 0) { i++; break; } }
  }
  while (source[i] !== "{") i++;
  const bodyStart = i;
  let braceDepth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") braceDepth++;
    else if (source[i] === "}") { braceDepth--; if (braceDepth === 0) break; }
  }
  return source.slice(bodyStart, i + 1);
}

async function run() {
  // --- Back Navigation: a real link back to the Trip Planning list,
  // not a client-side-only action that could strand the owner if JS
  // fails, and not something that only appears on one viewport. ---
  assert.match(dashboardSource, /<a className="donor-back-button" href="\/travel-planning">/, "a real anchor back to /travel-planning must exist");
  assert.match(dashboardSource, /Back to Trips/);

  // --- Edit Trip Dates control. ---
  const editDatesSource = extractFunctionSource(dashboardSource, "EditTripDatesControl");

  // Reuses the existing PATCH endpoint with startDate/endDate -- never
  // a new/separate endpoint, never DELETE.
  assert.match(editDatesSource, /method:\s*"PATCH"/);
  assert.match(editDatesSource, /startDate:\s*newStart/);
  assert.match(editDatesSource, /endDate:\s*newEnd/);
  assert.ok(!/method:\s*"DELETE"/.test(editDatesSource), "editing dates must never delete anything");

  // Client-side end-before-start rejection (defense in depth; the
  // server's validateTripDates is the authoritative check).
  assert.match(editDatesSource, /newEnd < newStart/);

  // A meeting that would fall outside the new range blocks an
  // immediate save and requires an explicit second confirmation --
  // never a silent auto-delete/auto-reschedule, and never a native
  // window.confirm() (so the warning text can actually explain
  // consequences, same discipline as TripManagementMenu's own
  // archive/delete confirmations).
  assert.match(editDatesSource, /meetingFallsOutsideTripDates/);
  assert.match(editDatesSource, /Save dates anyway/);
  assert.match(editDatesSource, /will not be changed, cancelled, or rescheduled/);
  assert.ok(!/window\.confirm/.test(editDatesSource), "the outside-range warning must use the in-page confirm panel, not a native window.confirm() dialog");

  // The warning only fires on an explicit save attempt -- commit() is
  // only ever reached via save() (after the outside-range check) or
  // the confirm panel's own "Save dates anyway" button, never on
  // mount/open.
  assert.ok(!/useEffect/.test(editDatesSource), "nothing about editing trip dates should run automatically on mount");

  // --- updateTrip (lib/relationships/trips-data.ts) must never touch
  // any OTHER trip data when dates are changed -- only the `trips` row
  // itself (and, separately, destination regions when that field is
  // explicitly provided). This is what makes "preserve all associated
  // donors, manual prospects, meetings, AI notes, pledges, donations,
  // and financial totals" true by construction, not by convention. ---
  const updateTripSource = extractFunctionSource(tripsDataSource, "updateTrip");
  assert.match(updateTripSource, /UPDATE trips SET/);
  for (const forbiddenTable of ["trip_prospects", "interactions", "giving_activities", "trip_financial_attributions", "trip_prospect_commitments", "donors"]) {
    assert.ok(
      !new RegExp(`(?:UPDATE|DELETE FROM|INSERT INTO)\\s+${forbiddenTable}\\b`).test(updateTripSource),
      `updateTrip must never write to ${forbiddenTable} -- editing trip dates (or any other trip field) must not touch it`,
    );
  }

  console.log("trip-edit-dates-and-back-nav.test.mjs: all assertions passed");
}

await run();
