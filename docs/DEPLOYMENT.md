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

**The authoritative full backup is automated** — see "Automated D1 backup
(GitHub Actions + R2)" below. Everything in this section is secondary to
that: useful for a quick look, a pre-rollback safety snapshot, or manual
disaster recovery, but none of it is a substitute for the automated
pipeline.

Application-level exports (inside the running app, for real workspace
data):

- `pnpm db:baseline:generate` / `pnpm db:baseline:rehearse` — regenerate and
  rehearse the packaged clean-baseline artifact (schema only, no data).
- `/api/import/backup` — authenticated, owner-scoped **partial** JSON
  export. An audit (2026-08-16) proved this route silently omitted ~20 of
  33 fundraising tables — including real donor-facing data added after it
  was first written (`yahrtzeits`, `important_dates`, `gift_acknowledgments`,
  `donor_historical_context`). It is not, and has never been, a full
  backup, despite historically being labeled "the D1 backup" in this doc
  and in Settings. It now says so explicitly in its own response payload
  (`coverage: "partial"`, `tablesIncluded`/`tablesExcluded`) — see
  `lib/operations/workspace-backup.ts` for the exact, tested table
  classification and `tests/production-backup-readiness.test.mjs`'s
  `verifyWorkspaceBackupCoverage` check, which fails CI if a new
  fundraising table is ever added to the schema without being classified
  as included or deliberately excluded here. It remains in use as the
  pre-rollback safety snapshot (`app/api/import/rollback`,
  `app/api/import/household-rollback`) and as a quick manual download from
  Settings — just not as anyone's real backup.
- `/api/operations/schema-backup` — schema-only backup, gated by
  `BUSINESS_DATA_COUNT_SQL`: it refuses to run if any business data exists,
  to prevent a schema-only export from being mistaken for a full backup.

For a raw, database-level backup/restore of `fundraising-os-staging-db`
itself (independent of the app), see the runbook below.

## Automated D1 backup (GitHub Actions + R2)

Nightly, fully automated, whole-database backup with monthly automated
restore verification. Implemented 2026-08-16 after an audit found zero
independent backups had ever actually been taken (`workspace_backup_audits`
was empty) and no scheduled backup mechanism existed at all.

**Important distinction to preserve:** `workspace_backup_audits` being
empty means the in-app `/api/import/backup` route had never been invoked —
it does **not** mean no backup of any kind ever existed. A manual
`wrangler d1 export` was taken before the first real-data import:
`staging-before-real-import-2026-08-06.sql`. That file predates this
automated pipeline and lives wherever it was originally saved (outside
this repository, per the "do not commit backups to source control" rule
below) — it was never tracked by `workspace_backup_audits` because that
table only records `/api/import/backup` invocations, not raw `wrangler d1
export` runs.

### Architecture

- **`.github/workflows/d1-backup-nightly.yml`** — every night (`0 8 * * *`
  UTC, plus manual `workflow_dispatch`): `wrangler d1 export --remote` the
  entire `fundraising-os-staging-db` (schema + every row in every table,
  no per-table enumeration to keep in sync), gzip it, GPG-encrypt it
  (AES256, symmetric passphrase), shred the plaintext, and upload the
  ciphertext to a dedicated R2 bucket under `daily/<name>-<timestamp>.sql.gz.gpg`
  and (overwriting each run) `latest/<name>.sql.gz.gpg`.
- **`.github/workflows/d1-restore-verify-monthly.yml`** — on the 1st of
  every month (`0 9 1 * *` UTC, plus manual `workflow_dispatch`): a
  periodic spot-check of the *backup pipeline*, not a per-backup gate — it
  does not run after every nightly backup, and a newer nightly backup
  existing than the one most recently restore-tested is normal and
  expected. First reads `backup-latest-success.json` (best-effort, using
  its own status-bucket credential — see the status-reporting section
  below) to learn the exact, immutable, dated `daily/...` object the backup
  pipeline most recently produced, then downloads and restores *that
  specific object* rather than the mutable `latest/...` pointer — this
  avoids a real race (a concurrent nightly backup run could overwrite
  `latest/...` between reading the metadata and downloading it) and lets
  the published result truthfully name which dated backup was tested. If
  that identity can't be established (unreadable/malformed metadata, or
  the specific object fails to download), falls back to downloading
  `latest/...` directly — still proving the pipeline produces a restorable
  backup, just without a provable dated identity for that run. Either way,
  runs `scripts/verify-remote-restore.mjs`, which restores the downloaded
  object into a brand-new throwaway remote D1 database, runs `PRAGMA
  integrity_check`, `PRAGMA foreign_key_check`, a full schema comparison
  against the verified production baseline, and a per-table row-count
  check across every fundraising table — then always deletes the scratch
  database, including on failure. Any failure in the real download/decrypt/
  restore/verify steps fails the workflow (no `continue-on-error` there);
  only the best-effort identity lookup and the final status-publish step
  may fail without failing the job.
- **Isolation from the deployed app**: `wrangler.staging.jsonc` has no
  `r2_buckets` binding and never should
  (`tests/backup-automation.test.mjs` asserts this). The deployed Worker
  has no credential capable of reading, writing, or deleting anything in
  the backup bucket — a bug or full compromise of the application itself
  cannot reach these backups. All backup credentials live only in GitHub
  Actions secrets. Workspace Health's "Automated backup"/"Monthly restore
  test" status (below) does not change this: it reaches a
  separate, dedicated status-worker over a Worker-to-Worker **service
  binding** (`STATUS_WORKER` — not an R2 binding, and not this bucket),
  which itself only has read access to a different bucket containing
  non-secret status metadata, never backup content.
- **Credential separation**: the nightly job's R2 credential is scoped to
  Object Read & Write on the backup bucket only (it needs to write, and
  reads its own upload back to verify it, but cannot delete anything —
  retention is handled by an R2 lifecycle rule, not by this workflow
  issuing deletes). The monthly verification job uses a **separate**,
  Object Read-only R2 credential — it cannot write or delete backups even
  if compromised. Both are distinct from the Cloudflare API token used for
  D1 operations, which cannot touch R2 at all.
- **Nothing is ever committed to this repository.** Backups exist only in
  R2. `tests/backup-automation.test.mjs` asserts neither workflow contains
  a `git add`/`git commit`/`git push` of any backup artifact.

### One-time setup (manual — dashboard/CLI actions the owner must do)

1. **Enable R2** for this Cloudflare account: dashboard → R2 → follow the
   one-time enablement prompt. This cannot be done via `wrangler` or the
   API from outside the dashboard.
2. **Create the backup bucket** (once R2 is enabled):
   ```
   wrangler r2 bucket create fundraising-os-staging-backups
   ```
3. **Set the retention lifecycle rule** (once, requires the bucket-admin
   level of R2 access — use your own logged-in `wrangler` session, not
   either of the narrow CI credentials below):
   ```
   wrangler r2 bucket lifecycle add fundraising-os-staging-backups daily-expiry daily/ --expire-days 90
   ```
   This expires objects under the `daily/` prefix after 90 days (comfortably
   above the required 60-day minimum); the `latest/` pointer has no
   lifecycle rule and is never auto-deleted.
4. **Create a Cloudflare API token** (dashboard → My Profile → API
   Tokens → Create Token → Custom Token): permission `Account → D1 →
   Edit`, resource scoped to this one account. (Cloudflare does not offer
   a narrower, export-only D1 permission — Edit is the finest grain
   available. This token cannot touch R2, Workers, DNS, or anything
   outside D1.) Save as GitHub secret `CLOUDFLARE_D1_API_TOKEN`.
5. **Create two R2 API tokens** (dashboard → R2 → Manage API Tokens),
   both scoped to the `fundraising-os-staging-backups` bucket only:
   - One with **Object Read & Write** permission → its Access Key ID /
     Secret Access Key become GitHub secrets
     `R2_BACKUP_WRITE_ACCESS_KEY_ID` / `R2_BACKUP_WRITE_SECRET_ACCESS_KEY`.
   - One with **Object Read only** permission → its Access Key ID /
     Secret Access Key become GitHub secrets
     `R2_BACKUP_READ_ACCESS_KEY_ID` / `R2_BACKUP_READ_SECRET_ACCESS_KEY`.
6. **Generate the encryption passphrase** — a long random value, e.g.
   `openssl rand -base64 48`. Save it as GitHub secret
   `BACKUP_ENCRYPTION_PASSPHRASE`, and **also** store a second copy
   somewhere durable outside GitHub (the organization's password manager)
   — this passphrase is required for real disaster recovery, not just the
   automated verification job, and GitHub secrets cannot be read back once
   set.
7. **Add the account ID and bucket name**: GitHub secret
   `CLOUDFLARE_ACCOUNT_ID` (from `wrangler whoami`), and repository
   **variable** (Settings → Secrets and variables → Actions → Variables,
   not Secrets — it isn't sensitive) `R2_BACKUP_BUCKET` =
   `fundraising-os-staging-backups`.
8. **First run**: trigger both workflows manually
   (Actions tab → select workflow → "Run workflow") once all of the above
   is in place, and confirm both succeed, before relying on the schedule
   alone.

### Backup/restore status reporting (Workspace Health)

Workspace Health's "Automated backup" and "Monthly restore test" cards
read from a small, dedicated status pipeline — deliberately separate
infrastructure from the backup pipeline above, so a compromise of one
credential can never touch the other:

- **`status-worker/`** — a minimal, standalone Cloudflare Worker
  (`fundraising-os-backup-status`), deployed and configured independently
  of the main app. Its only binding is **read-only** access (by its own
  code never calling `.put()`/`.delete()`/`.list()` —
  `tests/status-worker.test.mjs` and `tests/backup-automation.test.mjs`
  both fail if that ever changes) to a **separate** R2 bucket
  (`fundraising-os-backup-status`) containing only four small JSON
  objects (`backup-latest-success.json`, `backup-latest-attempt.json`,
  `restore-latest-success.json`, `restore-latest-attempt.json`) — never
  backup content. `restore-latest-success.json` additionally carries
  `verifiedLatestObjectKey` (the `latest/...` pointer name, always known)
  and `verifiedBackupObjectKey`/`verifiedBackupCompletedAt` (the specific
  immutable dated backup actually restored, or explicit JSON `null` on
  both when that identity couldn't be established for that run — see
  `lib/data-health/model.ts`'s `restoreVerificationCheck`, which never
  presents a `null` identity as a known dated backup). It has `workers_dev: false` and no `routes`: there is
  no public URL for it at all. It exposes exactly one route, `GET
  /status`, returning all four objects combined; any other path or method
  is rejected before R2 is ever touched.
- **The main app** (`wrangler.staging.jsonc`) reaches it only via a
  Worker-to-Worker **service binding** (`"services": [{"binding":
  "STATUS_WORKER", "service": "fundraising-os-backup-status"}]`) — not an
  R2 binding, not a credential of any kind. Because there is no public URL
  to call, there is nothing to authenticate: only a Worker explicitly
  wired to this binding at deploy time can reach it.
- **Both GitHub Actions workflows** publish status as an *additive*,
  best-effort final step (`continue-on-error: true`, `if: always()`) using
  their own separately-scoped **write** R2 credential — distinct from both
  the backup bucket's write and read credentials above, so a leaked
  status-write credential can never touch real backup content. A failure
  in this step is logged (`::warning::`) but can never fail the workflow
  or be mistaken for a failed backup/restore — see
  `tests/backup-automation.test.mjs`'s guardrail proving
  `continue-on-error` appears nowhere except this one step in each
  workflow.

Setup (in addition to steps 1-8 above):

9. **Create the status bucket** (the bucket and the status-worker itself
   have already been created/deployed as part of this rollout — this step
   documents how, for future reference or a fresh environment):
   ```
   wrangler r2 bucket create fundraising-os-backup-status
   ```
10. **Deploy the status-worker**:
    ```
    cd status-worker && wrangler deploy
    ```
11. **Create one R2 API token** (dashboard → R2 → Manage API Tokens),
    scoped to the `fundraising-os-backup-status` bucket only, with
    **Object Read & Write** permission. Its Access Key ID / Secret Access
    Key become GitHub secrets `R2_STATUS_WRITE_ACCESS_KEY_ID` /
    `R2_STATUS_WRITE_SECRET_ACCESS_KEY`. (One shared write credential for
    both workflows is intentional — its blast radius is already minimal,
    scoped to four small non-secret JSON objects, and creating a second
    identical-scope token would add setup complexity without a
    meaningfully smaller blast radius.)
12. **Add the bucket name as a repository variable** (Settings → Secrets
    and variables → Actions → Variables, not Secrets): `R2_STATUS_BUCKET`
    = `fundraising-os-backup-status`.
13. **Redeploy the main app** (`pnpm run build:staging-independent &&
    wrangler deploy --config wrangler.staging.jsonc`) so its new
    `STATUS_WORKER` service binding takes effect — already done as part of
    this rollout; needed again only if the status-worker is ever
    recreated under a different name.
14. **First run**: trigger both workflows manually and confirm Workspace
    Health's new cards populate correctly before relying on the schedule
    alone (see "First run" above — this can be done in the same pass).

### Recovering from an automated backup

```bash
# 1. Download the backup you want (latest, or a specific dated one) from R2:
aws s3api get-object \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --bucket fundraising-os-staging-backups \
  --key latest/fundraising-os-staging-db.sql.gz.gpg \
  downloaded.sql.gz.gpg
# (requires AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY set to either R2 credential above)

# 2. Decrypt and decompress:
gpg --decrypt --output downloaded.sql.gz downloaded.sql.gz.gpg   # prompts for the passphrase
gunzip downloaded.sql.gz

# 3. Follow "Restoring from a SQL export file" below -- this file has the
#    same shape and the same "no existing schema" caveat as a plain
#    `wrangler d1 export` output, because that's exactly what it is.
```

For "undo the last N minutes/hours/days" on the live database, D1 Time
Travel (below) is almost always the better tool — it needs no download or
decryption step. Reach for an R2 backup specifically when Time Travel
can't help: the database itself was deleted, you need a point further back
than 30 days, or you need to verify/inspect a point-in-time copy without
touching the live database at all.

## D1 backup and restore runbook (independent staging)

Every command below was run against the actual deployed
`fundraising-os-staging-db` (or its `--help` output) with Wrangler 4.92.0 to
confirm exact syntax and output — nothing here is guessed. Substitute
`fundraising-os-staging-db` for the target database name if this is ever
adapted for another database; never point it at anything legacy-ChatGPT-Sites-managed.

### 1. Creating a backup

Two independent mechanisms exist. Use both for anything that matters.

**a. SQL export (portable file, works with any empty D1 database)**

```bash
wrangler d1 export fundraising-os-staging-db --remote \
  --output=backups/fundraising-os-staging-db-<TIMESTAMP>.sql
```

Replace `<TIMESTAMP>` with a compact UTC ISO-8601 timestamp, e.g.
`20260806T202706Z` — this repository already uses that exact convention for
other backup artifacts (see `Downloads/fundraising-os-backup-*.json` on
past exports). Full recommended filename:
`fundraising-os-staging-db-20260806T202706Z.sql`.

Confirmed expected output (from an actual run):

```
 ⛅️ wrangler 4.92.0
──────────────────────────────────────────────
Resource location: remote

? ⚠️ This process may take some time, during which your D1 database will be unavailable to serve queries.
  Ok to proceed?
🌀 Executing on remote database fundraising-os-staging-db (<database-id>):
├ Creating export
│
You can also download your export from the following URL manually. This link will be valid for one hour: https://<presigned-r2-url>
├ Downloading SQL to <output-path>
│
🌀 Downloaded to <output-path> successfully!
```

Notes verified directly from a real export:
- The confirmation prompt (`Ok to proceed?`) appears interactively; pass
  `-y` / `--skip-confirmation` to skip it in a script. **The database is
  unavailable to serve queries while the export runs** — do not export
  during any window where the app must stay responsive.
- Wrangler also prints a one-hour presigned R2 download URL as an
  alternative to the local file — **never commit that URL anywhere**; it is
  a bearer credential for the raw export while it's valid.
- The exported file opens with `PRAGMA defer_foreign_keys=TRUE;`, then full
  `CREATE TABLE` / `CREATE INDEX` DDL, then `INSERT` statements for every
  row (confirmed: a real export of this database contained `INSERT INTO
  "users" ...`, `INSERT INTO "onboarding_preferences" ...`, and `INSERT
  INTO "production_schema_baseline" ...` rows, plus SQLite's own internal
  `sqlite_stat1` rows).
- The `CREATE TABLE` statements do **not** include `IF NOT EXISTS`
  (confirmed by inspecting the real export) — see the restore warning below
  before ever replaying this file.
- Useful flags confirmed via `--help`: `--no-schema` (data only),
  `--no-data` (schema only), `--table <name>` (repeatable, limit to
  specific tables), `--local` (export the local `wrangler dev` database
  instead of the remote one).

**b. D1 Time Travel bookmark (built-in, no file to manage)**

D1 automatically retains point-in-time recovery for the last 30 days with
no explicit "create backup" step. To record the current bookmark for later
reference:

```bash
wrangler d1 time-travel info fundraising-os-staging-db
```

Confirmed expected output (from an actual run):

```
 ⛅️ wrangler 4.92.0
──────────────────────────────────────────────
Resource location: remote

🚧 Time Traveling...
⚠️ The current bookmark is '<bookmark-id>'
⚡️ To restore to this specific bookmark, run:
 `wrangler d1 time-travel restore fundraising-os-staging-db --bookmark=<bookmark-id>`
```

Record the printed bookmark ID (and the wall-clock time) somewhere durable
before any risky operation — it is the exact restore target if that
operation goes wrong. `--timestamp <unix-or-RFC3339>` retrieves the
bookmark for a specific past moment instead of "now".

**Verifying a backup completed:**
- SQL export: confirm the CLI printed `Downloaded to <path> successfully!`,
  the file exists, is non-empty, and its first line is
  `PRAGMA defer_foreign_keys=TRUE;`. Spot-check row counts by grepping for
  `^INSERT INTO "users"` / your table of interest.
- Time Travel bookmark: confirm the CLI printed a bookmark ID starting with
  a hex/dash pattern like `0000000e-00000000-...` and no error.

### 2. Restoring a backup

**Preferred: D1 Time Travel restore** (no file handling, works for "undo
the last N minutes/hours/days" within the 30-day window):

```bash
wrangler d1 time-travel restore fundraising-os-staging-db --bookmark=<bookmark-id>
```

or, to restore to a specific past moment instead of a recorded bookmark:

```bash
wrangler d1 time-travel restore fundraising-os-staging-db --timestamp=<unix-or-RFC3339>
```

Prerequisites:
- The bookmark or timestamp must be within the last 30 days.
- You must know (or look up via `time-travel info --timestamp=...`) the
  target bookmark before running the restore.

**This is destructive** — it replaces the database's current state
entirely. `time-travel restore` has no separate `-y` confirmation flag
documented in `--help`, so treat every invocation as if it executes
immediately; do not run it against `fundraising-os-staging-db` without
having just confirmed the bookmark is the one you want via `time-travel
info`.

Expected execution time was not empirically measured against a large
database in this session (this environment's database is a few hundred
KB) — do not assume it is instant on a larger dataset; treat it the same
as the export warning above (the database may be briefly unavailable) and
schedule accordingly.

Verifying the restore succeeded:
- Re-run `wrangler d1 execute fundraising-os-staging-db --remote --command
  "SELECT id, schema_hash FROM production_schema_baseline;"` and confirm
  the row matches whatever value was recorded **at the bookmark/timestamp
  you restored to** (e.g. from your own pre-restore note, or a backup
  taken at that time) -- not necessarily today's
  `production-baseline/schema-manifest.json` `schemaHash`. This row is a
  write-once historical stamp, never rewritten when a later migration is
  applied; restoring to a point before a schema-affecting migration will
  correctly reproduce that older value, which legitimately differs from
  today's packaged hash. A mismatch against the bookmark's own value means
  the restore itself is suspect; a mismatch against only today's hash does
  not.
- Load `/settings` as the owner and check Workspace Health's live
  **"Staging ↔ baseline schema"** comparison -- that is the authoritative,
  always-current structural check (it never reads
  `production_schema_baseline`). If restoring to a point at or after the
  most recent schema-affecting migration, `independent-staging-baseline`
  should also read **Verified**; if restoring to an older point on
  purpose, expect it to read **Stale stamp** instead, which reflects the
  baseline's age, not a corrupt or unexpected live schema.
- Spot-check row counts on the tables you expected the restore to affect.

**Alternative: restoring from a SQL export file.** Only viable against a
database with **no existing schema** — the export's `CREATE TABLE`
statements have no `IF NOT EXISTS` (verified above), so replaying an
export against a database that already has these tables fails with
"table already exists" errors. This path is for recreating the database
from scratch (see disaster recovery scenario 3 below), not for undoing
recent changes on an already-populated database — use Time Travel for
that instead:

```bash
wrangler d1 execute fundraising-os-staging-db --remote --file=backups/fundraising-os-staging-db-<TIMESTAMP>.sql
```

Confirmed behavior from real use of `d1 execute --file` against this
database: Wrangler prints
`Note: if the execution fails to complete, your DB will return to its
original state and you can safely retry.` — the whole file is applied as
one atomic operation; a mid-file failure does not leave a half-applied
schema.

### 3. Recovering from a failed import

- If `wrangler d1 execute --remote --file=...` reports an error: per the
  confirmed message above, the database already rolled back to its
  pre-attempt state automatically. Re-run the same command after fixing
  whatever caused the failure (bad SQL, wrong file, schema mismatch) — do
  not assume partial damage occurred.
- If the failure happened inside the app (e.g. an in-app import route) and
  you're unsure of the database's state afterward: check
  `data_imports`/`*_import_changes`/`*_rollback_audits` tables for the
  batch, and prefer the app's own import-undo path (`app/api/import/rollback`,
  `app/api/import/household-rollback`) over manual `DELETE`s — those routes
  are batch-scoped and audited; ad hoc SQL deletes are not.
- If neither applies (e.g. a raw `d1 execute` against unrelated tables
  produced a bad state that already committed successfully): use D1 Time
  Travel to restore to the bookmark recorded immediately before the
  attempt (see §2). This is why recording a bookmark before any risky
  operation is a required step, not an optional one.

### 4. Returning the environment to a known-good state

In order of increasing severity — stop at the first one that applies:

1. **Only test/fundraising data is wrong, schema is fine**: use the
   Independent Staging Reset (Settings → Developer,
   `app/api/operations/staging-reset/route.ts`) — see "Staging reset
   procedure" below. Fastest, and purpose-built for exactly this.
2. **Something changed recently and you have a bookmark**: `wrangler d1
   time-travel restore fundraising-os-staging-db --bookmark=<bookmark-id>`.
3. **No good bookmark, but you have a SQL export from before things went
   wrong, and the current database can be discarded**: `wrangler d1 delete
   fundraising-os-staging-db -y` (destroys the database — the `--database_id`
   in `wrangler.staging.jsonc` becomes invalid), then `wrangler d1 create
   fundraising-os-staging-db`, update `wrangler.staging.jsonc`'s
   `database_id` with the new one, then restore the export (§2's
   file-based path) or re-apply the baseline + migrations from scratch
   (disaster recovery scenario 3).
4. **The Worker itself is misbehaving but the database is fine**: redeploy
   with `wrangler deploy --config wrangler.staging.jsonc` — the Worker
   holds no state of its own.

After any of these, always re-verify per §2's "Verifying the restore
succeeded" steps before considering the environment good again.

### 5. Checklist before importing production-shaped data

Independent staging is expected to stay empty (Workspace Health's
"Business data: Empty"). Before ever importing anything resembling real
production data into it:

- [ ] Confirm this really is `fundraising-os-staging-db`
      (`wrangler d1 info fundraising-os-staging-db`) and not any
      legacy-ChatGPT-Sites-managed database — there is no automated guard
      against pointing an import at the wrong database.
- [ ] Record a Time Travel bookmark first (`wrangler d1 time-travel info
      fundraising-os-staging-db`) so the pre-import state is recoverable.
- [ ] Take a SQL export as a second, portable copy
      (`wrangler d1 export ... --output=backups/fundraising-os-staging-db-<TIMESTAMP>.sql`).
- [ ] Confirm `Business data: Empty` and `Baseline: Verified` on Workspace
      Health immediately before the import, so you know the starting state
      was clean.
- [ ] Confirm you actually intend real/production-shaped data in a
      throwaway independent-staging environment — per
      `FUNDRAISING_OS_PRINCIPLES.md`, sample/test data must never appear in
      live workspace mode, and the inverse (real-shaped data in a
      disposable sandbox) deserves the same scrutiny. Get explicit sign-off
      before proceeding if there's any doubt.
- [ ] After the import, re-run the "Verifying a backup completed" /
      Workspace Health checks above to confirm the environment is in the
      state you expect, not a partially-applied one.

## Rollback procedure

- **Worker code**: `wrangler rollback` (or `wrangler deployments list` /
  `wrangler versions deploy` to pin an older version) against
  `wrangler.staging.jsonc` — Cloudflare retains recent Worker versions.
- **D1 data**: see the "D1 backup and restore runbook" above.
  `scripts/rehearse-production-restore.mjs` exercises the schema-only
  restore path end-to-end against a local SQLite copy before trusting it
  against a live database.
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

For independent staging, see "D1 backup and restore runbook" above,
§4 ("Returning the environment to a known-good state") for the full,
severity-ordered procedure — staging reset, then Time Travel restore, then
recreate-from-export/baseline, then Worker redeploy.

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
