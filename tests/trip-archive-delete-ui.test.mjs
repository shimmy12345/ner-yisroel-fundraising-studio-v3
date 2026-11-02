import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Add Archive and Delete Options to Trip Planner (2026-11-02, see
// docs/AI-HANDOFF.md). Source-inspection tests (no React/DOM test
// runner in this codebase -- see tests/trip-calendar-link.test.mjs's
// own established pattern) proving the UI is actually wired to the
// safe data-layer functions, and that the required warning text and
// list-filtering behavior are present in the real source.

const dashboardSource = await readFile(new URL("../app/travel-planning/[id]/TripDashboardExperience.tsx", import.meta.url), "utf8");
const listSource = await readFile(new URL("../app/travel-planning/TravelPlanningExperience.tsx", import.meta.url), "utf8");

function extractFunctionSource(source, functionName) {
  const start = source.indexOf(`function ${functionName}(`);
  assert.ok(start !== -1, `${functionName} must exist in the source`);
  // Skip past the parameter list (tracking paren depth, since a
  // destructured/typed parameter list itself contains `{`/`}`) to find
  // the function BODY's own opening brace, not an incidental one
  // inside the signature.
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
  const menuSource = extractFunctionSource(dashboardSource, "TripManagementMenu");

  // --- Archive/Restore uses PATCH {archived}, never a native
  // window.confirm() (so the warning text can actually explain
  // consequences) and never DELETE. ---
  assert.match(menuSource, /method:\s*"PATCH"/);
  assert.match(menuSource, /archived/);
  assert.ok(!/window\.confirm/.test(menuSource), "Archive/Delete must use the in-page confirm panel, not a native window.confirm() dialog");

  // --- Delete uses the real DELETE endpoint, and its confirm text
  // explicitly reassures donor/financial data is preserved. ---
  assert.match(menuSource, /method:\s*"DELETE"/);
  assert.match(menuSource, /donor profile|donor.s own permanent record/i);
  assert.match(menuSource, /pledge|donation/i);

  // --- A blocked (financial-activity) delete response offers Archive
  // as the explicit alternative, never a way to force the delete
  // through. ---
  assert.match(menuSource, /Archive Trip instead/);
  assert.ok(!/force/i.test(menuSource), "there must be no way to override/force a blocked delete from the UI");

  // --- Restoring is exposed once a trip is archived. ---
  assert.match(menuSource, /archivedAt === null/);
  assert.match(menuSource, /Restore Trip/);

  // --- The trip list: archived trips are excluded from "All" and
  // every status tab by default, and visible only via a dedicated
  // Archived filter -- the owner's own explicit "remove the trip from
  // the default active trip list" / "allow archived trips to be viewed
  // through an Archived Trips filter" requirements. ---
  assert.match(listSource, /trip\.archivedAt === null/, "the active trip list must filter out archived trips");
  assert.match(listSource, /filter === "archived" \? archivedTrips/, "the Archived tab must show the archived set, not the active one");
  assert.match(listSource, /id:\s*"archived",\s*label:\s*"Archived"/);

  console.log("trip-archive-delete-ui.test.mjs: all assertions passed");
}

await run();
