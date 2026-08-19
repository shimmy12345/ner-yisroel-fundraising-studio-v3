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
// calls (the three logger.info("workspace_brief_*", ...) blocks only).
const phaseCallStarts = [...liveData.matchAll(/logger\.info\("workspace_brief_(phase|render)",\s*\{/g)].map((m) => m.index);
assert.equal(phaseCallStarts.length, 3, "expected exactly 3 workspace_brief_* logger.info calls (query_complete, scoring_start, workspace_brief_render)");
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
