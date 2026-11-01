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
| Trip Planner -- "Use donor's home address" as meeting location | **Confirmed incomplete/unavailable on current Production** | Was built and Production-verified once (commit `adb97c0`, 2026-10-19), then dropped by an unrelated deployment on 2026-10-25 whose branch never incorporated it (see the AI-HANDOFF.md correction entry). Not present in the current working branch's code at all (`grep` for `googleCalendarTemplateUrl`/`formatDonorAddress` returns zero matches). |
| Trip Planner -- "Add to Google Calendar" link (template URL, no OAuth) | **Confirmed incomplete/unavailable on current Production** | Same root cause and evidence as the row above -- these two shipped together in the same commit. |
| Trip Planner -- automatic OAuth-based Google Calendar sync (create/update/cancel via the Google API) | Implemented, not active | Backend (`lib/calendar/`, `trip-calendar-sync.ts`, Settings UI) fully built and exercised live today against real Production (scheduling/rescheduling/cancelling correctly wrote `calendar_event_links` rows) -- but no real Google OAuth credential exists on Staging OR Production (`wrangler secret list` on both, 2026-11-01, shows only `GMAIL_OAUTH_*`), so no live Google API call has ever actually been made by this system. Deliberately gated behind an explicit owner-approved OAuth setup step that has never been taken, per the design doc's own rollout sequence -- not a bug. |
| AI Meeting Notes + donor-profile synchronization | Implemented, not independently re-verified this round | The "✦ AI meeting notes" link was observed present and reachable during today's live Trip Planner test, but its own save/sync behavior was not independently exercised this round. |
| Daily Fundraising Agenda email + donor recommendations | Implemented, not independently re-verified this round | The same-day recovery-window fix was deployed and source-verified earlier this session (commit `1b0b25a`, deployed), but this round did not independently confirm a real 9 AM send has fired and succeeded in Production since. |
| Production email scheduling (the underlying send guard/cron) | Implemented, not independently re-verified this round | `isRealEmailSendAllowed`'s fail-closed allowlist and the hourly `scheduled()` cron are both confirmed present in the deployed code; not independently re-tested this round. |
| Backups + restore verification | **Verified working in Production** | Real, independently-confirmed GitHub Actions runs today (2026-11-01): nightly backup (run `41332059400`, success) immediately followed by a monthly restore-verification run (`41332148209`, success) that read-only evidence confirms genuinely used that exact new backup -- decrypt, restore into a scratch D1, integrity/foreign-key checks, schema comparison, and cleanup all succeeded, against the now-corrected Production baseline. |

## Pre-deployment checklist (practical, not a framework)

Run before every Production deployment, in addition to whatever that
specific release's own task already requires:

1. **Ancestor check**: `git merge-base --is-ancestor <current-live-Production-commit> <commit-about-to-deploy>`. If this says the commit about to deploy is NOT a descendant of what's currently live, stop and ask explicitly -- this means some other line of work exists on Production that the new deploy doesn't know about, and deploying anyway will silently drop it, exactly as happened on 2026-10-25.
2. **Feature fingerprint check** (see below): run it against the freshly built `dist/` before `wrangler deploy`, not after.
3. **Diff review, not just the new feature**: `git diff <current-live-Production-commit>..<commit-about-to-deploy> --stat` and actually read the file list -- not just confirm the intended change is there, but notice anything conspicuously ABSENT that you'd expect to still be touched/present (e.g., a file you know exists on the live commit but doesn't appear anywhere in the new tree).
4. Everything this project's deployment entries already do well and should keep doing: record the pre-deploy Worker version as the rollback target, confirm a fresh backup exists, re-run the full test suite and build at the exact commit immediately before deploying, verify live post-deploy.

## Recommended automated regression test (proposed, not yet created)

**`scripts/check-production-feature-fingerprints.mjs`** -- a single,
small script, run against a freshly built `dist/` directory:

- For each row in this document marked "Verified working in
  Production," one short, distinctive source string that must appear
  somewhere in the compiled bundle (client or server). Examples:
  `AddToGoogleCalendarLink`, `googleCalendarTemplateUrl`,
  `CalendarSyncBadge`, `scheduleProspectMeeting`,
  `recordTripMeetingScheduled`, `D1_RESTORE_DATA_ORDER`,
  `runScheduledAgendaSend`.
- Exits non-zero and prints exactly which fingerprint(s) are missing
  if even one is absent. Never silently passes on a partial match.
- Wired into the deploy process as one line, immediately after the
  production build and before `wrangler deploy` -- refuses to deploy
  on any failure without an explicit, named override.
- Deliberately NOT a new test framework, not a new CI system, not a
  feature-flag service -- it reuses the exact manual `grep dist/`
  technique this project's own deployment history already performs by
  hand, every time, just made mandatory and automatic.

Not implemented this round -- this is a recommendation awaiting
approval, consistent with "investigation and documentation first."
