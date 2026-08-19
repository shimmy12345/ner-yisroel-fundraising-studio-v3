# Ask / Solicitation Feature — Design (not implemented)

Status: **DESIGN ONLY.** No schema, migration, or application code has been
written. No D1 writes were made. This document is the full audit and
design report; `docs/AI-HANDOFF.md` carries a summary and points here.

Product boundary (restated, governs every recommendation below): this is
**not** a CRM/opportunity pipeline. No sales stages, probability, weighted
pipeline, expected close date, forecasting, assigned-fundraiser workflows,
campaign hierarchy, opportunity dashboards, or pipeline management. The
only goal: let the system know, structurally, "we asked this donor for
$10,000 and it is still pending."

---

## 1. Existing architecture relevant to asks

Audited by reading the actual code (`db/schema.ts`, the recommendation
engine, Meeting Brief, Assistant, Today, imports, donor merge, and
infra), not assumed.

- **`giving_activities`** (JL Solutions import only — never fundraiser-
  entered) has `category: "completed_gift" | "open_pledge" |
  "partially_paid_pledge" | "event_or_ad" | "nonfinancial_entry" |
  "needs_review"`, derived purely from imported `committed_cents` /
  `paid_cents` / `balance_cents`. "Pledge" already means something
  specific here: a JL-recorded financial commitment with an outstanding
  balance (see `OPEN_PLEDGES_FOR_DONORS_SQL` /
  `lib/import/jl-payment-assignment.ts`'s `OpenPledge` type). This is
  **downstream of and later than** an Ask — a real JL pledge typically
  only exists once the back office has actually processed a pledge
  card/commitment, which may happen days or weeks after a fundraiser
  makes the ask, or never. **This codebase's existing word "pledge" must
  not be reused for the new feature** — it would collide with real
  financial-system-of-record data.
- **`lib/relationships/recommendation-evidence.ts` /
  `recommendation-candidates.ts` / `recommendation-rank.ts`** — the one
  shared Suggested Action engine. Every surface (donor page, Meeting
  Brief, Assistant, Today) builds the same `RecommendationEvidenceInput`
  shape and calls `buildRecommendationEvidence()` /
  `buildDonorRecommendation()`. Candidates are generated independently,
  hard-constrained (e.g. an open pledge vetoes `solicit` unless evidence
  postdates it), then scored: `certaintyMultiplier(certainty) * (0.35 *
  specificity + 0.35 * recency + 0.30 * urgency)`, `certainty` ∈
  `"confirmed"` (×1) / `"narrative"` (×0.85) / `"unconfirmed_historical"`
  (×0.55).
- **An existing `solicitCandidate` already exists** (`recommendation-
  candidates.ts`), and it is exactly the gap this feature closes: it
  regex-matches (`SOLICITATION_PATTERN` — `solicit|ask ... for|pledge
  request|...`) against `relationship_summary`/`institutional_memory`/
  `historicalContext` free text, and can never rise above `"narrative"`
  or `"unconfirmed_historical"` certainty (never `"confirmed"`, never
  `"high"` confidence) — it is structurally incapable of representing a
  real, structured fact. A new **confirmed**-certainty `open_ask`
  candidate will naturally outscore it whenever both fire for the same
  donor (only one candidate wins per donor — see `buildDonorRecommendation`
  — so no explicit suppression is required).
- **`recommendations`** table is the existing reminder system (`action`,
  `reason`, `status: open|completed|dismissed`, `dueAt`). Interaction
  capture (`app/api/interactions/route.ts`) already has a `reminder:
  "none"|"tomorrow"|"next-week"|"custom"` picker, a `reminderDueAt()`
  helper (`lib/capture/interaction.ts`), and inserts a `recommendations`
  row with `id = "activity-${interactionId}"` in the **same batch** as the
  interaction. This is precisely the mechanism the task asks to reuse for
  "follow up in two weeks."
- **`lib/relationships/meeting-brief.ts` / `meeting-brief-model.ts`**
  already has `openPledgeCents` and `discussionTopics`/`followUpActions`
  entries that reference "the open pledge" as a first-class concept —
  a natural, precedented place to add "open asks."
- **`app/api/assistant/route.ts`** is a fixed-task, rule-based classifier
  (`classifyAssistantPrompt`: keyword regex → one of 6 fixed tasks) that
  always reasons about exactly **one "primary donor"**
  (`brief.priorities[0]?.donorId ?? brief.gifts[0]?.donorId`), reusing
  `loadMeetingBrief()` for that donor's recommendation. **There is no
  donor-name resolution and no free-text search anywhere in the
  Assistant.** It structurally cannot answer "what did I ask Klein for?"
  or "who has an outstanding ask?" without new NLU/search infrastructure
  that does not exist today — see §16.
- **`lib/workspace/live-data.ts` + `lib/workspace/suggestion-
  candidates.ts`** — Today's cross-donor pipeline. Batches evidence per
  donor across a **bounded pool** chosen by `selectSuggestionDonorIds()`
  (gift/pledge/date/contact-gap donor-ID sets are always included in
  full; everything else is capped), ranks with the same engine, and maps
  candidate kind → short label (`suggestionLabelByKind`) for display.
  This is the existing mechanism for "which donors need attention today"
  — no new dashboard section is needed; a new `open_ask` candidate simply
  needs to be wired into this same pool/evidence/label plumbing.
- **`app/api/donors/merge/route.ts`** — one atomic `env.DB.batch()` with
  explicit `UPDATE <table> SET donor_id=? WHERE donor_id=? AND user_id=?`
  reassignment statements for `gifts`, `giving_activities`, `interactions`,
  `recommendations`, `donor_contact_audits`, `jl_payment_assignment_audits`,
  plus research/shared-activity via helper functions, followed by one
  `donor_merge_audits` row. **Audit finding, informational only, not in
  scope to fix here:** `yahrtzeits`, `important_dates`,
  `gift_acknowledgments`, and `donor_historical_context` are currently
  **not** reassigned on merge — a pre-existing gap in the more recently
  added tables. The Ask feature must not repeat this gap (see §19).
- **Backup/reset/baseline infra:**
  - Production baseline + data-health table enumeration
    (`lib/data-health/production-baseline.ts`) is fully **schema-driven**
    — it reads `production-baseline/schema-manifest.json`, which is
    regenerated by `scripts/generate-production-baseline.mjs` (dynamic
    `sqlite_schema`/`PRAGMA` introspection) via
    `pnpm run db:baseline:generate -- --write`. A new table needs the
    baseline **regenerated**, not hand-edited.
  - `wrangler d1 export` (nightly backup, `.github/workflows/d1-backup-
    nightly.yml`) is a full, untargeted database export — automatically
    includes any new table, no changes needed.
  - `lib/operations/staging-reset.ts`'s `STAGING_RESET_TABLE_ORDER` **is**
    a hand-maintained, dependency-ordered list, with its own regression
    test asserting it's exactly `FUNDRAISING_DATA_TABLES` — so a
    forgotten table would fail a test, not silently ship, but it does
    require an explicit addition.
- **Imports:** `lib/import/monday-classify.ts` already classifies
  imported note text into a `"solicitation"` category (distinct from
  `"professional_contact"`/`"planned_action"`/etc.) via
  `classifyMondayText()` — this is the exact mechanism that turned
  "Solicited for a plaque ($5k)" into a confirmable interaction for
  Klein/Pfeiffer/Rovinsky. It is **not** wired to any structured record
  today. A natural (but explicitly not-v1) future hook: offer a "Save as
  Ask?" prompt at confirm-contact time for rows already classified
  `"solicitation"`. Not recommended for v1 — see §22/§25.
- **No existing "commitment"/"pledge-in-progress" concept exists outside
  `giving_activities`.** The `oldCommitmentAction`/commitment-sentence
  language in `lib/capture/interaction.ts` is about detecting an
  actionable next step in free text for the relationship-snapshot
  extractor — unrelated, unstructured, not reusable as a data model.

## 2. Whether any existing model can be reused

**No.** `giving_activities` is exclusively JL-Solutions-imported financial
data; per `docs/FUNDRAISING_OS_PRINCIPLES.md`, "JL Solutions remains the
financial system of record," and using this table for fundraiser-entered,
pre-commitment asks would fabricate financial-system data and corrupt its
own import-category classification. `recommendations` (reminders) is the
right **reuse target for scheduling**, not for representing the ask fact
itself. A new table is justified and narrow.

## 3–4. Recommended schema / exact minimum fields

```
asks
  id                     text PK
  user_id                text NOT NULL  REFERENCES users(id)
  donor_id               text NOT NULL  REFERENCES donors(id)
  amount_cents           integer NULL      -- nullable: "asked for support," no figure
  purpose                text NULL         -- free text, v1 (see §"ASK PURPOSE")
  status                 text NOT NULL     -- pending | committed | declined | withdrawn (see §5)
  asked_at               integer NOT NULL  -- unix timestamp
  note                   text NULL
  source_interaction_id  text NULL  REFERENCES interactions(id)   -- nullable, see §7
  created_at             integer NOT NULL
  updated_at             integer NOT NULL
```

Dropped/renamed from the task's proposed field list:
- `linked_interaction_id` → `source_interaction_id`, nullable (an ask
  need not originate from an interaction — see §7/§13).
- No `campaign_id`/taxonomy FK — no campaign hierarchy exists in this
  schema and none is justified by this feature (see "ASK PURPOSE" below).
- No `probability`/`stage`/`expected_close_date`/`assigned_to` — explicitly
  excluded per the product boundary.
- No separate `committed_amount_cents` — v1 reuses `amount_cents` (edited
  in place if the committed figure differs from the ask, tracked via
  `ask_changes` — see §18). A second amount column starts to look like a
  weighted-pipeline field; avoided deliberately.
- No `follow_up_at`/`next_follow_up_at` — see §9; the existing reminder
  system already covers this need.

`donor_id`/`user_id` naming matches the existing convention for
donor-scoped **activity** tables (`interactions`, `recommendations`,
`yahrtzeits` all use `user_id`, not `owner_user_id` — that's reserved for
`donors` itself).

## 5. Status definitions

Recommend **`pending | committed | declined | withdrawn`** — four
statuses, but "closed" renamed to **"withdrawn"**, because "closed" is, as
the task itself worried, too vague: it doesn't say whether the donor said
no (that's `declined`) or the fundraiser simply stopped pursuing it for
some other reason (donor's situation changed, an entry error, priorities
shifted). Collapsing `withdrawn` into `declined` would misrepresent "the
donor never actually said no" as if they had — a real information loss.

- **`pending`** — an ask was made; no answer yet. Default status on
  creation.
- **`committed`** — the donor agreed to give, whether or not money has
  been received. This is a relationship-layer fact (an app-recorded
  fundraiser claim), independent of and never automatically linked to a
  real JL `giving_activities` pledge row — see §6.
- **`declined`** — the donor said no.
- **`withdrawn`** — the ask is no longer active for a reason other than
  the donor's answer. **Recommend requiring a non-empty `note` at the
  transition to `withdrawn`** (application-level validation, not a DB
  constraint) so this status can never become a silent catch-all — this
  directly answers the task's own "if 'closed' is too vague, say so and
  recommend a better minimal model."

No pipeline stages of any kind.

## 6. Ask vs commitment vs gift semantics

- **ASK** — an `asks` row, `status = 'pending'`. "We requested $X."
- **COMMITMENT** — `asks.status = 'committed'`. "They agreed to give $X,"
  recorded by the fundraiser. **Not** the same thing as a JL
  `giving_activities` row with `category IN ('open_pledge',
  'partially_paid_pledge')` — that requires the back office to actually
  process a real pledge card/commitment in JL, which may happen later, or
  never (administratively falls through). The two can, and often will,
  temporarily disagree — that's expected and fine.
- **GIFT/PAYMENT** — a real `giving_activities`/`gifts` row, always
  JL-imported.

Direct answers to the task's five questions:
1. **If an ask becomes committed, should that create/update an existing
   pledge/commitment record?** No. That would fabricate financial-
   system-of-record data from a fundraiser's own claim — a direct
   violation of "JL Solutions remains the financial system of record."
2. **If a gift arrives that appears to fulfill an ask — anything
   automatic?** No. Task's own instruction: "If gift matching is
   uncertain, do not auto-close from payments." The Open Ask card simply
   sits near the donor's giving history so a fundraiser visually notices
   and manually acts (Mark committed).
3. **Is explicit linking required?** No hard DB link between an Ask and
   a `giving_activities`/`gifts` row in v1 — human judgment only.
4. **Should fulfillment be manual in v1?** Yes, always — the three status
   buttons (Mark committed / Declined / [implicit] Withdraw).
5. **Is "committed" redundant if a real pledge table already exists?** No
   — they answer different questions at different, sequential points:
   "did the donor say yes" (relationship layer, immediate) vs. "has the
   back office recorded a financial commitment" (accounting layer,
   later, sometimes never).

## 7. Ask/interactions relationship

`source_interaction_id` is **nullable**. Preferred path: originates from
an interaction via the capture-form "Did you make an ask?" toggle (see
§12), written atomically with the interaction (and optional reminder) in
one `env.DB.batch()`, mirroring the existing interaction+reminder pattern
exactly.

But an ask does **not** have to originate from an interaction:
- a historical ask imported/backfilled from another system or from a
  reviewed old note (see §20/§21) — `source_interaction_id` can still
  point at the interaction that documents it, or be null for a purely
  manual entry;
- a fundraiser recording an ask directly, with no fresh interaction to
  attach it to (see §13).

## 8. Follow-up interaction linking recommendation

**Recommend Option A/D combined: only the originating interaction is
linked (`source_interaction_id`); no linkage on subsequent interactions
in v1.** Comparison:

| Option | Complexity | Usefulness gained over A |
|---|---|---|
| A. only originating interaction linked | none beyond the one nullable FK already needed | — |
| B. nullable `ask_id` on `interactions` | one nullable column + index on an already heavily-used, heavily-tested table | lets a fundraiser explicitly tag "this call was about that ask" |
| C. join table (`ask_interactions`) | a new table, new write path, new UI to manage it | full many-to-many history, closest to a real timeline |
| D. no explicit later linkage | same as A | — |

Reasoning for A/D: (a) it leaves the `interactions` table and its capture
pipeline completely untouched, zero risk to already-heavily-tested code;
(b) the existing reminder mechanism already gives "there's an open ask +
an open reminder about it" pairing without per-interaction linkage; (c)
an ask's own `status`/`note`/`updated_at` (plus `ask_changes` — §18)
already capture what actually changed and when, without needing to know
*which* of several later interactions was "about" it. Option B is a
legitimate, cheap fallback if the team decides interaction-level
traceability matters more than minimal footprint; Option C is
deliberately deferred — it's the first thing worth building only if a
real reporting need for "every touch on this ask" emerges.

## 9. Reminder behavior

**Reuse the existing reminder system exactly; do not add a second
mechanism, and do not add `follow_up_at`/`next_follow_up_at` to `asks`.**
The interaction-capture form already has a `reminder: none|tomorrow|
next-week|custom` picker → `reminderDueAt()` → an `INSERT INTO
recommendations` row (`id = "activity-${interactionId}"`) in the same
batch as the interaction. When creating or editing an Ask (from capture
or from "+ Add follow-up" on the donor page), offer that **same** picker
component, writing a `recommendations` row with `id =
"ask-${askId}-${n}"` (mirroring the existing ID-prefix convention rather
than adding a new FK column — precedented, not a real foreign key today
either). If an open reminder exists for the donor, `honor_reminder`
already outranks/suppresses the `solicit`-family candidates
(`REMINDER_SUPPRESSES`) — no new suppression logic is needed once
`open_ask` is added to that set (see §10).

This also directly satisfies "do not recommend follow-up immediately
after an ask if it was made yesterday unless the user explicitly set a
follow-up date" — see §10's urgency curve, which needs no new field to
achieve this.

## 10. Suggested Action behavior

Add a new candidate kind **`open_ask`** to `recommendation-candidates.ts`,
modeled closely on `followUpPledgeCandidate` (age-based urgency, not an
instant trigger):

```
certainty: "confirmed"                 // real DB row, not narrative text
specificity: 0.75
recency: 0.3                           // same low baseline as follow_up_pledge
urgency: clamp01(ageDays / 60)         // shorter horizon than pledge's 180 days —
                                        // an ask left hanging is more time-
                                        // sensitive/socially awkward than a
                                        // pledge balance
confidence: ageDays >= 21 ? "medium" : "low"
action: `Follow up on the ${money(amount)} ${purpose ?? ""} ask.`
        (amount/purpose both optional — degrade gracefully, e.g.
        "Follow up on the pending ask." when neither is set)
supportingDate: asked_at
```

`certainty: "confirmed"` (×1 multiplier) naturally outscores the existing
`solicitCandidate` (×0.85/0.55) whenever both could fire for the same
donor — since only one candidate wins per donor (`buildDonorRecommendation`
picks a single top-ranked winner), **no explicit suppression is needed**;
the confirmed Ask simply wins on merit in virtually every real case. Add
`open_ask` to `KIND_PRIORITY`'s tie-break list (near `follow_up_pledge`).
`summarizeRecommendationForSnapshot` needs no special case — the action
text is already a short, bounded sentence (like `follow_up_pledge`'s),
reused as-is through the existing default path.

"Do not recommend follow-up immediately... unless the user explicitly set
a follow-up date": satisfied structurally — `urgency` starts near 0 on
day 0/1 and ramps linearly, and an explicit reminder (§9) takes precedence
via the existing `honor_reminder` mechanism. No `follow_up_at` field
needed — confirmed by audit that the existing scoring shape already
solves this exact problem for `follow_up_pledge`.

## 11. Donor-profile UX

An **"OPEN ASK"** card (one per open — `pending`/`committed`-not-yet-
fulfilled — ask; v1 supports 0–N concurrently, not exactly one — see
§24) near the existing giving/pledge KPIs, but visually distinct from
JL-sourced data (different card style/label) to avoid implying it's
confirmed financial-system data. Shows amount (or "amount not
specified"), purpose, "Asked {date}", status, and three actions: **Add
follow-up** (opens the existing reminder picker), **Mark committed**,
**Declined** (a "Withdraw" action, requiring a note, covers the fourth
status without needing a fourth prominent button — could be a small
overflow/secondary action). `committed`/`declined`/`withdrawn` asks
collapse into a small "Past asks" expandable list further down the page
— never a giant management panel, matching
`FUNDRAISING_OS_PRINCIPLES.md`'s "empty states should collapse."

## 12. Interaction-capture UX

Progressive disclosure, matching the existing `<fieldset
className="reminder-picker">` visual convention already in
`CaptureExperience.tsx`:

```
Did you make an ask?  [ No ]  [ Yes ]

  (if Yes)
  Amount        [________]  (optional)
  Purpose       [________]  (optional, free text)
  Note          [________]  (optional)
  Reminder      [same existing picker: none / tomorrow / next week / custom]
```

One atomic submit: interaction + ask (+ optional reminder) all written in
the same `env.DB.batch()`, exactly like the existing
interaction+reminder write in `app/api/interactions/route.ts`.

## 13. Whether direct Ask creation belongs in v1

**Yes, but minimal** — a small "+ Log ask" affordance on the donor page:
donor is already known from context, so the form is just amount
(optional) / purpose (optional) / asked_at (defaults to now, editable) /
note (optional). No interaction fields. Needed for: (a) the exact
Klein/Pfeiffer/Rovinsky backfill cases (§20/§21) and any other historical
ask discovered later, and (b) a fundraiser who wants to log an ask
without a fresh interaction (forgot to log it at the time, or the ask
happened over a channel that wasn't otherwise captured as an
interaction). Keep it a single small inline form/modal, not a new page.

## 14. Mobile UX

The toggle + 2 optional fields fits the same single-column, large-
touch-target style the reminder picker already establishes; no new
guidance needed. Explicitly resist scope creep — if "Did you make an
ask?" ever grows past amount/purpose/note, it stops being a quick capture
add-on.

## 15. Meeting Brief behavior

Add `openAsks: MeetingBriefAsk[]` to `meeting-brief-model.ts`'s
`MeetingBrief` type, populated in `loadMeetingBrief()`
(`lib/relationships/meeting-brief.ts`) from a new `asks` query run
alongside the existing `giving`/`reminders` queries (same
`Promise.all([...])`). Rendered as its own short line, e.g.: **"Open ask:
$10,000 dinner sponsorship, pending since Aug 1."** The same evidence
object already threads `openAsk` into `buildRecommendationEvidence()` so
Suggested Action reflects it automatically (§10).

## 16. Assistant behavior

Bounded hard by the audited architecture (§1): the Assistant only ever
reasons about **one primary donor**, via `loadMeetingBrief()`, with no
donor-name parsing and no cross-donor search anywhere in
`lib/ai/rule-based.ts` / `app/api/assistant/route.ts`. So:

- If the **primary donor** has an open ask, it already surfaces for free
  once `s.donor.recommendation` reflects the new `open_ask` candidate
  (§10/§15). Recommend one small addition: a `s.donor.openAsk` line in
  the `meeting-brief`/`relationship-summary` task templates in
  `lib/ai/rule-based.ts` (mirroring the existing `familyContextBlock`
  pattern), so the Assistant states it explicitly, not just implicitly
  via the recommendation's action text.
- **"What did I ask Klein for?" (named-donor query) and "Who has an
  outstanding ask?" (cross-donor query) are NOT achievable in v1**
  without building real donor-name-resolution/search infrastructure,
  which does not exist today for *any* fact type, not just asks. Per the
  task's own instruction ("do not build broad reporting/search
  infrastructure unless current Assistant context can consume this
  cheaply"), and since it cannot be consumed cheaply, this is explicitly
  out of scope for v1 (§25).

## 17. Today/recommendation implications

Wire an `askDonorIds`/`openAskByDonor` map into
`lib/workspace/live-data.ts`, mirroring the existing `openPledgeByDonor`
pattern exactly (build the map, thread it into
`buildRecommendationEvidence()`'s per-donor loop). Add `askDonorIds` to
`lib/workspace/suggestion-candidates.ts`'s `selectSuggestionDonorIds()`
input, **always-included/unbounded** like `giftDonorIds`/`pledgeDonorIds`
(an open ask is exactly as "always worth surfacing" a signal as an open
pledge). Add `open_ask: "Open ask"` to `suggestionLabelByKind`. This
makes stale pending asks surface through the **existing** Suggested
Action/Today pipeline — **no new dashboard section**, per the task's
explicit constraint. Reminders remain the correct explicit-scheduling
mechanism (§9); Suggested Action's urgency ramp is the passive/ambient
signal for asks with no explicit follow-up date set.

## 18. Audit/history recommendation

**Yes — add a small `ask_changes` table from day one**, directly modeled
on the existing `donor_contact_audits` (the closest, smallest precedent
in this schema):

```
ask_changes
  id             text PK
  user_id        text NOT NULL REFERENCES users(id)
  donor_id       text NOT NULL REFERENCES donors(id)
  ask_id         text NOT NULL REFERENCES asks(id)   -- a real FK is safe here:
                                                       -- asks are never hard-
                                                       -- deleted in v1, unlike
                                                       -- yahrtzeits, so
                                                       -- yahrtzeit_changes'
                                                       -- non-FK precedent
                                                       -- doesn't apply
  action         text NOT NULL   -- created | updated | status_changed
  changed_fields text NOT NULL   -- json array
  before_json    text            -- json, nullable (null on "created")
  after_json     text NOT NULL   -- json
  created_at     integer NOT NULL
```

Justification: (a) status transitions and amount corrections are exactly
the class of donor-facing, money-adjacent change this codebase already
treats as audit-worthy everywhere else (contact fields, giving-activity
management, yahrtzeits, payment assignments — four existing precedents);
(b) it's cheap — one small append-only table, same shape as those four;
(c) it directly satisfies the requirement that a `withdrawn` transition
carry a reason (§5) by giving that note a permanent home. **Not** a large
event-sourcing system — the same lightweight pattern already proven four
times over.

## 19. Donor-merge behavior

Add to the existing atomic batch in `app/api/donors/merge/route.ts`:
```
UPDATE asks SET donor_id=? WHERE donor_id=? AND user_id=?
UPDATE ask_changes SET donor_id=? WHERE donor_id=? AND user_id=?
```
in the same transaction as every other reassignment, and include `asks`
in `linkedCounts()`/`movedCounts` reporting (same treatment as
`interactions`/`recommendations`).

**Duplicate/open-ask collision:** no automatic deduplication. If both
merging donors each have their own open ask(s), the survivor simply ends
up with multiple open Asks after merge — v1 does not enforce "one open
ask per donor" (§24), and a fundraiser reviews/resolves each manually,
consistent with "never silently merge donor data."

Transparency note (informational, **not** in scope to fix as part of
this feature): `yahrtzeits`, `important_dates`, `gift_acknowledgments`,
and `donor_historical_context` are **not currently reassigned** by donor
merge — a pre-existing gap discovered during this audit. The Ask feature
must not repeat it; whether to also fix the pre-existing gap is a
separate decision for the team.

## 20. Migration/backfill strategy

**No automatic bulk conversion of historical interaction notes into
Asks** — too risky, matches the task's own instruction. Recommended path,
**not implemented in this task**:
1. After the feature ships (§26 phase 8), manually create exactly the 3
   known-reviewed Ask records (Klein/Pfeiffer/Rovinsky — §21) via "+ Log
   ask," linking `source_interaction_id` to each donor's existing
   Monday-imported interaction, `asked_at` = that interaction's date.
   Source interaction rows stay completely untouched.
2. Once each Ask exists, that donor's `relationship_summary` (still
   flagged `NEEDS_REVIEW` from the prior cleanup-audit task, unresolved)
   can then safely be cleared — the fact it held ("we asked for $Xk,
   still pending") now lives structurally in the Ask, so clearing the
   free-text field no longer discards it. This directly closes the loop
   left open in `docs/AI-HANDOFF.md`'s prior "Next Approval Required" item
   for these 3 donors.
3. Any other historical solicitation notes discovered later follow the
   same manual, reviewed, one-at-a-time path — never a bulk script.

## 21. How Klein/Pfeiffer/Rovinsky would be represented

Source notes and dates were independently re-confirmed against staging
during this audit (read-only). **Not modified.**

| Donor | donor_id | amount_cents | purpose | asked_at | status | source_interaction_id |
|---|---|---|---|---|---|---|
| Mayer Simcha Klein | `b5e8cc18-49f5-42c9-8511-26371ca3cef6` | 500000 | "Plaque" | 2025-11-06 | pending | `monday-interaction-5a79919d` |
| Allen Pfeiffer | `d1b9cf78-2cdb-4546-9527-6210b95d16d4` | 1000000 | null (note specifies no purpose) | 2025-09-15 | pending | `monday-interaction-7161c502` |
| Rabbi Michoel A. Rovinsky | `952a1cc7-c05a-42ed-a472-463fdb1d633b` | 500000 | "Plaque in memory of his wife" | 2025-09-29 | pending | `monday-interaction-6d655cb9` |

(Source notes, for traceability: Klein — "Solicited for a plaque ($5k)";
Pfeiffer — "Solicited for $10k"; Rovinsky — "Solicited for a plaque in
memory of his wife ($5k)".)

## 22. Files likely to change (implementation phase — not done now)

- `db/schema.ts` — new `asks`, `ask_changes` tables
- `drizzle/0032_asks.sql` (or next free number) — new migration
- `lib/relationships/recommendation-evidence.ts` — `openAsk`(s) evidence field
- `lib/relationships/recommendation-candidates.ts` — `open_ask` candidate
- `lib/relationships/recommendation-rank.ts` — `KIND_PRIORITY` entry
- `lib/relationships/meeting-brief.ts` + `meeting-brief-model.ts` — query + field
- `lib/workspace/live-data.ts` — `askDonorIds`/`openAskByDonor` wiring
- `lib/workspace/suggestion-candidates.ts` — `askDonorIds` param
- `lib/ai/types.ts` + `lib/ai/rule-based.ts` — assistant snapshot line
- `app/api/assistant/route.ts` — pass ask data into the snapshot
- `app/capture/CaptureExperience.tsx` — ask toggle UI
- `app/api/interactions/route.ts` — accept + write ask fields in the same batch
- new `app/api/asks/route.ts` (direct create) + `app/api/asks/[id]/route.ts` (status/edits)
- `app/donors/[id]/page.tsx` — Open Ask card + query
- `app/api/donors/merge/route.ts` — `donor_id` reassignment (§19)
- `lib/operations/staging-reset.ts` — `STAGING_RESET_TABLE_ORDER` entries
- `production-baseline/schema-manifest.json` — regenerated via `pnpm run
  db:baseline:generate -- --write` (not hand-edited)

## 23. Tests required

- Migration/schema rehearsal (mirroring the existing migration-0031-style
  real-SQLite rehearsal test)
- `open_ask` candidate: generation, urgency ramp, and that it outranks
  `solicitCandidate` on merit (certainty multiplier)
- `recommendation-rank`: `KIND_PRIORITY` placement; no regression to
  existing candidate ordering
- Meeting Brief: `openAsks` populated correctly; recommendation reflects it
- Donor page: Open Ask card renders; status actions work
- Interaction capture: atomic interaction+ask(+reminder) write; **no**
  ask row created when "No" is selected
- Direct-ask-creation route: amount optional, purpose free text, status
  transitions, required note on `withdrawn`
- `ask_changes` rows written correctly for create/update/status-change
- Donor merge: `asks`/`ask_changes` reassigned correctly; no special
  collision handling needed (multiple open asks coexist)
- Staging-reset: new tables included (the existing self-check test should
  already force this if forgotten)
- `suggestion-candidates`/Today: `askDonorIds` included, unbounded, in
  the selection pool
- Existing `relationship-quality`/`recommendation-engine`/`meeting-
  brief`-adjacent tests remain green (no regression)

## 24. Risks

- **Terminology collision**: "pledge"/"committed" already mean something
  specific (JL-imported financial data) in this codebase. UI copy and
  code comments must be careful never to let `Ask.status = 'committed'`
  read as a real JL pledge.
- **Visual crowding**: an "Open Ask" card next to the existing "Open
  Pledge" giving stat could look like two competing pipelines if not
  laid out carefully at implementation time.
- **Cardinality assumption**: the task's own mockup shows one "OPEN ASK"
  card, singular — v1 must explicitly support 0–N concurrent open asks
  per donor rather than silently assuming exactly one, or the design
  breaks the first time a donor has two live asks.
- **`solicitCandidate` becomes partly redundant** once real Asks exist
  for a donor. Safe to leave (ranking naturally deprioritizes it), but
  worth a code comment so a future reader isn't confused about why it's
  still there.
- **Donor-merge gap**: the pre-existing yahrtzeits/important_dates/etc.
  non-reassignment bug (§19) must not be copied by assuming "it'll just
  work like everything else" — needs its own explicit test.
- **Mobile form scope creep**: resist growing "Did you make an ask?"
  past amount/purpose/note.

## 25. CRM/pipeline features intentionally NOT being built

- Sales stages / pipeline stages of any kind
- Probability / weighted pipeline
- Expected close date / forecasting
- Assigned-fundraiser / team-assignment workflows
- Campaign hierarchy or purpose taxonomy (purpose stays free text)
- Opportunity dashboards / pipeline management / kanban views
- Automatic gift-to-ask matching or auto-close from payments
- Automatic ask creation from dollar signs or free-text extraction
- A second reminder mechanism (the existing `recommendations` system is reused)
- Donor-name resolution / free-text search in the Assistant
- Broad cross-donor reporting infrastructure
- A large event-sourcing audit system (a small `ask_changes` table only)
- `ask_id` linkage on every subsequent interaction (join table) — deferred past v1
- Automatic bulk backfill of historical notes into Asks
- Automatic Monday-import "solicitation"-category → Ask creation (a
  future, explicitly-opt-in "Save as Ask?" prompt is a plausible v2, not v1)

## 26. Recommended phased implementation order

0. **(this task)** Design only — done, awaiting approval.
1. Schema + migration (`asks`, `ask_changes`) + staging-reset wiring +
   baseline regeneration. No UI. Verified via a migration-rehearsal test
   only.
2. `recommendation-evidence`/`recommendation-candidates`/
   `recommendation-rank` wiring (`open_ask` candidate) + tests — Suggested
   Action can reason about asks via synthetic fixtures before any UI
   exists to create them (same pattern `follow_up_pledge` already proves).
3. Interaction-capture UX ("Did you make an ask?") + direct "+ Log ask"
   creation route/UI — the only way real data starts flowing in.
4. Donor-profile Open Ask card + status actions (`committed`/`declined`/
   `withdrawn`) + `ask_changes` audit writes.
5. Meeting Brief + Assistant line wiring.
6. Today/`suggestion-candidates` wiring (cross-donor surfacing, still no
   new dashboard section).
7. Donor-merge reassignment wiring + test.
8. **(separate, explicitly approved, not automatic)** Manual backfill of
   the 3 known-reviewed cases (Klein/Pfeiffer/Rovinsky) + clearing their
   `relationship_summary` once each Ask exists.

Each phase ships and tests independently; the riskiest/most-visible UI
work (capture flow) deliberately comes after the data model and
recommendation logic are already proven.

---

## Unresolved decisions requiring explicit approval

1. Status model: `pending | committed | declined | withdrawn` (renamed
   from "closed") — confirm acceptable, including the requirement that
   `withdrawn` carry a note.
2. Purpose: free text, no enum/taxonomy — confirms the task's own lean.
3. Multiple concurrent open asks per donor: allowed, no artificial
   one-at-a-time constraint — confirm.
4. Direct "+ Log ask" creation: recommended for v1 (historical backfill +
   no-interaction cases) — confirm needed.
5. Follow-up interaction linking: Option A/D (originating interaction
   only) recommended — confirm, or prefer Option B (nullable `ask_id` on
   `interactions`, opt-in) instead.
6. `ask_changes` audit table: recommended — confirm justified.
7. Backfill of Klein/Pfeiffer/Rovinsky: recommended as a **separate**,
   later, explicitly-approved step after the feature ships — not part of
   the implementation itself.
8. Whether to also clear `relationship_summary` for those 3 once their
   Ask exists — callback to the still-open item from the prior
   cleanup-audit task.
