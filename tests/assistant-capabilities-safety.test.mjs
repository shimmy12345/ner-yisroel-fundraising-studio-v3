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
const fundraisingProgressSrc = await readFile(new URL("../lib/assistant/fundraising-progress.ts", import.meta.url), "utf8");

// --- No database writes anywhere in this feature's code. Ask Fundraising
// OS is read-only by requirement -- this must be true by construction,
// not just by the Staging write guard's own independent enforcement. ---

const WRITE_PATTERN = /\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\.run\(\)/i;
for (const [name, src] of [["capabilities.ts", capabilitiesSrc], ["conversation.ts", conversationSrc], ["orchestrator.ts", orchestratorSrc], ["route.ts", routeSrc], ["fundraising-progress.ts", fundraisingProgressSrc]]) {
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

const sqlStatements = [...(capabilitiesSrc.match(/`[^`]*SELECT[^`]*`/gis) ?? []), ...(fundraisingProgressSrc.match(/`[^`]*SELECT[^`]*`/gis) ?? [])];
assert.ok(sqlStatements.length >= 3, "expected to find the module's real SQL template literals");
for (const statement of sqlStatements) {
  if (/\bFROM\s+(donors|giving_activities|interactions|jl_payment_assignment_audits)\b/i.test(statement)) {
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

assert.match(capabilitiesSrc, /no\s+["']goal["']\s+or\s+target\s+concept/i, "fundraising_progress must document why no goal/percent figure is ever returned");
assert.match(orchestratorSrc, /No data could be found for this donor/);
assert.match(orchestratorSrc, /No specific donor was identified for this question/);

// --- Prompt injection: retrieved data (which can contain a donor's own
// free-text notes) is always wrapped in the same explicit delimiter/
// "data not instructions" framing already proven for Meeting Notes'
// dictated transcripts -- never concatenated into the prompt bare. ---

assert.match(orchestratorSrc, /delimited\("VERIFIED_CRM_DATA"/);
assert.match(orchestratorSrc, /delimited\("CONVERSATION_HISTORY"/);

// --- Donor profile URL security (independent code review, 2026-10-16):
// a donor profile href must always be REGENERATED server-side from a
// validated donor id, never read from client-supplied conversation
// state. conversation.ts's ordinal-reference resolution is the one place
// that handles a round-tripped, client-held donor list -- it must build
// the resolved donor's href from the just-verified `owned` row (donorHref
// of an id this statement's own owner_user_id check already confirmed),
// and must never assign the client's own `candidate.href` field to
// anything returned to the caller. ---

assert.doesNotMatch(conversationSrc, /href:\s*candidate\.href/, "conversation.ts must never reuse the client-supplied candidate.href -- it must rebuild the link from the verified donor id");
assert.match(conversationSrc, /href:\s*donorHref\(owned\.id\)/, "the resolved donor's href must be rebuilt from the ownership-verified id, using the shared canonical helper");
assert.match(conversationSrc, /import\s*\{[^}]*donorHref[^}]*\}\s*from\s*"\.\/conversation-state\.ts"/, "conversation.ts must reuse the one shared donorHref helper, never define or inline its own copy");
assert.doesNotMatch(capabilitiesSrc, /function donorHref/, "capabilities.ts must no longer define its own donorHref -- it must import the single shared one from conversation-state.ts");

// --- Monthly fundraising totals and timezone boundaries (independent
// code review, 2026-10-16): the month boundary for fundraising_progress
// must come from the fundraiser's LOCAL timezone via the shared
// localMonthBoundaries helper, never a UTC-truncated "now" -- a
// reintroduced setUTCDate(1)/setUTCHours(0 straight off `ctx.now` would
// silently misattribute transactions near local midnight to the wrong
// reporting month. ---

assert.doesNotMatch(capabilitiesSrc, /setUTCDate\(1\)/, "capabilities.ts must never truncate the fundraising-progress month boundary straight to UTC");
assert.match(capabilitiesSrc, /localMonthBoundaries\(/, "fundraising_progress must compute its month boundary via the shared, timezone-aware helper");
assert.match(capabilitiesSrc, /import\s*\{\s*localMonthBoundaries\s*\}\s*from\s*"\.\.\/workspace\/local-time\.ts"/);

// --- Final Financial Accuracy Fix for Ask Fundraising OS (independent
// code review, 2026-10-16): every fundraising_progress query must have
// an EXCLUSIVE upper bound (never a lower-bound-only query that silently
// sweeps in every later month too), must gate "new commitments"/"new
// gift rows" on created_at (immutable, set once at insert) rather than
// activity_date (a pledge's "Due Date", never updated once paid --
// lib/import/jl-refresh.ts), must reuse the exact same
// REAL_COMMITMENT_CATEGORIES set the Trip Fundraising Results Dashboard
// already uses, and must reconcile against jl_payment_assignment_audits
// through the shared, independently-tested pure summarizer rather than
// inventing its own ad hoc arithmetic inline. ---

assert.match(capabilitiesSrc, /instantEndEpoch/, "every fundraising_progress query must use an exclusive upper month boundary, not a lower bound alone");
assert.match(fundraisingProgressSrc, /created_at\s*>=\s*\?\s*AND\s*created_at\s*<\s*\?/i, "new-commitment/new-gift queries must gate on created_at with both an inclusive start and an exclusive end");
assert.doesNotMatch(capabilitiesSrc, /activity_date\s*>=/, "fundraising_progress must never filter by activity_date -- it is a pledge due date, never a receipt date (see lib/import/jl-refresh.ts)");
assert.doesNotMatch(fundraisingProgressSrc, /activity_date\s*>=/, "the exported SQL constants must never filter by activity_date -- it is a pledge due date, never a receipt date (see lib/import/jl-refresh.ts)");
assert.match(fundraisingProgressSrc, /import\s*\{\s*REAL_COMMITMENT_CATEGORIES\s*\}\s*from\s*"\.\.\/relationships\/pledge-payment-plan\.ts"/, "new commitments must reuse the Trip Dashboard's own REAL_COMMITMENT_CATEGORIES, never a separately invented category list");
assert.match(fundraisingProgressSrc, /jl_payment_assignment_audits/, "money received must reconcile against the one table that actually records a dated payment event applied to an existing pledge");
assert.match(capabilitiesSrc, /summarizeFundraisingProgress\(/, "the actual reconciliation arithmetic must live in the shared, independently unit-tested pure module, not be re-implemented inline");
assert.match(capabilitiesSrc, /limitations:/, "the capability's own return type must carry forward the disclosed limitation, never silently drop it");

assert.doesNotMatch(fundraisingProgressSrc, /from\s*["']cloudflare:workers["']/, "the reconciliation arithmetic must stay a pure function with no database/env dependency, so it is directly unit-testable");
assert.match(fundraisingProgressSrc, /auditedFingerprints\.has\(row\.sourceFingerprint\)/, "a new completed_gift row must be skipped when a payment-assignment audit already accounts for the same payment fingerprint, or its money is counted twice");

// --- Live-observed defect, fixed at the source (Staging verification,
// 2026-10-16): the model relabeled a transaction/row count as "N
// donors" when the field was ambiguously named moneyReceivedCount.
// Renamed everywhere so the field itself can never be misread, and the
// compose prompt now explicitly forbids stating a donor/household/
// people count the data never actually provided. ---

assert.doesNotMatch(fundraisingProgressSrc, /\bmoneyReceivedCount\b/, "the ambiguous field name must not reappear in the pure module");
assert.doesNotMatch(capabilitiesSrc, /\bmoneyReceivedCount\b/, "the ambiguous field name must not reappear in capabilities.ts");
assert.match(fundraisingProgressSrc, /verifiedMoneyReceivedTransactionCount/, "the field must be named unambiguously as a VERIFIED transaction count, never a donor count");
const protocolSrc = await readFile(new URL("../lib/assistant/protocol.ts", import.meta.url), "utf8");
assert.match(protocolSrc, /never state a number of donors/i, "the compose prompt must explicitly forbid inventing a donor/household count from a row/transaction count");

// --- Final Payment Accuracy and Financial Data Integrity Review
// (2026-10-16): a new giving row's CURRENT paid_cents may only be
// treated as verified money received if it has never been touched
// since the single import that created it -- otherwise a LATER, undated
// reimport against an in-period pledge could retroactively inflate a
// previously-reported month's own total on a later re-query. The old
// limitation wording ("will be reflected once that pledge is fully
// paid") was false -- this capability never retroactively attributes an
// undated payment to any month -- and must not reappear. The disclosure
// is also enforced in the deterministic response layer
// (orchestrator.ts's appendFinancialLimitations call), not solely
// through a prompt instruction. ---

assert.match(fundraisingProgressSrc, /updated_at\s*=\s*created_at/, "a new giving row must only count as verified when it has never been touched since creation");
assert.match(fundraisingProgressSrc, /VERIFIED_NEW_GIVING_ROWS_SQL/, "the verified-new-giving query must be named to make clear it is the dated, trustworthy subset, not every new row");
assert.match(fundraisingProgressSrc, /recordedCumulativePaidCents/, "the current cumulative balance must be exposed as its own, separately-labeled figure, never folded into the verified total");
assert.doesNotMatch(fundraisingProgressSrc, /will be reflected once that pledge is fully paid/i, "the limitation wording must never claim an omitted payment will eventually be reflected -- it never is, retroactively");
assert.match(orchestratorSrc, /appendFinancialLimitations\(/, "the financial disclosure must be enforced in the deterministic response layer, not left to the prompt alone");
assert.match(protocolSrc, /export function appendFinancialLimitations/, "the deterministic disclosure helper must exist and be exported for orchestrator.ts and tests to use");

console.log("assistant-capabilities-safety.test.mjs: all assertions passed");
