# AI Project Handoff

This file is an index/summary for another AI session (Claude or ChatGPT)
picking up this project. Git history, source code, tests, migrations, and
the actual deployed/D1 state remain the source of truth — this file only
tells you where to look and what has and hasn't happened. If this file and
the repository/infrastructure disagree, trust the repository/infrastructure.

## Current Git State

Branch:
feature/independent-cloudflare-sandbox

Current HEAD:
391a5095c20450daa57cbe37a08e0e329944c9d4

origin/feature/independent-cloudflare-sandbox:
391a5095c20450daa57cbe37a08e0e329944c9d4

origin/main:
4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58

Working tree:
clean

## Latest Completed Task

Multi-donor shared outreach activities (log one meeting/text/email once,
link it to several donors) — backend (Phase 1) and UX (Phase 2), both
committed and pushed to the feature branch. Not yet migrated, deployed, or
live-verified.

Relevant commits:
- Phase 1 (schema + backend + recipient-aware scoring): `c42cca30ef38c0da1986c3f5e800f6d1b3482400`
- Phase 2 (capture-form UX, edit/remove/delete routes + UI, Meeting Brief copy): `391a5095c20450daa57cbe37a08e0e329944c9d4`

Phase 1 added a `shared_activities` parent table plus nullable
`shared_activity_id`/`role` columns on `interactions` (migration
`drizzle/0030_shared_activities.sql`), a bulk-create route
(`POST /api/interactions/shared`), and a `lastSubstantiveContactAt` signal
so recipient-role touches update Last Contact without suppressing
reconnect-contact-gap recommendations. Every existing single-donor query
path is unchanged. Phase 2 added the capture-form UX (single/multiple
donor toggle, recipient picker, role picker, large-selection confirm),
`PATCH`/`DELETE` on `/api/interactions/shared/[id]` (edit once, remove one
recipient, delete the whole activity), and wired the role-aware "Sent to N
donors" / "N participants" copy into the Meeting Brief page (the timeline
already had it from Phase 1).

For full detail: `git show c42cca3` and `git show 391a509` (both commit
messages are self-contained root-cause/behavior explanations), plus
`tests/shared-activity-ux.test.mjs` for the exact behavioral contract.

## Important Product Decisions

Durable — do not accidentally reverse these:

- Shared multi-donor activities use one canonical `shared_activities`
  parent plus per-donor `interactions` rows (Option C from the original
  design review), not a fully normalized join table or per-donor row
  cloning.
- `role='recipient'` represents broadcast/outbound recipients (text,
  email, photo/update sent to many).
- `role='participant'` represents actual participants (shared
  meeting/call).
- Recipient touches update Last Contact.
- Recipient touches do NOT suppress substantive/contact-gap outreach
  recommendations (`reconnect_contact_gap` reads
  `daysSinceSubstantiveContact`, which excludes `role='recipient'` rows).
- Participant touches and every existing single-donor interaction type
  continue to count as substantive contact, unchanged.
- One role applies to the whole shared activity in v1 (not per-donor).
- Bulk activity creation never automatically creates reminders or
  recommendations, for any recipient.
- Single-donor interaction entry remains on the existing
  `POST /api/interactions` / `PATCH /api/interactions/[id]` path,
  untouched.
- The multi-donor shared route (`/api/interactions/shared`) only engages
  for 2+ donors; exactly 1 donor uses the legacy single-donor path.
- Text/Message is NOT an implemented interaction type — adding it would
  require rebuilding `interactions.type`'s CHECK constraint (a new
  migration beyond 0030 touching existing data). Deliberately deferred,
  not an oversight.
- Photo is not, and should not become, a separate interaction type —
  it's represented by its real channel (email/text/etc.) plus summary
  text.
- Backend recipient cap is 200 donors per shared activity
  (`MAX_RECIPIENTS` in `app/api/interactions/shared/route.ts`).
- Large-selection UI confirmation begins at 15 selected donors
  (`LARGE_SELECTION_CONFIRM_THRESHOLD` in `CaptureExperience.tsx`) — a UX
  threshold, not a technical limit; it never blocks the save.

## Database / Migration State

Migration `0030_shared_activities.sql`:
**UNAPPLIED**

The code on `feature/independent-cloudflare-sandbox` (both Phase 1 and
Phase 2) depends on this migration but it has **NOT** been applied to
Independent Staging D1 (or any database). Deploying the current feature
branch code without first applying this migration would break against
the live schema (no `shared_activities` table, no
`interactions.shared_activity_id`/`role` columns).

No migration beyond 0030 exists. `production-baseline/schema-manifest.json`
on this branch has already been regenerated to include it
(`sourceMigrations.length === 31`) — that regeneration is a local file
transform against a throwaway in-memory SQLite instance, not a real D1
operation, and does not itself apply anything to a database.

## Deployment State

Last deployed feature-branch commit (verified live via Independent
Staging's own `/health` page "Deployed version" badge earlier this
session): `97dd984f96538c12f6c1edbd6cb9049258e4d894` — this predates both
the Phase 1 and Phase 2 work above.

Current code ahead of deployment: `97dd984` → `c42cca3` (Phase 1) →
`391a509` (Phase 2). **Neither Phase 1 nor Phase 2 is live.** Nothing has
been deployed since `97dd984`.

## Verification

Latest known (Phase 2, this session):

pnpm test:
PASS (all suites, including new `tests/shared-activity-ux.test.mjs`)

pnpm exec tsc --noEmit:
PASS

pnpm run build:staging-independent:
PASS (`/api/interactions/shared` and `/api/interactions/shared/:id`
confirmed present in the build's route list)

No known failing or skipped checks. All verification above was run
locally against the feature-branch worktree, not against a deployed
environment.

## Safety / Infrastructure State

This session's Phase 1 + Phase 2 work and this handoff commit:
- D1: not touched (migration 0030 written but not applied to any database)
- R2: not touched
- Backup/restore workflows (`.github/workflows/d1-*.yml`): not touched
- Production: not touched
- `origin/main`: not touched (checked before every push this session;
  confirmed unchanged at `4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`)

## Outstanding Work / Known Limitations

- Migration 0030 still needs a controlled application to Independent
  Staging D1 — not yet done.
- Phase 1 + Phase 2 still need a staging deployment and live verification
  — not yet done. Current live deployment predates this feature entirely.
- Text/Message interaction type remains deferred (see Product Decisions)
  — would need its own migration decision, separate from 0030.
- Shared-activity recipient/participant list editing beyond "remove one
  donor" (e.g. adding a donor to an already-saved activity) was not built
  in v1 — only create, edit summary/type/date, remove one, and delete
  whole activity exist.
- Meeting Brief's other surfaces (discussion topics, people-mentioned)
  were not made role-aware — only the "Last Interaction" card was, per
  the Phase 2 scope. Not identified as a defect, just unbuilt.

## Next Approval Required

"Apply migration 0030 to Independent Staging, verify schema/data safety,
deploy the Phase 1 + Phase 2 commits, then perform controlled live testing
beginning with a 2-donor shared recipient activity."

Do NOT perform that action without explicit user approval.

## Last Updated

2026-08-19T00:05:58Z
Claude (Sonnet 5) — Phase 2 UX push + creation of this handoff file,
session `session_01DoQiMShaMrVYHvopkVj581`
