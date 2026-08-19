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
aa2a8b7c858acb984358da8a82c2d580734f1222

origin/feature/independent-cloudflare-sandbox:
aa2a8b7c858acb984358da8a82c2d580734f1222

origin/main:
4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58

Working tree:
clean

## Latest Completed Task

Four live mobile-usability fixes, all on `feature/independent-cloudflare-sandbox`, deployed and live-verified on Independent Staging:
1. `continue_conversation` no longer manufactures generic "Continue the
   conversation about X" copy from a bare recent touch; it only fires when
   the note names a real commitment, otherwise the existing honest empty
   state ("No suggested action available") shows instead.
2. The donor-page KPI grid lets Suggested Action span full width on
   mobile beneath the three numeric tiles, instead of squeezing prose
   into a half-width 2x2 column.
3. Shared-activity edit now states the exact affected-donor count
   ("This change affects all N donors...") and gained a separate
   non-destructive "Add note for this donor" action reusing the existing
   single-donor capture form.
4. RecipientPicker's mobile search-result rows no longer overlap (a CSS
   grid auto-row-sizing bug collapsed every row to a uniform ~49px track
   regardless of wrapped content); the secondary metadata line is also
   restrained to one truncating line.

Relevant commits (all on `feature/independent-cloudflare-sandbox`, all
pushed):
- Phase 1 (shared-activity schema + backend + recipient-aware scoring): `c42cca30ef38c0da1986c3f5e800f6d1b3482400`
- Phase 2 (shared-activity capture-form UX, edit/remove/delete routes + UI, Meeting Brief copy): `391a5095c20450daa57cbe37a08e0e329944c9d4`
- Text Message type (migration 0031 + app-layer propagation + tests): `1c2273537403f790f9670f468125606f312b5c43`
- Mobile UX fixes (recommendation wording/layout, shared-edit clarity, RecipientPicker overlap): `aa2a8b7c858acb984358da8a82c2d580734f1222` (current HEAD)

For behavior detail: `git show c42cca3` / `git show 391a509` / `git show
1c22735` / `git show aa2a8b7` (self-contained commit messages), plus
`tests/shared-activity-ux.test.mjs`, `tests/text-message-type.test.mjs`,
and `tests/mobile-ux-fixes.test.mjs`.

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
- Photo is not a separate interaction type — represented by its real
  channel + summary text (e.g. "Text Message" with the photo described in
  the note). This also governs Text Message: WhatsApp/iMessage/SMS/photo
  are all subchannels of the one `text` type, never their own type.
- Backend recipient cap: 200 donors per shared activity.
- Large-selection UI confirmation begins at 15 selected donors (never
  blocks the save) — live-verified with 16 selected.
- **Text Message is now a real, implemented interaction type** — canonical
  DB value `text`, display label "Text Message". `interactions.type` has
  no CHECK constraint in the live schema (enforcement is application-level
  only, via the `kinds`/`KINDS`/`allowedKinds` validation sets), so only
  `shared_activities.type`'s CHECK required a migration (0031) to widen.
  Both TypeScript enums are kept in sync by convention, not by a shared DB
  constraint — see the doc comments on both columns in `db/schema.ts`.
- Text Message role/scoring semantics are NOT special-cased: the existing
  generic role-based rule above (`role='recipient'` = broadcast,
  `role='participant'` = substantive) applies to Text Message exactly like
  every other type, with no per-type branch — live-verified directly at
  the data layer (see Verification below). Text Message defaults to
  `role='recipient'` in the multi-donor picker (`ROLE_DEFAULT_BY_KIND` in
  `CaptureExperience.tsx`), remaining overridable to `participant` via the
  existing role picker.
- `continue_conversation` (in `lib/relationships/recommendation-candidates.ts`)
  now only fires when the most recent completed interaction's note
  contains real commitment language (reused from
  `relationshipSnapshotDetails` in `lib/capture/interaction.ts`) — no
  longer on the mere existence of a recent touch. Its eligibility window
  (≤30 days) and every other candidate/the scoring formula in
  `recommendation-rank.ts` are unchanged. When it doesn't fire and
  nothing else applies, the recommendation is honestly `null` — the UI's
  existing "No suggested action available" / "None available" copy
  covers that, no new fallback string was added.
- The donor page's shared-activity row now offers a separate
  "Add note for this donor" action (a plain link to
  `/capture?donorId=...`, same prefill convention as the page's own
  "+ Log interaction" link) alongside "Edit shared activity". This is
  structurally guaranteed to create only an ordinary single-donor
  interaction (`shared_activity_id`/`role` both null) — the single-donor
  `POST /api/interactions` route never references `shared_activities`.
  "Detach and customize" was NOT built; not needed given this reuse.

## Database / Migration State

Migration `0030_shared_activities.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-19. (See prior verification detail in git history of this file —
unchanged since, not re-verified in this update.)

Migration `0031_interactions_text_type.sql`:
**APPLIED** to `fundraising-os-staging-db` (Independent Staging) on
2026-08-18.

Applied via `wrangler d1 execute fundraising-os-staging-db --remote --file
drizzle/0031_interactions_text_type.sql --config wrangler.staging.jsonc`.
7 statements executed (58 rows written — the 2 pre-existing
`shared_activities` rows being rebuilt with the widened CHECK). Verified
directly against `sqlite_schema` pre/post: `interactions`'s own table DDL
and all 3 of its indexes (`interactions_donor_date_idx`,
`interactions_shared_activity_idx`,
`interactions_shared_activity_donor_uidx`) were confirmed present and
untouched (this migration never rebuilds that table — it has no CHECK
constraint to widen); `shared_activities`'s CHECK now reads `type IN
('call','email','meeting','visit','note','personal','gift','text')` and
its index (`shared_activities_user_date_idx`) survived the rebuild;
row counts unchanged pre/post (`interactions`=12, `shared_activities`=2).

No migration beyond 0031 exists or has been applied. The mobile UX
fixes task (current HEAD) is application-layer + CSS only — no schema
change, no migration.

## Deployment State

**Live.** Deployed commit `aa2a8b7c858acb984358da8a82c2d580734f1222`,
Worker version `1b1fdd8c-5650-4f62-86b9-842d52fa7af7`, confirmed via the
`wrangler deploy` output itself (Current Version ID).

Worker: `fundraising-os-staging`
URL: `https://fundraising-os-staging.sgoldstein.workers.dev`
D1: `fundraising-os-staging-db` (bound as `env.DB`)

Multi-donor shared activities (Phase 1 + Phase 2), Text Message, and the
mobile UX fixes are all live and have been exercised end-to-end against
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

**Live, Text Message rollout (2026-08-18), using two real donors from the
actual staging roster, both created via the deployed app UI and cleaned up
afterward:**

- Single-donor Text Message: created for "Dr. & Mrs. Yaakov Abdelhak" via
  the single-donor capture form. Confirmed at the data layer: `type =
  'text'`, `role = NULL`, `shared_activity_id = NULL`. Timeline badge
  read "Completed · Text Message" (friendly label, never the raw enum
  value) and "Last meaningful contact" updated to the capture date.
- Shared Text Message, `role='recipient'`, 2 donors ("Mr. & Mrs. Ari
  Abramovitz", "Mr. & Mrs. Shaya Abramson"): the multi-donor picker
  defaulted the role toggle to "Recipients" the instant Text Message was
  selected (no manual step needed), matching the approved default.
  Confirmation screen read "Sent to 2 donors" / "Text Message on Aug 18,
  9:42 PM" and explicitly stated Last Contact was updated but the touch
  "does not, by itself, count as a substantive-contact touch" and that
  "No reminders were created." **Verified directly against
  `fundraising-os-staging-db`, not just the UI**: both `interactions` rows
  had `type='text'`, `role='recipient'`, the same `shared_activity_id`;
  the plain Last-Contact query (`MAX(occurred_at)`, no role filter)
  returned the touch timestamp for both donors; the exact production
  substantive-contact query (same query, `AND (role IS NULL OR role !=
  'recipient')`) returned **zero rows** for both donors, proving the
  recipient touch does not suppress `reconnect_contact_gap`; a query
  against `recommendations` for either donor with an open, text-related
  row returned 0 — no automatic reminder was created.
- No per-type branch exists anywhere in the scoring path — the SQL
  condition that excludes `role='recipient'` from
  `lastSubstantiveContactAt` (in `lib/workspace/live-data.ts`) is entirely
  type-agnostic, so this behavior is structural, not something that could
  regress for Text Message specifically without also breaking every other
  shared type.
- Cleanup: the single-donor row was archived via `DELETE
  /api/interactions/:id` (`action: "archive"`) and the shared activity was
  deleted via `DELETE /api/interactions/shared/:id` (`action:
  "delete-activity"`) — both are the app's own normal routes (invoked
  directly rather than by clicking the UI's confirm-dialog buttons, to
  avoid a blocking native `window.confirm()` in browser automation; the
  server-side effect is identical to clicking through). Final state
  confirmed via SQL: all 3 test rows now read `source =
  'archived:capture:text'` or `source = 'cancelled:manual'` — soft
  ended, never hard-deleted, consistent with every other cleanup in this
  project.

**Live, Mobile UX fixes rollout (2026-08-18), against real staging donors
and a real shared activity, cleaned up afterward:**

- **RecipientPicker overlap**: `resize_window` does not change the true
  rendered viewport in this environment (confirmed: `window.innerWidth`
  stayed 1280 after requesting 390×844) — same limitation as the prior
  session. Instead, the real `.content` container was narrowed to 375px
  via direct DOM style (same layout engine, same real CSS cascade, just a
  narrowed element instead of a narrowed window — valid for this bug
  since none of the relevant grid rules are viewport-media-query-gated).
  Before the fix: searching "Rosen" showed severely overlapping rows
  (`firstRow.offsetHeight` was 49px while `firstRow.scrollHeight` — the
  content's actual required height — was 175px). After deploying the
  fix: rows are fully separated, each row's height matches its own
  content, secondary metadata truncates to one line
  ("58252 · drose…" instead of wrapping across 3+ lines).
- Selected-donor state confirmed live: tapping a result shows a
  checkmark, green highlight, and "1 selected" with a chip below.
- **Shared-activity edit warning**: opening "Edit shared activity" on a
  real 2-donor activity showed, verbatim: "This change affects all 2
  donors linked to this activity -- it edits the one shared summary,
  type, and date, not just this donor's copy," in a visually distinct
  amber box, and the save button read "Save for all 2 donors".
- **Donor-specific note**: clicking "Add note for this donor" navigated
  to `/capture?donorId=...` prefilled with the correct donor in
  single-donor mode. After saving, verified directly against D1: exactly
  one new `interactions` row, `donor_id` = the one donor, `role`/
  `shared_activity_id` both `NULL`. The shared activity's own row was
  re-queried afterward and its `summary`/`recipient_count` (2) and both
  linked donors' `role='participant'` were unchanged.
- **Suggested Action wording**: reproduced the exact originally-reported
  case (a Text Message interaction with note "Text message", no
  commitment language) — Suggested Action showed "None available" /
  "No suggested action available" in place of the old "Continue the
  conversation from the recent text about 'Text message'."
- **Mobile Suggested Action layout**: with the `.content` container
  narrowed to 375px and the exact shipped CSS rule applied, the three
  numeric KPI tiles (Lifetime Paid, Most Recent Paid Gift, Open
  Commitments) rendered as compact columns in one row, and Suggested
  Action spanned the full width beneath them with room for natural
  prose — confirmed visually via screenshot.
- Cleanup: all 3 test rows (the shared activity + its 2 links, plus the
  donor-specific note) archived/cancelled via the app's own routes,
  confirmed via SQL (`source` = `archived:capture:email` /
  `cancelled:manual`), never hard-deleted.

## Safety / Infrastructure State

This rollout (shared-activity, Text Message, and mobile UX fixes work):
- D1: migrations 0030 and 0031 applied to `fundraising-os-staging-db`
  only; all read/write operations scoped to that database via `wrangler
  d1 execute --remote`; no other database touched.
- R2: not touched.
- Backup/restore workflows (`.github/workflows/d1-*.yml`): not touched.
- Production: not touched (no production Worker/D1 binding exists in
  `wrangler.staging.jsonc`; confirmed before any write).
- `origin/main`: not touched — checked before and after both the Text
  Message and mobile-UX-fixes rollouts, unchanged at
  `4ea1d5ec98ee2a2ef010154ba02a9ad278aa6a58` throughout.
- No unexpected `recommendations` rows were created at any point
  (checked directly by donor_id + status/action filter after each live
  test — 0 rows).
- `donors`/`giving_activities` row counts unaffected by any of these live
  tests (interactions/shared_activities only).

## Outstanding Work / Known Limitations

- True device/viewport visual QA is still not possible in this
  automation environment (`resize_window` does not change
  `window.innerWidth`). The mobile UX fixes task worked around this by
  narrowing the real `.content` DOM element to 375px and applying the
  exact shipped CSS — a real-cascade, real-layout-engine check that is
  strong evidence but not identical to a true device viewport (it can't
  exercise viewport-media-query-gated rules like the sidebar/nav
  collapse). Recommend a genuine phone/tablet check, or a different
  automation environment, before treating any mobile layout claim here
  as fully pixel-verified.
- The `continue_conversation` vs. `reconnect_contact_gap` ranking
  interaction described above (Verification section, from the earlier
  shared-activity rollout) is unaffected by this task's wording fix and
  remains a real, observed UX nuance worth a product decision if the
  copy ever needs to distinguish "continuing a broadcast" from
  "continuing a real conversation." continue_conversation's ELIGIBILITY
  on a broadcast recipient touch was explicitly not changed in this task
  (only its wording, and only when it does fire) — flagging again per
  the task's own instruction to report rather than silently redesign it.
- Shared-activity recipient list editing beyond "remove one donor" (e.g.
  adding a donor to an already-saved activity) is not built.
- Meeting Brief's other surfaces (discussion topics, people-mentioned)
  are not role-aware — only the "Last Interaction" card is.
- "Add note for this donor" always launches an empty single-donor
  capture form — it does not pre-fill any context from the shared
  activity it was opened from (e.g. the shared summary or date). Not
  requested by this task; worth considering if fundraisers want that
  context carried over.

## Next Approval Required

None blocking — the shared-activity, Text Message, and mobile UX fixes
are all live and verified on Independent Staging.

Optional follow-ups, each would need its own explicit approval before
work begins:
- A genuine device/alternate-tooling mobile visual QA pass to close the
  viewport-emulation gap above.
- A product decision on the `continue_conversation`/`reconnect_contact_gap`
  ranking nuance and/or continue_conversation's eligibility on broadcast
  recipient touches, if judged worth addressing.
- Pre-filling shared-activity context into the new "Add note for this
  donor" capture form, if fundraisers want it.

## Last Updated

2026-08-18T23:15:00Z
Claude (Sonnet 5) — Four live mobile-usability fixes shipped: continue_conversation
no longer manufactures generic copy from a bare recent touch (only fires
on real commitment language); donor-page Suggested Action spans full
width on mobile instead of a squeezed 2x2 column; shared-activity edit
now states the exact affected-donor count and gained a separate
"Add note for this donor" action; RecipientPicker's mobile overlap bug
(CSS grid auto-row-sizing collapsing to a uniform track) is fixed.
Deployed (commit `aa2a8b7`, Worker version
`1b1fdd8c-5650-4f62-86b9-842d52fa7af7`), live-verified against real
staging data including direct D1 checks, test data cleaned up via normal
app routes, this handoff updated to reflect live state. Session
`session_01DoQiMShaMrVYHvopkVj581`.
