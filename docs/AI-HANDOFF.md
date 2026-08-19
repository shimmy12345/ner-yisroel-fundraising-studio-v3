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
4175c7f180fdd96a5b5a97dd143108f5659c2185

origin/feature/independent-cloudflare-sandbox:
4175c7f180fdd96a5b5a97dd143108f5659c2185

origin/main:
4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58

Working tree:
clean

## Latest Completed Task

Multi-donor shared outreach activities (log one meeting/text/email once,
link it to several donors) — backend (Phase 1), UX (Phase 2), and the
controlled Independent Staging rollout (migration + deploy + live
verification) are all complete. **This feature is live on Independent
Staging.**

Relevant commits (all on `feature/independent-cloudflare-sandbox`, all
pushed):
- Phase 1 (schema + backend + recipient-aware scoring): `c42cca30ef38c0da1986c3f5e800f6d1b3482400`
- Phase 2 (capture-form UX, edit/remove/delete routes + UI, Meeting Brief copy): `391a5095c20450daa57cbe37a08e0e329944c9d4`
- Handoff doc: `4175c7f180fdd96a5b5a97dd143108f5659c2185` (current HEAD)

For behavior detail: `git show c42cca3` / `git show 391a509` (self-contained
commit messages), plus `tests/shared-activity-ux.test.mjs`.

## Important Product Decisions

Durable — do not accidentally reverse these:

- Shared multi-donor activities use one canonical `shared_activities`
  parent plus per-donor `interactions` rows, not a fully normalized join
  table or per-donor row cloning.
- `role='recipient'` = broadcast/outbound recipients (text, email,
  photo/update sent to many).
- `role='participant'` = actual participants (shared meeting/call).
- Recipient touches update Last Contact.
- Recipient touches do NOT suppress substantive/contact-gap outreach
  recommendations — **live-verified** (see Verification below):
  `daysSinceSubstantiveContact` stays `null` for a donor whose only touch
  is `role='recipient'`, even though `daysSinceLastContact` updates.
- Participant touches and every existing single-donor interaction type
  continue to count as substantive contact, unchanged.
- One role applies to the whole shared activity in v1 (not per-donor).
- Bulk activity creation never automatically creates reminders or
  recommendations, for any recipient — live-verified.
- Single-donor interaction entry remains on the existing
  `POST /api/interactions` / `PATCH /api/interactions/[id]` path,
  untouched.
- The multi-donor shared route (`/api/interactions/shared`) only engages
  for 2+ donors.
- Text/Message is NOT an implemented interaction type — would require
  rebuilding `interactions.type`'s CHECK constraint (a migration beyond
  0030, touching existing data). Deliberately deferred.
- Photo is not a separate interaction type — represented by its real
  channel + summary text.
- Backend recipient cap: 200 donors per shared activity.
- Large-selection UI confirmation begins at 15 selected donors (never
  blocks the save) — live-verified with 16 selected.

## Database / Migration State

Migration `0030_shared_activities.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-19.

Applied via `wrangler d1 execute fundraising-os-staging-db --remote
--file=drizzle/0030_shared_activities.sql`. All 8 statements in the file
executed successfully. Post-migration verification (read-only, against
real staging data) confirmed: `interactions`/`donors`/`recommendations`
row counts unchanged (8/248/4 immediately pre-migration), all 8
pre-existing `interactions` rows have `shared_activity_id IS NULL AND
role IS NULL`, `shared_activities` and `shared_activity_recipient_audits`
both exist with the exact designed DDL (including the partial unique
index `interactions_shared_activity_donor_uidx`), and table count went
from exactly 42 → 44 (no unrelated schema drift).

No migration beyond 0030 exists or has been applied.

## Deployment State

**Live.** Deployed commit `4175c7f180fdd96a5b5a97dd143108f5659c2185`,
Worker version `8f9b01f2-5999-49f1-8475-df8134f1dc87`, verified via the
live `/health` page's "Deployed version" badge after deploy.

Worker: `fundraising-os-staging`
URL: `https://fundraising-os-staging.sgoldstein.workers.dev`
D1: `fundraising-os-staging-db` (bound as `env.DB`)

Phase 1 + Phase 2 are both live and have been exercised end-to-end against
real staging data (see Verification).

## Verification

**Automated (local):**
pnpm test: PASS (all suites)
pnpm exec tsc --noEmit: PASS
pnpm run build:staging-independent: PASS

**Live, on Independent Staging (2026-08-19), using two real donor pairs
from the actual staging roster, all created via the deployed
`/api/interactions/shared` API and cleaned up afterward:**

- 2-recipient shared activity: parent + 2 linked `interactions` rows
  created, both `role='recipient'`, 2 "added" audit rows, both donor
  timelines showed "Sent to 2 donors" with the canonical summary, Last
  Contact updated for both. **Scoring rule confirmed directly at the data
  layer**: the substantive-contact query (excludes `role='recipient'`)
  returned no row for the test donor even after the touch, while the
  all-types Last Contact query did — proving `reconnect_contact_gap` is
  not suppressed by a recipient-only touch. No recommendation/reminder row
  was created (`recommendations` count stayed at 4 throughout).
- 2-participant shared activity: parent + 2 linked rows, both
  `role='participant'`, timeline/Meeting Brief showed "2 participants",
  Last Contact updated, and the substantive-contact query **did** return a
  row for these donors (proving a participant touch counts as substantive,
  as designed). No auto-reminder created.
- Edit: one `PATCH` updated only `shared_activities.summary`; both linked
  donors' timelines immediately showed the new text; the per-row
  `interactions.summary` columns were confirmed unchanged (no fan-out
  write).
- Remove one recipient: only that donor's `interactions` row was
  soft-cancelled (`source` → `cancelled:...`); the other donor's row and
  the parent were untouched; `recipient_count` decremented 2→1; exactly
  one "removed" audit row was added; the removed donor's Last Contact
  correctly reverted to "None recorded".
- Delete whole activity: performed on both test activities. Every
  still-linked row was cancelled and `shared_activities.deleted_at` was
  set on both. Final sweep confirmed zero active `shared_activities` rows
  and zero active `interactions` rows still pointing at a
  `shared_activity_id` — no test data left active.
- Mobile: **functional** behavior verified live (mode toggle, live donor
  search/multi-select with no duplicates, role picker with type-based
  defaults, 15+/16-selected large-selection confirmation showing the exact
  approved wording and not auto-saving) all confirmed working on the
  deployed app. The **narrow-viewport visual** check (actual small-screen
  layout) could not be completed — the browser-automation tooling's window
  resize did not change the rendered viewport in this environment (stayed
  ~1280×720 regardless of the requested size). The responsive CSS rules
  themselves (chip wrapping, `@media (max-width:760px)` stacking for the
  picker/role/confirm UI) are already asserted present and passing in
  `tests/shared-activity-ux.test.mjs`, but true small-screen visual QA is
  still outstanding — see Outstanding Work.

**One live-testing observation, not a defect:** on a donor's very first
logged interaction (of ANY type — recipient, participant, or an ordinary
single-donor touch), the `continue_conversation` recommendation becomes
eligible (it only requires *some* completed interaction to exist) and
generally outranks `reconnect_contact_gap` in the "Suggested Action"
slot, even when the underlying touch is a broadcast. This is pre-existing
ranking behavior in `recommendation-rank.ts`, identical regardless of
role, and was explicitly out of scope for the Phase 1 approved rule
(which is specifically about `reconnect_contact_gap`'s own suppression
logic, confirmed correct above). Net effect: the "Last Contact recent +
reconnect_contact_gap clarifier" UI scenario is rarer in practice than
it might seem, because `continue_conversation` tends to win once any
interaction has ever been logged. Not changed as part of this rollout;
flagged for a future decision if desired.

All test interactions/shared-activities have been soft-cancelled/deleted;
none are active. `interactions` table now has 12 rows total (8 original +
4 test rows, all 4 now cancelled, never hard-deleted).

## Safety / Infrastructure State

This rollout:
- D1: migration 0030 applied to `fundraising-os-staging-db` only; all
  read/write operations scoped to that database via `wrangler d1 execute
  --remote`; no other database touched.
- R2: not touched.
- Backup/restore workflows (`.github/workflows/d1-*.yml`): not touched.
- Production: not touched (no production Worker/D1 binding exists in
  `wrangler.staging.jsonc`; confirmed before any write).
- `origin/main`: not touched — checked before and after this rollout,
  unchanged at `4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58`.
- No unexpected `recommendations` rows were created at any point
  (count stayed at 4 throughout every phase).
- `donors`/`giving_activities` row counts and the two test donors'
  `updated_at`/`relationship_summary`/`institutional_memory` fields were
  confirmed unchanged by the shared-activity operations.

## Outstanding Work / Known Limitations

- Narrow-viewport (real small-screen) visual QA for the multi-donor
  picker is still outstanding — automation tooling in this environment
  couldn't resize the actual viewport. Recommend a manual phone/tablet
  check (or a different automation environment) before relying on this
  for a real mobile fundraiser workflow.
- Text/Message interaction type remains deferred (needs its own migration
  decision, separate from 0030).
- The `continue_conversation` vs. `reconnect_contact_gap` ranking
  interaction described above (Verification section) is a real, observed
  UX nuance — not a defect in the approved scoring rule, but worth a
  product decision if the copy ever needs to distinguish "continuing a
  broadcast" from "continuing a real conversation."
- Shared-activity recipient list editing beyond "remove one donor" (e.g.
  adding a donor to an already-saved activity) is not built.
- Meeting Brief's other surfaces (discussion topics, people-mentioned)
  are not role-aware — only the "Last Interaction" card is.

## Next Approval Required

None blocking — the feature is live and verified on Independent Staging.

Optional follow-ups, each would need its own explicit approval before
work begins:
- Manual/alternate-tooling mobile visual QA to close the outstanding gap
  above.
- A product decision on the `continue_conversation`/`reconnect_contact_gap`
  ranking nuance, if it's judged worth addressing.
- Any future decision to add a real Text/Message type (new migration).

## Last Updated

2026-08-19T00:35:00Z
Claude (Sonnet 5) — Controlled Independent Staging rollout: migration
0030 applied, feature branch deployed, live verification (2-recipient,
2-participant, edit/remove/delete, mobile-functional) complete, this
handoff updated to reflect live state. Session
`session_01DoQiMShaMrVYHvopkVj581`.
