# AI Project Handoff

This file is an index/summary for another AI session (Claude or ChatGPT)
picking up this project. Git history, source code, tests, migrations, and
the actual deployed/D1 state remain the source of truth — this file only
tells you where to look and what has and hasn't happened. If this file and
the repository/infrastructure disagree, trust the repository/infrastructure.

## Current Git State

**Per this file's own preamble, git/deployed state is always the
authoritative source if this section ever drifts again; do not trust a
commit SHA here over a fresh `git fetch`.**

Branch:
feature/independent-cloudflare-sandbox

Current HEAD (this commit):
`a30316f` -- "Add Option A: explicit review/accept flow for outcome-note
Relationship Snapshots" (see "Outcome-Note Relationship Snapshot
Review/Accept Flow -- Option A" below for full detail). On top of
`b72895d`/`4ad8f3f` (docs-only cleanup), `befa0fb` (the people-extraction
false-positive fix), `3f1cd3e`/`e20e10d` (outcome-route Option B fix +
docs), `c29590a`/`faea921` (Zman/Yahrtzeit extraction implementation +
investigation docs), `b687511`/`4126663` (Zman/Yahrtzeit historical
repair + comprehensive audit tooling), `d48e1f2`/`d6e43ee`/`a59c8d5`
(grandchild-gap fix, deployment, and donor 987 historical repair), and
the branch-documentation-authority fix (`dc245fc`) before that.
**Deployed to Independent Staging (Worker version
`0673c91a-de71-4f29-950b-34f71fc3fbec`, still the current live version)
and live-verified**: accepted/rejected/no-extraction/reopen/shared-
activity scenarios all confirmed correct directly in D1, all test data
cleaned up and reverted to baseline. No D1 schema change, no production
access. `origin/main` untouched throughout every one of the above tasks.

origin/feature/independent-cloudflare-sandbox:
`a30316f` (pushed; matches local HEAD exactly, no divergence).

origin/main:
`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58` (untouched across every task
recorded in this file since it was first confirmed at this SHA).

Working tree:
clean (after this docs update is committed).

## Independent Staging Incident -- Error 1102 (2026-08-19 16:59:03 UTC / 12:59:03 EDT) -- INVESTIGATION ONLY, NO FIX APPLIED

Ray ID `a2dab4de9e40be78`. Investigated per explicit instruction to look only,
not fix/deploy/migrate/write D1. Findings below are from Cloudflare
Observability (the actual event record for this Ray ID), `wrangler
deployments list`/`versions view` (real deployment history), read-only D1
`SELECT`/`COUNT` queries (no writes), and the repo's own git history --
not carried over from the prior 1102 incidents.

**1-3. Request.** `GET https://fundraising-os-staging.sgoldstein.workers.dev/`
(root -- the Today/homepage route). A real browser navigation (`sec-fetch-
mode: navigate`, `sec-fetch-dest: document`, referer same-origin `/`), not a
`.rsc` prefetch payload fetch. Cloudflare's own event record: `"outcome":
"exceededCpu"`, plus a separate runtime-generated log line whose message is
verbatim `"Worker exceeded CPU time limit."` -- independently re-verified for
this specific Ray ID, not assumed from prior incidents.

**4-7. Metrics.** `cpuTimeMs: 163`, `wallTimeMs: 517`, `response.status: 503`.
`scriptVersion.id: f5c3430d-1b04-4dd8-9f72-8a0fcd835e6a` -- this is the exact
version that served the failing request, read directly off the event record.

**Deployed version/commit (proven + one inferred link).** PROVEN via
`wrangler deployments list --config wrangler.staging.jsonc`: version
`f5c3430d` was deployed 2026-08-19T04:23:33Z and remained live until version
`e2fb2e0c` superseded it at 2026-08-19T17:04:39Z -- i.e. `f5c3430d` was the
only version live at 16:59:03Z. Cloudflare deploys carry no git-SHA metadata
(Source/Tag/Message are all `-`), so the exact commit is INFERRED from
timestamp adjacency, not proven by embedded metadata: the deploy timestamp
(00:23:33 EDT) falls between commit `1487a8b` ("Stop surfacing weak
machine-generated relationship intelligence", 00:15:47 EDT) and the next
commit `37dcdd4` (00:49:35 EDT), matching this repo's own commit-then-
handoff-commit pattern. Checked `1487a8b`'s diff directly: it only touches
`lib/capture/interaction.ts`'s `mentionedPeople`/`mentionedOrganizations`/
`inferSubject`, called only from that same file (capture/write-time path) --
grepped the whole repo at that commit and confirmed zero call sites in the
Today-page read path. **This commit is not implicated as the CPU driver.**

**Burst correlation (16:58:58-16:59:08 UTC window, same Worker).** Pulled
every event for `fundraising-os-staging` in this window directly from
Observability:
| Timestamp (EDT) | Route | Outcome |
|---|---|---|
| 12:58:56.729 | GET `/.rsc?_rsc=...` (prefetch payload of `/`) | success |
| 12:59:02.401 | POST `/api/giving/acknowledge` | success (`gift_acknowledgment_recorded`) |
| 12:59:03.090 | GET `/` | **error -- exceededCpu, 503** |

No `.rsc`/dynamic-route burst, no `/assistant`, `/settings`,
`/onboarding/import`, donor-page, Meeting Brief, or Ask-route requests
anywhere in this window. Only one failure. This rules out mechanisms (A) the
vinext prefetch-storm mechanism returning and (D) several independent
concurrent CPU failures -- there was exactly one failing request, and it was
a real navigation, not a prefetch fetch. Confirmed in source at the live
commit (`1487a8b`): `app/components/AppShell.tsx`'s persistent nav links
(Today/Import/Assistant/Settings/brand logo) all still carry `prefetch=
{false}`, exactly as commit `f639810` (2026-08-17, the original prefetch-
burst fix) left them -- the fix is intact and not what failed here.
**Conclusion: (C) one genuinely expensive user-request route** -- a single,
real Today-page load exceeded CPU on its own, on the same
`loadWorkspaceBrief()` path implicated (but never fully proven) in both
prior incidents.

**Route source trace.** `app/page.tsx` (`TodayPage`, `export const dynamic =
"force-dynamic"`) calls `loadWorkspaceBrief()` in
`lib/workspace/live-data.ts`: a 15-query `Promise.all` D1 fan-out, then a
per-donor loop over `selectSuggestionDonorIds()` that calls the same shared
`buildRecommendationEvidence()`/`buildDonorRecommendation()` engine
Meeting Brief/Assistant/donor pages use. Per the code's own comment (added
after the original Today-scoring incident that isn't otherwise documented in
this file's current text): only the `reconnect_contact_gap` category is
bounded; donors with a qualifying recent gift, open pledge, yahrtzeit, or
birthday/anniversary are **"kept in full, unbounded."** Read-only D1 counts
just now (not at incident time, so approximate): 248 total live donors
(matches the "247 of 248" figure in that code comment -- same roster), 32
donors with a qualifying recent gift, 58 with an open pledge. A JL donation
import completed at **12:52:54 EDT, six minutes before the incident**
(`jl_donation_import_completed` in the event log) -- plausible contributing
factor (a fresh bulk import can transiently inflate the unbounded
recent-gift/open-pledge pools right before a Today-page load), but NOT
proven at the precise incident-time row counts, since these counts were
taken after the fact. This route has **no phase instrumentation** at all
(unlike donor pages' `donor_page_render`): searched Observability for every
log line sharing this request's traceId (`22de44c9b28fe2b9aa8a56b3322f8063`)
and found exactly two -- the terminal fetch-error record and the runtime's
own CPU-limit message. Zero application log lines. The route reached no
instrumentation checkpoint because none exists to reach.

**Ask feature causality -- ruled out, not assumed.** (a) Deployed before
16:59:03 UTC? **No** -- the live version (`f5c3430d`) predates both Ask
commits (`a04b4bd`/`86584e9`, 15:20-15:24 UTC) by ~11 hours; the version
containing Ask code (`e2fb2e0c`) wasn't deployed until 17:04:39 UTC, ~5.5
minutes *after* the incident. (b) Migration 0032 applied at incident time?
**No** -- `asks`/`ask_changes` tables exist in D1 now, but wrangler's local
command logs show zero D1 activity anywhere between 13:39 UTC and 17:00:03
UTC that day; the only D1 execute activity near the incident starts at
17:00:03 UTC (after it), clustered around the 17:04:31 UTC deploy -- i.e.
the migration was applied afterward, not before. (c) Did the failing
request execute Ask-related code? **No** -- the deployed script version
literally didn't contain it. (d) Ask-related query count added: **zero**.

**Comparison with prior 1102s.**
- **Aug 17 donor-page incident** (`f446e74`, 2026-08-17T18:56:41Z): root
  cause was never proven either; only diagnostic instrumentation
  (`donor_page_render`) plus one proven Important-Dates sort fix were
  shipped. This incident's route (`/`) has no equivalent instrumentation --
  same gap, different route.
- **Five-route prefetch burst** (`f639810`, 2026-08-17): proven mechanism --
  vinext's always-visible sidebar auto-prefetching `/`, `/assistant`,
  `/onboarding/import`, `/settings` simultaneously, each independently
  running `loadWorkspaceBrief()`'s full fan-out. Fixed with `prefetch=
  {false}`, confirmed still intact and not the cause here (see above).
- **Earlier Today/homepage scoring incident**: produced the "247 of 248"
  bound on `reconnect_contact_gap` in `live-data.ts`. This incident's route
  and underlying call path are identical; the categories that bound left
  unbounded (gift/pledge/yahrtzeit/important-date) are the prime suspects
  here, unconfirmed at exact incident-time volumes.

**Proven vs. inference, explicitly.** PROVEN: failing route, method, CPU
outcome, cpu/wall metrics, exact scriptVersion live at incident time, deploy
timeline (Ask code deployed after, not before), migration timing (D1
activity only starts after the incident), no burst, prefetch fix intact, zero
app-level logs for this request, route's unbounded-candidate-pool design.
INFERRED (not proven): that `f5c3430d` corresponds specifically to commit
`1487a8b` (timestamp adjacency, not embedded metadata -- though `1487a8b`
is independently cleared as the CPU driver regardless of exact match); that
the JL import six minutes prior is what inflated the unbounded pools enough
to tip this specific request over the limit (plausible, not measured at the
time).

**Next instrumentation needed (root cause still not fully proven) -- DONE, see
below.** The phase-timing instrumentation this paragraph originally called
for has since been implemented, deployed, and live-verified -- see
"Independent Staging Instrumentation -- Today/Assistant Loader Phase
Timing" immediately below for what was added and what the first live
telemetry shows.

## Independent Staging Instrumentation -- Today/Assistant Loader Phase Timing (2026-08-19)

Instrumentation-only follow-up to the Error 1102 investigation above, per
explicit instruction: no recommendation-behavior change, no
candidate-selection-rule change, no D1 writes/migrations, no optimization.
Branch `feature/independent-cloudflare-sandbox` only; `origin/main`
untouched (still `4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`).

**Commit:** `83bfa75` ("Add phase-timing instrumentation to
loadWorkspaceBrief (Today/Assistant loader)"), pushed directly to
`origin/feature/independent-cloudflare-sandbox` (on top of `0387d4b`, the
concurrent Ask-rollout session's handoff commit -- rebased cleanly, no
file overlap). **Deployed Worker version:**
`f29c075f-b1e3-496d-bc10-cc52ecf05554` (`wrangler deploy --config
wrangler.staging.jsonc`, confirmed via the deploy's own printed Version
ID). `pnpm test` (88 files including the new
`tests/workspace-brief-instrumentation.test.mjs`), `pnpm exec tsc
--noEmit`, and `pnpm run build:staging-independent` all passed (exit 0)
before commit/push/deploy.

**What was added, exactly.** Three fields' worth of source-verified phase
boundaries in `lib/workspace/live-data.ts`'s `loadWorkspaceBrief()`
(current implementation traced fresh, not assumed from the prior report --
it now also threads Ask Phase 1's `askDonorIds`/`openAskByDonor` through
the same 16-query fan-out and candidate-selection call, one more query
than this file described before Ask shipped):
1. `workspace_brief_phase` / `phase: "query_complete"` -- logged the
   instant the 16-query `Promise.all` D1 fan-out resolves. Fields:
   `context`, `elapsedMs`, `totalLiveDonors`, `givingRows`,
   `remindersRows`.
2. `workspace_brief_phase` / `phase: "scoring_start"` -- logged after
   candidate-pool construction, immediately before the per-donor scoring
   loop starts. Fields: `context`, `elapsedMs`, `recentGiftDonorCount`,
   `openPledgeDonorCount`, `openAskDonorCount`, `yahrtzeitDonorCount`,
   `importantDateDonorCount`, `contactGapCandidateCount`,
   `finalSuggestionDonorCount`.
3. `workspace_brief_render` -- final event, logged right before `return`.
   Fields: everything above plus `totalDurationMs`,
   `queryFanoutDurationMs`, `scoringDurationMs`, `assemblyDurationMs`,
   `donorsScoredCount`, `recommendationCount`, `resultPriorityCount`.

All three use the existing `logger.info()` convention (same sanitization
as `donor_page_render`) and `performance.now()` (monotonic), not
`Date.now()`, per explicit instruction -- donor_page_render's own separate
`Date.now()` convention on the donor-page route was left untouched (out of
scope). **No PII, no donor names/emails/notes/summaries, no full
recommendation payloads** -- verified both by manual review and by the new
test's regex checks against the banned-field list. **No new D1 queries** --
`env.DB.prepare(` call-site count is unchanged at 16, pinned by the new
test. **No per-donor log lines** -- the scoring loop body is asserted
log-call-free. All candidate counts are read from Maps/Sets already built
earlier in the function (`recentGiftByDonor.size` etc.) -- nothing
recomputed or newly queried. A trivial, backward-compatible optional 6th
positional `context` parameter (default `"unknown"`) was added and threaded
through all three call sites: Today (`"today"`), the Assistant page
(`"assistant_page"`), and the Assistant API route (`"assistant_api"`) --
`cf-ray` was deliberately *not* added to keep this change minimal (it would
have required introducing `next/headers` into a `lib/` module, a pattern
not currently used outside `app/`); correlation to a Cloudflare Ray ID
still works via timestamp + the existing per-request `traceId` Cloudflare
itself already exposes across every log line for that request.

**Live verification -- 3 ordinary Today-page loads, Independent Staging,
2026-08-19 ~13:42-13:43 EDT.** Authenticated browser navigations to `/`,
no stress testing, no intentional 1102. All three succeeded
(`"outcome":"ok"`, HTTP 200); **no 1102 was encountered, accidental or
otherwise.**

| Ray ID | cpuTimeMs | wallTimeMs | queryFanoutDurationMs (per call) | scoringDurationMs | assemblyDurationMs | finalSuggestionDonorCount | donorsScoredCount |
|---|---|---|---|---|---|---|---|
| `a2daf4f58fd82f06` (1st load, cold start) | **242** | 828 | 65 | 0 | 0 | 139 | 139 |
| `a2daf527db1f2f06` (2nd load) | **152** | 489 | 53 | 0 | 0 | 139 | 139 |
| `a2daf5995d132f06` (3rd load) | **141** | 480 | 67 / 65 | 0 | 0 | 139 | 139 |

All other candidate counts were byte-identical across all three loads and
both internal calls within each (data didn't change between reloads):
`totalLiveDonors: 248`, `recentGiftDonorCount: 7`, `openPledgeDonorCount:
44`, `openAskDonorCount: 0`, `yahrtzeitDonorCount: 24`,
`importantDateDonorCount: 172`, `contactGapCandidateCount: 100`,
`recommendationCount: 129`, `resultPriorityCount: 10`. **Candidate counts
are stable, not varying materially** across ordinary reloads.

**Two findings, both unplanned, both load-bearing:**

1. **`loadWorkspaceBrief()` runs TWICE per single Today-page navigation --
   inside the same request (same `cf-ray`/`traceId`), not two separate
   requests.** Every one of the 3 loads produced two complete
   `workspace_brief_phase`/`workspace_brief_render` triplets under one
   `rayId`. This is not new behavior from this change -- the same
   double-invocation pattern is independently visible in the pre-existing
   `donor_page_render` log (two `donor_page_render` lines per donor-page
   visit, same rayId), so it's a systemic characteristic of this app's
   RSC/SSR rendering pipeline (vinext), not something this instrumentation
   introduced or something specific to the Today route. Net effect: every
   real Today-page load already runs the 16-query D1 fan-out **32 times**,
   not 16. Not investigated further here (out of scope -- instrumentation
   only) but this is the single most concrete, actionable lead this
   telemetry produced.
2. **Scoring and assembly are consistently ~0ms; D1 fan-out is
   essentially 100% of `loadWorkspaceBrief()`'s own measured internal
   cost.** Across all 6 internal calls sampled, `scoringDurationMs` and
   `assemblyDurationMs` were both `0` even at `donorsScoredCount: 139`
   (out of 248 total donors) -- **this weighs against the "unbounded
   per-donor scoring loop" hypothesis** carried over from the original
   incident report as the likely CPU driver, at today's actual data
   volumes. D1 fan-out (`queryFanoutDurationMs`, 53-67ms per call) is
   where essentially all of the function's own time goes.
3. **Caveat, stated plainly: `loadWorkspaceBrief()`'s own instrumented
   phases (~2x 53-67ms = roughly 110-134ms per request) account for only
   a fraction of each request's total `wallTimeMs` (480-828ms) and
   `cpuTimeMs` (141-242ms).** A substantial share of both wall time and
   CPU time is currently happening *outside* this function entirely --
   auth/session/Cloudflare Access JWT verification, the outer RSC
   page-tree render/serialization, or the second loader invocation's own
   overhead beyond the D1 re-fetch. This instrumentation does not yet
   have visibility into that portion, and it should not be assumed
   negligible.
4. **A successful, ordinary request (`a2daf4f58fd82f06`, cold start) used
   242ms of CPU time -- more than the original incident's 163ms -- and
   still succeeded.** This weakens any assumption that Error 1102 on this
   route is simply "any request whose `cpuTimeMs` crosses a fixed
   threshold around 150-165ms fails." Whatever separates a successful
   140-240ms request from the incident's killed 163ms request is not yet
   understood from this data alone.

**Whether a hotspot is now proven: no, not fully -- but the working
hypothesis has shifted with real evidence.** Before this task, the
leading (code-comment-based) hypothesis was the unbounded
gift/pledge/yahrtzeit/important-date candidate pool driving an expensive
per-donor scoring loop. That is now directly *disproven as the dominant
cost* at current data volumes (proven: scoring is ~0ms). The evidence
now points at (a) the double-invocation of the entire loader per request,
and (b) D1 fan-out cost (query volume/row-count-driven, likely
deserialization CPU rather than network wait, since Workers' `cpuTimeMs`
excludes I/O wait) as the two real, evidence-backed levers -- with a
meaningful uninstrumented remainder (caveat 3 above) still unaccounted
for. No optimization has been implemented; per explicit instruction, this
task stops at reporting the evidence.

**Smallest evidence-supported next step (not implemented, per explicit
instruction to stop and report):**
1. Determine why `loadWorkspaceBrief()` (and, by the same pre-existing
   pattern, the donor-page loader) runs twice per single navigation, and
   whether that's a fixable rendering artifact -- eliminating it would
   plausibly roughly halve this route's D1 query volume and a
   correspondingly large share of its fan-out cost.
2. Extend the same lightweight phase-boundary pattern to the currently
   uninstrumented remainder of the request (auth/session resolution, the
   outer page render/serialization step) so the ~350-700ms of wall time
   (and unknown CPU time) outside `loadWorkspaceBrief()` becomes
   attributable instead of a blind spot.

**Next approval required:** none for further investigation/instrumentation
of the same kind. Any change to fix (1) or (2) above -- or any other
optimization -- needs its own explicit approval before implementation, per
this task's instruction not to optimize yet.

## Independent Staging Duplicate-Loader Fix -- CURRENT STATUS: LIVE AND VERIFIED (mostly), 2026-08-19

**Read this section first if you're picking up the 1102 investigation. It
supersedes the "next step" note directly above -- that next step is now
done.** Deployed Worker version is `db4dcc3e-1629-4457-81e6-ae53ffeb5894`,
NOT the earlier instrumentation-only `f29c075f` or the broken
`70f3c2c6` -- see "Deployment State" below for the single source of
truth on what's actually live.

**Proven duplicate-execution cause** (source-verified against vinext
0.0.50, not assumed): vinext's app-router runtime runs a pre-render
"probe" pass for any route without a `loading.tsx` boundary
(`node_modules/vinext/dist/server/app-page-probe.js`'s
`probeAppPageBeforeRender` -> `probeAppPageComponent`), which calls the
page's default export directly as a plain function
(`dist/entries/app-rsc-entry.js`'s `probePage()`) and fully awaits it --
purely to catch a thrown `redirect()`/`notFound()`/`forbidden()`/
`unauthorized()` before committing to a streamed response. That full
execution (including `loadWorkspaceBrief()`) is separate from, and
precedes, the real render, which invokes the same page component a
second time via React's actual `renderToReadableStream`. Both happen
inside the SAME Cloudflare request (same rayId/traceId) -- confirmed
directly, not inferred, in the original instrumentation telemetry.

**Fix attempt 1 -- FAILED, broke staging (preserved as incident history,
not hidden).** Commit `76c3694` wrapped `loadWorkspaceBrief()` in
request-scoped memoization using `AsyncLocalStorage`, calling
`als.enterWith(store)` the first time it ran in a request so the second
call would see the same store. Deployed as Worker version `70f3c2c6`.
**This broke the Today page live on Independent Staging within
minutes.** Symptom: the browser showed "Something interrupted the
workspace." Telemetry showed exactly why: `cpuTimeMs` collapsed to ~18ms
(a fast crash, not a real computation) and **zero**
`workspace_brief_phase`/`workspace_brief_render` events appeared across
all 5 verification navigations -- the loader was throwing before it
could log anything. Root cause, confirmed against Cloudflare's own docs
(developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/):
**Cloudflare Workers' `AsyncLocalStorage` intentionally does not
implement `enterWith()`/`disable()`** -- only `run()`/`getStore()` are
supported. Calling `enterWith()` threw immediately. **Rolled back to
`f29c075f`** (`wrangler rollback f29c075f-...`) as soon as this was
observed; staging was back to a known-good state within the same
session, before any further investigation.

**Fix attempt 2 -- corrected, this is what's live now.** Since `run()`
requires a callback spanning the whole scope the store must be visible
in, and `loadWorkspaceBrief()` doesn't own that scope (vinext's probe
call and its real render call are two separate, non-nested invocations,
both internal to vinext's own dispatch), the `run()` call was moved to
`worker/index.ts` instead -- the one file in this repo that already
wraps vinext's entire per-request `handler.fetch(...)` call, and so is
the only place that correctly spans both of vinext's per-request
invocations. This exactly mirrors vinext's own documented pattern for
its own request-context shim (`dist/shims/request-context.js`'s
`runWithExecutionContext`, which wraps that same `handler.fetch()` call
in one `AsyncLocalStorage.run()` of its own). `lib/workspace/live-data.ts`
now exports `runWithWorkspaceBriefRequestScope()` (a thin `run()`
wrapper) for `worker/index.ts` to call; its own
`getRequestScopedBriefCache()` only ever calls `getStore()`, falling back
to a fresh, unshared `Map` (never throwing) if no store is active, so any
path that somehow bypasses the wrapper only forgoes the dedup
optimization, never breaks correctness.

**Empirical verification before redeploying (not just Node.js
semantics):** a minimal standalone Worker was run via `wrangler dev`
(real `workerd`, the actual Workers runtime, not a Node.js simulation),
exercising `AsyncLocalStorage.run()` with two sequential `await`ed calls
separated by a real task boundary (`setTimeout`), mirroring vinext's
probe -> render gap. Result: `{"ok":true,"sameInstance":true,"entries":
[["a","first"],["b","second"]]}` -- the same store instance was visible
to both calls, proving the mechanism works in this exact runtime before
it was trusted with the real deployment.

**Corrected commit:** `eec5266` ("Fix request-scoped dedup: use
AsyncLocalStorage.run()/getStore(), not enterWith()"), pushed to
`origin/feature/independent-cloudflare-sandbox` (fast-forward, no
conflicts). `pnpm test` / `tsc --noEmit` / `build:staging-independent`
all passed before commit and again after rebasing onto a concurrent
session's Ask-backfill push. **Deployed Worker version:**
`db4dcc3e-1629-4457-81e6-ae53ffeb5894`, deployed 2026-08-19T21:58:13Z
(approximate, `wrangler deploy` timestamp).

**Live verification -- 5 ordinary Today-page navigations, Independent
Staging, 2026-08-19 ~21:58-21:59 EDT.** Real browser navigations to `/`,
no stress testing. Each navigation's Ray ID was correlated directly
against its `workspace_brief_phase`/`workspace_brief_render` events by
`traceId` (not inferred from timestamp proximity):

| # | Ray ID | cpuTimeMs | wallTimeMs | Loader executions | queryFanoutDurationMs | finalSuggestionDonorCount | donorsScoredCount | Outcome |
|---|---|---|---|---|---|---|---|---|
| 1 (cold start) | `a2ddcb4e9e7e90c2` | 223 | 1156 | **2** (not deduped) | 65, 60 (both calls) | 140 | 140 | ok, 200 |
| 2 | `a2ddcb873b3c90c2` | 85 | 295 | **1** (query_complete+scoring_start+render, then 1 cache_hit) | 60 | 140 | 140 | ok, 200 |
| 3 | `a2ddcbc988f790c2` | 79 | 312 | **1** | 60 | 140 | 140 | ok, 200 |
| 4 | `a2ddcc0a5ff790c2` | 70 | 294 | **1** | 60 | 140 | 140 | ok, 200 |
| 5 | `a2ddcc44bdfe90c2` | 94 | 325 | **1** | 60 | 140 | 140 | ok, 200 |

`scoringDurationMs`/`assemblyDurationMs` were `0` in every sample, as
before. `resultPriorityCount: 10` and `recommendationCount: 129` in
every sample -- Today's visible content was byte-for-byte identical
across all 5 loads (confirmed both via screenshot and via these counts).
`openAskDonorCount` is `2` here vs `0` in the original instrumentation
baseline -- this is a real data change (the concurrent session's Ask
historical-backfill work created 2 real asks between the two
measurement sessions), not staleness: every one of these 5 requests
independently read the current D1 state and got the same *current*
answer, which is exactly what request-scoped (not cross-request) dedup
should produce. **No 1102, no 5xx, no blank/error screen, on any of the
5 navigations** -- including the one that didn't dedupe.

**Before vs. after, explicitly:**
- **Execution count:** before = 2 loader executions on every single
  request (proven in the original instrumentation task). After = 1 on
  4 of 5 (80%); the 5th (a cold start -- the first request the freshly
  deployed Worker version served) still ran 2. **Zero-execution
  regression: not observed on any of the 5** -- the loader never
  disappeared; freshness is intact.
- **CPU, deduped requests (4 samples):** 70, 79, 85, 94ms (median ~82ms)
  vs. the original instrumentation baseline's 141, 152, 242ms (median
  152ms). **A real, material reduction** -- roughly 40-65% lower,
  consistent with removing one of two D1 fan-outs.
- **CPU, the one non-deduped request:** 223ms -- in the same range as
  the pre-fix baseline (141-242ms), not worse than before, but not
  improved either, since it still ran the loader twice.
- **Wall time, deduped requests:** 294-325ms (median ~308ms) vs. before's
  480-828ms (median 489ms) -- also materially lower.
- Five samples is not enough to compute a rigorous median/confidence
  interval with any statistical weight -- this is a directional,
  evidence-backed read, not a claim of precision.

**What is proven:** the duplicate-execution root cause (vinext's probe
pass); that `enterWith()` is unsupported on Workers and breaks silently
when used for this; that `run()`/`getStore()`, scoped in
`worker/index.ts`, correctly dedupes the loader within a request in the
large majority (4/5) of real requests observed; that CPU/wall time drop
materially when dedup succeeds; that output and candidate counts are
byte-identical to what an un-deduped request would have produced (proven
by comparing against the un-deduped cold-start sample, which shows the
same `finalSuggestionDonorCount`/`donorsScoredCount`/`resultPriorityCount`
as the deduped ones); that freshness is intact (candidate counts reflect
real, concurrent data changes, not a stale cross-request cache).

**What remains unproven / open:**
1. **Why the cold-start request didn't dedupe.** Not investigated
   further in this task, per explicit instruction not to start another
   architectural fix in the same session. Leading (unverified)
   hypothesis: something about first-request module/dynamic-import
   resolution in a freshly-started isolate (e.g. `loadSsrHandler()`'s
   `import.meta.viteRsc.loadModule("ssr", "index")` lazily loading the
   SSR Vite environment for the first time) interacts with
   `AsyncLocalStorage` context propagation differently than on a warm
   isolate. Not confirmed.
2. **Whether Error 1102 risk is meaningfully reduced overall.** The
   duplicate-work problem is proven fixed for warm-isolate requests
   (the large majority of real traffic). It is explicitly NOT proven
   fixed for cold starts, and the original 1102 incident's own
   deployed version predated this loader's per-donor-scoring-loop-vs-
   fan-out cost profile question entirely (see the original incident
   section above) -- **do not claim future 1102s are impossible.**
   There may still be another CPU hotspot, and the cold-start case in
   particular is now the single most CPU-expensive scenario for this
   route (223ms, close to the old worst case).
3. The ~350-700ms of each request's wall time (and unknown CPU time)
   outside `loadWorkspaceBrief()`'s own instrumented phases, noted in
   the prior instrumentation section, is still completely
   uninstrumented and unattributed.

**Next approval needed:** none to close out or continue investigating
along the same lines. Any of the following would need its own separate,
explicit approval before implementation: investigating/fixing the
cold-start non-dedup case; extending instrumentation to the
uninstrumented request remainder; any other optimization.

## Ask / Solicitation Feature -- **COMPLETE / CLOSED FOR V1**

**STATUS: fully implemented, applied, deployed, live-verified, and now
closed out** -- including the last deliberately-deferred piece (the 3
reviewed historical cases) and their follow-on relationship_summary
cleanup. Migration `0032_asks.sql` is applied to
`fundraising-os-staging-db`; `a04b4bd`/`86584e9` are deployed as Worker
version `e2fb2e0c` (2026-08-19T17:04:39Z); direct Ask creation,
ask-from-interaction creation, all three status transitions
(committed/declined/withdrawn), Suggested Action timing/ranking,
Today/Meeting Brief/Assistant wiring, and the Klein/Pfeiffer/Rovinsky
historical backfill + cleanup have all been exercised against real
staging data and verified at the D1 layer, not just the UI. Full results:
"Ask / Solicitation Feature -- LIVE ROLLOUT VERIFICATION" and "Ask /
Solicitation Feature -- HISTORICAL BACKFILL AND CLOSURE" below. No
production/main/backup/R2/status infrastructure was ever touched by any
part of this feature's rollout. Remaining scope is intentionally deferred
(see "Intentionally Deferred Ask Enhancements" below), not blocking.

Design doc (approved, unchanged): `docs/ASK-SOLICITATION-DESIGN.md`.
This section reports the Phase 1 **implementation** built on top of that
approved design (§1-21 below describe the code as built and reviewed;
they predate the rollout and are unchanged by it). Everything below exists
as commits on `feature/independent-cloudflare-sandbox`, pushed to origin:
`a04b4bd` (implementation), `86584e9` (handoff update), `f1321c3`
(unrelated incident investigation), `0387d4b` (rollout/live-verification
handoff), plus this historical-backfill/closure handoff commit.

### 1. Root architecture implemented

Exactly the approved design, end to end: new `asks`/`ask_changes` tables;
a `open_ask` candidate in the existing shared recommendation engine
(confirmed-certainty, never a parallel engine); wiring into Meeting
Brief/Assistant/Today via the same evidence-building code paths every
other candidate already uses; a direct-creation route and a status-
transition route built on a pure, unit-tested decision function
(`planAskUpdate` in `lib/capture/ask.ts`); progressive-disclosure UI in
single-donor interaction capture only; a donor-profile Open Ask
card/history/direct-log entry point; donor-merge reassignment. Every
piece of shared logic (amount/purpose/note validation, the "what is this
ask" descriptor, the follow-up action text, the status-transition rules)
lives once in `lib/capture/ask.ts`, imported everywhere it's needed --
never duplicated or reimplemented.

### 2. Exact schema/migration

`drizzle/0032_asks.sql` (also reflected in `db/schema.ts`):
```sql
CREATE TABLE asks (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  donor_id text NOT NULL REFERENCES donors(id),
  amount_cents integer,                      -- nullable, integer cents only
  purpose text,                               -- nullable, free text
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','committed','declined','withdrawn')),
  asked_at integer NOT NULL,
  note text,
  source_interaction_id text REFERENCES interactions(id),  -- nullable
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX asks_donor_status_idx ON asks (donor_id, status);

CREATE TABLE ask_changes (
  id text PRIMARY KEY NOT NULL,
  ask_id text NOT NULL REFERENCES asks(id),   -- real FK (asks are never hard-deleted)
  user_id text NOT NULL REFERENCES users(id),
  donor_id text NOT NULL REFERENCES donors(id),
  action text NOT NULL CHECK (action IN ('created','updated','status_changed')),
  changed_fields text NOT NULL,               -- json array
  before_json text,                            -- json, null on 'created'
  after_json text NOT NULL,                    -- json
  created_at integer NOT NULL
);
CREATE INDEX ask_changes_ask_idx ON ask_changes (ask_id, created_at);
```
One evidence-based composite index on `asks` (covers both "asks for this
donor" and "pending asks for this donor" via its leftmost/full-pair
match); one on `ask_changes` (history for one ask), mirroring
`donor_contact_audits`'s single index exactly. No speculative indexes
added. Verified by applying this migration together with every other
committed migration (0000-0032) to a real in-memory SQLite database
(`node:sqlite`'s `DatabaseSync`) and inspecting the resulting
columns/FKs/indexes directly -- not just visual review.

### 3. Ask status semantics

`pending | committed | declined | withdrawn`, exactly as approved.
Transitions are one-way, always FROM `pending` (`ASK_TERMINAL_STATUSES`
in `lib/capture/ask.ts`) -- **no reopening in Phase 1**: attempting a
second status change on an already-terminal ask returns `409` with
`"This ask is already {status} and cannot be changed again."` A
`withdrawn` transition is rejected (`422`) unless a non-empty `note` is
provided in the same request -- that note becomes the required reason,
stored in the existing `note` column (no new column). No stage
selector/pipeline vocabulary anywhere.

### 4. Ask vs. JL financial-data protections

Verified two ways: (a) neither `app/api/asks/route.ts` nor
`app/api/asks/[id]/route.ts` contains any `INSERT`/`UPDATE` statement
targeting `giving_activities` or `gifts` -- asserted directly in
`tests/asks.test.mjs`; (b) marking an ask `committed` only ever writes
to `asks`/`ask_changes`/`recommendations` (retiring its own reminder) --
nothing else. No gift-to-ask matching of any kind exists; a newly
imported gift cannot and does not close an ask automatically. "Committed"
means only "the fundraiser recorded that the donor said yes," never "JL
has recorded the pledge."

### 5. Interaction-capture UX

`app/capture/CaptureExperience.tsx`, single-donor mode only: a "Did you
make an ask?" No/Yes toggle (default **No**) appears after the existing
reminder picker, using the same visual convention
(`reminder-picker`/`ask-picker` share styling). When Yes: Amount
(optional, `inputMode="decimal"`, parsed client-side to integer cents,
degrading to `null` — never a client-side error — on anything
unparseable/non-positive), Purpose (optional, 200-char cap), Note
(optional, 2000-char cap). Saving POSTs `madeAsk`/`askAmountCents`/
`askPurpose`/`askNote` to the **existing** `/api/interactions` route,
which creates the interaction, the ask (`source_interaction_id` set to
the just-created interaction's id), and the shared reminder (if any) in
one `env.DB.batch()` -- atomic, matching the pre-existing
interaction+reminder pattern exactly. The ask toggle is **never shown**
when editing an existing interaction (`!editing` guard) -- editing never
creates or changes an ask. No auto-detection from note text
("$"/"solicited"/"asked"/"pledge") anywhere -- `madeAsk` must be
explicitly `true`.

### 6. Direct Log Ask UX

`app/donors/[id]/AskManagement.tsx`'s `LogAskForm`, mirroring
`GivingManagement.tsx`'s `PendingGiftForm` exactly (collapsible inline
form, same interaction pattern). Fields: Amount (optional), Purpose
(optional), Date asked (defaults to today), Note (optional), and the
**same** reminder picker component reused a third time (interaction
capture, direct create, and — not built, see §7 — no separate "add
follow-up to an existing ask" flow in this phase's approved donor-profile
mockup). Posts to `POST /api/asks`. Status is always `pending`; no stage
selector is ever shown.

### 7. Donor-profile Open Ask UX

New `<section className="asks-section">` on `app/donors/[id]/page.tsx`,
positioned right after the JL-sourced giving KPI grid and visually
distinct from it (different background/border, its own "ASKS" eyebrow) --
deliberately never implies confirmed financial data. Live mode only (no
demo/sample asks data exists). Zero-to-N open (pending) asks render as
compact cards (`OpenAskCard`): amount (only when non-null — **never**
"$0"), purpose (or "Support requested" when both amount and purpose are
absent), "Asked {date}", and three actions -- **Mark committed** and
**Declined** as the two prominent, emphasized buttons, and a small `•••`
overflow that reveals **Stop pursuing** (the `withdrawn` status) behind a
required-reason textarea, deliberately de-emphasized so this never reads
as pipeline-management software, per explicit instruction. Historical
(committed/declined/withdrawn) asks collapse into a `<details>` "Past
asks (N)" section, same pattern `GivingManagement.tsx` already uses for
non-actionable records.

### 8. Status-transition behavior

`PATCH /api/asks/[id]` -- thin wrapper around the pure `planAskUpdate()`
(validates, enforces the one-way-from-pending rule, computes exactly
which fields changed). A no-op request (nothing actually different from
the stored row) returns `"No changes were needed."` and writes nothing --
verified directly (`planAskUpdate(pendingAsk, {amountCents: <same
value>, purpose: <same value>})` returns `{ ok: true, changed: false }`).
Reopening is not supported (§3). Every meaningful mutation writes one
`ask_changes` row (see §9) and, if the status changed, completes every
open reminder tied to this ask (`id LIKE 'ask-<id>-%'`, retiring every
"Add follow-up" reminder ever set for it, not just the first).

### 9. Audit-history behavior

`ask_changes`, modeled directly on the existing `donor_contact_audits`
shape: `action` (`created`/`updated`/`status_changed`), `changed_fields`
(json array), `before_json`/`after_json`. A status change is always
logged as `status_changed`; an amount/purpose/note-only edit is logged as
`updated`. Not event sourcing -- one row per meaningful mutation, nothing
finer-grained.

### 10. Reminder integration

Fully reused, no new mechanism. Interaction capture: the existing
`reminder`/`reminderDueAt()`/`recommendations`-insert path, now routed to
an ask-specific id (`ask-<askId>-<uuid>`) and action text
(`askFollowUpAction()`) when an ask was made, otherwise unchanged
(`activity-<interactionId>`, `extracted.nextAction`). Direct creation:
same picker, same mechanism. No `follow_up_at`/`next_follow_up_at`
column, no Ask-specific reminder table.

### 11. Suggested Action behavior and timing rule

New `open_ask` candidate (`certainty: "confirmed"`), added to
`generateCandidates()` -- the existing shared engine, not a parallel one.
**Timing rule, evidence-grounded, not invented:** urgency reuses
`follow_up_pledge`'s exact horizon (`clamp01(ageDays / 180)`) and exact
confidence cutoff (`ageDays >= 60 ? "medium" : "low"`) verbatim -- the
closest existing precedent for "a stale, confirmed, money-adjacent open
item." One deliberate, reasoned departure from that precedent: `recency`
is a constant `0.7` (not `follow_up_pledge`'s decaying `0.3`), because an
ask's own fact ("we asked, still pending") stays exactly as true and
current regardless of age -- there's no "last activity" to go stale the
way a pledge's does. This is what makes a same-day ask still outrank the
existing fuzzy `solicitCandidate` on merit (verified:
`certaintyMultiplier(1.0) * (0.35*0.75 + 0.35*0.7 + 0.30*0) ≈ 0.51` vs.
`solicit`'s `0.85 * (0.35*0.7 + 0.35*0.5 + 0.30*0.4) ≈ 0.46`) while
`urgency` still starts near zero, so a fresh ask never reads as an
immediate nag (verified: `ageDays=0` → `urgency < 0.05`, `confidence:
"low"`; `ageDays=90` → `urgency ≈ 0.5`, `confidence: "medium"`, and the
open_ask candidate wins the overall recommendation when nothing else
outranks it -- all asserted directly in `tests/asks.test.mjs` items
15-17). This was flagged as a genuine design decision (not a stop
condition) because a direct, reasoned precedent existed to reuse for two
of the three scoring axes; only `recency` needed adjustment, with
explicit reasoning grounded in the existing three-axis scoring model's
own semantics. `honor_reminder` is not hard-suppressed by `open_ask`
either way -- it already reliably outranks a fresh `open_ask` candidate
on scoring merit alone (specificity 0.9 vs. 0.75, recency/urgency 0.6-1
vs. 0.7/near-zero) whenever an explicit reminder exists, so no new
suppression rule was needed (documented in
`recommendation-rank.ts`'s `REMINDER_SUPPRESSES` comment).

### 12. Today integration

`lib/workspace/live-data.ts`: new `openAskByDonor` map (oldest pending
ask per donor), threaded into the same per-donor evidence loop as
`openPledgeByDonor`. `lib/workspace/suggestion-candidates.ts`:
`askDonorIds` added to `selectSuggestionDonorIds()`, **unbounded** like
`giftDonorIds`/`pledgeDonorIds` (always included, never subject to the
contact-gap pool cap). `open_ask: "Open ask"` added to
`suggestionLabelByKind`. **No new dashboard section, no "Ask Pipeline,"
no "Open Opportunities" view** -- stale pending asks surface exclusively
through the existing Suggested Action ranking on Today, exactly as
specified.

### 13. Meeting Brief integration

`lib/relationships/meeting-brief.ts` queries every pending ask for the
donor (oldest first); `meeting-brief-model.ts`'s `MeetingBrief.openAsks`
carries the full list, and a new `askLine()` formatter produces exactly
`"Open ask: $10,000 for dinner sponsorship, pending since Aug 1."` --
factual, never calling it an "opportunity" (asserted directly:
`askLine(...)` does not match `/opportunity/i`). The oldest pending ask
also feeds the same `buildRecommendationEvidence()` call every other
candidate uses, so Suggested Action reflects it automatically.

### 14. Assistant integration

Bounded exactly to what the existing architecture supports, per explicit
instruction: `AssistantContextSnapshot.donor.openAsks` (pre-formatted
lines via `askLine`) is threaded through from the **primary donor's**
Meeting Brief only (`app/api/assistant/route.ts`), and surfaced in the
`meeting-brief`/`relationship-summary` task templates
(`lib/ai/rule-based.ts`'s new `openAsksBlock`). **Not built:**
donor-name NLU, cross-donor Ask search, a "show me every open ask"
capability, any new Assistant architecture -- none of these are
achievable without infrastructure that doesn't exist for *any* fact type
today, not just asks (confirmed during the design phase's audit).

### 15. Shared/multi-donor safety behavior

`app/api/interactions/shared/route.ts` (the multi-donor/broadcast route)
was **not touched at all** -- verified directly: it contains zero
references to `madeAsk` or `INSERT INTO asks`
(`tests/asks.test.mjs` item 22). This is structural, not just a code-
review claim: the single-donor form fields (including the new ask toggle)
only ever render inside `entryMode === "single"`'s JSX branch, and only
`saveInteraction()` (which POSTs to `/api/interactions`, never
`/api/interactions/shared`) sends ask fields at all. A shared/broadcast
activity cannot create an ask for any recipient, let alone N of them.

### 16. Donor-merge behavior

`app/api/donors/merge/route.ts`: `UPDATE asks SET donor_id=? WHERE
donor_id=? AND user_id=?` and the same for `ask_changes`, added to the
existing atomic `env.DB.batch()` alongside every other reassigned table;
`asks` added to `linkedCounts()`/`movedCounts` reporting. Verified
behaviorally against a real in-memory SQLite database (not just source
review): seeded two donors, an ask, and an `ask_changes` row for the
duplicate donor, ran the literal reassignment statements, confirmed both
rows now belong to the survivor. **No fuzzy deduplication of asks** is
attempted merely because amount/purpose look similar -- multiple pending
asks are explicitly allowed (verified: inserting two `pending` asks for
the same donor against the real schema succeeds with no constraint
violation).

### 17. Infrastructure/baseline/reset changes

- `db/schema.ts` -- new `asks`/`ask_changes` table definitions.
- `production-baseline/schema-manifest.json` and
  `production-baseline/drizzle/0000_production_baseline_0019.sql` --
  regenerated via the existing `pnpm run db:baseline:generate -- --write`
  generator (never hand-edited); now reflects 33 source migrations
  (0000-0032).
- `lib/data-health/production-baseline.ts` -- the hardcoded
  `PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 32` invariant bumped
  to `33`, comment updated to describe `0032_asks.sql`.
- `lib/operations/workspace-backup.ts` -- **newly discovered during this
  task** (not caught during the design-phase audit): a *separate*,
  smaller, human-readable JSON export (`/api/import/backup`, distinct
  from the nightly whole-database `wrangler d1 export`) requires every
  fundraising table to be explicitly classified into one of two lists,
  enforced by its own regression test. Added `asks`/`ask_changes` to
  `WORKSPACE_BACKUP_EXCLUDED_TABLES` (same treatment as
  `yahrtzeits`/`important_dates` -- real donor-facing data, covered only
  by the nightly full backup; including them in the smaller export would
  need its own separately-verified owner-scoping work, out of scope
  here).
- `lib/operations/staging-reset.ts` -- `ask_changes` then `asks` added to
  `STAGING_RESET_TABLE_ORDER` (children-before-parents order: ask_changes
  references ask_id). The existing self-check test
  (`tests/staging-reset.test.mjs`) confirms this list is exactly the
  fundraising-table set.
- **Nightly backup/restore workflow YAML: untouched**, confirmed
  unnecessary -- `wrangler d1 export` (`.github/workflows/d1-backup-
  nightly.yml`) is a full, untargeted database export with no per-table
  enumeration to update.

### 18. Mobile behavior

Verified by reading the actual CSS, not just the JSX: `.ask-picker
.ask-fields` mirrors `.reminder-picker > input`'s three-breakpoint
pattern exactly (base: label-left layout; tablet+: wider label column;
narrow mobile: `.reminder-picker legend`/`.ask-fields` both collapse to
full-width, stacked). The Open Ask card grid
(`.open-ask-list`) collapses to a single column under 700px; the Log Ask
form becomes a fixed bottom sheet under 700px, matching
`.pending-gift-form`'s existing mobile treatment exactly. No wide tables,
no desktop-only management UI anywhere in this feature.

### 19. Tests added and results

`tests/asks.test.mjs` -- all 25 required items, run in `pnpm test`'s
existing chain. Mix of real behavioral tests (pure validation/transition
functions from `lib/capture/ask.ts`; real recommendation-engine
evidence/candidate construction; a real in-memory SQLite database built
from every actual committed migration for schema/merge/multi-ask
behavior) and source-string checks only where this repo has no D1/route
test harness at all (confirmed by auditing every existing API-route test
in this codebase first -- `tests/activity-editing.test.mjs`,
`tests/donor-merge.test.mjs`, etc. -- none of them invoke a route handler
against a mocked `env`; they all verify committed source text, the
established convention this task's own tests follow for the same reason).
**Result: all 25 items pass.**

Existing tests updated for legitimate, intentional changes (not weakened
to make something pass):
- `tests/today.test.mjs` -- the donor page's exact `env.DB.prepare(...)`
  call-site count invariant, `21 -> 22` (one new, real, intentional
  query), with an updated comment explaining why.
- `tests/production-baseline.test.mjs` -- a new "0032 asks migration"
  test (same pattern as every prior migration's own test in this file);
  the superseded 0031 test downgraded from an exact-length assertion to
  an `.includes()` check, matching how every earlier migration's test in
  this same file already reads once it's no longer the newest.
- `tests/shared-activity-ux.test.mjs` -- one assertion's regex loosened
  to no longer require `acceptRelationshipSnapshot` be the literal last
  field in the request body object (it no longer is, now that ask fields
  are appended after it) -- the assertion's actual intent (the flag is
  still sent, still correctly gated) is unchanged and still verified.
- `tests/assistant.test.mjs` -- its hand-built `AssistantContextSnapshot`
  fixture gained `openAsks: []` (a plain untyped test fixture, so this
  wasn't caught by `tsc`; caught by actually running the test).

### 20. Typecheck/build results

`pnpm exec tsc --noEmit`: clean, zero errors, after every single edit in
this task (re-run repeatedly throughout, not just once at the end).
`pnpm run build:staging-independent`: succeeded, exit 0; the build's own
route listing confirms `/api/asks` and `/api/asks/:id` are registered.

### 21. Exact files changed

New: `app/api/asks/route.ts`, `app/api/asks/[id]/route.ts`,
`app/donors/[id]/AskManagement.tsx`, `drizzle/0032_asks.sql`,
`lib/capture/ask.ts`, `tests/asks.test.mjs`.

Modified: `db/schema.ts`, `app/api/interactions/route.ts`,
`app/api/donors/merge/route.ts`, `app/api/assistant/route.ts`,
`app/capture/CaptureExperience.tsx`, `app/donors/[id]/page.tsx`,
`app/globals.css`, `lib/ai/types.ts`, `lib/ai/rule-based.ts`,
`lib/relationships/recommendation-evidence.ts`,
`lib/relationships/recommendation-candidates.ts`,
`lib/relationships/recommendation-rank.ts`,
`lib/relationships/meeting-brief.ts`,
`lib/relationships/meeting-brief-model.ts`, `lib/workspace/live-data.ts`,
`lib/workspace/suggestion-candidates.ts`,
`lib/data-health/production-baseline.ts`,
`lib/operations/staging-reset.ts`, `lib/operations/workspace-backup.ts`,
`package.json`, `production-baseline/schema-manifest.json`,
`production-baseline/drizzle/0000_production_baseline_0019.sql`,
`tests/today.test.mjs`, `tests/production-baseline.test.mjs`,
`tests/shared-activity-ux.test.mjs`, `tests/assistant.test.mjs`.

32 files changed total (`git diff --stat` on commit `a04b4bd`), 1607
insertions, 43 deletions.

### 22. Migration number/name and confirmation of applied state

`drizzle/0032_asks.sql`. **APPLIED** to `fundraising-os-staging-db`
(Independent Staging only) during this rollout task, ~2026-08-19T17:00:03Z.
Originally verified pre-apply against a local, disposable, in-memory SQLite
instance (`node:sqlite`); post-apply, independently re-verified directly
against real staging D1 (`asks`/`ask_changes` tables, their exact CHECK
constraints, FK, and both indexes all confirmed present via `sqlite_schema`
queries; every pre-existing table/index/row count confirmed byte-for-byte
unchanged). Never applied to production -- no production D1 binding exists
in this repo's wrangler config.

### 23. Commit SHAs

`a04b4bd` (implementation) and `86584e9` (its handoff-update commit), both
pushed to `origin/feature/independent-cloudflare-sandbox`. `86584e9` is the
exact commit deployed as Worker version `e2fb2e0c`. `f1321c3` (an unrelated
incident investigation, docs-only) and this rollout/live-verification
handoff commit both sit on top, also pushed.

### 24. Confirmation of push state

Confirmed: `origin/feature/independent-cloudflare-sandbox` matches local
HEAD at every checkpoint of this rollout (verified via `git fetch` +
`git rev-parse` before any write, and again before this handoff commit).
`a04b4bd`/`86584e9` were already pushed before this rollout task began (by
the implementation task); this task did not need to push application code,
only its own handoff-update commit at the end.

### 25. Confirmation of deploy state

Confirmed: `wrangler deploy --config wrangler.staging.jsonc` was run
against `86584e9` (current branch HEAD at deploy time) during this
rollout's Phase E. Deployed Worker version `e2fb2e0c-33eb-4f55-a881-7cf27deb898c`,
confirmed live via `wrangler deployments list --config wrangler.staging.jsonc`
showing it as the current 100% deployment. No production Worker/environment
was ever targeted -- `wrangler.staging.jsonc` has no production binding.

### 26. Confirmation of D1/R2/workflow/main/production scope

Confirmed throughout this rollout: every D1 write (the migration, and all
live-test Ask/interaction/status-transition writes) targeted
`fundraising-os-staging-db` only, via `wrangler d1 execute --remote
--config wrangler.staging.jsonc`. No R2 object was read or written (no R2
binding exists in `wrangler.staging.jsonc`). No `.github/workflows/*.yml`
file was modified. `origin/main` was checked before and after this
rollout and is unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). No
production binding/environment was touched at any point -- confirmed by
inspecting `wrangler.staging.jsonc` before any write and using only that
config for every command in this task.

### 27. Implementation issues / design assumptions that surfaced

1. **`lib/operations/workspace-backup.ts`'s secondary JSON-export table
   classification** (§17) was not caught during the design-phase audit
   and only surfaced while actually wiring infrastructure in this task --
   a real gap in the original design doc's "Infrastructure" section,
   now closed.
2. **The timing/urgency scoring for `open_ask`** (§11) required a
   genuine, reasoned departure from `follow_up_pledge`'s exact precedent
   (constant `recency` instead of decaying) to satisfy both "must
   normally beat fuzzy solicit evidence" and "must not nag immediately" --
   flagged in detail rather than silently invented; verified numerically,
   not just asserted.
3. **Reminder linkage to an ask uses an id-prefix convention**
   (`ask-<askId>-<uuid>`), not a real FK -- deliberately matching the
   pre-existing `activity-<interactionId>` convention `recommendations`
   already uses for interaction reminders (that table has no
   interaction_id column either). Consistent with precedent, but worth
   flagging as a soft link, not a database-enforced one.
4. **No "Add follow-up" action exists on the donor-page Open Ask card
   itself** in this phase -- the approved mockup for this task
   (`[Mark committed] [Declined] [•••]`) omits it, unlike the earlier
   design doc's own mockup which included it. Reminders can currently
   only be set at ask-creation time (interaction capture or direct Log
   Ask), not added later to an already-pending ask. Flagged as a scope
   note, not a bug -- easy to add later if wanted.
5. **The three Klein/Pfeiffer/Rovinsky historical cases were NOT
   backfilled** -- confirmed, per explicit instruction; they remain
   exactly as left by the prior cleanup-audit task (relationship_summary
   still flagged NEEDS_REVIEW, untouched).

## Ask / Solicitation Feature -- LIVE ROLLOUT VERIFICATION (Independent Staging, 2026-08-19)

Controlled rollout of the Phase 1 implementation above: applied the
migration, deployed, and live-tested end to end against real staging
donors, using the actual deployed UI/API (not synthetic/mocked calls).
Historical backfill (Klein/Pfeiffer/Rovinsky) was explicitly out of scope
for this task and was not touched.

**Migration.** `drizzle/0032_asks.sql` applied via `wrangler d1 execute
--remote --config wrangler.staging.jsonc`. Post-apply: both tables, their
exact CHECK constraints and FK, and both indexes confirmed present; every
pre-existing table/index/row count confirmed unchanged (10-point checklist,
all pass). Note: `wrangler d1 execute --file` mode's JSON summary metadata
(e.g. `num_tables`) is unreliable for verification (confirmed again this
task -- it under-reported the table count after a successful apply);
`--command` mode's per-query results are what was actually trusted.

**Deploy.** Current branch HEAD (`86584e9`) deployed via `pnpm run
deploy:staging-independent` (`wrangler deploy --config
wrangler.staging.jsonc`). Worker version `e2fb2e0c-33eb-4f55-a881-7cf27deb898c`,
confirmed live via both the deploy output and an independent `wrangler
deployments list` check. URL: `https://fundraising-os-staging.sgoldstein.workers.dev`.

**Direct Ask creation** (donor: Dr. & Dr. Joseph Resnikoff): logged via the
donor-page "+ Log ask" form, Amount $5,000 / Purpose "Staging ask test" /
Note "Direct Ask staging verification". Verified at the D1 layer: exactly
one `asks` row, `status='pending'`, `amount_cents=500000`,
`source_interaction_id` NULL; one `ask_changes` row (`action='created'`);
no `giving_activities`/`gifts` row created, no fake JL pledge. UI: Open
Ask card showed "$5,000 Staging ask test", never a raw-cents or fake "$0"
value; donor page visually distinguished it from JL-sourced giving KPIs.
Suggested Action correctly picked up the new `open_ask` candidate. Meeting
Brief and Assistant primary-donor context: architecture confirmed correct
via code (both read `openAsks` from the same `loadMeetingBrief()` call),
but this specific donor was not directly observable as the Assistant's
`primaryId` at test time (a different real donor had a higher-ranked
candidate) -- not a defect, just not independently live-observable for
this exact donor. **Real gap found (not a regression, a pre-existing
completeness gap):** `app/donors/[id]/meeting-brief/page.tsx` never
renders `brief.openAsks` as its own line -- an ask only becomes visible on
the Meeting Brief page today if it happens to win the single Suggested
Action slot. A donor with a pending ask that isn't the top-ranked
recommendation shows no ask information at all on their Meeting Brief.
Not fixed in this task (out of scope -- "do not redesign the feature");
flagged below under Next Approval Required.

**Ask created from an interaction** (donor: Dr. & Dr. Paul S. Richman):
single-donor capture form, "Did you make an ask? = Yes", Type: Text
Message, Summary "Ask staging verification interaction", Amount $10,000,
Purpose "Dinner sponsorship". Verified at the D1 layer: one new
`interactions` row; one new `asks` row with `source_interaction_id`
correctly set to that interaction's id; one `ask_changes` row
(`action='created'`); `shared_activity_id`/`role` both null (ordinary
single-donor interaction, not shared); no other donor received an ask; no
giving/JL data touched. Normal interaction-capture behavior (relationship
snapshot prompt, timeline entry) was unaffected.

**Status transitions** (all three tested live, all verified at the D1
layer):
- **Committed** (Resnikoff's $5,000 ask): `asks.status` -> `committed`;
  second `ask_changes` row (`action='status_changed'`, correct before/after
  JSON); the ask's linked reminder automatically completed
  (`recommendations.status` -> `'completed'`); `giving_activities`/`gifts`
  globally unchanged throughout (5176/0); UI moved it to "Past asks",
  Suggested Action naturally recomputed to the next-best candidate.
- **Declined** (Richman's $10,000 ask): `asks.status` -> `declined`; audit
  row written; giving/JL globally unchanged; UI/Suggested Action behaved
  identically to the committed case.
- **Withdrawn** (a third test ask, Resnikoff, "Staging withdraw test", no
  amount): attempting "Stop pursuing" with an empty reason never reached
  the server -- the button/field's client-side `required` state kept the
  ask `pending` (confirmed via D1: no change). Submitting again with a
  reason ("Staging verification -- testing withdrawn reason requirement")
  succeeded: `asks.status` -> `withdrawn`, `note` holds the reason,
  `ask_changes` has a `status_changed` row with the reason in `after_json`.
  Reminder-retirement/giving-protection behavior identical to the other
  two transitions. Reopening was not tested (intentionally unsupported;
  the UI does not expose it).

**Suggested Action / timing.** Consolidated from the tests above plus a
direct recommendations-table check: a same-day pending ask does not read
as an urgent nag (`timing: null`, "No dated urgency" shown), yet still
wins the Suggested Action slot on its own merit when nothing else
outranks it (observed directly for the withdrawn-test ask before it was
resolved). When an explicit reminder exists for an ask, `honor_reminder`
wins and its action text is exactly `askFollowUpAction()`'s output (e.g.
"Follow up on the $5,000 Staging ask test ask.") -- confirmed live, not
just in tests. No ranking/scoring logic was changed in this task.

**Today / Meeting Brief / Assistant wiring.** Confirmed via source: the
Today page (`app/page.tsx`) reads from the same `loadWorkspaceBrief()`
priorities/relationship-queue pool every other candidate uses -- no new
dashboard section, no "Ask Pipeline" view exists. The Assistant's
`openAsks` context (`app/api/assistant/route.ts`) is strictly scoped to
`primaryId` inside a single `Promise.all` -- no donor-name cross-search or
new query path was added. The Meeting Brief gap is described above.

**Mobile/narrow-viewport check.** Could not be completed. The
`resize_window` tool reported success at 390x844, but `window.innerWidth`
(checked directly via JavaScript) stayed at 1920 -- the true rendered
viewport never changed, matching this same tooling limitation recorded
elsewhere in this file for prior rollouts in this environment. **Not
claiming pixel-level mobile verification.** Code-level check only: the Ask
UI's CSS follows the same responsive card/form patterns already used
elsewhere in this app (no fixed-width or desktop-only markup found in the
Ask components), consistent with (but not a substitute for) a real
small-screen visual pass.

**Cleanup.** All test data resolved through normal application paths, no
ad-hoc SQL, nothing hard-deleted:
- The three test `asks` rows are all in terminal states (`committed`,
  `declined`, `withdrawn`) -- left as-is per this task's own instruction
  not to invent a hard-delete path; their `ask_changes` audit history is
  intentionally retained.
- The one test `interactions` row was archived via the donor-timeline
  "Archive" button (`DELETE /api/interactions/:id`, `action: "archive"`)
  -- confirmed via D1: `source` -> `archived:capture:text`, row never
  hard-deleted, no residual open `recommendations` row.
- **Note:** clicking "Archive" triggers a native `window.confirm()`
  dialog, which briefly froze the browser-automation tab (click/screenshot
  calls timed out for a few seconds) before the tab recovered on its own
  and the action completed successfully. Worth knowing for any future
  browser-automated testing of this same button.

**Final safety checklist (all confirmed via direct D1/git checks
immediately before this handoff commit):** production untouched;
`origin/main` unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`); no
backup/R2/status-worker infra changed; only migration `0032_asks.sql` was
applied; no historical backfill performed; Klein/Pfeiffer/Rovinsky have
zero `asks` rows (confirmed via a direct join, untouched); no
`relationship_summary` cleanup was performed (both test donors' summaries
remain `NULL`, as before); `giving_activities`/`gifts` counts unchanged
throughout (5176/0); no shared/multi-donor ask creation occurred (every
test ask ties to exactly one donor; the schema has no shared-activity
column on `asks` at all); all test data is terminalized/archived and
documented above.

## Ask / Solicitation Feature -- HISTORICAL BACKFILL AND CLOSURE (2026-08-19)

Closes the last open item from docs/ASK-SOLICITATION-DESIGN.md §20/21 and
this file's own prior "Next Approval Required": the 3 already-reviewed
historical solicitation cases (Klein/Pfeiffer/Rovinsky), backfilled into
real `asks` rows, with their broken machine-generated
`relationship_summary` values cleared only after each Ask was verified.

**Tooling.** `scripts/ask-historical-backfill.mjs` -- a narrow, one-off
script, not a general importer. An explicit, hardcoded 3-entry allowlist
(exact donor ID + source interaction ID pairs) is the only input it will
ever act on; no note-text scanning or Monday-classification lookup exists
anywhere in the file. Two independently-gated phases: `--apply-asks`
(create the 3 `asks`/`ask_changes` rows) and `--cleanup-summaries` (clear
`relationship_summary`, only for donors whose Ask was just freshly
re-verified). No flag = dry run (read-only). Idempotency: the schema has
no UNIQUE constraint on `asks.source_interaction_id` (noted below as a
future consideration only, not worth a migration for 3 records); the
script enforces it itself via `INSERT ... SELECT ... WHERE NOT EXISTS`
guards, safe even without cross-statement transactions (`wrangler d1
execute --remote` rejects explicit `BEGIN`/`COMMIT` -- confirmed live,
error code 7500, directs callers to Durable Object transaction APIs this
CLI-only script has no access to).

**Pre-write re-verification (all 3 independently re-confirmed against
fresh staging D1 before any write, per explicit instruction not to trust
the reviewed case blindly):** exact donor IDs, exact source interaction
IDs, exact note text (first line, byte-for-byte), interaction dates,
`user_id`/`owner_user_id` ownership, and that no ask already existed for
any of the 3 source interactions. All 3 matched the reviewed case exactly
-- no discrepancy, no STOP condition triggered.

**Dry run:** exactly 3 eligible (as required -- the script itself refuses
to proceed to `--apply-asks` if the count is ever not 3).

**Backfill result (all 3 applied on the first real attempt after fixing
one bug -- see below):**

| Donor | Ask ID | Amount | Purpose | Asked | Source interaction |
|---|---|---|---|---|---|
| Mr. & Mrs. Mayer Simcha Klein | `d3b77711-938d-4a61-bf59-02510ca77314` | $5,000 | Plaque | 2025-11-06 | `monday-interaction-5a79919d` |
| Mr. & Mrs. Allen Pfeiffer | `dc35a805-af5c-4dbd-8eda-a1cdc182abd1` | $10,000 | (none -- note specifies no purpose) | 2025-09-15 | `monday-interaction-7161c502` |
| Rabbi Michoel A. Rovinsky | `90b9b052-af64-48ed-82d8-78b060a9ef8b` | $5,000 | Plaque in memory of his wife | 2025-09-29 | `monday-interaction-6d655cb9` |

All 3: `status = 'pending'` (the source notes only prove "solicited," never
a terminal outcome -- no commitment/decline was invented), `asked_at` =
the source interaction's exact `occurred_at`, `note = NULL` (the source
note is already preserved via `source_interaction_id`; a duplicate copy in
`note` was judged not useful). One `ask_changes` row per Ask
(`action='created'`, `changed_fields =
["amountCents","purpose","status","askedAt","note","sourceInteractionId"]`,
matching the exact shape the real `/api/interactions` route uses for an
ask created from an interaction). Verified directly against D1
post-apply: exactly 3 new asks, exactly 3 new `ask_changes` rows, correct
linkage/amounts/purposes/dates, `giving_activities`/`gifts` counts
unchanged throughout (5176/0), no `recommendations` rows created for these
3 donors, the 3 source `interactions` rows byte-for-byte unchanged, and
the pre-existing 3 test asks from the prior rollout (Resnikoff x2,
Richman x1, all already terminal) untouched.

**Bug found and fixed live, before any write succeeded:** the script's
generated multi-line SQL (readable in source, but containing literal
newlines) broke `wrangler d1 execute --command`'s Windows shell-argument
parsing (`incomplete input: SQLITE_ERROR`) -- the same class of bug
documented in `scripts/relationship-summary-cleanup-preview.mjs`. Fixed
by collapsing whitespace/newlines to single spaces before sending (SQLite
is whitespace-insensitive; only the Windows shell argument boundary
cared). Confirmed via a fresh D1 read that the failed first attempt wrote
nothing (0 matching asks) before retrying. One additional transient
failure (a `UV_HANDLE_CLOSING` assertion during a read-only fetch)
matched the same known, transient, first-attempt-only wrangler/Windows
hiccup observed repeatedly elsewhere in this project's history -- resolved
on immediate retry with identical arguments, not a real error.

**Relationship_summary cleanup (all 3, applied after Ask verification,
first attempt, all succeeded):**

| Donor | Before | After |
|---|---|---|
| Klein | `"Latest discussion topics: Relationship update.\nPeople mentioned: Solicited.\nRecommended next action: Review this note before the next interaction."` | `NULL` |
| Pfeiffer | (same broken format) | `NULL` |
| Rovinsky | (same broken format) | `NULL` |

Each cleared only via a compare-and-swap `UPDATE donors SET
relationship_summary = NULL WHERE id = ? AND relationship_summary =
<exact hex-encoded current value>` -- fails closed (0 rows) if the stored
value had drifted since the read; all 3 matched `changes = 1`. Verified
post-cleanup: all 3 donors' `relationship_summary` is `NULL`;
`institutional_memory` for all 3 is byte-for-byte unchanged (still
`"Note context: Solicited for..."` -- this field was never touched, by
design); the 3 source interactions unchanged; table-wide
`relationship_summary` non-null count dropped from 9 (pre-existing
baseline) to 6, matching exactly (4 previously-regenerated-clean rows +
Semmelman + Zachter, the 2 other NEEDS_REVIEW donors from the prior
cleanup-audit task, which are **not** solicitation cases and were
correctly left untouched -- spot-checked directly, still their original
old-format text). No other donor's relationship_summary was touched.

**Recommendation verification (read-only, live-confirmed for Klein on the
deployed app):** the `open_ask` candidate is eligible and wins Suggested
Action -- "Follow up on the $5,000 Plaque ask." -- even though
`relationship_summary` is now `NULL` and the old fuzzy `solicitCandidate`
would otherwise still match `institutional_memory`'s "Solicited for a
plaque ($5k)" text (confirmed in source: `solicitCandidate` falls back to
`institutionalMemory` when `relationshipSummary` is null). The confirmed
Ask wins on merit exactly as designed (§10), not because the fuzzy path
was disabled. Because these are historical (~9-10 months old as of
2026-08-19), they surface as clearly-labeled **stale pending asks**, not
as new/urgent ones -- Klein's detail read "An ask was made 286 days ago
and is still pending," with the UI's usual "No dated urgency" copy (no
explicit reminder was set, per design -- historical backfills never
auto-create reminders). This is the intended behavior, not a defect; no
ranking/scoring logic was changed to produce it.

**Donor profile / Meeting Brief (live-verified for Klein, no app deploy
needed or performed -- this was a pure data backfill):** the donor page's
Open Ask card correctly shows "$5,000 / Plaque / Asked Nov 6, 2025"; the
Relationship Snapshot card now reads "No relationship snapshot yet" (an
honest empty state, not the old broken text); Institutional Memory still
correctly shows "Note context: Solicited for a plaque ($5k)" (untouched);
the Meeting Brief page's Suggested Action panel shows the same "Follow up
on the $5,000 Plaque ask." evidence. The previously-documented Meeting
Brief gap (no dedicated `openAsks` line, separate from the Suggested
Action slot) still applies here exactly as it does for every other Ask --
not a new or backfill-specific issue, not fixed in this task (redesigning
the feature was explicitly out of scope).

**Tests.** `tests/ask-historical-backfill.test.mjs`, 14 items (dry-run
fixture matching, deterministic amount/purpose mapping, source-interaction
requirement, existing-Ask no-op, unapproved donor/source rejection, no
reminders/recommendations, no giving/JL mutation, rerun idempotency,
cleanup-after-verification-only, compare-and-swap cleanup,
institutional_memory/source-interaction/other-donor immutability),
offline/networkless via injectable fetch/write functions, mirroring
`tests/relationship-summary-apply.test.mjs`'s pattern. Added to `pnpm
test`'s chain. `pnpm test` (full suite) and `pnpm exec tsc --noEmit` both
clean. No application/TypeScript code was touched by this task (only
`scripts/`, `tests/`, `package.json`'s test chain, and this handoff), so
this task itself needed and performed no build or deploy. Note: a
**separate, concurrent session** (unrelated Today/Assistant loader
instrumentation work, see "Independent Staging Instrumentation" below)
deployed Worker version `f29c075f-b1e3-496d-bc10-cc52ecf05554` at
2026-08-19T17:42:09Z during roughly the same window -- confirmed via a
fresh `wrangler deployments list` immediately before writing this section,
that version is the current 100% live deployment. That deploy is unrelated
to and does not affect the Ask feature or this backfill in any way (it
only adds structured logging inside `loadWorkspaceBrief()`); re-verified
live that the Klein donor-page/Meeting Brief checks above rendered
correctly against it.

**Final safety checklist (all re-confirmed via direct D1/git checks
immediately before this handoff commit):** production untouched;
`origin/main` unchanged; no backup/R2/status-worker infra changed; no
migration beyond 0032 applied (this task applied none -- it only wrote
rows); Klein/Pfeiffer/Rovinsky are the only 3 historical cases converted,
exactly as reviewed; `giving_activities`/`gifts` unchanged throughout;
`institutional_memory` and all 3 source interactions byte-for-byte
unchanged; no other donor's Ask or `relationship_summary` touched; no
reminders or `recommendations` rows auto-created by the backfill.

### Unresolved decisions from the design phase -- now resolved by this
implementation (recorded here for continuity)

All 8 items from the design doc's "Unresolved decisions" section were
implemented exactly as recommended (status model incl. `withdrawn`
requiring a note; free-text purpose; multiple concurrent pending asks
allowed; direct creation included; only-originating-interaction linking,
Option A/D; the `ask_changes` audit table built). Items 7-8
(backfilling Klein/Pfeiffer/Rovinsky, and clearing their
`relationship_summary`) were explicitly **not** done in the earlier
rollout task that first wrote this paragraph -- but **are** done as of
this same "HISTORICAL BACKFILL AND CLOSURE" section above (this
paragraph is carried over for continuity from that earlier report and
was not itself updated when the backfill completed later in this same
section; corrected 2026-08-21 during a documentation cleanup pass).

## Today's-Agenda Birthday Bucketing + Open-Pledge Payment Recency -- FIXED AND LIVE (2026-08-19)

Two bounded correctness fixes, unrelated to each other and to the Ask
feature/1102 work above. Not part of the (separate, not-started-here)
monthly-payment-plan feature -- see "Deferred: monthly payment plans" below
for what that would need.

### Bug 1: same-day birthday appeared only in Coming Up, never Today's Agenda

**Live regression case**: Dr. & Mrs. Yaakov Abdelhak, birthday Aug 19,
observed 2026-08-19 -- showed under Coming Up, not Today's Agenda.

**Root cause: category (C), a Today/Coming-Up classification gap -- NOT a
timezone or recurring-date calculation bug.**
`nextGregorianRecurrence`/`nextYahrtzeitOccurrence`
(lib/calendar/gregorian-recurring-date.ts,
lib/calendar/hebrew-date.ts) already correctly compute a same-day
occurrence's `dateEpoch` as exactly today (verified directly: for
Abdelhak's Aug 19 birthday, `dateEpoch` equals
`localDateOnlyEpoch(now, timezone)` exactly). The bug was purely
downstream: `lib/workspace/live-data.ts` built one combined,
unconditional `upcomingRelationshipDates` list (every yahrtzeit/birthday/
anniversary inside its lead window, regardless of date), and
`app/page.tsx` rendered that list only under Coming Up -- there was no
split for "is this today" anywhere in the pipeline. Today's Agenda itself
never looked at relationship-date events at all.

**Fix.** Added `partitionRelationshipDateEventsByToday()` (pure, in
`lib/workspace/relationship-date-events.ts`) plus a new
`localDateOnlyEpoch(now, timezone)` helper (in
`lib/workspace/local-time.ts`) that computes "today" in the exact same
date-only, UTC-midnight-of-local-date convention
`nextGregorianRecurrence`/`nextYahrtzeitOccurrence` already use
internally -- deliberately NOT `dayKey`/`localDayKey` (those are for
moment-in-time epochs like `occurred_at`/`due_at`; applying them to an
already-date-only `dateEpoch` would re-apply the timezone offset a second
time and silently misclassify a real same-day event in any timezone
behind UTC). `WorkspaceBrief` gained a new `todayRelationshipDates` field;
`app/page.tsx` renders it inside Today's Agenda (reusing the existing
`RelationshipDateEventRow` component, now with a `today` prop controlling
its return-anchor) and includes it in the Today's Agenda count badge.
`upcomingRelationshipDates` (Coming Up) now correctly excludes same-day
events instead of showing them a second time -- no duplication, by
design (the task's own preferred UX: Today's Agenda only, not both).
No persistent recommendation row was manufactured; this is a pure
re-bucketing of the same recomputed date-event data the existing
architecture already produced every request.

**Tests** (`tests/relationship-date-today-bucket.test.mjs`, 10 items):
birthday today (exact Abdelhak regression case, using the real builder
and the real partition function, not a reimplementation); birthday
tomorrow; birthday "yesterday" (the builder itself never produces a past
occurrence -- it recurs next year, outside the lead window, so there's
nothing for the partition to misclassify); a UTC-midnight timezone
boundary case (NOW chosen so raw UTC has already rolled to the next
calendar day while America/New_York is still "today," proving the fix
uses the correct date-only-epoch comparison, not a double timezone
conversion); anniversary (same path, same behavior); yahrtzeit (same
path, same behavior, unaffected outside-window case still produces no
event); no-duplication across both buckets (union recovers the original
list exactly, no id appears in both); plus source-level checks that
`live-data.ts` actually routes through the real partition function and
that Today's Agenda/Coming Up render/exclude the right lists.

**Live verification** (2026-08-19, deployed Worker, real Abdelhak
record): Today's Agenda shows "Aug 19, 2026 -- Dr. & Mrs. Yaakov Abdelhak
(49026) -- Birthday -- Yaakov's birthday · Turning 59" with count badge
"1"; Coming Up starts at Aug 23 (Raphael Nakhon), correctly does NOT
repeat Abdelhak's Aug 19 birthday; age ("Turning 59") is correct; no
duplicate or confusing presentation.

### Bug 2: open-pledge Suggested Action ignored a newly-applied payment

**Live regression case**: pledge KOLX2026 (donor Mr. & Mrs. Yaakov
Zachter, pledge id `ed3e9f11-33a7-4414-9409-217d41d63009`) -- $18,000
committed Jun 18, 2026, $4,500 originally paid; a $1,500 payment applied
Aug 18, 2026 correctly reduced the balance to $13,500 (confirmed in the
timeline as "Payment applied to pledge, Aug 18, 2026"), but Suggested
Action still said `"Follow up on the open $13,500 pledge to KOLX2026."` /
`"No payment activity in 62 days."` / evidence `"...last activity
2026-06-18."` -- silently ignoring the Aug 18 payment.

**Root cause, traced precisely.** `giving_activities` (the pledge's own
row) is updated IN PLACE when a payment is applied
(`paid_cents`/`balance_cents` change), but its `activity_date` column is
never touched -- it stays the original commitment date forever. The
payment's real date lives only in `jl_payment_assignment_audits
.payment_date` (one row per linked payment, `decision_type =
'apply_to_pledge'`, linked via `pledge_activity_id`). All three surfaces
sharing `buildRecommendationEvidence` (Today's homepage,
`app/donors/[id]/page.tsx`, `lib/relationships/meeting-brief.ts`, which
Assistant also reuses via `loadMeetingBrief()`) were reading
`activity_date` straight off the `giving_activities` row into
`openPledge.activityDate` -- never consulting the payment-audit table at
all for this specific evidence field. (The donor page's separate "Most
Recent Paid Gift" KPI already correctly used
`jl_payment_assignment_audits` for a DIFFERENT purpose -- the donor-wide
most-recent-payment display -- which is why that KPI already showed "Aug
18, 2026" correctly even while the pledge-specific evidence stayed
broken; these are not the same computation.)

**Fix.** Added `resolveOpenPledgeActivityDate(pledgeOwnActivityDate,
linkedPaymentDates)` (pure, in `lib/relationships/recommendation-
evidence.ts`, next to the `openPledge` type it directly governs): returns
the max of `linkedPaymentDates` if any exist, else falls back to the
pledge's own `activity_date`. Wired into all three loaders, each scoping
its payment-date lookup to the exact pledge id (never a whole-donor or
whole-account payment list): the donor page reuses its already-fetched
`paymentEvents` array (no new query needed there); `meeting-brief.ts` and
`live-data.ts` each gained one new `jl_payment_assignment_audits` query
(`decision_type = 'apply_to_pledge' AND applied_cents > 0 AND
payment_date IS NOT NULL`), matching the donor page's existing WHERE
clause exactly for consistency.

**No new suppression/threshold policy was invented, and none was
needed.** `followUpPledgeCandidate` (recommendation-candidates.ts) already
derives `ageDays`, `confidence` (`medium` at `ageDays >= 60`, else
`low`), and `urgency` (`clamp01(ageDays / 180)`) purely from
`openPledge.activityDate` -- once that date is correct, the SAME
unmodified formula automatically answers the task's own question C
("score materially lower because payment activity is recent"): ageDays
drops from 62 to 1, confidence drops to `low`, urgency drops to ~0, and
the wording template (unchanged) now produces a truthful sentence ("No
payment activity in 1 days" -- honestly true: no *additional* activity
in the one day since the real payment) instead of the false "62 days."
The candidate remains technically eligible (never suppressed outright) --
for the live Zachter case, a different, legitimately higher-ranked
candidate (`relationship_opportunity`, from an unrelated pre-existing
narrative-text fact) now wins Suggested Action instead, which is exactly
the intended effect of a low-urgency pledge candidate no longer being
falsely inflated by a stale date.

**Tests** (`tests/pledge-payment-recency.test.mjs`, 11 items): no
payments (falls back to original date); one recent payment (the exact
live regression -- ageDays 62→1); several payments (latest always wins,
order-independent); balance/recency stay mutually consistent; unrelated
donor/different-pledge payments cannot leak in (scoped filtering
verified); fully-paid pledge produces no `follow_up_pledge` candidate at
all (pre-existing behavior, confirmed unaffected); an old real payment
still correctly reports a large `ageDays` and remains eligible (this fix
never suppresses a genuinely stale pledge); the exact reported bad
sentence ("No payment activity in 62 days") is asserted absent, the
correct evidence line ("last activity 2026-08-18") is asserted present,
and confidence/urgency are asserted low/near-zero for the just-paid case;
plus source-level cross-surface checks that all three loaders route
through `resolveOpenPledgeActivityDate` (and that none of them still
reads `activity_date` straight onto `activityDate`).

**Live verification** (2026-08-19, deployed Worker, real Zachter/KOLX2026
record, read-only throughout -- confirmed via a direct D1 read
immediately after verification that `giving_activities` for this pledge
is byte-for-byte unchanged: `paid_cents=450000, balance_cents=1350000,
activity_date=1781740800`): donor page shows "Open Commitments: $13,500"
and "Most Recent Paid Gift: $1,500 / Aug 18, 2026" correctly; Suggested
Action does not show the buggy pledge text anywhere (a different
candidate legitimately wins, as expected once the pledge's urgency
correctly dropped); Meeting Brief agrees exactly with the donor page on
balance/lifetime-paid ($13,500 / $45,400) and shows the same Suggested
Action family -- cross-surface consistency confirmed directly, not
assumed.

### Deferred: monthly payment plans (NOT implemented in this task, audit only)

Per explicit instruction, the broader feature ("a donor paying an open
pledge monthly through a known final due date should not continually
surface as requiring follow-up while that plan is current") was not
built. What exists today that a future implementation could build on,
audited while tracing Bug 2:

- `jl_payment_assignment_audits` is already, effectively, a real payment
  ledger per pledge (`pledge_activity_id`, `payment_date`,
  `applied_cents`, `remaining_balance_cents`, one row per linked
  payment) -- a future feature could analyze this history to detect an
  actual recurring cadence, rather than needing a fundraiser to declare
  one from scratch.
- No table anywhere currently stores an explicit "this pledge is on an
  active monthly plan through date X" annotation -- there is no
  `giving_activities` column and no separate table for it, unlike Asks
  (which got dedicated `asks`/`ask_changes` tables). The natural
  precedent this repo already established for "a small, narrow,
  fundraiser-declared local annotation layered on top of JL financial
  data, with its own tiny audit table" is exactly the Ask feature's own
  shape (`docs/ASK-SOLICITATION-DESIGN.md`) -- a future
  `pledge_payment_plans` (+ small audit) table modeled the same way is
  the natural fit, not a new column on `giving_activities` itself
  (JL-imported financial system-of-record data should stay JL-owned).
- The one concrete hook point this fix's own architecture already
  provides: `RecommendationEvidenceInput.openPledge` (recommendation-
  evidence.ts) is exactly where a future `activePaymentPlan: {
  finalDueDate: number; cadenceDays: number } | null` field would be
  added, threaded through the same three loaders `resolveOpenPledgeActivityDate`
  is wired into today (Today, donor page, Meeting Brief/Assistant), and
  consumed by `followUpPledgeCandidate` to suppress or re-score itself
  while `now < finalDueDate` and the plan is being honored -- the exact
  same "add one evidence field, thread it through the three existing
  loaders, let the existing candidate function read it" shape this task's
  own Bug 2 fix and the Ask feature both already used. Not built here;
  flagged as the concrete next step if/when this feature is approved.

## Pledge Payment Plan -- IMPLEMENTED, NOT DEPLOYED (migration not applied, no staging write) (2026-08-20)

Full design report: `docs/PLEDGE-PAYMENT-PLAN-DESIGN.md`. The design below
was fully implemented on this branch in a follow-up task (schema,
migration, API routes, cycle-matching module, evidence/recommendation
wiring, donor-page UI, Meeting Brief line, donor-merge/staging-reset/
workspace-backup/production-baseline guardrail updates, and tests) --
**local commit only, not pushed; migration NOT applied to any D1
database; no data written to staging; KOLX2026 was only read, never
modified.** See "Pledge Payment Plan -- IMPLEMENTATION REPORT" further
below for the full accounting of what was built, tested, and still needs
explicit approval before a staging rollout.

**What this closes.** The smallest coherent feature for marking an open
pledge as being paid on a known schedule, so `follow_up_pledge` stops
surfacing while a donor is paying as expected.

**Status: the overall design is approved.** One material revision was
required and has been made (see below); with that revision, every other
previously-recommended decision (field set, `ended_at` over a status
enum, `giving_activities.id` linkage, monthly-only cadence, fixed 7-day
grace, optional/never-validated installment amount, one-pledge-per-plan,
compact card UX, `follow_up_pledge` becoming plan-aware rather than a new
candidate kind, no JL mutation, no fake giving rows, no automatic
reminders, no general recurrence engine, no cross-donor reporting, no
pipeline/collections architecture, "Payment plan" terminology, the
phased build order) is confirmed and unchanged.

**The revision (REJECTED and corrected):** the original design derived
the next expected payment date as `latest actual payment + ~30 days`.
This was rejected -- it conflates the AGREED/EXPECTED schedule with
ACTUAL payment behavior, so an early or late payment would permanently
drag the schedule off its true anchor day (e.g. expected-18th drifting
toward the 22nd after one late payment). **Corrected model**: EXPECTED
and ACTUAL are now kept strictly separate. A new, required
`expected_day_of_month` field (1-31, auto-derived from the fundraiser's
entered date, not a separate form input) anchors the schedule; a small,
pure `advanceOneCalendarMonth` function (reusing `isLeapYear`, already
exported from `lib/calendar/gregorian-recurring-date.ts`) advances the
expected date one real calendar month at a time, always clamping to the
*fixed* anchor day -- so Feb 28 correctly reverts to Mar 31, never stays
pinned at the 28th. A separate `isCycleSatisfied`/`currentCycleExpectedAt`
walk (bounded, deterministic, amount-blind) decides whether an actual
linked payment satisfies a given expected cycle, using a symmetric
±7-day grace window -- verified computationally (not just asserted) that
a September payment landing on the 22nd still produces `Oct 18` as the
next cycle, never `Oct 22`. Still monthly-only, still no recurrence-rule
string, still no library -- one small (~10-line) advancement function
plus one new schema field, not a general recurrence engine.

**Also reversed: paid-off behavior.** The original design auto-set
`ended_at` when the pledge balance reached zero. **Rejected and
corrected**: `ended_at` now represents only an explicit local
ending/editing action; zero balance is derived financial state and the
two are never conflated. A fully-paid pledge already can't produce a
`follow_up_pledge` candidate at all (structural -- `openPledge` itself
becomes `null` once balance is `<=0`), so no plan mutation was ever
needed for this to work correctly; the plan row is now left exactly as
the fundraiser last left it.

**KOLX2026 worked example (revised)**: walks the real pledge (Zachter,
$13,500 open, $1,500/mo hypothetical plan, expected day 18) through
Aug19 / Sep17 / Sep18 / Sep25 (grace boundary) / Sep26 (late) / Sep22
(within-grace payment) / October (proving the schedule stays anchored to
the 18th, not drifting to the 22nd) / final-date-with-$0 /
final-date-with-balance -- see the design doc's revised "KOLX2026 worked
example" section for the full table.

**Remaining approval needed (historical -- superseded by the implementation
report immediately below)**: the mechanics introduced by this revision were
confirmed during implementation (they are exactly what got built --
`expected_day_of_month`, `advanceOneCalendarMonth`, the symmetric-grace-
window `matchPaymentsToCycles`, and the reversed paid-off behavior). What
is still outstanding is not the design, but the staging rollout itself --
applying the migration and writing the real KOLX2026 plan -- see below.

### Pledge Payment Plan -- IMPLEMENTATION REPORT (2026-08-20)

**Schema.** Two new tables, `pledge_payment_plans` and
`pledge_payment_plan_changes`, added to `db/schema.ts` and captured in
`drizzle/0033_pledge_payment_plans.sql` (hand-written after `drizzle-kit
generate` produced a stale full-schema dump from an out-of-sync local
journal -- the correct incremental `CREATE TABLE`/index DDL was extracted
from inside that dump and reformatted to match this repo's established
migration style; `drizzle/meta/_journal.json` was reverted). Verified via a
standalone `node:sqlite` rehearsal script that all 34 migrations apply
cleanly in order and that the CHECK constraints correctly reject
`expected_day_of_month=32` and `cadence='quarterly'`. `pledge_payment_plans`
columns: `id`, `user_id`, `donor_id`, `pledge_activity_id` (references
`giving_activities.id`), `cadence` ('monthly' only, CHECK-enforced),
`installment_amount_cents` (nullable), `next_expected_payment_at`,
`expected_day_of_month` (1-31, CHECK-enforced), `final_expected_payment_at`,
`note` (nullable), `ended_at` (nullable), `created_at`, `updated_at`. No
`isLate`/`isOnTrack`/`daysLate` columns -- those are always derived, never
stored (see "Cycle-matching algorithm" below). `pledge_payment_plan_changes`
mirrors `ask_changes`'s shape exactly (`action` in
created/updated/ended, `changed_fields`/`before_json`/`after_json`).

**Stable pledge linkage, re-proven.** `pledge_activity_id` points at
`giving_activities.id`. Re-confirmed by inspecting the JL reimport upsert
(`ON CONFLICT(owner_user_id, external_source, source_fingerprint) DO UPDATE
SET paid_cents=...,balance_cents=...,...` -- `id` is never reassigned on
this path) and by re-reading the live KOLX2026 row, unchanged since the
design phase. `source_fingerprint` hashes the pledge's *original*
commitment fields (Code/Due Date/Item Num/Desc/Campaign/Amount/Company);
only a JL correction to one of those fields (rare) would ever produce a new
`giving_activities.id` and orphan a plan -- an accepted, previously-flagged
deferred risk, not a blocker.

**Cycle-matching algorithm, and the critical multi-cycle-satisfaction
fix.** Implemented in `lib/relationships/pledge-payment-plan.ts` (a
deliberate path deviation from the task's suggested
`lib/pledges/payment-plan.ts` -- there is no `lib/pledges/` directory in
this repo; every other pledge-adjacent module already lives under
`lib/relationships/`, so the new module follows that existing convention
instead). Auditing the original design before writing any code confirmed
it WOULD have let one late payment retroactively satisfy several missed
cycles merely because its date was later than all of them. Fixed
structurally, not by convention: `matchPaymentsToCycles()` assigns each
linked payment to at most one expected cycle and each cycle to at most one
payment, via a deterministic greedy match that is provably unambiguous --
monthly cycles are always >=28 days apart (the shortest possible gap, Jan
31 -> Feb 28) and the grace window is only +/-7 days (14 days wide, under
28), so two cycles' windows can never overlap and there is never more than
one valid assignment for any given payment. `evaluatePaymentPlan()` is the
single entry point every caller (donor page, Meeting Brief, Today via
`follow_up_pledge`) uses; it is pure, takes already-fetched facts, and
persists nothing.

**Tests.** `tests/pledge-payment-plan.test.mjs` (new) covers
`advanceOneCalendarMonth` (Jan 31 -> Feb 28 -> Mar 31, leap-year Feb 29),
`matchPaymentsToCycles` (including the exact three-cycles/one-March-payment
scenario proving the fix, and its three-cycles/three-payments counterpart),
the KOLX2026 worked example, and further edge cases. Added to the `test`
script chain in `package.json`. The full existing suite required several
pre-existing pinned-count regression tests to be updated for the two
legitimate new queries this feature adds (not an instrumentation leak, the
same pattern each prior feature followed): `tests/today.test.mjs` (donor
page D1 call-site count 22 -> 23), `tests/workspace-brief-instrumentation
.test.mjs` (`loadWorkspaceBrief` D1 call-site count 17 -> 18), and
`tests/production-baseline.test.mjs` (source-migration count 33 -> 34, plus
a new "baseline picks up the schema-changing 0033" test mirroring the
existing per-migration tests). `pnpm test`: **all tests pass.**
`pnpm exec tsc --noEmit`: **clean.** `pnpm run build:staging-independent`:
**succeeds** (confirmed both `/api/pledge-payment-plans` and
`/api/pledge-payment-plans/:id` are registered in the route manifest).

**Guardrails updated for the two new tables** (no hand-edited generated
files -- `production-baseline/schema-manifest.json` and
`production-baseline/drizzle/0000_production_baseline_0019.sql` were
regenerated via `pnpm run db:baseline:generate -- --write` and rehearsed
via `pnpm run db:baseline:rehearse`, which reports 45 tables and a clean
replay): `lib/data-health/production-baseline.ts`
(`PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length` 33 -> 34),
`lib/operations/staging-reset.ts` (`pledge_payment_plan_changes`/
`pledge_payment_plans` added to `STAGING_RESET_TABLE_ORDER`, deleted before
`donors`/`giving_activities`, same reasoning as `jl_payment_assignment_
audits`), `lib/operations/workspace-backup.ts` (both tables added to
`WORKSPACE_BACKUP_EXCLUDED_TABLES`, same "covered only by the nightly
whole-database R2 backup for now" treatment as `asks`/`ask_changes`), and
`app/api/donors/merge/route.ts` (both tables reassigned to the surviving
donor by `donor_id` on merge, mirroring the `asks`/`ask_changes`
treatment -- `pledge_activity_id` itself never needs to change, since
`giving_activities.id` is stable across a merge and only its own
`donor_id` moves).

**UI.** `app/donors/[id]/PledgePaymentPlanManagement.tsx` (new), mirroring
`AskManagement.tsx`'s exact pattern: a "Set payment plan" button on any
open pledge with no active plan; a compact factual card (Monthly / Next
expected -- the *derived* next-unsatisfied-cycle date, never a possibly-
stale stored value / Final expected / optional installment / an inline
"Expected payment overdue" flag when late) with `[Edit plan]`/`[End plan]`
when one exists. Wired into `app/donors/[id]/page.tsx` as a new "OPEN
PLEDGES" section (live mode only, same placement pattern as the existing
Asks section) rendering one card per open pledge -- not just the single
pledge used for Suggested Action's evidence slot -- so a donor with two
open pledges where only one is on a plan shows two independent cards.
`expected_day_of_month`, internal linkage IDs, and status machinery are
never exposed in this UI. CSS added to `app/globals.css` mirroring the
Asks section's existing visual language exactly (same tokens, same
responsive breakpoint).

**Meeting Brief.** `lib/relationships/meeting-brief-model.ts` gained a
`pledgePlanLine()` formatter (mirroring `askLine`/`familyDateLine`) and a
`MeetingBriefPledgePlanSummary` type; `buildMeetingBrief`'s "Discuss the
open pledge" discussion-topic detail now reads e.g. "Open pledge: $13,500
remaining. Being paid monthly; next expected payment Sep 18." when
on-track, or "...the expected monthly payment appears overdue." when late
-- purely factual, never framed as a collections problem, never claiming
the donor failed to pay when the evidence only proves the expected cycle
is late. Describes the exact same single open pledge already reflected in
Suggested Action, never a second independent read or a donor-wide summary.
`lib/relationships/meeting-brief.ts` threads this through from the same
`recommendationEvidence.giving.openPledge.activePaymentPlan` evaluation
already built for Suggested Action -- no separate computation. Assistant
requires no separate code: it already reuses `loadMeetingBrief()` for the
primary donor, so it picks this up automatically.

**Recommendation engine.** No new candidate kind. `followUpPledgeCandidate`
in `lib/relationships/recommendation-candidates.ts` now branches on
`activePaymentPlan.isOnTrack` (suppressed -- returns null),
`.isLate` (plan-aware wording, e.g. "Check in on the $13,500 pledge
payment plan." / "Expected monthly payment is overdue."),
`.isPlanEndedWithBalance` (e.g. "Follow up on the remaining $3,000 after
the payment plan end date."), or falls through unchanged to the original
age-based logic when there is no active plan.

**Explicitly NOT done in this task** (stopped here per the task's own
instructions): the migration has NOT been applied to any D1 database
(local, staging, or production); no payment plan has been written for the
real KOLX2026 pledge on staging; nothing has been pushed to
`origin/feature/independent-cloudflare-sandbox`; nothing has been deployed.
Also not attempted: true narrow-viewport/mobile rendering verification
(same tooling limitation noted in earlier tasks this session -- do not
treat the responsive CSS above as a substitute for actually having
verified it on a phone-width viewport).

**Files changed** (local working tree, `feature/independent-cloudflare-
sandbox`, not yet committed as of this report): `db/schema.ts`,
`drizzle/0033_pledge_payment_plans.sql` (new),
`lib/relationships/pledge-payment-plan.ts` (new),
`lib/capture/pledge-payment-plan.ts` (new),
`app/api/pledge-payment-plans/route.ts` (new),
`app/api/pledge-payment-plans/[id]/route.ts` (new),
`app/donors/[id]/PledgePaymentPlanManagement.tsx` (new),
`app/donors/[id]/page.tsx`, `app/globals.css`,
`lib/relationships/recommendation-evidence.ts`,
`lib/relationships/recommendation-candidates.ts`,
`lib/workspace/live-data.ts`, `lib/relationships/meeting-brief.ts`,
`lib/relationships/meeting-brief-model.ts`,
`app/api/donors/merge/route.ts`, `lib/operations/staging-reset.ts`,
`lib/operations/workspace-backup.ts`,
`lib/data-health/production-baseline.ts`,
`production-baseline/schema-manifest.json` (regenerated),
`production-baseline/drizzle/0000_production_baseline_0019.sql`
(regenerated), `tests/pledge-payment-plan.test.mjs` (new),
`tests/today.test.mjs`, `tests/workspace-brief-instrumentation.test.mjs`,
`tests/production-baseline.test.mjs`, `package.json`, this file.

**Proposed KOLX2026 staging values (NOT yet written -- for approval only)**:
pledge activity is the real Zachter KOLX2026 row, $13,500 open balance.
Proposed plan: cadence monthly, installment amount $1,500 (descriptive
only), next expected payment 2026-09-18 (`expected_day_of_month` derives to
18), final expected payment 2027-05-18 (matches the $13,500 balance at
$1,500/mo over 9 installments), no note. These are illustrative/documented
test values consistent with the design doc's own KOLX2026 worked example,
not yet applied to any database.

**Exact approval needed to proceed**: (1) apply
`drizzle/0033_pledge_payment_plans.sql` to the Independent Staging D1
database; (2) write the proposed KOLX2026 plan above via the real UI (not
a direct D1 insert) as live staging acceptance verification; (3) commit
this working tree and push to `origin/feature/independent-cloudflare-
sandbox`; (4) deploy to Independent Staging. None of these four steps have
been taken.

## Pledge Payment Plan -- LIVE ROLLOUT VERIFICATION (Independent Staging, 2026-08-20)

Controlled rollout of the implementation above, approved and executed
end to end against real staging data using the actual deployed UI/API
(not synthetic/mocked calls). Production was never touched.

**Migration.** `drizzle/0033_pledge_payment_plans.sql` applied via
`wrangler d1 execute fundraising-os-staging-db --remote --config
wrangler.staging.jsonc --file ...`. Verified via `--command` mode (not
the unreliable `--file` JSON summary, per this repo's established
practice): both `pledge_payment_plans` and `pledge_payment_plan_changes`
exist with DDL byte-for-byte identical to the migration file (CHECK
constraints, both FKs, both indexes `pledge_payment_plans_pledge_idx`/
`pledge_payment_plan_changes_plan_idx` all present); pre-existing table
row counts unchanged before/after (`giving_activities` 5176,
`jl_payment_assignment_audits` 19, `gifts` 0, `donors` 248, both times).

**A real bug found and fixed during rollout.** After creating the real
plan through the UI, the donor page displayed "Next expected: Sep 17,
2026" / "Final expected: May 17, 2027" -- one day EARLIER than the
approved Sep 18/May 18 values. Stopped and investigated before treating
verification as complete. Root cause, confirmed by reading the stored
row directly in D1: `next_expected_payment_at`/`final_expected_payment_at`
were stored exactly correctly (Sep 18 2026 / May 18 2027, UTC midnight)
-- this was a **display-only** bug, not a data-integrity problem.
`app/donors/[id]/PledgePaymentPlanManagement.tsx`'s local `dateLabel`
helper formatted these UTC-midnight date-only epochs with
`Intl.DateTimeFormat` and no `timeZone` specified, so it silently fell
back to the browser's local timezone -- for any timezone west of UTC, a
UTC-midnight epoch always displays as the previous calendar day. The
exact same bug was independently present in
`lib/relationships/meeting-brief.ts`'s `openPledgePlanSummary` construction
(it reused the fundraiser-timezone-aware `dateLabel`, correct for
recurrence dates like birthdays but wrong for a UTC-midnight financial
date). Both fixed by switching to `financialDateLabel` (the
`timeZone: "UTC"`-pinned helper every other financial date in this app
already uses, from `lib/financial-date.ts`) -- commit `0f75ad0`. Re-ran
`pnpm test`/`tsc --noEmit`/`pnpm run build:staging-independent` (all
clean), pushed, redeployed, and reconfirmed the donor page now correctly
reads "Next expected: Sep 18, 2026" / "Final expected: May 18, 2027".

**Deploy.** Two deployments this task: an initial one at commit `f474d1d`
(Worker version `831f319f-89b6-4cb0-bdea-74e428311419`, 2026-08-20T04:31:58Z)
before the display bug was caught, and the corrected one at commit
`0f75ad0` (Worker version `1875be3f-392f-4b74-835a-8270a9d1f84a`,
2026-08-20T04:38:18.759Z) after the fix -- this second version is the one
the real KOLX2026 plan was created under and is the one currently live.
Both via `pnpm run deploy:staging-independent`
(`wrangler deploy --config wrangler.staging.jsonc`), confirmed live both
via the deploy output and an independent `wrangler deployments list`
check. URL: `https://fundraising-os-staging.sgoldstein.workers.dev`.

**KOLX2026 before/after financial values (proving JL/financial data was
never touched).** Pledge: `giving_activities.id =
ed3e9f11-33a7-4414-9409-217d41d63009` (donor: Mr. & Mrs. Yaakov Zachter,
`donor_id = 19af69d6-f147-474b-88ad-f6358ff65b9a`, campaign KOLX2026).
Read immediately before any write: `paid_cents=450000` ($4,500),
`balance_cents=1350000` ($13,500), latest linked payment (
`jl_payment_assignment_audits`) Aug 18, 2026 for $1,500 -- exactly
matching the values the approval was based on, no drift. Read again
after migration, after plan creation, after the edit-path test, and
after the note revert: `paid_cents`/`balance_cents`/`updated_at` on the
`giving_activities` row **never changed** (`updated_at` stayed at
2026-08-19T16:49:47Z throughout, predating every write this task made by
~12 hours), the linked-payment count for this pledge stayed at exactly 1,
and every whole-database row count (`giving_activities`,
`jl_payment_assignment_audits`, `gifts`, `donors`) stayed identical at
every checkpoint.

**Exact plan created (through the real "Set payment plan" UI, not a
direct D1 insert).** Cadence monthly, installment amount $1,500
(150000 cents), next expected payment 2026-09-18, final expected payment
2027-05-18, no note. `pledge_payment_plans` row `id =
5050be0a-5505-4a67-9c78-73c20275e277`: `expected_day_of_month` correctly
auto-derived as `18` from the entered date (never a separate input,
never exposed in the UI); `pledge_activity_id` correctly points at the
verified pledge; `donor_id`/`user_id` correctly scoped; `ended_at IS
NULL`. Exactly one `pledge_payment_plans` row exists for this pledge at
every checkpoint -- no duplicate ever created, including after the
edit-path test below.

**Audit trail.** `pledge_payment_plan_changes` holds exactly 3 rows for
this plan, in order: `created` (the initial plan, `changed_fields`
covering all 5 populated fields), `updated` (`changed_fields=["note"]`,
the harmless edit-path verification test below), `updated`
(`changed_fields=["note"]`, reverting the note back to null). No
`ended` row -- the real plan was deliberately never ended as part of
testing, per the approved rollout plan (end-plan behavior is already
covered by the automated test suite).

**follow_up_pledge suppression -- proven structurally, not just by
ranking.** Built a one-off script (run locally, then deleted -- never
committed) that fed the exact real staging values (the plan's stored
fields, `linkedPaymentDates=[Aug 18, 2026]`, `balanceCents=1,350,000`,
real `now`) through the actual `buildRecommendationEvidence` +
`generateCandidates` functions from the committed module (not a
reimplementation). Result: `activePaymentPlan.isOnTrack: true`,
`isLate: false`, and `generateCandidates` returned only
`['reconnect_contact_gap']` -- **no `follow_up_pledge` candidate is
generated at all** for this donor, not merely outranked by something
else. This matches the donor page's real "Suggested Action" ("Review
before next outreach," an unrelated `reconnect_contact_gap`
recommendation) and confirms the candidate itself is suppressed.

**Donor-page verification.** `$13,500` open commitment still shown; a
new "OPEN PLEDGES" section (live-mode only, one card per open pledge)
renders the KOLX2026 pledge with a "PAYMENT PLAN" block: "Monthly / Next
expected: Sep 18, 2026 / Final expected: May 18, 2027 / Expected
installment: $1,500 / [Edit plan] [End plan]" -- confirming "Set payment
plan" correctly became "Edit plan"/"End plan" once a plan exists.
`expected_day_of_month`, the plan id, and any other internal linkage are
never exposed in this UI.

**Meeting Brief verification.** The real donor's Meeting Brief
("Suggested Preparation" -> "Discuss the open pledge") reads: "Open
pledge: $13,500 remaining. Being paid monthly; next expected payment
Sep 18, 2026." -- truthful, correctly dated (post-fix), never implies
the pledge is paid off, never framed as a collections problem.

**Assistant-context verification -- code path confirmed, live exercise
not achieved this session (honest limitation, not a failure).**
`app/api/assistant/route.ts` (line ~40) calls the exact same
`loadMeetingBrief()` already verified correct above, and threads
`primaryMeetingBrief.recommendation` into the Assistant's context
snapshot -- so by construction it can never disagree with the Meeting
Brief/donor page for the same donor, and no separate Assistant-specific
payment-plan code exists (as designed -- scope was not broadened).
However, tracing `lib/ai/rule-based.ts` shows `snapshot.donor.recommendation`
is only surfaced in the `meeting-brief` task's response text, which is
itself gated on an upcoming dated meeting reminder existing for some
donor (`s.meetings[0]`) -- none exists in this workspace right now, and
Zachter is not currently the workspace's auto-selected "primary donor"
(`brief.priorities[0]`/`brief.gifts[0]`) either. The Assistant API has no
donor-selection input by design. Rather than create a synthetic meeting
reminder or add a donor-selection parameter just to force this specific
check -- either of which would be scope creep beyond what was approved --
this was left as a verified-by-code-inspection-only item. If a live
Assistant exercise for this exact donor is wanted, the natural trigger is
a real dated meeting reminder for Zachter, which would also be genuine
product usage rather than test scaffolding.

**Mobile/narrow-viewport verification -- not achieved (known tooling
limitation, same as prior tasks this session).** `resize_window` to
390x844 reported success, but the rendered page continued showing the
full desktop layout (sidebar nav, no reflow), and a subsequent `zoom`
screenshot attempt timed out. Did not claim mobile verification that
didn't actually happen. The responsive CSS added in the implementation
(`app/globals.css`) mirrors the Asks section's existing breakpoint
exactly, by construction, but that is a code-review claim, not a
verified rendering claim.

**Edit-path test.** Used the real "Edit plan" UI to add a temporary note
("Staging edit-path verification test note (2026-08-20)"), verified via
D1 that exactly the `note` field changed (`changed_fields=["note"]`,
every financial/schedule field byte-identical before and after,
`giving_activities` untouched, no duplicate plan row), then used the same
UI to clear the note back to blank, matching the approved value exactly.
Final state: `note IS NULL`, matching the original approval.

**End Plan was deliberately never exercised against the real plan** --
per the approved rollout instructions, since automated tests already
cover it and doing so on the real KOLX2026 plan would create
unnecessary audit noise / temporarily alter live recommendation
behavior. The real plan remains active (`ended_at IS NULL`) after this
task.

**Final quality gates.** Re-ran after the display-bug fix (the only code
change made during rollout): `pnpm test` -- all pass; `pnpm exec tsc
--noEmit` -- clean; `pnpm run build:staging-independent` -- succeeds.
Nothing changed in the committed tree after that point (git status clean,
local HEAD `0f75ad0` == `origin/feature/independent-cloudflare-sandbox`
HEAD, `origin/main` unchanged at `4ea1d5e` -- all reconfirmed via a fresh
fetch at the end of this task).

**Production**: never touched at any point in this task -- no D1 write,
no deploy, no code change to any production-pointing config.

## Independent Staging Incident -- Error 1102 (2026-08-20 15:44:12 UTC / 11:44:12 EDT) -- INFRASTRUCTURE-LIMIT AUDIT ONLY, NO FIX/CHANGE APPLIED

Ray ID `a2e2849e1fdc23dd`. Investigated per explicit instruction to determine
whether repeated 1102s are an account/plan CPU-ceiling problem rather than
solely an application defect -- no application code change, no deploy, no
D1 write, no billing/plan change. All findings below are read directly from
the Cloudflare dashboard (Workers plans page, the Worker's Settings page,
and Observability event records for this exact Ray ID), not carried over
from memory or from prior incidents.

**1. Workers plan: FREE, verified via the dashboard's own "Current plan"
badge** (`dash.cloudflare.com/2f34086b78ac8643498a1a600b846757/workers/plans`
-- Free tier card is explicitly marked "Current plan"). Not inferred.

**2-5. CPU limit.** The plan page's own published Free-tier row: **100,000
requests/day, up to 10 ms CPU time per request, 10 ms max CPU time per
invocation.** `wrangler.staging.jsonc` (read directly, reproduced in full in
the "Deployment State" section) contains **no `limits.cpu_ms` key at all**
-- no override configured. The Worker's own Settings page in the dashboard
(`workers/services/view/fundraising-os-staging/production/settings`) has
**no "Limits"/CPU-ms configuration section at all** -- confirming this is
not user-adjustable on Free (that section only exists on Paid); the
effective ceiling is simply the Free-plan platform default itself, and
nothing is set lower than that default.

**6. Memory limit.** 128 MB, per Cloudflare's platform-wide Workers isolate
memory ceiling (same on Free and Paid -- not itself a line item on the
Workers plans page, which prices compute/requests/storage, not the fixed
runtime memory ceiling). Not relevant to this specific incident (see below).

**7. Has this Worker ever used >10 ms CPU on an ordinary, successful
request? Yes, repeatedly, already documented in this file before today.**
The 2026-08-19 dedup-fix verification table above (`## Independent Staging
Duplicate-Loader Fix`) recorded 5 real, ordinary Today-page navigations,
none of them a stress test, none intentionally provoking a 1102:
70, 79, 85, 94, and 223 ms CPU, **all `"outcome":"ok"`, HTTP 200** -- i.e.
7-22x the Free-tier's published 10 ms ceiling, succeeding. The
instrumentation table before that recorded 141-242 ms CPU, also all
successful. This is not new evidence manufactured for this audit; it was
already sitting in this document.

**Incident detail -- Ray `a2e2849e1fdc23dd`, read directly from the
Observability event record:**

| Field | Value |
|---|---|
| Route | `GET /?priorities=all` (Today/workspace-brief route, "coming-up-queue" expanded view -- same `loadWorkspaceBrief()` path as bare `/`) |
| Referer | a donor page, navigating back to the queue (`from=%2F%3Fpriorities%3Dall%23coming-up-queue&origin=queue`) -- a real user click, not a prefetch or automated probe |
| `outcome` | `"exceededCpu"` |
| `cpuTimeMs` | **68** |
| `wallTimeMs` | 201 |
| `response.status` | 503 |
| `scriptVersion.id` | `1875be3f-392f-4b74-835a-8270a9d1f84a` -- the exact Worker version live at the end of today's payment-plan rollout (see above); includes the dedup fix (`eec5266`, live since 2026-08-19) |
| `requestId` / `traceId` | `7770000e34da0f538867c1467bbcd157` / `a501b9f06190c5b37cfbd3c93d9501de` |
| Separate runtime log line | `"Worker exceeded CPU time limit."`, same timestamp |

**Nearby traffic (11:39:16-11:44:12 EDT window, same Worker, pulled with no
filter applied).** A real, single-user session: five separate
`pledge_payment_plan_created` events (11:39:45, 11:41:43, 11:42:47,
11:43:40, 11:44:09 EDT -- someone exploring the newly-rolled-out payment-
plan feature after this task's own rollout finished, not this task's own
KOLX2026 write), interleaved with `donor_page_render` and repeated
`GET /?priorities=all` navigations. **No burst, no concurrency**: the
failing request is the only event at its timestamp, and the identical
route succeeded (`workspace_brief_render` logged, no error) at 11:39:17,
11:39:48, 11:41:52, 11:43:05, and 11:43:42 EDT -- four times in the same
five minutes, immediately before and after the failure. This rules out
mechanism (D) (concurrent contention) exactly as the prior 16:59:03
incident did (see below) -- this is again mechanism (C), a single ordinary
request that happened to exceed CPU on its own.

**Comparison with prior 1102 (`a2dab4de9e40be78`, 2026-08-19 16:59:03
UTC, documented above).**

| | Prior (`a2dab4de9e40be78`) | New (`a2e2849e1fdc23dd`) |
|---|---|---|
| Route | `GET /` | `GET /?priorities=all` (same underlying loader) |
| `cpuTimeMs` | 163 | **68** |
| `wallTimeMs` | 517 | 201 |
| `scriptVersion` | `f5c3430d` (before the dedup fix) | `1875be3f` (after the dedup fix, and after today's payment-plan feature) |
| Burst? | No -- single failing request | No -- single failing request |

**The most important new finding: this incident's kill threshold (68 ms) is
lower than several already-documented SUCCESSFUL requests on the identical
route** (85, 94, 141, 152, 223, 242 ms all previously succeeded, tabulated
above in this same file). That is not consistent with a simple "any
request over some fixed cpuTimeMs number fails" rule -- it indicates the
account is not reliably operating below its ordinary budget on Free at
all, to the point that individual request outcomes vary independent of
their own measured cost. The dedup fix (`eec5266`) cut typical cost by
roughly 40-65% and is confirmed still live in the version that failed here
(`1875be3f` descends from it) -- and a request still got killed, at a cost
lower than several that didn't.

**CRITICAL DECISION: (A) Free-plan ceiling is fundamentally too low for
this SSR app. Recommend Workers Paid.** Ordinary, successful requests on
this exact route have repeatedly cost 70-242 ms of CPU -- 7-24x the
Free-tier's published 10 ms ceiling -- even after a proven, deployed
optimization (the dedup fix) materially reduced typical cost. This new
incident's failure occurred at a cost (68 ms) below several prior
successes on the same route, meaning the account isn't cleanly separated
into "under budget, succeeds" vs. "over budget, fails" on Free -- it's
chronically over Free's intended envelope for this app's ordinary
render path, with individual requests surviving or not somewhat
inconsistently. This is `exceededCpu`, not `exceededMemory` -- **not**
option D; the 128 MB memory ceiling is not implicated and a plan upgrade
does not change it regardless. Workers Paid's default 30-second (up to
5-minute, configurable) per-invocation CPU ceiling would remove this
entire failure class outright for a route whose own instrumented internal
phases alone (D1 query fan-out) already run 53-67 ms per loader call, before
counting the ~200-700 ms of wall time (and unknown CPU) this file's prior
instrumentation task documented as still unattributed outside
`loadWorkspaceBrief()` (auth/session resolution, RSC render/serialization).

**Is code optimization still needed after an upgrade? Yes.** A plan
upgrade removes the acute failure risk but does not address two open
items already on record in this file: (1) the cold-start request still
doesn't reliably dedupe (`## Independent Staging Duplicate-Loader Fix`,
"What remains unproven / open" #1), so the single most expensive case
(223 ms observed) is unresolved; (2) a large share of each request's
wall time and CPU time happens outside `loadWorkspaceBrief()` entirely
and remains uninstrumented (#3, same section). Neither is blocking once
on Paid, but both are still worth pursuing as non-urgent follow-ups --
this audit did not investigate or fix either.

**Estimated minimum plan/cost.** Workers Paid: **$5/month base
subscription** + usage-based overage beyond included quotas (10M
requests/month included, then $0.30/million; CPU $0.02/million ms beyond
included; per-invocation CPU ceiling default 30 s, configurable up to 5
min) -- read directly off the same Workers plans page. This is a
low-traffic, single-owner staging environment (231 events in the hour
surrounding this incident, 2 errors); expected usage should stay at or
very near the $5/month base with negligible overage, though this is an
estimate from observed traffic volume, not a Cloudflare-quoted figure.

**Exact approval needed next.** Explicit authorization to upgrade this
Cloudflare account (`2f34086b78ac8643498a1a600b846757`,
"Sgoldstein@nirc.edu's Account") from Workers Free to Workers Paid ($5/mo
base + usage) -- **not performed in this task**, per explicit instruction
to stop before any billing/plan/config change. Alternatively, if the
decision is to stay on Free, the next approval needed would instead be
for a further CPU-optimization task (the two open items above), which
would reduce but -- per this file's own prior caveat -- not provably
eliminate 1102 risk on Free, since the account is already over budget for
this route's ordinary cost even after the last optimization pass.

**Proven vs. inference, explicitly.** PROVEN: account plan (dashboard's
own "Current plan" badge), no `limits.cpu_ms` override in config or in the
dashboard, this incident's route/outcome/cpu/wall/version/no-burst facts
(read directly off the event record and surrounding log window), that
ordinary successful requests on this same route have repeatedly exceeded
Free's published 10 ms ceiling (already-documented historical table, not
re-measured today), that this incident is CPU- not memory-bound.
INFERRED: the exact dollar cost of upgrading (Cloudflare's own usage-based
overage isn't predictable from 5 samples of traffic); that Paid would
fully eliminate 1102 risk for this route (very likely given the 3000x
higher default ceiling relative to this route's own measured cost, but
not something that can be proven without actually being on Paid).

## Independent Staging Incident -- Error 1102 -- POST-UPGRADE VERIFICATION (Workers Paid, 2026-08-20) -- VERIFICATION ONLY, NO CODE/CONFIG/DEPLOY CHANGE

The user purchased and activated Workers Paid on this account following the
infrastructure-limit audit above. This section verifies the upgrade landed
and re-exercises the exact workload that previously failed -- no
application code change, no wrangler/config change, no D1 write, no
redeploy, no CPU-limit change performed in this task.

**Plan verified: Workers Paid, confirmed on the dashboard, not assumed.**
`dash.cloudflare.com/2f34086b78ac8643498a1a600b846757/workers/plans` now
shows **"Current plan" on the Paid tier** (Free shows "Downgrade" instead).
Published Paid ceiling, same page: **5 min max CPU time per invocation**
(vs. Free's 10 ms).

**Effective CPU limit for this Worker: still unset (platform default
applies), verified on the dashboard.** The Worker's own Settings page
(`.../fundraising-os-staging/production/settings`) now shows a "Pricing"
section with a **"CPU Time Limit (ms)" field that only exists on Paid** --
confirmed empty (placeholder `--`), matching `wrangler.staging.jsonc`
having no `limits.cpu_ms` (re-read directly, unchanged). No explicit
override was set at any point -- the Worker runs under Paid's platform
default (published as 30 s, up to 5 min configurable) purely because the
account's plan changed, not because of any config edit here.

**Deployed Worker version confirmed unchanged.** `wrangler deployments
list --config wrangler.staging.jsonc` (read-only) still shows
`1875be3f-392f-4b74-835a-8270a9d1f84a` (created 2026-08-20T04:38:18.759Z)
as the most recent/live version -- **no deployment has occurred since**,
before or after this verification task ran. This is the same version that
produced the `exceededCpu` failure at 11:44:12 UTC, so any change in
outcome is attributable only to the plan upgrade, not to a masked code fix.

**Workload exercised: 8 real browser navigations, Independent Staging,
2026-08-20 ~12:18:50-12:20:13 EDT (16:18:50-16:20:13 UTC).** Real
authenticated navigations (not a script/load test): 5x `GET
/?priorities=all` (the exact route and query string that failed
pre-upgrade), interleaved with 3x real donor-page visits from the Coming
Up list, mirroring the donor-page/queue-return cycle seen in both prior
1102 incidents. Ray-ID-correlated directly from each event's own
Observability record, not inferred from timestamp proximity:

| # | Time (EDT) | Ray ID | `outcome` | `cpuTimeMs` | `wallTimeMs` | `response.status` | `scriptVersion` |
|---|---|---|---|---|---|---|---|
| 1 (cold start -- first request of this exercise) | 12:18:50.523 | `a2e2b7542bfc8c23` | **ok** | 354 | 1141 | 200 | `1875be3f-...` |
| 2 | 12:19:09.181 | `a2e2b7cbdfe48c23` | **ok** | 322 | 809 | 200 | `1875be3f-...` |
| 3 | 12:19:30.933 | `a2e2b8545f828c23` | **ok** | 221 | 626 | 200 | `1875be3f-...` |
| 4 | 12:19:53.936 | `a2e2b8e41bcd8c23` | **ok** | 224 | 636 | 200 | `1875be3f-...` |
| 5 | 12:20:13.489 | `a2e2b95e38cd8c23` | **ok** | 226 | 639 | 200 | `1875be3f-...` |

All 3 interleaved donor-page navigations (`GET /donors/...`) and their
`donor_page_render` events logged at `level: "info"` throughout, with zero
`error`-level events anywhere in this exercise. The Observability panel's
own rolled-up count for the surrounding hour read **279 Success, 2
Errors** -- both errors are the single pre-upgrade `a2e2849e1fdc23dd`
event (11:44:12 UTC, before the upgrade); **zero new errors, zero new
`exceededCpu`, zero new 1102, zero new 5xx of any kind** appeared across
all 8 navigations exercised after the upgrade.

**Before vs. after, explicitly, and not attributed to reduced computation
per instruction.** Every one of today's 5 post-upgrade samples
(221-354 ms CPU) cost **more** CPU than the incident's own 68 ms kill, and
sample #1 (354 ms) and #2 (322 ms) both exceed every successful pre-upgrade
sample on record in this file (85-242 ms). **This is the load-bearing
evidence for this verification: the application's own computational cost
did not go down** -- if anything today's sample skews slightly higher,
consistent with ordinary request-to-request variance already documented
above, not with any code change (none was made; `scriptVersion` is
identical). What changed is that a 221-354 ms request, which would have
had a real chance of being killed under Free's ~10 ms/inconsistent
enforcement (recall: the 68 ms kill was *lower* than several pre-upgrade
successes), now completes without incident under Paid's much higher
ceiling. The reduction in failures is attributable to the raised ceiling,
not to lower application cost -- exactly the distinction the task asked
this verification to preserve.

**Cold-start note, consistent with (not new proof of) the existing open
item.** Sample #1, the first request of this exercise (a cold isolate),
cost the most CPU (354 ms) and wall time (1141 ms) of the five -- the same
pattern already on record in this file's "Duplicate-Loader Fix" section
(cold starts costing more, and not reliably deduping). This verification
did not re-instrument or re-diagnose that gap; it is simply consistent
with it still being present.

**Can the 1102 infrastructure-limit incident be closed? Yes.** The
specific failure mode investigated (`exceededCpu` on `GET
/?priorities=all` / the Today loader, caused by Free's ~10 ms ceiling
being incompatible with this route's ordinary 70-354 ms cost) has been
verified resolved at the infrastructure level: same code, same Worker
version, higher observed CPU costs than the original failure, zero
failures post-upgrade. There is no more diagnostic value in continuing to
treat ordinary CPU usage on this route as an application defect requiring
a fix before the account can be trusted -- the ceiling that made it a
defect is gone.

**What remains explicitly OPEN, not closed by this verification** (per
instruction to keep these separate):
1. **Cold-start dedup gap** (`## Independent Staging Duplicate-Loader
   Fix`, "What remains unproven / open" #1) -- still unresolved; today's
   cold-start sample is consistent with it still being present, not proof
   either way since no dedup-specific instrumentation was read here.
2. **Uninstrumented wall-time/CPU-time remainder outside
   `loadWorkspaceBrief()`** (same section, #3) -- still unattributed; a
   639 ms wall time against ~60-70 ms of instrumented loader phases (per
   the existing `workspace_brief_phase` telemetry) still leaves most of
   each request's cost unexplained.

Neither is urgent now that the ceiling risk is gone, but both remain
legitimate, separate performance-quality work if the user wants to pursue
them later -- no approval was sought or needed to leave them open, per
instruction.

**Proven vs. inference, explicitly.** PROVEN: account plan (dashboard's
own "Current plan" badge, moved from Free to Paid), no CPU-limit override
configured before or after the upgrade (Settings page field empty,
`wrangler.staging.jsonc` unchanged), deployed Worker version unchanged
(`wrangler deployments list`), all 5 sampled requests' exact
outcome/cpu/wall/status/version (read directly off each event record), no
new errors of any kind across all 8 navigations exercised. INFERRED:
that Paid's *effective* per-invocation ceiling is exactly the documented
30 s default (the dashboard does not expose the live numeric ceiling when
no override is set; inferred from the empty override field plus
Cloudflare's own published default, not read as a literal number).

**No approval needed to close this incident** -- per instruction, closing
it is a reporting action, not a code/config/deploy change. Any future
optimization work on the two open items above would need its own separate
approval before implementation, as already noted in the audit section
above.

## Payment-Plan Editor Layout Fix -- Overflowing Its Pledge Card (Independent Staging, 2026-08-20)

Unrelated to the 1102/infrastructure work above -- a UI/CSS bug report:
the payment-plan editor (Set/Edit) rendered wider than its own pledge
card, reproducible even with exactly one open pledge. Presentation-only
fix, per explicit instruction: no changes to
`PledgePaymentPlanManagement.tsx`, the `/api/pledge-payment-plans*`
routes, cadence/grace/cycle-matching logic, D1 schema, or any migration.

**Root cause, confirmed by inspection of `app/globals.css` before any
edit, not guessed.** Two compounding CSS gaps:
1. `.open-pledge-plan-list { grid-template-columns: repeat(auto-fill,
   minmax(240px, 1fr)); }` lays out as many 240px+ tracks as the row's
   width allows *regardless of how many grid items actually exist* --
   with a single open pledge, the lone `.open-pledge-plan-row` only
   occupies the first track (~240-300px), not the full row, even on a
   wide screen.
2. `.payment-plan-fields input, .payment-plan-fields textarea` had no
   `width` rule at all, so every field rendered at its browser-default
   intrinsic width (a `<input type="date">`/currency input/`<textarea>`
   each want on the order of 150-250px unconstrained). Combined with CSS
   Grid's default `min-width: auto` on both `.payment-plan-fields`'s
   `1fr` columns and their `label` grid items (neither had `min-width:
   0`), the two-column fields grid's own minimum computed width floored
   at roughly 2x that per-field default plus gap -- comfortably wider
   than the ~240-300px card from (1), with nothing in the ancestor chain
   clipping or shrinking it. Result: the form visually escaped the card
   border exactly as reported ("Installment amount extends beyond the
   right edge", "Note textarea extends far outside the card").

**Fix -- `app/globals.css` only, 6 rule changes, no new selectors beyond
one:**
- `.open-pledge-plan-row:has(.payment-plan-form) { grid-column: 1 / -1;
  }` (new rule) -- while a card is actively showing the payment-plan
  form (Set or Edit -- both render the same `PlanForm`, same
  `payment-plan-form` class), it spans every auto-fill track in the row,
  so the form gets real width. Compact view-mode and no-plan-yet cards
  are untouched -- `:has()` only matches while the form is actually
  present, so this is derived purely from DOM structure with zero
  component/state changes and zero residual class after Cancel.
- `min-width: 0` added to `.open-pledge-plan-row`, `.payment-plan-fields`,
  and `.payment-plan-fields label` -- overrides the CSS Grid default
  `min-width: auto` at each level so columns can actually shrink to the
  card's real width instead of being floored by unconstrained field
  widths.
- `width: 100%; max-width: 100%; box-sizing: border-box;` added to
  `.payment-plan-fields input, .payment-plan-fields textarea` -- the
  actual containment guarantee: every field (Cadence's disabled input,
  Installment amount, both date inputs, the Note textarea -- there is no
  `<select>` in this form) is now bound to its parent's width, never its
  own browser-default intrinsic size.
- `max-width: 100%` added to `.open-pledge-plan-row` and
  `.payment-plan-form` as a defensive belt-and-suspenders constraint.
- The pre-existing `@media (max-width:700px)` breakpoint (already
  collapsing both grids to one column) was **not modified** -- the fix
  doesn't interact with it; `grid-column: 1 / -1` on an already-1-column
  list is a no-op there.

**Files changed:** `app/globals.css` (the fix), `tests/pledge-payment-plan-layout.test.mjs` (new regression test), `package.json` (wired the new test into the `test` script chain). `PledgePaymentPlanManagement.tsx` and `app/donors/[id]/page.tsx` were read but **not modified** -- confirmed no genuine component-state issue existed; this was a pure CSS/layout problem.

**Tests.** New `tests/pledge-payment-plan-layout.test.mjs` (structural/
guardrail style, matching this repo's existing convention for CSS/JSX
facts that can't be expressed as computed-value unit tests, e.g.
`nav-link-prefetch.test.mjs`) -- reads `app/globals.css`,
`PledgePaymentPlanManagement.tsx`, and `page.tsx` as text and asserts:
Set/Edit both open `PlanForm` and Cancel returns to view mode; both
share the `payment-plan-form` class the CSS fix keys off of; the
`:has()` span rule, `min-width: 0`, and `width: 100%`/`max-width: 100%`/
`box-sizing: border-box` rules are all present; multiple pledges still
render independent `open-pledge-plan-row`s under the unchanged
`auto-fill` grid; the POST/PATCH request body shapes and the `{ ended:
true }` End Plan body are byte-identical to before; `expected_day_of_month`
is never referenced as an actual field/prop (only in the file's own
pre-existing explanatory comment); the component still imports nothing
from `lib/relationships/pledge-payment-plan.ts`. `pnpm test` (all
tests, this one included), `pnpm exec tsc --noEmit`, and `pnpm run
build:staging-independent` all passed (exit 0) before commit.

**Commit:** `1605f76` ("Fix payment-plan editor overflowing its pledge
card (CSS layout only)"), pushed to
`origin/feature/independent-cloudflare-sandbox` (fast-forward,
`9563efe..1605f76`, fetch-checked immediately before push -- no
concurrent movement). `origin/main` unchanged throughout
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`).

**Deployed:** `pnpm run deploy:staging-independent` ->
`wrangler deploy --config wrangler.staging.jsonc`. Worker version
`b5357707-2d49-47a3-a1af-d3849b26f9a3`. Only 1 asset changed on upload
(`/assets/index-*.css`) -- confirms the deployed change is exactly the
CSS fix, nothing else.

**Live verification, Independent Staging, real donor records, no
writes.**
- **Single-pledge case (the exact reported repro):** Mr. & Mrs. Daniel
  Stein, DIN2025, $144, an existing plan (Monthly / $36 / next Aug 30
  2026 / final Nov 30 2026). Clicked Edit plan. Confirmed both visually
  (screenshot) and geometrically via `getBoundingClientRect()`: the
  `.payment-plan-form` and all 5 fields (Cadence, Installment amount,
  both dates, Note) have their right edges at or inside the card's right
  edge; `document.documentElement.scrollWidth === clientWidth` (no
  page-level horizontal scroll). Layout matches the approved reference:
  two-column desktop fields, Note spans full width, Save/Cancel inside
  the card. **Cancel verified clean**: after clicking Cancel,
  `.payment-plan-form` is gone, the row's `className` is back to the
  bare `open-pledge-plan-row` (no residual class), computed
  `grid-column` is back to `auto`, and the row's width returned to its
  original ~260px compact size -- no residual width/span state, exactly
  as required.
- **Multiple-pledge case:** a real donor with 2 open pledges, no plans
  yet (CT2027 $300, CT2026 $100), rendered side by side compact
  beforehand. Clicked "Set payment plan" on CT2027. Confirmed: the
  active row spans the full section width and contains its whole form
  (geometrically verified, same method as above); the CT2026 neighbor
  drops cleanly to its own row below with zero pixel overlap
  (`overlaps()` check on both rows' `getBoundingClientRect()` returned
  `false`) and remains fully rendered/readable, its own "Set payment
  plan" button intact.
- **Edit-plan case (explicitly required):** the real KOLX2026 plan
  (Zachter donor, $13,500 open, Monthly / $1,500 / next 09/18/2026 /
  final 05/18/2027) opened via "Edit plan" -- identical correct
  containment (`aria-label="Edit payment plan"`, all fields
  geometrically inside the card, no page overflow). Cancelled afterward
  to leave the real record's page exactly as found (no plan was
  modified -- no PATCH request was ever sent during this verification).
- **Mobile/narrow width: NOT achieved, reported honestly rather than
  assumed.** `resize_window` to 420x900 reported success, but
  `window.innerWidth` read back as `1920` immediately after -- the
  viewport did not actually change, the same tooling limitation recorded
  in this file's prior payment-plan rollout section. The pre-existing
  `@media (max-width:700px)` breakpoint that already stacks both grids
  to one column was not touched by this fix (confirmed by reading the
  unedited rule), so the previously-existing mobile stacking behavior is
  believed preserved, but this is a source-code observation, not a
  live-rendered confirmation, and is reported as such.

**Confirmation: no D1 write, no migration, no schema change, no JL data
touched, no payment-plan business logic changed.** Only 3 files changed
(`app/globals.css`, `tests/pledge-payment-plan-layout.test.mjs`,
`package.json`), none of them touch a D1 query, the API routes, or
`lib/relationships/pledge-payment-plan.ts`. Verified directly: the two
donor records used for live verification (Daniel Stein, Zachter) were
only ever read (`GET`) or had their edit form cancelled -- confirmed by
the fact that Cancel never issues a request (see `PlanForm.save()`,
only reachable from the Save button) and no Save button was clicked on
either donor's real plan during this task.

**Note on CLAUDE.md's stated active branch.** `CLAUDE.md`'s Engineering
Rules section states "The active Fundraising OS branch is
`feature/fundraising-os-redesign`" -- this conflicts with every prior
entry in this file and with this task's own explicit instruction, both
of which point at `feature/independent-cloudflare-sandbox` (the branch
this Worker/D1/wrangler config actually deploys from). Flagged per
CLAUDE.md's own instruction to surface conflicts rather than silently
picking a side; proceeded on `feature/independent-cloudflare-sandbox`
since it matches the real, already-deployed infrastructure and every
other session's work in this file. `CLAUDE.md` itself was not edited.
**Resolved below -- see "Branch/Workflow Documentation Audit and
Correction" for the follow-up task that fixed this properly, including
the correction that the stale statement actually lives in
`docs/FUNDRAISING_OS_PRINCIPLES.md`, not `CLAUDE.md` itself.**

## Branch/Workflow Documentation Audit and Correction (2026-08-20)

Documentation/workflow-safety task only, per explicit instruction: no
application code, D1, deploy, Cloudflare config, or branch merge/delete/
rewrite. Follow-up to the note directly above -- confirms and fixes the
stale "active branch" conflict properly, with git evidence rather than
inference from conversation history alone.

**Correction to the prior note's own claim.** The prior note said
"CLAUDE.md's Engineering Rules section states..." -- re-checked directly:
`CLAUDE.md` itself is 13 lines and contains no branch statement at all.
The actual stale line lives in `docs/FUNDRAISING_OS_PRINCIPLES.md`
(Engineering rules, line 77): `"The active Fundraising OS branch is
`feature/fundraising-os-redesign`."` -- `CLAUDE.md` instructs readers to
"read `docs/FUNDRAISING_OS_PRINCIPLES.md` and treat it as the governing
product and engineering guidance," which is how the stale line reaches
the same authority CLAUDE.md carries. Corrected in this task.

**Git evidence, not inference.** Fresh `git fetch` immediately before any
edit:
- `origin/main`: `4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58` (unchanged).
- `origin/feature/independent-cloudflare-sandbox`:
  `0eb860265c1e65e6a38e7fd32aa3749dea7c6c5f` (local HEAD, matches exactly,
  clean working tree).
- `origin/feature/fundraising-os-redesign`:
  `ade8594bf72d9053b7f5c09449c13917e6a708a0` -- exists, was not assumed
  obsolete.

`git merge-base origin/feature/fundraising-os-redesign
origin/feature/independent-cloudflare-sandbox` returns exactly
`ade8594...` -- `feature/fundraising-os-redesign`'s own current tip --
and `git merge-base --is-ancestor` confirms it directly: **every commit
on `feature/fundraising-os-redesign` is also on
`feature/independent-cloudflare-sandbox`, and `git rev-list --count
origin/feature/independent-cloudflare-sandbox..origin/feature/fundraising-os-redesign`
is exactly `0`** -- `feature/fundraising-os-redesign` has no commit the
other branch lacks. `git rev-list --count
origin/feature/fundraising-os-redesign..origin/feature/independent-cloudflare-sandbox`
is `106` -- everything since `feature/fundraising-os-redesign`'s last
commit (`ade8594`, "fix: assign full JL payments to pledges,"
2026-08-05) has happened exclusively on
`feature/independent-cloudflare-sandbox`: the Ask/Solicitation feature,
the birthday-bucketing and payment-recency fixes, the Monthly Payment
Plan feature and its staging rollout, both Error 1102 investigations,
and the payment-plan layout fix immediately above. This is a fork-and-
continue relationship, not two parallel environments -- confirmed
further by both branches sharing the exact same root commit (`fdd6783`,
"feat: establish Fundraising OS application foundation"), while
`origin/main` has a completely disjoint root commit (`2b8f94c`, "Initial
commit") -- structural confirmation of CLAUDE.md's existing "main
contains the old CRM" statement, not a new finding.

**Why `docs/FUNDRAISING_OS_PRINCIPLES.md` names the wrong branch.** The
commit that added this file (`350b374`, "docs: add governing principles
doc and auto-load CLAUDE.md," 2026-08-06) is **not an ancestor of
`feature/fundraising-os-redesign` at all** -- `git merge-base
--is-ancestor 350b374 origin/feature/fundraising-os-redesign` returns
false. The file was authored and committed one day *after*
`feature/independent-cloudflare-sandbox` had already forked off and
continued, directly on the sandbox branch -- so the statement was not
"true when written and later went stale"; it named the wrong branch from
the moment it was committed, most likely a copy/paste or memory slip by
whoever wrote it, not a deliberate multi-environment design. No config,
script, or infrastructure file references either branch name by name --
`grep`/`git grep` across the repo (excluding this file's own many
correct mentions) found the stale line as the only other hit, in
`docs/FUNDRAISING_OS_PRINCIPLES.md`. `package.json`'s
`deploy:staging-independent`/`build:staging-independent` scripts and
`wrangler.staging.jsonc` are all config-file-driven, not branch-name-
driven -- branch discipline here is a human/process convention, not
something any script enforces, which is exactly why a stale doc could
have silently misdirected a future session.

**What this file (`docs/AI-HANDOFF.md`) already had right.** Its own
"Current Git State" section has said "Branch:
feature/independent-cloudflare-sandbox" since this file's earliest
entries, and its own preamble already states "If this file and the
repository/infrastructure disagree, trust the repository/infrastructure"
-- a narrower version of the authority-order rule this task was asked to
add. `docs/FUNDRAISING_OS_PRINCIPLES.md` was the only stale outlier.

**`feature/fundraising-os-redesign`'s actual status, established, not
guessed:** it is the branch this application's foundation was originally
built on (shares the app's true root commit with the sandbox branch,
unlike `main`), and its own last commit is a real, substantive fix ("fix:
assign full JL payments to pledges") -- not a throwaway or experimental
branch. But it has had zero commits since 2026-08-05, carries no unique
work `feature/independent-cloudflare-sandbox` lacks, and nothing in the
repo's config/scripts points at it as a separate deployment target. It is
**historical/superseded, not a second active environment** -- kept
as-is, not deleted, merged, renamed, or rewritten, per explicit
instruction; its final disposition (archive vs. eventual deletion) was
not decided here and would need its own separate approval.

**Fix.** `docs/FUNDRAISING_OS_PRINCIPLES.md`'s Engineering rules section:
replaced the single stale "active branch" bullet with two bullets --
(1) states that Independent Staging development is currently on
`feature/independent-cloudflare-sandbox`, explains the fork relationship
and the exact evidence above, and instructs verifying via `git
fetch`/`rev-parse`/`log` plus this file's own "Current Git State" section
rather than trusting any recorded branch name, including this one, and
(2) a general authority-order rule: a branch name in
`FUNDRAISING_OS_PRINCIPLES.md`, `CLAUDE.md`, or `docs/AI-HANDOFF.md` is a
starting hint, never authoritative on its own -- verified current git/
deployment state and the user's explicit task instruction win on
conflict, and the conflict should be surfaced and the stale note
corrected, not silently guessed past or silently overridden. This
mirrors, rather than duplicates, `docs/AI-HANDOFF.md`'s own existing
"trust the repository/infrastructure" preamble -- no new hierarchy
taxonomy was invented, and no other document needed a matching change
(`CLAUDE.md` was re-checked and contains no branch statement to correct;
`docs/DEPLOYMENT.md` and `README.md` contain no branch references at
all).

**Confirmation: no branch was merged, deleted, force-pushed, or
rewritten.** `feature/fundraising-os-redesign` was only read (`git log`,
`git merge-base`, `git rev-list --count`) -- never checked out, written
to, or force-pushed. No merge into or from `origin/main` occurred.
`origin/main` unchanged throughout
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Only
`docs/FUNDRAISING_OS_PRINCIPLES.md` and this file changed; no
application code, D1 schema, migration, Cloudflare configuration, or
deployment occurred in this task.

## Relationship Snapshot / Institutional Memory Divergence -- Donor 987 vs 67909 (2026-08-20) -- INVESTIGATION ONLY, NO FIX APPLIED

Investigated per explicit instruction: root-cause only, no D1 write, no
extraction-heuristic change, no deploy, `main` untouched. All findings
below are from read-only `wrangler d1 execute --remote --config
wrangler.staging.jsonc` `SELECT`s against Independent Staging and direct
execution of the real, unmodified `lib/capture/interaction.ts` functions
against the two donors' actual stored note text -- not inference from
conversation history.

**Rows (sanitized -- no donor names/contact info).**

| | Donor 987 | Donor 67909 |
|---|---|---|
| type | call | call |
| source | `capture:call` | `capture:call` |
| shared_activity_id | null | null |
| role | null | null |
| occurred_at -> created_at gap | 7s | 42s |
| updated_at == created_at | yes (never edited) | yes (never edited) |
| `activity_status_audits` rows | none | none |
| donors.relationship_health | null | 86 |
| donors.relationship_summary / institutional_memory | both NULL | both set |
| donors.updated_at vs. interaction created_at | unrelated, predates it | exactly equal |

Both interactions are eligible/"completed-live" under the same downstream
query (`lib/relationships/read.ts`'s last-contact SELECT: not
`cancelled:%`/`archived:%`, and `occurred_at <= created_at` since neither
carries a `capture-scheduled:` source prefix).

**Ruled out, not assumed, per explicit instruction to test rather than
assume:**
- Shared-activity/recipient-role path: both rows have
  `shared_activity_id IS NULL` and `role IS NULL` -- neither interaction
  went through `app/api/interactions/shared/route.ts` at all. (That route
  *would* be a real bug for a substantive 1:1 call if it were involved --
  it never writes `relationship_summary`/`institutional_memory` for any
  recipient, any role, any interaction type, by explicit design -- but it
  is not implicated in this specific pair.)
- Capture route divergence: identical route for both --
  `source = 'capture:call'` on both rows only comes from
  `app/api/interactions/route.ts`.
- Edit-vs-create distinction: neither row was ever edited
  (`updated_at == created_at`, zero `activity_status_audits` rows for
  either interaction id).
- Write failure: `app/api/interactions/route.ts`'s `env.DB.batch()` call
  either fully succeeds or the whole request 500s (`logger.error
  interaction_capture_failed`) -- both interactions exist with no
  scheduled-or-cancelled marker, so both requests succeeded end to end.
- UI/cache staleness: `app/donors/[id]/page.tsx` reads
  `donor.relationship_summary`/`donor.institutional_memory` directly off
  the `donors` row every render (`dynamic = "force-dynamic"`, no live
  derivation, no cache layer) -- D1's NULL for donor 987 and the honest
  empty state the UI would show are the same fact, not a staleness gap.

**Proven root cause.** `app/api/interactions/route.ts` only writes
`relationship_summary`/`institutional_memory` when
`!scheduled && body.acceptRelationshipSnapshot === true` (route.ts:86-91).
The client (`app/capture/CaptureExperience.tsx`) only ever sends
`acceptRelationshipSnapshot: true` when its own locally-computed
`preview.relationshipSummary !== null` (line 197) -- and only shows the
accept checkbox at all when that preview is non-null (line 418-420); when
it's null the UI instead renders "No meaningful relationship details
detected," with no checkbox to check. `preview.relationshipSummary` and
`extracted.relationshipSummary` both come from
`actionableRelationshipSnapshot()` in `lib/capture/interaction.ts`, which
returns null unless at least one sentence matches
`COMMITMENT_PATTERN`, `RELATIONSHIP_CHANGE_PATTERN`, or
`FACT_SIGNAL_PATTERN`.

Fetched both notes' actual text (not reproduced verbatim here) and ran
the real `relationshipSnapshotDetails()`/`actionableRelationshipSnapshot()`
functions against each, unmodified:
- Donor 987's note describes a call about a **grandson's** bar mitzvah.
  `specificFactsCount: 0`, `snapshotIsNull: true`.
- Donor 67909's note (near-identical phrasing) describes a call about a
  **son's** bar mitzvah. `specificFactsCount: 1`, `snapshotIsNull: false`.

`FACT_SIGNAL_PATTERN` includes `\bson\b`/`\bdaughter\b`/`\bfamily\b` etc.
as family-relevance signals. `\bson\b` requires a word boundary
immediately before "son"; in "grandson's" the preceding character is "d"
(a word character), so no boundary exists there and the match never
fires. In "son's" (standalone), the boundary exists and it matches. Nothing
in `FACT_SIGNAL_PATTERN`, `COMMITMENT_PATTERN`, or
`RELATIONSHIP_CHANGE_PATTERN` recognizes "grandson"/"granddaughter"/
"grandchild" as a distinct family-relevance term. This is why
`institutional_memory` was also lost for donor 987, not just the
snapshot: `extracted.memory` itself is always a non-null template string
regardless of extraction success, but the UI gates the *entire* accept
checkbox (which controls both fields' write, per the single shared
`acceptRelationshipSnapshot` condition in route.ts:86-91) on
`relationshipSummary` alone -- so a call with genuine, donor-relevant
content (a grandchild's simcha) that happens to route through the
"grandchild" family branch instead of the "child" branch never even gets
offered for saving.

**Not isolated to donor 987.** This is a content-shaped regex gap, not a
per-donor data issue: any note whose only family-relevance signal is
"grandson"/"granddaughter"/"grandchild"/"grandparent" (common phrasing
for a yeshiva/day-school fundraiser logging a donor's grandchild's
milestone) will silently fail to produce a snapshot preview -- and
therefore silently lose institutional-memory capture too -- regardless of
donor, capture route, or interaction type. No historical-frequency count
was run (would require scanning existing interaction summary text, out
of scope for a no-write investigation task); a real count needs a
targeted read-only pass before any backfill decision.

**Smallest evidence-supported fix (not applied -- reporting first, per
explicit instruction, since it touches extraction heuristics):** add
grandchild-relationship terms ("grandson", "granddaughter", "grandchild",
"grandparent") to `FACT_SIGNAL_PATTERN` in `lib/capture/interaction.ts`.
Single-file, single-regex change; no route, schema, or write-gating logic
needs to change. A regression test belongs in `tests/capture.test.mjs`
(or a small dedicated test file, matching this repo's structural-test
convention) asserting a grandchild-milestone note now yields a non-null
`actionableRelationshipSnapshot`. If approved, any backfill for
previously-missed grandchild-phrased interactions would need to go
through the existing human-review preview/apply tooling
(`scripts/relationship-summary-cleanup-preview.mjs`, the same pattern
already used for the prior relationship-summary cleanup pass) rather than
an automatic write, per `docs/FUNDRAISING_OS_PRINCIPLES.md`'s "Never save
AI-generated content without explicit user acceptance" rule.

**Confirmation: no D1 write, no extraction-heuristic change, no deploy.**
Only `SELECT` queries were run against Independent Staging; the local
`node` invocation that exercised `relationshipSnapshotDetails()`/
`actionableRelationshipSnapshot()` imported the existing, unmodified
source file and made no edits to it. `origin/main` not touched. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

## Grandchild/Grandparent Extraction-Gap Fix -- FACT_SIGNAL_PATTERN (2026-08-20)

Forward fix for the gap confirmed in "Relationship Snapshot /
Institutional Memory Divergence -- Donor 987 vs 67909" above, approved by
explicit instruction after that investigation.

**Change.** `lib/capture/interaction.ts`'s `FACT_SIGNAL_PATTERN` gained
six alternatives: `grandsons?|granddaughters?|grandchild(?:ren)?|
grandparents?|grandmothers?|grandfathers?` (inserted after the existing
`son|daughter`). No other pattern, route, schema, or write-gating logic
changed. `COMMITMENT_PATTERN`/`RELATIONSHIP_CHANGE_PATTERN` were left
untouched -- the gap was specifically in family-relevance fact detection,
not commitment or relationship-change detection.

**Regression tests.** New file `tests/relationship-snapshot-family-terms.test.mjs`,
added to `package.json`'s `test` script chain. Runs the real, unmodified
`relationshipSnapshotDetails()`/`actionableRelationshipSnapshot()`
functions (not a source-text regex check) against: grandson/grandsons,
granddaughter/granddaughters, grandchild/grandchildren, grandparent/
grandparents, grandmother, grandfather (all producing facts); son/
daughter unchanged (still producing facts, proving the fix didn't alter
existing behavior); three false-positive probes ("Johnson", "reasons ...
in person", "season") proving the new alternatives don't loosen matching
for unrelated words containing "son"; and a structural check on
`app/api/interactions/route.ts` proving the `!scheduled &&
body.acceptRelationshipSnapshot === true` gate and the combined
`relationship_summary`+`institutional_memory` UPDATE are both still
present -- i.e. a fixed extraction pattern still cannot write anything
without explicit client acceptance. All pass.

**Donor 987's real note, re-checked (extraction only, no write):**
`specificFactsCount` went from 0 (pre-fix) to 1 (post-fix); donor
67909's stayed at 1 either way. Donor 987's row was NOT written to --
per explicit instruction, no backfill was performed for 987 or anyone
else. The next time this donor's call (or a similar note) goes through
capture, the client will now offer the accept checkbox; the donor row
itself is untouched by this task.

**Read-only historical audit (no writes).** Scanned Independent Staging
`interactions.summary LIKE '%grand%'`: 15 rows total. 1 (donor 987's own
call, already known) was previously null under the old pattern and now
produces a fact under the new one. The other 14 are `type = 'text'`,
`source = 'manual'`, single-line summaries with no separate subject/note
split -- confirmed via `splitInteractionSummary()` that their `note`
portion is empty, so they were never eligible for extraction before or
after this fix, old pattern or new. Their `type`/`source` combination
matches `app/api/interactions/shared/route.ts` (the shared/broadcast
route, which stores `summary` as one raw field and never calls the
extraction functions at all, for any recipient, regardless of content --
already documented in the investigation above as a deliberate, separate
design choice). **Conclusion: not a materially broader extraction
problem** -- exactly the one already-confirmed case was affected; no
scope expansion needed, per explicit instruction to stop and report
rather than expand if the audit had found otherwise.

**Verification.** `pnpm test` (all suites, including the new file):
exit 0, every suite reports `fail 0`. `pnpm exec tsc --noEmit`: clean,
exit 0. `pnpm run build:staging-independent`: completed, full route
manifest printed, no errors.

**Confirmation: no D1 write, no deployment.** Only read-only `SELECT`s
were run against Independent Staging D1 for both the original
investigation and this audit. No `wrangler deploy` was run. `origin/main`
unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`) throughout. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

## Grandchild Fix Deployment + Donor 987 Repair Preview (2026-08-20)

Two phases, per explicit instruction: (A) deploy the already-committed
forward fix and live-verify it; (B) preview -- not apply -- donor 987's
historical repair.

**Phase A -- deploy.** Fetched origin, confirmed `HEAD ==
origin/feature/independent-cloudflare-sandbox == a59c8d5` (the commit
containing the approved `FACT_SIGNAL_PATTERN` fix), working tree clean,
`origin/main` unchanged. Re-ran `pnpm test` (exit 0, every suite `fail
0`), `pnpm exec tsc --noEmit` (clean), `pnpm run build:staging-
independent` (completed, full route manifest, no errors). Deployed via
`pnpm run deploy:staging-independent` (`wrangler deploy --config
wrangler.staging.jsonc`) at 2026-08-20T23:52:18Z (UTC, deploy command
start). **Worker version `e846f522-161e-48ea-a556-4b575db27be5`**,
deployed git SHA `a59c8d5`. No D1 schema/data, R2, workflow, CPU-limit,
or account-setting change; production untouched.

**Live forward-behavior verification.** No safe disposable/test donor
exists among live donors (checked: zero donors with display_name
matching test/QA/dummy/disposable/sample/zzz patterns) -- per explicit
instruction, did not fabricate an interaction against real donor
history. `CaptureExperience.tsx`'s preview (`useMemo(() =>
extractInteraction(note, activeKind, subject), ...)`) is computed
entirely client-side from note/type/subject alone, with no dependency on
`donorId` and no network round-trip -- so the acceptance-UX check could
be exercised live against the real deployed bundle on `/capture` without
selecting any donor and without ever clicking Save, guaranteeing zero
persistence by construction (not merely by choosing not to click
accept). Verified on `https://fundraising-os-staging.sgoldstein.workers.dev/capture`:
- A grandson note ("Spoke about his grandson's upcoming bar mitzvah.")
  now offers the "Use this relationship snapshot" checkbox, unchecked by
  default, with the exact preview text "Spoke about his grandson's
  upcoming bar mitzvah." shown -- a real quoted sentence, not a
  mechanical field-label dump.
- A parallel son note ("Spoke about his son's upcoming bar mitzvah.")
  produces the structurally identical checkbox/preview UI -- confirmed
  parity between the grandchild and existing son/daughter paths.
- A granddaughter note ("Spoke about his granddaughter's engagement.")
  also correctly triggers the checkbox.
- An unrelated note ("Left a voicemail, no answer.") correctly shows "No
  meaningful relationship details detected." with no checkbox -- no
  regression to the negative case.
- `Save interaction` stayed disabled throughout (no donor selected);
  `read_console_messages` (pattern `.`, all message types) returned zero
  messages across page load and every interaction -- no console errors.
- No server round-trip was exercised (no POST was ever sent, by design,
  to avoid writing a fabricated interaction into real donor history) --
  server-side error-free behavior for a real donorId + accepted checkbox
  was not directly observed live in this task; it is covered by the
  existing structural test in `tests/capture.test.mjs` (asserts the
  `acceptRelationshipSnapshot === true` gate in `app/api/interactions/
  route.ts`) and by the new `tests/relationship-snapshot-family-terms.
  test.mjs`, but not by a live end-to-end write in this session.

**Phase B -- donor 987 preview (NO WRITE).** Re-read fresh from D1
immediately before generating the preview:
- Donor 987 (`bb929584-0ba8-4741-84b6-746427724bc4`): `relationship_
  summary` and `institutional_memory` both still NULL,
  `relationship_health` still NULL, `updated_at` still `1786123132`
  (unchanged from every prior read in this session's earlier
  investigation).
- Source interaction `1c69f90a-59b4-431a-bbf4-eabee0bd6d36`: same donor,
  type `call`, source `capture:call`, `shared_activity_id`/`role` still
  null, `created_at == updated_at == 1787255047` (never edited), zero
  `activity_status_audits` rows, summary text byte-identical to the
  original audit ("grandson bar mitzvah mazel tov call\ncalled to wish
  mazel tov on grandson's bar mitzvah this shabbos"). All pre-write
  assumptions held -- proceeded to preview generation.

**Existing tooling audit.** `scripts/relationship-summary-cleanup-
preview.mjs` (the established preview/apply architecture) selects its
candidate set as `donors WHERE relationship_summary IS NOT NULL` --
built specifically to regenerate/clear *stale-format, already-non-null*
values (pre-fix "Latest discussion topics: ..." dumps), not to backfill
a field that is currently NULL. Donor 987's `relationship_summary` is
NULL, so this donor would never appear in that script's candidate set at
all -- **the existing tooling cannot express this specific repair
(null -> populated) as-is.** Per explicit instruction not to bypass the
safety model or write a one-off SQL UPDATE, this was reported rather
than worked around; the preview below was generated by calling the same
real, unmodified `actionableRelationshipSnapshot()`/
`relationshipSnapshotDetails()` functions this script itself uses,
directly, with no D1 write of any kind. Extending the script to handle a
null-backfill case (with its own compare-and-swap safety, matching the
existing apply-mode pattern) would be a separate, explicitly-scoped
follow-up if this preview is approved and a repeatable/backfill path is
wanted later.

**Preview (read-only, not applied):**

| | Value |
|---|---|
| Donor | 987 (`bb929584-0ba8-4741-84b6-746427724bc4`) |
| Source interaction | `1c69f90a-59b4-431a-bbf4-eabee0bd6d36`, type `call`, occurred 2026-08-20 |
| Source note (relevant excerpt) | "called to wish mazel tov on grandson's bar mitzvah this shabbos" |
| Current relationship_summary | `null` |
| Proposed relationship_summary | `"called to wish mazel tov on grandson's bar mitzvah this shabbos."` |
| Current institutional_memory | `null` |
| Proposed institutional_memory | `"Call context: called to wish mazel tov on grandson's bar mitzvah this shabbos"` |

**Quality assessment.** Compared directly against donor 67909's real,
already-live, already-accepted values for the parallel son note: `"called
to wish mazel tov on son's bar mitzvah this shabbos."` /
`"Call context: called to wish mazel tov on son's bar mitzvah this
shabbos"`. Donor 987's proposed values are structurally identical in
form, differing only in "grandson's" vs "son's" -- the same style already
live in production for this exact capture path, not a "People mentioned:
Grandson"-style mechanical dump (that failure mode was the pre-1487a8b
generator, already retired). `people`/`organizations` both extract empty
(no false "Grandson" name-mention), consistent with the note's lowercase
possessive not matching the capitalized-name pattern. One minor,
pre-existing, non-grandchild-specific cosmetic trait: the proposed
relationship_summary starts lowercase ("called to wish...") because it
quotes the note verbatim and this particular note itself starts
lowercase -- identical behavior to what already happened for 67909, not
a defect introduced by this fix. **Assessment: useful, consistent with
the already-accepted production bar for this exact note style --
recommended for approval, pending explicit human sign-off (not applied
in this task).**

**Confirmation: donor 987 remains unmodified.** Re-read after generating
the preview: `relationship_summary`/`institutional_memory` still NULL,
`updated_at` still `1786123132`; source interaction `updated_at` still
`1787255047`. No `UPDATE` statement of any kind was executed against
donor 987 or its interaction in this task. The other 14 shared-activity
rows from the historical audit were not touched or re-examined.

**Confirmation: git/deploy state.** `origin/feature/independent-
cloudflare-sandbox` and local `HEAD` both `a59c8d5` before this task's
docs-only commit; `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`) throughout. Only the
Worker was deployed (Independent Staging); no D1 write of any kind
occurred in this task. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Next approval needed:** explicit sign-off on the exact previewed
`relationship_summary`/`institutional_memory` values above for donor
987 before any write is made -- this task ends at preview.

**UPDATE 2026-08-20 -- APPLIED.** The user approved the exact previewed
values verbatim. Repair applied to Independent Staging. See "Donor 987
Historical Grandchild-Gap Repair -- APPLIED (2026-08-20)" below for the
full write/verification report. This donor's grandchild-gap repair is
now **complete**, not merely previewed.

## Donor 987 Historical Grandchild-Gap Repair -- APPLIED (2026-08-20)

Applied the previously-previewed, user-approved repair. Per explicit
instruction, did not broaden or modify `scripts/relationship-summary-
cleanup-preview.mjs` (that tool's candidate set requires
`relationship_summary IS NOT NULL` and structurally cannot represent a
null-backfill case -- see the preview task above). Instead used the
smallest auditable mechanism: a single, hand-reviewed, compare-and-swap
`UPDATE` executed directly via `wrangler d1 execute --remote`, with the
CAS condition embedded in its own `WHERE` clause (self-auditable from
the SQL text itself, reproduced below) rather than a new permanent
script.

**Pre-write CAS verification (fresh read, immediately before the
write).** Donor 987 (`bb929584-0ba8-4741-84b6-746427724bc4`):
`relationship_summary` NULL, `institutional_memory` NULL,
`relationship_health` NULL, `updated_at` still `1786123132` -- identical
to every prior read in this donor's investigation/preview. Source
interaction `1c69f90a-59b4-431a-bbf4-eabee0bd6d36`: `created_at ==
updated_at == 1787255047` (never edited), `shared_activity_id`/`role`
still null, summary text byte-identical to the original audit. Baseline
snapshot taken for the "no other row changed" check: 248 total donors, 7
with non-null `relationship_summary`, 10 with non-null
`institutional_memory`, 67 total interactions, 5 recommendations. All
preconditions held -- proceeded.

**The write.** Single SQL statement, executed via `wrangler d1 execute
fundraising-os-staging-db --remote --config wrangler.staging.jsonc
--json --command`:

```sql
UPDATE donors
SET relationship_summary = 'called to wish mazel tov on grandson''s bar mitzvah this shabbos.',
    institutional_memory = 'Call context: called to wish mazel tov on grandson''s bar mitzvah this shabbos',
    updated_at = 1787271522
WHERE id = 'bb929584-0ba8-4741-84b6-746427724bc4'
  AND owner_user_id = 'user_sgoldstein@nirc.edu'
  AND data_source = 'live'
  AND relationship_summary IS NULL
  AND institutional_memory IS NULL
```

Scoped to exactly one row by primary key, further gated by
`owner_user_id`/`data_source = 'live'`, and the CAS condition
(`relationship_summary IS NULL AND institutional_memory IS NULL`) means
this statement is naturally idempotent -- re-running it after the first
successful application would match zero rows and write nothing.
Deliberately writes only the two user-approved fields plus `updated_at`
(the same bookkeeping column every existing write path in this app
already updates on a relationship_summary/institutional_memory change);
`relationship_health` was intentionally left untouched -- it was not
part of the exact approval, so this repair does not set it, unlike the
normal capture-time write path which sets it to 86.

D1 response: `"changes": 1, "rows_written": 1` -- exactly one row
affected, matching the CAS precondition exactly.

**Post-write verification (direct D1 reads).**
1. `relationship_summary` = `"called to wish mazel tov on grandson's bar
   mitzvah this shabbos."` -- exact byte match to the approved value.
2. `institutional_memory` = `"Call context: called to wish mazel tov on
   grandson's bar mitzvah this shabbos"` -- exact byte match to the
   approved value.
3. Source interaction re-read: every column (`type`, `source`,
   `occurred_at`, `shared_activity_id`, `role`, `created_at`,
   `updated_at`, `summary`) byte-for-byte identical to the pre-write
   read -- untouched.
4. No other donor modified: `relationship_summary` non-null count went
   from 7 to exactly 8 (+1); `institutional_memory` non-null count went
   from 10 to exactly 11 (+1); total donor count unchanged at 248.
5. No unrelated rows created: total interaction count unchanged at 67;
   recommendation count unchanged at 5.

**Donor-page verification.** Navigated to
`/donors/bb929584-0ba8-4741-84b6-746427724bc4` (Dr. & Mrs. Mark
Danziger, JL 987) on Independent Staging. The Relationship Snapshot card
now renders "called to wish mazel tov on grandson's bar mitzvah this
shabbos." -- exact match to the applied `relationship_summary` -- and a
derived Suggested Action referencing the same text. Confirms the donor
page reads `donors.relationship_summary` directly with no cache/staleness
between the D1 write and the render, consistent with this donor page's
already-documented read path (see the original investigation report
above).

**Confirmation: nothing else touched.** No source-interaction edit, no
other donor, no recommendation/reminder created, no giving data, no
schema change, no production access, `origin/main` untouched
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). This was a single D1
`UPDATE` against Independent Staging only; no `wrangler deploy` was run
in this task (the Worker deployed in the prior task, version
`e846f522-161e-48ea-a556-4b575db27be5`, is unchanged and already serves
this donor's data straight from D1). Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Status: the grandchild/grandparent extraction-gap investigation, fix,
deployment, and the one confirmed historical case (donor 987) are now
all complete.**

## Comprehensive Historical Audit -- relationship_summary / institutional_memory (2026-08-20) -- READ-ONLY, NO WRITES

Prompted by a live donor page still showing clearly bad historical
content (`donor 60830` -- see "Special check" below), proving the prior
cleanup work (the `scripts/relationship-summary-cleanup-preview.mjs`
tool, and the grandchild-gap fix/repair above) did not comprehensively
identify every malformed historical snapshot already stored in D1. This
task is a complete, read-only audit of every live donor's stored
`relationship_summary`/`institutional_memory` -- no writes of any kind.

**Scope.** Every donor with `data_source='live'`, `archived_at IS NULL`,
and either `relationship_summary IS NOT NULL` or `institutional_memory
IS NOT NULL` -- not limited to donors visible in any screenshot, and not
assuming any non-null value is bad without inspecting its actual text.

**Tooling.** New, separate, read-only-only script
`scripts/relationship-context-audit.mjs` (does NOT modify or extend
`scripts/relationship-summary-cleanup-preview.mjs`, per explicit
instruction). It reuses that script's own exported pure helpers
(`candidateTexts`, `oldActionableRelationshipSnapshot`, `normalizeKind`)
for source-tracing rather than reimplementing them, but classifies BOTH
fields independently across every non-null donor (the existing tool
only classifies `relationship_summary`, and only for donors where it's
non-null) against a broader set of legacy-scaffolding signals than just
the exact `"Latest discussion topics: "` prefix (`People mentioned:`,
`Organizations mentioned:`, `Recommended next action:`, `Review this
note before the next interaction`, `Commitments:`, `Open follow-ups:`,
`Relationship changes:` -- every distinct field-label the pre-fix
generator ever emitted, checked independently of each other). Contains
no `UPDATE`/`INSERT`/`DELETE` statement and no `--apply` flag anywhere
in the file -- verified both by direct inspection and by a new test
(`tests/relationship-context-audit.test.mjs`) that greps the script's
own source for exactly that. That test file also proves: classification
is deterministic; every legacy scaffolding fragment listed above is
caught (both as part of a full dump and in isolation); every real
donor-relevant example on file (grandchild/family-milestone notes,
solicitation notes) is NOT falsely flagged; a donor with one malformed
field and one good field is surfaced as `C_MIXED`, never silently
cleared; and the Suggested-Action-impact check exactly matches
`relationshipOpportunityCandidate`'s real fallback chain. `pnpm test`
(all suites, exit 0) and `pnpm exec tsc --noEmit` (clean) both pass with
this script and test added.

**Counts.**
1. Total live donors: **248**
2. `relationship_summary` non-null: **9**
3. `institutional_memory` non-null: **12**
4. Clearly good (A): **10**
5. Clearly malformed (B): **0**
6. Mixed (C): **2**
7. Uncertain (D): **0**
8. Donors where malformed relationship context currently affects
   Suggested Action: **2** (both mixed donors below)
9. Donors where the source interaction could be confidently identified:
   **2** (both malformed `relationship_summary` values reproduce, byte-
   for-byte, under the OLD pre-1487a8b generator applied to a real
   interaction note on file -- proven, not inferred)
10. Donors where provenance could not be identified: **0**

**Every donor NOT clearly good (both, in full):**

| Donor | Code | relationship_summary | institutional_memory | Exact problematic text | Likely source interaction/date | Suggested Action affected? | Recommended disposition | Confidence |
|---|---|---|---|---|---|---|---|---|
| Mr. & Mrs. Yaakov Zachter | 60830 | MALFORMED | GOOD | `"Latest discussion topics: Text message follow-up.\nPeople mentioned: Texted, Zman.\nRecommended next action: Review this note before the next interaction."` | `8b502028-6a6e-4ee8-aa3f-9903a1d75af2` (Text Message, 2026-08-18; created 2026-08-19T02:29:35Z, ~2h before the 1487a8b fix deployed) | **YES** | `relationship_summary`: NEEDS REVIEW (see reasoning below). `institutional_memory`: LEAVE UNCHANGED | High |
| Dr. Jacques Semmelman | 72957 | MALFORMED | GOOD | `"Latest discussion topics: Personal update.\nPeople mentioned: Sent, Yahrtzeit.\nRecommended next action: Review this note before the next interaction."` | `544721ad-ceb3-4078-bbd6-ef90c0093a1b` (Personal interaction, 2026-08-07; created 2026-08-14T14:39:09Z) | **YES** | `relationship_summary`: NEEDS REVIEW (see reasoning below). `institutional_memory`: LEAVE UNCHANGED | High |

Both donors are `C_MIXED`: `relationship_summary` is pre-fix scaffolding
junk, `institutional_memory` is genuinely good (a real quoted note --
"Texted video from first day of Zman and thanked him for his support
that makes it happen" / "Sent text on wife's Yahrtzeit to acknowledge
it"). Per explicit instruction, mixed records must not be silently
deleted without review -- neither field was touched.

**Why "NEEDS REVIEW" rather than "CLEAR TO NULL" for these two
`relationship_summary` values.** The current (fixed) extractor, run
against each real source note, ALSO finds no fact signal and would
produce `null` -- but both notes contain a real, named, donor-relevant
term ("Zman" -- a school-calendar term; "Yahrtzeit" -- a death
anniversary) that `FACT_SIGNAL_PATTERN` doesn't recognize as a fact
signal, the same class of gap as the grandchild/grandparent case fixed
earlier in this branch. Clearing to null would silently discard that a
donor-relevant term is on file at all (even though `institutional_memory`
already preserves the actual sentence). This is flagged for human
review, not resolved here -- **per explicit instruction, extraction
logic was NOT changed in this task**, and whether `FACT_SIGNAL_PATTERN`
should also learn "Zman"/"Yahrtzeit" (or these two should simply be
cleared to null once reviewed) is a separate decision.

**Source trace detail.** Both source interactions: single-donor capture
route (`source = 'capture:text'` / `'capture:personal'`),
`shared_activity_id`/`role` both null (not a shared/broadcast
interaction), `created_at == updated_at` (never edited), zero
`activity_status_audits` rows. Both interactions' `created_at` exactly
equals the donor's `updated_at` at the time of this audit, confirming a
direct, single-request causal link between that capture and the stored
value -- not a coincidence or a later unrelated edit.

**Explicit acceptance history.** Both malformed `relationship_summary`
values were written through `app/api/interactions/route.ts`'s normal
capture flow, which -- both before and after commit 1487a8b -- only
ever writes `relationship_summary`/`institutional_memory` when
`!scheduled && body.acceptRelationshipSnapshot === true`. Since this
gating condition itself was not changed by 1487a8b (only the
*generator's output quality* changed), both values were **genuinely,
explicitly accepted by the user at capture time** -- real acceptance of
malformed content the pre-fix generator produced, not an import, not
silent automation, and not something to assume should be discarded
merely because provenance is "just user acceptance of bad output."
Both interactions' `created_at` predate the 1487a8b fix's staging deploy
(2026-08-19T04:23:33Z), confirming both are historical (pre-fix), not a
regression of the current extractor.

**Side finding (not malformed content, but relevant provenance
context): a second, ungated write path exists.**
`app/api/interactions/[id]/outcome/route.ts` (lines ~125-129, the
"mark this scheduled activity complete/no-response" flow) writes
`relationship_summary`/`institutional_memory` **unconditionally** --
with NO `acceptRelationshipSnapshot` gate at all -- whenever an activity
transitions to `completed`/`no-response`. This explains three donors in
this audit whose `institutional_memory` is non-null while
`relationship_summary` is null (37064 Rovinsky, 42818 Klein, 78289
Pfeiffer): their outcome notes ("Solicited for a plaque ($5k)",
"Solicited for $10k") contain no `FACT_SIGNAL_PATTERN` match, so
`relationship_summary` came back null, but `institutional_memory`
(always a non-null template) got written anyway through this route with
no accept step. All three donors' actual stored `institutional_memory`
content is genuinely good (real solicitation facts, not scaffolding),
so none of the three appear in the flagged table above -- but the
architecture gap itself (this route bypasses explicit acceptance
entirely, unlike the main capture route) is worth flagging for a future
task, since it could just as easily write scaffolding-quality content
without any accept step if a future outcome note happened to trip the
old-format-style edge cases. **Not fixed in this task** (would be an
extraction/write-path logic change, out of scope here).

**Suggested Action impact -- proven from source, not assumed.**
`lib/relationships/recommendation-candidates.ts`'s
`relationshipOpportunityCandidate()`/`solicitCandidate()` both compute
`text = evidence.narrative.relationshipSummary || evidence.narrative.institutionalMemory`
-- `relationship_summary` wins whenever non-null, **regardless of its
own quality**, only falling back to `institutional_memory` when
`relationship_summary` is null. For both Zachter and Semmelman,
`relationship_summary` is non-null (the malformed dump), so it directly
becomes `action: "Reach out and reference: ${text}"` and `evidence:
["Recorded relationship note: \"${text}\""]` -- the exact mechanism
behind the screenshot's "Suggested Action then repeats that text as
though it were meaningful donor knowledge." This candidate feeds
`generateCandidates()`, the single function shared by the donor page,
Today, Meeting Brief, and Assistant (per this file's own prior
established description of that engine) -- so the malformed text is
currently eligible to surface anywhere that engine runs, not merely on
the donor page. (Note: the code comment directly above this function
claims narrative text "is now always a specific, quoted fact" -- true
for anything the *current* extractor produces, but that invariant does
not hold retroactively for already-stored pre-fix values like these
two.)

**Special check -- the screenshot donor, confirmed.** Exact donor: **Mr.
& Mrs. Yaakov Zachter, donor code 60830**
(`19af69d6-f147-474b-88ad-f6358ff65b9a`). Stored `relationship_summary`
matches the screenshot's quoted text byte-for-byte:
`"Latest discussion topics: Text message follow-up.\nPeople mentioned:
Texted, Zman.\nRecommended next action: Review this note before the
next interaction."` Source interaction identified with proof:
`8b502028-6a6e-4ee8-aa3f-9903a1d75af2` (Text Message, occurred
2026-08-18, note: "Texted video from first day of Zman and thanked him
for his support that makes it happen"). Suggested Action is confirmed
**currently consuming this bad summary** (see mechanism above). **Not
repaired in this task, per explicit instruction.**

**Confirmation: no data was changed.** Every query in this audit was a
`SELECT` (via `wrangler d1 execute --remote`) or a pure in-process
function call against already-fetched data. No `donors`/`interactions`/
`recommendations` row was written, cleared, regenerated, or created. No
extraction code changed. No schema change. No deploy. `origin/main`
unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`) throughout.
Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Exact approval needed next.** Review of the full flagged set above (2
donors, both `C_MIXED`) before any cleanup is applied. Specifically:
(1) whether to clear `relationship_summary` to null for Zachter (60830)
and Semmelman (72957) now, accepting the loss of the
"Zman"/"Yahrtzeit" mention (already preserved in
`institutional_memory`), or hold for a separate `FACT_SIGNAL_PATTERN`
vocabulary decision first; (2) whether the `outcome/route.ts` ungated
write path (side finding above) should be scoped as a separate future
task. `institutional_memory` for both flagged donors, and every field
for all 10 clearly-good donors, needs no action.

## Zman / Yahrtzeit Extraction-Vocabulary Investigation (2026-08-20) -- DESIGN ONLY, NO CODE CHANGE, NO D1 WRITE

Narrow, read-only design investigation for the 2 mixed donors flagged in
the comprehensive audit above, per explicit instruction: determine
correct extraction behavior for "Zman" and "Yahrtzeit" BEFORE touching
`FACT_SIGNAL_PATTERN` or either donor's data. Nothing was written, no
extraction code changed, no deploy.

**Step 1 -- fresh re-verification.** Both donors and both source
interactions re-read fresh from D1: identical in every field to the
prior audit (same `relationship_summary`/`institutional_memory` text,
same `updated_at`, same interaction `created_at == updated_at`, zero
`activity_status_audits` rows for either). No discrepancy -- proceeded.

**Step 2/3 -- actual semantics, current extractor (real functions,
not reimplemented).**

*Zachter (60830), note: "Texted video from first day of Zman and
thanked him for his support that makes it happen."* Current extractor
output: `relationshipSummary: null` (zero `specificFacts`),
`institutionalMemory: "Text Message context: Texted video from first
day of Zman and thanked him for his support that makes it happen"`,
`people: ["Zman"]` (false-positive name detection -- `mentionedPeople()`
still treats the capitalized word "Zman" as a candidate name; this no
longer leaks into `actionableRelationshipSnapshot`'s output post-1487a8b
since `specificFacts` never includes the `people` list any more, but it
DOES still leak into `lib/relationships/meeting-brief-model.ts`'s
`peopleMentioned` list, which independently calls
`relationshipSnapshotDetails()` and flattens `.people` -- a live, minor,
separate bug noted for awareness, not investigated or fixed here, out
of this task's scope). `organizations: []`, `commitments: []`,
`recommendedNextAction: null`. **The actual donor-relevant fact is NOT
"Zman" itself** -- it's the fundraiser sending a video documenting
tangible impact and explicitly thanking the donor for support that
"makes it happen." "Zman" (a generic yeshiva/school-calendar term
meaning roughly "term/semester") is scene-setting, not the fact.
Interaction mechanics that should never be preserved: the channel verb
"Texted" (already excluded from name-detection) and the "Text message
follow-up" activity-label the OLD generator surfaced (architecturally
impossible under the current generator, which never emits category
labels at all, regardless of what happens with "Zman").

*Semmelman (72957), note: "Sent text on wife's Yahrtzeit to acknowledge
it."* Current extractor output: `relationshipSummary: null` (zero
`specificFacts`), `institutionalMemory: "Personal interaction context:
Sent text on wife's Yahrtzeit to acknowledge it"`, `people:
["Yahrtzeit"]` (same false-positive class as above, same Meeting Brief
caveat). **"Yahrtzeit" IS essentially the fact itself** -- like
`birthday`/`anniversary` (already in `FACT_SIGNAL_PATTERN`), the mere
presence of "[relative]'s Yahrtzeit" reliably signals a specific,
meaningful, recurring personal-loss date. Nothing here is mere
mechanics beyond the already-excluded "Sent" verb.

**Step 4 -- real corpus check (read-only, `interactions.summary LIKE
'%zman%'` / yahrtzeit + spelling variants, case-insensitive).** 42 total
rows matched. Grouped by `source`:

| source | rows | distinct donors |
|---|---|---|
| `capture:personal` (Semmelman's own) | 1 | 1 |
| `capture:text` (Zachter's own) | 1 | 1 |
| `manual` (shared/broadcast route) | 40 | 38 |

**Only these exact 2 rows are single-donor-capture (`source LIKE
'capture:%'`) -- i.e. the ONLY two rows in the entire corpus that ever
ran, or could have run, through `FACT_SIGNAL_PATTERN` at all.** No other
historical donor is affected by a vocabulary change to either term. The
other 40 rows are all `source = 'manual'` (the shared/broadcast route,
`app/api/interactions/shared/route.ts`), which never calls the
extraction functions for any recipient regardless of content -- already
established, separate, deliberate design from the earlier grandchild-fix
task -- so they are read here purely as real-world usage EVIDENCE for
the vocabulary question, not as extraction-eligible rows themselves. No
spelling variants of "yahrtzeit" (`yahrzeit`/`yarzeit`/`yortzeit`) appear
anywhere in the corpus -- only the single consistent spelling
"Yahrtzeit".

*Zman contexts (26 + 14 = 40 of the 42 total rows; bare `\bzman\b`
matches 39/42):* two distinct, identical, mass-broadcast templates sent
to dozens of donors verbatim: "Sent time lapse video from first name of
the zman" (26 rows, likely "name" is a typo/garble for "day") and "Sent
message to welcome son (or grandson) back for the new zman" (14 rows).
Every one of these is generic institutional messaging, not a
donor-specific fact -- strong, direct evidence that "zman" alone is
**not** a reliable per-donor signal in this donor base's real
communications. Zachter's own note is the only genuinely donor-specific
"zman" occurrence in the whole corpus, and even there the donor-relevant
element is the appreciation language around it, not the word itself.

*Yahrtzeit contexts (3 of 42 rows; bare `\byahrtzeits?\b` matches
3/42):* Semmelman's own ("wife's Yahrtzeit," genuinely personal/family);
and 2 identical `manual`-route rows, "Sent message to let them know that
it was rabbi Mintz's mother's first Yahrtzeit, they appreciated it" --
donor-relevant institutional/community content (informing recipients of
a third party's family yahrtzeit), not the recipient's own family fact,
but still a real, meaningful, non-mechanical use of the word -- no
purely mundane/scheduling use of "yahrtzeit" was found anywhere in the
corpus. Because the extractor quotes matching sentences verbatim rather
than attributing facts to named entities, even this third-party example
would not become misleading if it were ever captured single-donor: the
full sentence self-identifies whose yahrtzeit it is.

**Step 5 -- recommended classification (per concept, independently).**

- **Yahrtzeit: A. SIMPLE FACT SIGNAL.** Proposed pattern fragment (NOT
  implemented): add `yahrtzeits?` to `FACT_SIGNAL_PATTERN`'s
  alternation, alongside the existing `birthday|anniversary` family-event
  terms. Open question for whoever approves this: whether to also cover
  unevidenced-but-plausible alternate transliterations (`yahrzeit`,
  `yartzeit`) pre-emptively -- no evidence either way in this corpus, so
  not recommended without a separate decision.
- **Zman: D. DIFFERENT EXTRACTION CHANGE REQUIRED (not A/B/C as a bare
  word).** Corpus evidence (39/42 matching rows nearly all generic
  broadcast content) shows the word itself is not a reliable signal.
  Zachter's note is donor-relevant only because of the surrounding
  appreciation/impact language ("thanked him for his support that makes
  it happen"), which `FACT_SIGNAL_PATTERN` does not currently recognize
  as a category at all (no "thank"/"grateful"/"appreciate"/"support"
  terms exist in it today). If this class of note is worth capturing
  going forward, the correct change would be a new, independent
  appreciation/impact-acknowledgment fact-signal category -- entirely
  unrelated to the word "zman" -- which would need its own
  evidence-gathering and false-positive analysis (e.g. "thanked him for
  coming to the event" is routine and probably should NOT qualify) before
  being proposed. That is explicitly out of scope here, per instruction
  not to broaden this task into a general vocabulary audit.

**Step 6 -- false-positive regression cases (for future implementation,
not applied):**
- Yahrtzeit: genuine case = Semmelman's real note (must produce a
  non-null snapshot). No spelling variant is evidenced, so none is
  proposed as a required case. No misleading-context case was found in
  real evidence -- flagged as "none identified," not asserted as
  impossible.
- Zman: the exact real Zachter note (illustrates why a bare-word rule
  would be both necessary-looking and insuffient -- matching "zman" alone
  would not, by itself, explain why THIS note is meaningful); the two
  real generic/broadcast templates above (must NOT be treated as
  donor-specific facts if a future rule is proposed, even though they
  never reach extraction today); and an illustrative (not corpus-derived)
  calendar-only sentence such as "Reminded him zman starts Monday" or
  "Confirmed the zman dates for the mailing," labeled explicitly as
  hypothetical, showing the word alone conveys no personal relationship
  content.

**Step 7 -- desired Relationship Snapshot content (DESIRED BEHAVIOR
ONLY, not generated, not written, not current extractor output):**
- Zachter (60830), desired: `"Texted video from first day of Zman and
  thanked him for his support that makes it happen."` -- the same
  verbatim-quoted-sentence style every other successful case already
  uses. **Achievable via `FACT_SIGNAL_PATTERN` alone? No.** A narrowly
  correct fix requires recognizing the appreciation/impact language, not
  "zman" -- a materially different, separately-scoped extraction change
  (see Step 5).
- Semmelman (72957), desired: `"Sent text on wife's Yahrtzeit to
  acknowledge it."` -- same verbatim style. **Achievable via
  `FACT_SIGNAL_PATTERN` alone? Yes.** Adding `yahrtzeits?` as a simple
  fact signal would make the existing, unmodified
  `actionableRelationshipSnapshot()` produce exactly this sentence from
  the real source note, with no other code change.

**Step 9 -- outcome/route.ts ungated-write finding: re-confirmed
accurate from current source, unchanged.** `app/api/interactions/[id]/
outcome/route.ts` line 128 still writes `relationship_summary`/
`institutional_memory` unconditionally whenever an activity transitions
to `completed`/`no-response` -- confirmed via direct grep of the current
file: zero occurrences of `acceptRelationshipSnapshot` anywhere in it,
and the `UPDATE donors SET relationship_summary = ?, institutional_memory
= ?, ...` statement is gated only on `nextStatus === "completed" ||
nextStatus === "no-response"`, not on any explicit-acceptance check.
Recorded as a separate, still-open architecture/safety issue -- **not
touched, not expanded, not fixed in this task.**

**Confirmation: no data changed, no code changed.** Every query in this
investigation was a `SELECT` or a call to the real, unmodified
`extractInteraction`/`relationshipSnapshotDetails`/
`actionableRelationshipSnapshot` functions against already-fetched note
text. Neither donor's `relationship_summary` or `institutional_memory`
was cleared, regenerated, or written. `FACT_SIGNAL_PATTERN` and every
other extraction file are byte-identical to before this task. No
schema/deploy/production/`origin/main` change. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Exact decision needed next.** (1) Approve or reject adding
`yahrtzeits?` to `FACT_SIGNAL_PATTERN` (Semmelman's case -- would make
the existing extractor produce the desired snapshot above with no other
change); (2) explicitly confirm NOT adding a bare `zman` term (strong
evidence against it) and decide whether a separate
appreciation/impact-acknowledgment extraction category is worth scoping
as its own future task (Zachter's case has no narrow fix); (3) once (1)
is decided, whether to then clear/regenerate `relationship_summary` for
Zachter and/or Semmelman -- still not done in this task; (4) whether the
`meeting-brief-model.ts` people-mention leak and the `outcome/route.ts`
ungated-write gap should be scoped as their own future tasks.

**UPDATE 2026-08-20 -- IMPLEMENTED (not yet applied to either donor).**
The user clarified the domain meaning of "Zman" (Yeshiva semester/term)
and approved implementing both the Yahrtzeit fact signal and a narrow
contextual Zman rule. See "Zman/Yahrtzeit Extraction Implementation +
Historical Preview (2026-08-20)" below for the full report -- the
extraction code is now changed and deployed to neither staging nor the
two historical donors; both remain untouched pending explicit approval
of the previewed replacement values.

## Zman/Yahrtzeit Extraction Implementation + Historical Preview (2026-08-20) -- CODE CHANGED, NO D1 WRITE, NO DEPLOY

Implements the design approved after the domain clarification that
"Zman" means the Yeshiva semester/term in this context. Per explicit
instruction: implement the smallest defensible extraction change for
Yahrtzeit and (if safely possible) Zman, then preview -- but do not
apply -- the two historical repairs.

**1. Yahrtzeit -- exact change.** `lib/capture/interaction.ts`'s
`FACT_SIGNAL_PATTERN` gained `yahrtzeits?`, inserted after `anniversary`
(the same family-event tier as `birthday`/`anniversary`/the earlier
grandchild terms). One-line regex addition plus a doc comment; no other
logic touched.

**2. Corpus evidence for appreciation/impact language.** Read-only scan
of every interaction row containing "thank" (any form) or "support":
**exactly 1 row in the entire 42-row Zman/Yahrtzeit-adjacent corpus
contains either word, and it is Zachter's own note.** Neither word
appears anywhere else -- not in any of the 40 broadcast/shared-route
rows, not in any other single-donor capture. This is the direct
evidence base for the Zman rule below: requiring co-occurrence of these
already-rare words with "zman" is a conservative, evidence-backed
filter, not speculative phrase engineering from one example.

**3. Was a safe contextual Zman rule possible?** **Yes.** The existing
`relationshipSnapshotDetails()` architecture already filters
notes/sentences independently against multiple named patterns
(`COMMITMENT_PATTERN`, `RELATIONSHIP_CHANGE_PATTERN`,
`FACT_SIGNAL_PATTERN`) and unions the matching sentences into
`specificFacts`. Adding one more narrowly-scoped pattern, filtered and
unioned the same way, required no new framework, taxonomy, classifier,
or vocabulary system -- exactly the "smallest defensible" constraint.

**4. Exact contextual rule implemented.** New pattern
`ZMAN_APPRECIATION_PATTERN` in `lib/capture/interaction.ts`:
```js
const ZMAN_APPRECIATION_PATTERN = /(?=.*\bzman\b)(?=.*\b(?:thanks?|thanked|thanking|support)\b)/i;
```
Deliberately NOT a bare `\bzman\b` addition to `FACT_SIGNAL_PATTERN` --
requires a zman/semester mention AND a thank-word-or-"support" mention
in the same sentence (two independent lookaheads, order-independent).
Wired into `relationshipSnapshotDetails()` as a fourth sentence-filter
category (`zmanAppreciationSentences`), unioned into `specificFacts`
alongside the existing three categories -- same verbatim-sentence-quote
behavior as every other signal, no new output shape.

**5. False-positive protections (evidence-based, not merely
regex-matches-a-string):**
- Every real broadcast "zman" sentence in the corpus (26 + 14 rows, 2
  distinct mass-broadcast templates) lacks both "thank" and "support" --
  correctly excluded.
- A bare "Thanked him" with no zman/semester mention is correctly
  excluded -- thanks alone was never the signal.
- Requiring co-occurrence in the SAME sentence (not just the same note)
  keeps the rule narrow; `sentenceList()` already splits on
  `.`/`!`/`?`/newlines, so this falls out of the existing architecture
  for free.
- **One honest caveat, found during verification, NOT caused by this
  change:** the real broadcast template "Sent message to welcome son (or
  grandson) back for the new zman" DOES still produce a fact under the
  full pipeline -- but proven (isolated and tested explicitly) to be
  entirely because of the pre-existing `\bson\b` entry in
  `FACT_SIGNAL_PATTERN` (added during the earlier grandchild-fix task,
  unrelated to Zman/Yahrtzeit); `ZMAN_APPRECIATION_PATTERN` alone does
  NOT match this sentence (no thank/support word). Not fixed here --
  this specific content only ever arrives via the shared/broadcast route
  in production, which never calls the extraction functions for any
  recipient, so it is not a live regression risk today, but the
  underlying `\bson\b` breadth is a real, separate, pre-existing
  correctness question worth a future look.

**6. Regression-test results.** New file
`tests/relationship-snapshot-yahrtzeit-zman.test.mjs` (wired into
`package.json`'s `test` script), exercising the real, unmodified
extraction functions -- never a reimplementation of the regexes.
Covers: Semmelman's actual note (qualifies); a different-donor Yahrtzeit
phrasing (qualifies); existing birthday/anniversary/son/grandson
behavior (unchanged); an unrelated voicemail note and a commitment
note (unaffected); Zachter's actual note (qualifies); an equivalent
Zman+support phrasing (qualifies); the 4 "should not qualify merely
because of Zman" cases from the task (all correctly null); 3 "should
not qualify merely because of thanks" cases (all correctly null,
carefully chosen to avoid the unrelated pre-existing
gift/donation/contribution signal); the real broadcast-safety case
(correctly null); the caveat case above (asserted honestly, not
papered over); and a check that neither new snapshot ever surfaces
`"People mentioned"` text. `pnpm test` (all suites): exit 0, every
suite `fail 0`. `pnpm exec tsc --noEmit`: clean. `pnpm run
build:staging-independent`: completed, full route manifest, no errors.

**7-8. Zachter (60830) -- source note and new extractor output.**
Source note (unchanged from every prior read): "Texted video from first
day of Zman and thanked him for his support that makes it happen."
**Exact NEW `relationshipSummary`, produced by the real, unmodified-
except-for-this-task extractor, run against the exact stored note:**
`"Texted video from first day of Zman and thanked him for his support
that makes it happen."` -- matches the desired target exactly.

**9-10. Semmelman (72957) -- source note and new extractor output.**
Source note (unchanged): "Sent text on wife's Yahrtzeit to acknowledge
it." **Exact NEW `relationshipSummary`:** `"Sent text on wife's
Yahrtzeit to acknowledge it."` -- matches the desired target exactly.

**11. institutional_memory confirmation.** Not read from, not written
to, not part of the extraction change (the extraction functions this
task touched only affect `actionableRelationshipSnapshot`/
`relationshipSnapshotDetails`'s `specificFacts`, never `extracted.memory`,
which remains the unconditional `${label} context: ${note}` template,
byte-identical before and after this task). Fresh D1 re-read confirmed
both donors' `institutional_memory` values are unchanged from the prior
audit.

**12. People false-positive status.** Re-verified: `details.people`
still returns `["Zman"]`/`["Yahrtzeit"]` for both notes (the bug is
unchanged). Confirmed this does NOT affect either newly-generated
snapshot -- `specificFacts`/`actionableRelationshipSnapshot` never read
from `details.people` at all, and both new snapshot strings were
explicitly checked to contain no `"People mentioned"` text. Per
explicit instruction, since the bug does not affect the new snapshot's
correctness, it is left untouched and remains a separate, already-
recorded open task.

**13. outcome/route.ts confirmation.** Not touched, not re-investigated
beyond what the prior task already confirmed; still a separate,
recorded open task.

**Pre-write CAS verification for the historical preview (fresh reads,
immediately before generating the preview).** Both donors and both
source interactions re-read fresh from D1: identical to every prior
read in this donor pair's investigation (same malformed
`relationship_summary`, same good `institutional_memory`, same
`updated_at`, interactions still `created_at == updated_at`, unedited).
No discrepancy -- proceeded to preview generation. **No D1 write of any
kind was made for either donor or interaction in this task.**

**Files changed.** `lib/capture/interaction.ts` (the two extraction
additions), `package.json` (test wiring), `tests/relationship-snapshot-
yahrtzeit-zman.test.mjs` (new).

**Confirmation: no D1 writes, no deploy.** Every D1 interaction in this
task was a `SELECT` (fresh re-reads) via `wrangler d1 execute
--remote`. The extraction code change is committed to the feature
branch but was NOT deployed to Independent Staging in this task (no
`wrangler deploy` was run). `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`) throughout. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Exact approval needed next.** (1) Approve the exact previewed
`relationshipSummary` values above for Zachter and Semmelman before any
historical D1 write is made (this task stops at preview, per explicit
instruction); (2) approve deployment of the extraction change itself to
Independent Staging (not done in this task); (3) `meeting-brief-
model.ts`'s people-mention leak and `outcome/route.ts`'s ungated-write
gap remain separate, explicitly out-of-scope, open tasks -- no action
requested on them here.

**UPDATE 2026-08-20 -- DEPLOYED AND APPLIED.** All three approvals
granted: deploy, live-verify, and apply both historical repairs. See
"Zman/Yahrtzeit Deployment + Historical Repair -- APPLIED (2026-08-20)"
below for the full report. Both donors' `relationship_summary` is now
fixed; `institutional_memory`, `relationship_health`, and both source
interactions are unchanged.

## Zman/Yahrtzeit Deployment + Historical Repair -- APPLIED (2026-08-20)

Executes the three approvals from the prior task: (1) deploy commit
`c29590a` to Independent Staging; (2) live-verify Yahrtzeit/Zman capture
behavior without contaminating real donor history; (3) apply the two
reviewed historical `relationship_summary` replacements via
compare-and-swap.

**1. Pre-deploy gates.** Re-ran `pnpm test` (exit 0, all suites `fail
0`), `pnpm exec tsc --noEmit` (clean), `pnpm run build:staging-
independent` (succeeded) immediately before deploying -- all still
passing on the already-committed `c29590a`.

**2. Deployment.** `pnpm run deploy:staging-independent` (`wrangler
deploy --config wrangler.staging.jsonc`), started 2026-08-21T01:37:04Z.
**Worker version `e02f2b81-270d-419e-90d7-3a76d36c5e17`**, deployed git
SHA `c29590a`. No D1 schema/data, R2, workflow, CPU-limit, or
account-setting change; production untouched.

**3. Live capture-behavior verification (no donor contamination).** Same
technique as the original grandchild-fix verification: `/capture`'s
preview is computed entirely client-side from note/type/subject with no
`donorId` dependency, so every check below was done with no donor
selected and `Save interaction` never clicked -- zero persistence by
construction. On the real deployed bundle:
- Semmelman's actual Yahrtzeit note ("Sent text on wife's Yahrtzeit to
  acknowledge it.") now correctly offers the "Use this relationship
  snapshot" checkbox with that exact text as the preview.
- Zachter's actual Zman-appreciation note ("Texted video from first day
  of Zman and thanked him for his support that makes it happen.") also
  correctly offers the checkbox with that exact text.
- A Zman-only negative control ("Sent video from first day of Zman.")
  correctly shows "No meaningful relationship details detected." -- no
  false positive, confirming broadcast-safety live, not just in tests.
- Zero console messages/errors across every interaction.

**4. Historical repair -- pre-write CAS verification (fresh reads,
immediately before writing).** Both donors and both source interactions
re-read fresh from D1: identical to every prior read in this
investigation (same malformed `relationship_summary`, same good
`institutional_memory`, same `relationship_health` (86), same
`updated_at`, interactions still `created_at == updated_at`, unedited).
Baseline snapshot for the "no other row changed" check: 248 donors, 9
with non-null `relationship_summary`, 12 with non-null
`institutional_memory`, 68 interactions, 5 recommendations. All
preconditions held for both donors -- proceeded.

**5. The writes.** Two independent, single-statement, compare-and-swap
`UPDATE`s (not a batch), each executed via `wrangler d1 execute
fundraising-os-staging-db --remote --config wrangler.staging.jsonc
--json --command`, each gated on the donor's id + `owner_user_id` +
`data_source = 'live'` AND `relationship_summary` still equal to the
exact, byte-for-byte malformed value previously reviewed (a
compare-and-swap against the OLD value, unlike donor 987's earlier
null-to-value CAS which gated on `IS NULL`). Values containing embedded
newlines were hex-encoded (`CAST(X'...' AS TEXT)`), matching this
repo's own established convention in `scripts/relationship-summary-
cleanup-preview.mjs`'s `sqlLiteral()` (embedding a literal newline in a
`--command` shell argument breaks Windows argument parsing). Only
`relationship_summary` and `updated_at` were ever assigned in either
statement -- `institutional_memory`, `relationship_health`,
`interactions`, `recommendations`, and every other table/column were
never referenced in either write.

- Zachter (`19af69d6-f147-474b-88ad-f6358ff65b9a`): D1 response
  `"changes": 1, "rows_written": 1` -- exactly the intended row.
- Semmelman (`5c35437c-4b08-4c05-8c65-bb3eb95e06aa`): D1 response
  `"changes": 1, "rows_written": 1` -- exactly the intended row.

**6. Post-write verification (direct D1 reads).**
- Zachter's `relationship_summary` = `"Texted video from first day of
  Zman and thanked him for his support that makes it happen."` --
  exact byte match to the approved value.
- Semmelman's `relationship_summary` = `"Sent text on wife's Yahrtzeit
  to acknowledge it."` -- exact byte match to the approved value.
- Both donors' `institutional_memory` re-read: byte-for-byte identical
  to the pre-write read -- untouched.
- Both donors' `relationship_health`: still `86` for both -- untouched.
- Both source interactions re-read: every column (`type`, `source`,
  `occurred_at`, `shared_activity_id`, `role`, `created_at`,
  `updated_at`, `summary`) byte-for-byte identical to the pre-write
  read -- untouched.
- Baseline counts re-checked: donor count still 248, `relationship_
  summary` non-null count still 9 (replaced content on already-non-null
  rows, so the count itself doesn't change), `institutional_memory`
  non-null count still 12, interaction count still 68, recommendation
  count still 5 -- **exactly two donor rows changed, nothing else.**

**7. Donor-page / Suggested Action verification.** Navigated to both
donor pages on Independent Staging:
- Zachter (`/donors/19af69d6-...`): Relationship Snapshot now shows
  "Texted video from first day of Zman and thanked him for his support
  that makes it happen." Suggested Action now reads "Reach out and
  reference: Texted video from first day of Zman and thanked him for
  his support that makes it happen." -- the old "Latest discussion
  topics: .../People mentioned: .../Recommended next action: ..." text
  is gone from both the snapshot card and the Suggested Action card.
- Semmelman (`/donors/5c35437c-...`): Relationship Snapshot now shows
  "Sent text on wife's Yahrtzeit to acknowledge it." Suggested Action
  now reads "Reach out and reference: Sent text on wife's Yahrtzeit to
  acknowledge it." -- same confirmation, malformed text gone from both
  surfaces.
- Zero console errors on either page load.

**8. Kept open, per explicit instruction -- not touched in this task:**
(1) `Zman`/`Yahrtzeit` still misdetected as "people" by
`mentionedPeople()` (confirmed not affecting either new snapshot,
already recorded); (2) `app/api/interactions/[id]/outcome/route.ts`
still writes `relationship_summary`/`institutional_memory` with no
`acceptRelationshipSnapshot` gate (already recorded). Both remain
separate, open, unscoped tasks.

**Confirmation: exactly two donor rows changed, nothing else.** No
other donor, no interaction, no recommendation, no reminder, no giving
data, no schema was touched. No `main` merge, no production access.
`origin/main` unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`)
throughout. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

## Outcome-Route Acceptance-Gap Investigation (2026-08-21) -- INVESTIGATION ONLY, NO CODE/D1/DEPLOY CHANGE

Full investigation of the previously-recorded open finding: `app/api/
interactions/[id]/outcome/route.ts` can write `relationship_summary`/
`institutional_memory` without the explicit-acceptance gate the main
capture route enforces. Read-only throughout -- no code, D1, schema, or
deployment changed.

**1. Every caller of the outcome route, traced through the real UI.**
`POST /api/interactions/[id]/outcome` has exactly ONE caller in the
entire codebase: `app/interactions/[id]/outcome/OutcomeExperience.tsx`
(verified by grepping every `fetch` call against this literal path).
Three UI entry points navigate a user TO that page (never call the API
directly):
- `app/components/ActivityActions.tsx` -- "Edit outcome" link, shown for
  any non-scheduled (already logged/completed) single-donor interaction
  on a donor page.
- `app/donors/[id]/UnifiedRelationshipTimeline.tsx` -- "Log Outcome" link
  for any `scheduled` timeline item, and "Edit or reopen" for any
  `cancelled` item. **Rendered unconditionally regardless of
  `shared_activity_id`** -- see finding 1a below.
- `lib/workspace/live-data.ts` -- Today's schedule builds a
  `logOutcomeHref` pointing to the same page for any scheduled activity.

**User workflow.** The outcome page (`OutcomeExperience.tsx`) shows two
plain textareas -- "Activity notes" and "Outcome / result" -- a
completed-date picker, an optional follow-up toggle, and a "Close
Activity"/"Save Outcome Changes" button. **There is no Relationship
Snapshot preview anywhere on this page** -- no `useMemo` computing
`extractInteraction()` client-side (unlike `CaptureExperience.tsx`'s
`preview = useMemo(() => extractInteraction(...), ...)`), no "Use this
relationship snapshot" checkbox, nothing shown to the user about what
will be written to `relationship_summary`/`institutional_memory`. The
request body sent (`{ action, auditId, outcome, notes, completedAt,
rescheduledAt, followUpEnabled, followUpType, followUpSubject,
followUpNotes, followUpAt }`) **has no `acceptRelationshipSnapshot`
field at all, in the UI or the server's `OutcomeBody` type.**
Relationship extraction happens **only server-side**, and only at the
moment of submission -- the user never sees it before it's written.

**1a. Finding: shared/multi-donor interactions CAN reach this path.**
Proven from `lib/workspace/scheduled-activity.ts`: `isScheduledActivity`/
`activityStatus` are computed purely from `source`/`occurredAt`/
`createdAt`, with **no dependency on `shared_activity_id`**. The shared
route (`app/api/interactions/shared/route.ts`) sets `occurredAt` from
`body.occurredAt` with no restriction against a future date, so a
shared/broadcast-captured interaction CAN show status `scheduled` for an
individual recipient. `UnifiedRelationshipTimeline.tsx`'s "Log Outcome"
link renders for `scheduled` items **regardless of
`activity.shared_activity_id`** (the shared-vs-single branch only
affects the separate edit/cancel controls below it, not this link). If
such an interaction is later completed via this page, `ownedActivity()`
in the outcome route operates on that one interaction row and writes
straight to that one recipient's `donors` row -- **bypassing the shared
route's own explicit, documented guarantee that shared/broadcast
activities never touch `relationship_summary`/`institutional_memory` for
any recipient.** Not observed in real staging data (see finding 3), but
a real, code-proven gap, not theoretical.

**2. Comparison with the main capture path.** `app/api/interactions/
route.ts` gates its write with `if (!scheduled && body.
acceptRelationshipSnapshot === true)` (unchanged from prior
investigations); the client only ever sends that flag `true` when the
user has checked a box AND the locally-computed preview is non-null.
`app/api/interactions/[id]/outcome/route.ts` has **no equivalent
protection under any name** -- its write (lines 125-130) is gated only
on `nextStatus === "completed" || nextStatus === "no-response"`, which
covers BOTH the "complete" action button and the "No response" button.

**Comparison finding, not previously documented: the codebase already
has a SAFE pattern for this, elsewhere.** `app/api/interactions/[id]/
route.ts` (the single-donor EDIT route -- distinct from the outcome
route) does two things the outcome route does neither of:
- Requires `body.acceptRelationshipSnapshot === true` before touching
  either field at all (line 87-91), same gate/name as the capture route.
- Even when accepted, never blindly overwrites: `contextStatement()`
  (line 35-41) issues `UPDATE donors SET relationship_summary = CASE
  WHEN relationship_summary = <exactly what THIS interaction previously
  contributed> THEN <new value> ELSE relationship_summary END` -- a real
  compare-and-swap that only replaces the donor's stored value if it
  still equals what this specific interaction produced, and otherwise
  leaves it untouched. The `DELETE` (archive) handler in the same file
  calls the same helper when archiving an interaction, replacing the
  donor's context with the *next most recent* interaction's own
  extraction rather than nulling it. This exact machinery is reusable.

**3. Real-world exposure -- read-only D1 audit of Independent Staging.**
- Interactions with `source LIKE '%capture-completed:%'` (i.e. ever
  closed via this route's "complete"/"no-response" action): **0**.
- `activity_status_audits` rows, ANY action (`complete`, `no-response`,
  `cancel`, `reschedule`, `reopen`, `undo`): **0 total**.
- Interactions currently in `scheduled` status: **0** -- nothing is even
  currently eligible to go through this workflow.
- Source-prefix distribution across all 68 interactions: `manual` (40,
  shared route), `capture` (8), `cancelled` (8), `archived` (7),
  `import-monday:confirmed` (5) -- the `cancelled`/`archived` rows come
  from the separate, simpler `DELETE /api/interactions/[id]` route (no
  `activity_status_audits` write, confirmed by reading that route), not
  from the outcome route.
- **Conclusion: this workflow has never been exercised on Independent
  Staging.** No currently-stored `relationship_summary`/
  `institutional_memory` value can be traced to it -- both malformed
  historical values fixed in the prior task came from `source =
  'capture:text'`/`'capture:personal'` (the main capture route), not
  this one. **No malformed historical data was produced through this
  path.** This is a real, latent, code-proven bug with zero actual
  historical damage so far -- it activates the first time a fundraiser
  schedules a future activity and later closes it out.

**4. Reproduction (real `extractInteraction()`, no D1, no real donor).**
Simulated a donor with a good, previously-accepted
`relationship_summary`/`institutional_memory` (a real grandchild
bar-mitzvah note, matching this app's own established good-output
pattern), then simulated completing an unrelated, routine scheduled
activity ("Called to confirm he's coming to the dinner. Outcome:
Confirmed, will attend.") through the outcome route's exact extraction
call (`extractInteraction(`${notes}\nOutcome: ${outcome}`, kind,
subject)`, same template as route.ts line 127). Result: both fields were
overwritten with the new, unrelated, lower-quality content -- **the
prior good, explicitly-accepted content was destroyed**, with no
opportunity for review. A second reproduction with a fully generic note
("Left a voicemail. Outcome: No answer.") produced
`relationshipSummary: null` -- confirming the route's unconditional
write would, in that case, **silently NULL OUT** an existing good
`relationship_summary` entirely, while still overwriting
`institutional_memory` with generic boilerplate. **Answer: yes, the
donor's relationship fields are updated (and can be destroyed) with zero
explicit approval, in every outcome-completion, regardless of what the
extractor finds.**

**5. Snapshot vs. Institutional Memory semantics in this route.** Both
fields are written **together, in a single unconditional statement**
(line 128-129) -- there is no independent-write path for either field.
`extracted.relationshipSummary` can be `null` (from
`actionableRelationshipSnapshot`) and gets written as `NULL` verbatim;
`extracted.memory` is never null (the unconditional `${label} context:
${note}` template) and always overwrites. **Neither field's previous
value is preserved when extraction returns null or produces different
content -- both are unconditionally replaced every time.** Confirmed via
reproduction (4): **completing ANY scheduled/reopened interaction for a
donor -- even one utterly unrelated in topic to their existing
Relationship Snapshot -- silently replaces or erases already-good,
previously human-accepted content.** This is not limited to first-time
completion: `OutcomeExperience.tsx`'s "Save Outcome Changes" button
calls the identical `submit("complete")` path for an already-completed
activity being edited, so **every edit of an outcome note re-triggers
the same unconditional overwrite again.**

**6. Recommended fix -- comparison of options (not implemented).**
- **A. Require explicit acceptance in the outcome workflow, matching
  capture.** Would need real UI work, not a bare flag: a client-side
  preview (`useMemo(() => extractInteraction(...))`, mirroring
  `CaptureExperience.tsx`), an accept checkbox, and -- since this route
  can OVERWRITE existing content rather than only ever adding to an
  empty field -- the UI arguably needs to show what's currently stored
  so the user knows what they'd be replacing. Server-side: add
  `acceptRelationshipSnapshot` to `OutcomeBody`, gate the write on it
  (matching the capture route's exact condition name), and reuse
  `contextStatement()`'s existing CAS pattern instead of the current
  blind `UPDATE` (so even an accepted write can't clobber a value that
  changed since the page loaded).
- **B. Stop the outcome route from writing these fields at all, until a
  real review/accept UI exists.** Delete the unconditional write block
  (lines 125-130) entirely. Given finding 3 (zero historical use, zero
  currently-scheduled interactions), this costs nothing today and
  immediately satisfies the governing rule ("AI/extracted Relationship
  Snapshot content must not be persisted as donor relationship knowledge
  without explicit user review and acceptance") with the smallest
  possible code change -- a deletion, not new code. Institutional
  memory's own doc comment already treats it as equally
  "human-reviewed, AI-suggested-then-accepted" as relationship_summary
  (`lib/relationships/recommendation-evidence.ts`), so there is no
  principled basis for exempting it from the same requirement.
- **C. Differential treatment (write institutional_memory unconditionally,
  gate only relationship_summary).** Considered and set aside: nothing
  in the codebase treats `institutional_memory` as a lower-trust,
  always-overwritable log -- every other write path (capture, edit,
  archive) treats both fields as a single accepted-together pair, and
  the existing `contextStatement()` CAS logic already protects both
  identically. Introducing a new asymmetric rule here would be
  inconsistent with the rest of the architecture, not smaller.

**Recommendation: B now, A as a scoped follow-up if the product wants
outcome notes to be able to update relationship knowledge.** B directly,
minimally satisfies the governing rule today with zero current-data
risk (finding 3); A is the natural richer capability to build later,
reusing the CAS machinery that already exists in `[id]/route.ts` rather
than inventing something new.

**7. Regression requirements for an eventual fix (defined, not
written).** No test currently asserts anything about `relationship_
summary`/`institutional_memory`/`acceptRelationshipSnapshot` for this
route -- confirmed by reading the existing `tests/activity-outcome.
test.mjs` in full; this is genuinely untested behavior today. A fix
would need:
1. Completing a scheduled interaction (via either action `complete` or
   `no-response`) without any acceptance step does not modify
   `relationship_summary`/`institutional_memory` at all (fixture donor
   with pre-set values; assert unchanged after the route runs).
2. If an accept flow is built (Option A): accepting writes exactly the
   previewed content, and only when explicitly accepted -- mirroring
   `tests/capture.test.mjs`'s existing structural check of the main
   route's `acceptRelationshipSnapshot === true` gate.
3. An existing good `relationship_summary`/`institutional_memory` is
   never silently replaced by completing an unrelated interaction --
   direct regression coverage for reproduction (4)/(5) above.
4. Ordinary completion/no-response/cancel/reschedule/reopen/undo
   behavior, `activity_status_audits` inserts, and the old-reminder
   deletion are unaffected by the fix (re-run of the existing
   `tests/activity-outcome.test.mjs` suite, which the fix must not
   break).
5. Follow-up creation (`followUpEnabled`) still works unchanged.
6. No regression to `POST /api/interactions` (main capture) --
   `tests/capture.test.mjs` must keep passing unmodified.
7. A shared/multi-donor-originated interaction that reaches `scheduled`
   status and is later completed via this route must NOT write
   `relationship_summary`/`institutional_memory` for that donor either --
   new coverage closing finding 1a, extending the shared route's own
   "never touches these fields" guarantee through this path too.

**8. Scope discipline maintained.** Did not touch the "Zman"/"Yahrtzeit"
people-extraction false positive (separate, already-recorded open
task). Did not reopen or modify the completed malformed-snapshot
cleanup (Zachter/Semmelman, already applied and verified). Did not
modify recommendation logic. No code, D1, schema, or deployment change
of any kind in this task -- every finding above came from reading source
files and read-only `SELECT` queries via `wrangler d1 execute --remote`.

**Confirmation.** `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Exact approval needed next.** A decision between Option B (recommended:
stop the unconditional write now, smallest change, zero current-data
risk) and Option A (build the full review/accept UI now, larger scope)
-- or explicit confirmation to leave this open pending further product
input. No implementation should begin until one option is chosen.

**UPDATE 2026-08-21 -- OPTION B IMPLEMENTED, TESTED, DEPLOYED, LIVE-
VERIFIED.** See "Outcome-Route Fix -- Option B Implemented + Deployed
(2026-08-21)" below for the full report.

## Outcome-Route Fix -- Option B Implemented + Deployed (2026-08-21)

Implements Option B from the investigation above: removed the
unconditional `donors.relationship_summary`/`institutional_memory`
write from `app/api/interactions/[id]/outcome/route.ts` entirely.

**Implementation.** Deleted the write block (the old lines ~125-130:
`if (nextStatus === "completed" || nextStatus === "no-response") { ...
extractInteraction(...) ... UPDATE donors SET relationship_summary =
..., institutional_memory = ... }`), replaced with an explanatory
comment describing why (Option B, not a gate) and what re-adding this
capability would require (real preview/accept UI + the
`contextStatement()` CAS pattern from the sibling edit route). Removed
the now-unused `extractInteraction` import; kept the `InteractionKind`
type import (still used for the follow-up-type validation) and `kinds`
(unchanged). Nothing else in the route changed -- interaction
status/source/summary updates, `activity_status_audits` inserts,
follow-up creation, the old-recommendation delete, undo handling, and
the compare-and-swap on `results[0].meta?.changes` are all byte-for-byte
untouched.

**Regression tests.** New `tests/outcome-route-relationship-write-
removed.test.mjs` (wired into `package.json`), following this repo's
established convention for route-level behavior (structural assertions
against the route source, since `env` from `cloudflare:workers` can't be
invoked outside a Workers runtime -- confirmed no existing test in this
repo does otherwise). Combines structural proof with the real
`extractInteraction()` function run against the investigation's own
realistic notes, so the test grounds "no write statement exists" in
"here's concretely what it would have written." Covers: no `UPDATE
donors SET relationship_summary` statement (or any SQL referencing
either field) anywhere in the route; no `extractInteraction` import;
reproduction of both the investigation's overwrite scenario (a routine
note that extracts unrelated content) and its null scenario (a note
that extracts nothing) as sanity checks that these are real, still-live
risks the removal protects against; confirmation `ownedActivity()` has
no shared-activity special-casing (the fix closes that gap structurally,
not by adding a new exclusion); and unchanged-behavior assertions for
the interaction-row update, `capture-completed:`/no-response source
generation, status transitions, outcome-note persistence into the
interaction's own summary, audit logging, old-recommendation deletion,
follow-up creation, reopen/undo handling, and the stale-update
compare-and-swap. Also re-confirms the main capture route's own
`acceptRelationshipSnapshot` gate is unaffected. `pnpm test` (all
suites, including the existing `tests/activity-outcome.test.mjs`,
unmodified and still passing): exit 0, every suite `fail 0`. `pnpm exec
tsc --noEmit`: clean (no unused-import errors after removing
`extractInteraction`). `pnpm run build:staging-independent`: completed,
full route manifest, no errors.

**Commit and deployment.** Committed `e20e10d`, pushed to
`feature/independent-cloudflare-sandbox`. Deployed via `pnpm run
deploy:staging-independent`, started 2026-08-21T03:07:18Z. **Worker
version `c73b2bf3-5283-435e-aabc-a2bb918a1f0f`**, deployed git SHA
`e20e10d`. No asset upload needed (server-only change). No D1 schema
change, no production access.

**Live verification (real deployed endpoint, real donor, fully cleaned
up afterward).** No safe disposable donor exists (confirmed in an
earlier task), so this used donor 60830 (Zachter) -- chosen deliberately
because his exact `relationship_summary` was already known precisely
(the real, just-repaired good value from the prior grandchild/Zman
task), making this the most direct possible proof that the fix protects
real, already-good content, not just a synthetic fixture:
1. Created a real, genuinely future-dated (`2026-08-25 12:00 PM`)
   scheduled `call` interaction for Zachter via the actual `/capture`
   UI, clearly labeled as a test in its note text.
2. (An accidental manual click cancelled it during this process --
   unrelated to the fix; reopened it via a direct `fetch()` call to the
   same API endpoint the "Reopen activity" button uses, to avoid
   triggering the page's `window.confirm()` dialogs through automated
   clicks.)
3. Completed the activity via a direct `fetch()` POST to `/api/
   interactions/8b7234a9-.../outcome` (same authenticated session, same
   deployed route -- `window.confirm()` is a client-side UX guard only,
   not enforced server-side, so this exercises identical server logic to
   clicking the real button) with `action: "complete"` and an outcome
   note ("Confirmed, will attend the dinner.") chosen because it
   contains "dinner" -- a real `FACT_SIGNAL_PATTERN` word -- specifically
   to prove the fix holds even when the note WOULD have extracted
   content under the old code, not just when extraction happens to
   return null.
4. **Result: `donors.relationship_summary`/`institutional_memory`/
   `relationship_health`/`updated_at` for Zachter were completely
   byte-for-byte unchanged after completion** -- `updated_at` identical
   to the pre-test read (`1787276491`), still the exact grandchild/Zman
   snapshot from the prior task. Meanwhile the interaction itself
   behaved completely normally: reopened `cancelled -> scheduled`,
   completed `scheduled -> completed`, correct `capture-completed:...`
   source, outcome note correctly appended into the interaction's own
   summary, both actions correctly logged in `activity_status_audits`.
   **This is the exact scenario the investigation's reproduction warned
   about, now proven fixed on the real deployed Worker.**
5. **Cleanup:** deleted the 2 test `activity_status_audits` rows and the
   1 test interaction directly via D1 (not a route call -- these were
   fabricated for the test, not real donor history). Re-verified after
   cleanup: Zachter's donor row unchanged, his interaction list back to
   exactly the 1 real interaction, global `interactions`/
   `activity_status_audits` counts back to the exact pre-test baseline
   (68 interactions, 0 audits). No console errors at any point.

**Confirmation.** No D1 schema change, no historical-data repair, no
production access. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). This task's implementation
matched the investigation's own findings exactly -- nothing discovered
that contradicted or required broadening the fix beyond Option B as
scoped. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Status: the outcome-route acceptance-gap issue is now closed.**
Rebuilding a full review/accept capability for outcome notes (Option A)
remains a separate, unscoped future task if wanted.

## People-Extraction False-Positive Investigation and Fix (2026-08-21) -- CODE CHANGED, NO D1 WRITE, NOT DEPLOYED

Investigates and fixes the known false-positive where `mentionedPeople()`
in `lib/capture/interaction.ts` misreads capitalized non-person words
(`Zman`, `Yahrtzeit`) as donor names. Separate from Relationship
Snapshot extraction (`FACT_SIGNAL_PATTERN`/`ZMAN_APPRECIATION_PATTERN`
are untouched) -- that work is not reopened.

**Phase 1 -- trace.** `mentionedPeople()` is a pure regex function: it
matches every run of capitalized words (`\b\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}
[\p{L}'’-]*)*`) in the note and treats each as a candidate name unless it
hits an exclusion (`NON_NAME_WORDS` exact-match set,
`ORG_TYPE_TEST` for institution words, or `VERB_FOLLOWER_PATTERN` for a
lone word followed by "about/regarding/with/via"). No AI, no NER, no
persistence -- `people` is computed fresh every time
`relationshipSnapshotDetails()` runs, and is never written to D1
(confirmed: no `people`/`mentioned` column anywhere in `db/schema.ts`,
no `INSERT`/`UPDATE` referencing it anywhere in the app). The ONLY
consumer of `.people` in the entire codebase is
`lib/relationships/meeting-brief-model.ts`'s `peopleMentioned`, rendered
on `app/donors/[id]/meeting-brief/page.tsx` under "PEOPLE MENTIONED /
Names to remember" -- confirmed by grep, zero other references.
Relationship Snapshot, Institutional Memory, Suggested Action, Today,
Assistant, and the donor page's stored fields are all unaffected --
`specificFacts`/`actionableRelationshipSnapshot` never read `.people`,
and `recommendation-candidates.ts` (which feeds Suggested Action/Today/
Assistant) never calls `mentionedPeople()` at all. "Zman"/"Yahrtzeit"
qualify purely because they're capitalized and hit no exclusion --
capitalization alone is the evidence of personhood in this design; there
is no name dictionary, no context understanding of what the word means.

**Phase 2 -- read-only corpus audit.** Fetched all 13 real single-donor-
capture/import interaction notes (`source LIKE 'capture:%'` or
`'capture-completed:%'`/`'capture-scheduled:%'`/`'import-monday:%'`) and
ran the real `mentionedPeople()` against each. Found a broader class
than the two known examples:

| Term(s) extracted | Real source note | Donor |
|---|---|---|
| `Yahrtzeit` | "Sent text on wife's Yahrtzeit to acknowledge it" | Semmelman (72957) |
| `Zman` | "Texted video from first day of Zman and thanked him..." | Zachter (60830) |
| `Discussed Kollel` | "Discussed Kollel donation and said to follow up after succos" | Weinschneider (68390) |
| `Dropped` | "Dropped off bottle of schnaps for son's bar mitzvah" | Danziger (63618) |
| `Imported`, `Source` | "Imported from Monday.com pipeline export. Source due date: ..." | all 5 Monday-imported donors |

`Imported`/`Source` come from a machine-generated provenance line the
Monday import route appends to every imported interaction's summary
(`app/api/import/monday/commit/route.ts`) -- not donor-authored text at
all. The task's own broader candidate list (Shabbos, Yom Tov, Purim,
Pesach, Sukkos, Chanukah, Rosh Hashanah, Torah, Beis Medrash, Mechina,
Campaign) was checked against this same real corpus and **none of them
actually appear** -- not added, per the explicit instruction to use
evidence, not a speculative blacklist. "Dinner" was already excluded
before this task (already in `NON_NAME_WORDS`). All findings above are
currently live/visible on Meeting Brief for the affected donors.

**Phase 3 -- root cause class.** **B (capitalization treated as
sufficient evidence of personhood) compounded by A (the exclusion list
and how it's applied were both incomplete)** -- not a bad regex needing
a rewrite, not a case for real NER. Two structural gaps, not just
missing words, were found and proven with real notes:
1. A multi-word capitalized span is checked only as a WHOLE string
   against `NON_NAME_WORDS` -- a leading excluded word doesn't stop the
   rest of the span from being swallowed into one "name". Proven:
   "Discussed Kollel" (from Weinschneider's real note) was extracted as
   a single fabricated person, even though "Discussed" alone was already
   correctly excluded.
2. `VERB_FOLLOWER_PATTERN` ("word followed by about/regarding/with/via")
   was applied to any single-word match anywhere in the note, not just a
   sentence-initial one -- contradicting its own code comment, which
   explicitly says this was only ever meant to catch a verb "AT THE
   START OF A SENTENCE". Proven: "Spoke with Yaakov about the new Zman"
   dropped "Yaakov" too, since "about" happens to follow it mid-sentence
   in the object position of "with" -- not a disposition verb at all.

**Phase 4 -- false-negative risk, proven before implementing.** Ran
every case the task specified against the CURRENT (pre-fix) code first,
to establish the real baseline rather than assume: "Spoke with Yaakov
about the new Zman." incorrectly produced `people: ["Zman"]` (Yaakov
already missing, independent of this task); "Called David on his wife's
Yahrtzeit." incorrectly produced `["Called David", "Yahrtzeit"]`; "Met
Rabbi Cohen at the Yeshiva." incorrectly produced `["Met Rabbi Cohen"]`.
All three are the SAME two structural gaps above, not new problems --
fixing them was necessary to meet this task's own required acceptance
cases, not scope creep.

**Phase 5 -- implementation decision: IMPLEMENT.** Narrow, deterministic,
evidence-backed. `lib/capture/interaction.ts` changes:
- Added `"Dropped"` to `COMMUNICATION_ACTION_VERBS` (same category/
  reasoning as its existing entries).
- Added a new closed, evidenced `JEWISH_CALENDAR_AND_COMMUNAL_TERMS`
  list: `["Zman", "Yahrtzeit", "Kollel"]` -- each tied to a real source
  note in the comment, matching this file's existing convention for
  named closed categories (`MODAL_VERBS`, `DAYS_OF_WEEK`,
  `INDEFINITE_PRONOUNS`).
- Added a new closed `IMPORT_PROVENANCE_WORDS` list: `["Imported",
  "Source"]`, with a comment identifying the exact template text and
  route responsible.
- Fixed `mentionedPeople()` itself (not just the word list): strips
  leading `NON_NAME_WORDS` tokens from a multi-word match before
  evaluating it (`while (words.length > 1 && NON_NAME_WORDS.has(words[0]))
  words = words.slice(1)`) -- fixes "Discussed Kollel"/"Met Rabbi Cohen"
  without weakening genuine two-word names, since a real name has no
  excluded leading word to strip.
- Restricted `VERB_FOLLOWER_PATTERN`'s check to a sentence-initial match
  only (start of note, or immediately after `.`/`!`/`?`/newline) --
  matching the pattern's own already-documented intent, not a new
  behavior.

**Phase 6 -- required acceptance cases, all confirmed exactly as
specified:**
| Note | Result |
|---|---|
| Zachter's real note | `people: []` |
| Semmelman's real note | `people: []` |
| "Spoke with Yaakov about the new Zman." | `people: ["Yaakov"]` |
| "Called David on his wife's Yahrtzeit." | `people: ["David"]` |
| "Met Rabbi Cohen at the Yeshiva." | `people: ["Rabbi Cohen"]` |

**Documented edge case, not fixed (no evidence to fix it against).**
"Spoke with Mr. Zman about his pledge." produces `people: ["Mr"]` --
"Zman" is correctly never included (excluded independently by both the
new word-list entry and the existing "about" follower check), but the
period after "Mr." breaks the capitalized-word regex before it can join
"Zman" into one span, leaving "Mr" alone. This is a pre-existing,
unrelated regex limitation (unchanged by this fix) -- and the deeper
concern the task raised (what if "Zman" were someone's real surname?)
is real and openly acknowledged: this rule-based design cannot
distinguish "Zman" the calendar term from a hypothetical "Zman" surname,
exactly the same theoretical risk every other `NON_NAME_WORDS` entry
already carries (e.g. a donor surnamed "Monday" or "Will"). No such case
exists in the real corpus, so nothing further was built against a
hypothetical, per explicit instruction not to over-engineer.

**Phase 7 -- Relationship Snapshot work protected.**
`FACT_SIGNAL_PATTERN` and `ZMAN_APPRECIATION_PATTERN` were not touched
(confirmed: zero occurrences of either name in this task's diff).
Regression-tested directly: Zachter's and Semmelman's
`actionableRelationshipSnapshot()` output and `institutional_memory`
template output are byte-identical before and after this fix. Their
stored D1 values were not read from or written to in this task at all.

**Phase 8 -- historical effect: dynamically derived, no cleanup
needed.** Proven, not assumed: `db/schema.ts` has no `people`/
`mentioned`-related column anywhere, and no write statement anywhere in
the app ever persists `mentionedPeople()`'s output. Meeting Brief
recomputes it fresh from `interactions.summary` on every render.
**Deploying this fix alone (no D1 write) will correct Meeting Brief for
Zachter, Semmelman, Weinschneider, Danziger, and every Monday-imported
donor immediately, with no historical-data repair required or
performed.**

**Phase 9 -- quality gates.** `pnpm test`: exit 0, every suite (existing
and new) `fail 0`, including `tests/capture.test.mjs`,
`tests/relationship-quality.test.mjs`,
`tests/relationship-snapshot-yahrtzeit-zman.test.mjs`, and
`tests/relationship-summary-cleanup-preview.test.mjs` unmodified and
still passing. `pnpm exec tsc --noEmit`: clean. `pnpm run
build:staging-independent`: completed, full route manifest, no errors.

**New regression tests.** `tests/people-extraction-false-positives.test.mjs`
(wired into `package.json`), exercising the real, unmodified extraction
functions: every real corpus false positive now excluded; every Phase
4/6 required legitimate-name case preserved; the existing repo's own
Elena/Maya regression case unaffected; the documented "Mr. Zman" edge
case asserted explicitly (not silently ignored); and Zachter's/
Semmelman's exact `relationship_summary`/`institutional_memory` output
proven byte-identical to before this fix.

**Files changed.** `lib/capture/interaction.ts` (the fix),
`package.json` (test wiring), `tests/people-extraction-false-positives.test.mjs`
(new). `app/api/interactions/[id]/outcome/route.ts` was not touched --
that issue remains closed/separate, per explicit instruction.

**Confirmation: no D1 writes, no deploy.** Every D1 interaction in this
task was a `SELECT` (the corpus audit) via `wrangler d1 execute
--remote`. Per explicit instruction, this task stops before deployment
-- the fix is committed to the feature branch but NOT deployed to
Independent Staging. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Exact approval needed next.** Review of the implementation/audit
result above; approval to deploy this fix to Independent Staging (not
done in this task).

**UPDATE 2026-08-21 -- DEPLOYED AND LIVE-VERIFIED.** See "People-
Extraction Fix -- Deployed + Live-Verified (2026-08-21)" below for the
full deployment/verification report.

## People-Extraction Fix -- Deployed + Live-Verified (2026-08-21)

Deploys the fix committed above (`befa0fb`) and live-verifies it, per
explicit instruction: no additional code changes, no D1 writes/
migrations, no broadening of the extraction rules in this task.

**Pre-deploy gates (re-run, all still passing on `befa0fb`).** `pnpm
test`: exit 0, every suite `fail 0`. `pnpm exec tsc --noEmit`: clean.
`pnpm run build:staging-independent`: completed, full route manifest,
no errors.

**Deployment.** `pnpm run deploy:staging-independent` (`wrangler deploy
--config wrangler.staging.jsonc`), started 2026-08-21T12:40:27Z.
**Worker version `70dd7081-0fb3-4e69-8329-e115685f09fc`**, deployed git
SHA `befa0fb`. No D1 schema change, no production access.

**Live verification -- Meeting Brief, all three real corpus cases.**
- Zachter (`/donors/19af69d6-.../meeting-brief`): "PEOPLE MENTIONED /
  Names to remember" now reads "No additional people are mentioned in
  recent notes." -- `Zman` is gone. Suggested Action and Relationship
  Snapshot still read exactly "Texted video from first day of Zman and
  thanked him for his support that makes it happen." -- unchanged.
- Semmelman (`/donors/5c35437c-.../meeting-brief`): same "No additional
  people..." result -- `Yahrtzeit` is gone. Suggested Action/
  Relationship Snapshot still exactly "Sent text on wife's Yahrtzeit to
  acknowledge it." -- unchanged.
- Weinschneider (`/donors/9a9e3a1f-.../meeting-brief`, the broader
  structural-bug case): same "No additional people..." result --
  `Discussed Kollel` (the fabricated multi-word "person" from the
  leading-verb-stripping bug) is gone, confirming the structural fix is
  live, not just the word-list additions.

**Live verification -- legitimate names still recognized (temporary
test, cleaned up afterward).** No safe disposable donor exists, so this
reused donor 60830 (Zachter). Created a real, non-scheduled `call`
interaction via the actual `/capture` UI with note "TEST
(people-extraction fix live-verify, will be removed): Spoke with Yaakov
about the new Zman and confirmed his pledge." -- deliberately combining
a real name with the fixed term in one sentence, the exact shape of the
Phase 4 false-negative risk. Did not check "Use this relationship
snapshot", so no `relationship_summary`/`institutional_memory` write
occurred (confirmed on-page: "Relationship snapshot unchanged -- The
generated draft was not accepted, so it was not saved."). Zachter's
Meeting Brief "PEOPLE MENTIONED" then correctly showed `Yaakov` (the
real name, preserved) and did NOT show `Zman` -- `TEST` also appeared,
which is expected and not a regression (it's the test label's own
wording, not a real corpus term, and correctly demonstrates the
extractor still treats any unexcluded capitalized word as a candidate
name). Zero console errors throughout.

**Cleanup.** Confirmed Zachter's `relationship_summary`/
`institutional_memory`/`updated_at` were unaffected by the test
(`updated_at` unchanged at `1787276491`) before deleting the test
interaction directly via D1 (not a route call -- fabricated for the
test, not real donor history). Re-verified after cleanup: Zachter's
interaction list back to exactly the 1 real interaction, global
interaction count back to the exact pre-test baseline (68).

**Reconfirmed: Relationship Snapshot unchanged.** Directly observed
live on both Zachter's and Semmelman's Meeting Brief pages above --
identical text to every prior verification.

**Reconfirmed: the outcome-route fix remains intact.** `app/api/
interactions/[id]/outcome/route.ts` was not touched by this task or the
people-extraction fix itself (confirmed: zero diff to that file since
its own dedicated deployment/live-verification in the prior task); this
deployment is strictly additive on top of that already-verified fix, and
`tests/outcome-route-relationship-write-removed.test.mjs` still passed
in this task's pre-deploy gate run.

**Corrected the stale "Current Git State" section** at the top of this
file (previously still showing `0f75ad0` through several subsequent
completed tasks) to reflect the actual current HEAD (`befa0fb`) and
deployed state.

**Confirmation.** No D1 writes beyond the temporary test interaction
(created and then deleted in this same task, net effect zero). No
extraction-rule broadening -- only the deployment and live verification
of the already-committed, already-reviewed fix. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

**Status: the people-extraction false-positive issue is now closed** --
investigated, fixed, tested, deployed, and live-verified.

## Outcome-Note Relationship Snapshot Review/Accept Flow -- Option A -- IMPLEMENTED, TESTED, DEPLOYED, LIVE-VERIFIED (2026-08-21)

Approved by explicit user instruction as the follow-up to "Outcome-Route
Fix -- Option B Implemented + Deployed" above: Option B removed the
outcome route's unconditional relationship-snapshot write entirely (a
safety fix, but a capability regression -- outcome notes could no longer
ever contribute to a donor's Relationship Snapshot at all). This task
restores that capability, but gated behind an explicit review/accept UI
-- the same pattern `CaptureExperience.tsx`/`app/api/interactions/[id]/
route.ts` already use for the main capture form, reused rather than
reinvented.

**Investigation finding, reported per explicit instruction before
writing any destructive code.** The task asked whether the existing
Capture accept flow "intelligently incorporates" a donor's existing
accepted Relationship Snapshot or replaces it outright. Direct inspection
of `CaptureExperience.tsx` and `app/api/interactions/[id]/route.ts`
confirmed: **full replacement is the deliberate, established, existing
behavior everywhere in this codebase already** -- there is no merge/
incorporation logic anywhere; `relationship_summary` is documented (in
code) as reflecting the donor's most recently accepted summary, and both
the main capture route (unconditional replace on accept, no CAS) and the
edit route (CAS-guarded replace) already work this way. Neither Capture
UI shows the donor's *current* value before accepting a replacement --
this task's implementation goes further than existing UI, additively
showing the current stored value alongside the proposal, so an outcome's
higher-risk replacement (of a donor who may already have real accepted
history) is never silent. No materially different architecture was
required; the existing acceptance/CAS pattern was reused as-is with one
adaptation (see below).

**Implementation.**
- `app/api/interactions/[id]/outcome/route.ts`: re-imports
  `extractInteraction`; `ownedActivity()`'s single query now also reads
  `d.relationship_summary`/`d.institutional_memory` alongside the
  interaction row (one round trip, used as both the CAS baseline and,
  via `page.tsx`, the client's "current value" display); `OutcomeBody`
  gained `acceptRelationshipSnapshot?: boolean` (identical name/semantics
  to the capture route's own flag). The write itself sits in a new block
  gated on `(nextStatus === "completed" || nextStatus === "no-response")
  && body.acceptRelationshipSnapshot === true` -- structurally
  unreachable from cancel/reschedule/reopen, since none of those three
  actions ever set `nextStatus` to `"completed"`/`"no-response"`. Inside
  that gate, extraction is re-run **server-side** on the actual submitted
  text (never trusting the client's own preview), and the write only
  proceeds `if (extracted.relationshipSummary !== null)`. The `UPDATE
  donors` statement is a **NULL-safe compare-and-swap** (`relationship_
  summary IS ? AND institutional_memory IS ?`, using `IS` not `=`)
  against the donor row read at the very start of the request --
  deliberately NOT the existing `contextStatement()` CASE-WHEN helper
  from the edit/archive route, since that helper's semantics ("the
  stored value still traces to THIS interaction's own prior
  contribution") don't apply to a first-ever acceptance; a plain
  freshness CAS against the just-read value is the correct analogue
  here, and `IS` (rather than `=`) is required because the common case --
  a donor with no existing snapshot yet -- has a NULL current value,
  which `=` can never match. A failed CAS (concurrent accept elsewhere)
  fails closed: the batch statement itself reports `changes: 0`, surfaced
  to the client as `relationshipUpdated: false` without failing the whole
  request (the activity itself still closes out normally). The write
  reaches exactly `existing.donor_id` -- the one donor already resolved
  from the one interaction id in the URL -- with no `shared_activity_id`
  branch anywhere in the route, so no fan-out to other recipients of a
  shared/broadcast activity is structurally possible.
- `app/interactions/[id]/outcome/page.tsx`: SQL SELECT extended with
  `d.relationship_summary, d.institutional_memory`; passed through to the
  client as `currentRelationshipSummary`/`currentInstitutionalMemory`.
- `app/interactions/[id]/outcome/OutcomeExperience.tsx`: adds a live
  `preview = useMemo(() => extractInteraction(...))` computed from the
  same inputs the server extracts from (`${notes}\nOutcome: ${outcome}`,
  same kind-fallback rule, same subject) -- mirrors `CaptureExperience.
  tsx`'s own pattern exactly. A new `acceptRelationshipSnapshot` state
  defaults `false` (fresh on every page load/edit/reopen -- there is no
  prop or stored value that could pre-check it). The submitted
  `acceptRelationshipSnapshot` is gated identically to Capture:
  `acceptRelationshipSnapshot && preview.relationshipSummary !== null`.
  New UI block (placed where Capture places its own `extraction-preview`
  div, just before the save button): when `preview.relationshipSummary
  === null`, shows "No meaningful relationship details detected." with no
  checkbox at all (matching Capture exactly); otherwise shows the
  donor's **current** stored Relationship Snapshot/Institutional Memory
  (if any) directly above an unchecked "Use this relationship snapshot"
  checkbox and the proposed text -- the additive safety improvement
  beyond Capture's own UI. The post-save confirmation panel now reports
  `relationshipUpdated` honestly, including a distinct message when an
  accepted proposal failed to apply because of a concurrent CAS miss.

**Tests added** (`tests/outcome-relationship-snapshot-accept.test.mjs`,
new; `tests/outcome-route-relationship-write-removed.test.mjs`, updated
in place -- its historical name/git-blame predates this feature, but its
assertions now cover the Option A gate shape rather than asserting the
write is categorically absent, since Option A intentionally restores a
*gated* write). Structural regex assertions against the real route/page/
component source, combined with running the real, unmodified
`extractInteraction()` (never a reimplementation) for concrete scenario
grounding -- the established convention in this repo, since route
handlers need the `cloudflare:workers` `env` binding and a live D1 this
test suite doesn't have. Covers exactly the six scenarios requested:
existing snapshot + accepted proposal (replaces, with the current value
shown first), existing snapshot + rejected proposal (never sent, nothing
written), no meaningful extraction (no checkbox rendered; even a
maliciously-sent `true` flag can't write since the server re-extracts and
gates a second time), editing an outcome (same code path as first close,
fresh unchecked state every load, no pre-checked/inherited acceptance),
reopening an outcome (`nextStatus` becomes `"scheduled"`, structurally
outside the write gate regardless of what the shared request body
carries), and shared-activity-linked interactions (no `shared_activity_id`
branch in the route; the write binds to `existing.donor_id`, the single
donor already resolved for the one interaction id).

**Quality gates (all passing).** `pnpm test`: exit 0, every suite `fail
0` (including the two new/updated files above). `pnpm exec tsc
--noEmit`: clean, zero output. `pnpm run build:staging-independent`:
completed, full route manifest, no errors.

**Commit/push.** `a30316f` ("Add Option A: explicit review/accept flow
for outcome-note Relationship Snapshots") on
`feature/independent-cloudflare-sandbox`, on top of `b72895d`. Pushed;
`origin/feature/independent-cloudflare-sandbox` matches local HEAD
exactly. `origin/main` unchanged throughout
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`).

**Deployment.** `pnpm run deploy:staging-independent` (`wrangler deploy
--config wrangler.staging.jsonc`). **Worker version
`0673c91a-de71-4f29-950b-34f71fc3fbec`**, deployed git SHA `a30316f`. No
D1 schema/migration change, no production access.

**Live verification (Independent Staging, real donors, controlled
interactions, all cleaned up afterward).** No disposable test donor
exists on staging, so this reused Semmelman (`5c35437c-...`, known
baseline `relationship_summary`: "Sent text on wife's Yahrtzeit to
acknowledge it.") and Zachter (`19af69d6-...`, known baseline: "Texted
video from first day of Zman and thanked him for his support that makes
it happen."), plus one synthetic `shared_activities` row linking one
interaction on each donor. Five scheduled interactions inserted directly
via D1 (`optiona-test-accept`, `optiona-test-reject`, `optiona-test-
noextract`, `optiona-test-shared-a`/`-b`), driven through the real
outcome API via authenticated `fetch()` calls executed in-page (`window.
confirm()` in `OutcomeExperience.tsx` blocks automated UI clicks, the
same established workaround as the prior people-extraction live
verification):
- **Accepted proposal, donor with an existing snapshot** (Semmelman,
  `acceptRelationshipSnapshot: true`, note about a granddaughter's bat
  mitzvah): response reported `relationshipUpdated: true`; D1 confirmed
  `relationship_summary`/`institutional_memory` replaced with the
  proposed text, `relationship_health` still 86.
- **Rejected proposal, donor with an existing snapshot** (Zachter,
  `acceptRelationshipSnapshot: false`, note about a son's wedding -- a
  note that does contain a real fact, proving the gate genuinely blocks
  it rather than the note happening to extract nothing): response
  reported `relationshipUpdated: false`; D1 confirmed `relationship_
  summary`/`institutional_memory` byte-for-byte unchanged from baseline.
- **No meaningful extraction** (Zachter again, `acceptRelationshipSnapshot:
  true` deliberately sent despite a fully generic note -- "Left a
  voicemail." / "No answer." -- to prove server-side re-extraction, not
  just client-side gating, blocks the write): response reported
  `relationshipUpdated: false`; D1 confirmed no change.
- **Reopen, then re-edit without re-accepting** (the Semmelman
  interaction): `action: "reopen"` reported `relationshipUpdated: false`
  and D1 confirmed the donor row untouched by the reopen itself; then
  re-completing the same interaction with a note that *would* extract
  (a grandson's engagement) but `acceptRelationshipSnapshot: false`
  reported `relationshipUpdated: false` and D1 confirmed the donor's
  snapshot was still exactly the earlier accepted value -- editing/
  reopening an outcome never silently reapplies or overwrites.
- **Shared-activity fan-out check**: completed and accepted the
  Semmelman-side interaction of the shared pair (`relationshipUpdated:
  true`, D1 confirmed Semmelman's snapshot updated); Zachter's row --
  the other recipient of the identical `shared_activity_id` -- was
  re-queried immediately after and confirmed byte-for-byte unchanged. No
  fan-out.
- **Option B regression reconfirmed live**: every non-accepted completion
  above (reject, no-extraction, re-edit-without-accept) left relationship
  fields completely untouched despite notes containing real, extractable
  content in two of the three cases -- the exact unconditional-write
  danger Option B fixed remains fixed under Option A's gated write.

**Cleanup.** All five test interactions, the synthetic `shared_
activities` row, and their `activity_status_audits` rows deleted directly
via D1. Semmelman's `relationship_summary`/`institutional_memory`
explicitly reverted to the exact original baseline text (Zachter's was
never actually written to, so needed no reversion). Re-verified after
cleanup: both donors' `relationship_summary`/`institutional_memory`/
`relationship_health` match their original baseline exactly; zero rows
remain matching the `optiona-test-%` id prefix in `interactions` or
`activity_status_audits`; zero rows remain in `shared_activities` for the
test id.

**Known limitations.** (1) The compare-and-swap protects against a
concurrent *write* to the donor's relationship fields between page load
and submit, but not against the user's own preview going stale if they
leave the outcome page open a long time without refreshing after someone
else accepts a change elsewhere -- the CAS still fails closed in that
case (confirmed above), it just surfaces as "refresh and try again"
rather than a merge. (2) Like every existing accept path in this
codebase, acceptance replaces `relationship_summary`/`institutional_
memory` wholesale rather than merging old and new text -- this matches
established, deliberate behavior everywhere else (see the investigation
finding above), not a gap specific to this task. (3) No disposable test
donor exists on staging; live verification reused real donor records
(Semmelman/Zachter), fully reverted afterward and re-verified
byte-for-byte against baseline.

**Confirmation.** No production/main access at any point.
`origin/main` unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`).
Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

## Relationship Snapshot Durable-Accumulation Architecture Investigation (2026-08-21) -- INVESTIGATION/DESIGN ONLY, NO CODE/SCHEMA/D1/DEPLOY CHANGE

**Scope.** Explicit user instruction: the product behavior deployed as
Option A above (accepting a proposal REPLACES `donors.relationship_
summary`/`institutional_memory`) is not the long-term desired behavior.
Accepted donor intelligence should *accumulate* over time, with a
synthesized current view, contradiction/supersession handling, and
provenance -- not disappear on the next accept. This section is
investigation and design only. No file outside `docs/` was touched, no
migration written, no D1 write made, nothing deployed.

### What `institutional_memory` actually is today (not assumed -- verified)

Read directly from `extractInteraction()` (`lib/capture/interaction.ts`):
`memory: \`${interactionKindLabel(type)} context: ${note.trim()}\`` --
e.g. "Call context: Spoke with him about his granddaughter's bat
mitzvah." **It is a templated echo of the single most-recently-accepted
interaction's raw note text, nothing more.** It is not, and has never
been, an accumulation layer:
- Every one of the 4 write paths that touch it (below) writes it with
  the exact same replace/CAS semantics as `relationship_summary`, in the
  same statement, at the same time -- there is no code path anywhere
  that treats it differently or appends to it.
- `lib/relationships/recommendation-candidates.ts`'s
  `relationshipOpportunityCandidate()`/`solicitCandidate()` read it only
  as `evidence.narrative.relationshipSummary ||
  evidence.narrative.institutionalMemory` -- a plain OR-fallback used
  only when `relationship_summary` is null. In practice the two fields
  are near-duplicates of each other (same underlying note, two
  templates), not two distinct kinds of information.
- The Assistant (`app/api/assistant/route.ts`) shows both as separate
  labeled context lines ("No relationship summary is available." / "No
  institutional memory is available."), implying to the model that
  they're different information -- they are not, today.

**Conclusion, not assumed: `institutional_memory` is NOT structurally
suitable as the durable accumulation layer as it exists today.** It has
zero internal structure (one opaque string), no per-fact boundaries, no
dates, no source-interaction linkage beyond "whatever was last
accepted," and is overwritten by literally the same statement that
overwrites `relationship_summary`. Turning it into real accumulation
would mean changing its write semantics in all 4 paths to
append-with-a-delimiter -- which immediately hits the data-loss/
supersession problems documented under Approach A below, and would end
up needing per-fact metadata anyway, at which point it has organically
become an unstructured, worse-integrity version of a real facts table
(Approach B/C). A dedicated table is the smaller, not larger, coherent
change once this is followed through.

### All current write paths into `donors.relationship_summary`/`institutional_memory` (verified by direct read, not assumed complete from memory)

1. **`app/api/interactions/route.ts` (Capture, new interaction).**
   Unconditional `UPDATE donors SET relationship_summary = ?,
   institutional_memory = ?, relationship_health = ?, updated_at = ?
   WHERE id = ? AND owner_user_id = ? AND data_source = 'live'` -- **no
   compare-and-swap at all**, gated only on `!scheduled &&
   body.acceptRelationshipSnapshot === true`. Also does not re-verify
   `extracted.relationshipSummary !== null` server-side (relies on the
   client only ever sending `true` when its own preview is non-null,
   per `CaptureExperience.tsx`) -- a pre-existing gap, not introduced by
   this investigation, noted here because any new architecture must
   close it rather than inherit it.
2. **`app/api/interactions/[id]/route.ts` (edit `PATCH` / archive
   `DELETE`).** Uses `contextStatement()`'s `=`-based CASE-WHEN CAS
   (only replaces when the stored value still exactly equals what THIS
   interaction itself had contributed) for edits, and -- **this is a
   real, pre-existing gap worth flagging plainly** -- on **archive**,
   replaces the donor's snapshot with whatever `latestOther()`'s raw
   `extraction()` produces from a *different* interaction's raw text,
   with **no re-acceptance step for that replacement value**. Today,
   archiving an interaction that had contributed to the snapshot can
   silently pull in another interaction's never-explicitly-accepted
   extraction. This violates "human acceptance remains mandatory" for
   the *replacement*, even though removing the archived interaction's
   own contribution is legitimate. Any new architecture must close this,
   not reproduce it.
3. **`app/api/interactions/[id]/outcome/route.ts` (Option A, this
   session).** NULL-safe (`IS`) freshness CAS against the donor row read
   at request start, gated on `nextStatus` genuinely closing the
   activity AND `body.acceptRelationshipSnapshot === true` AND
   server-re-verified `extracted.relationshipSummary !== null`. The
   newest, smallest, best-tested of the four paths (see the section
   above).
4. **`app/api/import/monday/commit/route.ts` (`confirm_contact`
   decision).** A fourth, previously-undocumented-in-this-file write
   path, found by direct grep, not recalled from memory. Per-row
   explicit human confirmation (never bulk, never inferred from text) in
   the Monday import review UI feeds `extractInteraction()` the same as
   Capture, then does an unconditional replace guarded only by
   *recency* (`occurredAt >= latestOther`, the max `occurred_at` across
   the donor's other real interactions) -- not a value-CAS. Confirms
   this is a 4-write-path problem, not 3.

All four independently duplicate the same "extract, gate on explicit
accept, replace the donor row" shape with *different* concurrency
guards (none / `=`-CAS / `IS`-CAS / recency-only) -- itself evidence that
the replace-the-donor-row model has already been reinvented four times
slightly differently, which a shared accumulation layer would collapse
into one.

**Confirmed NOT write paths** (defensive comments read directly, not
assumed): gift acknowledgment, yahrtzeit entry, important-date entry,
and the DOB import commit route all carry explicit "never touches
relationship_summary/institutional_memory" comments and were verified to
contain no write to either column.

### `extractInteraction()` / `relationshipSnapshotDetails()` / `actionableRelationshipSnapshot()`

Pure, deterministic, regex/keyword-based (`lib/capture/interaction.ts`)
-- no AI/NER, no state, no memory of prior calls. `relationshipSnapshot
Details()` finds `specificFacts`: real quoted sentences matching
`COMMITMENT_PATTERN`, `RELATIONSHIP_CHANGE_PATTERN`,
`FACT_SIGNAL_PATTERN`, or `ZMAN_APPRECIATION_PATTERN`, capped at 2 and
deduplicated. `actionableRelationshipSnapshot()` joins them into a
sentence or two, or returns `null` if nothing specific was found --
never a placeholder. This function is reused verbatim by all 4 write
paths above and stays exactly as-is in every architecture considered
below; nothing about the extraction logic itself needs to change to
support accumulation -- only what happens to `specificFacts` *after*
extraction (single-value replace vs. durable per-fact rows) needs to
change.

### Consumers, verified by direct read (not assumed)

- **Meeting Brief "People Mentioned" / "Recent Discussion Topics"**
  (`lib/relationships/meeting-brief-model.ts`) -- **do not read
  `donors.relationship_summary`/`institutional_memory` at all.** They
  are computed live, on every render, by re-running
  `relationshipSnapshotDetails()` directly against the raw `summary`
  text of the donor's last 5 real interaction rows -- completely
  independent of whether anything was ever accepted. This is already an
  existing "derive a current view from source rows at read time"
  pattern in this codebase, just applied to raw interactions instead of
  accepted facts -- directly relevant precedent for the recommended
  architecture below.
- **Meeting Brief / Today / donor page "Suggested Action"**
  (`lib/relationships/recommendation-candidates.ts`'s
  `relationshipOpportunityCandidate()`/`solicitCandidate()`) -- read the
  single `narrative.relationshipSummary || narrative.institutionalMemory`
  string (the ACCEPTED, stored value) and pattern-match it for a
  solicitation phrase. This is the consumer most directly affected by
  losing an old fact to a new accept -- e.g. an old, still-unresolved
  solicitation sentence disappearing from `relationship_summary` when an
  unrelated new fact is accepted currently makes the `solicit`
  recommendation stop firing, even though nothing about the real
  solicitation changed.
- **Assistant** (`app/api/assistant/route.ts`) -- reads
  `donor.relationship_summary`/`institutional_memory` directly as two
  separately labeled context lines fed to the model.
- **Donor page** (`app/donors/[id]/page.tsx`) -- calls
  `sanitizeScheduledRelationshipContext()` (`lib/workspace/scheduled-
  activity.ts`), which exists **only** because there is currently no
  way to know which interaction (if any) produced the current
  `relationship_summary`/`institutional_memory` value -- it has to
  heuristically re-run the extractor against every still-*scheduled*
  (not-yet-happened) activity and hide the stored value if it happens to
  textually match, to avoid showing a snapshot that "looks like" it
  already reflects something that hasn't happened yet. **This function's
  entire existence is evidence for the recommended architecture below**:
  with a real `sourceInteractionId` per fact, this heuristic
  text-matching guess becomes an ordinary join/status check instead.

### Existing durable-fact/audit patterns already proven in this codebase (the precedent for Approaches B/C)

`db/schema.ts` already contains five instances of the same two-table
shape used elsewhere in this app for "a maintained, editable, durable
fact, with its own append-only change history": `asks`/`askChanges`,
`yahrtzeits`/`yahrtzeitChanges`, `important_dates`/`important_date_
changes`, `pledge_payment_plans`/`pledge_payment_plan_changes`, and
`donor_contact_audits` (donor-row-level). **Most directly relevant:
`donor_research_findings`** (Donor Research feature) already implements
almost exactly the "durable facts with supersession" model this task is
asking for, live and tested today: `status: "current" | "superseded" |
"removed_not_found" | "unverified"`, a self-referencing
`supersedesFindingId`, a `fingerprint` for idempotency, and a real
classification function (`lib/research/pipeline.ts`'s
`classifyFindingPlan`-equivalent) that decides `reuse` / `insert` /
`supersede-and-insert` by matching `(category, organizationNormalized)`
against the donor's existing *active* (current/unverified) findings --
never overwriting a row in place, never deleting, always leaving a full
audit trail. This is not a hypothetical pattern to invent; it is
production code in this exact repository solving the same
"accumulate, supersede by category-match, preserve history" problem for
a different kind of fact (research findings instead of interaction-note
facts).

### Approach A -- extend the current donor fields (accumulate in `institutional_memory`, synthesize `relationship_summary`)

- **Data loss risk:** low for raw text (append-only, never deleted) but
  **high in practice**: once N accepted facts are concatenated into one
  blob, there is no clean way to remove or supersede a single sentence
  without fragile substring surgery (exact-text matching against
  whatever separator/formatting convention was used) -- a real
  regression versus today's exact-value CAS, which only works *because*
  there is exactly one value to compare, not N appended fragments.
- **Contradictions/supersession:** no structural representation --
  would require in-band markers inside the text itself (unqueryable, no
  referential integrity, easy to corrupt on edit).
- **Provenance/auditability:** none beyond "appended at some point"
  unless a parallel side-channel of per-sentence metadata is also built
  -- at which point this has become Approach B/C in substance, without
  a real table's integrity guarantees (no FK, no index, no atomic
  supersede).
- **Archiving/editing a source interaction:** cannot cleanly remove that
  interaction's specific contribution from a concatenated blob -- a hard
  blocker on "retain provenance back to the interaction/source."
- **Human acceptance:** mechanically unchanged (still an explicit
  checkbox), but the blob grows unbounded over a donor's lifetime --
  directly violates "preserve history without blindly concatenating
  stale or contradictory sentences," since blind concatenation is
  exactly what this approach does by construction.
- **Impact on existing donor rows:** none required immediately --
  lowest migration friction of the three, on paper.
- **Migration/backfill:** trivial if truly free-text-append, but any
  attempt to add real structure (delimiters, per-entry dates) to avoid
  the problems above converges toward Approach B's shape anyway.
- **Today/Meeting Brief/Assistant impact:** none needed if the column
  keeps holding a single string, but consumers start showing an
  ever-growing, unbounded run-on paragraph without further work.
- **Complexity/maintenance:** deceptively low today; the string-surgery
  problems above push real complexity into ad hoc parsing/regex against
  the blob later -- a false economy.
- **Verdict: not recommended.** Cannot satisfy provenance or clean
  supersession without organically growing into Approach B's shape, but
  without a real schema's integrity guarantees.

### Approach B -- dedicated relationship-intelligence facts/history table

A new `donor_relationship_facts` table: one row per accepted fact
(`id, donorId, userId, category, factText, sourceInteractionId`
nullable FK, `sourceInteractionOccurredAt` (snapshotted at accept time,
so a later edit to the interaction's own date never retroactively
changes when the fact was true), `status: "current" | "superseded" |
"archived_with_source"`, `supersedesFactId` nullable self-reference,
`fingerprint`, `createdAt`/`updatedAt`) plus a matching
`donor_relationship_fact_changes` append-only audit table (identical
shape to `askChanges`/`yahrtzeitChanges`: `action`, `changedFields`,
`beforeJson`/`afterJson`, `createdAt`). `donors.relationship_summary`/
`institutional_memory` become a **synthesized, regenerated view**,
written by a pure function over the donor's current-status facts
(sorted by `sourceInteractionOccurredAt` descending), not accepted
directly.

- **Data loss risk:** very low -- every accepted fact is its own
  immutable row; nothing is ever overwritten in place; "deletion" is
  always a status transition, never a real `DELETE`.
- **Contradictions/supersession:** explicit and auditable --
  `status`/`supersedesFactId`, driven by a category-match rule (see
  worked examples below), never a silent guess.
- **Provenance/auditability:** `sourceInteractionId` +
  snapshotted `sourceInteractionOccurredAt` on every row -- directly
  satisfies "durable facts should retain provenance back to the
  interaction/source that produced them."
- **Archiving/editing a source interaction:** clean, well-defined
  (`archived_with_source` transition; edits never mutate an already-
  accepted fact row -- see worked example 5 below). Structurally fixes
  the pre-existing archive gap in write path #2 above, as a byproduct.
- **Human acceptance:** every write path funnels through one shared
  `acceptRelationshipFact()` helper; UI stays the same explicit,
  default-unchecked checkbox + preview pattern already shipped four
  times over -- only the persistence target changes.
- **Impact on existing donor rows:** requires a one-time backfill --
  see the migration plan below. Zero content loss (today's exact
  current text becomes fact #1), but honest, disclosed provenance loss
  for pre-existing data (no reliable way to reconstruct which
  interaction produced today's value, since today's CAS proves
  freshness, not identity).
- **Migration/backfill:** one new table pair (same shape as five
  existing ones already in `db/schema.ts`) + one backfill script + one
  shared helper, then each of the 4 write paths migrated independently,
  one at a time, each fully gated/tested/deployed on its own -- matching
  this repo's own established incremental-migration discipline (see
  Option A/B's own history above).
- **Today/Meeting Brief/Assistant impact:** **zero required changes** --
  they keep reading `donors.relationship_summary`/`institutional_memory`
  exactly as today; only what populates those columns changes
  (synthesis instead of direct accept). This is the "smallest coherent
  alternative" property explicitly asked for. Richer per-fact display
  (dates, provenance, category) is a real but strictly optional later
  phase.
- **Complexity/maintenance:** a genuinely new table + a synthesis
  function + a shared accept helper -- real, but proportional: the exact
  same shape as five other durable-fact features already shipped and
  load-bearing in this codebase (asks, yahrtzeits, important dates,
  pledge payment plans, donor research findings), not a novel pattern
  being introduced for the first time.
- **Verdict: satisfies every stated requirement.**

### Approach C -- materially better architecture already supported by this codebase

**Same shape as Approach B, realized by directly reusing `donor_
research_findings`'s already-shipped, already-tested supersession
model** (`lib/research/pipeline.ts`) instead of designing classification
logic from scratch: `status` enum, `supersedesFindingId` self-reference,
and a `(category, secondary-key)` match-and-classify function that
returns `reuse` / `insert` / `supersede-and-insert`. Adapted here as
`(category, sourceInteractionId-if-present)`: prefer superseding a fact
from the SAME source interaction (a correction to what was already
said) over one merely in the same category from a different
interaction. This is not a different architecture from B -- it is B,
built by reusing proven, already-tested code paths and data shapes
instead of inventing new ones, exactly what was asked for. **This is
the recommended architecture** (see below): Approach B's schema,
Approach C's reused classification/supersession logic.

### Category taxonomy for supersession matching

Not a new NLP system -- a coarsening of the regex groups
`FACT_SIGNAL_PATTERN`/`COMMITMENT_PATTERN`/`RELATIONSHIP_CHANGE_
PATTERN`/`ZMAN_APPRECIATION_PATTERN` already extract by, into 6 buckets
used only to decide "does this new fact plausibly replace an old one":
`family_milestone` (spouse/son/daughter/grandchild.../wedding/engaged/
birthday/anniversary/yahrtzeit), `solicitation` (proposal/request for
support/funding request/ask amount, or the ask-follow-up shape in the
worked example below), `health` (sick/illness/recovering/hospital/
passed away), `commitment_followup` (`COMMITMENT_PATTERN`: promised/
agreed/committed/will/would/send/follow up), `engagement` (campus/tour/
event/gala/dinner/zman-appreciation), `general` (fallback -- pledge/
gift/scholarship-type facts already better represented by
`giving_activities`/`asks` and other structured tables should NOT be
duplicated into this layer; see the next paragraph). Two facts in
DIFFERENT categories never supersede each other -- they accumulate side
by side, which is exactly what the worked examples below need (a
wedding fact, a travel fact, and a solicitation fact from the same donor
must all remain visible at once, not collapse into one).

**Explicit non-duplication principle** (per the task's own instruction):
this layer is for genuinely free-text relationship narrative that has
NO dedicated structured home. A pledge/gift/scholarship-category
sentence is still stored here as narrative color if that's literally
what was accepted, but the layer must never become a shadow copy of
`giving_activities`, `asks`, `yahrtzeits`, or `important_dates` -- those
remain the system of record for their own fact types, exactly as today
(`asks.sourceInteractionId` already links an ask back to the interaction
that produced it, the same provenance convention proposed here). A
solicitation-category fact accepted here does not create or imply a
real `asks` row -- exactly like today's `madeAsk` checkbox, which is
never inferred from note text.

### Known limitation: cross-category contradiction is not solved by category-matching alone

Category-match supersession (same category → supersede) does not catch
a genuine contradiction stated in a DIFFERENT category's terms (e.g. a
later note saying "the wedding was called off," which is still
`family_milestone` and WOULD correctly supersede -- but a subtler
cross-category contradiction has no automatic detector here, and true
semantic contradiction detection is out of scope for a deterministic
regex extractor). **Proposed v1 answer, consistent with "human
acceptance remains mandatory":** an explicit, human-driven "mark this
fact no longer current" affordance on the donor page (a manual status
override, mirroring `pledge_payment_plans.endedAt`'s convention of only
ever being set by an explicit fundraiser action, never inferred). Flagged
here as a known limitation and a deliberate v1 scope boundary, not an
oversight.

### Worked examples (exact behavior through 5 steps)

Assume a donor with no prior accepted facts.

1. **Accept "His daughter is getting married in November."**
   Category: `family_milestone`. No existing current fact in this
   category → plain insert, `status: current`. Facts table: 1 row.
   Synthesized `relationship_summary`: "His daughter is getting married
   in November." `institutional_memory`: same (only fact on file).
2. **Later, accept "He plans to be in Israel for Pesach."**
   Category: `engagement`/travel -- different category, no supersession.
   Facts table: 2 rows, both current. Synthesized `relationship_
   summary` (top 2 by `sourceInteractionOccurredAt` desc): "He plans to
   be in Israel for Pesach. His daughter is getting married in
   November." `institutional_memory`: full current list, both facts.
3. **Later, accept "Asked for $25,000 and wants to revisit after the
   wedding."** Category: `solicitation` -- different from both existing
   categories, no supersession. Facts table: 3 rows, all current.
   Synthesized `relationship_summary` (capped at top 2 most recent):
   "Asked for $25,000 and wants to revisit after the wedding. He plans
   to be in Israel for Pesach." **The November-wedding fact rotates out
   of the short summary but is never deleted** -- still `status:
   current`, still fully present in `institutional_memory`'s full list
   and in the facts table/donor-page history. This is exactly "old facts
   may become less relevant over time... without blindly concatenating":
   it's deprioritized in the short view, not lost.
4. **A later interaction contradicts/supersedes an earlier fact** --
   concrete case: accept "Wedding is now postponed to next year."
   Category: `family_milestone` -- SAME category as the November-wedding
   fact → supersession fires: the November-wedding fact's `status` flips
   to `superseded`, `supersedesFactId` on the new row points to it, new
   row is `status: current`. Facts table: 4 rows (1 superseded, 3
   current: Pesach, $25k-ask, wedding-postponed). Synthesized
   `relationship_summary`: "Wedding is now postponed to next year.
   Asked for $25,000 and wants to revisit after the wedding." The
   original November sentence is preserved verbatim, `status:
   superseded`, visible in the facts table and its own change-audit row
   (`beforeJson`/`afterJson`) -- never silently overwritten or deleted.
5. **The source interaction for one accepted fact is later edited or
   archived:**
   - **Edited** (fundraiser corrects/changes the note, does not
     re-accept a new proposal): the existing fact row is **completely
     unchanged** -- facts are immutable, accepted-value snapshots, not
     live pointers into the interaction's current text. This generalizes
     Option A's own requirement ("editing/reopening/completing existing
     outcomes must not accidentally reapply or overwrite Relationship
     Snapshot information") to the new model. If the fundraiser DOES
     re-accept a fresh proposal from the edited note, supersession
     prefers matching by `sourceInteractionId` first (a correction to
     what THIS interaction already contributed) before falling back to
     same-category-any-source -- directly reusing Approach C's
     `(category, sourceInteractionId)` classification.
   - **Archived** (the source interaction is archived/cancelled
     entirely): the fact(s) sourced from it transition to `status:
     archived_with_source` -- distinct from `superseded` (this is
     provenance loss, not a contradiction). They drop out of the
     synthesized view (relationship_summary/institutional_memory
     regenerate without them), the row and its text are preserved
     forever in the table/audit trail (restorable), and **nothing
     automatically promotes some other, never-explicitly-accepted
     interaction's extraction to fill the resulting gap** -- a new fact
     only ever enters the donor's current view through its own explicit
     accept flow. This is a direct, structural fix to the pre-existing
     write-path #2 archive gap documented above, not merely something
     the new model happens to avoid.

### Recommended architecture

**Approach C: Approach B's schema (dedicated `donor_relationship_facts`
+ `donor_relationship_fact_changes` tables, donor columns become a
synthesized view), realized by directly reusing `donor_research_
findings`'s proven status/supersession model instead of inventing new
classification logic.** This is the only approach of the three that
satisfies every stated requirement (accumulation, synthesis-not-storage,
non-destructive supersession, provenance, mandatory human acceptance)
without requiring any change to Meeting Brief, Today, or Assistant, and
it reuses a pattern already shipped five times over in this exact
codebase rather than introducing a genuinely new one.

### Phased migration plan (none of this implemented yet -- design only)

- **Phase 1 -- additive schema only, zero behavior change.** New
  `donor_relationship_facts`/`donor_relationship_fact_changes` tables.
  One-time backfill: for every live donor with a non-null
  `relationship_summary` (falling back to `institutional_memory` only
  when `relationship_summary` is null, mirroring today's own fallback
  convention), insert exactly one fact row -- `category: 'general'`
  (cannot be reliably reclassified retroactively; a safe, disclosed
  default, not a guess dressed up as certainty), `sourceInteractionId:
  NULL` (provenance genuinely unknown for pre-existing data -- today's
  CAS proves freshness, never identity -- disclosed honestly, never
  fabricated), `status: 'current'`, `factText` = the current column
  value verbatim. **No write path is touched.** `donors.relationship_
  summary`/`institutional_memory` continue to be written exactly as
  today by all 4 existing paths -- this phase writes ONLY the two new
  tables. Fully reversible (drop both tables; nothing else depends on
  them yet). Gate: full suite/tsc/build, deploy, live-verify the
  backfill produced exactly one fact row per qualifying live donor with
  byte-identical `factText`, and that the two donor columns are
  provably untouched by this migration.
- **Phase 2 -- wire the shared helper into ONE write path first
  (Option A, the newest/smallest/best-tested surface).** Build
  `acceptRelationshipFact()`: classify → find existing current fact
  (prefer same `sourceInteractionId`, else same category) → supersede if
  found, else insert → re-synthesize `relationship_summary`/
  `institutional_memory` from all current facts → write both via the
  same NULL-safe CAS pattern Option A already uses (now comparing
  against the synthesis output, which stays deterministic) → write a
  `donor_relationship_fact_changes` audit row. No visible UI change --
  same checkbox, same preview. New regression tests cover the
  supersession/archive scenarios from the worked examples above, on top
  of Option A's existing 6. Live-verify on Independent Staging before
  proceeding.
- **Phase 3 -- migrate the remaining 3 write paths one at a time**
  (Capture, edit route, Monday `confirm_contact`), each independently
  gated/tested/deployed/live-verified, retiring their bespoke direct-
  UPDATE/`contextStatement()`/recency-guard code in favor of the shared
  helper. This is where write path #2's pre-existing archive gap gets
  structurally closed, as a byproduct of the new model rather than a
  separate fix.
- **Phase 4 -- optional, not required by any stated requirement.**
  Richer consumer UI: donor page shows individual current facts with
  category/date/provenance and a history expander for superseded/
  archived facts; Meeting Brief could optionally surface facts by
  category. Deliberately deferred -- Phases 1-3 already fully satisfy
  every requirement in this task without touching any consumer.

**Safe transition of current staging data and the Option A flow
specifically:** Phase 1's backfill IS the safe transition -- every
donor's currently-accepted `relationship_summary` becomes fact #1
(`status: current`) before any write path changes, so no already-
accepted intelligence is ever lost, and every consumer's display is
byte-identical immediately after Phase 1 (nothing reads the new table
yet). Option A, as the newest and best-tested surface, becomes the
FIRST write path migrated in Phase 2 -- its existing 6-scenario
regression suite and its already-live-verified NULL-safe CAS pattern
become the direct template for Phase 3's other 3 paths, so the
"concurrent accept fails closed" guarantee already proven for Option A
today carries forward unchanged into the synthesis write-back. Each
phase is independently reversible: Phase 1 by dropping two additive
tables; Phases 2-3 by reverting that specific write path's own commit
without touching the others or the schema -- matching this repo's own
established one-path-at-a-time migration discipline already demonstrated
by Option A/B's own history.

### Status

**Investigation and design complete. Not implemented.** No files
outside `docs/AI-HANDOFF.md` were touched in this task; no migration
written; no D1 write made; nothing deployed. Awaiting explicit approval
before Phase 1 (or any phase) begins.

## Relationship Snapshot Synthesis Design (2026-08-21) -- FINAL DESIGN PASS, INVESTIGATION ONLY, NO CODE/SCHEMA/D1/DEPLOY CHANGE

**Approved:** the dedicated `donor_relationship_facts` architecture from
the section above, reusing `donor_research_findings`'s status/
supersession model. This section is the final design pass on exactly
how the current Relationship Snapshot is *derived* from durable facts,
per explicit instruction, before any implementation. Still investigation
only -- no file outside `docs/` touched.

### Category taxonomy and temporal character

**SUPERSEDED 2026-08-21 -- see "Relationship Snapshot Synthesis Design
-- Lifecycle Correction" below.** This subsection's per-category fixed
decay windows conflated a fact's SUBJECT (category) with its DURABILITY
(how long it stays relevant) -- caught by explicit user review before
implementation. `category` is kept below exactly as designed (still
correct for supersession-matching); a new, independent `lifecycle` field
now governs decay, per the corrected section. Left in place, not
deleted, per this file's own no-destruction convention -- the category
table's four additive/two singular-state split is still accurate and
reused as-is by the correction below.

Every accepted fact is tagged with a `category`, assigned deterministically
from which of the existing regex groups in `lib/capture/interaction.ts`
matched it (`FACT_SIGNAL_PATTERN`'s sub-groups, `COMMITMENT_PATTERN`,
`RELATIONSHIP_CHANGE_PATTERN`, `ZMAN_APPRECIATION_PATTERN`) -- no new
extraction logic, a coarsening of what already exists. Each category
gets two fixed properties, reasoned below, not claimed as scientifically
derived (matching this codebase's own explicit convention for
`recencyScore`'s comment: "deliberately linear and simple... not a claim
worth making"):

| Category | Supersession | Decay window (days) |
|---|---|---|
| `solicitation` | **singular-state** (auto-supersede same-category) | 90, pinned to fully-fresh while a linked `asks` row stays `status='pending'` |
| `health` | **singular-state** (auto-supersede same-category) | 180 |
| `commitment_followup` | additive (no auto-supersede by category) | 30 -- reuses the exact window `continue_conversation` already uses (`recencyScore(interaction.daysAgo, 30)`, `recommendation-candidates.ts`) |
| `engagement` | additive | 120 |
| `general` | additive | 90 |
| `family_milestone` | additive | 365 |

**Why the singular-state/additive split, not category-match-always:**
working the donor example below caught a real design bug before it
shipped -- `donor_research_findings`' own real supersession rule is
`(category, organizationNormalized)`, a category **plus a second,
specific key**, not category alone (re-read directly from `lib/
research/pipeline.ts` for this pass, correcting an oversimplification in
the prior section). Relationship facts have no reliable equivalent
second key (`mentionedPeople()` is best-effort/capped, not a stable
identity across two independently-phrased notes). Applying category-
match supersession to a broad, multi-subject category like
`family_milestone` would wrongly treat "grandson's bar mitzvah" and
"daughter's wedding" as the same claim and destroy the older one. The
fix: **automatic category-match supersession is scoped only to
categories where "same category" genuinely means "same evolving state of
one thing"** -- a donor has one live solicitation narrative and one
current health status, but can have many simultaneous, unrelated family
facts, commitments, and engagements. For every category, an exact
`sourceInteractionId` match (the SAME interaction re-accepted after an
edit -- a correction to what was already said) always supersedes
preferentially, before the category rule is even consulted.

### How each open question is answered

- **Which facts are eligible for the Snapshot?** Only `status: current`
  rows -- `superseded`/`archived_with_source` are structurally excluded
  from synthesis input, never a scoring question.
- **How many facts surface?** `relationship_summary`: top 2 by priority
  score (unchanged cap from the prior section, now score-ranked instead
  of just recency-of-acceptance-ranked). `institutional_memory`: every
  current fact clearing a minimum relevance floor (score > 0.1),
  capped at 5 -- often fewer than 5, never padded with stale facts just
  to hit a count. If literally nothing clears the floor (a donor whose
  only current facts are all very old), both surfaces fall back to the
  single most recent current fact regardless of score, so the Snapshot
  is never blank while any accepted fact exists.
- **How does recency affect relevance?** Reuses `recencyScore`'s exact
  existing formula and shape (`clamp01(1 - daysAgo / window)`, linear to
  zero at the category's window, per the table above) rather than
  inventing a new decay curve -- the same function/precedent
  `recommendation-candidates.ts` already uses for gift/reminder/
  relationship-date recency. Measured from `sourceInteractionOccurredAt`
  (accept time), never from any event date the fact's own text might
  reference ("this Sukkos") -- date-parsing free text is out of scope,
  and is stated as a disclosed simplification, not a silent gap.
- **Should an old but important family fact remain visible?** Yes, for
  longer than any other category (365-day window, vs. 30-180 for
  everything else) -- the direct, structural answer to this question.
  But not forever unconditionally: it fades from `relationship_summary`
  first, then from `institutional_memory` once its score drops below the
  floor, while never being deleted from `donor_relationship_facts` (see
  the worked example below for a concrete before/after).
- **How are superseded/contradicted facts excluded?** Structural status
  filter for the synthesis input (never `status != 'current'`). Auto-
  supersession is deliberately narrow (singular-state categories only,
  or an exact source-interaction match) to avoid the false-positive
  collision documented above; broader contradictions rely on decay (an
  old, unresolved fact naturally fades) plus an explicit, human-driven
  "mark this fact no longer current" override (mirrors `pledge_payment_
  plans.endedAt`'s existing convention of only ever being set by explicit
  fundraiser action) -- the v1 answer for cross-category contradiction,
  flagged as a known limitation in the prior section and unchanged here.
- **How are temporary facts distinguished from durable ones?** Not a
  separate flag -- an emergent property of category alone (its
  supersession behavior + decay window). No new column beyond
  `category`, which the extraction step already assigns.
- **How do structured facts (Asks, yahrtzeits, birthdays, giving,
  payment plans) influence the Snapshot without being duplicated?** Two
  sanctioned, narrow channels, nothing broader:
  1. **Display separation, unchanged from today.** `askLine()`/
     `familyDateLine()`/`pledgePlanLine()` (already existing, already
     shared across Meeting Brief/donor page/Assistant) remain the sole
     display surface for structured data, shown ALONGSIDE the Snapshot
     in Meeting Brief's already-separate fields (`openAsks`,
     `familyImportantDates`, giving totals) -- never folded into
     `relationship_summary`/`institutional_memory` text. This is already
     correct in the current Meeting Brief data model (confirmed by
     direct read in the prior section); this design's job is to
     preserve that separation, not introduce it.
  2. **Decay modulation, one category only.** A `solicitation` fact
     linked (via its own `sourceInteractionId` matching an
     `asks.sourceInteractionId`) to a still-`pending` ask is pinned to
     full freshness (score 1.0) regardless of age; once that ask
     resolves (`committed`/`declined`/`withdrawn`), the fact decays
     normally from that point. This is the only place structured state
     is allowed to affect the free-text layer, and it never copies the
     ask's own amount/purpose text into the fact -- only its `pending`/
     resolved status.
- **Deterministic, AI-generated, or hybrid?** **Deterministic for v1.**
  Synthesis is selection + priority scoring + capping + verbatim
  sentence-join over already-accepted text -- the same join logic
  `actionableRelationshipSnapshot()` already uses, never new prose. This
  directly satisfies "prevent hallucination or unsupported inference" by
  construction: nothing is generated, so there is nothing to hallucinate.
  Each fact was already explicitly human-accepted at insert time;
  synthesis never introduces a new claim requiring separate review.
  **AI-generated smoothing is explicitly deferred, not recommended for
  v1.** If ever pursued: the AI-authored paragraph must be shown as a
  preview and separately, explicitly accepted (same default-unchecked
  checkbox pattern used everywhere else in this codebase) before
  replacing the deterministic display; the underlying facts table stays
  authoritative regardless, so the AI-authored text is always a
  discardable, re-derivable display cache, never a second source of
  truth.
- **Persisted, cached, or generated on read?** **Persisted/materialized**
  into the existing `donors.relationship_summary`/`institutional_memory`
  columns, regenerated synchronously in the SAME `env.DB.batch()` as any
  fact status transition (insert/supersede/archive) -- never a separate
  async job, never independently editable. This is a cache, explicitly
  not a second source of truth: always exactly reproducible by
  re-running the synthesis function over `donor_relationship_facts`,
  unlike today's system where the "true" value has no other
  representation to regenerate from if it ever drifted. Chosen over
  read-time-only generation (which Meeting Brief's `peopleMentioned`/
  `recentDiscussionTopics` already do for raw interactions) specifically
  because the already-approved architecture requires zero changes to
  Meeting Brief/Today/Assistant -- materialize-on-write is what delivers
  that property; read-time generation would not.
- **What happens when a source fact is edited, archived, or
  superseded?** Facts are immutable once accepted -- editing the SOURCE
  INTERACTION never mutates an existing fact row; a fresh re-accept from
  the edited note is a new accept event, going through the same
  classify → supersede-or-insert → resynthesize pipeline as any other.
  Archiving the source interaction transitions its fact(s) to `status:
  archived_with_source` (distinct from `superseded` -- provenance loss,
  not a contradiction) and immediately triggers resynthesis. Every
  status transition (insert-current / supersede / archive_with_source)
  is followed, in the same batch, by a resynthesis-and-CAS-write of the
  two materialized columns -- mirroring how Option A already bundles the
  interaction update + relationship write + audit row in one
  `env.DB.batch()`. The cache can never observably lag its source.
- **How do Meeting Brief, Suggested Action, and Assistant stay in sync?**
  All three continue reading the SAME two materialized columns,
  unchanged from today's read sites. Because there is exactly one
  synthesis function and exactly one write site for those columns (the
  shared accept/supersede/archive pipeline), the three consumers are
  structurally incapable of drifting from each other -- not "kept in
  sync," but reading the literal same values by construction.
  `peopleMentioned`/`recentDiscussionTopics` stay explicitly OUT of this
  design: they already don't read these columns today (independently
  re-extracted from the last 5 raw interactions, no acceptance gate at
  all) and remain a deliberately separate, complementary, lower-bar
  signal -- not something this design merges in or must keep consistent
  with the Snapshot.

### Worked example: 2.5 years, 10 facts, a contradiction, an ask, a yahrtzeit, giving history

Fictional donor for illustration only. "Now" = 2026-08-21, matching
today's date.

**Structured data on file (never duplicated into facts):** one resolved
ask ($10,000 building fund, `status: committed`, `askedAt` 2024-11);
one open ask ($5,000 gala sponsorship, `status: pending`, `askedAt`
2026-07-20, `sourceInteractionId` = the same interaction as fact #10
below); one yahrtzeit (mother-in-law); an open $2,000 pledge with an
active monthly payment plan; several paid gifts, most recent 3 months
ago.

**Durable facts, in acceptance order:**

| # | Date | Text | Category | Status |
|---|---|---|---|---|
| 1 | 2024-03 | "His grandson had his bar mitzvah, a beautiful simcha." | family_milestone | **current** |
| 2 | 2024-06 | "Discussed a $10,000 solicitation for the building fund; he wants to think it over." | solicitation | superseded (by #4) |
| 3 | 2024-09 | "Promised to send him the updated campus tour schedule." | commitment_followup | **current** (stale) |
| 4 | 2024-11 | "He confirmed the $10,000 building fund gift and asked for a plaque acknowledgment." | solicitation | superseded (by #10) |
| 5 | 2025-02 | "She mentioned she's recovering from hip surgery." | health | superseded (by #7) |
| 6 | 2025-05 | "Promised to introduce him to another board member." | commitment_followup | **current** (stale) |
| 7 | 2025-08 | "Confirmed she's fully recovered and back to her normal schedule." | health | **current** (stale) |
| 8 | 2025-10 | "His daughter is getting married in November." | family_milestone | **current** (fading) |
| 9 | 2026-06 | "He's planning a trip to Israel this Sukkos and asked about visiting campus." | engagement | **current** (fresh) |
| 10 | 2026-07 | "Asked about renewing/expanding gala support at $5,000; wants to finalize after seeing this year's program." | solicitation | **current** (fresh, pinned by pending ask) |

**Supersession chain:** #2 → superseded by #4 (same category, both
solicitation) → #4 itself later superseded by #10 (same category again).
All three remain permanently in `donor_relationship_facts`, fully
readable in order, with their own `donor_relationship_fact_changes`
audit rows -- three hops of history, nothing destroyed. #5 → superseded
by #7 (health, singular-state) is the contradiction case: "recovering"
directly replaced by "fully recovered," cleanly captured, not blindly
concatenated into a paragraph that would read "recovering... fully
recovered" side by side.

**Priority scores at "now" (illustrative arithmetic, `1 - daysAgo /
window`):** #10 = 1.0 (pinned, linked ask still pending). #9 ≈ 0.44
(~67 days into a 120-day engagement window). #8 ≈ 0.15 (~310 days into a
365-day family_milestone window -- still just barely present). #1, #3,
#6, #7 all ≈ 0.0 (each well past its own category's window -- #1 at ~2.5
years vs. a 1-year family window; #3/#6 at well over a year vs. a
30-day commitment window; #7 at ~1 year vs. a 180-day health window).

**Resulting `relationship_summary` (top 2):** "Asked about renewing/
expanding gala support at $5,000; wants to finalize after seeing this
year's program. He's planning a trip to Israel this Sukkos and asked
about visiting campus." -- #10 and #9 only.

**Resulting `institutional_memory` (floor-qualifying, capped 5):** the
same two facts, plus #8: "...gala support... Israel this Sukkos...
His daughter is getting married in November." **#1 (the ~2.5-year-old
bar mitzvah) does not appear in either surface** -- fully decayed, but
still permanently retrievable in `donor_relationship_facts` (Phase 4's
donor-page history view). This is the concrete, non-hypothetical answer
to "should an old but important family fact remain visible": #8 (10
months old) still is, faintly; #1 (2.5 years old) no longer is, in the
synthesized view, though it is never deleted.

**Honest, disclosed limitation surfaced by this example:** fact #8's
text ("getting married in November") is now temporally stale in a
subtler way than mere irrelevance -- the wedding has already happened by
"now," but deterministic synthesis reproduces accepted text verbatim and
has no way to know that, since re-phrasing would require generation
(explicitly rejected for v1, see above). Decay is doing double duty
here: aging #8 out of the top-priority slots is also, incidentally, what
keeps this stale phrasing from dominating the Snapshot -- but it is not
a semantic fix, and a fact that decays slowly (family_milestone, 365
days) could still show dated phrasing for a while. Flagged here as a
known v1 limitation, not silently absorbed into the design as solved.

**What Meeting Brief should use:** `relationship_summary`/
`institutional_memory` exactly as synthesized above (via `narrative.
relationshipSummary || narrative.institutionalMemory`, unchanged
fallback). `openAsks`: only the $5,000 gala ask (`status: pending`) via
`askLine()` -- the resolved $10,000 ask never appears here, unchanged
existing behavior. `familyImportantDates`: the yahrtzeit, via
`familyDateLine()`, shown regardless of Snapshot content (existing
always-shown rule). Giving totals/pledge/payment-plan line: from
`giving_activities`/`pledge_payment_plans` directly, untouched by any of
this. `peopleMentioned`/`recentDiscussionTopics`: still independently
computed from the last 5 raw interactions, out of scope as above.

**What Suggested Action should use:** the real `openAsk` evidence (the
pending $5,000 gala ask) as genuine, structured, dated evidence --
already documented in `recommendation-evidence.ts` as more trustworthy
than narrative text ("More trustworthy than an imported note, less than
a confirmed database row"); this design doesn't change that hierarchy,
only confirms the synthesized narrative still sits below it. The
synthesized `relationship_summary` (facts #10/#9) as the `narrative`
fallback signal for `relationshipOpportunityCandidate`/`solicitCandidate`
-- unchanged mechanism, now fed cleaner input.

**What Suggested Action should NOT use:** the superseded #2/#4
solicitation facts (already excluded from the narrative -- structurally
invisible to `solicitCandidate`, so a resolved 21-month-old ask can no
longer keep re-suggesting "make a solicitation ask" the way today's
undecaying system could). The stale #3/#6 commitment facts (decayed out
of both surfaces, so `relationshipOpportunityCandidate` can no longer
prompt "reach out and reference: promised to send the campus tour
schedule" nearly two years after the fact -- a genuine correctness
improvement over today's no-decay system). #8's now-outdated wedding
fact does not reach Suggested Action at all in this example, since
`relationship_summary` is non-null and the `institutional_memory`
fallback is therefore never consulted -- traced directly from the
existing `||` fallback expression already in `recommendation-
candidates.ts`, not a new rule introduced here.

### Status

**Design complete. Not implemented.** No files outside `docs/AI-
HANDOFF.md` touched; no migration, D1 write, or deployment made.
Awaiting explicit approval before Phase 1 of the previously-approved
migration plan begins.

## Relationship Snapshot Synthesis Design -- Lifecycle Correction (2026-08-21) -- FINAL, INVESTIGATION ONLY, NO CODE/SCHEMA/D1/DEPLOY CHANGE

**Correction, per explicit user review before implementation:** the
prior section's per-category fixed decay windows conflated a fact's
SUBJECT (`category`, used for supersession-matching) with its
DURABILITY (how long it should stay relevant). "His daughter is
Danielle" and "His daughter Danielle is getting married in November" are
both `family_milestone`, but the first is permanent and the second is
not. This section adds a second, independent field -- `lifecycle` --
and reworks decay/synthesis/supersession around it. `category` is
unchanged from the prior section.

### The smallest deterministic model that supports this

Three lifecycle values, per-fact, assigned once at accept time alongside
`category`: **`durable`**, **`time_bound`**, **`follow_up`** -- the
user's own suggested names, kept as-is: they already match this
codebase's existing vocabulary (`RelationshipSnapshotDetails.
openFollowUps`/`commitments` in `lib/capture/interaction.ts` already
distinguish action-oriented content from descriptive facts; no better
existing name was found). No fourth value was added -- three is the
smallest set that separates "never expected to change" from "will
naturally become dated" from "exists to trigger an action, not to
describe the donor."

**Assignment is a deterministic waterfall, reusing existing regex groups
wherever possible, evaluated per matched sentence at extraction time
(same point `category` is already assigned) -- not new NLP, a second,
independent classification pass over the same sentence:**

1. **`follow_up`** if the sentence matches the EXISTING
   `COMMITMENT_PATTERN` (`promised|agreed|committed|will|would|send|
   follow up|follow-up|call back|introduce|schedule|share|provide`) --
   zero new regex; `relationshipSnapshotDetails()` already computes this
   exact sentence set today as `commitments`, just not wired to
   anything past the next-action suggestion. Checked first: an
   unambiguous, already-proven signal.
2. Else **`time_bound`** if the sentence contains an explicit relative-
   or calendar-time reference (a month name; `this`/`next`/`upcoming` +
   a season or a named Jewish holiday -- "this Sukkos," "next spring")
   OR a transient-state verb from a narrow, evidenced subset of the
   existing health keywords (`sick|illness|recovering|hospital` --
   **deliberately excluding `passed away`**, which is permanent, not
   transient) OR matches the EXISTING `RELATIONSHIP_CHANGE_PATTERN`
   (`increased|decreased|changed|newly|no longer|ready|hesitant|more
   involved|less involved|reconnected|stepped back` -- state-change
   language is inherently a snapshot of a moment, not a standing fact).
3. Else, **the default depends on category, not a single global
   fallback**: for the two "singular-state" categories from the prior
   section (`solicitation`, `health`) the default is `time_bound` -- an
   ask-in-progress or a health status is inherently a point-in-time
   state even when phrased without an explicit date word ("he wants to
   think it over" has no date but is still clearly not a standing
   identity fact). For every other category the default is `durable`
   ("His daughter is Danielle," "Very close with Rabbi Cohen" -- neither
   contains a date, health, or change signal, and neither category
   implies transience). **This is the one place `category` still
   informs `lifecycle`** -- as a sensible prior when no textual signal
   fires, never overriding an explicit signal, and never used for
   supersession matching (that stays category-only, corrected below).
   This is deliberate and narrow, not a re-conflation of the two axes.

**Disclosed limitation, not silently absorbed:** a past, one-off event
described with no explicit date/relative-time word ("His grandson had
his bar mitzvah") has no signal to catch it and defaults to `durable`
via rule 3 -- it will not decay, even though it is, strictly, an event.
This is the deliberate, safer failure mode of a text-only deterministic
system (erring toward "stays visible longer than ideal" rather than
"silently vanishes"), not a design flaw being ignored. If real usage
ever evidences this as a recurring problem, a narrower additional signal
(past-tense event verb + `FACT_SIGNAL_PATTERN` event noun) could be
added later -- exactly this codebase's own established convention of
only adding a pattern after a real, evidenced staging incident (Zman,
Yahrtzeit, grandchild), never speculatively.

### Does the fundraiser see or correct lifecycle at accept time?

**Sees it, and can correct it, without a new review screen.** The
existing accept-time preview (`OutcomeExperience.tsx`/
`CaptureExperience.tsx`'s single checkbox + proposed-text display)
gains one small, non-blocking addition: a label next to the proposed
fact showing its deterministic classification (e.g. "Durable" /
"Time-bound" / "Follow-up"), with a lightweight control (a 3-way toggle,
not a modal) defaulting to the waterfall's guess. Zero extra clicks if
the guess is right (the fundraiser just accepts, exactly as today); one
extra click to correct it if wrong. Justified by the stakes: getting
this wrong has multi-year consequences (a wrongly-`durable` event fact
never decays; a wrongly-`time_bound` identity fact fades prematurely),
so letting the human confirm it at the one moment they already have full
context -- while reviewing the proposal -- is more defensible than
trusting the regex guess unconditionally, and it extends the existing
explicit-acceptance pattern rather than inventing a new one.

### How each lifecycle affects synthesis/relevance

- **`durable`: does not decay.** Gets a fixed, non-time-decaying
  baseline relevance score (0.3 -- a constant, reasoned not derived,
  matching this codebase's own "not a claim worth making" convention
  for `recencyScore`). Always eligible for `institutional_memory`
  (clears the floor by construction); ranks below a genuinely fresh
  `time_bound` fact for the terse `relationship_summary` top-2 cut, but
  above any `time_bound` fact that has decayed past its own window.
  Ties among multiple durable facts (when more exist than the cap
  allows) break by acceptance recency -- there is no principled way to
  rank durable-vs-durable content itself; a fuller history view (Phase
  4, deferred) is the right long-term answer if a donor ever
  accumulates many.
- **`time_bound`: decays exactly as the prior section's per-category
  windows described** (`recencyScore`'s existing linear formula,
  `clamp01(1 - daysAgo / window)`), now applied ONLY to `time_bound`
  facts -- `solicitation` 90 days (pinned to 1.0 while a linked `asks`
  row stays `pending`, unchanged from the prior section), `health` 180,
  `engagement` 120, `family_milestone` 180 (revised down from the prior
  section's 365 -- now that permanence is durable's job, the time-bound
  window for a dated family EVENT can be realistically shorter than the
  window that used to have to cover both cases at once), `general` 120.
  Ages below the floor exactly as before: excluded from synthesis,
  never deleted from `donor_relationship_facts`.
- **`follow_up`: never enters `relationship_summary`/`institutional_
  memory` synthesis at all, regardless of age or status.** This is the
  direct answer to "how follow-up facts interact with reminders/asks
  rather than lingering as relationship intelligence": their job is not
  to describe the donor, it's to prompt an action, and this codebase
  already has a dedicated, separate surface for that -- the
  `recommendations` table (Meeting Brief's `openReminders`, Suggested
  Action) and Capture's own existing reminder picker. A `follow_up`
  fact is still stored in `donor_relationship_facts` (provenance/audit,
  same explicit-acceptance gate as any other fact), just excluded from
  the synthesis input by lifecycle -- structurally, not by decay, so it
  can never linger as stale prose even on day one. **Not proposed here:
  automatically creating a reminder from an accepted `follow_up` fact.**
  Consistent with this codebase's existing "never infer, always
  explicit" convention (`madeAsk` must be exactly `true`, never inferred
  from note text) -- the natural, optional product opportunity (turning
  `recommendedNextAction`'s already-computed text into a one-click
  reminder-creation suggestion) is flagged as a real but separate,
  deferred enhancement, not assumed as part of this design.

### Supersession, corrected to require lifecycle too

The prior section's rule ("auto-supersede same-category, singular-state
categories only") is refined: **automatic supersession now requires
same `category` AND same `lifecycle`, and only within the two singular-
state categories** (`solicitation`, `health`) -- OR an exact
`sourceInteractionId` match (always wins, category/lifecycle-agnostic,
unchanged from the prior section -- an edited note's re-accept always
supersedes its own prior contribution). **This is the direct fix for
the exact failure the user's examples describe:** "His daughter is
Danielle" (`family_milestone`, `durable`) and "His daughter Danielle is
getting married in November" (`family_milestone`, `time_bound`) share a
category but not a lifecycle -- under the corrected rule they
structurally cannot supersede each other, where a category-only rule
would have wrongly let the event fact destroy the identity fact.
Everything else (a genuine cross-category or same-category-different-
lifecycle contradiction) still relies on decay plus the explicit human
"mark no longer current" override from the prior section, unchanged.

### Migration/backfill when lifecycle cannot be inferred confidently

Phase 1's backfill (one fact per live donor's current `relationship_
summary` text) runs the SAME deterministic waterfall used for new
extraction -- not a blanket override -- since the waterfall's own
default is already conservative (`durable` for most categories,
`time_bound` only for the two singular-state categories, both safe
failure modes). **One backfill-specific safeguard, not a classification
change:** any backfilled fact the waterfall classifies as `time_bound`
gets its decay clock's start date **clamped to the migration date, not
the original interaction's true historical date.** Without this, a
years-old accepted sentence that happens to be `time_bound`-shaped could
be born already past its own decay window on day one of the new system
-- silently vanishing from every donor's Snapshot the moment Phase 2
ships, which would be a real regression, not a neutral migration
artifact. The clamp gives every backfilled fact the same full decay
grace period a brand-new fact would get, while still preserving the
waterfall's real classification (a backfilled `durable` fact still never
decays; a backfilled `time_bound` fact still eventually fades, just not
immediately).

### Reworked worked example (12 facts, covering every example given)

Same fictional donor, structured data (asks/yahrtzeit/giving/payment
plan), and "now" = 2026-08-21 as the prior section, with the fact list
revised to show every example given: an identity fact, its paired event
fact, a paired follow-up fact, a standing non-family relationship fact,
a health contradiction, a solicitation supersession chain, and the
disclosed durable-by-default limitation.

| # | Date | Text | Category | Lifecycle | Status |
|---|---|---|---|---|---|
| 1 | 2024-03 | "His grandson had his bar mitzvah, a beautiful simcha." | family_milestone | **durable** (disclosed default -- see limitation above) | current |
| 2 | 2024-06 | "Discussed a $10,000 solicitation for the building fund; he wants to think it over." | solicitation | time_bound (category default) | superseded (by #4) |
| 3 | 2024-09 | "Promised to send him the updated campus tour schedule." | commitment_followup | follow_up | current (never shown in Snapshot) |
| 4 | 2024-11 | "He confirmed the $10,000 building fund gift and asked for a plaque acknowledgment." | solicitation | time_bound | superseded (by #12) |
| 5 | 2025-02 | "She mentioned she's recovering from hip surgery." | health | time_bound (transient-state signal) | superseded (by #6) |
| 6 | 2025-08 | "Confirmed she's no longer recovering and is back to her normal schedule." | health | time_bound (`RELATIONSHIP_CHANGE_PATTERN`: "no longer") | current (decayed) |
| 7 | 2025-10 | "His daughter is Danielle." | family_milestone | **durable** | current |
| 8 | 2025-10 | "His daughter Danielle is getting married in November." | family_milestone | **time_bound** (month-name signal) | current (decayed) |
| 9 | 2025-10 | "Follow up after Danielle's wedding." | commitment_followup | follow_up | current (never shown in Snapshot) |
| 10 | 2026-06 | "He's planning a trip to Israel this Sukkos and asked about visiting campus." | engagement | time_bound ("this Sukkos" signal) | current (fresh) |
| 11 | 2026-07 | "Very close with Rabbi Cohen; mentioned they study together weekly." | general | **durable** | current |
| 12 | 2026-07 | "Asked about renewing/expanding gala support at $5,000; wants to finalize after this year's program." | solicitation | time_bound, pinned fresh (linked `asks` row still `pending`) | current (fresh) |

**#7 and #8, side by side, are the direct proof this correction works:**
same donor, same daughter, same category -- #7 (identity, durable) and
#8 (wedding date, time_bound) never supersede each other, and age
completely independently.

**Scores at "now" among the 9 `current` facts (`durable` = fixed 0.3;
`time_bound` = `recencyScore` against its category window; `follow_up`
excluded from scoring entirely, never competes for a slot):** #12 = 1.0
(pinned). #10 ≈ 0.44 (~67 of 120 days). #11/#7/#1 = 0.3 each (durable,
tie broken by acceptance recency: #11 > #7 > #1). #6 = 0.0 (~365 of 180
days, fully decayed). #8 = 0.0 (~310 of 180 days, fully decayed -- the
wedding has already passed).

**Resulting `relationship_summary` (top 2):** "Asked about renewing/
expanding gala support at $5,000; wants to finalize after this year's
program. He's planning a trip to Israel this Sukkos and asked about
visiting campus." -- unchanged in shape from the prior section (the two
freshest facts), now correctly excluding both `follow_up` facts by
construction.

**Resulting `institutional_memory` (floor-qualifying, capped 5 --
exactly 5 qualify here):** "...gala support... Israel this Sukkos...
Very close with Rabbi Cohen; mentioned they study together weekly. His
daughter is Danielle. His grandson had his bar mitzvah, a beautiful
simcha." **Note what this list does NOT contain:** the wedding date
fact (#8, decayed -- correctly, the event is long past) and both
follow-up facts (#3, #9 -- structurally excluded, not merely decayed).
**Note what it DOES still contain after 2.5 years:** the plain fact that
he has a daughter named Danielle, and that the fundraiser has a close,
ongoing relationship with Rabbi Cohen -- exactly the standing
relationship intelligence that should survive, sitting right next to
the still-fresh gala ask and trip.

### What remains useful after 2-3 years -- direct answer

- **Still visible, indefinitely (durable):** "His daughter is Danielle."
  "Very close with Rabbi Cohen..." "His grandson had his bar mitzvah..."
  (the last one present via the disclosed conservative-default
  limitation, not a misclassification the design pretends doesn't
  exist).
- **Still visible, because still fresh (time-bound, within window):**
  the gala ask and the Israel trip -- will themselves fade on the same
  schedule once enough time passes, exactly like #8 and #6 already did.
- **Faded from both synthesized surfaces, never deleted (time-bound,
  decayed):** the wedding date, the health-resolution sentence, both
  superseded solicitation facts -- all permanently retrievable in
  `donor_relationship_facts`/Phase 4's history view.
- **Never shown as Snapshot prose at any point, regardless of age
  (follow-up):** both commitment sentences -- their only intended path
  to visibility is the existing reminders surface, not the Snapshot.

This is a strictly better outcome than the prior section's version of
this same example: there, the Danielle-is-my-daughter identity would
never have existed as a separate fact at all (it was folded into the
single now-decayed wedding sentence), so after 2.5 years NOTHING about
Danielle would have remained visible. Here, the identity survives and
the event correctly fades -- precisely the distinction the user asked
for.

### Everything already approved stays intact

Dedicated `donor_relationship_facts`/`donor_relationship_fact_changes`
tables (now with one added `lifecycle` column); provenance via
`sourceInteractionId`; deterministic, non-generative v1 synthesis;
structured data (asks/yahrtzeits/giving/payment plans) staying in its
own dedicated fields, never duplicated into facts; materialized
`relationship_summary`/`institutional_memory` caches, regenerated
atomically on every fact status transition; explicit human acceptance
at the fact level (now additionally covering lifecycle); and no
destruction of historical facts at any point. Nothing in this correction
touches the already-approved 4-phase migration plan's shape -- Phase 1's
backfill gains the one clamp described above, nothing else changes.

### Status

**Correction complete. Not implemented.** No files outside `docs/AI-
HANDOFF.md` touched; no migration, D1 write, or deployment made.
Awaiting explicit approval before Phase 1 begins.

## Relationship-Intelligence Quality Pass (2026-08-19) -- historical, no longer the latest task

**Retitled 2026-08-21** (was "## Latest Completed Task" -- misleading
after many later tasks; kept as a heading only other sections still
point to it by name). This describes the original quality pass
(commit `1487a8b`) that first replaced the field-label-dump generator
with the current quoted-sentence one. Substantial further work has
happened since on this same code path -- every section ABOVE this one
in the file is chronologically later (each new task's report was always
inserted immediately before this anchor, so file order below "Current
Git State" runs oldest-to-newest and this heading marks where a much
older "latest" designation stopped being updated). In particular, see
"Grandchild/Grandparent Extraction-Gap Fix", "Zman/Yahrtzeit Extraction
Implementation + Historical Preview", "Outcome-Route Fix -- Option B",
and "People-Extraction Fix -- Deployed + Live-Verified" above -- all now
deployed and closed. The "Current Git State" section at the top of this
file and the "Last Updated" log's newest entry are the actual current
status; this section is history.

A relationship-intelligence quality pass, deployed and live-verified on
Independent Staging: stopped surfacing weak machine-generated content as
if it were real relationship intelligence, end to end (extraction ->
snapshot -> recommendation -> presentation). Root cause was entirely
upstream in `lib/capture/interaction.ts`'s extraction, so one fix there
flows through to every consumer (donor page, Meeting Brief, Assistant,
capture preview):
1. `mentionedPeople()` no longer misclassifies channel/CRM verbs
   (Messaged, Called, Solicited, and others) as people -- consolidated
   verb list plus a structural check (a bare capitalized word followed by
   "about"/"regarding"/"with"/"via" is a verb, not a name) and exclusion
   of modal auxiliaries/days-of-week/indefinite pronouns as closed
   grammatical classes. Also fixed organization matching to recognize
   keyword-first yeshiva names ("Yeshivas Ner Yisroel"), which the
   original qualifier-first-only regex couldn't capture at all.
2. The category-label "topics" field (e.g. "Personal update", a coarse
   classifier output, not a fact) was replaced with `specificFacts` --
   real quoted sentences from the note, reusing the same keyword signals
   but returning the matched sentence instead of a fixed label.
3. Relationship Snapshot / `donors.relationship_summary` is now natural
   language (or `null` when nothing specific was found) -- never a
   field-label dump, never a manufactured "Review this note before the
   next interaction" placeholder.
4. Suggested Action (`relationship_opportunity`/`solicit` candidates) no
   longer echoes a field-label dump wholesale, and no longer leaks the
   raw DB field name `relationship_summary/institutional_memory:` into
   evidence text.
5. The internal "Confidence: medium" label is gone from the Suggested
   Action detail view (donor page and Meeting Brief); timing still shows
   on its own when present.
6. The capture-form preview only offers the "Use this relationship
   snapshot" opt-in when something meaningful was actually extracted;
   shows "No meaningful relationship details detected." otherwise, so a
   fundraiser is never asked to manually reject generation garbage.

No existing `relationship_summary`/`institutional_memory` rows were
rewritten or backfilled -- this only changes generation going forward.

Relevant commits (all on `feature/independent-cloudflare-sandbox`, all
pushed):
- Phase 1 (shared-activity schema + backend + recipient-aware scoring): `c42cca30ef38c0da1986c3f5e800f6d1b3482400`
- Phase 2 (shared-activity capture-form UX, edit/remove/delete routes + UI, Meeting Brief copy): `391a5095c20450daa57cbe37a08e0e329944c9d4`
- Text Message type (migration 0031 + app-layer propagation + tests): `1c2273537403f790f9670f468125606f312b5c43`
- Mobile UX fixes (recommendation wording/layout, shared-edit clarity, RecipientPicker overlap): `aa2a8b7c858acb984358da8a82c2d580734f1222`
- Relationship-intelligence quality pass (extraction/snapshot/recommendation/preview quality gate): `1487a8bb4416666e79a8d94d571e3445af3fc2af` (current HEAD)

For behavior detail: `git show c42cca3` / `git show 391a509` / `git show
1c22735` / `git show aa2a8b7` / `git show 1487a8b` (self-contained commit
messages), plus `tests/shared-activity-ux.test.mjs`,
`tests/text-message-type.test.mjs`, `tests/mobile-ux-fixes.test.mjs`, and
`tests/relationship-quality.test.mjs`.

## Relationship-Summary Cleanup Audit (Phase 1 applied; all 5 original NEEDS_REVIEW donors now resolved -- see 2026-08-21 update below)

Follows on from the "Existing (pre-fix) `relationship_summary`/
`institutional_memory` rows" item in Outstanding Work below. Two-phase
task: (1) `fe35859` -- a read-only AUDIT -> PREVIEW -> CLASSIFY pass
against `fundraising-os-staging-db` to find remaining pre-fix (`1487a8b`)
machine-generated junk; (2) `7874d6b` -- an explicitly-approved APPLY of
the 4 SAFE_TO_REGENERATE rows the preview found, plus a read-only
investigation of the 5 NEEDS_REVIEW rows (not modified).

Tooling: `scripts/relationship-summary-cleanup-preview.mjs`. Preview:
`pnpm run cleanup:relationship-summary-preview`. Apply (explicit donor-ID
allowlist only, never a caller-supplied replacement string): `node
scripts/relationship-summary-cleanup-preview.mjs --apply <id1,id2,...>`.
Tested by `tests/relationship-summary-cleanup-preview.test.mjs` (12-item
classification coverage) and `tests/relationship-summary-apply.test.mjs`
(12-item apply-mode safety coverage, offline against synthetic fixtures).

Provenance (unchanged from Phase 1): donors.relationship_summary/
institutional_memory have no field-level provenance column, but all 4
real write paths (`app/api/interactions/route.ts`,
`app/api/interactions/[id]/route.ts`,
`app/api/interactions/[id]/outcome/route.ts`,
`app/api/import/monday/commit/route.ts`'s `confirm_contact` action) go
through the same `extractInteraction()` -- no manual free-text entry path
exists for either field. Old-format values are identified by a structural
signature (the pre-fix generator's unconditional `"Latest discussion
topics: "` prefix), not a guess. `institutional_memory`'s field
construction is byte-for-byte identical before/after `1487a8b` and was
never written by this task (see Applied Regenerations below for how that
was verified). No audit/history table covers either field
(`donor_contact_audits` is scoped to contact fields only) -- per
instruction, no new audit subsystem was built solely for this cleanup;
traceability instead comes from: a deterministic, tested tool; an
explicit approved-donor-ID allowlist; printed before/after per donor;
this handoff's execution report; and the commit SHA (`7874d6b`).

### Applied Regenerations (4 of 4, staging, verified)

Re-verified against a **fresh** classification (a brand-new
`wrangler d1 execute --remote` read) immediately before writing --
identical to the original preview: same 4 donor IDs, same source
interactions, same proposed values, no new/removed candidates. Applied
via `--apply` with exactly these 4 IDs; 4 applied, 0 failed closed.

| Donor | Before | After | Source interaction |
|---|---|---|---|
| Dr. & Mrs. Yaakov Abdelhak (`e4626eea-56ce-4005-96db-eeafbfde6628`) | `Latest discussion topics: Event planning.\nPeople mentioned: Personal, Teaneck.\nRecommended next action: Review this note before the next interaction.` | `Personal invite to Teaneck event.` | `monday-interaction-81662eab` (note, 2024-09-02) |
| Dr. & Mrs. Gavin Horn (`cd4fbfd1-a461-4954-b580-64d3585f9cb9`) | `Latest discussion topics: Personal update.\nPeople mentioned: Messaged.\nOrganizations mentioned: Yeshiva.\nRecommended next action: Review this note before the next interaction.` | `Messaged to welcome son back to Yeshiva.` | `56d24b22-de8d-462d-9c9e-6e8791b60189` (text, 2026-08-16) |
| Mr. & Mrs. Dovie Weinschneider (`9a9e3a1f-50d6-42b6-b986-c7608f0b8e8e`) | `Latest discussion topics: Giving follow-up.\nPeople mentioned: Discussed Kollel.\nCommitments: ...\nOpen follow-ups: follow up after succos.\nRecommended next action: follow up after succos.` | `Discussed Kollel donation and said to follow up after succos.` | `ccd22502-beff-4db5-88aa-1d2426383271` (call, 2026-08-17) |
| Mr. & Mrs. Tzvi Shlionsky (`2a1735d2-c3a6-4707-beb9-9ac7a0ab4e34`) | `Latest discussion topics: Personal update.\nPeople mentioned: Sent.\nRecommended next action: Review this note before the next interaction.` | `Sent him an email with photo of his son.` | `monday-interaction-5e36f7aa` (note, 2025-06-16) |

**How the write works** (`planApply`/`executePlan` in the tool): re-reads
and re-classifies fresh from D1 immediately before writing; a donor is
written only if its ID is in the explicit approved list AND it currently
(this fresh read) classifies SAFE_TO_REGENERATE; the write is a
conditional `UPDATE donors SET relationship_summary = <current extractor
output> WHERE id = <id> AND relationship_summary = <exact value just
read>` (compare-and-swap -- fails closed, no write, if the stored value
changed since the read); only `relationship_summary` is ever assigned.
Values are hex-blob-encoded (`CAST(X'...' AS TEXT)`) in the generated SQL
-- **found and fixed live**: the pre-fix values contain literal newlines,
which broke `wrangler d1 execute --command`'s Windows shell-argument
parsing (a real SQLITE_ERROR, no write occurred, caught and fixed before
any donor was touched); a `--file`-based alternative was tried and
rejected after discovering its JSON response's `meta.changes` is NOT a
trustworthy per-row count (verified live: an UPDATE targeting a
nonexistent donor id still came back `changes: 1`) -- unsafe for the
compare-and-swap check, so apply mode stays on `--command` mode with
hex-encoded values instead.

**Post-write verification** (all independently re-checked against live
staging after the write, read-only):
- `relationship_summary` for all 4 donors read back and matches the
  applied value exactly (and matches `actionableRelationshipSnapshot`
  computed fresh from the source note).
- `institutional_memory` for all 4 donors: the generated UPDATE
  statement's SQL never references `institutional_memory` (mechanically
  impossible for this write to have touched it -- also asserted by
  `tests/relationship-summary-cleanup-preview.test.mjs`); current stored
  values remain consistent with each donor's known source-interaction
  note (e.g. Abdelhak: `"Note context: Personal invite to Teaneck
  event"`).
- All 4 source interactions re-read: same `donor_id`/`type`/`occurred_at`
  as traced during classification -- unchanged.
- Table-wide: `relationship_summary` non-null count is still 9 (was 9
  before) -- no row nulled, no new candidate appeared.
- Re-running the preview immediately after: `SAFE_TO_REGENERATE: 0`,
  `ALREADY_GOOD: 4` (exactly these 4 donors, reclassified), `NEEDS_REVIEW:
  5` (identical to before, same donors/reasons) -- confirms exactly these
  4 rows changed, nothing else did, and the tool is idempotent (won't
  re-propose them).

### NEEDS_REVIEW Investigation (5 of 5, read-only -- NOT modified)

**Klein / Pfeiffer / Rovinsky** (all three stored "People mentioned:
Solicited." -- the false-person extraction the user specifically asked to
re-investigate). Each donor has exactly one interaction on file, a
Monday-imported note, and the underlying note **does** contain a real
fundraising fact beyond the bogus person -- clearing to null would lose
it:
- Klein (`b5e8cc18-...`): `"Solicited for a plaque ($5k)"` (note,
  2025-11-06)
- Pfeiffer (`d1b9cf78-...`): `"Solicited for $10k"` (note, 2025-09-15)
- Rovinsky (`952a1cc7-...`): `"Solicited for a plaque in memory of his
  wife ($5k)"` (note, 2025-09-29)

The current extractor returns `null` for all three (`specificFacts: []`,
`people: []`) -- it has no fact-signal keyword for "solicited"/dollar
amounts, so **regenerating with the current extractor as-is would produce
an empty relationship_summary, silently discarding the ask amount**. Not
a script bug: confirmed by direct git-history tracing that these 3 rows'
"Solicited" exclusion behavior predates the earliest retrievable
extractor version (`e1760c6~1` had no CRM-status-verb exclusion at all),
consistent with genuinely older data.
**Recommendation**: do NOT auto-clear or auto-regenerate. A human should
manually set relationship_summary to the underlying ask fact -- e.g.
`"Solicited for a plaque ($5k)."` / `"Solicited for $10k."` / `"Solicited
for a plaque in memory of his wife ($5k)."` -- these are already clean,
single-sentence facts once the false "People mentioned:" label is
dropped; no extractor change is required to write them by hand.

**Semmelman** (`5c35437c-...`): source interaction `544721ad-...`
(personal, 2026-08-07), note: `"Sent text on wife's Yahrtzeit to
acknowledge it"` (subject: "Yahrtzeit text"). Current extractor: `null`,
misdetects "Yahrtzeit" as a false person (same bug class as
"Messaged"/"Solicited", just not yet in the exclusion list). **Checked
whether the underlying fact is already tracked elsewhere**: yes -- this
donor already has a first-class row in the dedicated `yahrtzeits` table
(`deceased_name_english: "Esther"`, `relationship: "Wife"`, `hebrew_month:
"Av"`, `hebrew_day: 23`). The durable fact (wife's Yahrtzeit date) is
already correctly tracked in its purpose-built table; what this
interaction adds is only that *this particular touch* (a text
acknowledging it) happened -- temporary interaction context, not new
durable data. **Recommendation**: leave relationship_summary null/cleared
for this donor (a human call, not automated in this task) rather than
manually re-typing a fact that duplicates the yahrtzeits table.

**Zachter** (`19af69d6-...`): source interaction `8b502028-...` (text,
2026-08-18), note: `"Texted video from first day of Zman and thanked him
for his support that makes it happen"`. Current extractor: `null`,
misdetects "Zman" as a false person. No dedicated table tracks
institutional calendar milestones like "Zman" (unlike Yahrtzeit/birthday/
anniversary, which do have dedicated tables) -- this is routine
stewardship-acknowledgment language tied to a recurring yeshiva calendar
event, not a durable donor-specific fact. **Recommendation**: a human
should decide case-by-case; a reasonable manual value would be a short
paraphrase like `"Thanked for supporting the yeshiva's Zman."`, but this
is lower-value/more borderline than the three solicitation-amount cases
above.

**SUPERSEDED 2026-08-21.** Both the "leave null" recommendation for
Semmelman and the "manual paraphrase" suggestion for Zachter were
overtaken by a real product decision and implementation, not a manual
edit: after a domain clarification (Zman = Yeshiva semester/term,
not generic calendar chatter), `FACT_SIGNAL_PATTERN` gained a
`yahrtzeits?` entry and a new, narrow `ZMAN_APPRECIATION_PATTERN`
(zman/semester + an appreciation-for-support phrase, in the same
sentence -- corpus-evidence-backed, not a bare-word trigger) was added.
The real extractor now produces, automatically: Semmelman -- `"Sent
text on wife's Yahrtzeit to acknowledge it."`; Zachter -- `"Texted video
from first day of Zman and thanked him for his support that makes it
happen."` Both were applied to D1 via compare-and-swap (not hand-typed)
and are now live and verified on Independent Staging. See "Zman/
Yahrtzeit Extraction Implementation + Historical Preview" and "Zman/
Yahrtzeit Deployment + Historical Repair -- APPLIED" above for the full
implementation/deployment record. The dollar-amount category discussed
in Part C below was, independently, effectively resolved a different
way: the Ask/Solicitation feature (Option (b) from that section) became
the dedicated home for solicitation amounts, and Klein/Pfeiffer/
Rovinsky's dollar facts were backfilled into real `asks` rows instead of
ever needing a `FACT_SIGNAL_PATTERN` dollar-amount keyword.

### Part C -- Extractor Expansion Recommendation (not implemented)

Narrow assessment of whether `lib/capture/interaction.ts`'s
`FACT_SIGNAL_PATTERN` should be expanded to recognize Yahrtzeit, Zman, and
explicit dollar amounts. **Not implemented in this task.** Distinguishing
by category:

1. **Yahrtzeit-related facts -- durable, but already tracked elsewhere.**
   The `yahrtzeits` table (schema confirmed, and confirmed populated for
   the one case investigated) is the correct, purpose-built home for this
   durable fact (Hebrew-calendar-aware recurrence, editable, its own
   `yahrtzeitChanges` audit trail). Adding a generic "Yahrtzeit" keyword
   to `specificFacts` would duplicate/risk drifting from that table rather
   than add new information. **Recommendation: do not add** a generic
   Yahrtzeit fact-signal keyword; if anything, the donor page's existing
   Yahrtzeit surfacing (see `relationship-date-events`/`important-dates`
   tests) is the right place to make this more visible, not
   relationship_summary.
2. **Zman/yeshiva timing context -- temporary interaction context, not a
   durable relationship fact.** No dedicated table exists for it (nor
   should one, necessarily -- it's an institutional calendar event, not
   donor-specific data), but it's also not obviously worth a standing
   fact-signal keyword: promoting every "Zman"/holiday-adjacent mention
   risks pulling in routine liturgical-calendar chatter as if it were a
   special donor insight. **Recommendation: do not add** a generic
   keyword; treat these on a case-by-case manual basis (as done for
   Zachter above) rather than automating.
3. **Explicit solicitation/donation amounts ("$5k", "$10,000", etc.) --
   giving/solicitation information that currently has nowhere else to
   live.** Confirmed via schema: `giving_activities` only tracks
   confirmed/imported financial gifts (JL Solutions is the system of
   record per `docs/FUNDRAISING_OS_PRINCIPLES.md`); there is no dedicated
   pledge/ask/solicitation-tracking table. Unlike Yahrtzeit, a solicitation
   amount genuinely has no other home today, and per this task's own
   investigation, silently regenerating with the current extractor would
   discard it (all 3 Solicited cases above). **Recommendation: this is the
   one category worth a real product decision** -- either (a) add narrow,
   carefully-scoped dollar-amount fact-signal support (risk: false
   positives on incidental dollar mentions unrelated to a live ask, and
   scope creep toward relationship_summary becoming a pledge tracker,
   which `FUNDRAISING_OS_PRINCIPLES.md` explicitly warns against -- "not a
   full CRM... accounting system"), or (b) build a small, purpose-built
   "solicitation/ask" field or table (mirroring how Yahrtzeit got its own
   table) so this data doesn't have to route through free-text extraction
   at all. Not implemented here -- flagged for a separate, explicit
   decision.

Challenge to the premise: none of these three categories should be
treated the same way. Yahrtzeit is durable but has its own home already;
Zman is temporary/low-value; solicitation amounts are durable, giving-
adjacent, and currently homeless. relationship_summary should stay a
concise "what should I know" surface, not become a generic interaction-
note dump for all three.

**Where this landed, 2026-08-21 (see the SUPERSEDED note earlier in this
section for the full record):** Yahrtzeit's "do not add" recommendation
was overridden by an explicit product decision -- it's now a simple
`FACT_SIGNAL_PATTERN` entry, same tier as birthday/anniversary. Zman's
underlying caution actually held up: no bare "zman" keyword was ever
added (a bare keyword would have hit real broadcast/generic false
positives, confirmed by a later corpus audit) -- instead a narrow
contextual rule (`ZMAN_APPRECIATION_PATTERN`) fires only when a
zman/semester mention co-occurs with genuine appreciation-for-support
language, matching this section's own instinct that generic Zman
mentions shouldn't become relationship facts. Solicitation amounts
found their home via the Ask feature, not a `FACT_SIGNAL_PATTERN`
change, exactly matching option (b) considered above.

## Important Product Decisions

Durable — do not accidentally reverse these:

- Shared multi-donor activities use one canonical `shared_activities`
  parent plus per-donor `interactions` rows, not a fully normalized join
  table or per-donor row cloning.
- `role='recipient'` = broadcast/outbound recipients (text, email,
  photo/update sent to many).
- `role='participant'` = actual participants (shared meeting/call).
- Recipient touches update Last Contact.
- Recipient touches do NOT suppress substantive/contact-gap outreach
  recommendations — **live-verified** (see Verification below):
  `daysSinceSubstantiveContact` stays `null` for a donor whose only touch
  is `role='recipient'`, even though `daysSinceLastContact` updates.
- Participant touches and every existing single-donor interaction type
  continue to count as substantive contact, unchanged.
- One role applies to the whole shared activity in v1 (not per-donor).
- Bulk activity creation never automatically creates reminders or
  recommendations, for any recipient — live-verified.
- Single-donor interaction entry remains on the existing
  `POST /api/interactions` / `PATCH /api/interactions/[id]` path,
  untouched.
- The multi-donor shared route (`/api/interactions/shared`) only engages
  for 2+ donors.
- Photo is not a separate interaction type — represented by its real
  channel + summary text (e.g. "Text Message" with the photo described in
  the note). This also governs Text Message: WhatsApp/iMessage/SMS/photo
  are all subchannels of the one `text` type, never their own type.
- Backend recipient cap: 200 donors per shared activity.
- Large-selection UI confirmation begins at 15 selected donors (never
  blocks the save) — live-verified with 16 selected.
- **Text Message is now a real, implemented interaction type** — canonical
  DB value `text`, display label "Text Message". `interactions.type` has
  no CHECK constraint in the live schema (enforcement is application-level
  only, via the `kinds`/`KINDS`/`allowedKinds` validation sets), so only
  `shared_activities.type`'s CHECK required a migration (0031) to widen.
  Both TypeScript enums are kept in sync by convention, not by a shared DB
  constraint — see the doc comments on both columns in `db/schema.ts`.
- Text Message role/scoring semantics are NOT special-cased: the existing
  generic role-based rule above (`role='recipient'` = broadcast,
  `role='participant'` = substantive) applies to Text Message exactly like
  every other type, with no per-type branch — live-verified directly at
  the data layer (see Verification below). Text Message defaults to
  `role='recipient'` in the multi-donor picker (`ROLE_DEFAULT_BY_KIND` in
  `CaptureExperience.tsx`), remaining overridable to `participant` via the
  existing role picker.
- `continue_conversation` (in `lib/relationships/recommendation-candidates.ts`)
  now only fires when the most recent completed interaction's note
  contains real commitment language (reused from
  `relationshipSnapshotDetails` in `lib/capture/interaction.ts`) — no
  longer on the mere existence of a recent touch. Its eligibility window
  (≤30 days) and every other candidate/the scoring formula in
  `recommendation-rank.ts` are unchanged. When it doesn't fire and
  nothing else applies, the recommendation is honestly `null` — the UI's
  existing "No suggested action available" / "None available" copy
  covers that, no new fallback string was added.
- The donor page's shared-activity row now offers a separate
  "Add note for this donor" action (a plain link to
  `/capture?donorId=...`, same prefill convention as the page's own
  "+ Log interaction" link) alongside "Edit shared activity". This is
  structurally guaranteed to create only an ordinary single-donor
  interaction (`shared_activity_id`/`role` both null) — the single-donor
  `POST /api/interactions` route never references `shared_activities`.
  "Detach and customize" was NOT built; not needed given this reuse.
- Relationship intelligence quality gate (see Latest Completed Task): a
  generated fact/action must be specific, donor-relevant, and grounded in
  the actual note — never a generic channel/type label, never a
  sentence-start verb misclassified as a person, never boilerplate
  generated only because a note exists. Enforced with deterministic
  regex/keyword rules in `lib/capture/interaction.ts`, not an opaque
  scoring system. `specificFacts` (real quoted sentences) replaced the
  old category-label `topics` field; `recommendedNextAction` is `null`,
  not a manufactured placeholder, when no commitment sentence parsed.
  Quality enforcement lives entirely at the extraction/generation layer
  (`actionableRelationshipSnapshot`) — consuming code (recommendation
  engine, donor page, Meeting Brief, Assistant, capture preview) was NOT
  redesigned, it just correctly handles the now-nullable
  `relationshipSummary`/`recommendedNextAction`.

## Database / Migration State

Migration `0030_shared_activities.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-19. (See prior verification detail in git history of this file —
unchanged since, not re-verified in this update.)

Migration `0031_interactions_text_type.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-18.

Applied via `wrangler d1 execute fundraising-os-staging-db --remote --file
drizzle/0031_interactions_text_type.sql --config wrangler.staging.jsonc`.
7 statements executed (58 rows written — the 2 pre-existing
`shared_activities` rows being rebuilt with the widened CHECK). Verified
directly against `sqlite_schema` pre/post: `interactions`'s own table DDL
and all 3 of its indexes (`interactions_donor_date_idx`,
`interactions_shared_activity_idx`,
`interactions_shared_activity_donor_uidx`) were confirmed present and
untouched (this migration never rebuilds that table — it has no CHECK
constraint to widen); `shared_activities`'s CHECK now reads `type IN
('call','email','meeting','visit','note','personal','gift','text')` and
its index (`shared_activities_user_date_idx`) survived the rebuild;
row counts unchanged pre/post (`interactions`=12, `shared_activities`=2).

Migration `0032_asks.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-19, ~17:00:03Z, as part of the Ask/Solicitation Phase 1 rollout.
See "Ask / Solicitation Feature — LIVE ROLLOUT VERIFICATION" above for
full verification detail.

Migration `0033_pledge_payment_plans.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-20, as part of the Pledge Payment Plan feature rollout. See
"Pledge Payment Plan — LIVE ROLLOUT VERIFICATION" above for full
verification detail. **(This corrects a prior stale statement below
that had said "no migration beyond 0032" through several later
completed tasks -- fixed 2026-08-21.)**

No migration beyond 0033 exists or has been applied.

## Deployment State

**Corrected 2026-08-21 -- this section had gone stale (still describing
the 2026-08-20T02:34:01Z deploy through several later completed and
deployed tasks: the Pledge Payment Plan rollout, the grandchild-gap fix,
the Zman/Yahrtzeit fix, the outcome-route fix, and the people-extraction
fix, each of which has its own full deployment record in its own dated
section above). This section is now a pointer to the true current state,
not a duplicate of it.**

**Live -- current as of this deploy.** Deployed commit `a30316f` ("Add
Option A: explicit review/accept flow for outcome-note Relationship
Snapshots" -- see "Outcome-Note Relationship Snapshot Review/Accept Flow
-- Option A" above), Worker version
`0673c91a-de71-4f29-950b-34f71fc3fbec`, confirmed via the deploy
command's own printed Version ID and live-verified directly against D1
on real donor records. This supersedes every earlier version ID recorded
anywhere in this file. For the exact current git SHA (which may have
advanced past `a30316f` by documentation-only commits that touch no
application code -- the deployed Worker always reflects the latest
actual code change, not necessarily the latest commit), see "Current Git
State" at the top of this file, which is the authoritative pointer kept
in sync going forward.

Worker: `fundraising-os-staging`
URL: `https://fundraising-os-staging.sgoldstein.workers.dev`
D1: `fundraising-os-staging-db` (bound as `env.DB`)

Everything recorded in this file as deployed and live-verified remains
so as of this correction: multi-donor shared activities (Phase 1 + 2),
Text Message, the mobile UX fixes, the relationship-intelligence quality
pass and its later extraction fixes (grandchild/grandparent, Yahrtzeit,
Zman, people-extraction false positives), the Ask/Solicitation Phase 1
feature and its historical backfill, the request-scoped duplicate-loader
fix, the Today's-Agenda birthday-bucketing + open-pledge payment-recency
fixes, the Pledge Payment Plan feature, the outcome-route acceptance-gap
fix (Option B), and the outcome-note Relationship Snapshot review/accept
flow (Option A, which restores a gated write on top of Option B's
removal -- see that section above for why these are not in conflict).
Each has its own dated section above with full live-verification detail
-- this section intentionally does not repeat it.

Historical note (kept for continuity, not current): the 2026-08-20
deploy referenced above by the now-superseded version ID required two
retries due to a transient network/DNS outage in the environment
(`dash.cloudflare.com`/`api.cloudflare.com` briefly unresolvable);
succeeded once connectivity returned, independently confirmed via
`wrangler deployments list` before live-testing.

## Verification

**Automated (local):**
pnpm test: PASS (all suites)
pnpm exec tsc --noEmit: PASS
pnpm run build:staging-independent: PASS

**Live, on Independent Staging (2026-08-19), using two real donor pairs
from the actual staging roster, all created via the deployed
`/api/interactions/shared` API and cleaned up afterward:**

- 2-recipient shared activity: parent + 2 linked `interactions` rows
  created, both `role='recipient'`, 2 "added" audit rows, both donor
  timelines showed "Sent to 2 donors" with the canonical summary, Last
  Contact updated for both. **Scoring rule confirmed directly at the data
  layer**: the substantive-contact query (excludes `role='recipient'`)
  returned no row for the test donor even after the touch, while the
  all-types Last Contact query did — proving `reconnect_contact_gap` is
  not suppressed by a recipient-only touch. No recommendation/reminder row
  was created (`recommendations` count stayed at 4 throughout).
- 2-participant shared activity: parent + 2 linked rows, both
  `role='participant'`, timeline/Meeting Brief showed "2 participants",
  Last Contact updated, and the substantive-contact query **did** return a
  row for these donors (proving a participant touch counts as substantive,
  as designed). No auto-reminder created.
- Edit: one `PATCH` updated only `shared_activities.summary`; both linked
  donors' timelines immediately showed the new text; the per-row
  `interactions.summary` columns were confirmed unchanged (no fan-out
  write).
- Remove one recipient: only that donor's `interactions` row was
  soft-cancelled (`source` → `cancelled:...`); the other donor's row and
  the parent were untouched; `recipient_count` decremented 2→1; exactly
  one "removed" audit row was added; the removed donor's Last Contact
  correctly reverted to "None recorded".
- Delete whole activity: performed on both test activities. Every
  still-linked row was cancelled and `shared_activities.deleted_at` was
  set on both. Final sweep confirmed zero active `shared_activities` rows
  and zero active `interactions` rows still pointing at a
  `shared_activity_id` — no test data left active.
- Mobile: **functional** behavior verified live (mode toggle, live donor
  search/multi-select with no duplicates, role picker with type-based
  defaults, 15+/16-selected large-selection confirmation showing the exact
  approved wording and not auto-saving) all confirmed working on the
  deployed app. The **narrow-viewport visual** check (actual small-screen
  layout) could not be completed — the browser-automation tooling's window
  resize did not change the rendered viewport in this environment (stayed
  ~1280×720 regardless of the requested size). The responsive CSS rules
  themselves (chip wrapping, `@media (max-width:760px)` stacking for the
  picker/role/confirm UI) are already asserted present and passing in
  `tests/shared-activity-ux.test.mjs`, but true small-screen visual QA is
  still outstanding — see Outstanding Work.

**One live-testing observation, not a defect:** on a donor's very first
logged interaction (of ANY type — recipient, participant, or an ordinary
single-donor touch), the `continue_conversation` recommendation becomes
eligible (it only requires *some* completed interaction to exist) and
generally outranks `reconnect_contact_gap` in the "Suggested Action"
slot, even when the underlying touch is a broadcast. This is pre-existing
ranking behavior in `recommendation-rank.ts`, identical regardless of
role, and was explicitly out of scope for the Phase 1 approved rule
(which is specifically about `reconnect_contact_gap`'s own suppression
logic, confirmed correct above). Net effect: the "Last Contact recent +
reconnect_contact_gap clarifier" UI scenario is rarer in practice than
it might seem, because `continue_conversation` tends to win once any
interaction has ever been logged. Not changed as part of this rollout;
flagged for a future decision if desired.

All test interactions/shared-activities have been soft-cancelled/deleted;
none are active. `interactions` table now has 12 rows total (8 original +
4 test rows, all 4 now cancelled, never hard-deleted).

**Live, Text Message rollout (2026-08-18), using two real donors from the
actual staging roster, both created via the deployed app UI and cleaned up
afterward:**

- Single-donor Text Message: created for "Dr. & Mrs. Yaakov Abdelhak" via
  the single-donor capture form. Confirmed at the data layer: `type =
  'text'`, `role = NULL`, `shared_activity_id = NULL`. Timeline badge
  read "Completed · Text Message" (friendly label, never the raw enum
  value) and "Last meaningful contact" updated to the capture date.
- Shared Text Message, `role='recipient'`, 2 donors ("Mr. & Mrs. Ari
  Abramovitz", "Mr. & Mrs. Shaya Abramson"): the multi-donor picker
  defaulted the role toggle to "Recipients" the instant Text Message was
  selected (no manual step needed), matching the approved default.
  Confirmation screen read "Sent to 2 donors" / "Text Message on Aug 18,
  9:42 PM" and explicitly stated Last Contact was updated but the touch
  "does not, by itself, count as a substantive-contact touch" and that
  "No reminders were created." **Verified directly against
  `fundraising-os-staging-db`, not just the UI**: both `interactions` rows
  had `type='text'`, `role='recipient'`, the same `shared_activity_id`;
  the plain Last-Contact query (`MAX(occurred_at)`, no role filter)
  returned the touch timestamp for both donors; the exact production
  substantive-contact query (same query, `AND (role IS NULL OR role !=
  'recipient')`) returned **zero rows** for both donors, proving the
  recipient touch does not suppress `reconnect_contact_gap`; a query
  against `recommendations` for either donor with an open, text-related
  row returned 0 — no automatic reminder was created.
- No per-type branch exists anywhere in the scoring path — the SQL
  condition that excludes `role='recipient'` from
  `lastSubstantiveContactAt` (in `lib/workspace/live-data.ts`) is entirely
  type-agnostic, so this behavior is structural, not something that could
  regress for Text Message specifically without also breaking every other
  shared type.
- Cleanup: the single-donor row was archived via `DELETE
  /api/interactions/:id` (`action: "archive"`) and the shared activity was
  deleted via `DELETE /api/interactions/shared/:id` (`action:
  "delete-activity"`) — both are the app's own normal routes (invoked
  directly rather than by clicking the UI's confirm-dialog buttons, to
  avoid a blocking native `window.confirm()` in browser automation; the
  server-side effect is identical to clicking through). Final state
  confirmed via SQL: all 3 test rows now read `source =
  'archived:capture:text'` or `source = 'cancelled:manual'` — soft
  ended, never hard-deleted, consistent with every other cleanup in this
  project.

**Live, Mobile UX fixes rollout (2026-08-18), against real staging donors
and a real shared activity, cleaned up afterward:**

- **RecipientPicker overlap**: `resize_window` does not change the true
  rendered viewport in this environment (confirmed: `window.innerWidth`
  stayed 1280 after requesting 390×844) — same limitation as the prior
  session. Instead, the real `.content` container was narrowed to 375px
  via direct DOM style (same layout engine, same real CSS cascade, just a
  narrowed element instead of a narrowed window — valid for this bug
  since none of the relevant grid rules are viewport-media-query-gated).
  Before the fix: searching "Rosen" showed severely overlapping rows
  (`firstRow.offsetHeight` was 49px while `firstRow.scrollHeight` — the
  content's actual required height — was 175px). After deploying the
  fix: rows are fully separated, each row's height matches its own
  content, secondary metadata truncates to one line
  ("58252 · drose…" instead of wrapping across 3+ lines).
- Selected-donor state confirmed live: tapping a result shows a
  checkmark, green highlight, and "1 selected" with a chip below.
- **Shared-activity edit warning**: opening "Edit shared activity" on a
  real 2-donor activity showed, verbatim: "This change affects all 2
  donors linked to this activity -- it edits the one shared summary,
  type, and date, not just this donor's copy," in a visually distinct
  amber box, and the save button read "Save for all 2 donors".
- **Donor-specific note**: clicking "Add note for this donor" navigated
  to `/capture?donorId=...` prefilled with the correct donor in
  single-donor mode. After saving, verified directly against D1: exactly
  one new `interactions` row, `donor_id` = the one donor, `role`/
  `shared_activity_id` both `NULL`. The shared activity's own row was
  re-queried afterward and its `summary`/`recipient_count` (2) and both
  linked donors' `role='participant'` were unchanged.
- **Suggested Action wording**: reproduced the exact originally-reported
  case (a Text Message interaction with note "Text message", no
  commitment language) — Suggested Action showed "None available" /
  "No suggested action available" in place of the old "Continue the
  conversation from the recent text about 'Text message'."
- **Mobile Suggested Action layout**: with the `.content` container
  narrowed to 375px and the exact shipped CSS rule applied, the three
  numeric KPI tiles (Lifetime Paid, Most Recent Paid Gift, Open
  Commitments) rendered as compact columns in one row, and Suggested
  Action spanned the full width beneath them with room for natural
  prose — confirmed visually via screenshot.
- Cleanup: all 3 test rows (the shared activity + its 2 links, plus the
  donor-specific note) archived/cancelled via the app's own routes,
  confirmed via SQL (`source` = `archived:capture:email` /
  `cancelled:manual`), never hard-deleted.

**Live, relationship-intelligence quality pass (2026-08-19), using one
real staging donor ("Mr. & Mrs. Ari Abramovitz"), all three interactions
created via the deployed app UI and cleaned up afterward:**

- Generic Text Message, no meaningful fact ("Messaged about the building
  fund update."): capture preview showed "No meaningful relationship
  details detected." with no checkbox; saved with no "Relationship
  snapshot refreshed" confirmation ("Relationship snapshot unchanged —
  The generated draft was not accepted, so it was not saved." instead).
  Confirmed directly in D1: `donors.relationship_summary` /
  `institutional_memory` stayed `NULL`.
- Real fact ("Ari mentioned that his daughter is starting seminary in
  Israel this fall."): preview showed the plain sentence with the opt-in
  checkbox; checked and saved — confirmed directly in D1 that
  `relationship_summary` is exactly that sentence, no field labels. Donor
  page RELATIONSHIP SNAPSHOT card rendered the same clean sentence;
  SUGGESTED ACTION read "Reach out and reference: [the sentence]" (no
  "what's already known" redundancy, no field-dump echo); evidence read
  `Recorded relationship note: "..."` (never `relationship_summary/
  institutional_memory:`); no `.recommendation-meta` element was even
  present (timing is null for this kind, so nothing renders — confirming
  "Confidence:" is gone). KPI card showed the fixed "Review before next
  outreach" headline.
- Concrete next action ("Will send the updated pledge form by Friday.",
  left unaccepted to isolate this from the fact test above): donor page
  SUGGESTED ACTION read "Send the updated pledge form by Friday." — a
  direct, concise action, matching the task's own "strong example" style
  — both in the detail view and the KPI card, with no truncation needed.
- Cleanup: all 3 test interactions archived via the app's own
  `DELETE /api/interactions/:id` route (`action: "archive"`), confirmed
  via SQL (`source` = `archived:capture:text` / `archived:capture:note`).
  Archiving the 2nd/3rd interaction automatically triggered the existing
  `contextStatement` revert logic in `app/api/interactions/[id]/route.ts`,
  which reset `donors.relationship_summary`/`institutional_memory` back
  to `NULL` (their state before this test) with no manual SQL needed —
  confirmed directly in D1.

## Safety / Infrastructure State

This rollout (shared-activity, Text Message, mobile UX fixes, and
relationship-intelligence quality work):
- D1: migrations 0030 and 0031 applied to `fundraising-os-staging-db`
  only; all read/write operations scoped to that database via `wrangler
  d1 execute --remote`; no other database touched.
- R2: not touched.
- Backup/restore workflows (`.github/workflows/d1-*.yml`): not touched.
- Production: not touched (no production Worker/D1 binding exists in
  `wrangler.staging.jsonc`; confirmed before any write).
- `origin/main`: not touched — checked before and after both the Text
  Message and mobile-UX-fixes rollouts, unchanged at
  `4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58` throughout.
- No unexpected `recommendations` rows were created at any point
  (checked directly by donor_id + status/action filter after each live
  test — 0 rows).
- `donors`/`giving_activities` row counts unaffected by any of these live
  tests (interactions/shared_activities only).

## Outstanding Work / Known Limitations

- True device/viewport visual QA is still not possible in this
  automation environment (`resize_window` does not change
  `window.innerWidth`). The mobile UX fixes task worked around this by
  narrowing the real `.content` DOM element to 375px and applying the
  exact shipped CSS — a real-cascade, real-layout-engine check that is
  strong evidence but not identical to a true device viewport (it can't
  exercise viewport-media-query-gated rules like the sidebar/nav
  collapse). Recommend a genuine phone/tablet check, or a different
  automation environment, before treating any mobile layout claim here
  as fully pixel-verified.
- The `continue_conversation` vs. `reconnect_contact_gap` ranking
  interaction described above (Verification section, from the earlier
  shared-activity rollout) is unaffected by this task's wording fix and
  remains a real, observed UX nuance worth a product decision if the
  copy ever needs to distinguish "continuing a broadcast" from
  "continuing a real conversation." continue_conversation's ELIGIBILITY
  on a broadcast recipient touch was explicitly not changed in this task
  (only its wording, and only when it does fire) — flagging again per
  the task's own instruction to report rather than silently redesign it.
- Shared-activity recipient list editing beyond "remove one donor" (e.g.
  adding a donor to an already-saved activity) is not built.
- Meeting Brief's other surfaces (discussion topics, people-mentioned)
  are not role-aware — only the "Last Interaction" card is.
- "Add note for this donor" always launches an empty single-donor
  capture form — it does not pre-fill any context from the shared
  activity it was opened from (e.g. the shared summary or date). Not
  requested by this task; worth considering if fundraisers want that
  context carried over.
- **RESOLVED 2026-08-21 (was: "Existing pre-fix relationship_summary
  rows... 2 remain (Semmelman/Zachter), pending a human decision").**
  All 5 of the original NEEDS_REVIEW rows are now closed: Klein/
  Pfeiffer/Rovinsky via the Ask feature's historical backfill (their
  dollar-amount facts became real `asks` rows, `relationship_summary`
  cleared to `NULL` -- see "Ask / Solicitation Feature -- HISTORICAL
  BACKFILL AND CLOSURE" above); Semmelman/Zachter via the Zman/Yahrtzeit
  extraction fix and its historical repair (both now have real,
  extractor-generated `relationship_summary` values, applied via
  compare-and-swap and live-verified -- see "Zman/Yahrtzeit Extraction
  Implementation + Historical Preview" and "...Deployment + Historical
  Repair -- APPLIED" above). Nothing remains open from this item.
- **RESOLVED 2026-08-21 (was: "FACT_SIGNAL_PATTERN has no keyword
  coverage for Yahrtzeit/Zman/dollar amounts").** Yahrtzeit is now a
  simple `FACT_SIGNAL_PATTERN` entry; Zman has a narrow contextual rule
  (`ZMAN_APPRECIATION_PATTERN`, requiring genuine appreciation-for-
  support language alongside it, not a bare keyword -- see "Zman/
  Yahrtzeit Extraction Implementation + Historical Preview" above for
  the full corpus-evidence-backed design). Solicitation dollar amounts
  were never added to `FACT_SIGNAL_PATTERN` -- the Ask/Solicitation
  feature became their dedicated home instead (option (b) from the
  original Part C analysis), which is the outcome this bullet was
  originally waiting on a decision about.
- Place/holiday names (e.g. "Israel", "Rosh Hashanah") can still appear
  in the `people` array — genuinely ambiguous with real given names in
  this donor community (e.g. "Israel" is also a real first name), so no
  attempt was made to filter them; a full named-entity/place gazetteer
  was judged out of scope for a deterministic-rules-only fix. **Still
  accurate as of the 2026-08-21 people-extraction false-positive fix**
  (see "People-Extraction Fix" sections above) -- that task fixed a
  different, evidenced class of false positive (Zman/Yahrtzeit/Kollel/
  disposition-verb/import-provenance words being misread as people), not
  this broader place/holiday-name ambiguity, which remains a genuine,
  unaddressed, low-impact known limitation. Meeting Brief's "PEOPLE
  MENTIONED" card is still the only reader of this field, and this class
  of imprecision still doesn't affect the main Relationship Snapshot
  text, which is driven by `specificFacts`, not `people`.
- **RESOLVED 2026-08-21 (was: outcome notes could no longer contribute to
  a donor's Relationship Snapshot at all, since Option B removed the
  write entirely rather than gating it).** Option A restores that
  capability behind an explicit review/accept flow, live-verified -- see
  "Outcome-Note Relationship Snapshot Review/Accept Flow -- Option A"
  above. Its own known limitations (replace-not-merge on accept, matching
  every other accept path in this codebase; no disposable test donor on
  staging) are recorded in that section, not repeated here.
- The fact-signal sentence extraction (`specificFacts`) can occasionally
  promote a sentence that's technically "specific" (contains a signal
  keyword like "family") but still fairly generic in substance (e.g. "A
  nice family update, all is well" would NOT pass — verified null in
  testing — but a borderline case worded differently could). No proper-
  noun/digit specificity filter was added on top, since the task's own
  worked examples (e.g. "Concerned about pledge balance") don't
  consistently contain one either — this was a deliberate trade-off, not
  an oversight.

## Next Approval Required

**The Ask/Solicitation feature is now COMPLETE / CLOSED FOR V1** —
implemented, migration applied, deployed, end-to-end live-tested, and the
3 known historical cases backfilled with their broken relationship_summary
values cleared (see "LIVE ROLLOUT VERIFICATION" and "HISTORICAL BACKFILL
AND CLOSURE" above). No unresolved blocker remains for Ask v1. What
remains is intentionally deferred, not blocking (see "Intentionally
Deferred Ask Enhancements" below) — nothing here requires action before
the feature can be considered done:
1. **Meeting Brief completeness gap** (pre-existing, not a regression):
   the Meeting Brief page never renders `brief.openAsks` as its own line;
   a pending ask only becomes visible there if it happens to win the
   single Suggested Action slot. Needs a decision on whether/how to add a
   dedicated "Open ask" line to `app/donors/[id]/meeting-brief/page.tsx`
   (the `askLine()` formatter and `brief.openAsks` data already exist and
   are correct — this is a rendering gap, not a data or logic gap).
2. **"Add follow-up" on an already-created pending ask** (§27 item 4) —
   not built in Phase 1, reminders currently only attach at ask-creation
   time.
3. **Genuine mobile/narrow-viewport visual QA** — still not achievable in
   this browser-automation environment; recommend a real device or
   different tooling before treating any Ask UI mobile-layout claim as
   pixel-verified.

### Intentionally Deferred Ask Enhancements

Explicitly out of scope for v1, not overlooked — do not build these
without a separate, explicit approval:
- Adding reminders later from an existing Ask card (item 2 above).
- Cross-donor Assistant search / "what did I ask Klein for?" (needs
  donor-name-resolution infrastructure that doesn't exist for any fact
  type today — see design doc §16).
- Follow-up-interaction-to-Ask linking beyond the originating interaction
  (design doc §8, Option A/D was chosen deliberately).
- Pipeline/reporting views, sales stages, probability, forecasting (never
  in scope — see design doc §25).
- Automatic gift-to-ask matching or auto-close from payments.
- Ask support on shared/multi-donor interactions (structurally excluded —
  verified zero ask-related code in `app/api/interactions/shared/route.ts`).
- Meeting Brief dedicated `openAsks` line (item 1 above).

**RESOLVED 2026-08-21, no longer open (this whole subsection is kept
only as a historical record of what used to be pending here).** The
former "Separate, unrelated to Ask v1 closure" block below this line
used to recommend clearing Semmelman's `relationship_summary`, hand-
writing a manual value for Zachter, and flagged the dollar-amount
extractor question as needing its own decision. All three are now
closed by real, deployed work, not by this documentation edit:
Semmelman's and Zachter's `relationship_summary` were regenerated by the
extractor itself (Yahrtzeit fact signal + the narrow
`ZMAN_APPRECIATION_PATTERN`) and applied via compare-and-swap -- see
"Zman/Yahrtzeit Extraction Implementation + Historical Preview" and
"...Deployment + Historical Repair -- APPLIED" above; the dollar-amount
question was answered by the Ask feature becoming the dedicated home for
solicitation amounts rather than by extending `FACT_SIGNAL_PATTERN`.
Nothing from this item needs approval any more. (The original wording of
this now-resolved item is preserved in git history, per this file's own
preamble that git history is the source of truth for exact past
phrasing -- not worth duplicating verbatim here in a section whose whole
purpose is to state what's currently pending.)

**Also resolved since this section was last accurate, each with its own
full report above:** the outcome-route acceptance-gap issue (Option B --
the unconditional write was removed entirely, deployed, live-verified);
the people-extraction false-positive issue (Zman/Yahrtzeit/Kollel/
Dropped/Imported-Source, deployed, live-verified). Neither needs
approval or further action; both are closed.

**Genuinely still open, as of 2026-08-21:**
- **Outcome-note review/accept UI (Option A)** — the outcome-route fix
  (Option B) removed the unsafe unconditional write rather than building
  a full preview/accept flow for outcome notes. If the product wants
  outcome notes to be able to update `relationship_summary`/
  `institutional_memory` going forward, that requires new UI work
  (a client-side preview + accept step, reusing the existing
  compare-and-swap pattern from `app/api/interactions/[id]/route.ts`) --
  not started, needs its own explicit scoping and approval if wanted.
- Everything below this line was already-known, non-blocking, optional
  follow-up work (unchanged status) — see "Outstanding Work / Known
  Limitations" above for the full current list: genuine mobile/
  narrow-viewport visual QA (still not achievable in this automation
  environment), the Meeting Brief `openAsks` rendering gap, "Add
  follow-up" on an existing ask, the `continue_conversation`/
  `reconnect_contact_gap` ranking nuance, pre-filling shared-activity
  context into "Add note for this donor", and the place/holiday-name
  ambiguity in the `people` array. None of these block anything; each
  would need its own explicit approval before work begins.

Everything else described in this file as deployed and live-verified
remains so — the shared-activity feature, Text Message, mobile UX
fixes, the relationship-intelligence quality pass and its later
extraction fixes, the Ask/Solicitation feature and its historical
backfill, the Pledge Payment Plan feature, and the outcome-route fix are
all live on Independent Staging.

## Last Updated

2026-08-21T18:00:00Z (approximate)
Claude (Sonnet 5) — Corrected the synthesis design per explicit review:
the prior pass's per-category fixed decay windows conflated a fact's
subject (category) with its durability, so "his daughter is Danielle"
and "his daughter is getting married in November" — same category —
would have decayed identically. Added an independent `lifecycle` field
(`durable`/`time_bound`/`follow_up`, the user's own suggested names,
already matching this codebase's existing `openFollowUps`/`commitments`
vocabulary) with a deterministic assignment waterfall reusing existing
`COMMITMENT_PATTERN`/`RELATIONSHIP_CHANGE_PATTERN` regexes plus one new,
narrow calendar/relative-time signal. Defined that the fundraiser sees
and can lightly correct the assigned lifecycle at the existing
accept-time preview (one small addition, not a new screen); that durable
facts never decay (fixed baseline score); that follow-up facts never
enter Snapshot synthesis at all (excluded structurally, not by decay,
routed conceptually toward the existing reminders surface instead);
that supersession now requires matching category AND lifecycle, fixing
the exact identity-vs-event collision the user's examples described; and
a migration safeguard (clamp backfilled time-bound facts' decay clock to
the migration date, not their true historical date, so nothing vanishes
on day one). Reworked the worked example to 12 facts covering every
example given, showing the identity fact surviving 2.5 years while its
paired wedding-date fact correctly fades — the direct, concrete proof
this correction does what was asked. No code, schema, D1, or deployment
touched. Awaiting approval before implementation.

---

2026-08-21T17:00:00Z (approximate)
Claude (Sonnet 5) — Final design pass on Relationship Snapshot synthesis
behavior, per explicit approval of the durable-facts architecture and a
request to define synthesis precisely before implementation. Defined a
category taxonomy (6 categories, each with a supersession rule and a
decay window reusing `recencyScore`'s exact existing linear-decay
formula) and, while working the required donor example, caught and
corrected an oversimplification from the prior pass: `donor_research_
findings`' real supersession key is (category, a second specific field),
not category alone, which would have wrongly superseded unrelated
same-category family facts (a bar mitzvah vs. a later, unrelated
wedding). Fixed by scoping automatic same-category supersession to only
two "singular-state" categories (solicitation, health) where it's
actually valid, with every other category relying on decay plus an
explicit human override. Worked a full 10-fact, 2.5-year donor example
(a supersession chain, a contradiction, a pending vs. resolved ask, a
yahrtzeit, giving history) showing the exact resulting `relationship_
summary`/`institutional_memory`, and traced precisely what Meeting Brief
and Suggested Action should and should not consume. Answered every
explicit question asked (eligibility, count, recency, old-fact
visibility, exclusion of superseded facts, temporary-vs-durable,
structured-data influence without duplication, deterministic-vs-AI
synthesis with an explicit hallucination-prevention argument,
persistence model, edit/archive/supersede consequences, and cross-
surface consistency). No code, schema, D1, or deployment touched.
Awaiting approval before implementation.

---

2026-08-21T16:00:00Z (approximate)
Claude (Sonnet 5) — Investigation/design only, per explicit instruction
that the Option A replace-on-accept behavior is not the desired
long-term product model. Audited every current write path into
`donors.relationship_summary`/`institutional_memory` end to end
(Capture, edit/archive, Option A, and a fourth previously-undocumented
path in the Monday `confirm_contact` import flow), determined
`institutional_memory` is not structurally suitable as a durable
accumulation layer (it is a templated echo of the single most-recently-
accepted note, not an accumulation of anything), and found that
`donor_research_findings`' already-shipped status/supersession model is
directly reusable for this problem. Compared three architectures
(extend current fields / dedicated facts table / facts table via reused
research-findings pattern), worked through the five requested scenarios
(accumulation, non-superseding facts, supersession, cross-category
persistence, source-interaction edit/archive), and recommended the
third, with a 4-phase migration plan that backfills existing staging
data as the first durable fact before any write path changes. No code,
schema, D1, or deployment touched — `docs/AI-HANDOFF.md` is the only
file this task modified. Awaiting approval before any implementation.

---

2026-08-21T15:00:00Z (approximate)
Claude (Sonnet 5) — Implemented, tested, deployed, and live-verified
Option A: the outcome-note Relationship Snapshot review/accept flow (see
"Outcome-Note Relationship Snapshot Review/Accept Flow -- Option A"
above). Reused the existing Capture accept/CAS pattern rather than
inventing a new architecture, per explicit instruction; reported the
replacement-vs-incorporation investigation finding before writing any
destructive code (full replacement is this codebase's existing,
deliberate behavior everywhere, not something newly introduced here).
Added `tests/outcome-relationship-snapshot-accept.test.mjs` and updated
`tests/outcome-route-relationship-write-removed.test.mjs` in place to
match the new gated-write shape. `pnpm test`/`tsc --noEmit`/`build:
staging-independent` all clean. Committed `a30316f`, pushed, deployed to
Independent Staging only (Worker `0673c91a-de71-4f29-950b-34f71fc3fbec`).
Live-verified accept/reject/no-extraction/reopen-then-re-edit/shared-
activity-fan-out scenarios directly against D1 on real donors (Semmelman,
Zachter), all test data cleaned up and both donors' rows reverted to
their exact original baseline afterward. Reconfirmed the Option B
regression protection holds live (non-accepted completions with real
extractable content still leave relationship fields untouched). No
production/main access. Updated "Current Git State" to reflect this
commit/deployment.

---

2026-08-21T14:00:00Z (approximate)
Claude (Sonnet 5) — Documentation-only cleanup pass over this whole
file: no application code, tests, D1, migrations, Cloudflare config, or
deployment touched. Fixed forward-looking/status sections that still
described completed work as pending, without deleting any historical
report:
- Corrected a self-contradictory paragraph in "Ask / Solicitation
  Feature -- HISTORICAL BACKFILL AND CLOSURE" that said items 7-8 were
  "still open" immediately below the same section's own report of having
  completed them.
- Retitled "## Latest Completed Task" (misleading -- many later tasks
  had superseded it without anyone renaming it) with a pointer to the
  actual later sections and to "Current Git State" as the real current
  status.
- Fixed "Relationship-Summary Cleanup Audit"'s title and its Semmelman/
  Zachter/"Part C" sub-sections, which still recommended leaving
  relationship_summary null or hand-writing a manual value, and still
  recommended "do not add" a Yahrtzeit/Zman fact signal -- all three were
  later superseded by the real Zman/Yahrtzeit extraction fix and its
  historical repair. Added SUPERSEDED notes pointing to the actual
  resolution rather than deleting the original reasoning.
- Rewrote "Deployment State" (was still describing a 2026-08-20T02:34:01Z
  deploy through 5 later shipped deploys) to point at the real latest
  deployment (`befa0fb`, Worker `70dd7081-...`) and at "Current Git
  State" as the thing to trust going forward, rather than trying to stay
  a duplicate of it.
- Fixed "Database / Migration State", which stopped at migration 0032
  and never recorded that 0033 (Pledge Payment Plan) was applied
  2026-08-20.
- Fixed two "Outstanding Work / Known Limitations" bullets (the
  Semmelman/Zachter NEEDS_REVIEW item and the FACT_SIGNAL_PATTERN
  keyword-gap item) to reflect that both are resolved; left the
  genuinely-still-open items (mobile/viewport QA, Meeting Brief
  `openAsks` rendering gap, place/holiday-name ambiguity in `people`,
  etc.) unchanged since they're still accurate.
- Rewrote "Next Approval Required": removed the stale "clear Semmelman's
  relationship_summary / hand-write Zachter's" recommendation (resolved),
  noted the outcome-route and people-extraction issues are also now
  closed (neither needs approval), and added the one genuinely new open
  item this file hadn't recorded yet -- Option A (a full outcome-note
  review/accept UI), intentionally deferred when Option B shipped.
- Verified "Current Git State" against a fresh `git fetch` before
  starting this edit; it was already accurate (`befa0fb`) from the prior
  task's own correction, and is updated again below to point at this
  cleanup's own commit.
No new tasks were invented; every correction above points to a
follow-up decision only if the user wants one, not a task this session
decided needed doing. Two docs-only commits, pushed to
`feature/independent-cloudflare-sandbox`: `4ad8f3f` (the cleanup itself)
and a small immediate follow-up (this "Current Git State" section's own
pointer needed to reflect `4ad8f3f` as the new HEAD, per explicit
instruction) -- see "Current Git State" at the top of this file for
the final resulting SHA. No staging deployment performed or needed.
`origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-21T13:15:00Z (approximate)
Claude (Sonnet 5) — Deployed the people-extraction fix (`befa0fb`) to
Independent Staging (Worker `70dd7081-0fb3-4e69-8329-e115685f09fc`) and
live-verified it. Meeting Brief confirmed on the real deployed pages for
all three real corpus cases: Zachter (`Zman` gone), Semmelman
(`Yahrtzeit` gone), Weinschneider (`Discussed Kollel` gone, confirming
the structural multi-word fix specifically, not just the word-list
additions) -- all three donors' Relationship Snapshot/Suggested Action
text unchanged. Live-verified the false-negative protection too: created
a temporary test note for Zachter ("Spoke with Yaakov about the new
Zman...") without accepting any relationship-snapshot write, confirmed
`Yaakov` correctly still appears under People Mentioned while `Zman`
does not, then deleted the test interaction and confirmed Zachter's
donor row and the global interaction count were unaffected (back to the
exact pre-test baseline). Reconfirmed the outcome-route fix remains
intact (that file has zero diff since its own dedicated
deployment/verification; still covered by its own passing test in this
task's pre-deploy gate run). Corrected the stale "Current Git State"
section at the top of this file, which had still shown `0f75ad0`
through several completed tasks -- now reflects `befa0fb` and the
current deployed state. No additional code changes, no D1 writes beyond
the temporary test interaction (created and deleted within this task,
net zero), no extraction-rule broadening. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Full report: "People-
Extraction Fix -- Deployed + Live-Verified (2026-08-21)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-21T04:15:00Z (approximate)
Claude (Sonnet 5) — Investigated and fixed the people-extraction
false-positive (`Zman`/`Yahrtzeit` misread as donor names), separate
from and without touching Relationship Snapshot extraction. Traced the
full path: `mentionedPeople()` is a pure capitalized-word regex with an
exclusion list, no AI/NER, never persisted (no matching D1 column
anywhere), consumed by exactly one surface --
`lib/relationships/meeting-brief-model.ts`'s `peopleMentioned`, on the
Meeting Brief page. Read-only corpus audit (13 real capture/import
notes) found a broader class than the two known examples: `Zman`,
`Yahrtzeit`, `Discussed Kollel` (Weinschneider), `Dropped` (Danziger),
and `Imported`/`Source` (Monday-import provenance boilerplate, all 5
imported rows) -- the task's own longer candidate list (Shabbos, Yom
Tov, Purim, etc.) was checked and none of it actually appears in the
corpus, so none was added. Root cause: capitalization alone treated as
evidence of personhood, compounded by two structural gaps proven with
real notes -- a leading excluded word didn't stop a whole multi-word
span from being swallowed as one name ("Discussed Kollel"), and the
verb-follower check applied anywhere in the note instead of only
sentence-initially (dropping real names like "Yaakov" in "Spoke with
Yaakov about the new Zman"). Fixed both structurally (strip leading
excluded words from multi-word matches; restrict the follower check to
sentence-initial position) plus added the evidenced words to the
existing exclusion-list architecture -- no NER, no redesign. Proved
false-negative safety first: baselined every required case against the
UNFIXED code, then confirmed all pass post-fix, including "Yaakov"/
"David"/"Rabbi Cohen" surviving next to Zman/Yahrtzeit/Yeshiva.
Documented (not fixed, no evidence to fix against) the "Mr. Zman"
period-truncation edge case. Confirmed Zachter's/Semmelman's
`relationship_summary`/`institutional_memory` output byte-identical
before and after (`FACT_SIGNAL_PATTERN`/`ZMAN_APPRECIATION_PATTERN`
untouched). Since people are dynamically derived, this fix alone (no D1
write) will correct Meeting Brief for every affected donor once
deployed -- no historical cleanup needed or performed. New `tests/
people-extraction-false-positives.test.mjs`; `pnpm test` (all suites,
exit 0), `tsc --noEmit` (clean), `build:staging-independent` (succeeded)
all pass. Did not touch `app/api/interactions/[id]/outcome/route.ts` --
that issue stays closed/separate. **No D1 writes.** Per explicit
instruction, **not deployed** in this task -- committed to the feature
branch only, pending review. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Full report:
"People-Extraction False-Positive Investigation and Fix (2026-08-21)"
above. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-21T03:30:00Z (approximate)
Claude (Sonnet 5) — Implemented and deployed Option B from the
outcome-route investigation: removed the unconditional `donors.
relationship_summary`/`institutional_memory` write (and its
`extractInteraction` call) from `app/api/interactions/[id]/outcome/
route.ts` entirely -- replaced with an explanatory comment, no gating
flag added since the page has no review UI to give one meaning. All
other outcome behavior (status transitions, audits, follow-ups,
old-recommendation cleanup, undo, note persistence) untouched. New
`tests/outcome-route-relationship-write-removed.test.mjs` (structural
route-source assertions + the real `extractInteraction()` function
reproducing the investigation's own scenarios), `pnpm test`/`tsc
--noEmit`/`build:staging-independent` all passed. Committed `e20e10d`,
deployed to Independent Staging (Worker
`c73b2bf3-5283-435e-aabc-a2bb918a1f0f`). Live-verified on the real
deployed endpoint using donor 60830 (Zachter, whose exact good
`relationship_summary` was already known): created a real future-dated
scheduled call, reopened and completed it via direct `fetch()` calls to
the real API (avoiding the page's `window.confirm()` dialogs), with an
outcome note deliberately containing "dinner" (a real fact-signal word)
to prove the fix holds even when extraction would have produced content
under the old code. Result: Zachter's `relationship_summary`/
`institutional_memory`/`updated_at` were completely byte-for-byte
unchanged after completion, while the interaction itself transitioned
and logged normally -- the exact scenario the investigation warned
about, now proven fixed live. Cleaned up the test interaction and its
audit rows directly via D1 afterward; re-verified everything back to
the exact pre-test baseline (68 interactions, 0 audits, Zachter
unchanged). No D1 schema change, no historical-data repair, no
production access, `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Nothing discovered
contradicted the investigation -- Option B implemented exactly as
scoped. Full report: "Outcome-Route Fix -- Option B Implemented +
Deployed (2026-08-21)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-21T02:40:00Z (approximate)
Claude (Sonnet 5) — Full investigation (no code/D1/deploy change) of the
`app/api/interactions/[id]/outcome/route.ts` acceptance-gap finding.
Traced every caller through the real UI: `OutcomeExperience.tsx` is the
sole caller of the API, reached via "Edit outcome"
(`ActivityActions.tsx`), "Log Outcome"/"Edit or reopen"
(`UnifiedRelationshipTimeline.tsx`), and Today's `logOutcomeHref`
(`live-data.ts`) -- none of them show any Relationship Snapshot preview
or accept checkbox; the request body has no `acceptRelationshipSnapshot`
field anywhere. Found the "Log Outcome" link renders regardless of
`shared_activity_id`, and `isScheduledActivity`/`activityStatus` don't
depend on it either -- proving a shared/broadcast-originated interaction
CAN reach this route and bypass the shared route's own
no-relationship-write guarantee for that one recipient (not observed in
real data, but a real code-proven gap). Found the codebase already has a
safe pattern for this exact problem, unused here: `app/api/interactions/
[id]/route.ts`'s edit/archive handlers require `acceptRelationshipSnapshot
=== true` AND use a real compare-and-swap (`contextStatement()`'s `CASE
WHEN relationship_summary = <old> THEN <new> ELSE relationship_summary
END`) that never blindly clobbers -- the outcome route has neither
protection, just an unconditional `UPDATE`. Read-only staging audit:
zero interactions have ever gone through this route's complete/
no-response path, zero `activity_status_audits` rows exist at all, zero
interactions are currently scheduled -- **no historical data was ever
produced through this path**, so real-world exposure to date is zero,
though the bug itself is real. Reproduced with the real
`extractInteraction()` function (no D1, no real donor): completing a
routine, topically-unrelated scheduled activity for a donor with an
existing good, previously-accepted Relationship Snapshot **destroys**
that content -- confirmed both for a note that extracts unrelated
content and one that extracts nothing at all (silently nulls the
field), and confirmed this repeats on every edit of an already-completed
outcome, not just the first close. Recommended Option B (stop the
unconditional write entirely -- smallest change, zero current-data
cost, satisfies the governing acceptance rule immediately) over Option A
(build a full preview/accept UI reusing the existing CAS pattern, a
larger scoped follow-up) or Option C (asymmetric per-field treatment,
rejected as architecturally inconsistent). Defined the regression tests
an eventual fix would need (7 cases, including closing the shared-activity
gap found in this investigation) -- confirmed via reading `tests/
activity-outcome.test.mjs` that none of this behavior is currently
tested. Kept scope narrow: did not touch the Zman/Yahrtzeit
people-extraction issue, did not reopen the completed malformed-snapshot
cleanup, did not touch recommendation logic. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`); no code, D1, or deploy
change of any kind. Full report: "Outcome-Route Acceptance-Gap
Investigation (2026-08-21)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-21T01:50:00Z (approximate)
Claude (Sonnet 5) — Deployed the approved Zman/Yahrtzeit extraction fix
(`c29590a`) to Independent Staging (Worker
`e02f2b81-270d-419e-90d7-3a76d36c5e17`), live-verified Yahrtzeit and
Zman-appreciation capture behavior on the real deployed bundle with no
donor selected/no save clicked (zero persistence by construction) --
both real donor notes correctly offered the accept checkbox with the
exact desired preview text, a Zman-only negative control correctly
showed no meaningful details, zero console errors. Then applied the two
approved historical repairs via compare-and-swap: freshly re-read both
donors/interactions immediately before writing (unchanged from every
prior read), executed two independent single-statement CAS `UPDATE`s
(hex-encoded literals per this repo's existing convention, since both
malformed values contain embedded newlines), each gated on the exact
previously-reviewed malformed `relationship_summary` text -- both
returned `changes: 1`. Post-write D1 verification: both
`relationship_summary` values now byte-match the approved replacements;
both `institutional_memory` and `relationship_health` values
byte-for-byte unchanged; both source interactions byte-for-byte
unchanged; baseline row/count checks confirm exactly these two donor
rows changed and nothing else (interaction/recommendation counts
unchanged). Verified both donor pages render the new Relationship
Snapshot correctly and that Suggested Action now quotes the fixed text
instead of the old "Latest discussion topics: .../People mentioned:
.../Recommended next action: ..." scaffolding. Per explicit instruction,
left both known open issues untouched: the Zman/Yahrtzeit
people-extraction false positive, and `outcome/route.ts`'s ungated
relationship-data write. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Full report: "Zman/
Yahrtzeit Deployment + Historical Repair -- APPLIED (2026-08-20)"
above. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T22:30:00Z (approximate)
Claude (Sonnet 5) — Implemented the approved Yahrtzeit/Zman extraction
design (domain-clarified: "Zman" = Yeshiva semester/term).
`lib/capture/interaction.ts`: (1) added `yahrtzeits?` to
`FACT_SIGNAL_PATTERN` (simple fact signal, same tier as birthday/
anniversary); (2) added a new `ZMAN_APPRECIATION_PATTERN` --
`/(?=.*\bzman\b)(?=.*\b(?:thanks?|thanked|thanking|support)\b)/i` --
wired into `relationshipSnapshotDetails()` as a fourth sentence-filter
category, deliberately NOT a bare `zman` addition to
`FACT_SIGNAL_PATTERN`. Corpus evidence: "thank"/"support" each appear
in exactly 1 of 42 relevant rows (Zachter's own), making the
co-occurrence requirement a conservative, evidence-backed filter, not
speculative engineering. Verified every regression case from the task
against the real extractor: Zachter's and Semmelman's actual notes
qualify; 4 Zman-only and 3 thanks-only synthetic cases correctly don't;
the real broadcast Zman template correctly doesn't; one honest caveat
found and documented (a different real broadcast template still
qualifies, but proven to be from the pre-existing, unrelated `\bson\b`
entry, not this task's change -- not fixed, not a live production risk
since that content only ever arrives via the non-extracting shared
route). New `tests/relationship-snapshot-yahrtzeit-zman.test.mjs`
(wired into `package.json`), `pnpm test` (exit 0, all suites `fail 0`),
`pnpm exec tsc --noEmit` (clean), `pnpm run build:staging-independent`
(succeeded) all pass. Freshly re-read Zachter/Semmelman from D1
immediately before generating the historical preview -- both unchanged
from every prior read. Ran the NEW extractor against both exact source
notes (read-only, no write): Zachter's new `relationshipSummary` =
`"Texted video from first day of Zman and thanked him for his support
that makes it happen."`; Semmelman's = `"Sent text on wife's Yahrtzeit
to acknowledge it."` -- both match the desired targets exactly. Neither
donor's `relationship_summary`/`institutional_memory` was written to;
`institutional_memory` untouched by the code change itself. The
"Zman"/"Yahrtzeit" people-extraction false positive was confirmed to
NOT affect either new snapshot (verified neither contains "People
mentioned" text) and remains untouched, per instruction, as a separate
open task -- same for the `outcome/route.ts` ungated-write gap, neither
re-investigated nor touched beyond re-confirming it in the prior task.
**No D1 writes, no deploy** -- the extraction code change is committed
to the feature branch but not deployed to staging in this task. Full
report: "Zman/Yahrtzeit Extraction Implementation + Historical Preview
(2026-08-20)" above. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T21:50:00Z (approximate)
Claude (Sonnet 5) — Narrow, read-only design investigation into "Zman"
and "Yahrtzeit" for the 2 mixed donors flagged in the prior
comprehensive audit (Zachter 60830, Semmelman 72957), per explicit
instruction: determine correct extraction behavior BEFORE touching
`FACT_SIGNAL_PATTERN` or either donor's data. Fresh re-read confirmed
both donors/interactions unchanged from the prior audit. Ran the real,
unmodified extraction functions against both source notes: both
currently produce `relationshipSummary: null` (zero specific facts);
both also show a live, minor, separate bug where `mentionedPeople()`
misdetects "Zman"/"Yahrtzeit" as person names, which no longer leaks
into `actionableRelationshipSnapshot` (fixed by the quoted-sentence
redesign) but does still leak into `meeting-brief-model.ts`'s
`peopleMentioned` list -- noted, not investigated further, out of scope.
Corpus-scanned (read-only) all 42 interaction rows containing
"zman"/"yahrtzeit"/spelling variants: only 2 rows in the ENTIRE corpus
are single-donor-capture (Zachter's and Semmelman's own) -- the other 40
are all shared/broadcast-route rows (2 identical mass-template
messages sent to 38 distinct donors) that never run extraction at all,
confirming no other historical donor is affected by either vocabulary
question. Recommendation: **Yahrtzeit = SIMPLE FACT SIGNAL** (add
`yahrtzeits?` to `FACT_SIGNAL_PATTERN`; corpus evidence is uniformly
personal/meaningful, 3/42 rows, no mundane use found; would make the
existing unmodified extractor produce Semmelman's desired snapshot with
no other change). **Zman = DIFFERENT EXTRACTION CHANGE REQUIRED, not a
simple word addition** (39/42 corpus rows are generic broadcast
templates; Zachter's note is donor-relevant only because of surrounding
appreciation/impact language the pattern doesn't recognize at all today
-- a materially different, separately-scoped gap, not fixable by adding
"zman" itself). Desired (not generated, not written) snapshots for both
donors documented and clearly labeled as design targets. Re-confirmed
from current source that the `outcome/route.ts` ungated-write finding
from the prior audit is still accurate and unchanged -- not touched or
expanded in this task. **No D1 writes, no extraction-code change, no
deploy** -- strictly investigation/design only. Full report: "Zman /
Yahrtzeit Extraction-Vocabulary Investigation (2026-08-20)" above.
Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T21:20:00Z (approximate)
Claude (Sonnet 5) — Read-only, comprehensive audit of every live donor's
stored `relationship_summary`/`institutional_memory` on Independent
Staging, prompted by a live donor page (60830, Zachter) still showing
old-format "Latest discussion topics: .../People mentioned: .../
Recommended next action: ..." scaffolding, proving the earlier cleanup
work wasn't comprehensive. Audited all 12 donors with either field
non-null (of 248 total live donors; 9 with `relationship_summary`
non-null, 12 with `institutional_memory` non-null). Found exactly 2
`C_MIXED` donors -- Zachter (60830) and Semmelman (72957) -- both with a
pre-1487a8b malformed `relationship_summary` dump and a genuinely good
`institutional_memory`; 10 donors fully clearly-good; 0 clearly
malformed; 0 uncertain. Proved via source-tracing (byte-for-byte
reproduction under the old generator) that both malformed values came
from real single-donor `capture:text`/`capture:personal` interactions,
explicitly accepted by the user before the fix deployed, never edited
since. Proved via direct code inspection
(`relationshipOpportunityCandidate`/`solicitCandidate` in
`lib/relationships/recommendation-candidates.ts`) that both malformed
values are currently eligible to surface as Suggested Action anywhere
the shared recommendation engine runs (donor page, Today, Meeting Brief,
Assistant) -- confirming the screenshot's "Suggested Action repeats the
bad text" behavior is real and systemic to that donor, not cosmetic.
Also found a side architecture gap (not fixed): `app/api/interactions/
[id]/outcome/route.ts` writes both fields with no
`acceptRelationshipSnapshot` gate at all, explaining 3 other donors
whose `institutional_memory` is set while `relationship_summary` stayed
null (their content is fine, so not flagged, but the gap itself is
noted for a future task). Built a new, separate, read-only-only script
(`scripts/relationship-context-audit.mjs` -- does not modify or extend
the existing apply-capable `relationship-summary-cleanup-preview.mjs`)
plus `tests/relationship-context-audit.test.mjs` (deterministic
classification, malformed-pattern coverage, false-positive-safe on real
family-context examples, mixed records surfaced not auto-deleted,
Suggested-Action-impact matches the real fallback chain, and the script
itself proven to contain no write path). `pnpm test` (all suites, exit
0) and `pnpm exec tsc --noEmit` (clean) both pass. **No D1 writes, no
extraction-code change, no deploy** -- strictly read-only throughout.
Full report: "Comprehensive Historical Audit -- relationship_summary /
institutional_memory (2026-08-20)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T20:45:00Z (approximate)
Claude (Sonnet 5) — Applied the user-approved donor 987 historical
grandchild-gap repair to Independent Staging D1. Freshly re-read donor
987 and its source interaction immediately before writing -- unchanged
from the prior preview (both target fields still NULL, interaction still
unedited) -- so proceeded. Did not broaden `scripts/relationship-
summary-cleanup-preview.mjs` (it cannot represent a null-backfill case);
instead ran a single, hand-reviewed, compare-and-swap `UPDATE` directly
via `wrangler d1 execute --remote`, scoped to donor 987's exact id +
`owner_user_id` + `data_source='live'`, gated on `relationship_summary
IS NULL AND institutional_memory IS NULL` (naturally idempotent --
re-running it now would match zero rows). D1 confirmed `changes: 1`.
Post-write, verified directly from D1: `relationship_summary`/
`institutional_memory` exact byte matches to the approved values; source
interaction byte-for-byte unchanged; `relationship_summary`/
`institutional_memory` non-null counts each moved by exactly +1 (7->8,
10->11) with total donor/interaction/recommendation counts unchanged --
no other row touched, nothing unrelated created.
`relationship_health` deliberately left untouched (not part of the exact
approval). Verified the donor page (`/donors/bb929584-...`, Dr. & Mrs.
Mark Danziger) renders the repaired Relationship Snapshot correctly,
reading straight from D1 with no staleness. No source-interaction edit,
no other donor, no schema/production/`origin/main` change; no new
Worker deploy in this task (the already-deployed version
`e846f522-161e-48ea-a556-4b575db27be5` already serves this donor's data
from D1). The grandchild/grandparent extraction-gap work (investigation,
fix, deployment, and the one confirmed historical case) is now
**complete**. Full report: "Donor 987 Historical Grandchild-Gap Repair --
APPLIED (2026-08-20)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T20:10:00Z (approximate)
Claude (Sonnet 5) — Two-phase task: (A) deployed the already-committed
grandchild extraction fix (`a59c8d5`) to Independent Staging (Worker
`e846f522-161e-48ea-a556-4b575db27be5`) after re-passing `pnpm test`/
`tsc --noEmit`/`build:staging-independent`, then live-verified the UI on
the real deployed bundle: a grandson note and a granddaughter note both
now correctly offer the "Use this relationship snapshot" checkbox with a
sensible quoted-sentence preview, at parity with an equivalent son note;
an unrelated note still correctly shows no checkbox; zero console
errors. No donor was written to during verification -- no safe
disposable test donor exists, and the preview computation is entirely
client-side with no donorId dependency, so the check was done without
selecting a donor or ever clicking Save, guaranteeing no persistence by
construction. (B) Previewed -- did NOT apply -- donor 987's historical
repair: re-confirmed fresh from D1 that the donor and its source
interaction are unchanged from the original audit (`relationship_
summary`/`institutional_memory` still NULL, interaction never edited,
no audit rows). Found the existing `scripts/relationship-summary-
cleanup-preview.mjs` tool's candidate set is `relationship_summary IS
NOT NULL` -- it cannot see a currently-NULL donor like 987 at all, so it
structurally can't express this null-backfill repair; reported this gap
rather than writing a one-off UPDATE or bypassing the safety model.
Generated the proposed values directly from the real, unmodified
extraction functions: relationship_summary `"called to wish mazel tov
on grandson's bar mitzvah this shabbos."`, institutional_memory `"Call
context: called to wish mazel tov on grandson's bar mitzvah this
shabbos"`. Compared against donor 67909's real, already-live values for
the parallel son note (identical structure, differing only in
"grandson's"/"son's") and assessed the proposed content as useful and
consistent with the already-accepted production bar, not mechanical
junk -- recommended for approval, explicitly not applied. Donor 987
re-confirmed unmodified after generating the preview (`updated_at`
unchanged on both the donor row and the source interaction). `origin/
main` unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`); no D1
write of any kind occurred in this task. Full report: "Grandchild Fix
Deployment + Donor 987 Repair Preview (2026-08-20)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T19:00:00Z (approximate)
Claude (Sonnet 5) — Implemented the approved forward fix for the
grandchild/grandparent extraction gap confirmed in the prior
investigation-only task. Added six alternatives to `FACT_SIGNAL_PATTERN`
in `lib/capture/interaction.ts` (`grandsons?|granddaughters?|
grandchild(?:ren)?|grandparents?|grandmothers?|grandfathers?`) --
narrow, single-pattern change, no route/schema/gating-logic touched.
Added `tests/relationship-snapshot-family-terms.test.mjs` (wired into
`package.json`'s test chain): exercises the real extraction functions for
every requested singular/plural family term, proves son/daughter behavior
is unchanged, proves three "son"-substring false positives (Johnson,
reasons/person, season) still don't match, and structurally proves the
`acceptRelationshipSnapshot`-gated write is still required for both
`relationship_summary` and `institutional_memory`. Re-ran the fixed
extractor against donor 987's actual stored note (read-only, no write):
now produces a fact, where before it produced none; donor 987's row
itself was NOT backfilled, per explicit instruction. Read-only historical
audit of all Independent Staging interactions containing "grand": 15
total, exactly 1 (donor 987's own, already known) was affected by the old
gap; the other 14 are shared/broadcast text messages
(`app/api/interactions/shared/route.ts`, single-line summaries, no note
body) that never call the extraction functions at all, by prior
documented design -- not a materially broader problem, no scope
expansion. `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm run
build:staging-independent` all passed. No D1 write, no deploy,
`origin/main` unchanged (`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`).
Full report: "Grandchild/Grandparent Extraction-Gap Fix --
FACT_SIGNAL_PATTERN (2026-08-20)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T18:20:00Z (approximate)
Claude (Sonnet 5) — Investigation-only task: traced why a CALL logged for
donor 987 did not update Relationship Snapshot/Institutional Memory while
a near-identical CALL for donor 67909 did. Ruled out shared-activity/
recipient-role (both interactions have `shared_activity_id`/`role` NULL --
neither went through `app/api/interactions/shared/route.ts`), capture-
route divergence (both `source = 'capture:call'`, same single-donor
route), edit-after-create, write failure, and UI/D1 staleness (donor
page reads `donors.relationship_summary`/`institutional_memory` directly,
no cache/live derivation, and D1 already correctly shows NULL for 987).
Proven root cause via read-only D1 `SELECT`s plus running the real,
unmodified `actionableRelationshipSnapshot()`/`relationshipSnapshotDetails()`
functions against each donor's actual note text: donor 987's note
describes a call about a **grandson's** bar mitzvah, donor 67909's a
**son's** bar mitzvah. `FACT_SIGNAL_PATTERN` in `lib/capture/interaction.ts`
matches `\bson\b` but that word-boundary regex never fires inside
"grandson" (no boundary before "son" when preceded by "grand"), and
"grandson"/"granddaughter"/"grandchild" aren't recognized as their own
family-relevance terms anywhere in the pattern. `app/api/interactions/
route.ts` only writes `relationship_summary`/`institutional_memory` when
the client sends `acceptRelationshipSnapshot: true`, and the client
(`CaptureExperience.tsx`) only offers that checkbox when its local
extraction preview is non-null -- so donor 987's call was never even
offered for saving, on either field, despite genuine donor-relevant
content. Not isolated to donor 987: any note whose only family signal is
a grandchild-relationship word will hit the same gap. Smallest fix
identified (add grandchild terms to `FACT_SIGNAL_PATTERN`) but NOT
applied, per explicit instruction to report before touching extraction
heuristics. No D1 write, no code change, no deploy. Full report:
"Relationship Snapshot / Institutional Memory Divergence -- Donor 987 vs
67909 (2026-08-20)" above. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T17:45:00Z (approximate)
Claude (Sonnet 5) — Documentation/workflow-safety task: audited and fixed
the stale "active branch" conflict flagged during the payment-plan layout
task. The stale line actually lives in
`docs/FUNDRAISING_OS_PRINCIPLES.md` (not `CLAUDE.md` itself, which has no
branch statement -- CLAUDE.md just directs readers to treat that file as
governing). Proved with git evidence (`merge-base`, `--is-ancestor`,
`rev-list --count`), not inference: `feature/fundraising-os-redesign`
(tip `ade8594`, last commit 2026-08-05) is a strict ancestor of
`feature/independent-cloudflare-sandbox` (tip `0eb8602`) with zero unique
commits of its own, while sandbox is 106 commits ahead -- every recent
feature (Ask, birthday/payment-recency, Monthly Payment Plan, both 1102
investigations, the layout fix) happened only on sandbox. Also proved the
principles doc's own branch line was wrong from the moment it was
written, not merely stale: the commit that added it postdates sandbox's
fork point and isn't even an ancestor of the redesign branch it names.
Replaced the single stale bullet in `docs/FUNDRAISING_OS_PRINCIPLES.md`
with two: (1) correct current-branch guidance that tells the reader to
verify via git/AI-HANDOFF rather than trust any recorded name, and (2) a
general authority-order rule (verified git state + the user's explicit
instruction beat any recorded branch name; surface conflicts, don't
guess). `feature/fundraising-os-redesign` was only read, never
checked out, merged, deleted, or force-pushed -- described as historical/
superseded in the principles doc, disposition left undecided.
`origin/main` unchanged throughout
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). No application code, D1, or
deployment touched in this task. Full report: "Branch/Workflow
Documentation Audit and Correction (2026-08-20)" above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T17:15:00Z (approximate)
Claude (Sonnet 5) — Fixed the payment-plan editor overflowing its pledge
card (CSS/layout only, presentation bug, unrelated to the 1102 work
above). Root cause, confirmed by inspection: `.open-pledge-plan-list`'s
`auto-fill` grid gave a lone open pledge only a narrow ~240-300px track
even on a wide screen, and `.payment-plan-fields` inputs/textarea had no
width rule, so the fields grid's default `min-width: auto` floored its
own minimum width above the card's -- together forcing the form past the
card border. Fix: `.open-pledge-plan-row:has(.payment-plan-form) {
grid-column: 1 / -1; }` (span the row only while actively editing, zero
component/state changes, zero residual class after Cancel) plus
`min-width: 0` on the fields grid/labels and `width: 100%; max-width:
100%; box-sizing: border-box;` on every field. Only `app/globals.css`,
a new structural regression test
(`tests/pledge-payment-plan-layout.test.mjs`), and `package.json` (test
wiring) changed -- no touch to `PledgePaymentPlanManagement.tsx`, the
API routes, cadence/cycle logic, or D1. `pnpm test`/`tsc --noEmit`/build
all passed. Committed `1605f76`, pushed (fast-forward,
`9563efe..1605f76`), deployed as Worker `b5357707-2d49-47a3-a1af-d3849b26f9a3`
(only the CSS asset changed on upload). Live-verified on staging with
real donor records: single-pledge (Daniel Stein/DIN2025/$144) and
Edit-plan (the real KOLX2026/Zachter plan) both geometrically confirmed
fully contained with no page-level horizontal overflow; multiple-pledge
case confirmed the active editor spans the row with zero overlap against
the untouched neighbor card; Cancel confirmed to leave no residual
class/state. Mobile/narrow width honestly reported as unverified --
`resize_window` did not actually change `window.innerWidth` in this
environment. Flagged (not silently ignored) that `CLAUDE.md` names a
different "active branch" than the one this task and every prior session
actually use; proceeded on `feature/independent-cloudflare-sandbox` since
it matches the real deployed infrastructure. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`) throughout. Full report:
`## Payment-Plan Editor Layout Fix -- Overflowing Its Pledge Card
(Independent Staging, 2026-08-20)` above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T16:30:00Z (approximate)
Claude (Sonnet 5) — Post-upgrade verification of the Error 1102
infrastructure-limit incident, per explicit instruction: verification
only, no code/config/deploy/D1/CPU-limit change. The user purchased
Workers Paid following the prior audit. Confirmed on the dashboard (not
assumed): plan is now Paid ("Current plan" badge), the Worker's CPU-limit
override field is still empty (Paid platform default applies, nothing
configured), and `wrangler deployments list` shows the deployed version
unchanged (`1875be3f-...`, same version that produced the original
`exceededCpu` failure). Exercised 8 real navigations (5x `GET
/?priorities=all`, 3x donor pages) -- all succeeded, `outcome: "ok"`,
`cpuTimeMs` 221-354 (Ray-ID-correlated from each event record), zero new
errors of any kind. Per explicit instruction, did NOT attribute the
absence of failures to reduced computation: today's CPU costs were higher
than the incident's 68 ms kill and higher than several pre-upgrade
successes, proving the application's cost profile is unchanged -- only
the ceiling moved. Concluded the 1102 infrastructure-limit incident can be
closed; explicitly kept two separate, already-documented performance
items open (cold-start dedup gap, uninstrumented wall-time remainder) since
neither was investigated or fixed in this task. Full report: `##
Independent Staging Incident -- Error 1102 -- POST-UPGRADE VERIFICATION
(Workers Paid, 2026-08-20)` above. `origin/main` unchanged
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`) throughout. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T15:50:00Z (approximate)
Claude (Sonnet 5) — Infrastructure-limit audit of a new Independent Staging
Error 1102 (Ray `a2e2849e1fdc23dd`, 15:44:12 UTC), per explicit instruction:
investigation only, no application code change, no deploy, no D1 write, no
billing/plan change. Confirmed via the Cloudflare dashboard (not memory):
this account is on **Workers Free** (10 ms CPU/request, no configurable
`limits.cpu_ms` -- none set in `wrangler.staging.jsonc` either). The
incident itself: `outcome: "exceededCpu"`, `cpuTimeMs: 68`, `wallTimeMs:
201`, route `GET /?priorities=all` (same `loadWorkspaceBrief()` path as
prior incidents), `scriptVersion` `1875be3f-...` (today's post-rollout
version, includes the 2026-08-19 dedup fix), no burst/concurrency at the
same timestamp. Cross-referenced against this file's own already-recorded
data: ordinary successful requests on this exact route have repeatedly
cost 70-242 ms CPU (7-24x Free's published ceiling), and this incident's
68 ms kill is *lower* than several of those prior successes -- meaning the
account is chronically over Free's intended budget for this app, not
failing on rare outliers. Recommendation returned: **(A) Free-plan
ceiling is fundamentally too low for this SSR app; upgrade to Workers
Paid ($5/mo base + usage)** would remove this failure class outright
(default 30 s/up to 5 min CPU ceiling vs. this route's ~60-70 ms
internal-phase cost alone); code optimization (cold-start dedup gap,
uninstrumented wall-time remainder -- both already on record as open
items) is still recommended afterward as non-blocking follow-up, not a
substitute. No upgrade performed -- explicit approval required first, per
instruction to stop before any billing/plan/config change. Full report:
`## Independent Staging Incident -- Error 1102 (2026-08-20 15:44:12 UTC ...)
-- INFRASTRUCTURE-LIMIT AUDIT ONLY` above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T04:10:00Z (approximate)
Claude (Sonnet 5) — Revised the pledge payment-plan design (still not
implemented) per one required correction: the expected-vs-actual model
in `docs/PLEDGE-PAYMENT-PLAN-DESIGN.md` §8 previously derived the next
expected payment date as `latest actual payment + ~30 days`, which was
rejected for conflating the agreed schedule with actual payment behavior
(an early or late payment would permanently drag future expected dates
off their true anchor). Replaced with a calendar-month-anchored model: a
new required `expected_day_of_month` field (auto-derived, not a separate
form input) plus a small pure `advanceOneCalendarMonth` function (reusing
`isLeapYear`, already exported) that always clamps to the fixed anchor
day, not the previous cycle's own clamped day -- verified computationally
that Feb 28 correctly reverts to Mar 31, and that a September payment
landing on the 22nd still produces Oct 18 as the next cycle, never Oct
22. Also defined the exact cycle-satisfaction rule (symmetric ±7-day
grace window, bounded forward walk, payment amount never inspected) and
reversed the paid-off behavior -- `ended_at` is now never auto-set on
zero balance; only an explicit `[End plan]` sets it, since a fully-paid
pledge already can't produce a `follow_up_pledge` candidate on its own.
Reworked the KOLX2026 worked example with the corrected model across
Aug19/Sep17/Sep18/Sep25/Sep26/Sep22/October/final-date scenarios. Every
other previously-approved design decision (field set otherwise, `ended_at`
over a status enum, `giving_activities.id` linkage, monthly-only cadence,
fixed grace, terminology, phased order, non-goals) is confirmed unchanged.
No schema, migration, application code, or deploy -- design and
documentation only, committed and pushed to
`feature/independent-cloudflare-sandbox`. `origin/main` unchanged.
Remaining approval needed is narrowed to just the mechanics introduced by
this revision. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T03:20:00Z (approximate)
Claude (Sonnet 5) — Designed (not implemented) the smallest coherent
feature for marking an open pledge as being paid on a known payment plan,
so `follow_up_pledge` stops surfacing while a donor is paying as
expected. Full report: `docs/PLEDGE-PAYMENT-PLAN-DESIGN.md`. Audited the
actual architecture first (open-pledge representation in
`giving_activities`, `jl_payment_assignment_audits`'s real payment
ledger, `RecommendationEvidence.openPledge`, `followUpPledgeCandidate`,
donor merge, JL import upsert behavior, staging-reset/backup-export
classification, and the Ask/`ask_changes` feature as house-style
reference) before proposing any schema. Recommended: a new
`pledge_payment_plans` + `pledge_payment_plan_changes` table pair, linked
to `giving_activities.id` (proven stable across ordinary JL reimports via
the fingerprint-keyed upsert; one rare edge case -- a future correction
to the pledge's own original commitment terms -- flagged as deferred, not
solved); monthly-only cadence (no recurrence engine); a required
`final_expected_payment_at` as the sole backstop against indefinite
silent suppression; `ended_at` nullable timestamp instead of a status
enum; a fixed 7-day grace period; on-track/late/completed/plan-ended-
with-balance all derived at evidence-build time, never stored, reusing
the exact linked-payment query the prior payment-recency fix already
added; no new recommendation-candidate kind (one suppression branch plus
plan-aware wording added to the existing `followUpPledgeCandidate`); the
month-end calendar-arithmetic problem avoided entirely by approximating
monthly cadence as a 30-day day-count window re-anchored to the most
recent real payment, rather than building calendar-month arithmetic that
doesn't exist anywhere in this codebase today. Worked the real KOLX2026
pledge through five scenarios as a design fixture (read-only, not
modified). 10 explicit decisions flagged for approval before any
implementation begins. No schema, migration, application code, or deploy
-- design and documentation only, committed and pushed to
`feature/independent-cloudflare-sandbox`. `origin/main` unchanged. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-20T02:40:00Z (approximate)
Claude (Sonnet 5) — Fixed two bounded, unrelated correctness bugs. (1)
Today's Agenda never showed a same-day birthday/yahrtzeit/anniversary --
only Coming Up did; root cause was a classification gap (the combined
relationship-date-event list was never split by "is this today"), not a
date-calculation bug. Added `partitionRelationshipDateEventsByToday()` +
`localDateOnlyEpoch()` and a new `todayRelationshipDates` field; live-
verified with the real reported case (Dr. & Mrs. Yaakov Abdelhak, Aug 19
birthday) now correctly appearing in Today's Agenda and no longer
duplicated in Coming Up. (2) Open-pledge Suggested Action cited a
pledge's original commitment date as "last activity" even after a real
payment was applied, because `giving_activities.activity_date` never
moves when a payment is applied in place -- the true payment date lives
only in `jl_payment_assignment_audits.payment_date`. Added
`resolveOpenPledgeActivityDate()` and wired it into all three surfaces
sharing this evidence (Today, donor page, Meeting Brief/Assistant); the
existing age-based urgency/confidence scoring needed no changes at all
once given the correct age -- no new suppression policy was invented.
Live-verified with the real reported case (KOLX2026 pledge, donor Yaakov
Zachter): the exact bad sentence ("No payment activity in 62 days") is
gone everywhere, balance/recency now agree across every surface, and no
giving data was modified by verification (confirmed via a direct D1 read
before and after). 21 new regression tests across two new files. `pnpm
test`, `tsc --noEmit`, and `build:staging-independent` all pass. Deployed
commit `93bdfb3`, Worker version `5f738898-adee-4e43-8fc9-2f170e377c07`.
`origin/main` unchanged throughout
(`4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`). Documented (audit only, not
implemented) what the future monthly-payment-plan feature would need --
see the fix section above. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-19T22:05:00Z (approximate)
Claude (Sonnet 5) — Closed out the Error 1102 duplicate-`loadWorkspaceBrief()`
investigation. Root cause proven: vinext's pre-render "probe" pass (see
`docs/AI-HANDOFF.md`'s instrumentation section) calls the page component
directly, outside React's render dispatcher, so `React.cache()` can't
dedupe it against the real render. First fix attempt used
`AsyncLocalStorage.enterWith()`, deployed as Worker `70f3c2c6`, and broke
the Today page live within minutes (cpuTimeMs collapsed to ~18ms, zero
`workspace_brief_*` logs, "Something interrupted the workspace" on
screen) — Cloudflare Workers' `AsyncLocalStorage` does not implement
`enterWith()`/`disable()`, confirmed on Cloudflare's own docs. Rolled
back to `f29c075f` immediately. Corrected fix moves the `run()` call to
`worker/index.ts` (the file that already wraps vinext's whole
`handler.fetch()`), verified against real `workerd` via a standalone
`wrangler dev` test before redeploying. Committed `eec5266`, deployed as
Worker `db4dcc3e-1629-4457-81e6-ae53ffeb5894`. Live-verified with 5 real
Today navigations, Ray-ID-correlated against instrumentation: 4/5 showed
the intended single-execution dedup (cpuTimeMs 70-94ms, down from a
141-242ms baseline — a real, material reduction); the 5th (a cold start)
still executed the loader twice (cpuTimeMs 223ms, not worse than
baseline, not improved). No 1102/5xx/blank screen on any of the 5, and
candidate counts/output were unchanged (the one difference,
`openAskDonorCount` 0→2, is real new data from a concurrent session's Ask
backfill, not staleness). Root cause of the cold-start non-dedup case is
NOT investigated further, per instruction to stop and report rather than
start another architectural fix. Full detail, before/after tables, and
what remains unproven: see "Independent Staging Duplicate-Loader Fix —
CURRENT STATUS" above.

---

2026-08-19T19:00:00Z (approximate)
Claude (Sonnet 5) — Ask/Solicitation feature CLOSED FOR V1: backfilled the
3 already-reviewed historical solicitation cases (Klein/Pfeiffer/Rovinsky)
into real `asks` rows via a new narrow, allowlist-only, idempotent script
(`scripts/ask-historical-backfill.mjs`), then cleared their broken
machine-generated `relationship_summary` values (compare-and-swap,
NULL-out) only after each Ask was freshly re-verified. All 3 donor/
interaction records were independently re-confirmed against live staging
before any write, exactly matching the reviewed case. Dry run found
exactly 3 eligible; apply created exactly 3 asks + 3 audit rows (one bug
found and fixed live -- multi-line generated SQL broke Windows shell
argument parsing, same class of issue documented in the sibling cleanup
script; fixed by flattening whitespace before sending); cleanup cleared
exactly 3 relationship_summary values, leaving the 2 unrelated
NEEDS_REVIEW donors (Semmelman/Zachter, not solicitation cases)
untouched. Live-verified on the deployed app (Klein): Open Ask card,
Suggested Action ("Follow up on the $5,000 Plaque ask."), and Meeting
Brief all correct; old broken Relationship Snapshot text replaced by an
honest empty state; `open_ask` wins over the old fuzzy `solicitCandidate`
even though it now falls back to `institutional_memory` text, exactly as
designed. No application code was touched (script/tests/docs only), so no
deploy was needed or performed. `giving_activities`/`gifts`,
`institutional_memory`, and all 3 source interactions confirmed unchanged
throughout. 14 new focused tests added
(`tests/ask-historical-backfill.test.mjs`), `pnpm test` and `pnpm exec tsc
--noEmit` both clean. This closes the last open item for Ask v1 — see
"Ask / Solicitation Feature -- HISTORICAL BACKFILL AND CLOSURE" above for
full detail. Session `0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-19T17:43:00Z (approximate)
Claude (Sonnet 5) — Today/Assistant loader (`loadWorkspaceBrief()`)
phase-timing instrumentation, anchored against the Error 1102 investigation
above (Ray `a2dab4de9e40be78`). Instrumentation only — no recommendation
behavior, candidate-selection rules, or D1 data changed. Added three
compact structured log events (`workspace_brief_phase` x2,
`workspace_brief_render`), a new test
(`tests/workspace-brief-instrumentation.test.mjs`), and a trivial
backward-compatible `context` parameter. `pnpm test`/`tsc --noEmit`/
`build:staging-independent` all passed. Committed `83bfa75`, pushed to
`origin/feature/independent-cloudflare-sandbox` (`origin/main` untouched),
deployed as Worker version `f29c075f-b1e3-496d-bc10-cc52ecf05554`, then
live-verified with 3 ordinary Today-page loads (no 1102 encountered). Two
evidence-backed findings: `loadWorkspaceBrief()` runs twice per single
navigation (same request, same rayId — a pre-existing pattern, also seen
in `donor_page_render`, not introduced here); and scoring/assembly are
consistently ~0ms while D1 fan-out is ~100% of the function's own measured
cost — weakening the "unbounded scoring loop" hypothesis and pointing
instead at the double-invocation and fan-out cost as the more
evidence-backed levers. A meaningful share of each request's total
cpuTimeMs/wallTimeMs (roughly half or more) still falls outside this
function's instrumented phases and remains unattributed. No optimization
implemented, per explicit instruction — see "Independent Staging
Instrumentation" above for full detail, including the smallest
evidence-supported next steps identified (not yet approved). Next
approval required: none to investigate further; any fix/optimization
needs its own separate approval.

---

2026-08-19T18:00:00Z (approximate)
Claude (Sonnet 5) — Ask/Solicitation feature Phase 1 controlled rollout to
Independent Staging: applied migration `0032_asks.sql`, deployed current
branch HEAD (`86584e9`, Worker version `e2fb2e0c`), then live-tested every
major path against real staging donors — direct Ask creation,
ask-from-interaction creation, all three status transitions (committed/
declined/withdrawn, including the required-reason rejection path),
Suggested Action timing/ranking, and Today/Meeting Brief/Assistant wiring —
verifying each at the D1 layer, not just the UI. Confirmed no giving/JL
data was ever touched by any Ask action and no shared/multi-donor ask was
created. Found one genuine, previously-undiscovered completeness gap (not
fixed, per instruction not to redesign the feature in this task): the
Meeting Brief page never renders a dedicated line for a donor's open
ask(s), only surfacing one indirectly if it wins the Suggested Action
slot. Mobile/narrow-viewport visual verification could not be completed
in this automation environment (`resize_window` did not change the real
viewport) — reported honestly rather than claimed. Test data (3 asks, 1
interaction) resolved through normal application paths only — asks left
in terminal statuses, the interaction archived — nothing hard-deleted, no
ad-hoc SQL used. Full safety checklist confirmed clean: production/`main`/
backup/R2/status infra all untouched, only migration 0032 applied, no
historical backfill (Klein/Pfeiffer/Rovinsky untouched). This handoff
updated to replace stale "local-only/not pushed/not deployed" bookkeeping
text throughout with the actual live state. Session
`0d7eb3ea-61e9-462e-a65d-71eddd13f964`.

---

2026-08-19T00:00:00Z (approximate)
Claude (Sonnet 5) — Ask/Solicitation feature Phase 1 IMPLEMENTED, local
only. Built the approved design end to end: `asks`/`ask_changes` tables
+ migration (`drizzle/0032_asks.sql`), a new confirmed-certainty
`open_ask` Suggested Action candidate wired into the existing shared
recommendation engine (reusing `follow_up_pledge`'s exact urgency/
confidence precedent, with one reasoned, numerically-verified departure
so a fresh ask still outranks the existing fuzzy `solicitCandidate`),
Meeting Brief/Assistant/Today integration (no new dashboard section, no
new search infrastructure), progressive-disclosure "Did you make an
ask?" in single-donor interaction capture only (verified the
shared/multi-donor route has zero ask-related code), a direct "+ Log
ask" entry point, a donor-profile Open Ask card with de-emphasized
"Stop pursuing," `PATCH`/`POST` API routes built on a pure, unit-tested
`planAskUpdate()`, and donor-merge reassignment. Infrastructure: baseline
regenerated via the existing generator (not hand-edited), staging-reset
order updated, and a previously-undiscovered secondary JSON-export
table-classification requirement (`lib/operations/workspace-backup.ts`)
found and closed. `tests/asks.test.mjs` (25-item coverage, mixing real
behavioral tests -- including a real in-memory SQLite database built from
every committed migration for schema/merge/multi-ask verification --
with source-string checks only where this repo has no D1/route test
harness) added to `pnpm test`'s existing chain; a handful of existing
tests updated for legitimate, intentional changes (query-count invariant,
a new migration's own test, one now-non-terminal field assertion, one
test fixture). `pnpm test`, `pnpm exec tsc --noEmit`, and `pnpm run
build:staging-independent` all pass. **No D1 writes, no migration
applied, nothing deployed, nothing pushed** -- committed locally only
(`a04b4bd` + this handoff commit), per explicit instruction to stop after
a local commit. Full 27-item report, exact files changed, and 5 next-
approval items are all above.

---

2026-08-19T00:00:00Z (approximate)
Claude (Sonnet 5) — Ask/Solicitation feature DESIGN ONLY (no
implementation): audited existing architecture end to end (interactions,
recommendations, giving_activities, the shared Suggested Action engine,
Meeting Brief, Assistant, Today/suggestion-candidates, imports, donor
merge, staging-reset/backup/baseline infra) by reading the actual code,
not assuming. Confirmed no existing table can represent an Ask (
giving_activities is exclusively JL-imported financial-system-of-record
data) and that an existing `solicitCandidate` already does fuzzy,
never-"confirmed" regex-matching against free text -- exactly the gap a
new structured Ask closes. Wrote a full 26-item design report to
`docs/ASK-SOLICITATION-DESIGN.md`: minimum schema (`asks` + a small
`ask_changes` audit table), a 4-status model (`pending/committed/
declined/withdrawn` -- "closed" renamed for clarity), ask-vs-commitment-
vs-gift semantics (never auto-creates/links a real JL pledge), reuse of
the existing reminder system (no new follow-up-date field), Suggested
Action/Meeting Brief/Today wiring recommendations grounded in the actual
files that would need to change, an explicit statement of what the
Assistant cannot do without new search infrastructure, donor-merge/
backup/reset infra impact (including a discovered, out-of-scope,
pre-existing merge gap for yahrtzeits/important_dates/etc.), exactly how
the Klein/Pfeiffer/Rovinsky cases would be represented, and a phased
implementation order. Committed as documentation only -- no schema,
migration, or application code was written; no D1 writes were made.
8 explicit decisions are flagged as needing approval before any
implementation begins.

---

2026-08-19T00:00:00Z (approximate)
Claude (Sonnet 5) — Relationship-summary cleanup Phase 2: applied the 4
explicitly-approved SAFE_TO_REGENERATE rows to `fundraising-os-staging-db`
and investigated the 5 NEEDS_REVIEW rows (read-only, not modified). Before
writing, re-verified the 4 rows against a fresh classification (identical
to the original preview — no drift). Extended
`scripts/relationship-summary-cleanup-preview.mjs` with a `--apply
<id1,id2,...>` mode: explicit donor-ID allowlist only, re-classifies fresh
immediately before each write, fails closed if a donor no longer
classifies SAFE_TO_REGENERATE or its stored value changed since the read
(conditional UPDATE, compare-and-swap), writes only relationship_summary,
proposed value always computed server-side from the current extractor —
never a caller-supplied string. Found and fixed two real bugs live during
development: (1) the pre-fix values contain literal newlines, which broke
`wrangler d1 execute --command`'s Windows shell-argument parsing (caught
before any write happened, no data affected); (2) `wrangler d1 execute
--file`'s JSON response `meta.changes` is NOT a trustworthy per-row count
(confirmed live against a no-op query) — switched to hex-blob-encoded
values (`CAST(X'...' AS TEXT)`) under `--command` mode instead, which
does report reliable counts. All 4 applied successfully; post-write
verification confirmed relationship_summary matches the extractor exactly,
institutional_memory and source interactions unchanged, exactly 4 rows
changed table-wide, and a fresh preview run is idempotent (reclassifies
all 4 as ALREADY_GOOD, proposes nothing). Investigated all 5 NEEDS_REVIEW
donors read-only: the 3 "Solicited" cases (Klein/Pfeiffer/Rovinsky) each
have a real solicitation-amount fact in their source note that the
current extractor can't recover (would discard it if auto-regenerated);
Semmelman's Yahrtzeit fact is already tracked in the dedicated
`yahrtzeits` table; Zachter's "Zman" mention is temporary interaction
context. Wrote a narrow, category-specific extractor-expansion
recommendation (not implemented) distinguishing durable facts already
tracked elsewhere (Yahrtzeit — don't duplicate), temporary context (Zman —
handle manually), and giving-adjacent information with no other home
(dollar amounts — the one category worth a real product decision). Added
`tests/relationship-summary-apply.test.mjs` (12-item apply-mode safety
coverage, offline). `pnpm test` and `pnpm exec tsc --noEmit` both clean.
Committed and pushed as `7874d6b`. `origin/main` untouched. No Worker
deploy — no application code was touched, this was a data-only operation.
See "Relationship-Summary Cleanup Audit" above for full detail, and Next
Approval Required for what's still open on the 5 remaining rows.

---

2026-08-19T00:00:00Z (approximate)
Claude (Sonnet 5) — Relationship-summary cleanup AUDIT/PREVIEW/CLASSIFY
pass completed (read-only against `fundraising-os-staging-db`). Built
`scripts/relationship-summary-cleanup-preview.mjs`, reusing the real
production extractor (never reimplemented) to propose regenerated values
and a small frozen legacy-generator block used only to trace old-format
values back to their source note. 9 donors have a non-null
relationship_summary: 4 SAFE_TO_REGENERATE (proposed value shown), 5
NEEDS_REVIEW (left untouched, reasons documented above), 0 SAFE_TO_CLEAR,
0 MANUAL_UNCERTAIN, 0 ALREADY_GOOD. `institutional_memory` audited
separately and confirmed to need no cleanup. Added
`tests/relationship-summary-cleanup-preview.test.mjs` (12-item coverage,
offline against synthetic fixtures) and a `pnpm run
cleanup:relationship-summary-preview` script alias. `pnpm test` and
`pnpm exec tsc --noEmit` both clean. Committed and pushed as `fe35859`.
**No D1 writes were performed at any point in this task** — applying the
4 regenerations (and deciding what, if anything, to do about the 5
needs-review rows) is a separate, explicitly-approved next step; see Next
Approval Required above.

---

2026-08-19T04:35:00Z
Claude (Sonnet 5) — Relationship-intelligence quality pass shipped: fixed
the "Messaged" (and other channel/CRM verbs) misclassified as a person
bug at its root, replaced the generic category-label "topics" field with
real quoted `specificFacts`, made the Relationship Snapshot/capture
preview/Suggested Action all honestly show nothing when extraction found
nothing meaningful instead of boilerplate or a field-label dump, removed
the internal "Confidence:"/raw-field-name leaks from donor-facing UI.
Deployed (commit `1487a8b`, Worker version
`f5c3430d-1b04-4dd8-9f72-8a0fcd835e6a`, confirmed via `wrangler
deployments list` after a transient network/DNS outage delayed the
deploy), live-verified against real staging data (a generic Text Message,
a real fact, and a concrete next action) including direct D1 checks, test
data cleaned up via normal app routes (archiving automatically reverted
the donor's relationship_summary/institutional_memory via existing
`contextStatement` logic — no manual SQL needed), this handoff updated to
reflect live state. Session `session_01DoQiMShaMrVYHvopkVj581`.
