# Pledge Payment Plan — Design (not implemented)

Status: **DESIGN ONLY.** No schema, migration, or application code has been
written. No D1 was touched (read-only queries only, for the audit and the
KOLX2026 worked example). This document is the full audit and design
report; `docs/AI-HANDOFF.md` carries a summary and points here.

Product boundary (restated, governs every recommendation below): JL /
`giving_activities` remains the financial system of record. This feature
represents **only the fundraiser's own stewardship expectation** — "this
pledge is being paid on an agreed schedule" — never a rewrite of pledge
status, never fabricated payments, never a CRM/accounting/collections
system. It is a **recommendation suppression/deferment** feature, not a
financial one.

---

## 1. Existing architecture relevant to payment plans

Audited by reading the actual code and querying real staging data
read-only (never written to), not assumed.

- **`giving_activities`** (an open pledge's own row): `activity_date` is
  the ORIGINAL commitment date and is never touched again.
  `paid_cents`/`balance_cents`/`category` are updated **in place on the
  same row** when a payment is applied (confirmed in
  `lib/import/jl-payment-assignment.ts`'s `planPaymentAssignments`: a
  payment linked via `decision_type = 'apply_to_pledge'` never creates a
  second `giving_activities` row for itself — it only updates the
  existing pledge row's `paid_cents`/`balance_cents`). The upsert that
  writes this table
  (`app/api/import/route.ts`) is keyed on
  `ON CONFLICT(owner_user_id, external_source, source_fingerprint) DO
  UPDATE SET paid_cents=..., balance_cents=..., category=...,
  source_snapshot=..., updated_at=...` — critically, **`id` is never
  reassigned on conflict**, only the payment-derived columns are. This is
  the load-bearing fact for §5 below.
- **`source_fingerprint`** (`lib/import/jl-donations.ts`'s
  `canonicalFingerprint`) is a hash of `[Code, Due Date/Date, Item Num,
  Desc, Campaign, Amount, Company]` — i.e. the pledge's **original
  commitment fields**, not anything payment-related. It changes only if
  those original fields themselves are corrected in a later JL export,
  not when a payment is applied against the pledge.
- **`jl_payment_assignment_audits`** is a real, already-existing payment
  ledger: one row per applied payment, with `pledge_activity_id` (FK to
  the pledge's `giving_activities.id`), `payment_date`, `applied_cents`,
  `remaining_balance_cents`, `decision_type` (`'apply_to_pledge'` vs.
  `'new_gift'`). This is exactly the "actual" side of the
  expected-vs-actual comparison this feature needs, and it already has
  enough history to evaluate whether a plan is on track (§8) — no new
  payment-matching logic is needed; this feature only ever **reads** it.
- **`RecommendationEvidence.giving.openPledge`**
  (`lib/relationships/recommendation-evidence.ts`) currently carries
  `{ balanceCents, campaign, description, activityDate, ageDays }`.
  `activityDate` was, as of the just-shipped fix, corrected to resolve
  via `resolveOpenPledgeActivityDate(pledgeOwnActivityDate,
  linkedPaymentDates)` — the MAX of any linked
  `jl_payment_assignment_audits.payment_date` rows for that exact pledge,
  falling back to the pledge's own `activity_date` if none exist. This
  fix is already wired into all three loaders that build `openPledge`
  (Today/`live-data.ts`, donor page, `meeting-brief.ts`, which Assistant
  reuses via `loadMeetingBrief()`).
- **`followUpPledgeCandidate`** (`lib/relationships/recommendation-
  candidates.ts`) is pure: `ageDays = pledge.ageDays ?? 0`; `confidence`
  is `medium` at `ageDays >= 60` else `low`; `urgency =
  clamp01(ageDays / 180)`; wording is `"Follow up on the open ${balance}
  pledge..."` / `"No payment activity in ${ageDays} days..."`. There is
  **no suppression mechanism of any kind today** — a stale open pledge
  always produces this candidate once `ageDays` crosses a threshold.
- **Today (`live-data.ts`), donor page, Meeting Brief** each
  independently build `openPledgeForEvidence` from their own D1 query of
  `giving_activities`, then call `buildRecommendationEvidence`. **Assistant**
  never queries pledges itself — it reuses `loadMeetingBrief()` for the
  workspace's primary donor (`app/api/assistant/route.ts`), so fixing
  Meeting Brief's evidence automatically fixes Assistant's.
- **Reminders/`recommendations`** — the existing due-date reminder
  system, `id` prefix convention (`ask-<id>-<uuid>`,
  `activity-<interactionId>`). Established precedent (Ask historical
  backfill, this session's own prior task): **background facts like a
  payment plan must never auto-create a reminder/recommendation row** —
  only an explicit fundraiser action does that, and even then only via
  the existing reminder picker, never a new mechanism.
- **Donor merge** (`app/api/donors/merge/route.ts`) already reassigns
  `giving_activities.donor_id` and, separately,
  `jl_payment_assignment_audits.donor_id` (`UPDATE ... SET donor_id=?
  WHERE donor_id=? AND owner_user_id=?` / `AND user_id=?`) in one atomic
  batch. Neither statement touches the row's own `id` — merge reassigns
  ownership, never identity.
- **Import behavior** — confirmed above: `giving_activities.id` for a
  pledge is stable across ordinary reimports (payment application,
  balance/paid updates) because the upsert is keyed on
  `source_fingerprint`, which doesn't change for those operations.
- **Staging reset** (`lib/operations/staging-reset.ts`) is a
  hand-maintained, dependency-ordered `STAGING_RESET_TABLE_ORDER` list
  with its own self-check test (`ask_changes` before `asks`, children
  before parents; `jl_payment_assignment_audits`/`jl_payment_assignments`
  already present).
- **Backup/export classification**
  (`lib/operations/workspace-backup.ts`) enforces, via
  `tests/production-backup-readiness.test.mjs`, that every fundraising
  table appears in exactly one of two lists: `WORKSPACE_BACKUP_TABLES`
  (included, needs correct owner-scoping) or
  `WORKSPACE_BACKUP_EXCLUDED_TABLES` (covered only by the nightly
  whole-database R2 export). `asks`/`ask_changes` were added to the
  **excluded** list when built — "real donor-facing data... deliberately
  not added to the included list in this phase, that would require its
  own correct owner-scoping work, a separate decision from building the
  feature itself." Same reasoning applies here.
- **Audit/change-table convention** — established 4+ times now
  (`donor_contact_audits`, `yahrtzeit_changes`, `important_date_changes`,
  `ask_changes`): a small `<entity>_changes` table, `action` enum,
  `changed_fields` json array, `before_json`/`after_json`, `created_at`.
  Never event-sourcing — one row per meaningful mutation.
- **Ask / `ask_changes`** is the closest, most direct precedent for this
  entire feature: a small, narrow, fundraiser-declared local annotation
  layered on top of JL financial data, with its own tiny audit table,
  wired into the shared evidence/candidate architecture across the same
  three loaders, with an explicit non-goal of becoming a CRM. This
  design mirrors it deliberately at every decision point below.

## 2. Whether an existing model can be reused

**No.** Nothing today represents a forward-looking, fundraiser-declared
payment *expectation*. `giving_activities` is exclusively JL-imported
actual-transaction data (past fact, never an expectation).
`jl_payment_assignment_audits` is real payment *history*, not a plan —
reusing or overloading either would fabricate or misrepresent JL data,
directly violating the stated product boundary. A new, small, local table
is justified and narrow, exactly matching why `asks` was justified over
reusing `giving_activities` in the prior feature.

## 3. Recommended conceptual model

A **payment plan** is local, fundraiser-entered metadata attached to
exactly one open pledge (`giving_activities` row), stating what the
fundraiser expects: an approximate next-payment date, a hard final date,
optionally an installment amount. At evidence-build time, the
recommendation engine compares this EXPECTED fact against the ACTUAL
linked-payment history already available in
`jl_payment_assignment_audits`, purely as a derived read — nothing about
"on track" or "late" is ever stored. `follow_up_pledge` is suppressed
while the plan is on track, and re-appears (with plan-aware wording) once
a payment is meaningfully overdue or the plan's final date passes with
balance remaining.

## 4. Exact minimum fields

Every field from the task's own sketch, challenged:

| Field | Keep? | Reasoning |
|---|---|---|
| `id` | Yes | PK, matches every other local table. |
| `user_id` | Yes | Owner-scoping, matches every other local table. |
| `donor_id` | Yes, denormalized | Matches `jl_payment_assignment_audits`'s own denormalized `donor_id` — needed for merge reassignment and donor-scoped queries without a join. |
| `pledge_activity_id` | Yes, **required, non-nullable** | The stable link — see §5. Named to match `jl_payment_assignment_audits.pledge_activity_id`'s existing convention exactly, not a new name. |
| `cadence` | Yes, but trivial | See §6 — kept as a single-value, CHECK-constrained column (`'monthly'` only) purely for display/self-documentation. **Plays no role in suppression logic at all** — only `next_expected_payment_at`/`final_expected_payment_at` do. |
| `installment_amount_cents` | Yes, nullable, **display-only** | Never validated against actual payments (§20 risk #4) — storing it is cheap and useful for the UI/glance value, but the suppression logic never reads it. |
| `next_expected_payment_at` | Yes, **required** | The plan's original anchor date. See §8 for how it's used (never overwritten by a background process; only by an explicit edit). |
| `final_expected_payment_at` | Yes, **required, not nullable** | Deliberately required, not optional — this is the sole backstop against indefinite silent suppression (risk #11, "user forgets to end plan"). Without it, an on-track plan could suppress follow-up forever. |
| `note` | Yes, nullable | Matches `asks.note` exactly. |
| `status` (enum) | **No — replaced by `ended_at`** | Challenged directly, per the task's own instruction. There are truly only two states here (active/ended), not the 3+ states that justify an enum elsewhere in this schema (`recommendations.status`, `data_imports.status`). A nullable `ended_at` timestamp (`NULL` = active, non-null = ended) is smaller, gives "when did it end" for free, and avoids the task's own flagged risk of a status column duplicating what a timestamp already implies. |
| `created_at`/`updated_at` | Yes | Matches the `...timestamps` spread convention used everywhere else in this schema (see `asks`). |

**Recommended schema:**
```
pledge_payment_plans
  id                          text PRIMARY KEY
  user_id                     text NOT NULL REFERENCES users(id)
  donor_id                    text NOT NULL REFERENCES donors(id)
  pledge_activity_id          text NOT NULL REFERENCES giving_activities(id)
  cadence                     text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly'))
  installment_amount_cents    integer                    -- nullable, display-only
  next_expected_payment_at    integer NOT NULL           -- date-only epoch
  final_expected_payment_at   integer NOT NULL           -- date-only epoch, required backstop
  note                        text                       -- nullable
  ended_at                    integer                    -- nullable; NULL = active
  created_at                  integer NOT NULL
  updated_at                  integer NOT NULL
```
One evidence-based index: `(pledge_activity_id)` — covers "does this
pledge have a plan" lookups, mirroring `ask_changes_ask_idx`'s single-
index-per-real-need discipline. **No** `UNIQUE` constraint on
`pledge_activity_id` — a donor could end one plan and start a new one on
the same pledge later (renegotiated terms), and history should be
preserved as two rows, not one overwritten row. "At most one *active*
plan per pledge" is an application-level invariant (enforced when
creating a plan: refuse if an active one already exists for that
`pledge_activity_id`), not a DB constraint — same treatment as Asks'
"multiple pending asks allowed, no artificial one-at-a-time constraint."

**Audit table**, directly modeled on `ask_changes`:
```
pledge_payment_plan_changes
  id              text PRIMARY KEY
  plan_id         text NOT NULL REFERENCES pledge_payment_plans(id)
  user_id         text NOT NULL REFERENCES users(id)
  donor_id        text NOT NULL REFERENCES donors(id)
  action          text NOT NULL CHECK (action IN ('created','updated','ended'))
  changed_fields  text NOT NULL                -- json array
  before_json     text                          -- json, null on 'created'
  after_json      text NOT NULL                 -- json
  created_at      integer NOT NULL
```
Index: `(plan_id, created_at)`, mirroring `ask_changes_ask_idx` exactly.

## 5. Stable pledge-linking strategy

**`pledge_activity_id` = `giving_activities.id`.** This is the single
most important design decision, so the reasoning is stated in full:

Payments are applied **in place** to the existing pledge row (§1) — the
import upsert never replaces the row or reassigns its `id` when a payment
changes `paid_cents`/`balance_cents`. So `id` survives every *normal*
reimport cycle. The one case it would **not** survive: if the pledge's
own original commitment fields (the ones `canonicalFingerprint` hashes —
Code, Due Date, Item Num, Desc, Campaign, Amount, Company) are themselves
corrected in a later JL export. That produces a new `source_fingerprint`,
which the `ON CONFLICT` upsert can't match, so a **new** row with a
**new** `id` is inserted — orphaning any plan still pointing at the old
`id`.

This is rare (correcting the pledge's own terms, not applying a payment)
but real, and not solved here — see §14/§20 risk #8. Recommendation: link
to `id` anyway (it's the schema's actual FK target already used by
`jl_payment_assignment_audits.pledge_activity_id`, so this stays
consistent with the established convention), and defensively detect
orphaning passively (if the linked `giving_activities` row can no longer
be found, or no longer belongs to the plan's `donor_id`, or its balance
is now `<= 0` for a reason the plan didn't predict, surface a quiet "this
plan's pledge could not be confirmed — review" state) rather than
building reconciliation heuristics to guess the replacement row.

`source_fingerprint` itself was considered and rejected as the link — it
is not more stable than `id` (both break under the exact same rare
condition), and using it instead of the schema's real primary key would
be an inconsistent, worse choice for no benefit.

## 6. Cadence model

**Recommend A: monthly-only v1.** Comparing the three options as asked:

- **A. monthly-only** — matches the stated real use case exactly; the
  suppression logic (§8) never needs to *compute* occurrences from a
  cadence rule at all (dates are stored directly, not derived), so
  "cadence" ends up being a pure label with zero logic depending on it.
- **B. enum (monthly/quarterly/custom)** — no evidence today that any
  other cadence is needed; adding the enum values now would be dead code
  the suppression logic never reads until a real v2 need appears.
- **C. arbitrary recurrence rule** — explicitly the kind of "general
  recurrence engine" the task warns against; nothing in the suppression
  logic needs it, since `next_expected_payment_at`/
  `final_expected_payment_at` are stored dates, never re-derived from a
  rule string.

If a genuine quarterly/custom need appears later, widening the `cadence`
CHECK constraint is a small additive migration (the exact precedent
migration `0031` already set for widening `shared_activities.type`'s
CHECK when Text Message was added) — not a redesign.

## 7. Grace-period recommendation

Comparing the four options as asked:

1. **Zero grace** — rejected. Any real-world 1-3 day processing/weekend
   delay (risk #2) would immediately flip a genuinely-on-track plan to
   "late," defeating the feature's entire purpose.
2. **Fixed small grace (e.g. 7 days)** — recommended. Matches this
   codebase's own established taste for small fixed constants over
   configurability (`RELATIONSHIP_DATE_LEAD_WINDOW_DAYS`, the 60-day/
   180-day pledge-urgency thresholds are all fixed, not user-tunable).
3. **User-configurable** — rejected for v1. Adds a UI control and a
   per-plan decision burden with no evidence yet that a fixed default is
   wrong for real usage.
4. **Infer from historical payment behavior** — rejected as overbuilt.
   Requires analyzing variance across `jl_payment_assignment_audits` per
   plan for marginal benefit over a fixed default — exactly the kind of
   complexity the task is warning against building casually.

**Recommend a fixed 7-day grace period**, a constant in code (not stored
on the plan record), so it can be tuned in one place later without a
migration if real usage proves it wrong.

## 8. Expected-vs-actual logic

All fields below are **derived at evidence-build time, never stored**
(per the task's own explicit preference, and matching how `ageDays` is
already derived from `activityDate` today — not a new pattern).

```
GRACE_DAYS = 7            // constant, not stored
APPROX_MONTHLY_DAYS = 30  // constant, not stored -- see the month-end
                           // problem below for why this is a day-count
                           // approximation, not calendar-month arithmetic

Given: plan.nextExpectedPaymentAt, plan.finalExpectedPaymentAt,
       plan.endedAt, latestActualPaymentAt (MAX(jl_payment_assignment_
       audits.payment_date) for THIS pledge_activity_id -- the exact
       same query the Bug 2 fix already added, reused directly),
       balanceCents, now

isActive       = plan.endedAt === null
isFullyPaid    = balanceCents <= 0
isPastFinal    = now > plan.finalExpectedPaymentAt

// The "current" expected date re-anchors to the most recent REAL
// payment once one exists, rather than chaining projections off the
// original anchor -- this is what avoids compounding drift (see the
// month-end problem below). It is never less than the plan's own
// original anchor.
effectiveExpectedAt = latestActualPaymentAt !== null
  ? max(plan.nextExpectedPaymentAt, latestActualPaymentAt + APPROX_MONTHLY_DAYS)
  : plan.nextExpectedPaymentAt

daysLate = (isActive && !isFullyPaid && !isPastFinal)
  ? max(0, daysBetween(now, effectiveExpectedAt) - GRACE_DAYS)
  : 0
isLate               = daysLate > 0
isOnTrack            = isActive && !isFullyPaid && !isPastFinal && !isLate
isPlanEndedWithBalance = isActive && isPastFinal && !isFullyPaid
isCompleted          = isFullyPaid   // regardless of endedAt
```

**The month-end problem, resolved by avoiding it entirely.** The task
asks to compare (a) storing `next_expected_payment_date` and advancing it
by one calendar month after each detected payment, using existing date
helpers, vs. (b) day-of-month + final date. Neither is used here.
Calendar-month arithmetic (`setUTCMonth`-style) has the well-known Jan-31
+1-month-=-Mar-3 overflow bug, and no month-arithmetic helper exists
anywhere in this codebase today (`lib/workspace/local-time.ts` only has
day-granularity `addCalendarDays`) — building one would be new machinery
for a problem this design doesn't need to solve. Instead,
`effectiveExpectedAt` is a **derived day-count approximation**
(`latestActualPaymentAt + ~30 days`), recomputed fresh every time
directly from the real most-recent payment — never a chained/iterated
projection, so there is nothing to drift. This is a suppression
heuristic, not a real calendar system: an edge-of-month plan will
gradually drift a day or two against true calendar months over a year,
which is irrelevant for "is a payment meaningfully overdue" and explicitly
out of scope for anything more precise (this is not an accounting or
amortization system).

`next_expected_payment_at` in the stored record therefore means "the
plan's originally-declared next-due date, used as the floor/anchor before
any payment has landed, and never silently rewritten by a background
process" — only an explicit `[Edit plan]` action changes it.

## 9. Recommendation suppression/reactivation rules

**No new candidate kind, no second recommendation engine.**
`followUpPledgeCandidate` gains one early branch and plan-aware wording;
`confidence`/`urgency`/`specificity`/`recency` are **left exactly as they
are today** (still purely `ageDays`-based) for the late/ended-with-balance
cases — only the `action`/`why`/`evidence` strings change, since
`ageDays` (days since the resolved last activity) is already large in
those cases without any change:

```
if (!pledge) return null;                                  // unchanged
const plan = pledge.activePaymentPlan;
if (plan?.isOnTrack) return null;                           // suppressed
if (plan?.isLate) {
  action: `Check in on the ${money(balance)} pledge payment plan.`
  why: `Expected monthly payment appears overdue (last payment ${dateLabel(latestActualPaymentAt)}).`
  // confidence/urgency/specificity/recency: unchanged formulas
}
if (plan?.isPlanEndedWithBalance) {
  action: `Follow up -- the payment plan for the open ${money(balance)} pledge was expected to be complete by ${dateLabel(finalExpectedPaymentAt)}.`
  // confidence/urgency/specificity/recency: unchanged formulas
}
// no plan at all: existing unmodified behavior
```

**Reactivation is implicit and automatic** — nothing is ever persisted as
"currently suppressed." Every evidence build re-evaluates `isOnTrack`/
`isLate` fresh from real dates and real payment data, so a plan can never
go stale in either direction (a late plan that catches up next month
naturally re-suppresses itself the moment the new payment is detected —
no explicit "reactivate" action exists or is needed).

## 10. Donor-profile UX

There is currently **no dedicated "Open Pledge" card** on the donor page
(unlike Asks' `OpenAskCard`) — pledges surface via the KPI tile
("Open Commitments: $X") and the unified timeline. This feature
introduces one small new card, `OpenPledgePlanCard`, attached **per open
pledge** (never donor-wide — see §15), mirroring `OpenAskCard`'s exact
progressive-disclosure pattern:

No plan yet:
```
[Set payment plan]
```
Active plan:
```
Payment plan
Paid monthly
Next expected: Sep 18       (or "Expected payment overdue" styling if late)
Final expected: May 18, 2027
[Edit plan]  [End plan]
```
Positioned near the giving KPI tiles, visually distinct from JL-sourced
data (same "never implies confirmed financial-system data" treatment the
Ask card already established), with copy explicitly framing it as the
fundraiser's own expectation (see §terminology below) — never as if JL
itself contains this plan.

## 11. Creation/edit/end UX

Every one of the four sketched inputs, challenged:

- **Cadence** — not a user input at all in v1. Fixed label "Monthly,"
  no picker (only one value ever exists — see §6).
- **Installment amount** — optional field. Display-only, never validated
  against actual payments (§20 risk #4).
- **Next expected payment** — **required**, but the field is **pre-filled
  as an editable suggestion**: `latestActualPaymentAt + ~1 month` if a
  payment exists, else `today + ~1 month`. The fundraiser must confirm or
  adjust it — never silently auto-submitted, per the task's own explicit
  caution against inferring contractual obligations they didn't specify.
- **Final expected payment** — **required, with no suggested default at
  all.** Considered auto-computing it from `balance / installment_amount`
  when both are known, and rejected: this is the single field preventing
  indefinite silent suppression (§4), so getting it silently wrong
  (rounding, a changed final payment, an estimate presented as if
  authoritative) is the highest-risk mistake this feature could make.
  Always requires explicit fundraiser entry.

```
Set payment plan
Cadence: Monthly                              (fixed label)
Installment amount (optional): $______
Next expected payment: [Sep 18, 2026]         (pre-filled, editable)
Final expected payment: [____________]        (required, no suggestion)
Note (optional): ______
[Save]
```
**Edit**: same form, pre-filled with current values; writes an
`'updated'` audit row with only the changed fields (same `changed_fields`
discipline `ask_changes` already uses).

**End**: a single `[End plan]` action, with an **optional** short reason
(unlike an Ask's `withdrawn`, which *requires* a reason — ending a
routine payment plan is a much lower-stakes, more ordinary event than
declining a solicitation, so forcing a reason isn't warranted). Sets
`ended_at = now`, writes an `'ended'` audit row. Never a hard delete, per
this codebase's universal convention (asks, interactions, relationship
summaries — nothing fundraiser-entered is ever hard-deleted here).

**Auto-end on full payment**: when the linked pledge's `balance_cents`
reaches `0`, auto-set `ended_at` (with an `'ended'` audit row, reason
`"pledge paid in full"`) rather than requiring a manual click. This is a
safe, deterministic, evidence-backed transition (reacting to an
unambiguous fact, balance = 0), not a guess — the same spirit as
`planPaymentAssignments` already auto-flipping `nextStatus` to
`'completed_gift'` when balance hits zero today.

## 12. Audit-history recommendation

**Yes — `pledge_payment_plan_changes`** (§4), directly modeled on
`ask_changes`. Justification: this metadata directly drives whether
`follow_up_pledge` is suppressed, so a change to it is exactly the class
of donor-facing, decision-affecting change this codebase already treats
as audit-worthy everywhere (4+ existing precedents). Not event-sourcing —
one row per meaningful mutation (`created`/`updated`/`ended`).

## 13. Donor-merge behavior

Add to the existing atomic batch in `app/api/donors/merge/route.ts`,
exactly mirroring the `jl_payment_assignment_audits`/`asks` treatment
already there:
```
UPDATE pledge_payment_plans SET donor_id=? WHERE donor_id=? AND user_id=?
UPDATE pledge_payment_plan_changes SET donor_id=? WHERE donor_id=? AND user_id=?
```
Because `pledge_activity_id` continues pointing at the same
`giving_activities.id` (merge reassigns that row's `donor_id`, never its
`id` — §1), a plan's link to its pledge stays structurally valid through
a merge with zero extra reconciliation. This is a direct benefit of the
§5 linkage choice.

**No automatic deduplication**, matching the Ask feature's own explicit
precedent. Two active plans can only ever end up on the survivor if they
were each already on *different* pledges — which is not a collision at
all (§15), since merge reassigns `donor_id` on existing rows, never
merges two pledge rows into one. No fuzzy dedup by amount/date is built,
per the task's explicit instruction.

## 14. JL import survivability

Covered fully in §5. Summary: survives every ordinary reimport (payment
application, balance/paid updates) because `giving_activities.id` is
preserved by the fingerprint-keyed upsert. Does **not** survive if the
pledge's own original commitment terms are corrected in a later JL
export (rare — a data-entry correction to the pledge itself, not a
payment) — flagged as a deferred edge case (§20 risk #8) with a passive
"pledge could not be confirmed" detection recommended, not solved with
reconciliation heuristics in v1.

## 15. Multiple-pledge behavior

`pledge_activity_id` is **required, non-nullable, one specific pledge —
never donor-wide.** Every query that resolves `latestActualPaymentAt`
scopes by exact `pledge_activity_id`, reusing the identical scoped-query
discipline the Bug 2 fix already established and tested (a payment
applied to pledge B structurally cannot leak into pledge A's evaluation,
because the lookup is always `WHERE pledge_activity_id = <this pledge>`,
never a whole-donor query). The donor-profile UI (§10) renders one
`OpenPledgePlanCard` affordance per open pledge, so a donor with two open
pledges and only one plan correctly shows `[Set payment plan]` on one
card and the active plan summary on the other.

## 16-18. Today / Meeting Brief / Assistant integration

**Today**: no ranking/selection changes needed at all.
`followUpPledgeCandidate` returning `null` when on-track means the
candidate simply never enters `live-data.ts`'s `ranked` array — exactly
the same null-candidate handling every other candidate function already
relies on. The only change in `live-data.ts` is fetching plan +
linked-payment data (reusing the exact query the Bug 2 fix already added)
and threading `activePaymentPlan` into `openPledge`.

**Meeting Brief**: one new factual context line near the existing
giving/pledge display, via a new `pledgePlanLine()` formatter (mirroring
`askLine()`'s exact "factual, never called an opportunity" convention):
`"Being paid monthly; next expected payment Sep 18."` or, when late:
`"Expected monthly payment appears overdue (last payment Aug 18)."`
Display-only, rule-based, never AI-generated.

**Assistant**: inherits automatically via the existing `loadMeetingBrief()`
reuse for the primary donor — zero new Assistant-specific code, exactly
how `openAsks`/family important dates already flow through today. No
donor-name search or cross-donor plan capability is added, per the
task's explicit instruction.

**No new dashboard, no cross-donor plan reporting, no "payment plan
dashboard"** — this integrates through the exact same three existing
surfaces every other evidence field does.

## 19. KOLX2026 worked example

**Design fixture only — no row was created, KOLX2026 was not modified.**
Real donor/pledge used for concreteness (Mr. & Mrs. Yaakov Zachter,
pledge `ed3e9f11-33a7-4414-9409-217d41d63009`, confirmed read-only:
$18,000 committed, $4,500 originally paid, $1,500 paid Aug 18, 2026,
$13,500 open).

Hypothetical `pledge_payment_plans` row:
```
donor_id:                   19af69d6-f147-474b-88ad-f6358ff65b9a
pledge_activity_id:         ed3e9f11-33a7-4414-9409-217d41d63009
cadence:                    monthly
installment_amount_cents:   150000        ($1,500)
next_expected_payment_at:   2026-09-18    (one month after the Aug 18 payment)
final_expected_payment_at:  2027-05-18    ($13,500 / $1,500 = 9 more months from Aug 18)
note:                       null
ended_at:                   null
```

| Scenario | `latestActualPaymentAt` | `effectiveExpectedAt` | `daysLate` | Result |
|---|---|---|---|---|
| Aug 19 (day after the Aug 18 payment) | Aug 18 | max(Sep 18, Aug 18+30d≈Sep 17) = Sep 18 | 0 | **ON TRACK** — `follow_up_pledge` suppressed |
| One day before next expected (Sep 17) | Aug 18 | Sep 18 | 0 | **ON TRACK** — suppressed |
| Seven days after the expected date (Sep 25) | Aug 18 | Sep 18 | max(0, 7-7)=0 | **ON TRACK** — exactly at the grace boundary, still suppressed (grace is inclusive) |
| Task's own "today Sep 1" LATE example, i.e. 14 days after Aug 18 with no new payment | Aug 18 | Sep 18* | — | *(see note below — this example predates the Sep 18 anchor; using the plan's literal first cycle, expected≈Sep 18, so Sep 1 is still before it and is ON TRACK. A true 14-days-late case, e.g. Oct 2 with no Sep payment: daysLate=max(0,14-7)=7 → **LATE** — "Check in on the $13,500 pledge payment plan." / "Expected monthly payment appears overdue (last payment Aug 18)."* |
| After May 18, 2027 with $0 balance | — | — | — | **COMPLETED** — `balance<=0` means `openPledge` itself is already null; no candidate at all (unrelated to the plan) |
| After May 18, 2027 with $3,000 balance | — | isPastFinal=true | — | **PLAN ENDED WITH BALANCE** — "Follow up -- the payment plan for the open $3,000 pledge was expected to be complete by May 18, 2027." |

(Table note: the task's illustrative "expected Aug 18, today Sep 1" LATE
example describes a *different*, simpler plan shape than this specific
worked fixture's first-cycle math produces — included above for
completeness, with the actual formula's own boundary behavior spelled
out explicitly rather than silently reconciled.)

## 20. Edge-case decisions

| # | Risk | Decision |
|---|---|---|
| 1 | Payment a few days early | Naturally handled — an early payment simply re-anchors `effectiveExpectedAt` earlier too; no special case. |
| 2 | Payment a few days late | Absorbed by the 7-day grace (§7); no false reactivation. |
| 3 | Two payments in one month | `MAX(payment_date)` already picks the later one correctly (same logic already tested by the Bug 2 fix); a bonus payment just makes the plan look extra on-track. |
| 4 | Payment amount differs from expected installment | **Deferred, by design.** `installment_amount_cents` is never validated against actual payments — any payment counts as activity, avoiding false reactivation over normal real-world variance. |
| 5 | Plan changes midstream | `[Edit plan]` writes an `'updated'` audit row; evaluation is always derived fresh, so no migration logic needed. |
| 6 | Donor skips a month but catches up later | Self-correcting with no special-casing: the plan correctly shows `isLate` during the gap and automatically re-suppresses the moment the catch-up payment lands. |
| 7 | Multiple open pledges | Covered by §15 — always scoped to one `pledge_activity_id`. |
| 8 | JL row replacement/import identity | **Deferred**, with passive detection recommended (§5/§14) — not solved with reconciliation heuristics. |
| 9 | Final date passes with balance | Explicit `isPlanEndedWithBalance` case (§8/§19). |
| 10 | Pledge paid early | `isFullyPaid` takes priority over everything; plan auto-ends (§11). |
| 11 | User forgets to end plan | Mitigated by the required `final_expected_payment_at` backstop and auto-end-on-full-payment; residual risk beyond that is accepted for v1, not solved further. |
| 12 | Imported historical payments predate the plan | No special handling needed — `MAX(payment_date)` naturally considers any real payment regardless of when the plan itself was created; confirmed no bug risk here. |

## 21. Files likely to change (implementation phase — not done now)

- `db/schema.ts` — new `pledgePaymentPlans`, `pledgePaymentPlanChanges` tables
- `drizzle/00XX_pledge_payment_plans.sql` (next free migration number after 0032)
- `lib/relationships/recommendation-evidence.ts` — extend `openPledge` with `activePaymentPlan`; derive `isOnTrack`/`isLate`/`daysLate`/`isPlanEndedWithBalance`/`isCompleted`
- `lib/relationships/recommendation-candidates.ts` — `followUpPledgeCandidate` branches on plan state
- `lib/workspace/live-data.ts` — fetch plans + reuse/extend the existing pledge-payment query; thread into `openPledge`
- `lib/relationships/meeting-brief.ts` — same threading + `pledgePlanLine()`
- `app/donors/[id]/page.tsx` — same threading; new `OpenPledgePlanCard`
- new `app/api/pledge-payment-plans/route.ts` (create) + `app/api/pledge-payment-plans/[id]/route.ts` (edit/end), mirroring the `asks` route shape exactly
- new `app/donors/[id]/PledgePaymentPlanManagement.tsx`, mirroring `AskManagement.tsx`
- `app/api/donors/merge/route.ts` — reassignment statements
- `lib/operations/staging-reset.ts` — `STAGING_RESET_TABLE_ORDER` entries
- `lib/operations/workspace-backup.ts` — `WORKSPACE_BACKUP_EXCLUDED_TABLES` entries
- `production-baseline/schema-manifest.json` + `production-baseline/drizzle/0000_production_baseline_00XX.sql` — regenerated via `pnpm run db:baseline:generate -- --write`, never hand-edited
- `lib/data-health/production-baseline.ts` — `PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length` bump
- new `tests/pledge-payment-plans.test.mjs`

## 22. Tests required

- Migration/schema rehearsal (real in-memory SQLite, mirroring `0032_asks.sql`'s own rehearsal test)
- `activePaymentPlan` derivation: on-track / late / plan-ended-with-balance / completed / no-plan, for every §19 scenario
- `followUpPledgeCandidate`: suppressed when on-track; correct wording when late; correct wording when ended-with-balance; unchanged behavior with no plan
- Multi-pledge isolation: a plan on pledge A never affects pledge B, same donor
- Grace-period boundary: exactly at grace, one day past grace
- Re-anchoring: consecutive payments on different days-of-month don't drift `effectiveExpectedAt`
- Historical payment predating plan creation still counts (§20 #12)
- Two payments in one month still resolves correctly (§20 #3)
- Donor merge: plan/plan-changes `donor_id` reassigned; `pledge_activity_id` untouched; no dedup applied
- Staging-reset: new tables present (self-check test should force this)
- Backup/export classification: new tables classified (self-check test should force this)
- API routes: create/edit/end, audit-row correctness, ownership checks (mirroring `asks` route tests)
- Auto-end on full payment
- No reminders/recommendations auto-created by plan creation/edit/end

## 23. Risks

See §20's table for the 12 listed risks and their disposition. Summary:
9 of 12 are naturally handled by the derived-not-stored design with no
extra code; 2 (JL row-replacement identity, user-forgets-to-end residual
risk) are explicitly deferred with documented mitigations; 1 (amount
mismatch) is deliberately never solved by design (validating installment
amounts would itself be scope creep toward accounting software).

## 24. Explicitly deferred features

- Quarterly/custom cadence (v2 only if real evidence supports it)
- Amount-matching/strict installment validation against actual payments
- Automatic reconciliation when a pledge's JL fingerprint changes (row replaced)
- User-configurable grace period
- Cross-donor plan reporting/dashboard
- A reminder tied directly to a plan's next-expected date (a plausible v2; this feature's job is suppression, not scheduling — the existing reminder system stays untouched)
- Any accounting/amortization math beyond simple day-count comparisons
- Automatic JL mutation of any kind

## 25. Recommended phased implementation order

0. **(this task)** Design only — done, awaiting approval.
1. Schema + migration (`pledge_payment_plans`, `pledge_payment_plan_changes`) + staging-reset + backup-classification + baseline regeneration. No UI, no evidence wiring. Verified via a migration-rehearsal test only.
2. Evidence/candidate wiring (`activePaymentPlan` derivation, `followUpPledgeCandidate` branching) against synthetic fixtures — Suggested Action can reason about plans before any UI exists to create one, same pattern the Ask feature's own phase 2 already proved.
3. Create/edit/end API routes + `OpenPledgePlanCard` UI on the donor page — the only way real plans start existing.
4. Meeting Brief + Assistant factual-line wiring.
5. Today wiring (fetch + thread into `live-data.ts`'s `openPledge` construction) — likely near-trivial once phase 2 exists.
6. Donor-merge reassignment wiring + test.
7. **(separate, explicitly approved, not automatic)** Live rollout to Independent Staging + live verification against a real plan set up on a real donor's real open pledge, mirroring exactly how the Ask feature's own rollout task was structured.

Each phase ships and tests independently, same discipline as the Ask
feature's own phased order.

## Terminology

Recommend **"Payment plan"** as the primary UI label (clear, natural
fundraiser language, matches how development/major-gifts staff actually
talk about this) over "Expected payment schedule" (safer but clunkier),
"Installment plan" (same accounting-authority risk as "Payment plan,"
less natural), or "Stewardship plan" (safest phrasing but reads as vague
about what it actually tracks). The accounting-authority risk the task
warns about is mitigated the same way the Ask feature already mitigates
"Ask.status='committed' must never read as a real JL pledge" — not by
avoiding a natural label, but by pairing every surface of this feature
with explicit copy making clear it is the fundraiser's own recorded
expectation, never a JL record (e.g. the creation form's own framing,
and Meeting Brief's `pledgePlanLine()` wording, always phrase it as
"being paid" / "expected," never "scheduled by JL" or similar).

---

## Unresolved decisions requiring explicit approval

1. The minimal field set in §4 — in particular: `final_expected_payment_at` **required** (not optional), `installment_amount_cents` optional and never validated, `cadence` kept as a trivial single-value column rather than omitted entirely.
2. `ended_at` (nullable timestamp) instead of a `status` enum column.
3. `giving_activities.id` as the stable pledge link, accepting the documented residual risk (rare pledge-terms-correction edge case, §5/§14/§20#8) as deferred rather than solved.
4. The fixed 7-day grace period default (not user-configurable, not zero, not behavior-inferred).
5. The "effective expected date" derivation (`max(stored anchor, latest actual payment + ~30 days)`) and the deliberate choice to approximate monthly cadence as a 30-day window rather than building real calendar-month arithmetic.
6. Auto-ending a plan (with an audited `'ended'` row) when the pledge balance reaches $0, rather than requiring a manual `[End plan]` click.
7. Terminology: "Payment plan" vs. the other candidate labels.
8. The donor-profile UX shape (new `OpenPledgePlanCard` mirroring `OpenAskCard`), and that no reminder/follow-up integration is added in v1.
9. The phased order in §25, and that Phase 1 (schema + migration only, no UI) is what gets built first once approved — not the whole feature at once.
10. Scope boundary: explicitly **not** building quarterly/custom cadence, amount validation, or cross-donor reporting in this feature at all — v2-or-never, not silently smuggled into v1.
