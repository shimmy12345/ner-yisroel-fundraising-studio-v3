# D1 Migration -> Main Restore/Baseline Sync Process

This document is the operating reference for keeping `main`'s restore/
schema baseline tracking (`production-baseline/schema-manifest.json`,
`lib/data-health/production-baseline.ts`, and -- for a migration that adds
a brand-new table -- `lib/operations/staging-reset.ts`/
`lib/operations/d1-restore-order.ts`) synchronized with
`feature/independent-cloudflare-sandbox`'s real schema, every time a
migration is added, without waiting for a failed GitHub Actions run to
notice.

## Why this exists

`feature/independent-cloudflare-sandbox` owns `fundraising-os-staging-db`'s
real, live schema. `main` keeps a *separate, independently committed*
mirror of that schema's shape, used by the monthly real-backup restore-
verification workflow. Those two copies only stay in agreement if
something updates `main`'s copy every time a migration lands on the
canonical branch -- see `docs/AI-HANDOFF.md`'s "D1 Monthly Restore
Verification Repair" and "D1 Migration Sync Automation" entries for the
full incident history (this has happened, unassisted, at least six
times).

## The two signals

GitHub Actions workflow `.github/workflows/d1-restore-sync-check.yml` has
two independent jobs on every push/PR touching a schema-relevant path:

- **`check`** -- unmodified, read-only, the sole authority on "is `main`
  synchronized?" Real drift always fails this job. Nothing else in this
  system ever changes that conclusion, including an automated PR already
  existing to fix it.
- **`prepare-sync`** -- runs only for a trusted push to the canonical
  branch or a manually authorized `workflow_dispatch` (never for a
  `pull_request` event, so it never runs with write privileges against
  untrusted PR-sourced code). When drift exists, it conservatively
  attempts to generate, validate, and open/update a pull request against
  `main` carrying the minimal fix. It never merges anything.

Reading a commit's checks together tells you exactly which of three
states you're in:

| `check` | `prepare-sync` | Meaning |
|---|---|---|
| pass | pass (no-op) | `main` is fully synchronized. |
| **fail** | pass | Drift exists; a synchronization PR is prepared and awaiting review -- link is in the job's own log. |
| **fail** | fail | Drift exists and could not be safely automated -- prepare this sync manually (see below). |

## Mandatory preflight (do this *before* pushing a migration)

1. Add the migration, apply it to Independent Staging, and confirm it
   works, per the usual process.
2. Run `node scripts/generate-production-baseline.mjs --write` (updates
   this branch's own `production-baseline/schema-manifest.json`) if you
   haven't already as part of the migration itself.
3. Run `node scripts/check-main-restore-sync.mjs`. If it reports "in
   sync," you're done -- nothing further needed for this step.
4. If it reports drift: optionally run
   `node scripts/prepare-main-restore-sync-patch.mjs` locally (read-only,
   zero side effects) to see exactly what the automation will propose.
   You do not need to open the PR yourself -- pushing the migration will
   cause `prepare-sync` to do that automatically -- but never leave this
   step unacknowledged in your own task's report. State explicitly
   whether you expect `prepare-sync` to handle it, or whether the change
   is outside its conservative scope (see below) and a human must
   prepare the sync by hand.

## What the automation can safely handle

`lib/operations/restore-sync-generator.ts`'s `planRestoreSyncPatch` only
ever proposes a patch for a migration that is a **pure addition**:

- A new column or index on an existing table.
- Nothing removed, retyped, renamed, or reordered on any existing
  table/index.
- **No new table at all.** Placing a new table correctly in the restore
  order requires real judgment about its foreign-key dependencies --
  deliberately left to a human, every time, following the exact same
  narrow-branch process used for every historical sync (see
  `docs/AI-HANDOFF.md`).

It refuses immediately -- never guesses -- for: a dropped or renamed
column (detected both via the raw migration SQL text and via a column-
list subsequence check against the old schema), a new table, a removed
table, a changed or removed index, or anything its own final self-
verification (re-running the exact same `compareCrossBranchRestoreState`
the `check` job uses, against the candidate patched state) doesn't
independently confirm resolves to "fully in sync."

When it refuses, `prepare-sync` fails with the specific reason in its own
log -- prepare that sync manually, following the same narrow-branch
pattern as every prior round (see `docs/AI-HANDOFF.md`'s "D1 Monthly
Restore Verification Repair" entries for worked examples, including the
new-table case).

## What the automation does when it can proceed

1. Generates the new `production-baseline/schema-manifest.json` (a
   verbatim copy of the canonical branch's own current manifest) and a
   text-patched `lib/data-health/production-baseline.ts` (migration count
   and a templated, mechanical doc comment -- less narrative than a
   hand-written sync, fully correct and traceable).
2. Applies that patch to a scratch worktree built from `main`'s real
   current tip, commits it under a dedicated bot identity, and
   **independently validates it there**: `main`'s own real `npm test`,
   `main`'s own real `npm run build`, and a fresh re-run of the
   unmodified `check-main-restore-sync.mjs` pointed at that candidate
   branch. Any of those failing is treated exactly like a refusal --
   nothing is ever pushed on a failed validation.
3. Only after all three validations pass: pushes the commit to one
   rolling branch, `automated/d1-restore-sync` -- **never a force-push**.

## Branch/PR safety (never touching a reviewed PR)

- If no automated branch exists yet, one is created.
- If the existing branch already carries the exact same generated
  content (a concurrent run won a push race, or nothing has changed),
  nothing happens -- a safe no-op.
- If the existing branch/PR has **any** human activity on it -- a review,
  a comment, or a commit not authored by the automation's own identity
  (`D1 Restore Sync Bot <d1-restore-sync-bot@users.noreply.github.com>`)
  -- it is **never touched again**. A fresh, separately-named branch
  (`automated/d1-restore-sync-<short-sha>`) and PR are opened instead,
  linking back to the one it does not replace, so a human reconciles
  them.
- Otherwise, a new commit is **appended** (never an amend, never a
  rewrite) to the existing branch and pushed normally.
- A concurrent push race that rejects this run's push is handled by
  re-fetching and comparing content, not by retrying with `--force`: if
  the winning push already matches this run's own generated content,
  that's a benign, expected outcome; if it's genuinely different, the
  automation refuses rather than overwrite it.

## Reviewing and merging an automated sync PR

The PR only ever touches `production-baseline/schema-manifest.json` and
`lib/data-health/production-baseline.ts`. It has already passed `main`'s
own real test suite, build, and the unmodified drift check before being
opened. Review it like any other PR and merge it through the normal
process -- **the automation never merges its own PR.**

## Local command reference

- `node scripts/check-main-restore-sync.mjs` -- the authoritative drift
  check (unchanged, read-only).
- `node scripts/prepare-main-restore-sync-patch.mjs [--out-dir <dir>]` --
  read-only; prints the plan as JSON, optionally writes the generated
  files to `<dir>` for inspection. Safe to run any time, as often as you
  like; never pushes, never calls the GitHub API.
- `node scripts/open-or-update-sync-pr.mjs [--apply]` -- without
  `--apply`, performs every read-only step (plan, look up the existing
  branch/PR, detect human activity, decide the action) and prints what it
  *would* do -- safe to run locally for diagnosis. `--apply` is what the
  CI job passes; only pass it yourself if you specifically intend to push
  and open/update a real PR.
