import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMutatingMethod,
  isStagingWritesOverrideEnabled,
  isTripPlanningWritePath,
  shouldBlockStagingWrite,
  STAGING_READ_ONLY_MESSAGE,
} from "../lib/operations/staging-write-guard.ts";

// --- Pure unit coverage ---

assert.equal(isMutatingMethod("POST"), true);
assert.equal(isMutatingMethod("put"), true, "case-insensitive");
assert.equal(isMutatingMethod("PATCH"), true);
assert.equal(isMutatingMethod("DELETE"), true);
assert.equal(isMutatingMethod("GET"), false);
assert.equal(isMutatingMethod("HEAD"), false);
assert.equal(isMutatingMethod("OPTIONS"), false);

assert.equal(isStagingWritesOverrideEnabled("true"), true);
assert.equal(isStagingWritesOverrideEnabled("TRUE"), false, "must be exact lowercase \"true\", never a loose truthy check");
assert.equal(isStagingWritesOverrideEnabled("1"), false);
assert.equal(isStagingWritesOverrideEnabled(undefined), false);
assert.equal(isStagingWritesOverrideEnabled(""), false);

// The core gate: only blocks on staging-independent, only for mutating
// methods, only under /api/, only when the override is absent.
assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/api/donors", undefined), true);
assert.equal(shouldBlockStagingWrite("staging-independent", "PUT", "/api/donors/abc", undefined), true);
assert.equal(shouldBlockStagingWrite("staging-independent", "PATCH", "/api/giving/abc", undefined), true);
assert.equal(shouldBlockStagingWrite("staging-independent", "DELETE", "/api/asks/abc", undefined), true);

assert.equal(shouldBlockStagingWrite("staging-independent", "GET", "/api/donors", undefined), false, "reads must never be blocked -- browsing existing data is explicitly preserved");
assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/donors", undefined), false, "a non-API path (a page route) is out of scope for this guard");
assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/api/donors", "true"), false, "the explicit override must lift the block");
assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/api/donors", "TRUE"), true, "override must be exact-match \"true\", not a loose truthy check");

// Never blocks on any environment other than staging-independent --
// including production-independent, the two legacy values, and any
// unrecognized string (fail OPEN on an unrecognized environment would be
// wrong for a destructive reset, but this guard's failure mode is the
// opposite: an unrecognized value just means "don't apply a staging-only
// restriction", which is the safe default here).
for (const env of ["production-independent", "staging", "production", "something-unexpected"]) {
  assert.equal(shouldBlockStagingWrite(env, "POST", "/api/donors", undefined), false, `must never block on deploymentEnvironment=${env}`);
}

assert.match(STAGING_READ_ONLY_MESSAGE, /read-only/i);
assert.match(STAGING_READ_ONLY_MESSAGE, /Production/);

// --- Trip Planning carve-out: a narrow, path-prefix exception so an
// authorized tester can exercise that feature on Staging without
// flipping STAGING_WRITES_ENABLED (which would also re-open every
// donor/financial/import route this guard exists to protect). ---

assert.equal(isTripPlanningWritePath("/api/trips"), true);
assert.equal(isTripPlanningWritePath("/api/trips/abc123"), true);
assert.equal(isTripPlanningWritePath("/api/trips/abc123/prospects"), true);
assert.equal(isTripPlanningWritePath("/api/trips/abc123/prospects/def456"), true);
assert.equal(isTripPlanningWritePath("/api/tripsomething"), false, "must not match on a mere string prefix -- only an exact segment or a path under it");
assert.equal(isTripPlanningWritePath("/api/donors"), false);
assert.equal(isTripPlanningWritePath("/api"), false);

assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/api/trips", undefined), false, "creating a trip must be allowed on Staging without the override");
assert.equal(shouldBlockStagingWrite("staging-independent", "PATCH", "/api/trips/abc/prospects/def", undefined), false, "updating/scheduling/completing a trip prospect must be allowed on Staging without the override");
assert.equal(shouldBlockStagingWrite("staging-independent", "DELETE", "/api/trips/abc/prospects/def", undefined), false, "removing a trip prospect must be allowed on Staging without the override");
assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/api/tripsomething", undefined), true, "a route that merely starts with the same letters, but isn't actually under /api/trips, must stay blocked");
assert.equal(shouldBlockStagingWrite("staging-independent", "POST", "/api/donors", undefined), true, "the carve-out must never leak into unrelated donor/financial routes");

// Google Calendar sync narrowed first release (2026-10-19 review,
// follow-up): "confirm the Settings enable/disable behavior is
// consistent with the Staging safety guard." PATCH /api/calendar-sync
// is a new route, outside /api/trips, so it deliberately falls into the
// SAME blocked "accepted trade-off" bucket as PUT /api/profile -- it is
// NOT added to the Trip Planning carve-out (that carve-out's own
// justification is specifically "every route this feature has or ever
// will have lives under /api/trips by construction," which
// /api/calendar-sync does not satisfy; adding it would be exactly the
// kind of unauthorized carve-out growth this guard's own header warns
// against). This is also proven generically by the repo-wide route walk
// below (nonTripRouteFiles), but asserted directly here too, by name,
// since it is the one behavior an owner testing Settings on Staging will
// actually hit.
assert.equal(shouldBlockStagingWrite("staging-independent", "PATCH", "/api/calendar-sync", undefined), true, "the calendar-sync enable/disable toggle is deliberately NOT exempted -- Staging stays read-only for it, same bucket as PUT /api/profile");
assert.equal(shouldBlockStagingWrite("staging-independent", "GET", "/api/calendar-sync", undefined), false, "reading the connection status is never blocked -- only the mutating PATCH is");
assert.equal(shouldBlockStagingWrite("staging-independent", "PATCH", "/api/calendar-sync", "true"), false, "the owner's own STAGING_WRITES_ENABLED escape hatch still lifts this block, same as every other non-Trip-Planning route");

// --- Structural coverage: the guard is actually wired into the one real
// request-dispatch path, ahead of everything else, and can never be
// bypassed by a route this repo doesn't know about yet. ---

const workerIndex = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
assert.match(workerIndex, /import \{ deploymentEnvironment \} from "\.\.\/lib\/environment"/);
assert.match(workerIndex, /shouldBlockStagingWrite/);
{
  const guardCallIndex = workerIndex.indexOf("shouldBlockStagingWrite(deploymentEnvironment");
  const imageBranchIndex = workerIndex.indexOf('url.pathname === "/_vinext/image"');
  const handlerFetchIndex = workerIndex.indexOf("handler.fetch(request, env, ctx)");
  assert.ok(guardCallIndex > 0, "the guard must actually be invoked in fetch()");
  assert.ok(guardCallIndex < imageBranchIndex, "the guard must run before the image-optimization branch, not after");
  assert.ok(guardCallIndex < handlerFetchIndex, "the guard must run before any route can be dispatched");
}

// Every API route file that can write must live under app/api/ -- this is
// the actual invariant the blanket `pathname.startsWith("/api/")` check in
// shouldBlockStagingWrite depends on. If a future route with a POST/PUT/
// PATCH/DELETE export ever lands outside app/api/, this guard would not
// see it, so this test must fail loudly rather than let that drift in
// silently.
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name === "route.ts") yield full;
  }
}
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const mutatingRouteFiles = [];
for await (const file of walk(appDir)) {
  const contents = await readFile(file, "utf8");
  if (/^export async function (POST|PUT|PATCH|DELETE)\b/m.test(contents)) mutatingRouteFiles.push(file);
}
assert.ok(mutatingRouteFiles.length > 0, "sanity check: this repo does have mutating API routes today");
for (const file of mutatingRouteFiles) {
  assert.ok(file.includes(`${path.sep}app${path.sep}api${path.sep}`), `mutating route file outside app/api/, not covered by the blanket /api/ guard: ${file}`);
}

// Trip Planning carve-out, checked against the REAL route tree (not just
// hardcoded example strings above): every mutating route actually under
// app/api/trips/ must be reachable through isTripPlanningWritePath, and
// -- the one risk this carve-out accepts -- no mutating route OUTSIDE
// app/api/trips/ (donors, asks, giving, pledges, imports, interactions,
// etc.) may ever be covered by it. If a future donor/financial route is
// ever added under /api/trips/* by mistake, this must fail loudly rather
// than silently reopen it on Staging.
const tripsApiDir = `${path.sep}app${path.sep}api${path.sep}trips${path.sep}`;
const tripRouteFiles = mutatingRouteFiles.filter((file) => file.includes(tripsApiDir));
const nonTripRouteFiles = mutatingRouteFiles.filter((file) => !file.includes(tripsApiDir));
assert.ok(tripRouteFiles.length > 0, "sanity check: Trip Planning does have mutating API routes today");
for (const file of tripRouteFiles) {
  const routePathname = `/api/${file.split(`${path.sep}app${path.sep}api${path.sep}`)[1].replace(/\\/g, "/").replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "placeholder")}`;
  assert.ok(isTripPlanningWritePath(routePathname), `a real Trip Planning route is not covered by the carve-out: ${routePathname}`);
}
for (const file of nonTripRouteFiles) {
  const routePathname = `/api/${file.split(`${path.sep}app${path.sep}api${path.sep}`)[1].replace(/\\/g, "/").replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "placeholder")}`;
  assert.ok(!isTripPlanningWritePath(routePathname), `a non-Trip-Planning route is unexpectedly covered by the /api/trips carve-out, which would leak Staging write access to it: ${routePathname}`);
}

// --- Config coverage: Production never carries the override, and the
// two Workers' email-cron state matches the post-cutover state (2026-
// 10-12 Production Daily Email Cutover round: Production active,
// Staging's matching block removed in the same deploy) at the moment
// this test suite runs. This is deliberately a snapshot assertion of a
// KNOWN state, not a permanent invariant -- update it again if the cron
// ever moves. ---

const wranglerStaging = await readFile(new URL("../wrangler.staging.jsonc", import.meta.url), "utf8");
const wranglerProduction = await readFile(new URL("../wrangler.production.jsonc", import.meta.url), "utf8");

assert.doesNotMatch(wranglerProduction, /"STAGING_WRITES_ENABLED"\s*:/, "Production must never carry this staging-only override var at all");
assert.match(wranglerStaging, /\/\/\s*"STAGING_WRITES_ENABLED"\s*:\s*"true"/, "the override must exist only as a commented-out, explicit opt-in on Staging");

// Staging's cron must be an EXPLICIT empty array, not an absent "triggers"
// key -- the 2026-10-12 cutover round removed the key entirely and
// Staging kept firing its old Cron Trigger registration anyway (confirmed
// live: a real agenda email with Staging's own links went out again on
// 2026-10-13), since Cloudflare does not clear a previously-registered
// schedule just because a later deploy's config omits it. See
// docs/AI-HANDOFF.md's 2026-10-13 incident writeup.
assert.match(wranglerStaging, /^\s*"triggers":\s*\{\s*"crons":\s*\[\s*\]\s*\}/m, "Staging's agenda cron must be explicitly cleared (an empty crons array), not merely absent -- an absent key does not actually stop Cloudflare from still firing a previously-registered schedule");
assert.match(wranglerProduction, /^\s*"triggers":\s*\{\s*"crons":\s*\[\s*"0 \* \* \* \*"\s*\]\s*\}/m, "Production's agenda cron must be active, matching the exact schedule Staging's used to carry");

console.log("staging-write-guard.test.mjs: all assertions passed");
