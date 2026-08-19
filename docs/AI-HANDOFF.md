# AI Project Handoff

This file is an index/summary for another AI session (Claude or ChatGPT)
picking up this project. Git history, source code, tests, migrations, and
the actual deployed/D1 state remain the source of truth — this file only
tells you where to look and what has and hasn't happened. If this file and
the repository/infrastructure disagree, trust the repository/infrastructure.

## Current Git State

Branch:
feature/independent-cloudflare-sandbox

Current HEAD (this commit):
Documentation-only update to this file, on top of `83bfa75`. Reports the just-completed Today/Assistant loader instrumentation task (code + deploy already done and verified before this doc update -- see "Independent Staging Instrumentation" section below).

origin/feature/independent-cloudflare-sandbox:
`83bfa75` (`0387d4b`'s Ask-rollout handoff + this session's instrumentation commit `83bfa75`, adding phase-timing telemetry to `loadWorkspaceBrief()`; both pushed). Deployed to Independent Staging as Worker version `f29c075f-b1e3-496d-bc10-cc52ecf05554`. See "Independent Staging Instrumentation -- Today/Assistant Loader Phase Timing" below for the full report, including 3 live-verified telemetry samples and two evidence-backed findings (the loader runs twice per navigation; scoring/assembly are ~0ms, D1 fan-out dominates the function's own cost).

origin/main:
4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58 (untouched)

Working tree:
clean.

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

## Ask / Solicitation Feature -- Phase 1 IMPLEMENTED, APPLIED, DEPLOYED, AND LIVE-VERIFIED

**STATUS: fully rolled out to Independent Staging and live-tested end to
end.** Migration `0032_asks.sql` is applied to `fundraising-os-staging-db`;
`a04b4bd`/`86584e9` are deployed as Worker version `e2fb2e0c`
(2026-08-19T17:04:39Z); direct Ask creation, ask-from-interaction creation,
all three status transitions (committed/declined/withdrawn), Suggested
Action timing/ranking, and Today/Meeting Brief/Assistant wiring have all
been exercised against real staging data and verified at the D1 layer, not
just the UI. Full results: "Ask / Solicitation Feature -- LIVE ROLLOUT
VERIFICATION" below. Test data created during verification was terminalized
or archived through normal application paths, not hard-deleted.

Design doc (approved, unchanged): `docs/ASK-SOLICITATION-DESIGN.md`.
This section reports the Phase 1 **implementation** built on top of that
approved design (§1-21 below describe the code as built and reviewed;
they predate the rollout and are unchanged by it). Everything below exists
as commits on `feature/independent-cloudflare-sandbox`, pushed to origin:
`a04b4bd` (implementation), `86584e9` (handoff update), `f1321c3`
(unrelated incident investigation), plus this rollout/live-verification
handoff commit.

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

### Unresolved decisions from the design phase -- now resolved by this
implementation (recorded here for continuity)

All 8 items from the design doc's "Unresolved decisions" section were
implemented exactly as recommended (status model incl. `withdrawn`
requiring a note; free-text purpose; multiple concurrent pending asks
allowed; direct creation included; only-originating-interaction linking,
Option A/D; the `ask_changes` audit table built). Items 7-8 (backfilling
Klein/Pfeiffer/Rovinsky, and clearing their `relationship_summary`) were
explicitly **not** done in this task, per instruction -- still open, see
"Next Approval Required" below.

## Latest Completed Task

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

## Relationship-Summary Cleanup Audit (Phase 1 applied; 5 donors still pending review)

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

No migration beyond 0032 exists or has been applied.

## Deployment State

**Live.** Deployed commit `83bfa75` (Today/Assistant loader phase-timing
instrumentation, on top of Ask/Solicitation Phase 1's `86584e9`), Worker
version `f29c075f-b1e3-496d-bc10-cc52ecf05554`, confirmed via the deploy
command's own printed Version ID and via live-verified telemetry
(`workspace_brief_render`/`workspace_brief_phase` log events observed for
3 real Today-page loads immediately after deploy). Note: branch HEAD may
advance past `83bfa75` by documentation-only commits (like this one) that
touch no application code — the deployed Worker reflects the latest
actual code change, `83bfa75`.

Worker: `fundraising-os-staging`
URL: `https://fundraising-os-staging.sgoldstein.workers.dev`
D1: `fundraising-os-staging-db` (bound as `env.DB`)

Multi-donor shared activities (Phase 1 + Phase 2), Text Message, the
mobile UX fixes, the relationship-intelligence quality pass, and now the
Ask/Solicitation Phase 1 feature are all live and have been exercised
end-to-end against real staging data (see Verification, and the Ask
rollout section above).

Note: this deploy required two retries — the environment's network/DNS
had a transient outage (wrangler/curl/nslookup all failed to resolve
`dash.cloudflare.com`/`api.cloudflare.com` for several minutes); the
deploy succeeded once connectivity returned, verified independently via
`wrangler deployments list` in the same session before live-testing.

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
- Existing (pre-fix) `relationship_summary`/`institutional_memory` rows
  written before this quality pass: 4 of 9 non-null rows were cleaned up
  (regenerated with the current extractor, applied and verified -- see
  "Relationship-Summary Cleanup Audit" above). 5 remain, all investigated
  and left untouched pending a human decision: 3 ("Solicited" false-person
  cases -- Klein/Pfeiffer/Rovinsky) have a real underlying solicitation-
  amount fact the current extractor can't recover on its own; 2
  (Semmelman/Zachter) hinge on a Yahrtzeit/Zman keyword gap the extractor
  doesn't recognize. See Next Approval Required for what's needed to close
  these out.
- The current extractor's `FACT_SIGNAL_PATTERN` has no keyword coverage
  for Yahrtzeit, Zman/yeshiva-timing language, or explicit dollar amounts
  ("$5k", "$10,000"). Investigated in depth (see "Relationship-Summary
  Cleanup Audit" -> "Part C"); recommendation is narrow and category-
  specific, not implemented: Yahrtzeit facts are already durably tracked
  in the dedicated `yahrtzeits` table (don't duplicate into
  relationship_summary); Zman/timing mentions are temporary interaction
  context better handled case-by-case than with a standing keyword;
  solicitation dollar amounts are the one category that currently has
  nowhere else to live in the schema and deserves an explicit product
  decision (either narrow fact-signal support, or a small dedicated
  ask/solicitation field/table).
- Place/holiday names (e.g. "Israel", "Rosh Hashanah") can still appear
  in the `people` array — genuinely ambiguous with real given names in
  this donor community (e.g. "Israel" is also a real first name), so no
  attempt was made to filter them; a full named-entity/place gazetteer
  was judged out of scope for a deterministic-rules-only fix. Confirmed
  low-impact: Meeting Brief's "PEOPLE MENTIONED" card is the only reader
  of this field, and this class of imprecision existed before this task
  too (it doesn't affect the main Relationship Snapshot text, which is
  driven by `specificFacts`, not `people`).
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

**The Ask/Solicitation feature Phase 1 implementation is now fully rolled
out and live-verified on Independent Staging** (migration applied,
deployed, and end-to-end tested — see "LIVE ROLLOUT VERIFICATION" above).
What remains open:
1. **Meeting Brief completeness gap**, discovered during live rollout
   verification (not a regression — a pre-existing gap): the Meeting Brief
   page never renders `brief.openAsks` as its own line; a pending ask only
   becomes visible there if it happens to win the single Suggested Action
   slot. A donor whose ask isn't top-ranked shows no ask information on
   their Meeting Brief. Needs a decision on whether/how to add a dedicated
   "Open ask" line to `app/donors/[id]/meeting-brief/page.tsx` (the
   `askLine()` formatter and `brief.openAsks` data already exist and are
   correct — this is a rendering gap, not a data or logic gap).
2. A **secondary product decision**, surfaced during implementation (§27
   item 4 above): whether to add an "Add follow-up" action to an
   *already-created* pending ask on the donor page (not built in Phase 1
   — reminders currently only attach at ask-creation time).
3. **Genuine mobile/narrow-viewport visual QA** — still not achievable in
   this browser-automation environment (see the rollout section above);
   recommend a real device or different tooling before treating any Ask
   UI mobile-layout claim as pixel-verified.
4. **Historical backfill** (Klein/Pfeiffer/Rovinsky) — explicitly out of
   scope for this rollout task, remains untouched; see the
   relationship-summary items below for that decision.

Everything from the design doc's 8 unresolved decisions was implemented
as recommended and is no longer open (see the design-resolution note
above) -- **except** items 7-8, which remain deliberately untouched:

The 4 approved SAFE_TO_REGENERATE rows are done (applied and verified —
see "Relationship-Summary Cleanup Audit" above). Nothing is blocking; the
following need a human decision before any further write happens to the
5 remaining rows (note: items 1-3 below would be resolved differently,
and arguably better, once the Ask feature exists — see the design doc's
§20 migration/backfill strategy):
1. **Klein / Pfeiffer / Rovinsky** ("Solicited" false-person cases): the
   underlying note has a real solicitation-amount fact
   ("Solicited for a plaque ($5k)." / "Solicited for $10k." / "Solicited
   for a plaque in memory of his wife ($5k)."). Decide whether to
   manually set relationship_summary to that fact for each (recommended —
   see the audit section for exact suggested text), leave as-is, or
   handle differently. Not automated — the current extractor would return
   null for all three if regenerated as-is, which would silently discard
   the ask amount.
2. **Semmelman**: recommend clearing relationship_summary to null (the
   durable fact — wife's Yahrtzeit — is already tracked in the dedicated
   `yahrtzeits` table; this row would just duplicate it). Needs explicit
   confirmation before any write.
3. **Zachter**: more borderline; recommend a human read and a short manual
   value (e.g. "Thanked for supporting the yeshiva's Zman.") or leave
   as-is — lower priority than the other 4.
4. **Extractor expansion** (Part C above): a real product decision on
   whether to add dollar-amount fact-signal support (the one category of
   the three investigated that has no other home in the schema) — not
   implemented, needs its own explicit approval and design if wanted.

Everything else is non-blocking — the shared-activity, Text Message,
mobile UX fixes, and relationship-intelligence quality pass are all live
and verified on Independent Staging.

Optional follow-ups, each would need its own explicit approval before
work begins:
- A genuine device/alternate-tooling mobile visual QA pass to close the
  viewport-emulation gap above.
- A product decision on the `continue_conversation`/`reconnect_contact_gap`
  ranking nuance and/or continue_conversation's eligibility on broadcast
  recipient touches, if judged worth addressing.
- Pre-filling shared-activity context into the new "Add note for this
  donor" capture form, if fundraisers want it.

## Last Updated

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
