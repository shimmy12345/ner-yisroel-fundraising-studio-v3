// Source-level tests for the Today/homepage loader's Error 1102
// instrumentation (lib/workspace/live-data.ts). Mirrors this repo's existing
// convention for D1-coupled loader code (see tests/today.test.mjs): env.DB
// comes from `cloudflare:workers` and isn't mockable in plain Node, so these
// assert against the loader's own source text/structure rather than
// invoking it -- the same approach already used for this exact function.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
const todayPage = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const assistantPage = await readFile(new URL("../app/assistant/page.tsx", import.meta.url), "utf8");
const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");

// 1. Instrumentation event names exist.
assert.match(liveData, /"workspace_brief_phase"/, "the phase-checkpoint event name must exist");
assert.match(liveData, /"workspace_brief_render"/, "the final event name must exist");
assert.match(liveData, /phase:\s*"query_complete"/);
assert.match(liveData, /phase:\s*"scoring_start"/);

// 2. Query-complete checkpoint is emitted after the D1 fan-out (the
// Promise.all closes at `]);`, immediately followed by the query_complete
// log) and before any candidate-map construction begins.
const fanoutCloseIndex = liveData.indexOf("]);");
const queryCompleteIndex = liveData.indexOf('phase: "query_complete"');
const recentGiftMapIndex = liveData.indexOf("const recentGiftByDonor = new Map");
assert.ok(fanoutCloseIndex > -1 && queryCompleteIndex > -1 && recentGiftMapIndex > -1);
assert.ok(fanoutCloseIndex < queryCompleteIndex, "query_complete must be logged after the D1 Promise.all fan-out resolves");
assert.ok(queryCompleteIndex < recentGiftMapIndex, "query_complete must be logged before candidate-map construction begins");

// 3. Scoring-start checkpoint occurs before the donor-scoring loop, and
// after candidate-set construction (selectSuggestionDonorIds call).
const selectSuggestionCallIndex = liveData.indexOf("const suggestionDonorIds = selectSuggestionDonorIds(");
const scoringStartIndex = liveData.indexOf('phase: "scoring_start"');
const scoringLoopIndex = liveData.indexOf("for (const donorId of suggestionDonorIds)");
assert.ok(selectSuggestionCallIndex > -1 && scoringStartIndex > -1 && scoringLoopIndex > -1);
assert.ok(selectSuggestionCallIndex < scoringStartIndex, "scoring_start must be logged after suggestionDonorIds is computed");
assert.ok(scoringStartIndex < scoringLoopIndex, "scoring_start must be logged before the per-donor scoring loop begins");

// 4. Final event includes the required aggregate fields.
const finalEventStart = liveData.indexOf('logger.info("workspace_brief_render"');
assert.ok(finalEventStart > -1);
const finalEventBlock = liveData.slice(finalEventStart, liveData.indexOf("return {", finalEventStart));
for (const field of [
  "totalDurationMs", "queryFanoutDurationMs", "scoringDurationMs", "assemblyDurationMs",
  "totalLiveDonors", "recentGiftDonorCount", "openPledgeDonorCount", "openAskDonorCount",
  "yahrtzeitDonorCount", "importantDateDonorCount", "contactGapCandidateCount",
  "finalSuggestionDonorCount", "donorsScoredCount", "recommendationCount", "context",
]) {
  assert.match(finalEventBlock, new RegExp(field), `final workspace_brief_render event must include ${field}`);
}

// 5. No per-donor logging exists inside the scoring loop.
const loopBodyEnd = liveData.indexOf("const scoringDurationMs =");
const loopBody = liveData.slice(scoringLoopIndex, loopBodyEnd);
assert.doesNotMatch(loopBody, /logger\.(info|error)\(/, "no logger call may exist inside the per-donor scoring loop");
assert.doesNotMatch(loopBody, /console\.(log|info|warn|error)\(/, "no console call may exist inside the per-donor scoring loop");

// 6. No donor names/emails/notes are logged by the new instrumentation
// calls (the four logger.info("workspace_brief_*", ...) call sites only:
// query_complete, scoring_start, cache_hit, workspace_brief_render -- only
// three of which fire on any single loader execution, since cache_hit is
// mutually exclusive with the other three (see the request-scoped-dedup
// tests below).
const phaseCallStarts = [...liveData.matchAll(/logger\.info\("workspace_brief_(phase|render)",\s*\{/g)].map((m) => m.index);
assert.equal(phaseCallStarts.length, 4, "expected exactly 4 workspace_brief_* logger.info call sites (query_complete, scoring_start, cache_hit, workspace_brief_render)");
for (const start of phaseCallStarts) {
  const end = liveData.indexOf("});", start);
  const block = liveData.slice(start, end);
  for (const bannedField of ["name:", "donorName", "email", "note:", "summary:", "reason:", "why:", "relationshipSummary", "institutionalMemory", "purpose:"]) {
    assert.doesNotMatch(block, new RegExp(bannedField), `workspace_brief_* log call must not include ${bannedField}`);
  }
}

// 7. Instrumentation does not add D1 queries -- exact call-site count
// pinned, mirroring donor_page_render's own "21 before and after" comment.
const d1CallSites = (liveData.match(/env\.DB\.prepare\(/g) ?? []).length;
assert.equal(d1CallSites, 16, "loadWorkspaceBrief must still issue exactly 16 D1 query call sites -- instrumentation must never add a query");

// 8. Candidate-set sizes are derived from existing in-memory results, not
// freshly computed/queried: the logged fields must reference the same Map
// objects already built earlier in the function (.size on the exact same
// identifiers used to build selectSuggestionDonorIds's input).
for (const expr of [
  "recentGiftByDonor.size", "openPledgeByDonor.size", "openAskByDonor.size",
  "yahrtzeitsByDonor.size", "importantDatesByDonor.size", "suggestionDonorIds.size",
]) {
  assert.match(liveData, new RegExp(expr.replace(".", "\\.")), `expected ${expr} to be logged directly from the existing in-memory Map/Set`);
}
assert.match(liveData, /Math\.min\(contacts\.length,\s*CONTACT_GAP_POOL_SIZE\)/, "contactGapCandidateCount must be derived from the existing contacts array and the unchanged CONTACT_GAP_POOL_SIZE constant");

// 9. Successful loader result shape is unchanged (WorkspaceBrief return
// still has exactly the same fields as before this change).
assert.match(liveData, /return \{ overview, recommendation, priorities: deduped, priorityCount: allPriorities\.length, relationshipQueue, morningBrief, recentlyViewed, recentlyUpdated, todaySchedule, upcomingActivities, meetings, gifts, upcomingRelationshipDates, generatedAt: now \};/, "loadWorkspaceBrief's return shape must be byte-for-byte unchanged");

// 8b (from the "candidate-selection rules" guardrail). selectSuggestionDonorIds
// itself, and the pure suggestion-candidates.ts module, are untouched by this
// instrumentation task -- only imported from (an additional named import of
// the already-exported CONTACT_GAP_POOL_SIZE constant).
assert.match(liveData, /import \{ selectSuggestionDonorIds, HOMEPAGE_MAX_RESULTS, CONTACT_GAP_POOL_SIZE \} from "\.\/suggestion-candidates\.ts";/);

// context param: trivial, backward-compatible optional 6th positional arg.
assert.match(liveData, /context = "unknown"\)/, "context must be an optional parameter with a default so existing callers remain valid");
assert.match(todayPage, /loadWorkspaceBrief\(profile\.id, profile\.timezone, mode, now, showAll \? 50 : 10, "today"\)/);
assert.match(assistantPage, /loadWorkspaceBrief\(profile\.id, profile\.timezone, await getDataMode\(profile\.id\), undefined, undefined, "assistant_page"\)/);
assert.match(assistantRoute, /loadWorkspaceBrief\(profile\.id, profile\.timezone, mode, now, undefined, "assistant_api"\)/);

// performance.now(), not Date.now(), for the new phase timers specifically
// (per explicit instruction) -- donor_page_render's own separate Date.now()
// convention on the donor-page route is untouched by this task.
assert.match(liveData, /const __loaderStart = performance\.now\(\);/);
assert.match(liveData, /const __scoringLoopStart = performance\.now\(\);/);
assert.match(liveData, /const __assemblyStart = performance\.now\(\);/);

// --- Request-scoped deduplication (fix for vinext's double loader
// execution per Today/Assistant navigation -- see docs/AI-HANDOFF.md) ---

// 1 (call sites). Every current call site of loadWorkspaceBrief() is
// exactly the three already asserted above (today/assistant_page/
// assistant_api) plus its own definition -- confirmed by an exact count
// of the exported symbol's usages across the loader and its three callers.
{
  const occurrencesIn = (text) => (text.match(/loadWorkspaceBrief\(/g) ?? []).length;
  assert.equal(occurrencesIn(todayPage), 1, "app/page.tsx must call loadWorkspaceBrief exactly once in source");
  assert.equal(occurrencesIn(assistantPage), 1, "app/assistant/page.tsx must call loadWorkspaceBrief exactly once in source");
  assert.equal(occurrencesIn(assistantRoute), 1, "app/api/assistant/route.ts must call loadWorkspaceBrief exactly once in source");
}

// 2/5 (single expensive execution per logical request; result/candidate
// counts unchanged). The exported loadWorkspaceBrief must consult the
// request-scoped cache and return early on a hit, before ever reaching
// the expensive uncached implementation -- this is what collapses
// vinext's two per-navigation invocations (see the root-cause comment in
// live-data.ts) into one real D1 fan-out/scoring/assembly execution,
// without touching selectSuggestionDonorIds, buildRecommendationEvidence,
// buildDonorRecommendation, or any candidate-inclusion rule -- none of
// which this diff touches at all (loadWorkspaceBriefUncached's body,
// including its return statement asserted unchanged above, is untouched
// text).
{
  const exportedFnStart = liveData.indexOf("export async function loadWorkspaceBrief(");
  const uncachedFnStart = liveData.indexOf("async function loadWorkspaceBriefUncached(");
  assert.ok(exportedFnStart > -1 && uncachedFnStart > -1 && exportedFnStart < uncachedFnStart, "the exported wrapper must be defined before the private uncached implementation");
  const wrapperBody = liveData.slice(exportedFnStart, uncachedFnStart);
  assert.match(wrapperBody, /const cached = cache\.get\(cacheKey\);/, "the wrapper must look up a cached entry");
  assert.match(wrapperBody, /if \(cached\) \{[\s\S]*?return cached;\s*\}/, "a cache hit must return early, before loadWorkspaceBriefUncached is ever called");
  assert.match(wrapperBody, /loadWorkspaceBriefUncached\(userId, timezone, mode, now, priorityLimit, context\)/, "a cache miss must delegate to the untouched uncached implementation with the same arguments");
  assert.doesNotMatch(wrapperBody, /env\.DB\.prepare/, "the wrapper itself must never touch D1 directly -- all queries stay inside the untouched uncached implementation");
}

// 3 (dedup does not persist across separate requests) and 8 (no global
// cache introduced). The cache lives behind AsyncLocalStorage, entered
// fresh per store, not a bare module-level Map -- see the behavioral
// test below for the actual persistence/isolation semantics this relies
// on. Source-level: confirm the singleton is registered on `globalThis`
// via `Symbol.for(...)` (matching vinext's own als-registry.js pattern,
// required because Vite's RSC/SSR/client module environments can load
// this file as more than one module instance) rather than a naive
// module-local `new AsyncLocalStorage()` that could silently fork.
assert.match(liveData, /import \{ AsyncLocalStorage \} from "node:async_hooks";/);
assert.match(liveData, /Symbol\.for\("fundraising-os\.workspace-brief-request-cache\.als"\)/, "the ALS singleton must be registered under a Symbol.for(...) globalThis key, not a bare module-level instance");
assert.doesNotMatch(liveData, /^const \w+ = new AsyncLocalStorage\(\);/m, "must not declare a bare module-level AsyncLocalStorage instance (would fork across Vite's multiple module environments)");

// 9 (no new D1 queries) is already covered by check 7 above (still
// exactly 16 D1 call sites) -- the wrapper adds zero.

// 10 (instrumentation still emits expected phases). The cache-hit path
// logs its own single, compact, PII-free phase event (covered by the
// banned-field loop above); the cache-miss path is untouched and still
// emits query_complete/scoring_start/workspace_brief_render exactly as
// before.
assert.match(liveData, /phase: "cache_hit"/);

// Behavioral test: verifies the actual JS semantics the fix depends on
// using node:async_hooks directly (available in plain Node, same API
// nodejs_compat exposes in the real Workers runtime) -- NOT by invoking
// loadWorkspaceBrief itself, since it calls env.DB from cloudflare:workers,
// which has no meaningful mock outside a real Workers/Miniflare runtime
// (matching this repo's established limitation for every D1-coupled
// loader/route, per the file-level comment at the top of this file and
// tests/today.test.mjs).
//
// This proves the WITHIN-one-request half of the mechanism: a store
// entered via enterWith() during an earlier awaited call is still the
// same store on a later awaited call in the same unbroken async chain
// (mirroring vinext's probe-then-render sequence, both awaited in turn
// from renderAppPageLifecycle). It also proves getStore() is undefined
// before anything has entered a store, so a fresh chain that never
// touches this ALS starts clean.
//
// LIMITATION, stated plainly: it does NOT and cannot prove Cloudflare
// Workers' cross-request isolation guarantee (that a second, wholly
// separate incoming fetch() in the same warm isolate does not see a
// store entered during a prior request) -- Node has no equivalent to
// Workers' per-request IoContext boundary, so a Node-only test of that
// claim would test Node's semantics, not the Workers runtime's. That
// guarantee rests on Cloudflare's documented request-isolation model and
// on vinext's own request-context shim (dist/shims/request-context.js)
// depending on the identical assumption for its own, load-bearing
// per-request ExecutionContext plumbing -- and is verified empirically
// against the real deployment in this task's live-verification step
// (5 ordinary Today loads showing unchanged, non-stale candidate counts).
{
  const { test } = await import("node:test");
  const { AsyncLocalStorage } = await import("node:async_hooks");

  await test("AsyncLocalStorage enterWith() persists a store across sequential awaited calls in one continuation (the mechanism loadWorkspaceBrief's dedup relies on)", async () => {
    const als = new AsyncLocalStorage();
    function getOrCreateStore() {
      let store = als.getStore();
      if (!store) {
        store = new Map();
        als.enterWith(store);
      }
      return store;
    }
    assert.equal(als.getStore(), undefined, "no store should exist before anything has entered one");
    const first = getOrCreateStore();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve().then(() => {});
    const second = getOrCreateStore();
    assert.strictEqual(first, second, "the same store instance must be returned on a later awaited call in the same continuation -- this is what makes the second (probe or render) loadWorkspaceBrief call see the first call's cached promise");
    first.set("k", "v");
    assert.equal(second.get("k"), "v", "writes made during the first call must be visible to the second call");
  });
}
