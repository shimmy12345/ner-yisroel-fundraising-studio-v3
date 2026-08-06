# Fundraising OS — Deployment

This document describes how Fundraising OS is actually deployed today, across
its two genuinely different environments. Read
[`FUNDRAISING_OS_PRINCIPLES.md`](./FUNDRAISING_OS_PRINCIPLES.md) first — it
governs every decision here.

## Architecture overview

There are **two independent deployment paths**, not one system with two
environments:

1. **Legacy ChatGPT Sites** (staging + production) — a private, OpenAI-hosted
   platform. Its source of truth is a separate private Sites source
   repository, not this repository's `origin` remote. It builds and deploys
   itself; nothing in this repo's `package.json` scripts drives it directly.
   Requests arrive through a ChatGPT Sites gateway that authenticates the
   user and forwards identity via the `oai-authenticated-user-email` header.
2. **Independent Cloudflare staging** — a Worker and D1 database created and
   deployed directly from this repository with `wrangler`, fronted by
   Cloudflare Access instead of the ChatGPT Sites gateway. This is the only
   environment this repository can deploy on its own.

There is currently **no independent production Worker**. `wrangler.production.example.jsonc`
is a non-functional template for if one is ever built — see its header
comment before touching it.

## Legacy ChatGPT Sites vs. independent Cloudflare staging

| | Legacy ChatGPT Sites (staging/production) | Independent Cloudflare staging |
|---|---|---|
| `deploymentEnvironment` value | `"staging"` / `"production"` | `"staging-independent"` |
| Deployed by | Private Sites source repository | This repository, via `wrangler` |
| Identity source | `oai-authenticated-user-email` header (ChatGPT Sites gateway) | Cloudflare Access JWT (`cf-access-jwt-assertion`), independently verified |
| D1 schema | Staging: legacy, migration-replay history. Production: verified 0019+ baseline | Verified 0019+ baseline (bootstrapped the same way as production) |
| Business-data expectation | Real donor data | Expected to stay empty; has a one-click reset |
| Workspace Health "Business data" wording | "Schema only" / "Live records present" | "Empty" / "Contains N row(s)" — plus a separate "Account setup" line |

`app/chatgpt-auth.ts`'s `getChatGPTUser()` checks the ChatGPT Sites header
first (unchanged, original precedence), then falls back to the Cloudflare
Access provider only when that header is absent — the two paths cannot both
be active for the same request. See `lib/auth/provider.ts`.

## Worker and D1 names

- **Independent staging Worker**: `fundraising-os-staging`
- **Independent staging D1**: `fundraising-os-staging-db`
- **Legacy ChatGPT Sites staging/production**: managed by the Sites
  platform under project IDs recorded in `.openai/hosting.json` (staging)
  and `.openai/hosting.production.json` (production). Do not duplicate
  those IDs elsewhere — read them from those files if you need them.

## Cloudflare Access and JWT verification

The independent staging Worker never trusts a client-supplied identity
header. Instead:

1. Cloudflare Access sits in front of the Worker's route/`workers.dev` URL,
   restricted by policy to the configured owner's email.
2. On a request, `app/auth/cloudflare-access-provider.ts` reads the
   `cf-access-jwt-assertion` header and calls
   `lib/auth/cloudflare-access.ts`'s `verifyAccessToken()`, which:
   - fetches the team's JWKS (`https://<TEAM_DOMAIN>/cdn-cgi/access/certs`),
   - verifies the JWT's signature, issuer (`https://<TEAM_DOMAIN>`), audience
     (`POLICY_AUD`), and expiry via `jose`,
   - rejects missing, malformed, expired, wrong-issuer, or wrong-audience
     tokens uniformly (all collapse to "unauthenticated" — no partial trust),
   - derives the email **only from the verified payload**, then checks it
     against `STAGING_OWNER_EMAIL` as a second, independent check (defense
     in depth on top of the Access policy itself).
3. `lib/operations/staging-reset.ts`'s `authorizeStagingReset()` reuses this
   same identity plus an explicit `deploymentEnvironment === "staging-independent"`
   check, returning `404` (not 401/403) everywhere else — the reset endpoint
   is invisible, not merely unauthorized, outside independent staging.

Regression tests: `tests/cloudflare-access-auth.test.mjs` (10 cases against
locally-generated keys, no network calls) and `tests/staging-reset.test.mjs`
(gating cases).

## Required variables

Set as `vars` in `wrangler.staging.jsonc` (not secrets — none of these are
credentials, but treat the owner's email as identifying information and
avoid pasting it elsewhere unnecessarily):

| Variable | Purpose | Where it comes from |
|---|---|---|
| `TEAM_DOMAIN` | Cloudflare Access team domain | Zero Trust dashboard |
| `POLICY_AUD` | Audience tag of the Access Application protecting this Worker | Access dashboard, after creating the Access Application |
| `STAGING_OWNER_EMAIL` | The sole email allowed to authenticate | Set by whoever owns this environment |

The D1 binding (`DB` → `fundraising-os-staging-db`) and `ASSETS` binding are
also declared in `wrangler.staging.jsonc`. The `IMAGES` binding is
intentionally omitted — Cloudflare Images is not required to run the app;
`worker/index.ts` falls back to serving images unoptimized when it's absent.

## Build and deployment commands

```bash
# Independent staging
pnpm run build:staging-independent
pnpm exec wrangler deploy --config wrangler.staging.jsonc
# equivalently: pnpm run deploy:staging-independent

# Legacy ChatGPT Sites (build only — the Sites platform handles the deploy)
pnpm build               # staging
pnpm build:production    # production
```

**Always pass `--config wrangler.staging.jsonc` explicitly.** There is no
root `wrangler.jsonc` in this repository on purpose — creating one would
become the implicit default for `wrangler deploy` / `vinext deploy` and
could silently target the wrong environment. Do not add one.

## Migration procedure

- Legacy ChatGPT Sites staging replays nothing: its schema is inspected
  directly (`lib/data-health/read.ts`), and `drizzle/`'s migration files are
  historical record only.
- Production and independent staging both start from
  `production-baseline/drizzle/0000_production_baseline_0019.sql` — a single
  file, safe only on a brand-new, empty D1 database.
- New migrations beyond 0019 (e.g. `drizzle/0020_financial_date_only.sql`)
  are applied individually to already-bootstrapped clean-baseline databases:

  ```bash
  pnpm exec wrangler d1 execute fundraising-os-staging-db --remote \
    --file=drizzle/0020_financial_date_only.sql
  ```

  Before applying any migration to a live database: read it in full, run
  read-only `SELECT COUNT(*)` checks on every table it touches, and stop if
  any are non-empty and the migration wasn't written to handle that safely.
  After applying: re-run the same counts and confirm `PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length`
  in `lib/data-health/production-baseline.ts` matches the number of files in
  `production-baseline/schema-manifest.json`'s `sourceMigrations` — update
  it and add a regression test (see `tests/production-baseline.test.mjs`)
  if it doesn't. A schema-changing migration also requires regenerating the
  baseline artifact (`pnpm db:baseline:generate && pnpm db:baseline:rehearse`)
  before it's applied anywhere live.

## Backup procedure

- `pnpm db:baseline:generate` / `pnpm db:baseline:rehearse` — regenerate and
  rehearse the packaged clean-baseline artifact (schema only, no data).
- `/api/import/backup` — authenticated, full live workspace backup
  (encrypted; see `lib/operations/schema-backup.ts` and
  `tests/production-backup-readiness.test.mjs`).
- `/api/operations/schema-backup` — schema-only backup, gated by
  `BUSINESS_DATA_COUNT_SQL`: it refuses to run if any business data exists,
  to prevent a schema-only export from being mistaken for a full backup.

## Rollback procedure

- **Worker code**: `wrangler rollback` (or `wrangler deployments list` /
  `wrangler versions deploy` to pin an older version) against
  `wrangler.staging.jsonc` — Cloudflare retains recent Worker versions.
- **D1 data**: D1's built-in Time Travel (`wrangler d1 time-travel`) can
  restore the database to a prior point-in-time bookmark. `scripts/rehearse-production-restore.mjs`
  exercises the schema-only restore path end-to-end against a local SQLite
  copy before trusting it against a live database.
- Never roll back Worker code and D1 data independently without checking
  they're compatible — a rolled-back Worker expecting a newer schema (or
  vice versa) will misbehave silently rather than erroring.

## Staging reset procedure

Available only on independent staging, under **Settings → Developer**
(`app/settings/StagingResetPanel.tsx`), visible only when
`deploymentEnvironment === "staging-independent"`. Deletes every row in
every table in `FUNDRAISING_DATA_TABLES` plus `onboarding_preferences`
(demo/import-mode state), in a dependency-safe order, inside a single
`env.DB.batch()`. Preserves `production_schema_baseline`, all schema and
migrations, and the owner's `users` row. Requires typing the exact
confirmation phrase (`STAGING_RESET_CONFIRMATION` in
`lib/operations/staging-reset.ts`), checked server-side independent of the
UI. See `tests/staging-reset.test.mjs` for the full proof (baseline intact,
account intact, all fundraising tables empty, no orphaned foreign keys).

This is irreversible — there is no soft-delete or retained audit trail for
the deleted rows. Appropriate for a throwaway staging environment only.

## Disaster recovery

For independent staging, in order of preference:

1. **Bad data only, schema fine**: run the staging reset procedure above.
2. **Bad schema or corrupted state, D1 database still exists**: use D1 Time
   Travel to restore to a known-good bookmark, then re-verify via
   Workspace Health (Baseline should read "Verified").
3. **D1 database itself is gone or unrecoverable**: recreate it
   (`wrangler d1 create fundraising-os-staging-db`), re-apply
   `production-baseline/drizzle/0000_production_baseline_0019.sql` and any
   migrations beyond it in order, update the `database_id` in
   `wrangler.staging.jsonc`, and redeploy. This is exactly the sequence
   this environment was originally created with.
4. **Worker itself is gone or misconfigured**: redeploy from this repo with
   `wrangler deploy --config wrangler.staging.jsonc` — the Worker has no
   state of its own outside the D1 binding.

Legacy ChatGPT Sites staging/production disaster recovery is out of scope
for this repository — it is owned by the private Sites source repository
and platform.

## Owner access verification

- Confirm the active Cloudflare account: `wrangler whoami` — check the
  account name/ID matches the one that owns `fundraising-os-staging-db`.
- Confirm Access is actually enforcing: an anonymous request to the Worker
  URL (or any of its routes, including `/api/operations/staging-reset`)
  must return `302` to `https://<TEAM_DOMAIN>/cdn-cgi/access/login/...`, not
  `200` or app content. If it doesn't, Access is misconfigured or disabled
  — treat the environment as unprotected until fixed.
- Confirm the owner can actually authenticate: complete the Access login
  flow as the configured `STAGING_OWNER_EMAIL` and load `/settings` —
  Workspace Health should show `Environment: Independent Staging`,
  `Baseline: Verified`, and an `Account setup` line reflecting exactly one
  owner.
- A non-owner email presented with a technically valid Access session
  should still be rejected by the app's own JWT-derived email check, not
  just by the Access policy — this is what
  `tests/cloudflare-access-auth.test.mjs`'s "owner restriction" cases prove
  at the unit level; verify it live at least once after any Access
  configuration change.

## Explicit warnings — do not mix up staging and production

- **`wrangler.production.example.jsonc` deploys nothing.** It is a template
  with placeholder values. Never run `wrangler deploy` with it.
- **Never create a root `wrangler.jsonc`.** Always deploy with
  `--config wrangler.staging.jsonc` explicitly named.
- **Pushing to this repository's `origin` does not deploy legacy ChatGPT
  Sites staging or production.** Those are deployed exclusively through the
  private Sites source repository. Do not assume a merge here has any live
  effect there.
- **The independent staging D1 (`fundraising-os-staging-db`) is a
  completely separate database from anything legacy ChatGPT Sites uses.**
  Migrations, the reset routine, and Time Travel restores here never touch
  real donor data.
- **Do not commit real values into `wrangler.production.example.jsonc`.**
  If an independent production Worker is ever built, its real config
  belongs in a new, separate `wrangler.production.jsonc` (gitignored or
  reviewed with the same care as any other credential-adjacent file),
  copied from the example and filled in deliberately — never by editing
  the example in place.
- **Production deployment always requires separate explicit approval**, per
  `FUNDRAISING_OS_PRINCIPLES.md` — this applies to any future independent
  production Worker exactly as it applies to legacy ChatGPT Sites
  production today.
