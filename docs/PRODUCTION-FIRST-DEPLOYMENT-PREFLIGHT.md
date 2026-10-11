# Fundraising OS — Production First Deployment Preflight

**Date:** 2026-10-11
**Status:** Independent, read-only preflight. Nothing was deployed, migrated, or modified during this round. Every finding below was re-verified live this round (fresh `wrangler`/GitHub API calls, fresh local build/test runs, direct code reads) — prior documents (`docs/AI-HANDOFF.md`, `docs/PRODUCTION-LAUNCH-READINESS-ASSESSMENT.md`, `docs/PRODUCTION-INFRASTRUCTURE-SETUP.md`) were read first but treated as claims to re-check, not facts to assume.

---

## 1. Executive GO/NO-GO recommendation

**GO for the first empty Production deployment** (Production status-worker, then the main Production Worker), subject to the order and immediate post-deploy verification in §6–§7.

**NO-GO, unchanged and untouched by this preflight, for:**
- Adding the `GITHUB_BACKUP_DISPATCH_TOKEN` Cloudflare secret to Production's status-worker (Stage 2 watchdog) — **blocked** until `status-worker/src/github-dispatch.ts`'s hardcoded workflow filename is fixed (§3).
- Adding `schedule:` triggers to either Production GitHub Actions workflow.
- Any donor-data migration or real cutover.

This deployment is for an **empty, Access-gated, schedule-free Production environment** only. It does not start any automated backup, does not expose any donor data (there is none yet), and does not activate any cross-environment dispatch capability (that capability is provably unreachable in the current configuration — see §3).

---

## 2. Verified Production configuration

All of the following was re-checked live this round, not assumed from prior documents.

### 2.1 Main Production Worker (`wrangler.production.jsonc`)

| Property | Value | Verified how |
|---|---|---|
| Worker name | `fundraising-os-production` | File read; confirmed **does not yet exist** on the account via `wrangler deployments list --config wrangler.production.jsonc` → `This Worker does not exist on your account. [code: 10007]` (re-run fresh this round) |
| Cloudflare account | `Sgoldstein@nirc.edu's Account` (`2f34086b78ac8643498a1a600b846757`) | `wrangler whoami`, re-run fresh this round |
| D1 binding | `DB` → `fundraising-os-production-db` (`a51c6571-ae16-4614-aa9a-08f8e6be3ecd`) | File read + `wrangler d1 list` (fresh): confirmed this exact id, distinct from Staging's `6c18396c-0a8f-4f2c-ba83-ea809ec10289`; live query this round: 56 tables, `donors=0`, `gifts=0` |
| R2 bucket binding | **None on the main Worker** — by design (`tests/backup-automation.test.mjs`'s no-R2-binding guardrail pattern, mirrored from Staging) | File read: no `r2_buckets` key present |
| Service binding | `STATUS_WORKER` → `fundraising-os-production-backup-status` | File read; target Worker confirmed **not yet deployed** (`wrangler deployments list` on the status-worker config, fresh) |
| Cloudflare Access | `TEAM_DOMAIN="fundraising-os.cloudflareaccess.com"`, `POLICY_AUD="7cfff2279260cb67e19af8c129b2ba6cdd137ba855ddb638ff316493f8ef14e1"` | File read; confirmed not placeholder values, confirmed distinct from Staging's own `POLICY_AUD` (`b9796074ba20c3787bd3fc697c0eb0de6981f240081ff3018fb28e5bb95971ed`) by direct diff against `wrangler.staging.jsonc` |
| Owner email | `STAGING_OWNER_EMAIL="sgoldstein@nirc.edu"` | File read |
| `APP_BASE_URL` | `https://fundraising-os-production.sgoldstein.workers.dev` (predicted default; not yet confirmed live since nothing is deployed) | File read |
| Cron triggers | **None** — no `triggers` key present at all | File read; confirmed absent (Daily Agenda deliberately excluded per the file's own comment) |
| Required secrets (GitHub Actions, for the two backup/restore workflows — not Worker secrets) | All 7 present: `BACKUP_ENCRYPTION_PASSPHRASE_PRODUCTION`, `R2_BACKUP_READ/WRITE_*_PRODUCTION` (×2 each), `R2_STATUS_WRITE_*_PRODUCTION` (×2) | `GET /repos/.../actions/secrets`, re-run fresh this round — all present, `updated_at` 2026-10-11 |
| Build command | `pnpm run build:production-independent` → `node scripts/build-production-independent.mjs` | Re-run fresh this round (see §4) |
| Deploy command | `pnpm run deploy:production-independent` → `wrangler deploy --config wrangler.production.jsonc` (a separate command; does **not** run the build itself) | `package.json` read |

### 2.2 Production status-worker (`status-worker/wrangler.production.jsonc`)

| Property | Value | Verified how |
|---|---|---|
| Worker name | `fundraising-os-production-backup-status` | File read; confirmed **does not exist** on the account via fresh `wrangler deployments list` |
| Public route | **None** — `workers_dev: false`, no `routes` | File read; this Worker has no network path reachable from the public internet under any configuration, deployed or not |
| R2 binding | `STATUS_BUCKET` → `fundraising-os-production-backup-status` (read-only by its own code, never `.put()`/`.delete()`/`.list()`) | File read + `wrangler r2 bucket list` (fresh): bucket exists, created 2026-10-09, distinct from Staging's `fundraising-os-backup-status` |
| Cron trigger | `"23 * * * *"` (hourly) | File read; distinct minute from Staging's own watchdog cron (`"17 * * * *"`, confirmed by reading `status-worker/wrangler.jsonc`) — no scheduling collision between the two environments' watchdogs |
| Secrets this Worker could hold | `GITHUB_BACKUP_DISPATCH_TOKEN` (optional, Stage 2 only) | Attempted `wrangler secret list --config wrangler.production.jsonc` fresh this round → `Worker "fundraising-os-production-backup-status" not found.` **This is conclusive, not inferential: a Cloudflare Worker secret cannot exist for a script that has never been deployed.** No such secret exists today, and none can exist until the Worker is deployed and the secret is explicitly set in a separate step. |

### 2.3 Isolation from Staging — confirmed by direct diff, not by comment alone

| Resource | Staging | Production | Shared? |
|---|---|---|---|
| D1 database id | `6c18396c-0a8f-4f2c-ba83-ea809ec10289` | `a51c6571-ae16-4614-aa9a-08f8e6be3ecd` | No |
| Backup R2 bucket | `fundraising-os-staging-backups` | `fundraising-os-production-backups` | No |
| Status R2 bucket | `fundraising-os-backup-status` | `fundraising-os-production-backup-status` | No |
| Status-worker service name | `fundraising-os-backup-status` | `fundraising-os-production-backup-status` | No |
| Access Application AUD | `b9796074...` | `7cfff227...` | No (same Zero Trust org, separate Application) |
| Watchdog cron minute | `:17` | `:23` | No collision |
| GitHub Actions secrets | `R2_BACKUP_*`, `BACKUP_ENCRYPTION_PASSPHRASE` (no suffix) | Same names with `_PRODUCTION` suffix | No — fully distinct secret values |
| GitHub workflow files/targets | `d1-backup-nightly.yml`, `d1-restore-verify-monthly.yml` | `d1-backup-nightly-production.yml`, `d1-restore-verify-monthly-production.yml` | No, **except** see §3 — one code path does not yet respect this separation |

**No configuration file was found that could cause a deployed Production resource to inadvertently read, write, or reference a Staging resource**, with the one specific, fully-traced exception in §3.

---

## 3. Complete scheduled-operation safety findings

This is the most safety-critical question in this preflight, so it is traced in full, line by line, rather than summarized from the prior assessment.

### 3.1 The code in question

`status-worker/src/github-dispatch.ts`:
```ts
const REPO = "shimmy12345/ner-yisroel-fundraising-studio-v3";
const WORKFLOW_FILE = "d1-backup-nightly.yml";   // <- Staging's filename, literal
```
Both exported functions (`checkActiveBackupRun`, `dispatchBackupWorkflow`) build their GitHub API URLs from this one constant. There is no environment parameter, no binding, no way for the Production status-worker to resolve this to its own `d1-backup-nightly-production.yml`. **This is confirmed, not inferred: existing test `tests/backup-watchdog-github-dispatch.test.mjs` line 25 explicitly asserts the dispatch URL ends in `/d1-backup-nightly.yml/dispatches` — the hardcoding is the codebase's current, deliberately-tested behavior for the one environment (Staging) it was built for, with no Production-aware variant ever added.**

### 3.2 Complete execution trace

**Entry point:** `status-worker/src/index.ts`'s `scheduled()` handler — fires only from the Cloudflare Cron Trigger (`"23 * * * *"` for Production), a platform-level trigger entirely independent of GitHub Actions' own scheduler.

```
scheduled() 
  → ctx.waitUntil(runBackupWatchdog(env, Date.now()))
  → runBackupWatchdog:
      1. readBackupStatus(env.STATUS_BUCKET)
         -- env.STATUS_BUCKET is bound, per wrangler.production.jsonc, to
            fundraising-os-production-backup-status ONLY. There is no
            code path, binding, or credential by which this read could
            ever touch Staging's status bucket. CONFIRMED by direct file
            read of the R2 binding, not assumed.
      2. evaluateBackupFreshness(...) -- pure function, no I/O, no
         environment-specific constants of any kind (verified by reading
         status-worker/src/watchdog.ts in full and grepping it for any
         "staging"/"production" literal -- none found).
      3. if action !== "fresh":
           log "recovery_needed"
           if (!env.GITHUB_BACKUP_DISPATCH_TOKEN):
             log "recovery_needed_detection_only"
             RETURN  <-- GitHub is NEVER called. checkActiveBackupRun
                          and dispatchBackupWorkflow (the only two
                          functions that reference WORKFLOW_FILE) are
                          NEVER INVOKED on this path.
           [only reachable if the token exists:]
           checkActiveBackupRun(fetch)          -- uses WORKFLOW_FILE
           dispatchBackupWorkflow(fetch, token)  -- uses WORKFLOW_FILE
```

**The critical fact, confirmed by this trace and independently confirmed live (§2.2): `env.GITHUB_BACKUP_DISPATCH_TOKEN` cannot exist today.** Cloudflare Worker secrets are set only via an explicit `wrangler secret put` against an already-deployed Worker script. This round's attempt to even *list* secrets for `fundraising-os-production-backup-status` failed with `Worker "fundraising-os-production-backup-status" not found` — proof by direct negative, not an assumption, that no such secret can be present.

**Therefore: deploying the Production status-worker today, exactly as currently configured, with its cron trigger active, cannot reach the buggy code at all.** Every hourly invocation will, at most, read Production's own status bucket and log one of `fresh` or `recovery_needed_detection_only` — it will never call GitHub's API, never reference Staging's workflow file, never dispatch anything, in Staging or Production.

**What will happen over time if deployed today, concretely:** the status bucket's most recent recorded success is this morning's manual backup (`38109341883`, ~03:44 UTC). Since neither Production workflow has a `schedule:` trigger, no new success will ever be recorded automatically. Roughly 26 hours after that timestamp (around 2026-10-12 ~05:44 UTC), the watchdog's hourly log lines will shift from `fresh` to `recovery_needed` / `recovery_needed_detection_only`, and will continue logging that every hour, indefinitely, until either a new manual backup is dispatched or the workflow is put on a schedule. **This is expected, harmless, and purely informational** — it is a log line in Cloudflare's own Workers Logs, nothing more; no alert, no email, no GitHub call results from it.

### 3.3 Risk classification

| Risk | Classification | Rationale |
|---|---|---|
| Deploying the Production status-worker as-is triggers any Staging interaction | **NON-BLOCKING** | Traced completely in §3.2: the only code path that references Staging's workflow filename is provably unreachable without a secret that cannot exist today |
| Deploying the Production status-worker as-is triggers any unintended GitHub Actions dispatch (Production or Staging) | **NON-BLOCKING** | Same trace — Stage 1 only, no dispatch call of any kind occurs |
| The Production watchdog logging `recovery_needed_detection_only` hourly after ~26h | **NON-BLOCKING** | Purely informational logging; no action, no alert, no side effect |
| `WORKFLOW_FILE` hardcoding itself, as a latent defect | **BLOCKING — but only for a specific future action, not for this deployment**: adding `GITHUB_BACKUP_DISPATCH_TOKEN` to Production's status-worker (enabling Stage 2) must not happen until this is fixed, or it would silently dispatch **Staging's** backup workflow on a stale-Production-freshness condition | Confirmed by the same trace: once the token exists, `dispatchBackupWorkflow` is reached and uses the hardcoded Staging filename unconditionally |
| Main Production Worker's own cron | **N/A — none exists** | `wrangler.production.jsonc` has no `triggers` key; the Daily Agenda/backup-alert `scheduled()` logic in `worker/index.ts` will simply never fire for Production until a cron is deliberately added later |
| Stale inline comment in `status-worker/src/index.ts` referencing only `fundraising-os-staging-backups` | **NON-BLOCKING, cosmetic** | A comment, not executable code; written before Production existed; does not affect behavior, but is now misleading and worth a one-line correction whenever the file is next touched |

**Recommended correction before deployment (cheap, zero-risk, not strictly required):** parameterize `WORKFLOW_FILE` (and ideally `REPO`'s workflow-suffix logic) per environment — e.g. read it from a `wrangler.jsonc` `vars` entry the same way `DATABASE_NAME` and bucket names are already environment-specific elsewhere in this codebase — and add a regression test asserting the Production status-worker's dispatch target is `d1-backup-nightly-production.yml`, distinct from Staging's. This is not required to deploy safely today (§3.2 proves today's deployment cannot reach the bug), but doing it now removes the need to remember it later, before the separate, future Stage 2 decision.

---

## 4. Build and deployment readiness

All of the following was executed fresh this round, locally, with no Cloudflare or GitHub mutation:

| Check | Result |
|---|---|
| `pnpm exec tsc --noEmit` | **Clean, exit 0** |
| `pnpm test` | **178/178 test files passed, 0 failed** |
| `pnpm run build:production-independent` | **Succeeded** — real `vinext build` run, all routes compiled |
| Correct environment constant baked into the output bundle | **Confirmed**: `grep -c "production-independent" dist/server/index.js` → `1` (re-verified fresh this round, not assumed from the 2026-10-09 report) |
| Build script performs any migration, D1 write, or network call | **No** — `scripts/build-production-independent.mjs` is a local `vinext build` invocation with three environment variables set (`FUNDRAISING_OS_ENVIRONMENT`, `FUNDRAISING_OS_SCHEMA_TRACK`, `FUNDRAISING_OS_COMMIT`) and a best-effort, non-failing `git rev-parse HEAD` call; read in full, confirmed no `wrangler`, `fetch`, or database call anywhere in it |
| Deploy command performs any migration, D1 write, or donor-data import | **No** — `deploy:production-independent` is exactly `wrangler deploy --config wrangler.production.jsonc`, nothing wrapped around it; `wrangler deploy` uploads the already-built bundle and config, it does not execute application code or touch D1 rows |
| Correct config file used (not the non-functional example) | **Confirmed by diff** — `wrangler.production.jsonc` has real `database_id`, real `TEAM_DOMAIN`/`POLICY_AUD`; `wrangler.production.example.jsonc` remains the separate, placeholder-only template, never referenced by either build/deploy script |
| Status-worker-before-main-Worker ordering: is it enforced, or just documented? | **Documented, not mechanically enforced.** No script fails if run out of order. See §3.2's companion finding below for what actually happens if the order is reversed. |
| What actually happens if the main Worker is deployed before the status-worker | **Confirmed by code read, not deployed to test**: `lib/data-health/read.ts`'s `fetchBackupStatus()` wraps the `env.STATUS_WORKER.fetch(...)` call in try/catch and returns `{ backupStatusReachable: false, ... }` on any failure — it does **not** throw, crash the page, or fail other requests. The practical effect of deploying out of order is a degraded Workspace Health "Automated backup"/"Monthly restore test" card (reads as unreachable) until the status-worker is deployed, at which point — confirmed by `docs/DEPLOYMENT.md`'s own note that a service-binding target is resolved by name at request time — it self-heals with **no redeploy of the main Worker required**. Recommended order (status-worker first) is still correct and should be followed; this is reported as a safety margin, not permission to skip the documented order. |
| No unexpected Staging resource would be touched by either deploy | **Confirmed** — neither config file references any Staging resource name, id, or secret anywhere (§2.3) |

---

## 5. Authentication and security findings

Traced through actual source, not assumed from the prior assessment's summary.

### 5.1 Expected behavior, by request type

| Request | Expected behavior | Where enforced |
|---|---|---|
| Anonymous request to the Production `workers.dev` URL | `302` redirect to `https://fundraising-os.cloudflareaccess.com/cdn-cgi/access/login/...` — **at Cloudflare's edge, before the Worker ever runs** | Cloudflare Access Application (owner-created, Zero Trust dashboard); **this is the primary gate** |
| Authenticated owner (`sgoldstein@nirc.edu`) with a valid Access session | Passes Access, then: `app/chatgpt-auth.ts`'s `getChatGPTUser()` calls `selectAuthProviders(hasCloudflareAccessConfigured=true, ...)` → **only** `cloudflareAccessAuthProvider` is used (confirmed: `lib/auth/provider-selection.ts:68`, `return [cloudflareAccessAuthProvider]` when Access is configured — the legacy ChatGPT-Sites header path is never even checked) → `verifyAccessToken()` validates JWT signature/issuer/audience/expiry via `jose` against the real JWKS, extracts `email`, confirms it equals `STAGING_OWNER_EMAIL` → authenticated as the owner | `app/auth/cloudflare-access-provider.ts`, `lib/auth/cloudflare-access.ts` |
| A technically-valid Access JWT for a **different** email (should not be issuable per the Access policy itself, but checked independently anyway — defense in depth) | **Rejected**, treated identically to unauthenticated | `lib/auth/cloudflare-access.ts:58-59`: `if (config.ownerEmail && email.toLowerCase() !== config.ownerEmail.toLowerCase()) return null;` — confirmed by direct code read this round |
| A request bearing the legacy `oai-authenticated-user-email` header (no real Access JWT) | **Ignored entirely** on Production — the header provider is never in the active provider list whenever `TEAM_DOMAIN`/`POLICY_AUD` are both configured (true for Production) | `lib/auth/provider-selection.ts:68`, `app/chatgpt-auth.ts:56-57` |
| Any authenticated request to `/api/operations/staging-reset` | **404**, not 401/403 — invisible, not merely unauthorized | `lib/operations/staging-reset.ts:132`: `if (deploymentEnvironment !== "staging-independent") return { allowed: false, status: 404, ... }` — Production's build sets `deploymentEnvironment` to `"production-independent"`, a distinct value, confirmed unreachable |
| Any of the 63 API route files in `app/api/**/route.ts` | **All 63 reference `requireChatGPTUser` or `getChatGPTUser`** — confirmed this round by checking every single route file, not a sample; **zero unauthenticated API routes found** | Direct `grep` across the full route tree |
| A request to the Production status-worker's `/status` endpoint, directly | Not internet-reachable at all — `workers_dev: false`, no `routes` configured; there is no public URL to send such a request to, deployed or not. The route handler itself performs no authentication check, but this is safe specifically because the only way to reach it is a Worker-to-Worker Service Binding from a Worker explicitly wired to it at deploy time (the main Production Worker, and only it) | `status-worker/wrangler.production.jsonc` (no `routes`), `status-worker/src/index.ts` |

### 5.2 Specific answers to the task's questions

- **Anonymous requests:** redirected by Cloudflare Access before reaching application code; confirmed by config inspection, **not yet confirmed against a live request** (nothing is deployed) — this is the first item on the post-deployment checklist below.
- **Authorized owner:** authenticates correctly per the trace above; same live-verification caveat applies.
- **Unauthorized authenticated users:** rejected by the app's own independent email check even if somehow Access let a non-owner JWT through — confirmed at the code level (`tests/cloudflare-access-auth.test.mjs`'s existing "owner restriction" cases cover this; re-run as part of the 178/178 pass this round).
- **Public routes exposing sensitive information:** none found — all 63 API routes gate on authentication; static assets (`ASSETS` binding) serve only the compiled app shell/JS/CSS, no data.
- **Initial empty Production database isolation:** sufficient — even in a worst-case auth failure, there is no donor data to expose (`donors=0`, `gifts=0`, confirmed live this round), and `staging-reset` (the one destructive admin operation) is unreachable on Production by construction.
- **Production status-worker unauthenticated endpoints:** `/status` has no auth check in its own code, but is not reachable from outside Cloudflare's internal Worker-to-Worker binding mechanism — this is isolation by network topology, not by application-layer authentication, and that distinction is called out explicitly here rather than glossed over.

### 5.3 Live verification checklist — execute immediately after deployment, before considering Production "live"

1. **Anonymous access test:** `curl -I https://fundraising-os-production.sgoldstein.workers.dev/` (or any path) → must return `302` with a `location` header pointing at `fundraising-os.cloudflareaccess.com/cdn-cgi/access/login/...`. **Any `200` or app content here means Access is misconfigured — treat the environment as unprotected and do not proceed.**
2. **Owner login test:** complete the real Access login flow as `sgoldstein@nirc.edu`, load `/settings`. Confirm Workspace Health shows the correct environment label, `Baseline: Verified`, `Business data: Empty`.
3. **Status-worker reachability test:** from the now-authenticated `/settings` page, confirm the "Automated backup"/"Monthly restore test" cards show real (if stale/never-run-on-schedule) data from today's manual runs, not "unreachable" — this proves the `STATUS_WORKER` service binding resolved correctly.
4. **Non-owner rejection test (if practical):** attempt the Access flow with any other identity available for testing; confirm rejection. If no second test identity exists, this step may be deferred, but should not be skipped indefinitely.
5. **Staging-reset invisibility test:** `curl` (authenticated as owner) `/api/operations/staging-reset` → must return `404`, never `401`/`403`/`200`.
6. **Staging cross-check:** immediately after, re-confirm Staging's own Access login and Workspace Health still behave exactly as before (unaffected by the new Production deployment) — this is a cheap, high-value regression check given both environments now share the same Zero Trust organization.
7. **Watchdog log check:** `cd status-worker && wrangler tail --config wrangler.production.jsonc`, wait for the next `:23` cron tick, confirm exactly one `fresh` (or, if >26h since the last manual backup, `recovery_needed_detection_only`) log line — and confirm no GitHub-dispatch-related log line (`recovery_dispatch_requested`/`recovery_dispatch_failed`) ever appears, which would indicate the token exists when it shouldn't.

---

## 6. Blocking issues and required corrections

**Blocking issues for this deployment: none.**

**Blocking for a specific future action (not this deployment):**
- Fix `status-worker/src/github-dispatch.ts`'s hardcoded `WORKFLOW_FILE` before ever adding `GITHUB_BACKUP_DISPATCH_TOKEN` to Production's status-worker (§3.3).

**Required corrections before this deployment: none identified.** The one recommended-but-not-required correction (parameterizing `WORKFLOW_FILE` now, while touching the file is cheap) is listed in §3.3 as a recommendation, not a blocker.

---

## 7. Exact deployment commands, in the correct order

**Not executed this round.** Listed here for the record and for whoever performs the actual, separately-authorized deployment.

```bash
# 1. Deploy the Production status-worker FIRST.
cd status-worker
wrangler deploy --config wrangler.production.jsonc
cd ..

# 2. Build the main Production Worker (separate from deploy; must run first).
pnpm run build:production-independent

# 3. Deploy the main Production Worker.
pnpm run deploy:production-independent
# equivalently: wrangler deploy --config wrangler.production.jsonc
```

Immediately after step 3: run every item in §5.3's live verification checklist before considering this deployment complete or telling anyone Production is reachable.

**Explicitly not part of this sequence, and not to be run alongside it:** anything that sets `GITHUB_BACKUP_DISPATCH_TOKEN`, anything that adds a `schedule:` block to any workflow file, and anything that imports, restores, or writes donor data into `fundraising-os-production-db`.

---

## 8. Post-deployment verification checklist

See §5.3 for the authentication-specific checklist. In addition:

- [ ] `wrangler deployments list --config status-worker/wrangler.production.jsonc` shows a real deployment (not `code: 10007`).
- [ ] `wrangler deployments list --config wrangler.production.jsonc` shows a real deployment.
- [ ] `wrangler d1 execute fundraising-os-production-db --remote --command "SELECT COUNT(*) FROM donors;"` still returns `0` (confirm the deployment itself wrote no data — it shouldn't, and §4 confirms neither script contains a write, but verify anyway).
- [ ] Confirm the actual assigned `workers.dev` URL matches the predicted `https://fundraising-os-production.sgoldstein.workers.dev`; update `APP_BASE_URL` in `wrangler.production.jsonc` and redeploy if Cloudflare assigned anything different (per that file's own comment).
- [ ] `cd status-worker && wrangler tail --config wrangler.production.jsonc` for at least one full hour, confirming the cron fires once and only logs `fresh`/`recovery_needed_detection_only` — never a dispatch-related event.
- [ ] Confirm Staging's own deployment, Access login, and Workspace Health are unaffected (§5.3 item 6).

---

## 9. Rollback procedures

**Distinguishing deleting a brand-new Worker from rolling back an existing one — this matters here specifically because both Production Workers are being deployed for the first time:**

### If the status-worker deployment fails or looks wrong
Since it has no prior version to roll back to, the correct action is **deletion, not rollback**:
```bash
cd status-worker
wrangler delete --config wrangler.production.jsonc
```
This removes the Worker entirely; the R2 bucket, its data, and all GitHub secrets are untouched. Re-deploy once the issue is understood.

### If the main Worker deployment fails or looks wrong (first deployment — same situation)
```bash
wrangler delete --config wrangler.production.jsonc
```
Same reasoning — there is no prior version to roll back to on a first deploy. D1 (`fundraising-os-production-db`) is untouched by this; it is a separate resource from the Worker script and is not deleted by `wrangler delete`.

### If a *future* redeployment (after this first one) needs to be undone
At that point, and only then, `wrangler rollback` or `wrangler deployments list` / `wrangler versions deploy` (to pin an older version) becomes the correct tool — Cloudflare retains recent Worker versions once more than one exists. Not applicable to tonight's first deployment, but documented here so it isn't confused with deletion later.

### If live Access verification (§5.3) fails
Do not attempt to patch Access configuration ad hoc. Delete the newly deployed main Worker (`wrangler delete --config wrangler.production.jsonc`) to remove the exposed surface immediately, then diagnose the Access Application/policy configuration in the Cloudflare dashboard (this session's credentials have no Access API scope, confirmed in the earlier infrastructure-setup round) before attempting another deploy.

### If unexpected scheduled activity is observed (e.g., a dispatch-related log line appears when it shouldn't)
This would indicate `GITHUB_BACKUP_DISPATCH_TOKEN` exists when §3.2 proves it shouldn't be able to. Immediately:
```bash
cd status-worker
wrangler secret delete GITHUB_BACKUP_DISPATCH_TOKEN --config wrangler.production.jsonc
```
(no redeploy needed — absence of the secret is what keeps the watchdog in Stage 1), then investigate how it was set, since per this preflight's own trace that should not be possible on a correctly-executed first deployment.

### If environment bindings are wrong (e.g., `STATUS_WORKER` resolves to the wrong service, or `DB` points at the wrong database id)
Fix `wrangler.production.jsonc` (or the status-worker's config) and redeploy — config is just a file; redeploying with corrected bindings takes effect immediately, no data migration needed since no data exists yet. If this is discovered *after* real data exists (a future, separate concern), treat it with much more caution and stop to get explicit guidance rather than following this quick procedure.

---

## 10. Remaining risks

- **Cloudflare Access has never been exercised against a real live request.** Real config values are in place and unit-tested, but §5.3's checklist is the actual first live proof. If it fails, this is the single most consequential thing to catch before calling the deployment done.
- **`APP_BASE_URL`'s predicted value may not match what Cloudflare actually assigns.** Low impact (used for building absolute links in emails/agenda features not yet enabled for Production), but worth confirming and correcting per §8.
- **The `WORKFLOW_FILE` hardcoding remains unfixed.** Zero risk today (§3), but is a standing trap for whoever later decides to enable Production's Stage 2 watchdog without first reading this document or `docs/PRODUCTION-LAUNCH-READINESS-ASSESSMENT.md`.
- **No automated backup protection exists for Production until scheduling is deliberately enabled later.** D1's native 30-day Time Travel still applies automatically regardless; this is a reminder, not a new gap.
- **This preflight did not and cannot test the live deploy itself** (explicitly out of scope) — §4's build/test verification is as close as a read-only round can get; the actual `wrangler deploy` invocation remains the first real-world test of the full chain.

---

## 11. Explicit approval gates

1. **Deploying the two empty Production Workers** (§7) — the action this document was written to support. Low risk (empty database, Access-gated, every piece duplicates an already-proven Staging pattern), but it is the first time anything Production-facing becomes reachable at all.
2. **Fixing `WORKFLOW_FILE`** — recommended now, not required for this deployment; a normal code-review approval, not a Production-data-affecting one.
3. **Adding `GITHUB_BACKUP_DISPATCH_TOKEN`** (Stage 2) — separately gated, and gated specifically on gate 2 being done first.
4. **Adding `schedule:` triggers** to either Production workflow — separately gated, unchanged from the prior assessment.
5. **Any donor-data migration or cutover** — separately gated, unchanged from the prior assessment; this document does not move that forward in any way.

---

Stopping here, per explicit instruction. No Worker was deployed, no workflow was run, no scheduling was enabled, and no donor data was touched or migrated this round.
