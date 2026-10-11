# Production Backup Watchdog Correction

**Date:** 2026-10-11
**Status:** IMPLEMENTED AND TESTED, NOT DEPLOYED. Code, tests, Wrangler config, and this documentation only -- no Worker, secret, database, or GitHub Actions workflow was deployed, modified, or triggered.

---

## 1. Root cause

`status-worker/src/github-dispatch.ts` hardcoded a single module-level constant:

```ts
const WORKFLOW_FILE = "d1-backup-nightly.yml";
```

used by both `checkActiveBackupRun()` and `dispatchBackupWorkflow()`, regardless of which environment the status-worker Worker was actually deployed as. `d1-backup-nightly.yml` is Independent **Staging's** own nightly backup workflow -- it exports and encrypts Staging's database, not Production's.

The defect: the moment a `GITHUB_BACKUP_DISPATCH_TOKEN` secret ever existed for the **Production** status-worker (`fundraising-os-production-backup-status`), its watchdog would, on detecting a stale backup, dispatch Staging's workflow instead of Production's own dedicated one (`d1-backup-nightly-production.yml`). The practical consequence would have been silent and severe: Production would appear to have an active recovery mechanism (a successful-looking GitHub dispatch, logged as `recovery_dispatch_requested`) while actually backing up Staging a second time and leaving Production's own data with no automated recovery path at all.

**This was not purely theoretical.** Live-state verification during this round (read-only `wrangler secret list`) found:

| Status-worker | Deployed | `GITHUB_BACKUP_DISPATCH_TOKEN` | Cron | Actual risk today |
|---|---|---|---|---|
| Staging (`fundraising-os-backup-status`, `wrangler.jsonc`) | Yes | **Present** (Stage 2, dispatch-capable) | `17 * * * *` | None -- already correctly dispatches `d1-backup-nightly.yml`, its own workflow, because the old hardcoded constant happened to match Staging's filename |
| Production (`fundraising-os-production-backup-status`, `wrangler.production.jsonc`) | Yes (version `932a70e2-...`, live since 2026-10-11T13:56:23Z) | **Absent** (Stage 1, detection-only) | `23 * * * *` | None yet -- the Worker has no secret, so it never reaches the dispatch path regardless of this bug |

So today, the bug has caused no incorrect dispatch -- Staging's own watchdog already resolves correctly (by coincidence, not by design), and Production's watchdog can't call GitHub at all (no secret). The risk was entirely forward-looking: the first time anyone configured `GITHUB_BACKUP_DISPATCH_TOKEN` for the Production Worker -- the natural next step toward enabling real automated recovery -- it would have silently dispatched the wrong workflow with no error of any kind. This correction closes that gap before it can ever be reached, rather than after.

A secondary, unrelated finding corrected in passing: `status-worker/wrangler.production.jsonc`'s own header comment said "NOT YET DEPLOYED," which was stale (the Worker has in fact been live since the first Production deployment round on 2026-10-11). Corrected in the same file for accuracy; this is a comment-only change with no behavioral effect.

---

## 2. Exact code changes

| File | Change |
|---|---|
| `status-worker/src/github-dispatch.ts` | Removed the single hardcoded `WORKFLOW_FILE` constant. Added a closed `WORKFLOW_FILE_ALLOWLIST` map (`"staging-independent" → "d1-backup-nightly.yml"`, `"production-independent" → "d1-backup-nightly-production.yml"`) and an exported pure function `resolveBackupWorkflowFile(environment: string \| undefined)` that looks up the given identity in the allowlist, fails closed (`{ ok: false, reason }`) on anything not an exact allowlisted key, and re-validates the resolved filename against the allowlist's own values before returning it. `checkActiveBackupRun()` and `dispatchBackupWorkflow()` now take the resolved `workflowFile` as an explicit parameter instead of reading the removed module constant. |
| `status-worker/src/index.ts` | Added `BACKUP_WORKFLOW_ENVIRONMENT?: string` to the `Env` interface (a plain, non-secret Wrangler `vars` entry). In `runBackupWatchdog()`, after the existing token-presence gate (Stage 1 behavior unchanged) and before any GitHub call, added a call to `resolveBackupWorkflowFile(env.BACKUP_WORKFLOW_ENVIRONMENT)`; an unresolved result logs `recovery_dispatch_blocked_unresolved_environment` and returns -- no active-run check, no dispatch. On success, the resolved `workflowFile` is threaded into both `checkActiveBackupRun()` and `dispatchBackupWorkflow()`. |
| `status-worker/wrangler.jsonc` (Staging) | Added `"vars": { "BACKUP_WORKFLOW_ENVIRONMENT": "staging-independent" }`. |
| `status-worker/wrangler.production.jsonc` (Production) | Added `"vars": { "BACKUP_WORKFLOW_ENVIRONMENT": "production-independent" }`. Also corrected the stale "NOT YET DEPLOYED" header comment described in Section 1. |
| `tests/backup-watchdog-github-dispatch.test.mjs` | Updated every `checkActiveBackupRun`/`dispatchBackupWorkflow` call to pass an explicit workflow filename (the new required parameter); added one case proving the HTTP call reflects whatever filename it's given verbatim. |
| `tests/backup-watchdog-scheduled.test.mjs` | Added `BACKUP_WORKFLOW_ENVIRONMENT: "staging-independent"` to every existing fixture that exercises the Stage 2 (token-present) dispatch path, preserving their original assertions unchanged; added 4 new cases (missing/unknown environment fails closed, Production-vs-Staging non-interchangeability). |
| `tests/backup-watchdog-workflow-selection.test.mjs` (new) | Dedicated unit coverage for `resolveBackupWorkflowFile()` in isolation (no mocked network needed -- it is a pure function). |
| `scripts/run-tests.mjs` | Added the new test file to the hardcoded `TEST_FILES` list (required for `pnpm test` to run it at all; see that script's own self-check comment). |

No application code outside `status-worker/` changed. No database, migration, D1 binding, R2 binding, Cloudflare Access configuration, or main-application (`worker/`, `lib/`, `app/`) file was touched.

---

## 3. Environment-to-workflow mapping

| `BACKUP_WORKFLOW_ENVIRONMENT` | Resolved workflow file | Verified to exist in `.github/workflows/` |
|---|---|---|
| `"staging-independent"` | `d1-backup-nightly.yml` | Yes |
| `"production-independent"` | `d1-backup-nightly-production.yml` | Yes |
| anything else (missing, empty, unknown, whitespace-padded, concatenated) | *(none -- resolution fails)* | n/a |

The mapping is a static allowlist, never a string built by interpolating the environment value into a filename template -- an unexpected value can only ever fail to resolve, never silently produce an unintended filename.

---

## 4. Fail-closed behavior

`resolveBackupWorkflowFile()` returns `{ ok: false, reason }` -- never a filename -- for:

- a missing (`undefined`) or empty-string environment identity,
- any value that is not an *exact* key in the allowlist (case-sensitive, no trimming, no substring/prefix matching) -- covers unknown values (`"qa"`), near-misses (`"Production-Independent"`, trailing/leading whitespace), and conflicting/malformed values (both identities concatenated or comma-joined).

`runBackupWatchdog()` treats any `{ ok: false }` result identically to a missing dispatch token: it logs the reason and returns immediately, before the active-run check and before any dispatch attempt. There is no code path by which a Production-configured Worker can resolve Staging's filename, or vice versa -- each identity maps to exactly one allowlisted value, and that value is re-validated against the same allowlist before use.

---

## 5. Regression-test results

- `pnpm exec tsc --noEmit` -- clean, exit 0.
- `pnpm test` -- **179/179 test files passed** (178 pre-existing + 1 new: `tests/backup-watchdog-workflow-selection.test.mjs`).
- `pnpm run build:production-independent` -- succeeded (main application build; unaffected by this change, run per the task's required-checks list).
- Status-worker's own build, via the actual command the repository uses to bundle it (`wrangler deploy --dry-run`, which builds but never publishes): run against **both** `status-worker/wrangler.jsonc` and `status-worker/wrangler.production.jsonc` -- both succeeded, each confirming the correct `BACKUP_WORKFLOW_ENVIRONMENT` binding is wired (`"staging-independent"` / `"production-independent"` respectively) and that no deploy occurred (`--dry-run: exiting now.`).

New/updated test coverage proves every item the task required:

- Staging selects the Staging workflow (`backup-watchdog-scheduled.test.mjs`, `backup-watchdog-workflow-selection.test.mjs`).
- Production selects the Production workflow (same files).
- Missing environment identity fails closed (`resolveBackupWorkflowFile(undefined)`, `resolveBackupWorkflowFile("")`, and an end-to-end `runBackupWatchdog()` case with a token but no `BACKUP_WORKFLOW_ENVIRONMENT`).
- Unknown environment identity fails closed (`"qa"`, legacy `"production"`/`"staging"`, case/whitespace variants, and an end-to-end case).
- Conflicting/malformed environment configuration fails closed (concatenated/comma-joined/padded values).
- Production cannot select the Staging workflow (explicit cross-check: Production's resolved filename is asserted distinct from, and never equal to, Staging's; the end-to-end orchestration test asserts the dispatch URL never contains `d1-backup-nightly.yml` when configured as Production).
- No dispatch occurs without a valid authorization token (pre-existing Stage 1 tests, unchanged and still passing -- the token gate still runs first).
- Existing retry, alerting, and status-reporting behavior is preserved (every pre-existing scenario in `backup-watchdog-scheduled.test.mjs` -- fresh/stale detection, active-run check, race re-check, dispatch failure, R2-read failure, malformed JSON -- still passes with its original assertions, now simply supplying the one new required fixture field).

All GitHub API requests remain mocked (`fakeFetch`); no test performs a real network call, dispatches a real workflow, or contacts any live Cloudflare or GitHub service.

---

## 6. Staging compatibility

Independent Staging's resolved workflow filename is unchanged: `resolveBackupWorkflowFile("staging-independent")` returns exactly `"d1-backup-nightly.yml"`, the same value the old hardcoded constant always used. Staging's already-live, dispatch-capable watchdog (Section 1's table) will, once this code is deployed, behave identically to how it behaves today -- same filename dispatched, same token, same cron, same retry/race-recheck/alerting logic, all verified unchanged by the preserved assertions in Section 5. The currently deployed Staging Worker itself was not touched, redeployed, or reconfigured this round.

---

## 7. Deployment requirements

This correction requires, in a future, separately authorized round:

- **A status-worker code deployment** -- both `fundraising-os-backup-status` (Staging) and `fundraising-os-production-backup-status` (Production) need to be redeployed to pick up the new code and the new `vars` entry. The main application Worker does **not** need redeploying -- it reaches the status-worker only through a Worker-to-Worker service binding by name; it has no dependency on the status-worker's internal source.
- **A Wrangler configuration change** -- already made in this round (`vars.BACKUP_WORKFLOW_ENVIRONMENT` added to both `status-worker/wrangler.jsonc` and `status-worker/wrangler.production.jsonc`). This is a plain, non-secret `vars` entry; it has no effect on either currently-running deployed Worker until that Worker is actually redeployed with this config.
- **No new environment variable beyond `BACKUP_WORKFLOW_ENVIRONMENT`.**
- **No secret changes of any kind.** `GITHUB_BACKUP_DISPATCH_TOKEN` is untouched -- Staging keeps its existing secret as-is; Production still has none and this correction does not add one.

Exact commands for that future round (none executed this round):

```sh
# Staging status-worker (already dispatch-capable; preserves identical behavior)
cd status-worker
npx --yes wrangler@4.92.0 deploy --config wrangler.jsonc

# Production status-worker (still detection-only; adds the fail-closed gate, no token exists)
npx --yes wrangler@4.92.0 deploy --config wrangler.production.jsonc
```

**Risk that deployment itself could activate backup dispatch or other unintended scheduled behavior: none.** `wrangler deploy` only uploads a new Worker version; it never invokes `scheduled()` (the Cron Trigger handler) as a side effect of deploying -- `scheduled()` only runs on its own independent Cron schedule. Redeploying Production introduces no new capability (it still has no `GITHUB_BACKUP_DISPATCH_TOKEN`, so it remains Stage 1/detection-only exactly as before, now additionally fail-closed on top of that). Redeploying Staging changes nothing observable (same resolved filename, same token, same schedule) -- it only adds a gate that, for Staging's own correctly-configured identity, is always satisfied.

**Verified this round:** the currently deployed Production status-worker remains detection-only -- `wrangler secret list --config status-worker/wrangler.production.jsonc` returned `[]` (no secrets of any kind, including no `GITHUB_BACKUP_DISPATCH_TOKEN`), re-confirming it cannot call GitHub today regardless of this fix.

---

## 8. Rollback procedure

If a future redeploy of either status-worker surfaces a problem:

1. `npx --yes wrangler@4.92.0 rollback --config status-worker/wrangler.jsonc` (or `wrangler.production.jsonc`) reverts that Worker to its immediately prior deployed version in one step.
2. Because the status-worker has no public route (`workers_dev: false`, no `routes`) and is reachable only via a Worker-to-Worker service binding, a rollback carries no live-traffic-facing risk -- the main application's own behavior is unaffected either way (it only calls the one `/status` route, which this correction does not change).
3. No database, D1 binding, R2 bucket, or GitHub Actions workflow is touched by either the deploy or the rollback, so no data-level recovery step is ever needed as part of rolling this back.

---

## 9. Remaining risks

- **Not yet exercised against a live Cloudflare Worker runtime.** Validation this round is local: unit tests (mocked `fetch`/R2) plus a `wrangler deploy --dry-run` bundle check against both real Wrangler configs. Genuine live-environment behavior (e.g. an actual stale-backup scenario reaching the dispatch path end-to-end) has not been observed on a deployed Worker.
- **Staging's watchdog is live and dispatch-capable today**, independent of this round's work -- it already holds a real `GITHUB_BACKUP_DISPATCH_TOKEN` and ticks hourly. This was not newly introduced and is not changed by this correction, but is called out explicitly here since it was not previously documented this plainly.
- **The allowlist currently covers only the two "-independent" identities** actually in use (`staging-independent`, `production-independent`). If a legacy (`staging`/`production`) status-worker instance is ever separately stood up and given a dispatch token, it would fail closed under the current allowlist until a follow-up change explicitly adds it -- intentional (fail-closed is the safe default), but worth flagging so it isn't mistaken for an oversight later.
- This correction does not change GitHub Actions workflow triggers, secrets, or the existing manual-authorization chain for enabling real automated recovery -- enabling `GITHUB_BACKUP_DISPATCH_TOKEN` for Production remains a separate, future, explicitly-gated decision.

---

## 10. Recommended next action

Independent review of this diff, then a separately authorized deployment of **both** status-workers (Staging and Production) using the exact commands in Section 7, each followed by live verification (confirm bindings via `wrangler deployments list`, confirm no secret was added, and -- ideally -- a one-off manual invocation or log check confirming the resolved workflow filename matches Section 3's table for each). No other Production work should proceed from this round.

Nothing was deployed, migrated, or modified live this round. No GitHub Actions workflow was triggered. No secret was created, rotated, or configured. Stopping here per explicit instruction.
