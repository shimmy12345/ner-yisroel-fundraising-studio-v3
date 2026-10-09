# Fundraising OS — Independent Production Infrastructure Setup

**Date:** 2026-10-09
**Status:** Infrastructure provisioning only. No application deployed. No donor data copied or migrated. No Production URL is live or operational. This is not Production launch — see `docs/ACCELERATED-PRODUCTION-LAUNCH.md` for the full launch plan and `docs/AI-HANDOFF.md` for this round's verification record.

This document is the authoritative inventory of the independent Cloudflare Production environment: exactly what exists, what doesn't yet, and the precise manual steps remaining.

**2026-10-09 update (Configuration + Build Resolution round)**: the owner created the Production Cloudflare Access Application + policy (the one piece this session's own credentials could not automate) and supplied the real `TEAM_DOMAIN`/`POLICY_AUD`. `wrangler.production.jsonc` has been updated with the real values — confirmed correct by a new regression test, not just by eye. The build-script gap (§8's prior caveat) is also resolved: `scripts/build-production-independent.mjs` / `pnpm run build:production-independent` now exist, giving the independent Production Worker its own `FUNDRAISING_OS_ENVIRONMENT` value (`"production-independent"`), distinct from legacy production's `"production"`. **Still not deployed** — see the revised §9 for exactly what remains.

---

## 1. Resources created

| Resource | Status |
|---|---|
| Production D1 database | **Created**, empty |
| Production R2 backup bucket | **Created**, retention rule applied |
| Production R2 backup-status bucket | **Created** |
| Production Cloudflare Access application/policy | **Created** (owner, Zero Trust dashboard, 2026-10-09) |
| Production Worker config (`wrangler.production.jsonc`) | **Prepared with real TEAM_DOMAIN/POLICY_AUD**, not deployed |
| Production status-worker config | **Prepared**, not deployed |
| Production-specific build script (`build:production-independent`) | **Created** — resolves the environment-value ambiguity flagged in the prior round |
| Production nightly-backup workflow | **Prepared**, gated (`workflow_dispatch` only, no schedule) |
| Production monthly-restore-verify workflow | **Prepared**, gated (`workflow_dispatch` only, no schedule) |
| Production GitHub Actions variables (bucket names) | **Created** (non-secret) |
| Production-scoped R2 API tokens (write/read/status) | **Not created** — dashboard-only, same established pattern as Staging's own setup |
| Production backup encryption passphrase | **Not created** — must be a new, separate secret from Staging's |
| Production Worker/status-worker deployment | **Not done** — deliberately deferred until the remaining secrets (R2 tokens, passphrase) exist, so the backup pipeline can be verified before anything is reachable |

## 2. Resource identifiers (non-secret)

- **Production D1 database**: name `fundraising-os-production-db`, id `a51c6571-ae16-4614-aa9a-08f8e6be3ecd`, region ENAM (same region as Staging's `fundraising-os-staging-db`, id `6c18396c-0a8f-4f2c-ba83-ea809ec10289`, for comparison — the two are completely separate databases).
- **Production backup bucket**: `fundraising-os-production-backups` (created 2026-10-09T20:30:10.381Z; retention lifecycle rule `daily-expiry` on the `daily/` prefix, 90-day expiry, mirroring Staging's own `fundraising-os-staging-backups` bucket exactly).
- **Production backup-status bucket**: `fundraising-os-production-backup-status` (created 2026-10-09T20:30:13.533Z).
- **Prospective Production Worker name**: `fundraising-os-production` (not yet deployed).
- **Prospective Production status-worker name**: `fundraising-os-production-backup-status` (not yet deployed; same name as its own R2 bucket, matching the exact coincidental-but-intentional pattern Staging's own `fundraising-os-backup-status` Worker/bucket pair already uses).
- **Prospective Production URL** (once deployed, default `workers.dev` subdomain, no custom domain): `https://fundraising-os-production.sgoldstein.workers.dev`.
- **GitHub Actions variables created this round** (non-secret, repo-level): `R2_BACKUP_BUCKET_PRODUCTION=fundraising-os-production-backups`, `R2_STATUS_BUCKET_PRODUCTION=fundraising-os-production-backup-status`.

No secret value of any kind is recorded anywhere in this document, any commit, or any terminal output this round.

## 3. Production configuration

`wrangler.production.jsonc` (new, committed this round) — populated from the existing `wrangler.production.example.jsonc` template:

- `name`: `fundraising-os-production`.
- `d1_databases`: bound to the real new database above (`binding: "DB"`).
- `services`: `STATUS_WORKER` bound to `fundraising-os-production-backup-status` (the not-yet-deployed status-worker — this binding will not resolve until that Worker is deployed; deploy it first).
- `vars.TEAM_DOMAIN` / `vars.POLICY_AUD`: **real values**, set by the owner's own Production Access Application (§4) — `fundraising-os.cloudflareaccess.com` / `7cfff2279260cb67e19af8c129b2ba6cdd137ba855ddb638ff316493f8ef14e1`. Neither is secret (Cloudflare treats both as public-ish identifiers, same as Staging's own `vars.POLICY_AUD` already committed in `wrangler.staging.jsonc`) — a forged JWT still cannot pass real signature verification merely by knowing them. Confirmed, as a regression test (`tests/production-wrangler-config.test.mjs`), that these specific values are present, are not the old placeholder strings, and correctly drive `selectAuthProviders()` to exclude the legacy header path.
- `vars.STAGING_OWNER_EMAIL`: set to the real, explicitly authorized value `sgoldstein@nirc.edu` (this app's own defense-in-depth re-check of the JWT's email claim — independent of, and in addition to, the Access policy's own allow-list configured separately in §4).
- `vars.APP_BASE_URL`: predicted default `workers.dev` URL; confirm after first real deploy.
- **No `triggers.crons` block** — the Daily Fundraising Agenda email is deliberately not enabled for Production; that is a separate "activate for daily use" decision, out of this round's scope.
- `observability.enabled: true` — Cloudflare's built-in Workers logs/metrics, zero extra setup, matching Staging.

`status-worker/wrangler.production.jsonc` (new, committed this round) — identical architecture to Staging's own `status-worker/wrangler.jsonc`: `workers_dev: false`, no routes (no public URL exists even once deployed — reachable only via the Worker-to-Worker service binding above), read-only R2 binding to the new status bucket, hourly watchdog cron present in the file (harmless to deploy with, since it only ever reads status objects and would ask GitHub to dispatch the nightly-backup workflow — which does not run automatically yet either, since it has no schedule trigger).

## 4. Cloudflare Access configuration

**Created by the owner, 2026-10-09**, via the Zero Trust dashboard (this session's Cloudflare credentials still have no Access API scope — confirmed again this round, unchanged from before — so this step was necessarily manual, exactly as anticipated).

- **Production hostname**: `fundraising-os-production.sgoldstein.workers.dev` (matches this document's own §2 prediction exactly).
- **Authorized email**: `sgoldstein@nirc.edu` — the sole identity the policy allows, per the owner's own confirmation.
- **Team Domain**: `fundraising-os.cloudflareaccess.com` — the same Zero Trust organization Staging already uses (a separate Application within it, not a separate organization).
- **Application Audience (AUD) tag**: `7cfff2279260cb67e19af8c129b2ba6cdd137ba855ddb638ff316493f8ef14e1` (64-character hex, same shape as Staging's own `POLICY_AUD`).

Both values are now written into `wrangler.production.jsonc` (§3) and independently confirmed correct by `tests/production-wrangler-config.test.mjs` (present, not a placeholder, correct shape, and correctly drives the auth-provider-selection gate).

**The existing Staging Access application/policy was not touched** — this session's only Cloudflare Access-related action was reading the owner-supplied values into the repo; no Access API call of any kind was made (none was available, and none was needed).

**Not yet independently verified**: a real request against the real Production hostname, since nothing is deployed there yet (§9).

## 5. Backup architecture

Mirrors Staging's own, already-proven architecture exactly (see `docs/DEPLOYMENT.md`'s "Automated D1 backup" section for the full design rationale, unchanged here) — full `wrangler d1 export` → gzip → GPG-AES256 symmetric encryption (plaintext shredded immediately) → upload to the dedicated Production backup bucket → atomic `latest/` pointer promotion carrying its own dated-object provenance metadata → additive, best-effort, non-blocking status publish to the separate Production status bucket.

**Isolation from Staging, structural, not just by convention**: separate D1 database id, separate R2 buckets (both), separate GitHub Actions variables (`*_PRODUCTION` suffix), and — once created — separate R2 API tokens and a separate encryption passphrase. Neither new workflow file references any Staging resource name, secret, or variable anywhere.

**Retention**: same 90-day lifecycle rule on the `daily/` prefix of the Production backup bucket (applied this round); `latest/` never expires, matching Staging.

**D1 Time Travel**: Cloudflare's native 30-day point-in-time recovery applies automatically to the new Production D1 the moment it exists — already active, zero additional setup, exactly as it already does for Staging.

## 6. GitHub Actions configuration

Two new workflow files, committed this round, both **deliberately gated**: `workflow_dispatch` only, **no `schedule:` trigger** — they cannot fire automatically under any circumstance until a human explicitly adds a schedule block later, as a separate, deliberate step once launch readiness is confirmed.

- **`.github/workflows/d1-backup-nightly-production.yml`** — structurally identical to `d1-backup-nightly.yml`, pointed at `fundraising-os-production-db` and the Production bucket/secrets.
- **`.github/workflows/d1-restore-verify-monthly-production.yml`** — structurally identical to `d1-restore-verify-monthly.yml`, including every safety property already proven this session against Staging (unique scratch-database naming, `finally`-block cleanup that runs even on failure, never targets `fundraising-os-production-db` or `fundraising-os-staging-db` for restore, read-only R2 credential only).

**New GitHub Actions secrets required before either workflow can succeed** (none created this round — all require Cloudflare dashboard credential creation first, see §9):

| Secret | Purpose | Reused from Staging? |
|---|---|---|
| `CLOUDFLARE_D1_API_TOKEN` | D1 export access | **Yes** — already account-wide (Cloudflare offers no narrower, database-scoped D1 permission; reusing it is not a privilege increase) |
| `CLOUDFLARE_ACCOUNT_ID` | Account identification | **Yes** — already account-wide, not a secret value tied to one database |
| `R2_BACKUP_WRITE_ACCESS_KEY_ID_PRODUCTION` / `..._SECRET_ACCESS_KEY_PRODUCTION` | Writes dated/`latest/` backup objects | **No** — new, scoped to `fundraising-os-production-backups` only |
| `R2_BACKUP_READ_ACCESS_KEY_ID_PRODUCTION` / `..._SECRET_ACCESS_KEY_PRODUCTION` | Restore-verification reads | **No** — new, scoped to `fundraising-os-production-backups` only, read-only |
| `R2_STATUS_WRITE_ACCESS_KEY_ID_PRODUCTION` / `..._SECRET_ACCESS_KEY_PRODUCTION` | Status JSON publish | **No** — new, scoped to `fundraising-os-production-backup-status` only |
| `BACKUP_ENCRYPTION_PASSPHRASE_PRODUCTION` | Backup encryption | **No — must be distinct from Staging's**, so a Staging passphrase leak can never decrypt Production backups |

**GitHub Actions variables already created this round** (non-secret, done by this session directly — no dashboard step needed): `R2_BACKUP_BUCKET_PRODUCTION`, `R2_STATUS_BUCKET_PRODUCTION`.

## 7. Production build configuration (resolved)

**The problem**: before this round, there was no build pipeline that gave an independent Cloudflare Production Worker a `FUNDRAISING_OS_ENVIRONMENT` value distinct from legacy production's own `"production"`. `scripts/build-production.mjs` — the only "production" build script that existed — is documented (`docs/DEPLOYMENT.md`) as feeding exclusively the legacy ChatGPT Sites platform. Reusing it for this independent Worker would have made the two deployments indistinguishable by `lib/environment.ts`'s own `deploymentEnvironment` value, which `authorizeStagingReset()` and other environment-gated logic rely on.

**The fix**:
- `cloudflare-env.d.ts`: `__FUNDRAISING_OS_ENVIRONMENT__`'s type widened to a 4th value, `"production-independent"`.
- `lib/environment.ts`: `deploymentEnvironment`'s type and ternary widened to recognize it.
- `vite.config.ts`: the matching build-time `define` branch added, so `FUNDRAISING_OS_ENVIRONMENT=production-independent` actually produces this value in a real build.
- `lib/data-health/model.ts`: its two independently-duplicated copies of the same union type widened for type correctness (their own `=== "production"` / `=== "staging-independent"` branches are unchanged — "production-independent" currently falls through to the same path legacy "staging" takes there; a Workspace Health *display* refinement to consider later, not a correctness or security issue, called out explicitly in that file's own new comment).
- New `scripts/build-production-independent.mjs` (mirrors `scripts/build-staging.mjs`'s shape exactly) and new `package.json` scripts `build:production-independent` / `deploy:production-independent`.
- `wrangler.production.jsonc`'s own header comment now names the correct build script explicitly, and warns against `build:production` by name.

**Verified, not just written**:
- `pnpm exec tsc --noEmit`: clean across the whole widened type.
- `pnpm test`: 178/178 (176 prior + 2 new files this round: `tests/production-wrangler-config.test.mjs`, 7 cases).
- `pnpm run build:production-independent` was actually run; the resulting `dist/server/index.js` was grepped and confirmed to contain the literal string `"production-independent"`, proving the build-time constant substitution genuinely took effect, not just that the build exited 0.
- `pnpm run build:staging-independent` and `pnpm run build:production` (the legacy one) were both re-run afterward and still succeed unchanged — this was purely additive.
- `authorizeStagingReset()` itself was not modified — it already allowlists exactly `"staging-independent"`, so it was already correctly unreachable under `"production-independent"` without needing a code change there; this round's fix makes that value actually obtainable by a real, correct build, closing the process gap that made the allowlist's safety depend on nobody ever using the wrong build script.

## 8. Security and isolation verification

Performed this round, non-destructively, with evidence:

| Check | Result | Evidence |
|---|---|---|
| Production D1 uses a new database ID | ✅ | `a51c6571-ae16-4614-aa9a-08f8e6be3ecd`, confirmed ≠ Staging's `6c18396c-0a8f-4f2c-ba83-ea809ec10289` via `wrangler d1 list` |
| Production D1 is empty | ✅ | `SELECT COUNT(*) FROM sqlite_master WHERE type='table'` → 1 row, and that one table is `_cf_KV` (D1's own internal system table) — zero application tables, zero data |
| Production Worker config does not bind to Staging D1 | ✅ | `wrangler.production.jsonc`'s only `d1_databases` entry is the new database |
| Separate R2 buckets | ✅ | `wrangler r2 bucket list` shows all 4 buckets (2 Staging, unchanged creation dates; 2 new Production) |
| Staging D1 unchanged | ✅ | Re-queried read-only after all provisioning: `donors=254, giving_activities=5463, pledge_balance_corrections=1` — identical to every count confirmed in prior rounds; `size_after` in the query response byte-identical to earlier rounds' queries |
| Staging R2 buckets untouched | ✅ | `fundraising-os-staging-backups`/`fundraising-os-backup-status` creation timestamps unchanged (2026-08-16/2026-08-17) in the post-provisioning bucket listing |
| Production secrets not exposed | ✅ | No secret value was ever requested, printed, or committed — only non-secret bucket-name variables were set, and only via the GitHub API's variables endpoint (distinct from its secrets endpoint, which never returns values) |
| No donor records copied | ✅ | Every write this round targeted only the brand-new, empty Production D1 (which received no data-bearing writes of any kind — only the `d1 create` operation itself) or GitHub's own config (workflow files, non-secret variables) |
| No Production application launch | ✅ | No `wrangler deploy` was run against `wrangler.production.jsonc` or `status-worker/wrangler.production.jsonc` this round — confirmed by this round's own command history; no Production URL is reachable |
| Production Access configured independently | ✅ | Owner-created Application/policy, separate from Staging's, confirmed via the real `TEAM_DOMAIN`/`POLICY_AUD` now in `wrangler.production.jsonc` (§4) — not yet exercised against a live deployed request (nothing is deployed yet) |
| Real TEAM_DOMAIN/POLICY_AUD present and not placeholders | ✅ | `tests/production-wrangler-config.test.mjs`: both values present, neither matches the old placeholder pattern, `POLICY_AUD` matches the real 64-hex-character Access AUD shape |
| Hardened authentication correctly engages with the real configured values | ✅ | Same test file: feeding the real parsed `TEAM_DOMAIN`+`POLICY_AUD` into the actual `selectAuthProviders()` function (not a reimplementation) confirms the legacy header provider is excluded — this is exactly the computation `app/chatgpt-auth.ts`'s `getChatGPTUser()` will perform once deployed. Still not verified against a live HTTP request (nothing is deployed). |
| Cannot invoke Staging reset against Production | ✅ **Caveat resolved** | `authorizeStagingReset()` still checks `deploymentEnvironment !== "staging-independent"` → 404 (unchanged, an allowlist of one value). The prior round's caveat — no dedicated build script existed to give Production its own distinguishable `deploymentEnvironment` value — is now resolved: `scripts/build-production-independent.mjs` sets `FUNDRAISING_OS_ENVIRONMENT=production-independent`, a 4th value added to `lib/environment.ts`/`cloudflare-env.d.ts`/`vite.config.ts` this round (confirmed via `tsc --noEmit` clean, full suite 178/178, and a real `pnpm run build:production-independent` run whose output bundle was grepped to confirm the constant was actually baked in). Using `build:production-independent` (not `build:production`) for this Worker is now the documented, correct, named choice — see `wrangler.production.jsonc`'s own header comment. |

## 9. Manual setup remaining (in order)

Steps 1 (Access Application) and 7 (build-script decision) from the prior version of this list are **done** — see §4 and §7. What remains:

1. **Create two R2 API tokens scoped to `fundraising-os-production-backups`** (dashboard → R2 → Manage API Tokens): one Object Read & Write (→ `R2_BACKUP_WRITE_ACCESS_KEY_ID_PRODUCTION`/`..._SECRET_ACCESS_KEY_PRODUCTION`), one Object Read only (→ `R2_BACKUP_READ_ACCESS_KEY_ID_PRODUCTION`/`..._SECRET_ACCESS_KEY_PRODUCTION`).
2. **Create one R2 API token scoped to `fundraising-os-production-backup-status`**, Object Read & Write (→ `R2_STATUS_WRITE_ACCESS_KEY_ID_PRODUCTION`/`..._SECRET_ACCESS_KEY_PRODUCTION`).
3. **Generate a new, separate backup encryption passphrase** (e.g. `openssl rand -base64 48`) → `BACKUP_ENCRYPTION_PASSPHRASE_PRODUCTION`, and store a second durable copy outside GitHub (same requirement as Staging's own passphrase).
4. **Add all 7 secrets to GitHub** (Settings → Secrets and variables → Actions → Secrets) — `CLOUDFLARE_D1_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are already reused as-is (§6); the other 5 are new, from steps 1–3 above.
5. **Deploy the Production status-worker first**, then the main Production Worker:
   ```
   cd status-worker && wrangler deploy --config wrangler.production.jsonc
   cd ..
   pnpm run build:production-independent && pnpm run deploy:production-independent
   ```
   **Not done this round.** Access is now configured (§4), so this is no longer blocked on that — it remains blocked on steps 1–4 above (the Worker would deploy, but its own backup/status plumbing would have no working credentials yet), and is otherwise ready whenever the owner wants to proceed.
6. **Manually dispatch each new workflow once** and confirm success, mirroring the exact verification already performed against Staging (`docs/AI-HANDOFF.md`'s "Complete Backup Verification" entry) — before ever adding a `schedule:` trigger to either file.

## 10. Estimated operating costs

Not independently verifiable this round — this session's Cloudflare credentials have no billing/account-limits API access, and billing specifics are account-plan-dependent. Structurally: one additional D1 database, two additional R2 buckets (currently empty, so effectively zero storage cost today), and (once deployed) two additional Workers — all the same kind and rough scale of resource Staging already runs successfully. Recommend the owner do a brief Cloudflare dashboard billing check before ever adding a schedule to either workflow (§9 step 6), rather than relying on an estimate this investigation cannot verify.

## 11. Steps required before donor-data migration

Per `docs/ACCELERATED-PRODUCTION-LAUNCH.md`'s own Stage C/D — unchanged by this round, and explicitly **not** performed here: fresh re-audit of the Staging dataset at the time of migration, owner's explicit approval of the exact dataset, a rehearsed restore (into a throwaway scratch database first, never directly into this new Production D1), then the real, approved copy into this Production database using the already-proven backup/restore pipeline. None of this infrastructure round changes that plan; it only makes the destination (this Production D1) exist.

## 12. Rollback or cleanup procedure

Everything created this round is empty, inert, and cheap to remove if needed:

- **Production D1**: `wrangler d1 delete fundraising-os-production-db -y` — contains no data, safe to delete and recreate.
- **Production R2 buckets**: `wrangler r2 bucket delete fundraising-os-production-backups` / `fundraising-os-production-backup-status` — both currently empty (no backup has ever been written to either).
- **GitHub variables**: delete `R2_BACKUP_BUCKET_PRODUCTION`/`R2_STATUS_BUCKET_PRODUCTION` via Settings → Secrets and variables → Actions → Variables.
- **Config/workflow files**: revert the 4 new files in this round's commit; no other file was changed.
- None of the above affects Staging in any way — every Staging resource (D1, both buckets, both workflows, both secrets sets) is referenced by none of this round's new files.

## 13. Outstanding risks

- **Cloudflare Access configuration has not been exercised against a live request** — real values are in place and unit-tested (§3/§4/§8), but nothing has actually been deployed yet, so no real JWT has ever been verified end to end against this specific Access Application. First real confirmation happens at deploy time (§9 step 5).
- **R2 credentials and the encryption passphrase do not exist yet** (§9 steps 1–4) — the backup/restore-verify workflows will fail cleanly (not dangerously) if dispatched before these exist.
- **Backup/restore pipeline for Production is entirely unexercised** — the workflows are prepared and gated but have never actually run. Once §9's secrets are in place, dispatch both once manually and verify, exactly as this session already did for Staging, before ever adding a schedule.
- **Operating cost is not independently confirmed** (§10) — low risk given the resource shapes involved, but not verified.
- **The build-script resolution itself has not been exercised via a real deploy** — `build:production-independent` was run and its output bundle confirmed to contain the right constant, but the resulting bundle has not yet been deployed and probed live.

No Production deployment, no Production infrastructure beyond what's listed above, no donor data copied, no Staging modification, and no merge to `main` occurred this round. Stopping here for independent review.
