# Fundraising OS — Production Workspace Health Reporting Fix

**Date:** 2026-10-11
**Status:** Code implementation and testing only. Nothing was deployed. This fix has not been exercised against a live Worker — see "Deployment procedure" below for the separately-authorized next step.

Implements the smallest safe correction for the defects found in `docs/PRODUCTION-SCHEMA-MISMATCH-INVESTIGATION.md`.

## Root cause (unchanged from the investigation, restated briefly)

1. **A stale comparison constant.** `EXPECTED_MIGRATION_LEVEL = "0019"` was never updated as the packaged baseline artifact was regenerated for later migrations (most recently 0042), while deliberately keeping its own historical "0019" file-origin label (`production-baseline.ts`'s own comment: *"that label identifies the single bootstrap file's origin, not its current contents"*).
2. **An environment-recognition gap.** The new `"production-independent"` value (added 2026-10-09) was never wired into `lib/data-health/model.ts`'s or `read.ts`'s `=== "production"` branches — a gap the code's own comment had explicitly flagged and deferred until "anyone actually deploys and views this page against fundraising-os-production-db." It fell through to the same treatment as legacy `"staging"`.

Neither defect reflected a real schema problem — `facts.schemaMatchesBaseline` (the authoritative, full structural comparison) was already correct and already passing.

## Exact files changed

- `lib/data-health/model.ts` — the environment-recognition helpers, the migration-level comparison basis, and every card's label/branch logic.
- `lib/data-health/read.ts` — `checksLiveBaseline`, so the live `production_schema_baseline` query actually runs for independent Production.
- `tests/production-readiness-diagnostics.test.mjs` — new fixture and 11 new regression tests.

No database, migration, Worker configuration, Cloudflare Access policy, GitHub Actions workflow, secret, or donor-data logic was touched. `tests/data-health.test.mjs` was inspected (per the task's instruction) but needed no change — it tests SQL-level integrity queries against a fixed, hardcoded `deploymentEnvironment` default and is orthogonal to this fix; forcing an unrelated change into it would have been scope creep.

## What changed, precisely

### 1. `isProductionEnvironment()` (new, exported from `model.ts`)

```ts
export function isProductionEnvironment(env: DataHealthFacts["deploymentEnvironment"]): boolean {
  return env === "production" || env === "production-independent";
}
```

Replaces every bare `deploymentEnvironment === "production"` / `!== "production"` comparison in `model.ts` (`productionBaselineCheck`, `productionReadinessCheck`, the `productionBaselineApplied`/`productionBlockers` computation, the migration-history card, the business-data-state label) and the one in `read.ts` (`checksLiveBaseline`). Legacy `"production"`'s own behavior is **unchanged** at every one of these call sites — the helper evaluates identically to the bare string check for that value; it is purely additive for `"production-independent"`.

### 2. `usesLatestDetectableMigrationLevel()` (new, exported from `model.ts`)

```ts
export function usesLatestDetectableMigrationLevel(env: DataHealthFacts["deploymentEnvironment"]): boolean {
  return env === "staging-independent" || env === "production-independent";
}
```

Both independent environments boot from the same continually-regenerated baseline artifact, so `LATEST_MIGRATION_LEVEL` ("0022", the newest rung `inferMigrationLevel()` can detect) is the correct comparison basis for either — **not** the historical `EXPECTED_MIGRATION_LEVEL` ("0019") pin. Legacy `staging`/`production` keep comparing against `EXPECTED_MIGRATION_LEVEL` exactly as before: their provenance was not independently re-verified as part of this fix, so their existing behavior was deliberately left untouched rather than assumed safe to change.

This one new boolean now drives a single `expectedMigrationLevel` computed once per report (previously recomputed inconsistently — the "Live schema version" card had its own copy of this ternary; `productionReady`'s computation used the bare `EXPECTED_MIGRATION_LEVEL` unconditionally). Both now read the same value, eliminating the possibility of the two drifting apart.

### 3. The "Live schema version" card

**Before:** `value: "0022 / 0019"`, `status: "critical"`, explanation: *"The live schema does not match the packaged application schema. Do not deploy database changes until reconciled."* — for any freshly-bootstrapped independent Production database.

**After:** `value: "0022 / 0022"`, `status: "healthy"`, explanation: *"The live D1 schema contains every expected table and column through migration 0022 (the newest migration this check can independently detect from schema inspection alone — migration 0020 is data-only and has no schema signature, so it is invisible to this check specifically). The packaged baseline artifact may already include later migrations beyond what this heuristic can see — see 'Production ↔ baseline schema' for the authoritative, complete structural comparison."*

The explanation deliberately does **not** claim "0022 is the actual latest migration" — it says the opposite: this is a detection ceiling, and the real answer lives in the structural comparison card. This directly satisfies the task's requirement #2 ("must not imply 0022 is the actual latest migration when the detector cannot inspect later migrations").

**A genuinely stale schema still fails.** If `currentMigrationLevel` is anything other than `"0022"` for an environment using the latest-detectable comparison (e.g., a production-independent database that was never actually bootstrapped from the current baseline), the card still reports `critical` with the real value (e.g. `"0019 / 0022"`) — covered by a dedicated regression test (`tests/production-readiness-diagnostics.test.mjs`).

### 4. `productionBaselineCheck()` and `productionReadinessCheck()`

Both now branch on `isProductionEnvironment(facts.deploymentEnvironment)` instead of the bare string. For independent Production, this means:

- **Before:** the Staging-informational branch — label "Production baseline artifact", value `"0019 · Packaged"`, explanation naming "Staging" explicitly, never reading the live `production_schema_baseline` row at all (because `read.ts`'s `checksLiveBaseline` never ran the query in the first place).
- **After:** the real, live-evidence branch — label "Production rehearsal baseline", value `"0019 · Verified"` (or `"· Not yet applied"` / `"· Mismatch"` / `"· Unknown"` depending on the actual live marker state), reading the real `production_schema_baseline` table and its `schema_hash`.
- **Before:** "Production launch readiness" showed `status: "info"`, value `"Evaluated on production only"`, explanation telling the owner to "open this page on the production environment" — while they already were.
- **After:** a real verdict — `"Ready"` or `"Blocked"` with an itemized, accurate blocker list.

### 5. Label fixes (task's §4 examples, all addressed)

| Card | Before (shown on independent Production) | After |
|---|---|---|
| `schema-comparison` | "Staging ↔ baseline schema" | "Production ↔ baseline schema" |
| `staging-migration-history` | (would have shown, if routing had been correct) "Staging migration history" | "Production migration history" |
| `business-data-state` | "Staging data state" | "Production data state" |
| `production-readiness` | "Evaluated on production only" | A real "Ready"/"Blocked" verdict |

The `schema-comparison` card's own "critical" explanation text was also de-Staging-ified: *"Material application-schema differences exist between staging and the production rehearsal"* → *"Material application-schema differences exist between the live database and the packaged baseline."* This wasn't in the task's explicit example list but is the same category of hardcoded Staging wording on the same card, found during implementation — fixed in the same, already-open edit rather than left half-done.

**Independent Staging's own cards are completely unaffected** — same labels, same values, same explanations, verified by a dedicated regression test asserting the "before" state is still exactly what staging-independent sees.

## How genuine schema problems remain detectable

Nothing about *detection* changed — only which comparison basis and which branch each environment routes through:

- `schemaMatchesBaseline` (the full, unabridged DDL comparison against the packaged `schema-manifest.json`, covering all 43 migrations) is **completely untouched**. A real structural difference — a missing table, an altered column, a missing index — still reports `critical` on the "Production ↔ baseline schema" / "Staging ↔ baseline schema" card and still blocks `productionReady`, independent of everything else in this fix.
- A live schema that is genuinely behind (hasn't actually been bootstrapped from the current baseline) still fails the "Live schema version" card, because its `currentMigrationLevel` will be something other than the expected level — this is proven by a dedicated test rather than assumed.
- A missing or hash-mismatched `production_schema_baseline` marker still reports `critical` and still blocks `productionReady` — now *correctly evaluated* for independent Production instead of silently skipped.
- Giving-reconciliation and relationship-integrity checks were never part of this bug and are untouched.

## Test coverage added

11 new tests in `tests/production-readiness-diagnostics.test.mjs`, plus a new `independentProductionFacts()` fixture using the **realistic** `currentMigrationLevel: "0022"` (not the historical "0019" every prior "production" fixture in this file used, which is exactly why this gap was never caught before a real deployment hit it):

1. Healthy independent-Production environment reports Ready, no blockers.
2. Valid baseline marker is verified against the real live row (not the build-time-only artifact).
3. Missing baseline marker blocks readiness.
4. Incorrect baseline hash blocks readiness and flags business-data risk.
5. A genuine structural schema mismatch still fails, independent of the baseline marker.
6. A genuinely stale live schema (below the detectable ceiling) still fails — proving the fix doesn't blanket-suppress real staleness.
7. An empty database reports healthy with the correct Production-specific label.
8. Every dashboard card on independent Production carries a Production-specific label — no leftover `/^Staging/`-prefixed label anywhere in the report.
9. The two new helper functions correctly classify every one of the four `deploymentEnvironment` values.
10. Legacy production's behavior is explicitly proven unchanged — still compares against "0019", and would still (correctly, per this fix's own conservative scope) report a mismatch if fed a "0022" reading, since its provenance was never re-verified.
11. Independent Staging's behavior is explicitly proven unchanged — same `0022/0022` comparison, same labels, same "Evaluated on production only" informational verdict.

One pre-existing test (`tests/workspace-health-semantics.test.mjs`) initially failed after the first draft of this fix because it asserted the exact phrase "0020 is data-only" in the live-schema explanation — a legitimate, pre-existing assertion that this fix's first draft had accidentally generalized away. Restored by re-including that specific phrase in the new explanation text rather than loosening the test, so no existing signal was lost.

## Validation results

- `pnpm exec tsc --noEmit` — **clean, exit 0.**
- `pnpm test` — **178/178 test files passed, 0 failed** (includes the 11 new tests, run both standalone and as part of the full suite).
- `pnpm run build:production-independent` — **succeeded.** Output bundle re-confirmed to contain the `"production-independent"` constant (now appearing 4 times, up from 1, since the new helper functions' own string literals are bundled in alongside the existing build-time environment constant).

## Remaining risks

- **This fix has not been exercised against a live Worker.** All verification above is local (`tsc`, unit tests, a local build). The first real proof that the dashboard now renders correctly will be the first time it's actually deployed and viewed.
- **Legacy production's true provenance remains unverified.** This fix deliberately left legacy `"production"`'s comparison basis untouched rather than assume it's also safe to move to `LATEST_MIGRATION_LEVEL` — if legacy production is later confirmed to also be bootstrapped from the regenerated baseline, the same `usesLatestDetectableMigrationLevel()` set could be extended to include it, as a separate, explicitly-justified follow-up.
- **The backup-watchdog `WORKFLOW_FILE` hardcoding bug remains, unfixed, exactly as instructed.** It is unrelated to this fix and was not touched.
- **`inferMigrationLevel()`'s detection ceiling is still "0022."** A database bootstrapped from a baseline reflecting migration 0050 would also report "0022" here. This is an accepted, pre-existing limitation of the heuristic (now clearly documented rather than silently misleading) — the authoritative signal remains the structural comparison, not this card.

## Exact Production deployment and rollback procedure (future, separately authorized)

**This section describes what a future, separately authorized deployment round should do — nothing here was executed.**

1. Preflight: confirm this commit is still the tip of `feature/independent-cloudflare-sandbox`, re-run `tsc`/`pnpm test`/`pnpm run build:production-independent` fresh, and confirm no unrelated change has landed since.
2. Build and deploy the main Production Worker only — this fix touches no status-worker code or config, so the status-worker does not need to be redeployed:
   ```bash
   pnpm run build:production-independent
   pnpm run deploy:production-independent
   ```
3. Immediately after, log in as the owner and confirm on `/settings`: "Live schema version: Healthy" (`0022 / 0022`); "Production rehearsal baseline: 0019 · Verified"; "Production ↔ baseline schema: Match"; "Production launch readiness" renders a real verdict (expected: "Ready", or a specific, legitimate blocker list if one genuinely exists).
4. Confirm Staging's own Workspace Health is unaffected — same cards, same values, as documented in this fix's own preservation tests.

**Rollback**, if anything looks wrong: this is a pure reporting/labeling logic change with zero schema or data implications.
```bash
wrangler rollback --config wrangler.production.jsonc
```
or redeploy the immediately-prior Worker version via `wrangler deployments list` / `wrangler versions deploy`. No database, secret, or infrastructure state needs to be touched either way — the fix never reads or writes anything beyond the existing, unchanged D1 queries this dashboard already performed.

---

Stopping here, per explicit instruction. Nothing was deployed or redeployed. Awaiting independent code review and explicit deployment authorization.
