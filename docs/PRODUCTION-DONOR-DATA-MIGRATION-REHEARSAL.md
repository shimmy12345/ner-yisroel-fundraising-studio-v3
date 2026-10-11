# Production Donor-Data Migration Rehearsal — Execution Report

**Date:** 2026-10-11
**Status:** EXECUTED, under explicit owner authorization, against a temporary, isolated Cloudflare D1 database. The rehearsal database has been deleted. Independent Staging and Independent Production were never written to. No application code was deployed, no Worker binding was added for the rehearsal database, no GitHub Actions schedule or secret was changed, and no donor data was migrated into Production.

**Recommendation: PASS.**

---

## 1. Authorization and scope

Executed under the owner's explicit authorization to create, populate, validate, and delete a temporary, isolated D1 rehearsal database to test the Staging→Production migration, confirming: Independent Staging is the authoritative current dataset; donor data will keep growing over time; both duplicate-flagged giving activities must be preserved unchanged; all 48 migration tables must be verified at the row level. This authorization explicitly excluded modifying Staging/Production, deploying code, enabling backup schedules, or executing the real migration — none of those were done.

## 2. Pre-execution review

Read before executing anything: `docs/AI-HANDOFF.md`, `docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md`, `docs/PRODUCTION-BACKUP-WATCHDOG-DEPLOYMENT-VERIFICATION.md`, `lib/operations/d1-restore-order.ts`, and every script under `scripts/migration-audit/`.

**Confirmed exact database identities** (`wrangler d1 list --json`, re-run live at execution time):

| Database | Name | UUID |
|---|---|---|
| Staging (source) | `fundraising-os-staging-db` | `6c18396c-0a8f-4f2c-ba83-ea809ec10289` |
| Production | `fundraising-os-production-db` | `a51c6571-ae16-4614-aa9a-08f8e6be3ecd` |

Exactly these two databases existed before this round. **No ambiguity found** — the rehearsal database (created below) got a third, newly-minted UUID, unmistakably distinct from both.

## 3. Source snapshot

| Field | Value |
|---|---|
| Source database | `fundraising-os-staging-db` (`6c18396c-0a8f-4f2c-ba83-ea809ec10289`) |
| Method | `wrangler d1 export --remote` (live fallback export — the audit's Section 8.3 default when no sufficiently recent decrypted R2 backup was available in this session) |
| Snapshot window | 2026-10-11T23:05:03Z (export requested) – 2026-10-11T23:05:09Z (download complete) |
| Export size | 7.8 MB, 14,181 lines, 54 `CREATE TABLE` statements, 13,390 `INSERT` statements |
| Frozen-source row counts | Parsed directly from the export file itself (never re-queried against live Staging after the fact, to eliminate any race between export time and verification time) |

Staging was never modified, deleted, frozen, or locked — `wrangler d1 export` is a read-only operation. The export file and every file derived from it were written only to a local, session-scoped scratch directory **outside the git working tree**, never committed, and securely removed at the end of this round (Section 8).

## 4. Isolated rehearsal database

| Field | Value |
|---|---|
| Name | `fundraising-os-migration-rehearsal-20261011` |
| UUID (recorded) | `04b60cb0-745a-44ad-8480-b2da6231eab3` |
| Created | 2026-10-11T23:08:24Z |
| Deleted | 2026-10-11T23:30:27Z (confirmed via `wrangler d1 list` immediately after — only the original two databases remained) |
| Worker binding | **None added, anywhere** — no `wrangler.jsonc`/`wrangler.production.jsonc` was touched |

**Pre-import confirmation (per the task's required checklist):**
- Separate from Staging and Production: **yes** — a distinct, newly-created UUID, confirmed via a fresh `d1 list` before and after creation.
- Schema matches intended Production schema: **confirmed** (Section 5).
- Account references valid: **confirmed** (Section 7, ownership/FK section) — resolves the rehearsal plan's own previously-unresolved "synthetic user" question (see `docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md` Section 15.4): the rehearsal received the **one real, deterministic `users` row** (`id='user_sgoldstein@nirc.edu'`), not a synthetic one, because every `ownerUserId`/`userId` foreign key in the 48 MIGRATE tables already points at that exact id and the `users` table carries no credential-shaped column. Production's own existing owner account/row was never read, copied, or modified by this.
- Staging and Production remain untouched: **confirmed** throughout (Section 9).

Schema was applied from `production-baseline/drizzle/0000_production_baseline_0019.sql` — the same artifact that bootstraps real Production. Despite its filename, this file was confirmed (by direct inspection) to already contain all 54 current `CREATE TABLE` statements through migration `0042_pledge_balance_corrections.sql` — not a stale, pre-0020 schema — so no additional migration needed to be layered on top of it for a faithful rehearsal.

## 5. Schema verification

| Check | Result |
|---|---|
| Schema objects present | 137 |
| Matches `PRODUCTION_BASELINE_OBJECTS` (`lib/data-health/production-baseline.ts`'s `compareSchemaObjects`) | **true** — byte-identical, 0 differences |
| `production_schema_baseline` marker | `id='0019'`, `schema_hash` matches `PRODUCTION_BASELINE_HASH` exactly |

## 6. Restore execution

**Mechanism:** the repository's own dependency-safe restore order (`lib/operations/d1-restore-order.ts`'s `D1_RESTORE_DATA_ORDER`), filtered for the rehearsal per the audit's Section 8.4/15.4: `production_schema_baseline`, `onboarding_preferences`, and `backup_alert_state` excluded (the first gets its own fresh marker from the baseline schema file; the other two are account-config tables nothing references by FK); `users` **kept** (the one real row, needed for FK resolution — Section 4 above); `import_preview_sessions`/`import_preview_session_chunks` skipped per the already-established, already-documented ephemeral-cache exclusion (`D1_RESTORE_SKIP_DATA_TABLES`).

**Restore window:** 2026-10-11T23:10:12Z – 2026-10-11T23:13:30Z. 41 tables with data restored via `wrangler d1 execute --remote --file=...`, in dependency order, one table at a time. **Zero failures.**

**Oversized-row handling (new finding this round):** the frozen export contained **one** single-row `INSERT` (`data_imports.report_json`, 161,828 bytes) exceeding D1's bulk-import inline-statement-length ceiling (`D1_SAFE_STATEMENT_BYTES` = 65,536 bytes; the real empirical ceiling is ~100–102KB, per `d1-restore-order.ts`'s own history). The already-built fix for this (`parameterizeInsertStatement` + the D1 HTTP query API's `{sql,params}` path) requires a bare `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, which this execution environment does not expose (it authenticates to `wrangler` via a cached OAuth session instead). **Resolved without that dependency**, using only `wrangler d1 execute` (already in use for everything else): insert the row with that one column empty, then append the value in five ~40KB pieces via repeated `report_json = report_json || '<chunk>'` `UPDATE`s. Row-level hash comparison (Section 7) proves the final restored value is byte-identical to the source. This technique is now captured in `scripts/migration-audit/build-rehearsal-restore-files.mjs` for reuse — **no row was silently omitted or left unverified.**

## 7. Full data-integrity verification (Section 6.A of the authorization)

### 7.1 Row counts, all 48 migration-eligible tables

All 48 MIGRATE tables reconciled exactly against the frozen source: 40 tables with data matched row-for-row; the remaining 8 (`gifts`, `donor_merge_audits`, `activity_status_audits`, `sample_cleanup_audits`, `legacy_test_cleanup_audits`, `data_health_repair_audits`, `household_import_rollback_audits`, `donation_import_rollback_audits`) were confirmed empty (0 rows) in both the frozen source and the rehearsal database — consistent with the migration audit's own "moot — empty" classification, explicitly re-verified rather than assumed. The `users` account-config table (restored deliberately, Section 4) matched 1-for-1. The 5 tables excluded by the approved plan (`production_schema_baseline`, `onboarding_preferences`, `backup_alert_state`, `import_preview_sessions`, `import_preview_session_chunks`) were each confirmed in their **intended, by-design** post-restore state (own fresh marker / empty / empty), never silently omitted from the check. **Zero mismatches across 48/48 tables.**

### 7.2 Row-level, column-level, cryptographic comparison (not just counts/totals)

Per the explicit instruction not to rely solely on financial totals or a small column selection: every column of every row of all 41 non-excluded tables with data was hashed (SHA-256 of a deterministic, fixed-column-order JSON serialization — NULLs normalized, numeric and string types canonicalized consistently) from **both** the frozen source export and the restored rehearsal database, and the two sorted hash multisets compared.

**Result: 41/41 tables, full row-and-column hash match.** This includes `giving_activities` (5,463/5,463 rows, every column), `data_imports` (17/17, including the chunk-restored oversized row — proving the chunking technique in Section 6 reproduced the value byte-for-byte), and `interactions` (203/203, including 25 rows with embedded-newline values that the export represents as a `replace(...,char(10))` SQL expression rather than a plain literal — correctly evaluated rather than skipped).

Two gaps were found and fixed **in this round's own verification tooling** before trusting its output (documented transparently, not swept under the rug): the column-extraction regex initially missed `important_dates`/`shared_activities` (which use `CREATE TABLE IF NOT EXISTS "name"` rather than the backtick-table-name style used elsewhere in the same export — fixed to handle both); and 25 `interactions` rows initially compared as "unevaluated" because their embedded-newline values were represented as SQL expressions, not literals — fixed by adding a narrow, fail-loud evaluator for exactly the `replace(...,char(10))` shape actually observed (never a silent guess for anything else). Both fixes are reflected in the committed script.

### 7.3 Primary-key uniqueness, foreign-key integrity, orphan detection, ownership

| Check | Result |
|---|---|
| Duplicate primary keys (`giving_activities`, `donors`) | 0 |
| `PRAGMA foreign_key_check` | **0 violations** across 13,395 FK-checked rows |
| `donors`/`giving_activities` rows with an `owner_user_id` not resolving to the real `users` row | 0 / 0 |
| Orphaned `gift_acknowledgments` (application-level reference, **not** FK-enforced — `giftId` has no `.references()` in `db/schema.ts`) | 0 |
| Orphaned `jl_payment_assignments.pledge_activity_id` | 0 |
| Orphaned `pledge_payment_plans`/`pledge_balance_corrections` | 0 / 0 |
| Orphaned `giving_activity_import_changes.import_id` | 0 |
| `PRAGMA integrity_check` | **Blocked by D1's own query-API policy** ("not authorized: SQLITE_AUTH") in this environment — not something this round could control or work around. Not treated as a missing required check: the task's own Section 6.A list does not name `integrity_check` specifically, and the row-level hash match (7.2) plus the FK/PK checks above independently verify the properties this PRAGMA would otherwise speak to. Documented here rather than silently dropped. |

## 8. Financial integrity (Section 6.B of the authorization)

Re-ran the audit's own canonical reconciliation query (`workspace_status='active' AND record_origin='live'`, with the active `pledge_balance_corrections` override applied) against the rehearsal database:

| Figure | Rehearsal (cents) | Rehearsal (dollars) | Matches audit's live-Staging figure? |
|---|---:|---:|---|
| Rows counted | 5,461 | — | yes |
| Committed | 402,429,680 | $4,024,296.80 | **yes, exact** |
| Paid | 384,791,565 | $3,847,915.65 | **yes, exact** |
| Raw outstanding balance | 17,638,115 | $176,381.15 | **yes, exact** |
| Corrected outstanding balance | 17,617,115 | **$176,171.15** | **yes, exact** |
| Internal-consistency failures (`balance ≠ committed − paid`) | 0 | — | yes |
| Active `pledge_balance_corrections` | 1 | — | yes |
| Net correction effect | -21,000 | -$210.00 | yes (the Kutoff/DIN2023 case) |

**Every figure reconciles to the cent against the frozen source — not approximately.**

### Duplicate-record preservation (both specifically required by the owner)

| Record | `workspace_status` | Committed | Paid | Balance | Counted in the totals above? |
|---|---|---:|---:|---:|---|
| Goldman `1c3f3d51-4a28-42f5-a3ee-105bc245d7f5` | **`duplicate`** (unchanged) | $500.00 | $500.00 | $0.00 | No — correctly excluded by the application's own existing `workspace_status='active'` rule |
| Gluck `5e29f6c5-b599-4227-9ab8-fc50e7415f28` | **`duplicate`** (unchanged) | $10.00 | $10.00 | $0.00 | No — correctly excluded |

Neither flag was modified by the restore. The negative check (`workspace_status='active' AND id IN (...)`) returned **0** — confirming the restore process itself never silently reactivated either row. Goldman's linked `gift_acknowledgments` row (`23061ede-...`, `status='thank_you_sent'`) is present and intact in the rehearsal database, unchanged, exactly as the owner's decision required.

## 9. Application compatibility (Section 6.C of the authorization)

Verified read-only, without deploying or redirecting any Worker to the rehearsal database:
- Schema byte-identical to the packaged production baseline (Section 5) — the strongest available proxy for "the application's code, which is schema-shape-dependent, would read this correctly."
- The application's own canonical financial-reporting formula (`workspace_status='active' AND record_origin='live'`, with the `pledge_balance_corrections` LEFT JOIN/COALESCE override — the exact rule verified consistently applied across every reporting surface in the prior round's code audit, `docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md` Section 15.2) reproduces the correct, exact figures against the restored data (Section 8).

No Worker was deployed or redirected to this database at any point.

## 10. Failure handling

No verification failed. Two tooling gaps were found and fixed in this round's own scripts before they could produce a false result (Section 7.2) — these were caught, root-caused, and corrected through read-only investigation of the export's own structure, never by altering donor data or silently discarding a discrepancy. The one true execution-environment limitation (the oversized-row ceiling, Section 6) was resolved with an alternative, verified-correct technique rather than skipped. The one blocked check (`PRAGMA integrity_check`, Section 7.3) is a platform/API-policy restriction, documented rather than hidden, and is not among the specifically required checks.

## 11. Cleanup

| Action | Status |
|---|---|
| Rehearsal database deleted (`wrangler d1 delete fundraising-os-migration-rehearsal-20261011 -y`) | **Confirmed** — `wrangler d1 list` immediately after shows only the original `fundraising-os-staging-db` and `fundraising-os-production-db`, with unchanged `file_size` values, confirming neither was touched by this round |
| Local scratch files (export, per-table restore SQL, manifests) removed | **Confirmed** — entire session-scratch directory deleted (`rm -rf`) after this report's figures were captured |
| Note on secure deletion | This environment (Windows/Git Bash) does not provide the Linux CI pipeline's `shred -u` cryptographic-erase guarantee. Cleanup here is ordinary filesystem deletion of files that lived only in a session-scoped temp directory, never git-tracked and never reachable outside this session. Stated plainly rather than overclaiming a stronger guarantee. |
| Staging modified? | **No.** |
| Production modified? | **No.** |
| Any Worker deployed/redirected? | **No.** |
| Any GitHub Actions schedule/secret changed? | **No.** |

## 12. Recommendation: PASS

Every required check in Sections 6.A/6.B/6.C of the authorization passed: all 48 migration tables reconcile exactly at the row level (40 with data, byte-for-byte hash-verified; 8 confirmed empty); financial totals reconcile to the cent; both duplicate-flagged giving activities and Goldman's acknowledgment survive unchanged and un-reactivated; foreign-key integrity, primary-key uniqueness, and every application-level (non-FK-enforced) reference checked are clean; ownership resolves correctly against the real deterministic owner id without touching Production's own account row; schema is byte-identical to the production baseline. The one new oversized-row obstacle this rehearsal encountered was solved, not worked around with a shortcut, and the fix is now a reusable, committed script. The rehearsal database and every local scratch file have been removed; Staging and Production are confirmed untouched.

## 13. Remaining steps before a real Production migration

This PASS authorizes **nothing beyond this rehearsal.** Before a real cutover:

1. **Confirm Staging is the sole current system of record** (open owner decision #1, `docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md` Section 13) — must be resolved before cutover, not just before rehearsal, since a rehearsal never writes to Staging/Production but a real cutover does.
2. **Approve the cutover-timing mitigation** (a short owner-coordinated pause in Staging usage during the real copy window) or propose an alternative.
3. **Re-run this entire audit's reconciliation baseline immediately before the real cutover** — today's and this rehearsal's figures will be stale by then, since Staging continues to change daily (the owner has already confirmed more donor data will keep being added).
4. **If a real migration will also need the oversized-row technique**, either provision `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` to use the originally-designed parameterized-HTTP-API path, or reuse this round's chunked-UPDATE technique (`scripts/migration-audit/build-rehearsal-restore-files.mjs`) — both are now proven; pick one deliberately rather than assuming either by default.
5. **A real migration still requires its own separate, explicit owner authorization** — this rehearsal's PASS is evidence the mechanism works, not a substitute for that authorization.

---

Stopping here, per explicit instruction. No data was migrated into Production, no application code was deployed, and no further action was taken beyond this rehearsal and its documentation. Awaiting independent review and separate explicit owner authorization before any real Production migration.
