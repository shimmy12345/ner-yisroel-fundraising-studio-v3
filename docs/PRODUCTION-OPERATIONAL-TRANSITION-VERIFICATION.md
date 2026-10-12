# Production Operational Transition — Verification Report

**Date:** 2026-10-12 (two rounds: initial transition, then this addendum — "Complete Production Automation and Backup Transition")
**Status:** Production backup/restore-verification schedules **ENABLED, CONFIGURED AWAITING FIRST SCHEDULED RUN** (independently verified restorable today by this round's own manual check). Daily email and Claude's morning check **STILL BLOCKED on owner-only actions** (unchanged root cause from the prior round, re-confirmed, not assumed). Staging read-only protection **CONFIRMED STILL DEPLOYED AND EFFECTIVE**. Production **CONFIRMED INTACT**.

---

## 0. Re-verification of prior findings (nothing assumed carried over)

Per the explicit instruction not to assume previous findings are still current, every material fact from the prior round (`docs/PRODUCTION-OPERATIONAL-TRANSITION-VERIFICATION.md`'s earlier version) was re-checked live today:

| Fact | Prior round | Re-checked today | Changed? |
|---|---|---|---|
| Production secrets | `[]` (none) | `[]` (none) | No |
| Staging secrets | 3 `GMAIL_OAUTH_*` | 3 `GMAIL_OAUTH_*` | No |
| Latest Production nightly backup run | 2026-10-11T03:44:12Z, success | 2026-10-11T03:44:12Z, success (no new run) | No |
| Latest Production restore-verification run | 2026-10-11T12:35:39Z, success | 2026-10-11T12:35:39Z, success (no new run) | No |
| Both Production backup workflows' trigger | `workflow_dispatch` only, no schedule | same, confirmed again before editing | No (until this round's own change, below) |
| `gh` CLI / `GITHUB_TOKEN` / `GH_TOKEN` in this session | absent | absent | No |
| Production D1/Staging D1 identities | `a51c6571-...` / `6c18396c-...` | same, re-confirmed via live `wrangler d1 list` | No |
| Production donor data | 254 donors / 5,463 giving activities | same, re-confirmed live (and again after every deploy this round) | No |

One new, unrelated discovery this round: a separate branch, `feature/r2-production-read-credential-check` (not this branch, not merged anywhere), was found to contain a prior investigation into the one historical restore-verification failure (`run 38109498404`, 2026-10-11T03:47:09Z) — a Production R2 *read* credential (`R2_BACKUP_READ_*_PRODUCTION`) that was broken and has since been recreated, which is why the very next run succeeded. Noted for context only; that branch was not touched or merged by this round.

## 1. Production backups — Step A (current, verified backup)

**GitHub Actions workflow execution remains unavailable from this session** — same root cause as before, re-confirmed: no `gh` CLI installed, no `GITHUB_TOKEN`/`GH_TOKEN` in the environment, and only unauthenticated (read-only) GitHub REST API access was available. **Per the task's own instruction, this phase is stopped rather than worked around**, and exact manual instructions are given below (Section 1a).

**Independent substitute verification performed instead** (does not require GitHub Actions, uses only this session's existing Cloudflare access — the same technique proven throughout the migration/rehearsal rounds):
1. `wrangler d1 export fundraising-os-production-db --remote` — fresh export, 2026-10-12T01:30:01Z.
2. Confirmed the export itself contains the migrated data: 254 `donors` INSERTs, 5,463 `giving_activities` INSERTs (counted directly in the export file, no row content inspected).
3. Restored that export into a brand-new, disposable scratch database (`fundraising-os-backup-verify-20261012b`) using the same dependency-safe restore order and oversized-row chunking technique proven in the migration rehearsal.
4. `PRAGMA foreign_key_check` on the restored scratch database: **0 violations**. Row counts: 254 donors, 5,463 giving activities — exact match.
5. Deleted the scratch database immediately after (confirmed via `wrangler d1 list` — only the original two databases remain). Deleted the local export file (contained real donor data; never committed).

**This proves Production's data is currently backed-up-able and restorable, as of today** — but it is **not** the same thing as "the automated GitHub Actions pipeline has a current, successful run in its own history," which remains the Section 1a gap below.

### 1a. Exact owner instructions (GitHub Actions execution — blocked from this session)

1. Open the repository's **Actions** tab on GitHub.
2. Run **"D1 nightly backup (Production)"** manually (**Run workflow** button) — this uploads a fresh, real backup to the Production R2 bucket via the existing, unmodified pipeline.
3. Wait for it to complete successfully, then run **"D1 monthly restore verification (Production)"** manually the same way — this restores that backup into its own disposable scratch database and verifies it, exactly as this round's own substitute check did.
4. Both can now ALSO be left alone from tomorrow onward — see Section 1b, their schedules are now enabled.

## 1b. Production backups — Step B (automatic schedules) — ENABLED

**Both Production GitHub Actions workflows now carry a `schedule:` trigger**, added as a plain source-file edit (no GitHub API call needed — this is a git commit, not a workflow execution):

| Workflow | Old trigger | New trigger |
|---|---|---|
| `.github/workflows/d1-backup-nightly-production.yml` | `workflow_dispatch` only | `schedule: "15 8 * * *"` (15 min after Staging's own `0 8 * * *`) + `workflow_dispatch` kept |
| `.github/workflows/d1-restore-verify-monthly-production.yml` | `workflow_dispatch` only | `schedule: "20 9 1 * *"` (20 min after Staging's own `0 9 1 * *`, safely after Production's own nightly run) |

**Owner authorization matched exactly:** both files' own already-written header comments explicitly named this exact change ("Add a `schedule:` block... only as part of that later, separately-approved step") — this round's authorization is that approval. **Nothing else in either file was changed**: destination bucket (`vars.R2_BACKUP_BUCKET_PRODUCTION`), retention/promotion logic, and every secret reference remain byte-identical to before.

**Verified safe to run unattended, from source, before enabling:**
- Both files already read `DATABASE_NAME: fundraising-os-production-db` as a hardcoded `env:` value (never Staging's) and every secret/var reference is suffixed `_PRODUCTION`, distinct from Staging's own secret names — confirmed by direct re-reading of both files' full content, not assumed.
- The restore-verification workflow's own header comment (re-confirmed, unchanged by this round) states it restores only into "a brand-new, uniquely-named, THROWAWAY remote D1 database every run... never `fundraising-os-production-db` itself, never `fundraising-os-staging-db`," and reads only from the Production backup bucket via a read-only-scoped credential, "never touches the Staging backup bucket at all."
- **Cannot accidentally target Staging.**

**YAML syntax validated** (via `js-yaml`, since no `yamllint`/Python is available in this session): both files parse cleanly; `on.schedule`/`on.workflow_dispatch` resolve to exactly the intended structure.

**Status: configured, awaiting its first scheduled run** — the next automatic nightly backup fires at 08:15 UTC; the next automatic monthly restore-verification on the 1st of the next month at 09:20 UTC. **Not yet "a scheduled run has completed successfully"** — that evidence does not exist yet and is not claimed here. The owner's manual trigger (Section 1a) remains the fastest way to get a second, GitHub-Actions-native data point before then.

**Backup failure detection/alerting:** the existing mechanism (`lib/backup-alert/run.ts`, already proven on Staging) reads the same R2 status objects these workflows publish and emails the owner on a stale/failed backup — but it runs only from the Worker's own `scheduled()` Cron Trigger, and (like the daily agenda email, Section 2) it sends via the identical `sendGmail()` client requiring the same three Gmail secrets. **Passive visibility** (a human checking Settings → Data Health, which already reads via `STATUS_WORKER`) is available on Production today; **active automated email alerting** is blocked by the exact same single root cause as Section 2 below — not a second, separate gap.

## 2. Daily Fundraising Agenda email — STILL BLOCKED, UNCHANGED (re-confirmed, not re-attempted)

Re-confirmed, exactly as the prior round found: `wrangler secret list --config wrangler.production.jsonc` → `[]`. Production still has none of the three `GMAIL_OAUTH_*` secrets.

**No safe mechanism exists in this session to transfer the existing secret values.** Cloudflare Worker secrets are write-only once set — there is no API or CLI command that reads a secret's value back out, by design, from either this session's tools or Cloudflare's own API. The only ways to "configure the same existing Gmail sending capability" on Production are:
1. The owner runs `wrangler secret put GMAIL_OAUTH_CLIENT_ID --config wrangler.production.jsonc` (and the other two) themselves, typing/pasting the existing values directly into their own terminal — this session never sees them.
2. The owner pastes the values into this chat for this session to apply via `wrangler secret put` — **not recommended, and not requested**: that would expose the credential in the conversation transcript, which both this round's own instruction ("do not reveal secret values... in logs, commits, documentation, or chat") and this session's own operating rules treat as something to avoid, not perform even if offered.

**Stopping this step, per the task's own explicit instruction, rather than attempting either.** No secret was requested from the owner in this conversation.

**Nothing was changed about the email's current operation.** Staging's cron (`wrangler.staging.jsonc`) remains the sole active sender, exactly as before — re-confirmed live: Staging's deployed Worker still shows `schedule: 0 * * * *`. Production's cron remains the prepared-but-commented line from the prior round, untouched this round. **No duplicate or missed email risk was introduced.**

### Exact owner instructions (unchanged from the prior round, restated for completeness)

1. `wrangler secret put GMAIL_OAUTH_CLIENT_ID --config wrangler.production.jsonc` (and `_CLIENT_SECRET`, `_REFRESH_TOKEN`) — the owner's own existing values, or a freshly registered OAuth client if preferred; either way, this session never touches the value.
2. Once set: uncomment the `"triggers"` line in `wrangler.production.jsonc`, **remove** the `"triggers"` block from `wrangler.staging.jsonc`, and deploy both in the same step.
3. Tell this session (or whoever runs the next round) once done — that round should also update `tests/staging-write-guard.test.mjs`'s cron-state snapshot assertions to match the new, final state.

## 3. Claude's morning check — PARTIALLY configured; the remaining step is dashboard-only and was not accessible

**Re-inspected the actual implementation** (unchanged since the prior round): `GET /api/morning-brief` (`app/api/morning-brief/route.ts`), authenticated via a Cloudflare Access Service Token (`CF-Access-Client-Id`/`CF-Access-Client-Secret` headers), returning `loadWorkspaceBrief()`'s same data the Today page/Assistant already show — donor priorities, today's schedule/upcoming activities, recent gifts. **This endpoint has no application-availability, database-connectivity, backup-status, or email-failure fields today** — it is, and has only ever been, a donor-priorities brief. Folding those other signals into "the morning check" (as the task's "Desired morning-check behavior" section describes) would require either extending this endpoint or having the external script call a separate, not-yet-existing status endpoint — **not built this round**, since this repo has no visibility into what the actual external script already does or doesn't check elsewhere, and inventing a combined-status API speculatively risked exactly the "do not create a second morning check" the task warned against. Flagged as an open design question for the owner, not performed.

**What was done, safely, within this session's access:**
- Confirmed (again) that `wrangler.staging.jsonc` has a real `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID` and `wrangler.production.jsonc` did not.
- **Added the identical Client ID** (`983ea5fccaebc48932c5e69df510f74a.access` — the same token already in use, never a new or rotated one) to `wrangler.production.jsonc`, and deployed it. A Client ID alone is not a secret (the Client Secret is, and this Worker never sees it) — this follows the exact precedent already established for this same var on Staging.
- **Confirmed this one change does not by itself weaken or change anything security-relevant**: until Cloudflare Access's own Zero Trust policy for Production's Access Application is separately told to accept this token (see below), a request bearing it is rejected at the Access edge exactly as before — verified there is no regression by re-checking Production's live `GET /` still returns `302` to the Access login page, unchanged.

**What could not be done, and why:** granting Production's Cloudflare Access Application a Service Auth policy for this token is a Zero Trust dashboard action. Checked for an API path this session could use instead: no `wrangler access`/`wrangler zero-trust` subcommand exists in this wrangler version, and this session's Cloudflare API token's own scope list (re-confirmed via `wrangler whoami`) has no Access/Zero-Trust administration scope — only Workers, D1, R2-adjacent, Pages, and a handful of other product scopes. **Confirmed, not merely assumed, by attempting the two most plausible CLI paths and finding neither exists.**

**Confirmed the real scheduler is external, again:** `CronList` (this session's own scheduling tool) returns no jobs, and that tool's jobs are session-only by design (never persist, 7-day max lifetime) — it cannot be the thing that has been sending a request for months. The actual script/scheduler lives entirely outside this repository and outside every tool available in this session.

### Exact owner instructions

1. In the Cloudflare Zero Trust dashboard, add the existing Service Token (Client ID `983ea5fccaebc48932c5e69df510f74a.access`) to a Service Auth policy on **Production's** Access Application (the same token, reused — not a new one; this is the "determine whether an existing authorized service token can be reused safely" question, and the answer is yes, this is the safe way to do it, but the grant itself must happen there).
2. Confirm that Access Application's path scope covers `/api/morning-brief` on the Production hostname (same open item as Staging's own original setup).
3. Update wherever the actual external morning-check script/scheduler lives to call `https://fundraising-os-production.sgoldstein.workers.dev/api/morning-brief` instead of Staging's URL, with the same Client ID/Secret headers it already uses. **This repository has no visibility into where that is.**
4. Separately decide whether backup/health/email-failure status should be folded into this same report (see above) — if yes, say so explicitly in a future round so that work can be scoped rather than guessed at.

## 4. Staging protections — RECONFIRMED STILL DEPLOYED AND EFFECTIVE

Nothing in this round touched `lib/operations/staging-write-guard.ts`, `worker/index.ts`, or `app/layout.tsx`. Re-verified rather than assumed:
- Staging's deployed Worker still shows its cron (`schedule: 0 * * * *`) and the same bindings as before.
- `GET /` on both Staging and Production still returns `302` to the Access login page — the identical edge behavior confirmed in every prior round, re-confirmed again after this round's two new deploys.
- The full test suite (including `tests/staging-write-guard.test.mjs`'s structural + config-state assertions) still passes 180/180 after this round's changes.
- No code path in this round's changes (the two `d1-*-production.yml` schedule edits, the `wrangler.production.jsonc` service-token var, the two comment corrections) touches `worker/index.ts`, the write-guard, or any D1 write path at all.

**Staging cannot accidentally send a second daily email after this round**: its cron is unchanged (still the sole active sender), and Production's remains commented out.

## 5. Tests and deployment evidence

- `pnpm test`: **180/180 passed** (no new test files this round — no application code changed, only two GitHub Actions YAML files and one wrangler config's `vars`/comments).
- `tsc --noEmit`: clean.
- `pnpm run build:production-independent`: succeeds.
- `wrangler deploy --config wrangler.production.jsonc --dry-run`: confirmed exactly the expected bindings (`DB`, `STATUS_WORKER`, `TEAM_DOMAIN`, `POLICY_AUD`, `STAGING_OWNER_EMAIL`, `APP_BASE_URL`, and the new `MORNING_BRIEF_SERVICE_TOKEN_CLIENT_ID`) before the real deploy — no cron, no `STAGING_WRITES_ENABLED`.
- **Deployed:** `fundraising-os-production`, Version ID `240785de-e0de-4886-ab02-1009cd3e95d3` (2026-10-12T01:36:09Z). Staging was not redeployed this round (nothing in its config or code changed).
- Post-deploy: Production's 254 donors / 5,463 giving activities / owner account (`sgoldstein@nirc.edu`) confirmed unchanged; both sites' `GET /` confirmed unchanged (`302`).
- **No database ID swap**: `wrangler.staging.jsonc`'s `database_id` is still `6c18396c-...`, `wrangler.production.jsonc`'s is still `a51c6571-...` — re-confirmed by direct re-read of both files plus a live `wrangler d1 list`.
- **Rollback plan, preserving donor data:** `git revert` this round's commit (two workflow YAML files, one wrangler config file) and redeploy Production from the prior commit. This touches no D1 write path in either database — fully reversible with zero risk to migrated data.

## 6. What this round did NOT do, by design

- Did not set any Gmail secret, anywhere.
- Did not rotate, replace, or recreate any existing credential.
- Did not change backup retention, storage destination, or any secret/variable name in either Production backup workflow.
- Did not create a second scheduled email or a second morning-check mechanism.
- Did not merge to `main`.
- Did not create any fake donor record, test donation, or artificial transaction — the only data-touching actions this round were read-only exports against Production and writes into two disposable scratch databases (both deleted).
- Did not modify or merge the unrelated `feature/r2-production-read-credential-check` branch.

---

No donor data was lost, modified, or recreated. No secret, backup retention policy, or storage destination was changed. No merge to `main` was performed.
