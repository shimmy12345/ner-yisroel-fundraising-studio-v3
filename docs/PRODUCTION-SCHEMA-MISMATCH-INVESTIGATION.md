# Fundraising OS — Production "Live Schema Version 0022/0019" Investigation

**Date:** 2026-10-11
**Status:** Read-only investigation. No database, Worker, workflow, or application code was modified. Every claim below is sourced from direct code reads and live, read-only Production queries performed this round.

## Root cause, severity, and recommendation (read this first)

**Root cause: a health-reporting defect, not a genuine schema incompatibility.** The live Production D1 schema is correct, current, and complete — independently confirmed by the one check in this file that already compares the real thing correctly (`schemaMatchesBaseline`, surfaced as "Staging ↔ baseline schema: Match"). The alarming "Live schema version: 0022 / 0019 — ERROR... Do not deploy database changes until reconciled" line is produced by a much narrower, much older heuristic (`EXPECTED_MIGRATION_LEVEL = "0019"`, last touched 2026-08-05) that was never updated to reflect that the packaged baseline artifact has been regenerated many times since — most recently to absorb migration 0042 — while keeping its original "0019" filename/label by design (`lib/data-health/production-baseline.ts`'s own comment: *"PRODUCTION_BASELINE_LEVEL stays '0019': that label identifies the single bootstrap file's origin, not its current contents"*). Compounding this, the new `"production-independent"` environment value (added 2026-10-09) was never wired into any of this file's `=== "production"` branches — a gap the code's own comment explicitly flagged and deferred: *"revisit before anyone actually deploys and views this page against fundraising-os-production-db."* That moment has now arrived.

**Severity: Medium (reporting/observability), not a data-integrity or security issue.** No donor/financial data risk exists. No application feature outside the Workspace Health dashboard depends on this distinction (confirmed by a repo-wide search — see §7). The real-world consequence is that the dashboard's own "Production launch readiness" signal cannot currently render a trustworthy verdict for this environment (it shows a non-answer, not a wrong answer), and the "Live schema version" card displays a false, alarming mismatch that could cause someone to waste time investigating a non-existent problem or attempt an unnecessary and risky "corrective" migration against a database that does not need one.

**Recommended fix:** smallest-safe, two-part, detailed in §9. Not implemented this round, per instruction.

**Should Production deployment remain blocked for further data migration?** The actual schema is fine, so this finding does not newly block migration. However, donor-data migration was already gated behind a separate, explicit owner-approval chain (fresh Staging audit → rehearsal → sign-off → cutover) that does not depend on this dashboard card — that gate is unchanged and should remain in place regardless of this bug. What this investigation adds: **do not use the "Production launch readiness"/"Live schema version" cards as part of that approval chain until the fix in §9 lands and is verified**, since right now they cannot be trusted to say "Ready" even when things genuinely are, and a future *real* problem in this exact area could equally go unreported until the environment-recognition gap is closed.

---

## 1. How the dashboard calculates the live schema version and the expected version

Both numbers come from `lib/data-health/model.ts`'s `buildDataHealthReport()`, specifically the "live-schema" check (lines ~702–721):

```ts
const expected = deploymentEnvironment === "staging-independent" ? LATEST_MIGRATION_LEVEL : EXPECTED_MIGRATION_LEVEL;
const matches = facts.schemaReady && facts.currentMigrationLevel === expected;
return {
  id: "live-schema",
  label: "Live schema version",
  status: matches ? "healthy" : "critical",
  value: `${facts.currentMigrationLevel ?? "Unknown"} / ${expected}`,
  explanation: matches ? /* ... */ : "The live schema does not match the packaged application schema. Do not deploy database changes until reconciled.",
};
```

- **`facts.currentMigrationLevel`** ("0022" in the report) comes from `inferMigrationLevel()` (model.ts lines 861–888) — a live schema-inspection heuristic that walks a hardcoded ladder of table/column signatures, from newest to oldest, and returns the highest rung it finds evidence for. Its newest rung is:
  ```ts
  if (previewSessionColumns.has("decisions_json") && previewSessionColumns.has("status") && previewSessionColumns.has("progress_resolved")) return "0022";
  ```
  **There is no higher rung.** Any live database whose `import_preview_sessions` table has these three columns — whether its true schema reflects migration 0022 or migration 0042 — reports exactly `"0022"`, because the function has no way to distinguish further. This is not a bug in the function's own logic; it is simply a detector that was never extended past the point someone last needed it to go.
- **`expected`** is `EXPECTED_MIGRATION_LEVEL`, a constant defined at model.ts line 177:
  ```ts
  // Continues to gate production launch readiness specifically -- production
  // is deliberately pinned to the verified 0019 baseline until it is itself
  // migrated forward, a separate decision from what independent staging runs.
  export const EXPECTED_MIGRATION_LEVEL = "0019";
  ```
  for every `deploymentEnvironment` value **except** `"staging-independent"`, which instead compares against `LATEST_MIGRATION_LEVEL = "0022"` (model.ts line 185, with its own comment explaining this exact split: "0020_financial_date_only.sql is data-only and has no schema signature... 0021 and 0022 both changed import_preview_sessions and are [detectable]").

So "0022 / 0019" is exactly `${currentMigrationLevel} / ${expected}` with `currentMigrationLevel = "0022"` (correctly detected, capped) and `expected = EXPECTED_MIGRATION_LEVEL = "0019"` (because `"production-independent" !== "staging-independent"`, so Production does not get the same, already-correct `LATEST_MIGRATION_LEVEL` comparison Staging gets).

## 2. Where 0022 and 0019 originate

| Value | File | Introduced | What it actually represents |
|---|---|---|---|
| `EXPECTED_MIGRATION_LEVEL = "0019"` | `lib/data-health/model.ts:177` | 2026-08-05 (confirmed via `git log -S`), unchanged since | A constant frozen at the point when migration 0019 genuinely was the newest migration in the repository. Never updated since, even as 23 more migrations (0020–0042) landed. |
| `LATEST_MIGRATION_LEVEL = "0022"` | `lib/data-health/model.ts:185` | 2026-08-10 (confirmed via `git log -S`), unchanged since | Introduced specifically so independent Staging's own "ahead of production" schema could be correctly recognized as healthy. Also never updated since, even though `inferMigrationLevel()`'s own detection ceiling and this constant happen to coincide at "0022" by chance of when they were last touched together — not because the real schema stopped advancing. |
| `facts.currentMigrationLevel = "0022"` | Computed live, per request, by `inferMigrationLevel()` reading the real Production D1 | N/A — live inspection | **Confirmed empirically this round**: `PRAGMA table_info('import_preview_sessions')` against the real, live `fundraising-os-production-db` shows the columns `decisions_json`, `status`, `progress_resolved` are genuinely present. The detector is reporting a true fact about the live schema, capped at the highest rung it knows how to check. |
| Baseline artifact's own "0019" label | `production-baseline/schema-manifest.json`'s `baselineLevel` field, loaded via `lib/data-health/production-baseline.ts`'s `PRODUCTION_BASELINE_LEVEL` | Set once at the baseline file's creation; never changed | This is **not** a live schema-version indicator at all. The file's own comment says so explicitly: *"PRODUCTION_BASELINE_LEVEL stays '0019': that label identifies the single bootstrap file's origin, not its current contents."* The same file's own trailing comment confirms the baseline was most recently regenerated for migration 0042 (`pledge_balance_corrections`), changing `PRODUCTION_BASELINE_HASH` but, by design, never `PRODUCTION_BASELINE_LEVEL`. |

**In short: "0019" is three different things wearing one label** — a stale comparison constant (`EXPECTED_MIGRATION_LEVEL`), a historical file-origin tag (`PRODUCTION_BASELINE_LEVEL`) that was never meant to track live content, and (confusingly) the same literal string appears in UI copy describing both. "0022" is a real, correctly-detected live fact, but one that is architecturally incapable of expressing "this schema is actually at migration 0042" — it can only ever say "at least 0022."

## 3. Production D1: migration journal, baseline marker, tables, columns, indexes, constraints — direct inspection

All of the following was queried live, read-only, this round:

- **Baseline marker** (`production_schema_baseline` table): `id = "0019"`, `schema_hash = "913299652ad37c0073e82aeccb30511dc1f13c784eebb5e4e7ecd3e237dea566"`. This exact hash was already independently verified twice before today — once by the restore-verification workflow run `38139854757` ("production_schema_baseline backup fidelity OK ... also matches today's packaged hash"), and again just now by re-reading the live row directly. It matches `PRODUCTION_BASELINE_HASH` in the currently-packaged `production-baseline/schema-manifest.json` exactly.
- **Table count**: 56 total (`SELECT COUNT(*) FROM sqlite_master WHERE type='table'`), consistent with every prior check this session: 54 application tables (53 fundraising tables + `production_schema_baseline` itself) plus 2 SQLite/D1-internal system tables.
- **`import_preview_sessions` columns** (the specific table `inferMigrationLevel` inspects): `id, owner_user_id, file_hash, file_name, mapping_json, force_type, row_count, created_at, expires_at, decisions_json, status, updated_at, progress_resolved, progress_total` — confirmed live. `decisions_json`/`status`/`progress_resolved` are all present, matching migration 0022's shape exactly, as the baseline SQL file (`production-baseline/drizzle/0000_production_baseline_0019.sql`, lines 439–450) itself also shows them baked directly into the single `CREATE TABLE` statement (not added via a later `ALTER TABLE` replay — this database was never migration-replayed; it was bootstrapped from one file that already contains this shape).
- **Migration journal / `d1_migrations` table**: not applicable to this database. Production (like independent Staging) is bootstrapped from the single baseline file, never from a replayed migration history — `docs/DEPLOYMENT.md`'s own migration-procedure section confirms this is the intended design ("Production and independent staging both start from `production-baseline/drizzle/0000_production_baseline_0019.sql`... a single file"). There is no migration journal to be out of sync with.
- **Indexes/constraints**: not spot-checked individually this round beyond what the authoritative structural comparison in §4 already covers exhaustively (every index and constraint, not a sample).
- **Business data**: `donors = 0, gifts = 0, giving_activities = 0, users = 0` — unchanged from every check earlier this session, confirming no data exists to be at risk either way.

## 4. Live Production schema vs. the packaged baseline — the comparison that actually matters

This is `facts.schemaMatchesBaseline`, surfaced as the "Staging ↔ baseline schema" card, computed by `compareSchemaObjects()` in `lib/data-health/production-baseline.ts`: a full, unabridged, table-by-table and index-by-index comparison of the live database's actual DDL (`SELECT name,type,tbl_name,sql FROM sqlite_schema`) against `PRODUCTION_BASELINE_OBJECTS` — the complete, current packaged schema (derived from `schema-manifest.json`'s `ddlTopology`, which reflects **all 43 source migrations**, 0000 through 0042, per `schema-manifest.json`'s own `sourceMigrations` array and `PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === 43` assertion).

**This check is the authoritative one, and it reported `Match`.** Every table, every index, every column, every constraint the current application code actually expects — the full picture, not a 23-step-behind heuristic ladder — is present and correct in live Production. This directly answers the investigation's core question: **there is no genuine schema incompatibility.** The "Live schema version" card and the "Staging ↔ baseline schema" card are measuring different things (a crude migration-number proxy vs. the real structural comparison), and only the latter is designed to be authoritative — the former's own explanatory text even says so for the one environment where this was already noticed (model.ts lines 716–718, staging-independent's own explanation: *"...it cannot be independently verified by schema inspection alone — see 'Staging ↔ baseline schema' for the authoritative structural comparison"*). Production's version of this same card simply never got the equivalent caveat added to its own explanation.

## 5. Genuine incompatibility or health-reporting defect?

**Health-reporting defect, conclusively.** Three independent pieces of evidence converge:

1. The authoritative structural comparison (§4) passes.
2. The specific columns `inferMigrationLevel` checks for are confirmed present live (§3), proving the "0022" reading is a true (if capped) fact about the schema, not a stale/incorrect read.
3. The comparison basis (`EXPECTED_MIGRATION_LEVEL = "0019"`) is independently documented, in the same codebase, as representing a historical file-origin label rather than a live expectation (`production-baseline.ts`'s own comment, §2) — so the "expected" side of the comparison was never a correct target to compare against in the first place for any database bootstrapped from the current (post-regeneration) baseline artifact.

## 6. Why the dashboard shows Staging-specific descriptions in Production

Two distinct causes, found by direct code inspection:

**(a) One hardcoded label, unconditional, affecting every environment:** model.ts line 726:
```ts
{ id: "schema-comparison", label: "Staging ↔ baseline schema", ... }
```
This label is not inside any environment branch at all — it reads "Staging ↔ baseline schema" on literal legacy `"production"`, on `"production-independent"`, and everywhere else, simply because it was written when only Staging existed and nobody revisited the copy when the check became meaningful for Production too.

**(b) The `"production-independent"` environment-recognition gap, causing real branch misrouting:** `lib/data-health/model.ts`'s own type definition carries this exact warning, written 2026-10-09 when the 4th environment value was added (lines 54–62):
```ts
// "production-independent" (lib/environment.ts, added 2026-10-09) is
// accepted here for type correctness, but none of this file's own
// `=== "production"` / `=== "staging-independent"` branches below
// match it yet -- it currently falls through to the same path legacy
// "staging" takes. That is a deliberate, conservative default (no
// branch silently misfires), not a considered design for how
// Workspace Health should present an independent Production
// environment -- revisit before anyone actually deploys and views
// this page against fundraising-os-production-db.
```
Concretely, this means (model.ts, `buildDataHealthReport`):
- `productionBaselineApplied` (line 678) is unconditionally `true` for production-independent, bypassing the real check.
- `productionBlockers` (line 685) is unconditionally `[]` for production-independent, even when `productionReady` computes `false` — see §1/§5.
- `productionBaselineCheck()` (lines 505–526) takes its **non-production** branch for production-independent, whose own explanation text literally says: *"Staging is a legacy database that never carries the production_schema_baseline marker by design, so this value is informational only and never represents or blocks production launch readiness."* — shown, verbatim, on the real Production dashboard. This is the direct source of the "Production baseline artifact: 0019 · Packaged" line the owner saw, which is the **build-time-only, informational** card, not the live-verified one (which would have read "Production rehearsal baseline: 0019 · Verified" with real evidence, had the correct branch been taken).
- `productionReadinessCheck()` (lines 548–568) likewise takes its non-production branch, whose label is "Production launch readiness" but whose value is the non-answer *"Evaluated on production only"* with explanation *"open this page on the production environment to see its current readiness"* — shown while the owner is, in fact, on the production environment. (Not mentioned in the owner's pasted excerpt, but confirmed present by code trace and almost certainly what a full screenshot would show.)
- The migration-history card (line 722–724) and the "business data state" label (line 730) both fall to their Staging-oriented wording for the same reason.

Also confirmed, separately, in `lib/data-health/read.ts` line 119:
```ts
const checksLiveBaseline = deploymentEnvironment === "production" || deploymentEnvironment === "staging-independent";
```
For `"production-independent"`, `checksLiveBaseline` is `false`, so the live `production_schema_baseline` query is never even attempted — `productionBaselineState` defaults to `"not-applicable"` before model.ts's own branch choice even comes into play. Both layers need the same fix (§9).

## 7. Could any Production application feature actually fail because of this?

**No.** A repository-wide search (`grep -rn '=== "production"' --include="*.ts" app/ lib/ worker/`, excluding `lib/data-health/`) found **zero** other locations anywhere in the application that branch on this exact distinction. Authentication (`lib/auth/provider-selection.ts`) gates on whether Cloudflare Access is *configured* (a boolean derived from real `TEAM_DOMAIN`/`POLICY_AUD` values), not on the `deploymentEnvironment` string — already confirmed correct for Production in the deployment-preflight round. The staging-reset endpoint gates on `=== "staging-independent"` specifically (an allowlist, not this affected comparison) and correctly stays unreachable regardless of this bug. Every donor/gift/financial read-and-write path is scoped by authenticated owner id, never by this environment label.

**The only real-world consequence is to the Workspace Health dashboard's own self-description and readiness-signaling** — specifically, the "Production launch readiness" card currently cannot render a real verdict for this environment (§6), and the "Live schema version" card renders a false alarm. Both are observability/decision-support concerns, not data-integrity or security concerns.

## 8. Test coverage review

- `tests/production-readiness-diagnostics.test.mjs` has dedicated fixtures for `deploymentEnvironment: "production"` (using `currentMigrationLevel: "0019"`, artificially matching `EXPECTED_MIGRATION_LEVEL` exactly) and `deploymentEnvironment: "staging-independent"` (using `currentMigrationLevel: "0022"`, correctly matching `LATEST_MIGRATION_LEVEL`, with its own comment already explaining the split this investigation describes).
- `tests/data-health.test.mjs`'s own fixture builder also hardcodes `currentMigrationLevel: EXPECTED_MIGRATION_LEVEL` directly, guaranteeing a match by construction.
- **A repo-wide search for the literal string `"production-independent"` across every file in `tests/` returned zero matches.** There is no test fixture, anywhere, for this environment value — exactly the gap the model.ts comment itself anticipated and flagged two days before the first real deployment made it observable. This is the single missing piece of coverage that would have caught this before an owner ever saw it live: a fixture with `deploymentEnvironment: "production-independent"` and a realistic `currentMigrationLevel: "0022"` (matching what any freshly-bootstrapped database from the current baseline actually produces) would have immediately shown the same false "critical"/"ERROR" result and the same wrong-branch card labels this investigation found live.

## 9. Recommended smallest safe correction (not implemented this round)

**Part A — close the environment-recognition gap** (the root cause of the wrong-branch cards, §6):
In both `lib/data-health/model.ts` and `lib/data-health/read.ts`, extend every `=== "production"` comparison that is meant to mean "a real, live-baseline-bearing production environment" to also match `"production-independent"` — e.g. `(deploymentEnvironment === "production" || deploymentEnvironment === "production-independent")` — mirroring the pattern this codebase already uses to give `"staging-independent"` its own first-class treatment where needed. This restores the real `productionBaselineCheck()`/`productionReadinessCheck()`/`checksLiveBaseline` branches for the actual independent Production environment, so the dashboard starts reading the real, live `production_schema_baseline` marker and rendering a real "Ready"/"Blocked" verdict instead of a non-answer.

**Part B — reconcile the stale comparison basis** (the direct source of "0022 / 0019", §1–§2):
Since `EXPECTED_MIGRATION_LEVEL`'s "pin production to 0019" premise no longer matches what the regenerated baseline artifact actually contains (and has not, for any database bootstrapped since the baseline was last regenerated), the "Live schema version" card's comparison needs a basis that reflects reality. Two options, either acceptable, smallest-safe-first:
  - **B1 (smallest):** For any environment whose database is bootstrapped from the current baseline artifact (production, production-independent, staging-independent — i.e. everything except legacy `"staging"`/`"production"`, which alone still carry real migration-replay history), compare against `LATEST_MIGRATION_LEVEL` instead of `EXPECTED_MIGRATION_LEVEL`. This is a one-line change to the `expected` ternary at model.ts line 708, extending the condition already used for `"staging-independent"` to include `"production-independent"` too (and, if legacy production is also bootstrapped the same way today, that as well — verify before changing, since legacy production's actual provenance was not re-examined this round).
  - **B2 (more thorough, future work):** Extend `inferMigrationLevel()`'s detection ladder past "0022" so the "Live schema version" card can eventually express the database's *true* current level rather than a capped proxy, and retire the now-demonstrably-stale `EXPECTED_MIGRATION_LEVEL` constant in favor of deriving the "expected" side directly from `PRODUCTION_BASELINE_SOURCE_MIGRATIONS` (already always current, since it's regenerated alongside the baseline). This is the more correct long-term fix but is more work and not required to resolve today's false alarm.

**Part C — fix the hardcoded Staging-specific copy** (§6a and the explanation text quoted in §6b):
Relabel the "Staging ↔ baseline schema" card (and the one explanation string in `productionBaselineCheck()`'s non-production branch that names "Staging" specifically) to use environment-appropriate wording, e.g. deriving a human label ("Independent Production" / "Independent Staging" / "Staging") the same way other cards in this file already do, rather than a single hardcoded string.

**Verification, after implementing (future round, separately authorized):**
1. Add the missing test fixture: `deploymentEnvironment: "production-independent"` with a realistic `currentMigrationLevel` value, covering both the "matches" and "has a real blocker" cases, in `tests/production-readiness-diagnostics.test.mjs` (mirroring its existing `"production"`/`"staging-independent"` cases) and `tests/data-health.test.mjs`.
2. Run the full suite locally (`pnpm test`) — expect 178+/178+ passing, including the new cases.
3. Deploy the fix to the independent Production Worker (separately authorized, following the same preflight discipline as the first deployment).
4. Reload `/settings` as the owner and confirm: "Production rehearsal baseline: 0019 · Verified" (the real, live-evidence card, not the build-time-informational one); "Live schema version: Healthy"; "Production launch readiness" renders a real verdict (expected: "Ready", or a specific, legitimate blocker list if one exists); the schema-comparison card's label reads appropriately for Production.
5. Confirm Staging's own dashboard is completely unaffected by re-loading it and confirming its cards read exactly as before this change (environment-string additions should be additive, never a removal of an existing branch).

**Rollback:** trivial and zero-data-risk either way. This is a pure reporting/labeling logic change with no schema or data implications — `wrangler rollback` (or redeploying the prior Worker version) reverts the dashboard's own code with no effect on the database itself, which was never touched by this investigation or would be touched by the fix.

---

Stopping here, per explicit instruction. No database, Worker, workflow, or application code was modified during this investigation.
