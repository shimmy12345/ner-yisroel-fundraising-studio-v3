# Production Donor-Data Cutover — Execution Report

**Date:** 2026-10-12
**Status: SUCCESS.** Executed under the owner's explicit final GO, following the approved runbook (`docs/PRODUCTION-DONOR-DATA-CUTOVER-RUNBOOK.md`). Independent Staging was never written to. No application code was deployed, no Worker binding was added or changed, no GitHub Actions schedule or secret was changed, and Production's pre-existing owner account was never touched.

---

## 1. Database identities (confirmed live, not assumed)

| Database | Name | UUID |
|---|---|---|
| Staging (source) | `fundraising-os-staging-db` | `6c18396c-0a8f-4f2c-ba83-ea809ec10289` |
| Production (target) | `fundraising-os-production-db` | `a51c6571-ae16-4614-aa9a-08f8e6be3ecd` |

Exactly these two databases exist. The target matches the owner's authorization exactly, re-confirmed via `wrangler d1 list` immediately before the first write.

## 2. Mandatory preflight — all 9 items, all passed, no STOP condition

| # | Check | Result |
|---|---|---|
| 1 | Exact Staging/Production UUIDs | Confirmed above |
| 2 | Production has zero donor/fundraising records | All 50 `FUNDRAISING_DATA_TABLES` confirmed at 0 rows (full live re-check, not reused from a prior round) |
| 3 | Production's schema matches the baseline | 137/137 schema objects byte-identical; `production_schema_baseline` marker (`id='0019'`) matches `PRODUCTION_BASELINE_HASH` exactly |
| 4 | Production's existing owner account is intact | Exactly one `users` row, `id='user_sgoldstein@nirc.edu'`, full profile captured before the write for later diff (Section 6) |
| 5 | Fresh Production backup created | `wrangler d1 export fundraising-os-production-db --remote`, 2026-10-12T00:33:40Z–00:33:45Z |
| 6 | Backup verified restorable, not just that an export exists | Restored the fresh backup into a brand-new, disposable scratch database (`fundraising-os-backup-verify-20261012`), confirmed `PRAGMA foreign_key_check` returns 0 violations and the owner row/schema marker match, then deleted the scratch database. `scripts/verify-remote-restore.mjs` itself could not run in this environment (requires a bare `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, not exposed here) — the same create/restore/verify/delete pattern was reproduced manually via `wrangler d1 execute`, which this session is authenticated for. |
| 7 | Latest automated backup status, via working tooling | `gh` CLI is not installed and `wrangler r2 object get` failed with a local environment error (missing `workerd.exe`/an internal wrangler error) unrelated to Cloudflare account state. **Worked around, not skipped:** queried the GitHub Actions REST API directly (`api.github.com/repos/.../actions/workflows/.../runs`, unauthenticated — this repo's Actions API is publicly readable). Results: "D1 nightly backup (Production)" last succeeded 2026-10-11T03:44:12Z; "D1 monthly restore verification (Production)" last succeeded 2026-10-11T12:35:39Z (one failure earlier the same day, on the very first run immediately after that workflow's own initial deployment — not recurring since); "D1 nightly backup" (Staging) last succeeded 2026-10-11T14:30:05Z. |
| 8 | No other migration/database-writing process running | Checked the local process list; only this session's own node/wrangler processes were present. This is a local-process check, not a guarantee against every possible external actor, but nothing unexpected was found. |
| 9 | Staging data entry paused for the cutover window | No literal way to observe the owner's own application usage directly. **Proxy verification performed:** captured Staging's donor/giving-activity counts and `MAX(updated_at)` across `donors`/`giving_activities` twice, ~5 minutes apart, spanning the preflight and snapshot work — both readings identical (254 donors, 5,463 giving activities, same max timestamps). No activity observed during this round's own window. |

**No STOP condition was triggered.**

## 3. Final Staging snapshot (the authoritative migration source and reconciliation baseline)

| Field | Value |
|---|---|
| Method | `wrangler d1 export fundraising-os-staging-db --remote` |
| Window | 2026-10-12T00:36:26Z – 00:36:32Z |
| Source database | `fundraising-os-staging-db` (`6c18396c-0a8f-4f2c-ba83-ea809ec10289`) |

| Figure | Value |
|---|---:|
| Donors | 254 |
| Giving activities | 5,463 |
| Committed (cents) | 402,429,680 ($4,024,296.80) |
| Paid (cents) | 384,791,565 ($3,847,915.65) |
| Raw outstanding balance (cents) | 17,638,115 ($176,381.15) |
| Corrected outstanding balance (cents) | 17,617,115 (**$176,171.15**) |
| Active `pledge_balance_corrections` | 1 (net -$210.00, the Kutoff/DIN2023 case) |

Identical to every figure reported in this session's prior rounds (audit, rehearsal, readiness checkpoint) — Staging showed zero drift across the entire session. Per-table counts for all 48 migration-eligible tables were captured from this export (not from a separate live query, eliminating any race) — see Section 4.

## 4. Production import

**Mechanism:** `scripts/migration-audit/build-rehearsal-restore-files.mjs` (default mode — **no** `--include-users-row` flag, per the runbook's Section 2.6 safeguard) followed by `scripts/migration-audit/run-rehearsal-restore.mjs fundraising-os-production-db`, reusing the dependency-safe restore order unchanged from the rehearsal.

**Execution window:** 2026-10-12T00:38:07Z – 00:41:36Z. **40 tables with data restored, zero failures, no retry needed.**

**The one oversized row** (`data_imports.report_json`, ~162KB) was restored using the rehearsal's proven chunked-INSERT-then-repeated-UPDATE technique — confirmed below (Section 5) to be byte-identical to source.

**`users`, `onboarding_preferences`, `backup_alert_state`, and `production_schema_baseline` were explicitly excluded**, exactly per the runbook: Production's own pre-existing owner-account rows and schema marker were never touched. `import_preview_sessions`/`import_preview_session_chunks` were skipped per the already-established ephemeral-cache exclusion.

## 5. Full database reconciliation (all 48 migration tables)

### 5.1 Row counts

**48/48 tables reconciled exactly**, zero mismatches: 40 tables with data matched the frozen snapshot's own counts exactly (including `users`=1, counted for completeness though it was not restored — Production's own pre-existing row); the 5 by-design-excluded tables (`production_schema_baseline`, `onboarding_preferences`, `backup_alert_state`, `import_preview_sessions`, `import_preview_session_chunks`) were each confirmed in their intended post-restore state; the remaining zero-row MIGRATE tables (`gifts`, `donor_merge_audits`, `activity_status_audits`, `sample_cleanup_audits`, `legacy_test_cleanup_audits`, `data_health_repair_audits`, `household_import_rollback_audits`, `donation_import_rollback_audits`) were confirmed at 0, consistent with the frozen source.

### 5.2 Row-level, column-level, cryptographic hash comparison

**40/41 checked tables: full row-and-column SHA-256 hash MATCH** (every column, every row — not just counts), including the chunk-restored `data_imports` row and `giving_activities`' full 5,463 rows.

**1 reported "MISMATCH" — `users` — expected and correct, not a defect.** `row-level-hash-compare.mjs` was built for the rehearsal, where `users` is always restored fresh and should match source exactly. For this real cutover, `users` was deliberately **excluded** from the restore (Section 4) — Production kept its own pre-existing row. Direct comparison confirms why source and target differ: `id`/`email` match exactly (`user_sgoldstein@nirc.edu` / `sgoldstein@nirc.edu` — the same deterministic identity, migration audit Section 4.6), but `name`, `preferred_first_name`, `organization_name`, `household_import_review_mode`, `created_at`, and `updated_at` differ, because Staging's and Production's `users` rows were always two independently-created, independently-configured rows that merely share the same deterministic id — never copied from one to the other. **This "mismatch" is proof the exclusion worked correctly**, not evidence of a problem. The script's own general-purpose design doesn't know about this real-cutover-specific exclusion; this report documents the one place a human must read its output with that context rather than take "MISMATCH" at face value.

### 5.3 Primary keys, foreign keys, ownership, application-level orphans

| Check | Result |
|---|---|
| Duplicate primary keys (`giving_activities`, `donors`) | 0 |
| `PRAGMA foreign_key_check` | 0 violations |
| `donors`/`giving_activities` rows with unresolved `owner_user_id` | 0 / 0 — every ownership FK resolves correctly against **Production's own pre-existing, untouched** `users` row |
| Orphaned `gift_acknowledgments` (application-level, not FK-enforced) | 0 |
| Orphaned `jl_payment_assignments.pledge_activity_id` | 0 |
| Orphaned `pledge_payment_plans` / `pledge_balance_corrections` | 0 / 0 |
| Orphaned `giving_activity_import_changes.import_id` | 0 |

## 6. Financial reconciliation

| Figure | Production (cents) | Production (dollars) | Matches frozen source? |
|---|---:|---:|---|
| Rows counted (active, live) | 5,461 | — | yes |
| Committed | 402,429,680 | $4,024,296.80 | **exact** |
| Paid | 384,791,565 | $3,847,915.65 | **exact** |
| Raw outstanding balance | 17,638,115 | $176,381.15 | **exact** |
| Corrected outstanding balance | 17,617,115 | **$176,171.15** | **exact** |
| Internal-consistency failures | 0 | — | — |
| Active `pledge_balance_corrections` | 1 | — | yes |
| Net correction effect | -21,000 | -$210.00 | yes |

**Every figure reconciles to the cent.**

### Duplicate-record preservation

| Record | `workspace_status` | Committed | Paid | Balance | Counted in totals above? |
|---|---|---:|---:|---:|---|
| Goldman `1c3f3d51-4a28-42f5-a3ee-105bc245d7f5` | **`duplicate`** (unchanged) | $500.00 | $500.00 | $0.00 | No — correctly excluded |
| Gluck `5e29f6c5-b599-4227-9ab8-fc50e7415f28` | **`duplicate`** (unchanged) | $10.00 | $10.00 | $0.00 | No — correctly excluded |

The negative check (`workspace_status='active' AND id IN (...)`) returned **0** — neither flag was reactivated by the import. Goldman's linked `gift_acknowledgments` row (`23061ede-...`, `status='thank_you_sent'`) is present and intact.

## 7. Production account protection

| Field | Before migration | After migration | Changed? |
|---|---|---|---|
| `id` | `user_sgoldstein@nirc.edu` | `user_sgoldstein@nirc.edu` | No |
| `email` | `sgoldstein@nirc.edu` | `sgoldstein@nirc.edu` | No |
| `name` | `sgoldstein@nirc.edu` | `sgoldstein@nirc.edu` | No |
| `preferred_first_name` | `sgoldstein@nirc.edu` | `sgoldstein@nirc.edu` | No |
| `organization_name` | `null` | `null` | No |
| `job_title` | `null` | `null` | No |
| `timezone` | `America/New_York` | `America/New_York` | No |
| `household_import_review_mode` | `auto_unchanged` | `auto_unchanged` | No |
| `created_at` | 1791727573 | 1791727573 | No |
| `updated_at` | 1791735238 | 1791735238 | **No — not even this moved** |
| `onboarding_preferences` row count | 0 | 0 | No |
| `backup_alert_state` row count | 0 | 0 | No |
| `production_schema_baseline` marker | `id='0019'`, hash `9132996...` | `id='0019'`, hash `9132996...` | No |

**Every field byte-identical before and after — no account setting or credential was overwritten.** (The `users` table itself carries no credential-shaped column in this schema; authentication is handled entirely outside this table.)

## 8. Application verification

- **Schema compatibility:** unaffected by this round — Production's schema was never modified (confirmed identical before/after, Section 2/7). The application reads the exact same DDL shape it already read before the migration.
- **Financial-reporting logic:** the canonical, previously-verified-consistent formula (`workspace_status='active' AND record_origin='live'`, with the `pledge_balance_corrections` COALESCE override — `docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md` Section 15.2) was re-run directly against Production post-import and reproduces the exact correct figures (Section 6) — the same query every reporting surface in the application already uses.
- **No Worker was deployed or redirected to Production at any point in this round.** Production remains not reachable by the deployed application in a way that writes donor data until a separate deployment decision is made.

## 9. Discrepancies and limitations

1. **The `users`-table hash "MISMATCH" (Section 5.2)** — expected and explained; not a defect.
2. **Backup-status tooling (preflight item 7)** — `gh` CLI and `wrangler r2 object get` were both unavailable/broken in this execution environment; worked around via the GitHub REST API directly rather than skipped. No functional gap in the actual backup pipeline was found — only in this session's own tooling access.
3. **Staging-pause verification (preflight item 9)** — necessarily a proxy (no drift observed in a ~5-minute window), not a literal confirmation of the owner's own application usage. No evidence of any conflicting activity was found.

**No other discrepancy of any kind was found.**

## 10. Final status: **SUCCESS**

## 11. Remaining steps before regular Production use

1. **Owner-facing application verification** — log into Production through the actual deployed application (not just raw SQL) and confirm donor records, giving history, and financial dashboards render correctly. This round verified the data and the query logic independently; it did not click through the live UI.
2. **Formal designation** — once step 1 passes, Production becomes the primary working environment; Staging should be clearly labeled a non-authoritative testing environment going forward (not done automatically by this round, per the task's explicit instruction not to switch Staging off or redeploy without separate authorization).
3. **Future donor updates/imports** — until a separate decision is made and documented, the JL-import pipeline and any manual data entry should be deliberately pointed at Production (not Staging) once step 1 passes; this round does not change where the deployed application's `env.DB` binding points, since that is a deployment/configuration change explicitly out of scope here.
4. **No automated backup schedule was enabled or altered** by this round, per the explicit restriction — Production's existing nightly backup workflow (already operational, confirmed in Section 2 item 7) continues unchanged and will now begin capturing real donor data on its normal schedule.

---

Stopping here, per explicit instruction. No unrelated Production change was made. Staging was never modified. Awaiting the owner's own application-level verification before Production is treated as fully operational for daily use.
