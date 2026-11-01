# Production Feature Baseline

Created 2026-11-01, following the discovery that a real, previously-
working Trip Planner feature ("Add to Google Calendar" link + "Use
donor address" button) was silently dropped from Production by an
unrelated deployment on 2026-10-25, because the two lines of work had
diverged from a common ancestor and were never reconciled. See
`docs/AI-HANDOFF.md`'s "CORRECTION" entry of the same date for the
full root-cause investigation.

**Purpose**: a single place that says, per critical feature, whether
it is verified working in Production right now, implemented but not
independently re-checked recently, or confirmed incomplete/unavailable
-- so the next change can check "did I just break something on this
list" before deploying, not after a user reports it missing.

**Rule this document follows**: a feature is marked "Verified working
in Production" only when this session (or the most recent review
noted) produced direct evidence against the real, live environment --
a real HTTP response, a real database read, a real deployed-bundle
check, or a real GitHub Actions run outcome. Code existing, a type
check passing, or a simulated/mocked test passing is **never**
sufficient on its own for that top tier.

## The baseline

| Feature | Status | Evidence |
|---|---|---|
| Donor profiles, giving history | Implemented, not independently re-verified this round | Core, long-standing feature with extensive historical deployment/test evidence in `docs/AI-HANDOFF.md`; row counts and financial totals read live today (2026-11-01, migration-0048 release) as a side effect of unrelated work, not a dedicated feature check. |
| Pledges, payments, payment plans, reconciliation | Implemented, not independently re-verified this round | Same as above -- heavily documented history, not freshly re-confirmed against live Production in this specific investigation. |
| Trip Planner -- meeting scheduling, rescheduling, completion, cancellation | **Verified working in Production** | Live browser test against real `https://shimmydonors.org`, 2026-11-01: real `PATCH` calls returned `200`, direct D1 reads confirmed the resulting `interactions`/`trip_prospects`/`calendar_event_links` rows matched exactly (scheduled -> rescheduled -> completed; separately, scheduled -> cancelled). Disposable test records, fully cleaned up afterward. |
| Trip Planner -- "Use donor's home address" as meeting location | **Verified working in Production** | Restored 2026-11-01 (commit `2536c52`, originally `adb97c0`/2026-10-19, dropped by the 2026-10-25 incident). Deployed to Production (Worker `b75eedb7-e5e2-40a6-bb93-345338823cb6`) and verified live, read-only: opened the real scheduling panel for an actual, not-yet-scheduled donor (Kopstick) on a real trip, clicked "Use donor address," confirmed the field filled with his real on-file address ("122 Maiden Ln, Bergenfield, NJ 07621-4102"), then cancelled without saving -- a direct D1 re-check confirmed his real record was never touched. |
| Trip Planner -- "Add to Google Calendar" link (template URL, no OAuth) | **Verified working in Production** | Same restoration/deployment as the row above. Found via a read-only query that 6 real, pre-existing scheduled meetings already exist on Production; confirmed live that every one correctly shows the link, and read one real href directly off the live page (Bashevkin: correct name, correct date/time/location) -- no new data created, no link ever clicked. |
| Trip Planner -- automatic OAuth-based Google Calendar sync (create/update/cancel via the Google API) | Implemented, not active | Backend (`lib/calendar/`, `trip-calendar-sync.ts`, Settings UI) fully built and exercised live today against real Production (scheduling/rescheduling/cancelling correctly wrote `calendar_event_links` rows) -- but no real Google OAuth credential exists on Staging OR Production (`wrangler secret list` on both, 2026-11-01, shows only `GMAIL_OAUTH_*`), so no live Google API call has ever actually been made by this system. Deliberately gated behind an explicit owner-approved OAuth setup step that has never been taken, per the design doc's own rollout sequence -- not a bug. |
| AI Meeting Notes + donor-profile synchronization | Implemented, not independently re-verified this round | The "✦ AI meeting notes" link was observed present and reachable during today's live Trip Planner test, but its own save/sync behavior was not independently exercised this round. |
| Daily Fundraising Agenda email + donor recommendations | Implemented, not independently re-verified this round | The same-day recovery-window fix was deployed and source-verified earlier this session (commit `1b0b25a`, deployed), but this round did not independently confirm a real 9 AM send has fired and succeeded in Production since. |
| Production email scheduling (the underlying send guard/cron) | Implemented, not independently re-verified this round | `isRealEmailSendAllowed`'s fail-closed allowlist and the hourly `scheduled()` cron are both confirmed present in the deployed code; not independently re-tested this round. |
| Backups + restore verification | **Verified working in Production** | Real, independently-confirmed GitHub Actions runs today (2026-11-01): nightly backup (run `41332059400`, success) immediately followed by a monthly restore-verification run (`41332148209`, success) that read-only evidence confirms genuinely used that exact new backup -- decrypt, restore into a scratch D1, integrity/foreign-key checks, schema comparison, and cleanup all succeeded, against the now-corrected Production baseline. |

## Regression protection -- IMPLEMENTED 2026-11-01, wired into the real deploy process

Both safeguards below are real, committed, tested code -- not proposals.
Both are wired into `package.json`'s `deploy:*-independent` scripts
themselves, so they run automatically, not as a separate manual step
someone has to remember.

### A. `scripts/check-production-feature-fingerprints.mjs`

Runs automatically as part of `pnpm run deploy:staging-independent` and
`deploy:production-independent`, immediately after the build and
`verify-build-manifest.mjs`, before `wrangler deploy`. Two layers, per
explicit instruction not to rely on text search alone:

1. **Fingerprint check**: one short, distinctive string per feature
   marked "Verified working" above (`AddToGoogleCalendarLink`, `Use
   donor address`, `scheduleProspectMeeting`, `completeProspectMeeting`,
   `runScheduledAgendaSend`), grepped across the freshly built `dist/`.
   Catches "this code isn't in the bundle at all" -- the exact 2026-
   10-25 failure mode.
2. **Behavioral check**: actually RUNS a short list of this project's
   own real test files (`tests/trip-calendar-link.test.mjs`,
   `tests/trip-calendar-missing-table-regression.test.mjs`,
   `tests/d1-restore-order.test.mjs`) as real subprocesses, not merely
   checking they exist. Catches a fingerprint string surviving in
   `dist/` while the actual behavior underneath it is broken, which a
   text search alone cannot.

Fails loudly and specifically (names exactly which fingerprint or
which test failed) and refuses to deploy. Unit-tested itself
(`tests/check-production-feature-fingerprints.test.mjs`, 5 cases
including a real CLI spawn against a real temp `dist/`).

### B. `scripts/check-production-branch-ancestry.mjs`

Runs automatically as part of `deploy:production-independent` (not
Staging -- this one specifically targets the Production-deployment
risk). Takes the current live Production commit as an explicit,
required argument or `PRODUCTION_LIVE_COMMIT` environment variable
(read from the live Worker's own Data Health page or `wrangler
deployments list`, the same step every prior Production deployment
in this project's history already performs by hand) and confirms the
commit about to be deployed is a real git descendant of it
(`git merge-base --is-ancestor`). If the two have diverged -- exactly
what happened on 2026-10-25 -- it refuses to deploy and names both
commits plus the exact `git diff`/`git log` commands to review what
would be lost.

**Proven against the real incident**: running this check with the
actual 2026-10-25 commits (`354b889` as "current Production",
`58a9c60e` as "candidate") correctly fails with "is NOT a descendant."
Running it with a genuine descendant pair correctly passes. Unit-
tested (`tests/check-production-branch-ancestry.test.mjs`, including
a real CLI spawn against this repository's own real, known-diverged
history). **Exercised for real in a live Production deployment**
(2026-11-01, commit `2536c52`, `PRODUCTION_LIVE_COMMIT=dfcc150...`
passed as part of the actual `deploy:production-independent` run,
both checks running automatically as part of the real deploy chain,
not as a separate manual step) -- see AI-HANDOFF.md's "Authorized
Production Deployment" entry.

### Pre-deployment checklist (practical, not a framework)

The two checks above now cover items 1-2 automatically. What's still a
human judgment call before every Production deployment:

1. **Diff review, not just the new feature**: `git diff <current-live-Production-commit>..<commit-about-to-deploy> --stat` and actually read the file list -- not just confirm the intended change is there, but notice anything conspicuously ABSENT that you'd expect to still be touched/present.
2. Everything this project's deployment entries already do well and should keep doing: record the pre-deploy Worker version as the rollback target, confirm a fresh backup exists, re-run the full test suite and build at the exact commit immediately before deploying, verify live post-deploy.
3. **Add a new fingerprint entry to this document and to `FEATURE_FINGERPRINTS` the same day a new feature is independently verified working** -- the check can only protect what it knows about.
