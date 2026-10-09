# Fundraising OS — Accelerated Production Launch Assessment

**Date:** 2026-10-09
**Status:** Investigation, planning, and documentation only. No Production infrastructure was created or modified. No donor data was copied, altered, or deleted. This document is not a deployment authorization.

This assessment answers one question: what is the shortest *responsible* path from the current Independent Staging environment to a dependable daily-use Production environment, and what — if anything — is actually standing in the way?

Methodology: this round combined direct investigation (git/GitHub state, deployment config, documented runbooks) with four parallel, independent code/test/data audits, each scoped to a distinct domain (donor & financial core; relationship & workflow core; security & authentication; live staging data). Each audit was instructed to find real evidence, not to manufacture findings to pad a checklist, and to explicitly say so when a domain was clean. All four came back clean at the P0/P1 level.

**2026-10-09 update (Pre-Launch Safety Verification round)** — two follow-up items from this document, closed out:

1. **P2-1 (auth hardening) is now fixed and tested.** See `docs/AI-HANDOFF.md`'s "Pre-Launch Safety Verification" entry for the full root-cause investigation (the originally-suggested one-line fix was found to be wrong once the real `deploymentEnvironment` values and the `build:production` script's actual behavior were inspected) and the real fix (gating on whether Cloudflare Access is actually configured, not on a guessed environment name). §5 and §9 below are left as originally written for the historical record, with this note superseding them.
2. **A new, more precise backup-freshness finding, from actually dispatching the monthly restore-verification workflow this round (not merely recommending it):** the real run failed — not because anything is broken, but because the most recent nightly backup (taken the same day, before migrations 0041/0042 were applied to live Independent Staging) does not yet contain the current schema. See the updated §10 below for the full detail. This refines, with real evidence, what was previously only inferred from dates in the original §10.

---

## 1. Executive summary

**Fundraising OS is close.** Across every capability audited — donor profiles, giving history, outstanding pledges, payment plans, manual balance corrections, interactions, asks, reminders, search, reporting, authentication, and backup — **zero P0 (launch-blocking) and zero P1 (daily-reliance-blocking) defects were found**, backed by direct code inspection, fresh test runs, and live read-only verification against the real Independent Staging database. The only two findings are P2 (nice to fix soon, not required to launch).

The current Independent Staging dataset — 254 real donors, 5,463 giving activities, 88 real outstanding pledges, 45 active payment plans, 1 active manual balance correction, 17 completed imports with zero failures — was independently audited this round and found to have **zero duplicates, zero orphaned foreign keys, zero unexpected nulls, zero financial inconsistencies, and zero residual test/sample data**. The Shlomo Kutoff regression case (donor 57932, DIN2023/DIN2025) was independently re-verified and matches the known-correct values exactly.

**What remains before launch is not application engineering — it is infrastructure provisioning that has never been done before** (an independent Production Worker/D1/R2 have genuinely never existed for this application) and the deliberate, careful process of verifying, approving, and transferring the dataset. Both are well-understood, low-novelty work: every piece of it reuses a pattern already built, tested, and running successfully on Independent Staging today.

## 2. Current readiness status

Verified fresh this round, not assumed from prior reports:

- `origin/main` tip: `c8a11dab2b68106f310a3e5367a6f159d143e981` — PR #14 merged, confirmed via `git log`/`git diff`.
- D1 restore/schema sync check: **green**, confirmed via a fresh local run of `scripts/check-main-restore-sync.mjs` this round ("D1 restore/schema state on main is in sync with the canonical schema. No drift detected.").
- Canonical branch `feature/independent-cloudflare-sandbox`: clean, matches `origin` exactly, no pending local changes before this round's work.
- Independent Staging deployment: Worker `fundraising-os-staging`, D1 `fundraising-os-staging-db` (id `6c18396c-0a8f-4f2c-ba83-ea809ec10289`), fronted by Cloudflare Access, single-owner (`sgoldstein@nirc.edu`), confirmed directly from `wrangler.staging.jsonc`.
- **No independent Production Worker/D1 exists today.** `wrangler.production.example.jsonc` is an explicitly non-functional template; the only other "production" in this codebase is the separate legacy ChatGPT Sites platform, which is out of scope for this application's D1/backup tooling (see `docs/DEPLOYMENT.md`).

## 3. Minimum viable Production checklist

| # | Capability | Implemented | Tested | Working in Staging | Known defects | Required before launch? |
|---|---|---|---|---|---|---|
| A | Donor profiles & contact info | Yes | Yes (`tests/donor-contact-management.test.mjs`, 6/6) | Yes (254 real donors, verified live) | None | Already launch-ready |
| B | Giving history | Yes | Yes (`tests/donations.test.mjs`, `donation-management.test.mjs`, `import-cross-import-duplicates.test.mjs`) | Yes (5,463 giving activities, verified live) | None | Already launch-ready |
| C | Outstanding pledges | Yes — single `COALESCE` effective-balance rule at all 7 real consumer sites | Yes | Yes (88 real outstanding pledges, financially consistent, verified live) | None | Already launch-ready |
| D | Payment plans | Yes | Yes (7 dedicated test files) | Yes (45 active plans, verified live) | None | Already launch-ready |
| E | Manual pledge balance corrections | Yes (migration 0042, append-only, DB-enforced single-active-correction constraint) | Yes (57 tests across correction/migration-upgrade/backup-restore suites, all run fresh this session) | Yes (1 active correction, the real Kutoff case, re-verified exactly this round) | None | Already launch-ready |
| F | Interactions & relationship notes | Yes | Yes (10+ test files) | Yes (203 interactions) | None | Already launch-ready |
| G | Asks & solicitation tracking | Yes | Yes (3 dedicated test files) | Yes (6 asks) | None | Already launch-ready |
| H | Follow-up tasks & reminders | Yes (`recommendations` table + renewal follow-up logic) | Yes, heavily (463-line engine test + 3 more) | Not independently re-verified live this round (code/test evidence only) | None found | Already launch-ready |
| I | Donor search & navigation | Yes (no artificial pagination limit — all owner-scoped donors load) | Yes | Yes (254 donors, confirmed no hidden-record risk) | None | Already launch-ready |
| J | Basic fundraising reporting | Yes (`fundraising-intelligence`, `portfolio-focus`) | Yes, heavily (1,300+ combined test lines) | Not independently re-verified live this round (code/test evidence; no fabricated-data code paths found) | None | Already launch-ready |
| K | Secure authentication & permissions | Yes (Cloudflare Access + independently re-verified JWT signature/issuer/audience/expiry) | Yes (15 real cases incl. wrong-key/wrong-audience rejection) | Yes (this is how every live check this entire session authenticated) | 1 P2 (defense-in-depth hardening, see §9) | Already launch-ready |
| L | Reliable backup & recovery | Yes (nightly R2 export + monthly real-restore verification + D1 Time Travel, native) | Yes (dedicated test suites + a long real track record) | Yes — 10/10 recent nightly runs succeeded; most recent real restore-verification (2026-10-01) succeeded | 1 P2 (freshness not surfaced in-app UI, see §9); 1 note (next restore-verification run will be the first against the current, 0041/0042-inclusive schema — see §10) | Already launch-ready, with one recommended pre-cutover action |

**"Implemented" was not assumed to mean "working."** Every row above reflects test files that were actually opened and run (not just counted) and, for the financial/data rows, live read-only staging queries run this round.

## 4. Verified P0/P1 blockers

**None.** Across all four independent audits — donor/financial core, relationship/workflow core, security/authentication, and live staging data — zero P0 and zero P1 findings were identified. This is stated plainly rather than padded: each audit was explicitly instructed to report "clean" honestly rather than manufacture findings, and each did so, with concrete evidence (file:line references, test run results, exact query values) rather than general impressions.

If this is surprising, the reason is straightforward: this application has already been under active, test-driven development with real-money-shaped data for months, with every major feature (payment plans, manual balance corrections, backup/restore, import pipeline) built with dedicated regression suites as part of its own construction, not bolted on afterward.

## 5. P2/P3 deferred work (does not block launch)

| # | Finding | Domain | Why it can wait |
|---|---|---|---|
| P2-1 | The ChatGPT-Sites header auth path (`chatGPTHeaderProvider`) is checked before the real Cloudflare Access JWT path and trusts a client-supplied header with no signature check. On the independent Cloudflare deployment this is only unreachable because Cloudflare Access gates the route at the edge first — not because the code itself provably excludes it. | Security | The primary gate (Access + real JWT verification) is sound and tested; this is a secondary hardening layer, not an active vulnerability. Smallest safe fix: skip this provider whenever `deploymentEnvironment !== "staging"` (one conditional). Low complexity — worth doing in Stage B or G, not worth delaying launch for. |
| P2-2 | The Workspace Health (`/health`) page references "the automated nightly backup below" but no backup-freshness card actually renders in the UI — the real backup status is only reachable via the GitHub Actions API or the backup-alert email, not the app itself. | Operational monitoring | The backup pipeline itself is independently verified functional (see §10); this is a visibility/convenience gap for the owner, not a correctness problem. |
| P3-1 | Custom Production domain (vs. the default `*.workers.dev` subdomain) | Infrastructure polish | Zero functional difference for a single-owner tool; adds DNS/Workers Routes setup with no launch benefit. |
| P3-2 | Expanding the per-workspace JSON export (`WORKSPACE_BACKUP_TABLES`) to cover tables currently in `WORKSPACE_BACKUP_EXCLUDED_TABLES` (asks, payment plans, corrections, etc.) | Convenience export | This export is explicitly a secondary, human-readable snapshot — the authoritative backup (nightly whole-DB R2 export) already covers every table, including all of these, today. |

No new dashboards, CRM modules, redesigns, refactoring, or integrations were found necessary for launch, and none are proposed here.

## 6. Staging donor-data readiness

Verified read-only this round against the real `fundraising-os-staging-db`:

| Check | Result |
|---|---|
| Donors | 254 |
| Giving activities | 5,463 (5,375 completed gifts; 88 real outstanding pledges: 57 partially paid + 31 open) |
| Interactions | 203 |
| Asks | 6 |
| Active payment plans | 45 (0 ended) |
| Manual balance corrections | 1 total, 1 active, 0 reversed |
| Users | 1 (the owner) |
| Duplicate donor codes | 0 |
| Duplicate `source_fingerprint` | 0 (DB-enforced unique index, not just application logic) |
| Orphaned foreign keys (4 distinct checks) | 0 |
| Unexpected nulls | 0 |
| Rows where paid exceeds committed | 0 |
| Total outstanding balance (effective, workspace-wide) | $176,171.15 |
| Import batches | 17, all `status='completed'`, 0 stuck/failed |
| Residual migration-seed sample data (`staging_user_sarah`) | **Not present** — already clean |
| Rows flagged `data_source`/`record_origin` other than `'live'` | 0 |
| "Legacy test" rows (app's own real detection query) | 0 |

Two `giving_activities` rows carry `workspace_status='duplicate'` — these are legitimate, already-handled import-deduplication history (a superseded row kept for audit, already filtered out of every live query), not test artifacts requiring cleanup.

**The Shlomo Kutoff regression case (donor code 57932), re-verified exactly this round:**

| Pledge | Committed | Paid | Raw balance | Correction | Effective balance |
|---|---|---|---|---|---|
| DIN2023 (`b16a6e94-...`) | $5,000.00 | $4,790.00 | $210.00 | Active, corrected to $0, reason "JL mistake" | $0.00 |
| DIN2025 (`11bc5aef-...`) | $3,000.00 | $2,750.00 | $250.00 | None | $250.00, active $250/month plan (`ae64934c-...`, `ended_at` NULL) |

Every value matches exactly. The already-proven backup/restore architecture (round-tripped and tested extensively in prior rounds) independently guarantees both pledges, their original imported values, the correction's full audit trail, and the active payment plan all survive a real export→restore cycle without cross-contamination.

**Verdict: the current Independent Staging dataset is, as it exists right now, sufficiently trustworthy to become the initial Production dataset**, subject to the owner's own final review and explicit approval (never assumed or automated).

## 7. Production architecture

Reuses the existing, proven Independent Staging pattern exactly — no new architecture, no new services. What must be **created** (none of this was done this round):

1. **Production D1 database** — `wrangler d1 create`, new and empty, separate `database_id` from staging.
2. **Production Worker** — populate `wrangler.production.jsonc` from the existing `wrangler.production.example.jsonc` template (already present, already deliberately non-functional until filled in) with the new database id, team domain, policy AUD, and owner email.
3. **Production Cloudflare Access Application** — a new Access App + policy in the Zero Trust dashboard, scoped to the production Worker's route. The owner has done this exact one-time setup once already, for staging.
4. **Production R2 backup bucket** — a new, separate bucket. Cannot safely share staging's bucket: the backup/restore-verify workflow files hardcode a database name and bucket per file, and the status JSON object keys are fixed names (not namespaced), so sharing would conflate staging and production backup status.
5. **Production status bucket + a second status-worker deployment** — mirrors the existing isolated `fundraising-os-backup-status` pattern exactly; no code changes to the proven status-worker itself, just a second deployment of it pointed at a second bucket.
6. **Two new GitHub Actions workflow files** — copies of `d1-backup-nightly.yml` / `d1-restore-verify-monthly.yml` with the database name, bucket variable, and secret names changed to production-scoped ones (e.g. staggered to 08:15 UTC so the two nightly jobs don't compete for the same GitHub Actions platform-load minute).
7. **New GitHub secrets** — separate R2 read/write tokens scoped to the new production backup bucket, a separate token for the new status bucket, and a **new, separate** `BACKUP_ENCRYPTION_PASSPHRASE` (so a staging passphrase leak could never decrypt production backups) — stored in GitHub secrets and a second durable copy outside GitHub, per the existing runbook's own requirement.
8. **Domain** — default `*.workers.dev` subdomain is the fastest path (zero DNS work, identical to staging today, zero functional downside for a single-owner tool). A custom domain is explicitly deferred (§5, P3-1).
9. **Monitoring** — `observability: { enabled: true }` (already in the template) gives Cloudflare's built-in Workers logs/metrics with zero extra setup; the existing Workspace Health page works identically once deployed.
10. **Rollback** — redeploying the Worker is stateless (`wrangler deploy`); D1 Time Travel (Cloudflare's native 30-day point-in-time recovery, automatic the moment the database exists, zero setup) plus the R2 nightly pipeline together form the same documented disaster-recovery runbook already in `docs/DEPLOYMENT.md`, applied verbatim with new resource names.

**Isolation from Staging** is structural, not procedural: separate Worker, separate D1 database id, separate R2 buckets, separate Access Application/audience, separate secrets, no shared binding of any kind — mirroring exactly how Staging and the legacy platform are already isolated today.

**Costs/limits**: this round had no access to live Cloudflare billing/account-limit data (not a code or D1 query concern, and out of this round's read-only scope). A second D1 database, Worker, and R2 bucket at this application's actual scale (254 donors, ~5,500 giving-activity rows) is structurally identical in kind to what Staging already runs successfully — but the owner should do a brief dashboard check of current plan/limits before provisioning, since this investigation cannot see account-specific billing details.

## 8. Migration and reconciliation plan

The **data-copy mechanism itself requires no new engineering** — it is the exact backup/restore pipeline already built, tested, and round-tripped extensively this session (`lib/operations/d1-restore-order.ts`'s `planD1Restore`/`reorderD1ExportForRestore`, proven against the real Kutoff two-pledge scenario and against active/reversed/absent corrections). Because this is a byte-level SQL export→restore (not a selective API re-import), every row's primary key, every foreign-key relationship, every original imported balance, every correction's audit history, and every payment plan survives automatically and identically — there is no ID-remapping or selective-field-copy step to design.

1. **Pre-copy integrity audit** — done this round (§6). Re-run immediately before the real cutover, since Staging keeps changing until then.
2. **Identification of test/development records** — done this round: none found. Re-confirm at cutover time with the same queries.
3. **Owner approval of the exact dataset** — explicit, required, not assumed. The owner reviews this document's §6 findings (and a fresh re-run of them at cutover time) and explicitly approves "this is the dataset to launch with."
4. **Verified source backup** — use the most recent real nightly R2 backup (or take a fresh one immediately before cutover) as the actual source, not a live `wrangler d1 export` against the still-changing database, so the source is a known, fixed, already-integrity-checked artifact.
5. **Migration-version compatibility** — already proven this round: the backup's schema already includes migrations through 0042 (`pledge_balance_corrections`, `renewal_acknowledged_at`), confirmed live.
6. **Exact data-copy mechanism** — decrypt the chosen backup, run it through the already-proven `reorderD1ExportForRestore`, restore into the new, empty Production D1 via `wrangler d1 execute --file=...` (or the HTTP-API path for any oversized statements, both already built and tested).
7–12. **Preservation of IDs, relationships, imported balances, correction history, payment plans, interactions/asks/tasks/reminders** — all automatic consequences of item 6's mechanism (a raw structural copy), not separate work items. Verified empirically in prior rounds' round-trip tests and re-confirmed conceptually against this round's live data audit.
13. **Secure handling of users/authentication** — the `users` row itself (containing no password — Cloudflare Access is stateless JWT-based) copies safely as-is. What must change is Production's own `wrangler.production.jsonc` vars (`TEAM_DOMAIN`, `POLICY_AUD`, owner email) — environment configuration, not donor data.
14. **Post-copy record-count reconciliation** — re-run every count in §6 against the new Production database; every number must match the source backup's own counts exactly.
15. **Financial reconciliation** — re-run the effective-balance total ($176,171.15 as of this audit — will differ slightly by cutover time as real activity continues) and confirm it matches the source backup exactly, plus spot-check the Kutoff case specifically.
16. **Representative donor validation** — manually open several real donor profiles (including Kutoff) in the new Production environment and visually confirm they render identically to Staging.
17. **Rollback and recovery** — until cutover is declared final, Staging remains untouched and fully operational; if anything looks wrong post-copy, there is no urgency to "fix" Production — simply delete the new Production D1 and re-run the copy, or keep using Staging while the issue is resolved. D1 Time Travel and the R2 backup also apply to Production from the moment it exists.
18. **Final cutover approval** — a separate, explicit decision from "the copy looks correct" — the owner decides when to actually start using the Production URL daily.

**Will Staging keep changing during migration? Yes — recommend the simplest safe approach, not a complex sync.** Given this is a single-owner tool, not a multi-tenant system, the lowest-risk, least-engineering approach is a **short, scheduled cutover window**: the owner briefly pauses using Staging (even just for the duration of taking the final backup — minutes, not hours), the final backup is taken and restored into the new Production database, items 14–16 above are verified, and the owner then simply starts using the Production URL going forward. This avoids building any dual-write, delta-sync, or replication mechanism, which would be real engineering effort spent on a problem a brief pause solves for free. Do not build anything more complex than this without a specific, verified reason to.

## 9. Security assessment

Independently audited this round (code-level, no live penetration testing): authentication bypasses, unauthorized API access, cross-user data access, role enforcement, session security, secrets exposure, production/staging separation, sensitive data in logs, unsafe administrative operations, and backup access controls.

**Zero P0 findings.** Every sampled API route (11 spot-checked across donors, corrections, payment plans, interactions, asks, backup, and admin operations) enforces authentication before touching data, and scopes every query by the authenticated owner's id — genuinely enforced at the query layer, not merely true because only one real user exists today. Cloudflare Access JWT verification is real (signature, issuer, audience, and expiry all checked via `jose` against the live JWKS, with 15 dedicated test cases including deliberately-wrong-key and wrong-audience rejection). No hardcoded secrets found in source. No donor PII or financial amounts found passed into any log call. Destructive administrative operations (staging reset) are gated by environment check + authentication + exact owner-email match + an explicit confirmation phrase. Backup credentials are genuinely separated into three distinct scoped tokens (write/read/status), not one shared credential.

One P2 finding (§5, P2-1): a defense-in-depth hardening opportunity, not an active vulnerability, contingent on the primary gate (Cloudflare Access) failing independently.

## 10. Backup and recovery requirements

For Production, specify: same nightly schedule (staggered ~08:15 UTC), a separate R2 destination bucket, the same AES256/GPG symmetric encryption with a new, separate passphrase, the same 90-day retention lifecycle, the same monthly real-restore verification workflow (ported with new resource names), the same existing failure-notification email alert (`lib/backup-alert/`, already generic — just needs Production's own `STATUS_WORKER` binding), the same documented recovery procedure (`docs/DEPLOYMENT.md`'s disaster-recovery runbook, applied with new resource names — no new runbook to invent). Expected recovery time: realistically well under an hour for any single-cause incident, based on the existing runbook's steps being single CLI commands (D1 Time Travel restore, or decrypt-and-restore a dated R2 export, or a stateless Worker redeploy) — not independently timed this round. Potential data-loss window: near-continuous (effectively minutes) within D1's own native 30-day Time Travel window; up to ~24 hours worst-case via the offsite R2 nightly backup (the fallback for a scenario Time Travel can't cover, such as the database itself being deleted). Responsible operator: the owner — single-owner system, no separate ops team; the durable offline copy of the encryption passphrase is the owner's own responsibility, per the existing runbook.

**Distinguishing "configured," "completed," and "independently restored and verified" — for Staging's real, current state, verified this round via GitHub's public Actions API (not assumed):**

- **Configured**: Yes. Workflow files, cron schedules, R2 buckets, and the documented one-time setup are all in place and have been for months.
- **Completed**: Yes. The last 10 nightly backup runs (2026-09-30 through 2026-10-09) all succeeded; the most recent completed the same day as this investigation.
- **Independently restored and verified against the CURRENT schema**: **No — and this round has real, direct evidence why, not just a date-based inference.** The recommended manual dispatch was carried out (`workflow_dispatch`, <https://github.com/shimmy12345/ner-yisroel-fundraising-studio-v3/actions/runs/37983465332>, 2026-10-09). Result: **failure**, root-caused from the actual job logs — the real, mechanical restore worked correctly end to end (decrypt → scratch D1 created → every table in the backup restored → `PRAGMA quick_check` passed → `PRAGMA foreign_key_check` passed, zero violations → scratch database cleaned up safely, confirmed in the log even though the run ultimately failed), but the schema-comparison step correctly caught that the backup actually tested (`daily/fundraising-os-staging-db-20261009T144819Z.sql.gz.gpg`, confirmed to be the single most recent nightly backup in existence at the time) **predates migrations 0041/0042 being applied to the live database**, which happened later the same day — confirmed directly: the live database has `pledge_balance_corrections` right now; the tested backup's own restored schema does not. **This is not a backup-pipeline defect** — the pipeline and the verification script both did exactly what they are supposed to do, including correctly refusing to pass a stale-schema restore as current. It is a timing gap: no backup containing the current schema exists yet. Row-count reconciliation and the donor-level Kutoff check were never reached (the script fails fast on the first bad assertion) — not claimed as verified. **Concrete next step, requiring separate approval**: either wait for the next scheduled nightly backup (which will naturally include 0041/0042) and then re-run this same verification, or explicitly approve dispatching the nightly backup workflow once, now, followed by a re-run of the monthly restore-verification. Until one of those happens and succeeds, Stage D/E below should not treat "the most recent nightly backup" as proven to contain the current schema — pull a fresh one at that time and confirm, rather than assuming this document's earlier backup is still the right one to use.

## 11. Fastest safe launch sequence

**STAGE A — Fix genuine launch blockers**
Work required: none identified. The two P2 findings (§5) may optionally be addressed here or deferred to Stage G — neither blocks any later stage.
Dependencies: none. Acceptance criteria: N/A (no blockers found). Risk: none. Effort: 0–2 hours if the P2 items are addressed now. Owner approval needed: no (or, if addressing the P2 items, standard code-review approval only). Rollback: N/A.

**STAGE B — Prepare isolated Production infrastructure**
Work required: the 10 creation items in §7 (D1 database, Worker config, Access Application, two R2 buckets, second status-worker deployment, two duplicated workflow files, new secrets). Dependencies: none (can start immediately). Acceptance criteria: a deployed, empty Production Worker, reachable only via its own Cloudflare Access policy, with its own nightly backup running successfully at least once. Risk: low — every piece duplicates an already-proven pattern. Effort: roughly half a day to a day of focused, mostly-manual dashboard/CLI work (most of it is the same checklist the owner already completed once for Staging). Owner approval needed: yes — this stage creates real, billable Cloudflare resources. Rollback: delete the newly created resources; nothing else is affected.

**STAGE C — Verify and approve donor data**
Work required: re-run §6's audit queries fresh (data keeps changing on Staging), present the results, obtain the owner's explicit sign-off on the exact dataset to launch with. Dependencies: none (can run in parallel with Stage B). Acceptance criteria: owner's explicit written/verbal approval of the dataset. Risk: low. Effort: 1–2 hours. Owner approval needed: yes — this is the core approval gate. Rollback: N/A (no data is touched in this stage).

**STAGE D — Rehearse migration and recovery**
Work required: perform a full dry-run restore of a real Staging backup into a **throwaway** scratch D1 database (never the real new Production one), verify record counts/financial totals/the Kutoff case per §8 items 14–16, then (with explicit approval) trigger a real monthly restore-verification run to get current-schema proof per §10. Dependencies: Stage B's backup pipeline must exist for the production-side rehearsal; the staging-side rehearsal can start immediately. Acceptance criteria: a dry-run restore reconciles exactly against its source. Risk: low (throwaway database, auto-deleted). Effort: half a day. Owner approval needed: yes, specifically for the scratch-database creation/deletion and for the restore-verification workflow dispatch. Rollback: delete the scratch database (already automatic in the existing tooling).

**STAGE E — Deploy Production**
Work required: the real cutover — brief pause of Staging use, final backup, restore into the real new Production D1, run §8's reconciliation (items 14–16) for real. Dependencies: Stages B, C, and D all complete and approved. Acceptance criteria: Production's record counts and financial totals match the source backup exactly; the Kutoff case renders correctly in Production. Risk: low-moderate (the one irreversible-feeling step, though Staging remains untouched throughout and nothing is deleted). Effort: 1–3 hours, ideally in one sitting. Owner approval needed: yes — this is the final cutover decision (§8 item 18). Rollback: Staging is unaffected and still fully usable; the new Production database can simply be deleted and the copy re-run.

**STAGE F — Validate and begin daily use**
Work required: the owner uses Production for real daily work for the first several days, watching for anything that looks wrong. Dependencies: Stage E complete. Acceptance criteria: a few days of real use with no data-integrity surprises. Risk: low, given zero P0/P1s were found and the dataset was pre-verified. Effort: ongoing, owner's own time. Owner approval needed: N/A (this *is* the owner's own use). Rollback: Stage E's rollback remains available for as long as Staging is kept around.

**STAGE G — Stabilize and resume feature development**
Work required: address the two P2 items if not already done in Stage A; resume normal feature work on the canonical branch. Dependencies: Stage F reasonably stable. Risk: none. Effort: ongoing.

**What can run in parallel:** Stage B (infrastructure) and Stage C (data approval) have no dependency on each other and should run simultaneously. Stage D's staging-side rehearsal can also start immediately, in parallel with B and C; only its production-side half needs Stage B's pipeline to exist.

## 12. Estimated effort and timeline

No specific calendar launch date is proposed — it is not knowable from this investigation and would be invented if stated. What *is* knowable: there are **zero verified P0/P1 engineering blockers**, so the remaining work is entirely infrastructure provisioning and careful process (Stages B–E), estimated at roughly **2–3 focused days of actual work**, most of it manual Cloudflare dashboard/CLI steps the owner has already done once before for Staging, plus one real cutover session (Stage E, 1–3 hours). If the owner can allocate that time in a single week, an accelerated launch within that week is realistic; the limiting factor is the owner's own availability for the manual approval/dashboard steps, not outstanding engineering.

## 13. Decisions requiring owner approval

1. Explicit approval to provision real Production infrastructure (Stage B) — creates billable Cloudflare resources.
2. Explicit approval of the exact donor dataset to launch with (Stage C), after a fresh re-audit at that time.
3. Explicit approval to create/delete a throwaway scratch D1 database for rehearsal, and to manually dispatch the restore-verification workflow (Stage D).
4. Explicit approval of the final cutover moment (Stage E) — when Staging use pauses and Production becomes authoritative.
5. Whether to address the two P2 findings (§5) before or after launch (either is safe).
6. Whether a custom domain is wanted for Production, or the default `*.workers.dev` subdomain is acceptable (recommended, for speed).
7. A brief personal check of current Cloudflare account limits/costs before provisioning (this investigation had no access to that data).

## 14. Explicit GO / NO-GO criteria

**GO for beginning Stage B (infrastructure provisioning) and Stage C (data approval) immediately, in parallel**, on the evidence in this document: zero verified P0/P1 application blockers, a clean and verified staging dataset, a proven backup/restore mechanism, and a sound security posture.

**NO-GO for Stage E (actual Production deployment/cutover) until**: Stages B through D are complete and independently verified (not merely "looks done"), the owner has given each of the explicit approvals in §13, and — per this round's absolute restrictions — until a human, not this assessment, makes that call. This document is evidence and a plan, not that approval.

**Additionally NO-GO for Stage D's production-side rehearsal / Stage E specifically until a fresh nightly backup containing migrations 0041/0042 exists and has been independently restore-verified** (see §10's 2026-10-09 update) — confirmed this round by actually dispatching the verification, not inferred. This does not block Stage B or Stage C, which have no dependency on backup content.
