# Fundraising OS — Independent Production Infrastructure Setup

**Date:** 2026-10-09
**Status:** Infrastructure provisioning only. No application deployed. No donor data copied or migrated. No Production URL is live or operational. This is not Production launch — see `docs/ACCELERATED-PRODUCTION-LAUNCH.md` for the full launch plan and `docs/AI-HANDOFF.md` for this round's verification record.

This document is the authoritative inventory of the independent Cloudflare Production environment created this round: exactly what exists, what doesn't yet, and the precise manual steps remaining.

---

## 1. Resources created

| Resource | Status |
|---|---|
| Production D1 database | **Created**, empty |
| Production R2 backup bucket | **Created**, retention rule applied |
| Production R2 backup-status bucket | **Created** |
| Production Worker config (`wrangler.production.jsonc`) | **Prepared**, not deployed |
| Production status-worker config | **Prepared**, not deployed |
| Production nightly-backup workflow | **Prepared**, gated (`workflow_dispatch` only, no schedule) |
| Production monthly-restore-verify workflow | **Prepared**, gated (`workflow_dispatch` only, no schedule) |
| Production GitHub Actions variables (bucket names) | **Created** (non-secret) |
| Production Cloudflare Access application/policy | **Not created** — requires manual Zero Trust dashboard access this session's Cloudflare credentials do not have API scope for |
| Production-scoped R2 API tokens (write/read/status) | **Not created** — dashboard-only, same established pattern as Staging's own setup |
| Production backup encryption passphrase | **Not created** — must be a new, separate secret from Staging's |
| Production Worker/status-worker deployment | **Not done** — deliberately deferred until Access is configured, so nothing is ever exposed even briefly without it |

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
- `vars.TEAM_DOMAIN` / `vars.POLICY_AUD`: **deliberate placeholder strings** (`REPLACE_WITH_REAL_TEAM_DOMAIN_AFTER_ACCESS_SETUP` / `REPLACE_WITH_REAL_POLICY_AUD_AFTER_ACCESS_SETUP`), per this round's explicit security requirement that a Production environment missing either value must never be considered secure or ready. **`wrangler deploy --config wrangler.production.jsonc` must not be run until both are replaced with real values from §4 below.**
- `vars.STAGING_OWNER_EMAIL`: set to the real, explicitly authorized value `sgoldstein@nirc.edu` (this app's own defense-in-depth re-check of the JWT's email claim — independent of, and in addition to, the Access policy's own allow-list configured separately in §4).
- `vars.APP_BASE_URL`: predicted default `workers.dev` URL; confirm after first real deploy.
- **No `triggers.crons` block** — the Daily Fundraising Agenda email is deliberately not enabled for Production; that is a separate "activate for daily use" decision, out of this round's scope.
- `observability.enabled: true` — Cloudflare's built-in Workers logs/metrics, zero extra setup, matching Staging.

`status-worker/wrangler.production.jsonc` (new, committed this round) — identical architecture to Staging's own `status-worker/wrangler.jsonc`: `workers_dev: false`, no routes (no public URL exists even once deployed — reachable only via the Worker-to-Worker service binding above), read-only R2 binding to the new status bucket, hourly watchdog cron present in the file (harmless to deploy with, since it only ever reads status objects and would ask GitHub to dispatch the nightly-backup workflow — which does not run automatically yet either, since it has no schedule trigger).

## 4. Cloudflare Access configuration

**Not created this round.** This session's Cloudflare credentials are an OAuth session scoped to Workers/D1/R2/Pages (confirmed via `wrangler whoami`) with no Zero Trust/Access API scope — Access applications and policies are not manageable through `wrangler` at all, only through the Cloudflare Zero Trust dashboard or a separately-scoped API token this session does not have. This is exactly the "cannot be safely automated" case this round's instructions anticipated.

**Exact manual steps required** (mirrors the one-time setup already completed once for Staging, per `docs/DEPLOYMENT.md`):

1. Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application** → **Self-hosted**.
2. Application name: e.g. "Fundraising OS Production". Application domain: the Production Worker's `workers.dev` subdomain (`fundraising-os-production.sgoldstein.workers.dev`, once deployed — or the application can be created first and the Worker deployed after, in either order).
3. Add a policy restricting access to exactly: **`sgoldstein@nirc.edu`** (Include rule: Emails → `sgoldstein@nirc.edu`). Do not add any broader rule.
4. Save. Record the **Application Audience (AUD) tag** shown after creation — this is the real `POLICY_AUD` value.
5. The **Team Domain** is the same Zero Trust organization already in use for Staging (`fundraising-os.cloudflareaccess.com`, per `wrangler.staging.jsonc`) — Production can reuse the same Zero Trust organization's team domain; only the Application/policy itself needs to be new and separate. Confirm this is still correct in the dashboard before using it.
6. Replace `wrangler.production.jsonc`'s two placeholder values with the real Team Domain and AUD tag from steps 4–5.
7. **Do not alter the existing Staging Access application or policy** at any point in this process — they are a completely separate Application in the same dashboard.

Until this is done, `wrangler.production.jsonc` deploys nothing usable (the placeholder `TEAM_DOMAIN` causes every JWT verification attempt to fail closed — no one, including the real owner, can authenticate — never an open/bypassed state; see §7 below for why this is safe rather than merely "broken").

## 5. Backup architecture

Mirrors Staging's own, already-proven architecture exactly (see `docs/DEPLOYMENT.md`'s "Automated D1 backup" section for the full design rationale, unchanged here) — full `wrangler d1 export` → gzip → GPG-AES256 symmetric encryption (plaintext shredded immediately) → upload to the dedicated Production backup bucket → atomic `latest/` pointer promotion carrying its own dated-object provenance metadata → additive, best-effort, non-blocking status publish to the separate Production status bucket.

**Isolation from Staging, structural, not just by convention**: separate D1 database id, separate R2 buckets (both), separate GitHub Actions variables (`*_PRODUCTION` suffix), and — once created — separate R2 API tokens and a separate encryption passphrase. Neither new workflow file references any Staging resource name, secret, or variable anywhere.

**Retention**: same 90-day lifecycle rule on the `daily/` prefix of the Production backup bucket (applied this round); `latest/` never expires, matching Staging.

**D1 Time Travel**: Cloudflare's native 30-day point-in-time recovery applies automatically to the new Production D1 the moment it exists — already active, zero additional setup, exactly as it already does for Staging.

## 6. GitHub Actions configuration

Two new workflow files, committed this round, both **deliberately gated**: `workflow_dispatch` only, **no `schedule:` trigger** — they cannot fire automatically under any circumstance until a human explicitly adds a schedule block later, as a separate, deliberate step once launch readiness is confirmed.

- **`.github/workflows/d1-backup-nightly-production.yml`** — structurally identical to `d1-backup-nightly.yml`, pointed at `fundraising-os-production-db` and the Production bucket/secrets.
- **`.github/workflows/d1-restore-verify-monthly-production.yml`** — structurally identical to `d1-restore-verify-monthly.yml`, including every safety property already proven this session against Staging (unique scratch-database naming, `finally`-block cleanup that runs even on failure, never targets `fundraising-os-production-db` or `fundraising-os-staging-db` for restore, read-only R2 credential only).

**New GitHub Actions secrets required before either workflow can succeed** (none created this round — all require Cloudflare dashboard credential creation first, see §8):

| Secret | Purpose | Reused from Staging? |
|---|---|---|
| `CLOUDFLARE_D1_API_TOKEN` | D1 export access | **Yes** — already account-wide (Cloudflare offers no narrower, database-scoped D1 permission; reusing it is not a privilege increase) |
| `CLOUDFLARE_ACCOUNT_ID` | Account identification | **Yes** — already account-wide, not a secret value tied to one database |
| `R2_BACKUP_WRITE_ACCESS_KEY_ID_PRODUCTION` / `..._SECRET_ACCESS_KEY_PRODUCTION` | Writes dated/`latest/` backup objects | **No** — new, scoped to `fundraising-os-production-backups` only |
| `R2_BACKUP_READ_ACCESS_KEY_ID_PRODUCTION` / `..._SECRET_ACCESS_KEY_PRODUCTION` | Restore-verification reads | **No** — new, scoped to `fundraising-os-production-backups` only, read-only |
| `R2_STATUS_WRITE_ACCESS_KEY_ID_PRODUCTION` / `..._SECRET_ACCESS_KEY_PRODUCTION` | Status JSON publish | **No** — new, scoped to `fundraising-os-production-backup-status` only |
| `BACKUP_ENCRYPTION_PASSPHRASE_PRODUCTION` | Backup encryption | **No — must be distinct from Staging's**, so a Staging passphrase leak can never decrypt Production backups |

**GitHub Actions variables already created this round** (non-secret, done by this session directly — no dashboard step needed): `R2_BACKUP_BUCKET_PRODUCTION`, `R2_STATUS_BUCKET_PRODUCTION`.

## 7. Security and isolation verification

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
| Production Access configured independently | **Not yet performed** | Requires the manual dashboard steps in §4 — cannot be verified until those are complete |
| Hardened authentication active in Production once deployed | **Verified by code, not yet by a live request** | `lib/auth/provider-selection.ts` (commit `f1137eb`) gates on `env.TEAM_DOMAIN`/`env.POLICY_AUD` presence, not on any environment name — this is unconditionally the same code path Production will run once deployed; its 14 regression tests (all passing) already exercise this exact logic with real signed JWTs. Cannot be verified against a live Production request until the Worker is actually deployed with real Access values, which has not happened. |
| Cannot invoke Staging reset against Production | **Verified by code, with one documented process caveat** | `authorizeStagingReset()` (`lib/operations/staging-reset.ts`) checks `deploymentEnvironment !== "staging-independent"` → 404, an allowlist of exactly one value, not a denylist — so it is unreachable under any `deploymentEnvironment` value Production could plausibly resolve to. **Caveat**: there is currently no dedicated build script that sets `FUNDRAISING_OS_ENVIRONMENT` to a Production-specific value distinct from legacy production's own `"production"` value (`scripts/build-production.mjs` is documented as feeding only the legacy ChatGPT Sites platform) — at actual deploy time (Stage E), the build script used must be deliberately chosen to match `wrangler.production.jsonc`'s bindings; using the wrong build script (e.g. accidentally reusing `build:staging-independent`) together with the Production wrangler config would be a process error that could make this endpoint reachable against Production's real `env.DB` binding. This is a process-discipline risk for deploy time, not a code defect — flagged explicitly rather than glossed over. |

## 8. Manual setup remaining (in order)

1. **Create the Production Cloudflare Access Application + policy** (§4) — dashboard only, ~10–15 minutes, the owner has done this exact process once already for Staging.
2. **Create a Cloudflare API token reuse decision**: none needed — `CLOUDFLARE_D1_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are reused as-is (§6).
3. **Create two R2 API tokens scoped to `fundraising-os-production-backups`** (dashboard → R2 → Manage API Tokens): one Object Read & Write (→ `R2_BACKUP_WRITE_ACCESS_KEY_ID_PRODUCTION`/`..._SECRET_ACCESS_KEY_PRODUCTION`), one Object Read only (→ `R2_BACKUP_READ_ACCESS_KEY_ID_PRODUCTION`/`..._SECRET_ACCESS_KEY_PRODUCTION`).
4. **Create one R2 API token scoped to `fundraising-os-production-backup-status`**, Object Read & Write (→ `R2_STATUS_WRITE_ACCESS_KEY_ID_PRODUCTION`/`..._SECRET_ACCESS_KEY_PRODUCTION`).
5. **Generate a new, separate backup encryption passphrase** (e.g. `openssl rand -base64 48`) → `BACKUP_ENCRYPTION_PASSPHRASE_PRODUCTION`, and store a second durable copy outside GitHub (same requirement as Staging's own passphrase).
6. **Add all 7 secrets above to GitHub** (Settings → Secrets and variables → Actions → Secrets).
7. **Replace `wrangler.production.jsonc`'s two placeholders** with the real `TEAM_DOMAIN`/`POLICY_AUD` from step 1.
8. **Deploy the Production status-worker first**, then the main Production Worker (`cd status-worker && wrangler deploy --config wrangler.production.jsonc`, then `pnpm run build:production-independent` [does not exist yet — see the open decision below] `&& wrangler deploy --config wrangler.production.jsonc`) — **not done this round, and not recommended until step 1 is complete**, so the Worker is never reachable even briefly without real Access protection.
9. **Open decision, not yet resolved**: there is no dedicated build script producing a Production-specific `FUNDRAISING_OS_ENVIRONMENT` value distinct from legacy production's own `"production"` (see §7's caveat). Before step 8's Worker deploy, decide and document which build script to use — reusing `scripts/build-production.mjs` as-is, or adding a new one — this is an application-code-adjacent decision explicitly deferred past this infrastructure-only round.
10. **Manually dispatch each new workflow once** and confirm success, mirroring the exact verification this round already performed against Staging (`docs/AI-HANDOFF.md`'s "Complete Backup Verification" entry) — before ever adding a `schedule:` trigger to either file.

## 9. Estimated operating costs

Not independently verifiable this round — this session's Cloudflare credentials have no billing/account-limits API access, and billing specifics are account-plan-dependent. Structurally: one additional D1 database, two additional R2 buckets (currently empty, so effectively zero storage cost today), and (once deployed) two additional Workers — all the same kind and rough scale of resource Staging already runs successfully. Recommend the owner do a brief Cloudflare dashboard billing check before enabling scheduled backups (step 10 above), rather than relying on an estimate this investigation cannot verify.

## 10. Steps required before donor-data migration

Per `docs/ACCELERATED-PRODUCTION-LAUNCH.md`'s own Stage C/D — unchanged by this round, and explicitly **not** performed here: fresh re-audit of the Staging dataset at the time of migration, owner's explicit approval of the exact dataset, a rehearsed restore (into a throwaway scratch database first, never directly into this new Production D1), then the real, approved copy into this Production database using the already-proven backup/restore pipeline. None of this infrastructure round changes that plan; it only makes the destination (this Production D1) exist.

## 11. Rollback or cleanup procedure

Everything created this round is empty, inert, and cheap to remove if needed:

- **Production D1**: `wrangler d1 delete fundraising-os-production-db -y` — contains no data, safe to delete and recreate.
- **Production R2 buckets**: `wrangler r2 bucket delete fundraising-os-production-backups` / `fundraising-os-production-backup-status` — both currently empty (no backup has ever been written to either).
- **GitHub variables**: delete `R2_BACKUP_BUCKET_PRODUCTION`/`R2_STATUS_BUCKET_PRODUCTION` via Settings → Secrets and variables → Actions → Variables.
- **Config/workflow files**: revert the 4 new files in this round's commit; no other file was changed.
- None of the above affects Staging in any way — every Staging resource (D1, both buckets, both workflows, both secrets sets) is referenced by none of this round's new files.

## 12. Outstanding risks

- **Cloudflare Access is not configured yet** — the single largest remaining gap; until §4 is complete, Production cannot be deployed at all without failing closed (safe, but non-functional).
- **No build-script decision made yet** (§7's caveat, §8 step 9) — resolve before the first real Worker deploy, not after.
- **Backup/restore pipeline for Production is entirely unexercised** — the workflows are prepared and gated but have never actually run (correctly so — they'd fail cleanly today since the required secrets don't exist yet). Once §8's secrets are in place, dispatch both once manually and verify, exactly as this session already did for Staging, before ever adding a schedule.
- **Operating cost is not independently confirmed** (§9) — low risk given the resource shapes involved, but not verified.

No Production deployment, no Production infrastructure beyond what's listed above, no donor data copied, no Staging modification, and no merge to `main` occurred this round. Stopping here for independent review.
