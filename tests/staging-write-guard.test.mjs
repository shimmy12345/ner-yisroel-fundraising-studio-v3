import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isMutatingMethod,
  isStagingWritesOverrideEnabled,
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
