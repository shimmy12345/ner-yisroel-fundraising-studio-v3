# Production Donor-Data Migration Audit & Rehearsal Plan

**Date:** 2026-10-11
**Status:** READ-ONLY AUDIT AND PLANNING ONLY. No migration was executed, no rehearsal database was created, no existing database was modified, no code was deployed. Every number in this document was produced by a read-only `SELECT`/`PRAGMA *_check` query run fresh today against the live `fundraising-os-staging-db` and `fundraising-os-production-db`, or by direct inspection of the current schema/migration/script source. The exact queries are preserved in `scripts/migration-audit/` (see Section 9).

---

## 1. Executive summary

Independent Staging's `fundraising-os-staging-db` holds **254 donors** and **5,463 giving-activity records** (committed $4,024,296.80 / paid $3,847,915.65 / outstanding $176,171.15 after the one active manual balance correction), all flagged by the application's own `dataSource`/`recordOrigin` columns as real (`"live"`) data — zero sample/test/demo records. Independent Production's `fundraising-os-production-db` is confirmed empty of donor/financial data (`donors=0`, every fundraising table `=0`) except the owner's own single account row and the schema-baseline marker, both of which must be preserved untouched.

Schema compatibility is **confirmed, live, byte-for-byte identical** between the two databases (137/137 schema objects match exactly) — no transformation is required. Foreign-key integrity is clean in both databases (0 violations). A fully proven, already-tested dependency-safe restore/reordering mechanism (`lib/operations/d1-restore-order.ts`) already exists in this codebase and is the recommended basis for the rehearsal, rather than a new mechanism.

**No blocking defect was found in the source data itself.** The findings below are two small, named exceptions (2 giving-activity rows the application itself flags `workspace_status='duplicate'`) requiring an explicit owner decision, plus a handful of process gaps (no application-level maintenance/freeze mode; the fresh pre-cutover audit and owner sign-off steps identified in the 2026-10-09 predecessor audit have not yet been repeated at migration time). **Audit result: READY FOR REHEARSAL**, subject to the open owner decisions in Section 13 — this document does not itself authorize the rehearsal.

---

## 2. Source-of-truth assessment

**Confirmed fact (live-verified):** Independent Staging's `fundraising-os-staging-db` is the only database in this application holding real donor/fundraising data today. Independent Production holds none. There is no second D1 database, no third environment, and no in-app reference to any other currently-queried datastore.

**Confirmed fact (code/schema inspection):** every historical import source this application knows about is an *upstream feed already ingested into Staging's own tables* through Staging's own in-app import pipeline, not a separate, currently-authoritative system of record:

| Source (as named in code/migrations) | What it fed | Where it landed |
|---|---|---|
| "JL" (the donation/pledge platform this app imports from) | Donations, pledges, payments | `giving_activities`, `jl_payment_assignments`, `jl_payment_assignment_audits`, `jl_refresh_state` |
| Monday.com | Household/contact records, historical notes, reminders | `household_import_changes`, `donor_historical_context`, `recommendations` |
| DOB spreadsheet import (`lib/import/dob-pipeline.ts`) | Donor birthdays | `important_dates` (`source='import-dob'`) |
| Yahrtzeit workbook import | Yahrtzeit dates | `yahrtzeits` (`source='import-yahrtzeit-workbook'`) |
| Donor-code/Rebbeim bulk import | Donor↔clergy relationships | `donor_rebbeim` (`source='bulk_import'`) |

No code path, schema reference, environment variable, or documentation file found in this repository points at any other currently-live donor-management system, legacy database, or external spreadsheet still being written to. This conclusion is **based on what this repository's code and documentation can show** — it cannot rule out a parallel system maintained entirely outside this codebase (e.g., a spreadsheet staff still updates by hand). **This residual uncertainty is reported as an open owner decision (Section 13, #1), not silently assumed away.**

**Confirmed fact (live-verified):** no unresolved synchronization/import issue was found. Every donor-code and email value is unique (both DB-enforced by a `UNIQUE` index and independently re-confirmed by direct query), zero duplicate `source_fingerprint` values are possible by construction (enforced by `giving_activities_owner_source_fingerprint_unique`), and `PRAGMA foreign_key_check` returns zero violations against the live Staging database.

**Confirmed fact (live-verified):** Staging's own `dataSource`/`recordOrigin` columns — the application's own mechanism for flagging non-production-worthy data — show **zero** sample, demo, or verification-origin records anywhere in `donors` or `giving_activities` today (see Section 6).

**Conclusion:** Independent Staging is the authoritative source for the intended initial Production migration. No other source was found and none is assumed to exist beyond what was checked.

---

## 3. Complete table inventory

All 54 real application tables, confirmed identical by name in both databases (`SELECT name FROM sqlite_master WHERE type='table'`, excluding SQLite/Cloudflare internal tables). Counts are live, from today's queries (`scripts/migration-audit/table-row-counts.mjs`).

Legend for **Classify**: **MIGRATE** = candidate for the real migration; **PRESERVE** = must keep Production's own existing row(s) untouched, never overwritten by anything from Staging; **EXCLUDE (ephemeral)** = real data in Staging, deliberately not carried over, matching an existing, already-documented precedent in this codebase; **REVIEW** = small table, migrate-or-regenerate is a legitimate judgment call either way (not a blocker).

The **Kind** column mirrors this codebase's own canonical classification (`lib/data-health/production-baseline.ts`'s `ACCOUNT_CONFIGURATION_TABLES` / `FUNDRAISING_DATA_TABLES`, and `lib/operations/d1-restore-order.ts`'s `D1_RESTORE_SKIP_DATA_TABLES`) — this audit did not invent a new taxonomy.

| Table | Purpose | Staging rows | Production rows | Kind | Classify | Depends on |
|---|---|---:|---:|---|---|---|
| production_schema_baseline | Schema-verification marker (one row, the packaged manifest's hash) | 1 | 1 | Schema marker | **PRESERVE** | — |
| users | Account record (owner login) | 1 | 1 | Account config | **PRESERVE** | — |
| onboarding_preferences | Per-user UI onboarding flags | 1 | 0 | Account config | **PRESERVE**/REVIEW | users |
| backup_alert_state | Backup-alert-email dedupe state (operational) | 0 | 0 | Account config | **PRESERVE** | users |
| donors | Donor profiles | 254 | 0 | Business data | **MIGRATE** | users |
| data_imports | Import-batch audit history | 17 | 0 | Business data | **MIGRATE** | users |
| giving_activities | Gifts/pledges/payments ledger (authoritative financial data) | 5,463 | 0 | Business data | **MIGRATE** | donors |
| shared_activities | Parent record for one outreach logged to multiple donors | 8 | 0 | Business data | **MIGRATE** | users |
| interactions | Donor contact/interaction log | 203 | 0 | Business data | **MIGRATE** | donors, users, shared_activities |
| rebbeim | Clergy directory | 43 | 0 | Business data | **MIGRATE** | users |
| donor_rebbeim | Donor↔clergy relationship links | 138 | 0 | Business data | **MIGRATE** | donors, rebbeim |
| donor_source_attributions | Suggested third-party-payer→donor mapping | 1 | 0 | Business data | **MIGRATE** | users, donors |
| household_import_rollback_audits | Undo-log for a household import batch | 0 | 0 | Audit/operational | **MIGRATE** | users |
| giving_activity_management_audits | Audit trail of manual giving-activity edits | 2 | 0 | Audit/operational | **MIGRATE** | users |
| giving_activity_import_changes | Undo-log for one import's giving-activity changes | 5,581 | 0 | Audit/operational | **MIGRATE** | data_imports |
| donation_import_rollback_audits | Undo-log for a donation import batch | 0 | 0 | Audit/operational | **MIGRATE** | users |
| household_import_changes | Per-donor change record from a household import | 254 | 0 | Audit/operational | **MIGRATE** | users |
| jl_payment_assignments | Current payment→pledge/gift assignment decisions | 90 | 0 | Business data | **MIGRATE** | users, giving_activities |
| jl_payment_assignment_audits | Audit trail of payment-assignment decisions | 91 | 0 | Audit/operational | **MIGRATE** | users, donors, giving_activities |
| donor_research_runs | Donor-research session records | 1 | 0 | Business data | **MIGRATE** | — |
| donor_research_sources | Shared research-source pool | 1 | 0 | Business data | **MIGRATE** | — |
| donor_research_pending_evidence | Unconfirmed research evidence (pre-identity-match) | 1 | 0 | Business data | **MIGRATE** | — |
| donor_research_identity_candidates | Candidate donor-identity matches for research evidence | 1 | 0 | Business data | **MIGRATE** | — |
| donor_research_findings | Confirmed research findings | 1 | 0 | Business data | **MIGRATE** | donors |
| donor_research_finding_sources | Finding↔source links | 1 | 0 | Business data | **MIGRATE** | donor_research_findings, donor_research_sources |
| important_dates | Birthdays/anniversaries | 177 | 0 | Business data | **MIGRATE** | donors, users |
| important_date_changes | Audit trail for important_dates | 181 | 0 | Audit/operational | **MIGRATE** | donors, users |
| yahrtzeits | Yahrtzeit dates | 40 | 0 | Business data | **MIGRATE** | donors, users |
| yahrtzeit_changes | Audit trail for yahrtzeits | 63 | 0 | Audit/operational | **MIGRATE** | donors, users |
| relationship_queue_dismissals | Per-user "today" queue dismissal state | 18 | 0 | Operational/UI state | **MIGRATE**/REVIEW | users, donors |
| recommendations | Fundraiser task/reminder suggestions | 5 | 0 | Business data | **MIGRATE**/REVIEW | donors, users |
| gifts | Legacy simple-gift model (superseded by giving_activities) | 0 | 0 | Business data | **MIGRATE** (moot — empty) | donors |
| gift_acknowledgments | Thank-you tracking for gifts/giving activities | 56 | 0 | Business data | **MIGRATE** | donors, users |
| donor_views | Per-user "recently viewed donor" log | 131 | 0 | Operational/UI state | REVIEW | users, donors |
| donor_merge_audits | Audit trail of donor-merge operations | 0 | 0 | Audit/operational | **MIGRATE** (moot — empty) | users, donors |
| donor_historical_context | Unconfirmed historical notes imported from Monday.com | 159 | 0 | Business data | **MIGRATE** | donors |
| donor_contact_audits | Audit trail of donor-contact-field edits | 7 | 0 | Audit/operational | **MIGRATE** | users, donors |
| donor_relationship_facts | Durable accepted relationship facts | 12 | 0 | Business data | **MIGRATE** | donors, users |
| donor_relationship_fact_changes | Audit trail for donor_relationship_facts | 12 | 0 | Audit/operational | **MIGRATE** | donor_relationship_facts, users, donors |
| pledge_balance_corrections | Manual pledge-balance correction overlay | 1 | 0 | Business data | **MIGRATE** | users, donors, giving_activities |
| pledge_payment_plan_reviews | Pledge-cleanup manual review decision | 22 | 0 | Business data | **MIGRATE** | users, giving_activities |
| pledge_payment_plans | Monthly payment-plan stewardship metadata | 45 | 0 | Business data | **MIGRATE** | users, donors, giving_activities |
| pledge_payment_plan_changes | Audit trail for pledge_payment_plans | 104 | 0 | Audit/operational | **MIGRATE** | pledge_payment_plans, users, donors |
| asks | Solicitation/ask tracking | 6 | 0 | Business data | **MIGRATE** | users, donors |
| ask_changes | Audit trail for asks | 12 | 0 | Audit/operational | **MIGRATE** | asks, users, donors |
| shared_activity_recipient_audits | Audit trail for shared-activity recipient add/remove | 179 | 0 | Audit/operational | **MIGRATE** | shared_activities, donors, users |
| activity_status_audits | Audit trail for interaction status transitions | 0 | 0 | Audit/operational | **MIGRATE** (moot — empty) | interactions, users |
| import_preview_sessions | Short-lived cached parsed-import-file rows | 1 | 0 | Ephemeral cache | **EXCLUDE (ephemeral)** | users |
| import_preview_session_chunks | Chunked row data for an import_preview_sessions row | 1 | 0 | Ephemeral cache | **EXCLUDE (ephemeral)** | import_preview_sessions |
| workspace_backup_audits | Audit trail of the secondary JSON-export route's use | 1 | 0 | Audit/operational | **MIGRATE** | users |
| sample_cleanup_audits | Audit trail of a sample-data cleanup operation | 0 | 0 | Audit/operational | **MIGRATE** (moot — empty) | users |
| legacy_test_cleanup_audits | Audit trail of a legacy/test-record cleanup operation | 0 | 0 | Audit/operational | **MIGRATE** (moot — empty) | users |
| jl_refresh_state | Per-user last-JL-refresh timestamps | 1 | 0 | Operational state | **MIGRATE**/REVIEW | users |
| data_health_repair_audits | Audit trail of data-health repair actions | 0 | 0 | Audit/operational | **MIGRATE** (moot — empty) | users |

**Totals:** 54 tables; 6 PRESERVE/EXCLUDE (`production_schema_baseline`, `users`, `onboarding_preferences`, `backup_alert_state`, `import_preview_sessions`, `import_preview_session_chunks`); 48 MIGRATE candidates (several currently empty in Staging, listed "moot" above — schema still needs to exist in Production, which it already does).

---

## 4. Record counts and reconciliation baselines

All queries below are preserved verbatim in `scripts/migration-audit/reconciliation-baselines.sql`; every one was run fresh today against both live databases.

### 4.1 Donor data quality (Staging)

| Check | Result |
|---|---|
| Total donors | 254 |
| `dataSource='live'` | 254 (100%) |
| `dataSource='sample'` | 0 |
| Archived (`archivedAt IS NOT NULL`) | 0 |
| Merged away (`mergedIntoDonorId IS NOT NULL`) | 0 |
| No owner assigned | 0 |
| Distinct, non-null `externalId` | 254 of 254 |
| Distinct `displayName` | 254 of 254 |
| Duplicate email (excl. NULL) | 0 groups |
| Duplicate `donorCode` (excl. NULL) | 0 groups |

### 4.2 Giving-activity data quality (Staging)

| Check | Result |
|---|---|
| Total rows | 5,463 |
| `recordOrigin='live'` | 5,463 (100%) |
| `recordOrigin='sample'`/`'verification'` | 0 |
| `workspaceStatus='active'` | 5,461 |
| `workspaceStatus='duplicate'` | **2** — see exception register, Section 7 |
| Other `workspaceStatus` values (`hidden`/`needs_review`/`invalid`/`merged`) | 0 |
| No owner assigned | 0 (of the 5,461 active+live rows) |
| Null `activityDate` | 0 (of the 5,461 active+live rows) |
| `activityDate` range | 1973-07-19 to 2029-04-21 (wide but plausible: historical gifts at one end, scheduled future pledge installments at the other) |

### 4.3 Financial reconciliation (Staging, `workspace_status='active' AND record_origin='live'`, 5,461 rows)

Exact integer-cents arithmetic throughout; no float used anywhere in these queries or in the schema itself.

| Figure | Cents | Dollars |
|---|---:|---:|
| Sum committed | 402,429,680 | $4,024,296.80 |
| Sum paid | 384,791,565 | $3,847,915.65 |
| Sum outstanding balance, **raw** (`giving_activities.balance_cents`) | 17,638,115 | $176,381.15 |
| Sum outstanding balance, **corrected** (active `pledge_balance_corrections` override applied) | **17,617,115** | **$176,171.15** |
| Active balance corrections | 1 | — |
| Net correction effect | -21,000 | -$210.00 |
| Internal-consistency check: rows where `balance_cents ≠ committed_cents - paid_cents` | **0** | — |

The **corrected** figure ($176,171.15) is the authoritative outstanding-pledge-balance total — it is what the application itself displays everywhere, per `db/schema.ts`'s own documented rule (`LEFT JOIN pledge_balance_corrections ... WHERE reversed_at IS NULL`, then `COALESCE(corrected_balance_cents, balance_cents)`). This audit never invented a second, divergent formula.

**Independent cross-validation:** the prior migration-planning audit (`docs/ACCELERATED-PRODUCTION-LAUNCH.md`, 2026-10-09, two days before this one) reported the *identical* figures — donors=254, giving_activities=5,463, effective balance=$176,171.15, and the same single active correction (-$210.00, the real Kutoff/DIN2023 case). Staging's core financial dataset has been completely stable across those two days.

### 4.4 Payment-plan summary (Staging)

| Check | Result |
|---|---|
| Total pledge_payment_plans | 45 |
| Active (`endedAt IS NULL`) | 45 |
| Ended | 0 |
| Sum of `installmentAmountCents` | $13,256.33 (a monthly-installment total, not a liability figure — do not add to the balance above) |

### 4.5 Foreign-key integrity (both databases)

`PRAGMA foreign_key_check` returns **zero rows** (zero violations) against both `fundraising-os-staging-db` and `fundraising-os-production-db`, run fresh today.

### 4.6 User-identity parity (both databases)

| Database | `users.id` | `users.email` |
|---|---|---|
| Staging | `user_sgoldstein@nirc.edu` | `sgoldstein@nirc.edu` |
| Production | `user_sgoldstein@nirc.edu` | `sgoldstein@nirc.edu` |

**This is the single most important structural finding for migration risk.** This application derives `users.id` deterministically from the account's email (`user_<email>`). There is exactly one user in each environment, and it is **the same identity string in both** — not because any data was copied, but because the owner independently logged into each environment with the same email. Every owner-scoped foreign key in the 48 MIGRATE tables (`ownerUserId`/`userId` columns) references this exact id. **As long as the `users` table itself is excluded from migration (Section 3), every one of those foreign keys will resolve correctly against Production's own existing owner row, with zero ID remapping and zero conflict.** If Production is ever given a second real user account before migration, this finding must be re-checked — it is not a static guarantee.

---

## 5. Schema compatibility findings

**Confirmed live, today:** every schema object (`CREATE TABLE`/`CREATE INDEX`/`CREATE UNIQUE INDEX`) in `fundraising-os-staging-db` and `fundraising-os-production-db` was pulled directly from each database's own `sqlite_master` and compared byte-for-byte (after whitespace normalization). **137 objects in each database. Zero differences of any kind** — not one column, type, index, or constraint differs.

| Check | Result |
|---|---|
| Required tables exist | Yes — all 54, identical names in both |
| Columns/types match | Yes — identical DDL, confirmed live |
| Indexes/constraints compatible | Yes — identical DDL, confirmed live, including every `UNIQUE`/partial index |
| Foreign-key relationships preservable | Yes — identical DDL; 0 live FK violations in Staging to carry over |
| Production baseline marker valid | Yes — Production's `production_schema_baseline` row (`id='0019'`, `schema_hash=913299652ad37c0073e82aeccb30511dc1f13c784eebb5e4e7ecd3e237dea566`) exactly matches `production-baseline/schema-manifest.json`, confirmed live today |
| Production auth records at risk of being overwritten | No, **provided `users`/`onboarding_preferences`/`backup_alert_state` are excluded from migration** (Section 3) — Production's owner row is otherwise never touched by this plan |
| Migration IDs / app-generated identifiers remain valid | Yes — every primary key observed is a UUID or content-derived string (never a sequential autoincrement), and the one shared identity (`users.id`) is confirmed identical by construction (Section 4.6), not coincidence |
| Unique constraints create unexpected conflicts | No conflict found: every unique constraint in the 48 MIGRATE tables is scoped per-owner (`owner_user_id` + another column) or is itself the row's own primary key; since Production has zero existing rows in every MIGRATE table, no pre-existing value can collide |

**Classification: Category 1 — Compatible without transformation.** No schema or data transformation is required for the migration itself. The only "transformation" involved is the already-existing, already-tested **reordering** of a database export into foreign-key-safe insertion order (Section 6) — not a change to any value or structure.

---

## 6. Data-quality findings

1. **Clean dataset overall.** Zero FK violations, zero duplicate donor codes/emails/source fingerprints (two independently enforced at the database level, not just observed empirically), zero orphaned ownership, zero sample/test/demo-flagged donor or giving-activity rows.
2. **Two giving-activity rows are flagged `workspace_status='duplicate'`** by the application's own existing duplicate-detection mechanism (internal ids `1c3f3d51-4a28-42f5-a3ee-105bc245d7f5` and `5e29f6c5-b599-4227-9ab8-fc50e7415f28`; no donor name/contact detail needed to identify them). Both have `balance_cents=0` (already fully resolved/closed), so excluding them changes no outstanding-balance figure, only the committed-total by $510.00 combined. **This audit does not decide their disposition** — see the exception register (Section 7) and open decision #2 (Section 13).
3. **No near-duplicate (fuzzy) donor detection was run.** Exact-match checks (email, donor code, display name) found zero duplicates, but this cannot rule out two genuinely different donor rows representing the same real person under different name spellings. No evidence of this was found, but it was not exhaustively tested — flagged as a residual risk (Section 8), not a known defect.
4. **Wide `activityDate` range (1973–2029)** is plausible, not a defect: the low end is an old historical gift; the high end is a scheduled future pledge-installment date. No row outside a sane bound (e.g., before this organization's founding or more than a few years out) was found.
5. **`gifts` (the original, pre-`giving_activities` financial table) has zero rows** in both environments. It is not deprecated in the schema, but all real financial data today lives in `giving_activities`. Nothing to migrate from `gifts`; no action needed.

---

## 7. Proposed migration inclusion/exclusion rules

Derived directly from Section 3's table inventory; stated here as explicit rules rather than left implicit:

1. **Migrate as data, in dependency order:** every table in `lib/data-health/production-baseline.ts`'s `FUNDRAISING_DATA_TABLES` (50 tables) **except** `import_preview_sessions` and `import_preview_session_chunks` (already-established ephemeral exclusion, `D1_RESTORE_SKIP_DATA_TABLES`) — 48 tables total.
2. **Never migrate; preserve Production's own existing row(s) untouched:** `users`, `onboarding_preferences`, `backup_alert_state` (`ACCOUNT_CONFIGURATION_TABLES`) and `production_schema_baseline` (the schema marker, which Production already has its own correct copy of from its own deployment).
3. **Exclude from the data copy entirely (ephemeral):** `import_preview_sessions`, `import_preview_session_chunks` — already time-expiring working cache with no durable value, matching this codebase's own existing, documented precedent for disaster-recovery restores.

### Exception register

| Record (internal id) | Table | Issue | Financial impact | Status |
|---|---|---|---:|---|
| `1c3f3d51-4a28-42f5-a3ee-105bc245d7f5` | giving_activities | App-flagged `workspace_status='duplicate'` | $0 (balance already $0) | **Owner decision required** — include as-is, or exclude |
| `5e29f6c5-b599-4227-9ab8-fc50e7415f28` | giving_activities | App-flagged `workspace_status='duplicate'` | $0 (balance already $0) | **Owner decision required** — include as-is, or exclude |

No other exception-register candidates were found (no other `workspace_status`/`recordOrigin`/`dataSource` value outside `active`/`live` exists in the current dataset).

---

## 8. Isolated rehearsal architecture

**Nothing below was created or executed this round.** This is the proposed design for a future, separately authorized rehearsal.

### 8.1 Resource naming

- **Rehearsal D1 database:** `fundraising-os-migration-rehearsal-<YYYYMMDD>` (e.g. `fundraising-os-migration-rehearsal-20261015`) — date-suffixed so a second rehearsal never silently reuses/collides with a prior one's name.
- **No Worker, no R2 bucket, no Cloudflare Access policy, no DNS/route of any kind** is created for the rehearsal. The database is reachable only via `wrangler d1 execute`/`wrangler d1 export` using the operator's own Cloudflare credentials — the same security boundary `scripts/verify-remote-restore.mjs` already uses for its own scratch-database pattern. **No public application endpoint is ever created for this.**

### 8.2 Schema initialization

Apply `production-baseline/drizzle/0000_production_baseline_0019.sql` — the exact same artifact that bootstrapped the real Production database — to the new, empty rehearsal database via `wrangler d1 execute --remote --file=...`. This guarantees the rehearsal starts from a byte-identical schema to real Production, not a freshly-regenerated one that could silently drift.

### 8.3 Safe source export

Prefer the most recent **verified, encrypted nightly R2 backup** of Staging (decrypted locally, in-memory/scratch-file-only, immediately shredded after use — same pattern as the existing nightly backup workflow's own `shred -u` step) over a live `wrangler d1 export`, so the rehearsal's source is a fixed, already-integrity-checked artifact rather than a database that keeps changing underneath the rehearsal while it runs. If no sufficiently recent backup exists at rehearsal time, a fresh `wrangler d1 export --remote` against Staging is the fallback — read-only against Staging either way; nothing is ever written back to it.

### 8.4 Transformation

None required at the value/structural level (Section 5). The only transformation is **reordering**, using the already-existing, already-tested `reorderD1ExportForRestore`/`planD1Restore` (`lib/operations/d1-restore-order.ts`) with a **migration-specific table order**: `D1_RESTORE_DATA_ORDER` filtered to drop `production_schema_baseline`, `users`, `onboarding_preferences`, and `backup_alert_state` entirely (so their INSERT statements, if present in the export, are never applied to the rehearsal database — it already has its own correct baseline row from step 8.2, and the rehearsal does not need or want Staging's own user account). This is a new, narrow variant of the existing order, not a new mechanism — `planD1Restore` already accepts a custom `order` argument for exactly this purpose. `D1_RESTORE_SKIP_DATA_TABLES` (`import_preview_sessions`/`import_preview_session_chunks`) is reused unchanged. Oversized single-row INSERTs (if any — none were observed in today's live data, but a real export could still contain one) are handled by the existing `parameterizeInsertStatement`/D1 HTTP-API path, already built and tested for this exact problem.

### 8.5 Insertion order

Exactly the filtered `D1_RESTORE_DATA_ORDER` from 8.4, applied via `planD1Restore`'s own per-table `steps` array — every parent row is inserted before any child row that could reference it, by construction (already proven against a real large export in production, 2026-08-16 — see that file's own header comment).

### 8.6 Owner account / environment-specific configuration

The rehearsal database receives **no** `users`, `onboarding_preferences`, or `backup_alert_state` rows from the export (8.4). If a validation step needs *any* user context (e.g. to run an app-level query that joins through `userId`), it should synthesize a throwaway test user row directly in the rehearsal database — never copy a real credential or real owner identity into it.

### 8.7 Duplicate/conflicting ID resolution

Not expected to be needed: the rehearsal database starts empty (post schema-init), every primary key in the source data is a UUID/content-derived string (never sequential), and Section 4.6 confirms the one shared identity (`users.id`) is deliberately excluded from the copy. If the restore nonetheless surfaces a unique-constraint violation, that is itself a **STOP condition** for the rehearsal (Section 9) — it would mean this audit's "no conflict expected" finding was wrong, and must be investigated before proceeding, never silently worked around (e.g. via `INSERT OR REPLACE`).

### 8.8 Protecting sensitive information

No Cloudflare Access credential, API key, dispatch token, or other environment secret exists *as data* anywhere in the D1 schema (confirmed by schema inspection — no column anywhere is shaped like a credential). The rehearsal plan independently guarantees none is introduced regardless: no secret is ever created for the rehearsal database (8.1), and the one table that could theoretically carry a credential-shaped value (none found) is excluded by the same account-configuration exclusion as `users`.

### 8.9 Validation

Re-run every query in `scripts/migration-audit/reconciliation-baselines.sql` against the rehearsal database and diff the results against the same queries run against the **frozen source export** (not live Staging, which may have changed since): row counts per table, FK check (must be 0 violations), financial totals (committed/paid/corrected-balance, to the exact cent), and the baseline-marker check. See Section 10 for the exact pass/fail thresholds.

### 8.10 Cleanup

Immediately after validation and **explicit owner sign-off** (never automatic): `wrangler d1 delete fundraising-os-migration-rehearsal-<date>`. No secret or credential was ever created for the rehearsal (8.1/8.8), so there is nothing else to revoke. Any locally-decrypted backup scratch file is shredded (`shred -u`) as part of the same step that decrypted it (8.3), not left for a separate cleanup pass.

---

## 9. Step-by-step proposed rehearsal procedure

1. Obtain explicit owner authorization for this specific rehearsal (separate from this audit's own authorization).
2. Identify the source: most recent verified nightly Staging R2 backup, or a fresh `wrangler d1 export --remote` if none is recent enough. Record its exact identity (R2 object key or export timestamp).
3. Run `scripts/migration-audit/reconciliation-baselines.sql` against that frozen source (decrypted backup, or live Staging at export time) — this is the baseline every later check is diffed against.
4. `wrangler d1 create fundraising-os-migration-rehearsal-<date>`.
5. Apply `production-baseline/drizzle/0000_production_baseline_0019.sql` to it (schema only).
6. Decrypt the source backup (if using one) into a scratch file; run it through `reorderD1ExportForRestore`/`planD1Restore` with the filtered order from Section 8.4.
7. Restore via `wrangler d1 execute --remote --file=...` for each "file" step and the D1 HTTP `{sql, params}` API for each "statement" (oversized-row) step, in the plan's own order — never reordering or batching differently than the plan produced.
8. Shred the decrypted scratch file immediately.
9. Re-run `reconciliation-baselines.sql` against the rehearsal database.
10. Diff every number against step 3's baseline. Any mismatch is a STOP condition (Section 10) — investigate before proceeding, do not retry blindly.
11. Spot-check the Kutoff/DIN2023 case specifically (the one real active balance correction) by its internal pledge id, confirming the corrected balance renders identically.
12. Present the full diff and the exception register (Section 7) to the owner for explicit sign-off.
13. On sign-off: `wrangler d1 delete` the rehearsal database (cleanup, Section 8.10). On non-sign-off or any STOP condition: same cleanup, plus a written note of what failed, before any second attempt.

---

## 10. Acceptance criteria

All of the following must hold for the rehearsal to be reported PASS. Any single failure is a STOP condition for that rehearsal run (not for Staging or Production, which this plan never writes to).

1. Every row present in the frozen source's 48 MIGRATE tables (Section 7) is present in the rehearsal database, **except** the exception-register rows (Section 7) if and only if the owner has explicitly approved their exclusion before the rehearsal runs.
2. Row count per table in the rehearsal database exactly equals the frozen source's count for that table, minus only explicitly-approved exceptions.
3. No duplicate primary key, no duplicate value on any table's existing `UNIQUE` index.
4. `PRAGMA foreign_key_check` on the rehearsal database returns zero rows.
5. `sum_committed_cents`, `sum_paid_cents`, and `sum_corrected_balance_cents` (Section 4.3's query) match the frozen source exactly, to the cent — not approximately.
6. The single active `pledge_balance_corrections` row (or however many the frozen source has at rehearsal time) is present, un-duplicated, and its corrected balance still reconciles exactly against the formula in Section 4.3.
7. Every `pledge_payment_plans` row's `donorId`/`pledgeActivityId` still resolves to a real row in the rehearsal database (an FK-check pass already covers this, restated here as a named business check).
8. Every `ownerUserId`/`userId` reference across all 48 tables resolves correctly — since no `users` row was copied (Section 8.6), this is only possible if the rehearsal is validated against Production's real owner id, confirming Section 4.6's identity-parity finding holds.
9. No row in `interactions`/`asks`/`donor_relationship_facts`/research tables (interaction and ask histories) is missing or duplicated relative to the frozen source.
10. Neither Staging nor Production's live databases show any row-count or content change caused by the rehearsal (re-run the relevant counts against both, live, after the rehearsal completes).
11. No row in the rehearsal database contains a Cloudflare Access/API/dispatch credential or secret value (spot-check: no column in the schema is shaped like one; confirm no unexpected column was added).
12. No transformation applied to any value was left unexplained — the only transformation is the insertion-order reordering (Section 8.4), and the diff in step 10 of Section 9 should show zero value-level differences, not just zero count differences.
13. Running the entire rehearsal a second time, from the same frozen source, produces the identical diff result (reproducibility) — the process has no step that depends on wall-clock time, random IDs, or any other non-deterministic input beyond the source data itself.
14. **Any financial discrepancy found and not fully explained by an approved exception-register entry is an unconditional STOP condition** — never worked around, never silently rounded away, never re-run with a "looser" query.

---

## 11. Backup and recovery requirements

| Safeguard | Status | Verified how |
|---|---|---|
| Encrypted nightly D1→R2 backup pipeline (Staging and Production) | **Already operational, verified** | Live GitHub Actions run history (both "D1 nightly backup" and "D1 nightly backup (Production)" completed successfully within the last ~13 hours of this audit) |
| Monthly restore-verification workflow | **Already operational, verified** | Prior rounds this session independently restored a real backup into a scratch D1 and passed every integrity/FK/schema/row-count check; live run history confirms it continues running on schedule |
| Backup-watchdog detection | **Operational on both environments** | Both status-workers deployed and live, each correctly resolving only its own dedicated GitHub workflow filename (this session's own backup-watchdog-correction round) |
| Backup-watchdog automatic dispatch | **Staging: enabled (pre-existing, unrelated to this audit). Production: deliberately disabled** | `wrangler secret list` re-confirmed live today: Staging's status-worker holds `GITHUB_BACKUP_DISPATCH_TOKEN`; Production's holds none |
| Pre-migration restore point | **Not yet created for this specific migration** | A fresh, immediately-pre-rehearsal (and separately, immediately-pre-real-cutover) nightly backup of Staging should be taken or confirmed-recent, per Section 9 step 2 |
| Partial-write prevention during restore | **Already solved, tested** | `planD1Restore`'s per-table `steps`/dependency order (Section 8.4) and the existing oversized-statement handling were built specifically to avoid a partial, FK-broken restore — proven against a real large export in 2026-08-16 |
| Idempotency / safe retries | **Partially established** | The *restore* mechanism itself has no retry logic of its own (a failed step should stop the whole rehearsal, per Section 10 item 14's STOP-condition philosophy, not auto-retry); the *backup watchdog's* own dispatch retry/race-recheck logic is separately tested and unaffected by this plan |
| Cutover timing / concurrent-modification prevention | **Gap — no application-level maintenance/read-only mode exists today** | Searched the codebase for a maintenance-mode/freeze flag; none found. **Mitigation for a real (non-rehearsal) cutover:** since the owner is Staging's only active user, a short owner-coordinated pause in Staging usage during the actual copy window is sufficient and low-cost — no code change needed for the rehearsal itself, which never writes to Staging regardless |
| Rollback if a real cutover ever goes wrong (future, not this round) | **Mechanism already exists, unexercised for this specific scenario** | Staging remains untouched and fully operational throughout any migration attempt (nothing in this plan ever writes to Staging); Production rollback is simply deleting/recreating the new data (no data existed there before) |

**Not activated and not proposed to be activated by this document:** no backup scheduling change, no new dispatch credential, no change to any GitHub Actions trigger.

---

## 12. Risk register

| # | Risk | Severity | Evidence | Potential impact | Mitigation | Blocks rehearsal? | Blocks Production migration? | Owner decision needed? |
|---|---|---|---|---|---|---|---|---|
| 1 | Two giving-activity rows are app-flagged duplicates | Low | Section 6/7 | $0 balance impact; $510 committed-total difference depending on inclusion | Explicit owner decision (Section 13 #2) before rehearsal | No | No (pending the decision either way) | **Yes** |
| 2 | No fuzzy/near-duplicate donor detection performed | Low–Medium | Section 6 #3 | A real duplicate donor record could exist under different name spellings and go uncaught | Optional future fuzzy-match pass before the real cutover; not found necessary by any exact-match check run | No | No | Owner may request this as a future step |
| 3 | Source-of-truth cannot be proven to exclude an external spreadsheet/system outside this codebase | Low–Medium | Section 2 | A real donor relationship could exist that Staging never captured | Owner confirms, in writing, that Staging is the sole system of record before the real cutover | No | **Yes, until confirmed** | **Yes** |
| 4 | No application-level maintenance/freeze mode | Medium | Section 11 | A real cutover's copy window could race against a live edit in Staging | Owner-coordinated short pause during the real copy (operational, not technical) | No (rehearsal never writes to Staging) | Yes, for the real cutover's timing plan | **Yes** |
| 5 | Fresh pre-cutover re-audit not yet repeated at migration time | Medium | `docs/PRODUCTION-LAUNCH-READINESS-ASSESSMENT.md` item 9, `docs/ACCELERATED-PRODUCTION-LAUNCH.md` §8 item 1 | Staging changes daily; today's numbers could be stale by the time a real cutover happens | Re-run this exact audit's queries immediately before any real cutover, not reused from today | No | Yes, procedurally (already a known, pre-existing requirement, not new) | No (process requirement, already established) |
| 6 | Oversized single-row INSERT could appear in a future export | Low | `lib/operations/d1-restore-order.ts`'s own documented history | A restore step could fail with `SQLITE_TOOBIG` if a row grows past the known threshold again | Already handled by `parameterizeInsertStatement`/the D1 HTTP-API path — re-verify during the rehearsal, not assumed | No (mechanism exists) | No | No |
| 7 | Rehearsal itself could be misconfigured to write to the real Staging/Production database | Low (procedural) | N/A (design-time risk) | Catastrophic if it occurred | Rehearsal plan (Section 8) targets only a newly-created, separately-named throwaway database; never Staging/Production's own name | **Yes — must be verified at execution time**, not just at design time | N/A | No |

---

## 13. Open owner decisions

1. **Confirm Staging is the sole current system of record** for donor/fundraising data — no parallel spreadsheet or external system is still being used outside this application (Section 2, Risk #3).
2. **Decide the disposition of the 2 app-flagged duplicate giving-activity rows** (Section 7 exception register) — include as-is, or exclude from the migrated dataset. This audit does not pre-decide this.
3. **Approve the rehearsal's exact design** (Section 8) before any rehearsal database is created.
4. **Approve the cutover-timing mitigation** (a short owner-coordinated pause in Staging usage during any future real copy window, Section 11/Risk #4) or propose an alternative.
5. **Confirm this audit's figures remain the basis for planning**, understanding that a fresh re-run immediately before any real cutover is still required regardless (Risk #5 — already an established, pre-existing requirement from the 2026-10-09 predecessor audit, not new to this document).

---

## 14. Exact next authorization required

This document authorizes nothing by itself. The next action requires **explicit, separate authorization** to:

- Create the named rehearsal D1 database (Section 8.1) and apply the baseline schema to it (8.2);
- Export (or decrypt an existing backup of) Staging's data for the rehearsal (8.3);
- Run the reordering/restore procedure into the rehearsal database only (8.4–8.7);
- Validate and report the results (8.9, Sections 9–10);
- Delete the rehearsal database afterward (8.10).

**No step above touches Staging's or Production's existing databases, deploys any Worker, or migrates any donor data into Production.** A full real-Production-migration authorization is a separate, later decision this audit explicitly does not request or assume.

---

Stopping here, per explicit instruction. No database was modified, no rehearsal environment was created, no Worker was deployed or redeployed, and no donor data was migrated. Awaiting independent review and explicit authorization before creating or populating any rehearsal environment.
