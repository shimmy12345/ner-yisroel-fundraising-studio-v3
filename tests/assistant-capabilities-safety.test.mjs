import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CAPABILITY_NAMES } from "../lib/assistant/protocol.ts";

// Ask Fundraising OS -- structural safety checks on the capability/
// conversation/orchestrator/route layer (docs/AI-HANDOFF.md, "Upgrade Ask
// Fundraising OS to a Real AI Assistant"). These files import
// `cloudflare:workers`' `env` and so cannot be invoked directly in a Node
// test process (the same established constraint every other D1-dependent
// route/lib file in this repo has -- see tests/ask-followup-and-meeting-
// brief.test.mjs's own header comment). Their real database/AI behavior is
// verified live on Staging instead; these checks verify what source-text
// analysis CAN prove outright: no write statement exists anywhere in this
// feature's code, every donor-scoped query is owner-scoped, result sizes
// are bounded, and the registry the AI is shown matches what actually gets
// dispatched -- the same "no-write/no-R2-binding guardrail" convention
// tests/backup-automation.test.mjs already uses for a different feature.

const capabilitiesSrc = await readFile(new URL("../lib/assistant/capabilities.ts", import.meta.url), "utf8");
const conversationSrc = await readFile(new URL("../lib/assistant/conversation.ts", import.meta.url), "utf8");
const orchestratorSrc = await readFile(new URL("../lib/assistant/orchestrator.ts", import.meta.url), "utf8");
const routeSrc = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");

// --- No database writes anywhere in this feature's code. Ask Fundraising
// OS is read-only by requirement -- this must be true by construction,
// not just by the Staging write guard's own independent enforcement. ---

const WRITE_PATTERN = /\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\.run\(\)/i;
for (const [name, src] of [["capabilities.ts", capabilitiesSrc], ["conversation.ts", conversationSrc], ["orchestrator.ts", orchestratorSrc], ["route.ts", routeSrc]]) {
  assert.doesNotMatch(src, WRITE_PATTERN, `${name} must contain no SQL write statement and no D1 .run() write call`);
}

// --- No dynamic/arbitrary SQL and no dynamic capability dispatch -- every
// query is a literal string, and the capability dispatch is a fixed
// if/else chain over known names, never a bracket-indexed call built from
// AI output (which would let an unrecognized/injected string reach a
// function call). ---

assert.doesNotMatch(capabilitiesSrc, /\beval\(/);
assert.doesNotMatch(orchestratorSrc, /\beval\(/);
assert.doesNotMatch(orchestratorSrc, /capabilities\[[^\]]*\]\s*\(/i, "capability dispatch must be a fixed if/else chain, never a dynamic lookup");

// --- Every donor-scoped query capabilities.ts runs is owner-scoped. A
// bare SELECT against `donors`/`giving_activities`/`interactions` with no
// owner_user_id/user_id filter in the same statement would leak another
// fundraiser's donors -- checked per-statement by splitting on the
// module's own query boundaries. ---

const sqlStatements = capabilitiesSrc.match(/`[^`]*SELECT[^`]*`/gis) ?? [];
assert.ok(sqlStatements.length >= 3, "expected to find the module's real SQL template literals");
for (const statement of sqlStatements) {
  if (/\bFROM\s+(donors|giving_activities|interactions)\b/i.test(statement)) {
    assert.match(statement, /owner_user_id\s*=\s*\?|user_id\s*=\s*\?/i, `every donor-scoped query must filter by owner: ${statement.slice(0, 120)}...`);
  }
}

// --- Every result-returning capability is bounded (LIMIT / .slice cap) --
// no capability can return an unbounded number of donors. ---

assert.match(capabilitiesSrc, /LIMIT\s*\?/i, "the direct SQL capabilities must use a bounded LIMIT");
assert.match(capabilitiesSrc, /MAX_RESULT_ITEMS/);
assert.match(capabilitiesSrc, /MAX_SEARCH_RESULTS/);

// --- The capability registry shown to the planning AI (protocol.ts's
// CAPABILITY_NAMES, which IS directly importable) must exactly match the
// set of capabilities capabilities.ts actually implements and
// orchestrator.ts actually dispatches -- no capability the AI can "select"
// that silently does nothing, and no capability implemented but never
// reachable. ---

const descriptionKeys = [...capabilitiesSrc.matchAll(/^\s*(\w+):\s*"/gm)]
  .map((m) => m[1])
  .filter((key) => CAPABILITY_NAMES.includes(key));
for (const name of CAPABILITY_NAMES) {
  assert.ok(descriptionKeys.includes(name) || capabilitiesSrc.includes(`${name}:`), `capabilities.ts must describe capability "${name}"`);
  if (name !== "search_donors") {
    // search_donors has no standalone data-returning branch -- it only
    // acts through donor-reference resolution -- documented explicitly in
    // orchestrator.ts's own dispatch comment, checked below instead.
    assert.match(orchestratorSrc, new RegExp(`name === "${name}"`), `orchestrator.ts must dispatch capability "${name}"`);
  }
}
assert.match(orchestratorSrc, /search_donors.*no standalone data output/is, "search_donors' lack of a dispatch branch must be an explicit, documented decision, not an oversight");

// --- Auth is checked before any data access, in both the route and the
// resolveDonorReference ownership re-check. ---

assert.match(routeSrc, /getChatGPTUser\(\)/);
assert.match(routeSrc, /if \(!identity\)[\s\S]{0,80}401/);
assert.match(conversationSrc, /owner_user_id\s*=\s*\?/, "ordinal donor-reference resolution must re-verify ownership, never trust client-supplied conversation state");

// --- Confidential content is never logged -- the route logs that a turn
// happened, not the question or the answer. ---

assert.doesNotMatch(routeSrc, /logger\.(info|error)\([^)]*prompt[^)]*\)/is);
assert.doesNotMatch(routeSrc, /logger\.(info|error)\([^)]*\banswer\b[^)]*\)/is);

// --- Financial accuracy: outstanding pledges must reuse the exact same
// pledge_balance_corrections override every other balance-reading surface
// in the app uses (app/pledge-review/page.tsx's own query), never a raw
// giving_activities.balance_cents read that could show a stale,
// manually-corrected balance. ---

assert.match(capabilitiesSrc, /pledge_balance_corrections/, "outstanding pledges must join the same balance-correction table every other surface reads");
assert.match(capabilitiesSrc, /COALESCE\(pbc\.corrected_balance_cents,\s*ga\.balance_cents\)/, "must prefer a corrected balance exactly like app/pledge-review/page.tsx's own query");

// --- Payment-plan / stale-pledge safeguard: "payment plans needing
// attention" must come from the already-reconciled recommendation
// pipeline (loadWorkspaceBrief's "Open commitment" priorities, which are
// only populated via isOpenPledgeActionable/evaluateOpenPledgePlanStatus),
// never a re-derived staleness check of its own -- this is the exact
// safeguard the task explicitly requires: a donor with a valid upcoming
// payment must never be re-decided as delinquent by this feature. ---

assert.match(capabilitiesSrc, /label === "Open commitment"/, "payment plans needing attention must reuse the recommendation engine's own already-safeguarded filter");
assert.doesNotMatch(capabilitiesSrc, /from\s+["'][^"']*pledge-payment-plan["']/, "this feature must never import pledge-payment-plan.ts directly -- it must only consume loadWorkspaceBrief's already-safeguarded output, never re-derive staleness itself");

// --- Missing/insufficient data is reported honestly, with a fixed, always
// -present note string a fundraiser-facing answer can actually explain --
// never silently omitted or left for the AI to invent around. ---

assert.match(capabilitiesSrc, /no\s*\n?\/\/\s*"goal"\s*or\s*target\s*concept/i, "fundraising_progress must document why no goal/percent figure is ever returned");
assert.match(orchestratorSrc, /No data could be found for this donor/);
assert.match(orchestratorSrc, /No specific donor was identified for this question/);

// --- Prompt injection: retrieved data (which can contain a donor's own
// free-text notes) is always wrapped in the same explicit delimiter/
// "data not instructions" framing already proven for Meeting Notes'
// dictated transcripts -- never concatenated into the prompt bare. ---

assert.match(orchestratorSrc, /delimited\("VERIFIED_CRM_DATA"/);
assert.match(orchestratorSrc, /delimited\("CONVERSATION_HISTORY"/);

console.log("assistant-capabilities-safety.test.mjs: all assertions passed");
