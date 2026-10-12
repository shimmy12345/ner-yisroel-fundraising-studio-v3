# Production Donor-Data Cutover Runbook

**Date prepared:** 2026-10-12
**Status:** PREPARED AND VERIFIED (Phases 1-3 complete). **Phase 4 (the actual Production import) is NOT executed and NOT authorized by this document.** Everything below that is a live check is read-only. Executing the import described in Phase 4 requires a separate, explicit owner GO, given after reviewing this runbook.

---

## Phase 1 — Pre-cutover verification (completed, read-only)

All checks below were re-run live on 2026-10-12, not assumed from prior rounds.

| Check | Result |
|---|---|
| Staging database identity | `fundraising-os-staging-db`, UUID `6c18396c-0a8f-4f2c-ba83-ea809ec10289` |
| Production database identity | `fundraising-os-production-db`, UUID `a51c6571-ae16-4614-aa9a-08f8e6be3ecd` |
| Ambiguity between the two | **None** — confirmed via a fresh `wrangler d1 list`; exactly these two databases exist |
| Production schema | 137/137 schema objects, byte-identical to `PRODUCTION_BASELINE_OBJECTS` (`lib/data-health/production-baseline.ts`) |
| Production's `production_schema_baseline` marker | `id='0019'`, `schema_hash` matches `PRODUCTION_BASELINE_HASH` exactly |
| Production's owner account | **Exactly one** `users` row: `id='user_sgoldstein@nirc.edu'`, `email='sgoldstein@nirc.edu'` — the same deterministic id Staging's single user has (zero-remapping finding, migration audit Section 4.6) |
| Production fundraising data | **All 50 `FUNDRAISING_DATA_TABLES` confirmed at 0 rows** — Production holds no donor, giving, interaction, or any other business-data row today |
| Production account-config | `users`=1 (the owner row above), `onboarding_preferences`=0, `backup_alert_state`=0 |
| Staging is authoritative | Reconfirmed — no other current system of record found in code/schema/docs (migration audit Section 2); this remains an open owner confirmation, not a code-verifiable fact (see Section 3 below) |
| Rehearsal's validation methods still applicable | **Yes** — the rehearsal's four scripts (`scripts/migration-audit/build-rehearsal-restore-files.mjs`, `run-rehearsal-restore.mjs`, `row-level-hash-compare.mjs`, `verify-rehearsal.mjs`) operate generically on any target database name passed as an argument; none hardcode the rehearsal database's name or ID. They are reused below, pointed at Production instead, with one critical adjustment (Section 2.6). |

**No STOP condition was triggered**: Production contains no unexpected donor data, and both environments were identified unambiguously by UUID, not by name alone.

---

## Phase 2 — Cutover runbook

### 2.1 Pre-cutover backup of Production

Before any write to Production, take and verify a fresh backup:

```
npx wrangler@4.92.0 d1 export fundraising-os-production-db --remote --output <local-scratch>/production-pre-cutover-backup.sql
```

Verify it restores cleanly using the already-proven, already-tested mechanism: `scripts/verify-remote-restore.mjs -- <local-scratch>/production-pre-cutover-backup.sql` (creates its own disposable scratch database, restores into it, runs `integrity_check`/`foreign_key_check`/schema comparison, then deletes itself — see that script's own header for why it is the correct, already-built tool for exactly this). Because Production's business tables are confirmed empty (Phase 1), this backup's main value is capturing the account-config state (the one real `users` row and the schema baseline marker) faithfully, as a restore point in case anything damages that row during the cutover — not a donor-data safety net (there is no donor data in Production yet to lose).

This backup is **in addition to**, not a replacement for, the already-operational automated nightly D1→R2 backup pipeline for Production (`docs/PRODUCTION-BACKUP-WATCHDOG-DEPLOYMENT-VERIFICATION.md`). **This round's environment could not re-confirm the literal latest automated run live** (`gh` CLI is not installed in this session, and `wrangler r2 object get` failed with a local environment error unrelated to Cloudflare — a missing `workerd.exe` binary/an internal wrangler error, not a sign of any backup problem). Re-verify the latest automated backup's timestamp via GitHub Actions run history immediately before Phase 4, using whichever environment has working `gh`/R2 tooling.

### 2.2 Consistent frozen snapshot of Staging

Identical method to the rehearsal (migration audit Section 8.3, already proven): `wrangler d1 export fundraising-os-staging-db --remote --output <local-scratch>/staging-cutover-snapshot.sql`. Read-only against Staging — exporting never modifies, deletes, freezes, or locks the source database. Record the exact export timestamp and source database ID in the post-execution report (Phase 4/5 documentation).

### 2.3 Fresh row counts and financial reconciliation from that snapshot

Run `scripts/migration-audit/reconciliation-baselines.sql`'s queries (and parse the export directly for authoritative per-table counts, exactly as the rehearsal did) against this fresh snapshot — never reuse this runbook's own Phase 3 numbers (Section 3 below), which will be stale by the time Phase 4 actually runs.

### 2.4 Documented pause in Staging data entry

**Mechanism:** operational, not technical — there is no application-level maintenance/freeze mode in this codebase (migration audit Section 11, Risk #4, already a known, pre-existing gap). Since the owner is Staging's only active user, the pause is: the owner stops using the Staging application (no new gifts, donors, interactions, or edits) from immediately before the Phase 2.2 export until Phase 4's final verification passes. See Section 3 for the estimated duration.

### 2.5 Preventing conflicting writes to Production until validation passes

Production is not deployed to or reachable by end users yet in any capacity that writes donor data (confirmed: 0 rows in every fundraising-data table, and this runbook adds no Worker binding for any new database). The only writer to Production during Phase 4 is this runbook's own restore script, run manually, one table at a time, from this operator's own machine — no concurrent process, scheduled job, or deployed Worker touches Production's D1 database during the cutover window. No code is deployed or redeployed as part of this plan (Phase 4 explicitly does not deploy).

### 2.6 Exact migration commands, targeting only the approved Production database — with the critical rehearsal-vs-real-cutover difference

**Target, named explicitly everywhere a command is run: `fundraising-os-production-db` (UUID `a51c6571-ae16-4614-aa9a-08f8e6be3ecd`). Never any other database name or ID.**

**Critical safeguard (the one load-bearing difference from the rehearsal):** the rehearsal's restore order deliberately *included* `users`, because its target was a brand-new, empty database with no users row of its own — it needed one inserted for `PRAGMA foreign_key_check` to pass. **Production already has its own real `users` row** (confirmed, Phase 1). Inserting Staging's `users` row into Production via a plain `INSERT` would either be a harmless no-op (the content is identical — same deterministic id/email, migration audit Section 4.6) or, worse, **fail outright on the primary-key uniqueness constraint**, since the row already exists. **The real cutover's restore order must therefore EXCLUDE `users`, in addition to `production_schema_baseline`, `onboarding_preferences`, and `backup_alert_state`** — this is the *original* migration audit's Section 7 inclusion rule (48 MIGRATE tables, the 6-table PRESERVE/EXCLUDE set left fully alone), not the rehearsal's narrower, special-cased variant.

This is now a real, explicit script parameter, not a manual edit left to the operator's memory: `build-rehearsal-restore-files.mjs` was updated this round so **excluding `users` is the default** — safe for Production and any other non-empty target. A `--include-users-row` flag exists and must be passed **only** when the target is a confirmed-empty rehearsal database with no users row of its own yet (exactly the case the original rehearsal was). The real cutover below never passes that flag.

Steps, reusing the rehearsal's own proven scripts:

1. `node scripts/migration-audit/build-rehearsal-restore-files.mjs <staging-cutover-snapshot.sql> <local-scratch-outdir>` — **no `--include-users-row` flag** — the script's default (`users` excluded, alongside `production_schema_baseline`/`onboarding_preferences`/`backup_alert_state`) is exactly correct for Production.
2. `node scripts/migration-audit/run-rehearsal-restore.mjs fundraising-os-production-db <local-scratch-outdir>` — restores every other table, in dependency order, via `wrangler d1 execute --remote --file=...`, stopping immediately on the first failure (no retry, no skip).
3. The oversized-row technique (Section 2.7) is already built into step 1's script and requires no separate invocation.

### 2.7 The verified oversized-row restoration technique from the rehearsal

Reused unchanged: `build-rehearsal-restore-files.mjs`'s chunked-INSERT-then-repeated-UPDATE technique for any single-row `INSERT` at or above `D1_SAFE_STATEMENT_BYTES` (65,536 bytes) — proven in the rehearsal to reproduce the oversized `data_imports.report_json` value byte-for-byte (confirmed via row-level hash comparison). No raw Cloudflare API token is required; everything runs through `wrangler d1 execute`.

### 2.8 Full row-level reconciliation across all 48 migration tables

Reused unchanged: `scripts/migration-audit/row-level-hash-compare.mjs <staging-cutover-snapshot.sql> fundraising-os-production-db <local-scratch-outdir>` — SHA-256, every column, every row, both the frozen snapshot and the restored Production data, compared as sorted hash multisets. Must report 0 mismatches across all tables with data (40 in the rehearsal; re-count fresh from the Phase 4 snapshot, since Staging keeps growing).

### 2.9 Foreign-key, ownership, and application-level reference checks

Reused unchanged: `scripts/migration-audit/verify-rehearsal.mjs fundraising-os-production-db <local-scratch-outdir>` — `PRAGMA foreign_key_check`, primary-key uniqueness, `ownerUserId`/`userId` resolution against the real (pre-existing, untouched) Production `users` row, and every application-level (non-FK-enforced) orphan check already exercised in the rehearsal (`gift_acknowledgments.gift_id`, `jl_payment_assignments.pledge_activity_id`, `pledge_payment_plans`/`pledge_balance_corrections`, `giving_activity_import_changes.import_id`).

### 2.10 Financial reconciliation to the cent

Reused unchanged: the same `workspace_status='active' AND record_origin='live'` query (with the `pledge_balance_corrections` COALESCE override) run against Production post-restore, diffed to the cent against the Phase 2.3 frozen-snapshot figures. Both duplicate-flagged giving activities (Goldman `1c3f3d51-4a28-42f5-a3ee-105bc245d7f5`, Gluck `5e29f6c5-b599-4227-9ab8-fc50e7415f28`) must land with `workspace_status='duplicate'` unchanged and must **not** appear in this filtered total — exactly as the rehearsal proved.

### 2.11 Rollback procedure if any required verification fails

Because Production's 48 MIGRATE tables are confirmed empty today (Phase 1), rollback is simple and low-risk: **restore Production to that same, independently-confirmed-empty starting state**, never a destructive guess. Using `lib/operations/staging-reset.ts`'s `STAGING_RESET_TABLE_ORDER` (already built, already proven, child-before-parent — the same order a staging reset uses, which already deliberately excludes `users`/`onboarding_preferences`/`backup_alert_state`):

```
for each table in STAGING_RESET_TABLE_ORDER:
  DELETE FROM "<table>";
```

run against Production only, in that exact order, via `wrangler d1 execute fundraising-os-production-db --remote --command "DELETE FROM \"<table>\";"` one table at a time. After rollback, re-run Phase 1's "Production fundraising data" check (all 50 tables = 0) to confirm the rollback itself succeeded. **Production's `users` row and schema marker are never touched by rollback**, since they were never touched by the forward restore either (Section 2.6). Staging is never written to during rollback — it was never written to during the forward restore either. **Do not attempt a partial fix, a second blind retry, or any manual data edit** — per the task's explicit instruction, STOP and report if any required check still fails after one clean rollback, rather than attempting a second cutover in the same session.

---

## Phase 3 — Readiness checkpoint (completed; see final response for the full report)

All Phase 3 reporting is read-only and was performed live; its figures are reproduced in this session's final chat response rather than duplicated here, since they will be stale the moment Staging is used again. The one open question Phase 3 explicitly asks — "confirm whether the owner must stop using Staging and for approximately how long" — is answered in Section 2.4 above and quantified in the final response's downtime estimate.

**STOPPING HERE. Phase 4 is not executed. It requires a separate, explicit owner GO after reviewing this runbook and the final response's readiness report.**

---

## Phase 4 — Production migration (NOT YET AUTHORIZED, NOT EXECUTED)

Documented above (Sections 2.1–2.11) as the exact procedure to follow once authorized. Restated here as a checklist for the operator at execution time, in order:

1. Confirm Staging writes are paused (Section 2.4).
2. Capture and verify the final Staging snapshot (Sections 2.2–2.3).
3. Verify the Production target and backups again, immediately before writing (Section 2.1, re-run fresh — do not reuse this runbook's Phase-1 figures).
4. Import the approved 48-table dataset into Production (Sections 2.6–2.7), **with `users` excluded from the restore, per Section 2.6's safeguard.**
5. Confirm Production's pre-existing owner account/row is byte-identical to before the import (re-run the Phase 1 owner-account check).
6. Run all reconciliation checks (Sections 2.8–2.10).
7. On any critical-check failure: stop and execute the Section 2.11 rollback; do not retry blindly.
8. Do not declare success until every required check in Sections 2.8–2.10 passes.

## Phase 5 — Post-migration validation (NOT YET AUTHORIZED, NOT EXECUTED)

To be performed only after a successful Phase 4: verify donor records/giving history read correctly through the application's own queries (not just raw SQL); verify financial totals as displayed by the application; verify both duplicate-flagged records remain excluded from every reporting surface (reusing the prior round's code-level verification, `docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md` Section 15.2); verify the owner can log into and use Production; verify normal application functionality end-to-end; then, and only then, formally establish Production as the primary working environment and Staging as a non-authoritative testing environment going forward, and document how future data imports/updates should be performed against Production (this still requires separately deciding whether/how the JL-import pipeline itself gets re-pointed at Production — not decided by this runbook). **No automated backup schedule is enabled or altered as part of Phase 5 or any other phase of this plan** — that remains a separate, future, explicitly-authorized decision.

---

Stopping here, per explicit instruction. Production has not been modified by any step in preparing this runbook. Awaiting the owner's separate, explicit GO before Phase 4.
