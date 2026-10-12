# Production Operational Transition — Verification Report

**Date:** 2026-10-12
**Status:** Staging write-protection **DEPLOYED AND LIVE**. Production designation **CONFIRMED**. Daily email and automated backups **PREPARED, EXPLICITLY BLOCKED on owner actions outside this session's authorization** (not silently skipped — see Sections 4 and 6). Claude's morning check **IDENTIFIED, CANNOT BE MODIFIED FROM THIS REPOSITORY** (Section 5).

---

## 1. Current-state review (before any change)

- `docs/AI-HANDOFF.md`, `docs/PRODUCTION-DONOR-DATA-CUTOVER-EXECUTION.md`, and the migration runbook confirmed the migration's own result (254 donors, 5,463 giving activities, both duplicate records preserved) — not re-verified from scratch here, but spot-checked (Section 2).
- `worker/index.ts` is the single Worker entry point for both deployments: `fetch()` delegates every request to `vinext`'s `handler.fetch`, with one existing special case (`/_vinext/image`); `scheduled()` runs `runScheduledAgendaSend` and `runScheduledBackupAlertCheck` on the Worker's own Cron Trigger.
- `wrangler.staging.jsonc`: Daily Fundraising Agenda email cron **APPROVED and ACTIVE since 2026-08-26** (`"triggers": { "crons": ["0 * * * *"] }`, with `lib/agenda/send-agenda.ts`'s `isDailyAgendaSendHour()` guard actually sending once per day at 9am America/New_York). `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID` is set (a real Client ID), meaning the owner completed the `docs/AI-HANDOFF.md` "Morning Brief API" entry's remaining step 2 (enabling service-token auth) at some point after 2026-10-08.
- `wrangler.production.jsonc`: the cron was **deliberately not included**, by its own header comment, pending a separate "activate Production for daily use" decision. No `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID` was present.
- **Did not assume automation = running.** Checked live: the Production Worker had in fact already been deployed twice (2026-10-11T13:57Z, 14:54Z — by the owner, not this session, which never ran a Worker deploy before today). Checked live: Production had **zero secrets configured** (`wrangler secret list --config wrangler.production.jsonc` → `[]`), while Staging has all three `GMAIL_OAUTH_*` secrets. Checked live via the GitHub Actions REST API (public, unauthenticated read access — `gh` CLI is not installed in this session): both `.github/workflows/d1-backup-nightly-production.yml` and `.github/workflows/d1-restore-verify-monthly-production.yml` carry **no `schedule:` trigger at all**, `workflow_dispatch` only, by explicit, documented design ("DELIBERATELY NOT ON A SCHEDULE... until the Production database has real data worth protecting AND the Production-scoped secrets exist AND launch readiness has been separately confirmed"). This is the single most important finding of this round — see Section 6.
- CronList (this session's own scheduling tool) returned no jobs; CronCreate jobs are session-only and never persist, so "Claude's morning check" is not implemented through this session's own tooling — it is an external automation, consistent with `docs/AI-HANDOFF.md`'s own "Remaining work (the user's own steps, outside this repo)" note under the Morning Brief API entry. See Section 5.

## 2. Production designation — CONFIRMED

| Check | Result |
|---|---|
| Production D1 | `fundraising-os-production-db`, UUID `a51c6571-ae16-4614-aa9a-08f8e6be3ecd` — confirmed in `wrangler.production.jsonc`'s own `d1_databases` binding and via a live `wrangler d1 execute` query |
| Staging D1 | `fundraising-os-staging-db`, UUID `6c18396c-0a8f-4f2c-ba83-ea809ec10289` — confirmed the same way |
| Deployed Production Worker reads/writes exclusively Production's DB | Confirmed — `wrangler deploy --config wrangler.production.jsonc --dry-run` shows exactly one D1 binding, `env.DB (fundraising-os-production-db)`; the application code's only D1 access is through that one `env.DB` binding, never a hardcoded database name or ID |
| New donor records/giving/interactions/pledges/payments/imports save to Production | By construction — every API route writes only through `env.DB`, which is deployment-scoped; no route or background job references a specific database by name |
| Existing Production data/account settings intact | Confirmed post-deploy: 254 donors, 5,463 giving activities, owner `users` row (`sgoldstein@nirc.edu`) unchanged |
| Staging/Production not re-copied, neither reset | Confirmed — this round's only D1 operations were read-only `SELECT`s; zero `INSERT`/`UPDATE`/`DELETE`/export/import against either database |

## 3. Staging read-only protection — IMPLEMENTED, TESTED, DEPLOYED

**Mechanism:** `lib/operations/staging-write-guard.ts` (new) — a single, pure `shouldBlockStagingWrite(deploymentEnvironment, method, pathname, stagingWritesEnabled)` function, wired into `worker/index.ts`'s `fetch()` as the very first check, before routing, before the existing image-optimization special case, before `handler.fetch` is ever called. Blocks every `POST`/`PUT`/`PATCH`/`DELETE` request under `/api/**` when `deploymentEnvironment === "staging-independent"`, unless `STAGING_WRITES_ENABLED === "true"` is explicitly set. Returns a `403` with a clear JSON error message.

**Why a blanket block, not a per-route list:** this repo has 50+ API route files (`asks`, `donors`, `giving`, `import` (JL/Monday/DOB/yahrtzeit/rebbeim), `pledge-balance-corrections`, `pledge-payment-plans`, `interactions`, `research`, `staging-reset`, etc.) that create/edit/delete/merge/import donor or fundraising data. A curated allow/deny list would have to be maintained by hand for every future route; a blanket method-based block under `/api/**` cannot be bypassed by a route this guard doesn't know about yet. Verified exhaustively: a new regression test (`tests/staging-write-guard.test.mjs`) walks the entire `app/` tree and asserts every file exporting a `POST`/`PUT`/`PATCH`/`DELETE` handler lives under `app/api/` — the exact invariant the blanket `pathname.startsWith("/api/")` check depends on. It passes today (50 files, all under `app/api/`) and will fail loudly if that invariant is ever broken by a future change.

**What this intentionally does NOT block:** `lib/backup-alert/run.ts`'s `backup_alert_state` upsert (operational monitoring state, not donor/fundraising data — runs via the scheduled handler, never through `/api/**`) keeps working identically on both environments.

**Side effect, intentional:** the existing `/api/operations/staging-reset` route (already Staging-only, already owner-email-gated) is now *also* blocked by default, since a reset is itself a mutation. This is correct, not a regression — resetting Staging's data is exactly the kind of accidental-write risk this round exists to prevent; the same `STAGING_WRITES_ENABLED` override covers the rare case a real reset is needed.

**Escape hatch, "with an explicit configuration change and appropriate safeguards" per the requirement:** `wrangler.staging.jsonc`'s `"STAGING_WRITES_ENABLED": "true"` line, left commented out by default (confirmed via `wrangler deploy --dry-run`: the binding does not appear in the live bindings list while commented out — the exact same pattern already established for `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID`). Enabling it requires editing the config file and redeploying — never a runtime toggle a UI click could flip.

**Cannot affect Production:** the guard only ever matches `deploymentEnvironment === "staging-independent"`, a value Production's build never resolves to (`lib/environment.ts`); `STAGING_WRITES_ENABLED` was never added to `wrangler.production.jsonc` at all, and a new test (`tests/staging-write-guard.test.mjs`) asserts Production's config never carries that var.

**UI banner:** `app/layout.tsx` renders a persistent, sticky banner on every page (server-rendered, present before any client JS runs) reading **"STAGING — READ ONLY. All live donor updates and imports must be entered in Production."** when on the independent staging deployment, or a distinct amber "TEMPORARY WRITES ENABLED" banner if the override is currently flipped on — so a tester is never misled about which state they're in. Renders nothing on Production.

**Browsing preserved:** the guard only intercepts mutating methods under `/api/**`; every `GET` request (every page, every read-only API call) is completely unaffected.

### Audit of mutation paths (before deployment, per the task's explicit instruction)

Enumerated via `grep -rl "^export async function (POST|PUT|PATCH|DELETE)" app/api` — 50 route files, every one already covered by the blanket guard (see the regression test above). Background jobs: the `scheduled()` handler's two calls (`runScheduledAgendaSend`, `runScheduledBackupAlertCheck`) were individually reviewed; the agenda send is addressed by keeping its cron off Staging-as-the-long-term-home (Section 4) and the backup-alert write was deliberately left outside this guard's scope (operational state, not donor data, see above). Uploads and bulk actions (JL/Monday/DOB/yahrtzeit/rebbeim imports) all route through `app/api/import/**`, already covered.

### Testing

`tests/staging-write-guard.test.mjs` (new, registered in `scripts/run-tests.mjs`): pure-function unit coverage of every branch (method case-insensitivity, exact-match `"true"` override — never a loose truthy check, every non-staging-independent environment value, read requests, non-API paths); a structural check that the guard is actually invoked in `worker/index.ts`'s `fetch()` before the image branch and before `handler.fetch`; the whole-repo mutation-route-location invariant above; and config-state assertions (Production never carries the override var; Staging's cron stays active and Production's stays commented-out, matching Section 4's current transitional state exactly — explicitly a snapshot assertion to update in the same change that flips the cron).

**Full suite:** `pnpm test` — 180 test files run, 180 passed, 0 failed (179 existing + this round's 1 new file). `tsc --noEmit`: clean. `eslint` on every new/changed file: zero errors. `vinext build` for both `build:staging-independent` and `build:production-independent`: both succeed.

**Live verification limitation, same category as this repo's existing precedent:** Cloudflare Access intercepts every request at the edge before it reaches the Worker, including an unauthenticated `POST` (confirmed live: `302` to the Access login page, identical to the unauthenticated `GET` behavior — no regression). This means the guard's actual `403` response cannot be exercised live from this session without a real authenticated session or the Service Token's secret (which this repo never holds, only its Client ID). `docs/AI-HANDOFF.md`'s own "Morning Brief API" entry hit the identical limitation for its app-level `401` check and relied on unit tests instead — the same approach is used here, backed by the structural + unit tests above rather than a live `403` capture.

### Deployed

- `fundraising-os-staging`, Version ID `a6143fd0-9033-4c59-acac-e1c6da1cc229` (2026-10-12T01:15:18Z) — cron confirmed still `0 * * * *` post-deploy.
- `fundraising-os-production`, Version ID `7f7c4326-8a4e-4f73-90ed-89944d05500d` (2026-10-12T01:15:44Z) — confirmed `env.DB (fundraising-os-production-db)`, no cron, no `STAGING_WRITES_ENABLED`.
- Post-deploy data check: Production still shows 254 donors, 5,463 giving activities, owner email unchanged — the deploys themselves never touch D1 data, confirmed rather than assumed.

## 4. Daily Fundraising Agenda email — PREPARED, NOT YET ACTIVATED ON PRODUCTION (blocked, reported, not worked around)

**How it actually works** (read from source, not assumed): `worker/index.ts`'s `scheduled()` calls `runScheduledAgendaSend(now)` on every hourly Cron Trigger invocation; `lib/agenda/send-agenda.ts`'s `isDailyAgendaSendHour()` guard makes only the one invocation per day where the real America/New_York wall-clock hour reads 9 actually send (DST-safe by construction, recomputed from `Intl` every time, never a fixed UTC offset) — the other 23 are a silent no-op. The email reads from `env.STAGING_OWNER_EMAIL` (same value, `sgoldstein@nirc.edu`, on both deployments) and `loadWorkspaceBrief()`, which reads only through `env.DB` — **entirely deployment-scoped already**; whichever Worker's Cron Trigger fires is the one whose own bound database the email reflects. No separate "point the email at Production" code change was ever needed.

**Why it is NOT activated on Production today:** `wrangler secret list --config wrangler.production.jsonc` returns `[]` — Production has **zero** secrets. `GMAIL_OAUTH_CLIENT_ID`/`GMAIL_OAUTH_CLIENT_SECRET`/`GMAIL_OAUTH_REFRESH_TOKEN` (Staging has all three) do not exist on Production. Enabling Production's cron today would make it fail, silently from the owner's perspective, every single day — Cloudflare would record the scheduled invocation as failed (the code's own `logger.error` + rethrow, "never swallowed," confirms this would be *detected*, but not *fixed*, by just turning the cron on).

**Setting those three secrets is a `wrangler secret put` action.** This round's authorization explicitly excludes modifying secrets without separate approval. **Stopping here, per the task's own instruction**, rather than setting them.

**What was done instead, so nothing regresses and nothing silently breaks:**
- `wrangler.production.jsonc`: the cron is now **prepared as a commented-out line** (`// "triggers": { "crons": ["0 * * * *"] },`) with an explicit comment naming the exact blocker and the exact two-file flip needed once it's resolved.
- `wrangler.staging.jsonc`: the cron **stays active**, with a comment explaining why (removing it now, before Production can send, would stop the daily email entirely — directly contradicting "preserve the current delivery schedule" and "avoid duplicate emails" is moot if nothing is sending).
- **Recipients unchanged** either way: `from`/`to` is always `env.STAGING_OWNER_EMAIL`, the same owner address on both deployments.
- **Format/reporting logic unchanged**: no edit was made to `lib/agenda/agenda-model.ts`, `agenda-render.ts`, or `send-agenda.ts`'s own email-building logic.
- A new regression test (`tests/staging-write-guard.test.mjs`) pins this exact transitional state (Staging active, Production commented-out) so it cannot silently drift before the real flip happens.

**Exact action required from the owner before this can complete:**
1. `wrangler secret put GMAIL_OAUTH_CLIENT_ID --config wrangler.production.jsonc` (and `_CLIENT_SECRET`, `_REFRESH_TOKEN`) — either the same OAuth client/refresh token already used on Staging, or a freshly registered one; the owner's choice, not this session's to make.
2. Once set: uncomment the `"triggers"` line in `wrangler.production.jsonc`, **remove** the `"triggers"` block from `wrangler.staging.jsonc`, and deploy both in the same step — never one without the other, to avoid a day with zero sends or two. (This is also when `tests/staging-write-guard.test.mjs`'s cron-state assertions must be updated to match.)
3. `STAGING_WRITES_ENABLED` already independently prevents Staging from ever sending a *second* live email even if its cron were ever accidentally left active past that point — but the clean fix is still to remove the trigger, not to rely on that as the primary safeguard.

## 5. Claude's morning check — IDENTIFIED, EXTERNAL, CANNOT BE MODIFIED FROM THIS SESSION

**What it is, from source:** `GET /api/morning-brief` (`app/api/morning-brief/route.ts`, `lib/workspace/morning-brief-api.ts`), authenticated via a Cloudflare Access Service Token (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers), returning the same data `loadWorkspaceBrief()` already computes for the Today page/Assistant — `generatedAt`, `overview`, `recommendedFocus`, `priorities[]`, `todaySchedule[]`/`upcomingActivities[]`, `recentGifts[]`.

**Confirmed currently pointed at Staging:** `wrangler.staging.jsonc` has a real `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID` configured (the owner completed this step after the 2026-10-08 feature was built, per `docs/AI-HANDOFF.md`'s own "remaining work" note). `wrangler.production.jsonc` has **no such var at all** — Production's deployed Worker does not accept service-token authentication for this endpoint today.

**Checked whether this is implemented through this session's own tooling: it is not.** `CronList` (this session's scheduler) returned no scheduled jobs, and that mechanism is session-only by design (jobs vanish when a session ends, never written to disk) — it could never be the thing sending a daily request for months. The actual "morning check" is an external script/automation entirely outside this repository and outside this session's visible tools, consistent with `docs/AI-HANDOFF.md`'s own "Remaining work (the user's own steps, outside this repo)" note under the original Morning Brief API entry: "Point the morning-brief script at `GET /api/morning-brief` with `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers" — that script's location and schedule were never disclosed to or configured by this repository.

**What the owner must do, exactly, outside this session:**
1. In the Cloudflare Zero Trust dashboard, create (or reuse) a Service Token scoped to Production's Access Application, and set its Client ID as `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID` in `wrangler.production.jsonc` (this one line IS something this session could make once the Client ID is supplied — not done today because no value was provided).
2. Confirm that Access Application's path scope covers `/api/morning-brief` on the Production hostname (dashboard-only, not determinable from this repo — the same category of fact the original 2026-10-08 entry already flagged).
3. Update wherever the actual external morning-check script/scheduler lives — its URL, Client ID, and Client Secret — to point at `https://fundraising-os-production.sgoldstein.workers.dev/api/morning-brief` instead of Staging's URL. **This repository has no visibility into where that is**, so this step cannot be verified or performed from here.

**Not claimed as done:** no external configuration was touched. This section reports the exact blocker rather than guessing at a fix.

## 6. Production backups — THE MOST IMPORTANT FINDING OF THIS ROUND: NOT YET AUTOMATICALLY PROTECTED

Checked live via the GitHub Actions REST API (public read access; `gh` CLI unavailable in this session):

| Workflow | Trigger | Latest run | Result |
|---|---|---|---|
| `D1 nightly backup (Production)` | **`workflow_dispatch` only — no `schedule:` trigger exists in the file at all** | 2026-10-11T03:44:12Z | success |
| `D1 monthly restore verification (Production)` | **`workflow_dispatch` only — no `schedule:` trigger** | 2026-10-11T12:35:39Z | success (one earlier same-day failure, on the very first run immediately after this workflow's own initial deployment — not recurring since) |

**Both files carry an explicit header comment stating this is deliberate**: *"DELIBERATELY NOT ON A SCHEDULE... this workflow must never fire automatically until the Production database has real data worth protecting AND the Production-scoped secrets below actually exist AND launch readiness has been separately confirmed. Add a `schedule:` block... only as part of that later, separately-approved step."*

**That moment has now arrived — Production holds the real, migrated donor dataset — but the schedule has not been added.** Per the task's own explicit instruction not to assume a pre-migration backup proves current protection: **the most recent Production backup (2026-10-11T03:44:12Z) predates this round's migration (2026-10-12T00:38–00:41Z) and does NOT contain the migrated donor data.** As things stand, **Production's donor/fundraising data has zero automated backup coverage** — it is backed up only if and when someone manually triggers `workflow_dispatch`.

**This round did not add the `schedule:` block.** Doing so is explicitly "modify backup schedules... without separate authorization," outside this round's authorization boundary. **This round could not manually trigger either workflow either** — triggering `workflow_dispatch` requires GitHub write credentials (a token), and this session has none (confirmed: no `gh` CLI, no `GITHUB_TOKEN`/`GH_TOKEN` in the environment; only unauthenticated, read-only REST API access was available).

**Exact action required from the owner, as the single highest-priority follow-up from this entire round:**
1. Immediately: manually run both "D1 nightly backup (Production)" and, afterward, "D1 monthly restore verification (Production)" via the GitHub Actions UI's "Run workflow" button — closing the gap for *today's* data without changing anything about the schedule.
2. Separately, when ready: add a `schedule:` block to both workflow files (the comments already specify exactly what — Staging's own cron, offset by a few minutes) and have that reviewed/approved like any other infrastructure change — not performed by this round.

No backup-schedule, secret, retention, or storage-destination change was made.

## 7. Future data imports — ROUTING CONFIRMED CORRECT (via the Staging write-guard, not a separate mechanism)

Traced the JL import pipeline (`app/api/import/route.ts`, `app/api/import/preview/route.ts`, `lib/import/jl-*.ts`) and every other import mechanism (Monday, DOB, yahrtzeit, rebbeim — all under `app/api/import/**`): **none of them reference a specific database by name or hold a separate credential pointing at one.** Every import writes through the same `env.DB` binding every other route uses — it goes to whichever deployment (Staging or Production) actually receives the HTTP request. There is no separate "import service" to repoint.

**Direct consequence:** "no existing scheduled or manual import silently writes to Staging after the transition" is now satisfied by Section 3's write-guard, not by a separate code change — any import attempted against Staging's URL is blocked at the same `/api/import/**` layer as every other mutation, unless `STAGING_WRITES_ENABLED` is explicitly set for a deliberate test. Real imports should be performed against `https://fundraising-os-production.sgoldstein.workers.dev` going forward. No real import was executed as part of this verification (confirmed: zero `INSERT` statements against either database this round).

**No external integration credential or endpoint change was identified as necessary** — the import pipeline has always been "whichever URL the fundraiser is using," never a fixed external target.

## 8. Testing and deployment safeguards

1. `pnpm test`: 180/180 passed. `tsc --noEmit`: clean. `eslint`: zero errors on changed files.
2. New regression tests: `tests/staging-write-guard.test.mjs` (Staging write-block unit + structural coverage, described in Section 3; also proves Production write-availability is structurally guaranteed by the same guard's own `deploymentEnvironment` gate — it is simply never blocked there).
3. Worker bindings reviewed via `wrangler deploy --dry-run` for both configs before the real deploy — confirmed exactly the expected bindings on each, no accidental cross-wiring.
4. Duplicate-scheduled-email risk: identified precisely (Section 4) and avoided by deliberately keeping the cron on exactly one Worker (Staging, for now) rather than ever having it live on both at once.
5. Rollback plan, not touching migrated donor data: `git revert` the commit containing this round's code/config changes (`lib/operations/staging-write-guard.ts`, `worker/index.ts`, `app/layout.tsx`, `cloudflare-env.d.ts`, the two `wrangler.*.jsonc` files, the new test) and redeploy both Workers from the prior commit. This touches only application code and Worker configuration — it has no code path that reaches either D1 database, so it cannot affect the migrated data in Production or anything in Staging.

## 9. Post-deployment verification (actual deployed environments, not just local code)

| Check | Result |
|---|---|
| Production accessible/authenticated | `GET /` → `302` to Cloudflare Access login, same as before this round — no regression |
| Production donor records/giving history intact | 254 donors, 5,463 giving activities, confirmed live post-deploy |
| Production accepts authorized writes | Not exercised live (would require a real authenticated session); structurally true by construction — the write-guard never matches `deploymentEnvironment !== "staging-independent"`, and Production's own existing D1 write paths are completely unmodified by this round |
| Staging displays the read-only warning | Deployed (`app/layout.tsx`); not captured in an authenticated screenshot this round (same Access-at-the-edge limitation as the `403` check) — verified by code/structural tests instead |
| Staging rejects writes server-side | Verified by unit + structural tests (Section 3); the actual live `403` could not be exercised unauthenticated (Access intercepts first, confirmed live) |
| Daily email: Production source, one delivery mechanism | **Not yet true** — still Staging-only until the Section 4 blocker clears; accurately reported as prepared-not-active, not claimed complete |
| Morning check: Production as primary target | **Not yet true** — still points at Staging; external configuration limitation reported in full (Section 5), not claimed modified |
| Production backups cover the migrated data | **Not yet true** — Section 6's finding; most recent backup predates the migration, and no schedule exists to fix that automatically |
| No donor data lost or unexpectedly changed | Confirmed — zero write statements executed against either database this round; Production counts/owner-account identical before and after |

**No fake donation or test record was created in Production or Staging at any point.**

## 10. Summary: what "DONE" actually means today

**PRODUCTION = live fundraising work, donor data, primary environment** — true today for data and application access. **Not yet true** for the daily email (still Staging) or morning monitoring (still Staging) or automated backup coverage (not yet scheduled) — each blocked on a specific, named, owner-only action (Sections 4/5/6), not forgotten.

**STAGING = protected, read-only testing environment with a controlled override** — true today, deployed and tested. Still the one actually sending the live daily email, by necessity, until Production's secrets exist (Section 4).

---

No donor data was lost, modified, or recreated. No secret, backup schedule, retention policy, or external integration was changed. No merge to `main` was performed.
