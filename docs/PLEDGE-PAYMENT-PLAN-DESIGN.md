# Pledge Payment Plan — Design (not implemented)

Status: **DESIGN ONLY, REVISED AND APPROVED (pending the mechanics
introduced by this revision).** No schema, migration, or application code
has been written. No D1 was touched (read-only queries only, for the
audit and the KOLX2026 worked example). This document is the full audit
and design report; `docs/AI-HANDOFF.md` carries a summary and points
here.

**Revision note**: the overall design was approved with one material
correction required to §8 (the original `latest actual payment + ~30
days` expected-date formula conflated EXPECTED schedule with ACTUAL
payment behavior and was rejected) and one reversal to §11 (a plan is no
longer auto-ended when the pledge balance reaches zero). §8, §9's
references, §11, and §19 are revised below; every other section reflects
the original, still-approved design. See "Approval status" near the end
for the exact list of what changed vs. what's confirmed.

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
| `expected_day_of_month` | **Yes — required** (revised in this round) | The fixed calendar-day anchor (1-31), auto-derived from `next_expected_payment_at`'s own day at creation/edit time (no separate form field — see §11). **Necessary, not merely convenient**: once `next_expected_payment_at`/a derived cycle date has been clamped through a February (displayed as day 28), the raw date value alone cannot say whether the *original* intended day was 28 or 31 — that information is lost the moment it's clamped. A separate persisted anchor is the only way to correctly return to the 31st in March. See §8. |
| `next_expected_payment_at` | Yes, **required** | The plan's original/last-edited anchor date. See §8 (revised in this round) for exactly how it's used — it is the seed the calendar-month walk starts from, never overwritten by a background process, only by an explicit `[Edit plan]`. |
| `final_expected_payment_at` | Yes, **required, not nullable** | Deliberately required, not optional — this is the sole backstop against indefinite silent suppression (risk #11, "user forgets to end plan"). Without it, an on-track plan could suppress follow-up forever. |
| `note` | Yes, nullable | Matches `asks.note` exactly. |
| `status` (enum) | **No — replaced by `ended_at`** | Challenged directly, per the task's own instruction. There are truly only two states here (active/ended), not the 3+ states that justify an enum elsewhere in this schema (`recommendations.status`, `data_imports.status`). A nullable `ended_at` timestamp (`NULL` = active, non-null = ended) is smaller, gives "when did it end" for free, and avoids the task's own flagged risk of a status column duplicating what a timestamp already implies. |
| `created_at`/`updated_at` | Yes | Matches the `...timestamps` spread convention used everywhere else in this schema (see `asks`). |

**Recommended schema** (revised in this round — adds `expected_day_of_month`):
```
pledge_payment_plans
  id                          text PRIMARY KEY
  user_id                     text NOT NULL REFERENCES users(id)
  donor_id                    text NOT NULL REFERENCES donors(id)
  pledge_activity_id          text NOT NULL REFERENCES giving_activities(id)
  cadence                     text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('monthly'))
  installment_amount_cents    integer                    -- nullable, display-only
  expected_day_of_month       integer NOT NULL CHECK (expected_day_of_month BETWEEN 1 AND 31)
  next_expected_payment_at    integer NOT NULL           -- date-only epoch; the anchor
  final_expected_payment_at   integer NOT NULL           -- date-only epoch, required backstop
  note                        text                       -- nullable
  ended_at                    integer                    -- nullable; NULL = active; ONLY ever
                                                           -- set by an explicit fundraiser
                                                           -- action, never automatically on
                                                           -- zero balance (revised, see §11)
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

## 8. Expected-vs-actual logic (REVISED)

**This section replaces the prior version's `effectiveExpectedAt =
latestActualPaymentAt + ~30 days` formula, which was rejected**: it
conflated the AGREED schedule with ACTUAL payment behavior, causing an
early or late payment to permanently shift all future expected dates
(concretely: an Aug 15 early payment then a Sep 22 late payment would
have dragged the "expected day" from the 18th toward the 22nd, when the
agreement is and stays "the 18th of every month"). The revised model
keeps EXPECTED and ACTUAL strictly separate, as required:

- **EXPECTED** — `next_expected_payment_at`, `expected_day_of_month`,
  `final_expected_payment_at`. Advances **only** by calendar-month
  arithmetic from itself. Never touched by an actual payment's own date.
- **ACTUAL** — `latestActualPaymentAt` (MAX of linked
  `jl_payment_assignment_audits.payment_date` for this exact pledge —
  the same query the Bug 2 fix already added, reused directly). Used
  **only** to decide whether an expected cycle has been *satisfied* —
  never to redefine what the schedule itself is.

### Calendar-month advancement rule

All fields below are still **derived at evidence-build time, never
stored** (`next_expected_payment_at` itself is never rewritten by
background logic — see the note at the end of this section).

```
function daysInSpecificMonth(year, month): integer
  // Small (~5-line) helper -- reuses isLeapYear(), already exported
  // from lib/calendar/gregorian-recurring-date.ts. Every non-February
  // month's real day count is fixed and already correct in that file's
  // own DAYS_IN_MONTH_MAX table; only February varies by year, which
  // isLeapYear() already answers. No new date library, no new engine.
  return month === 2 ? (isLeapYear(year) ? 29 : 28) : DAYS_IN_MONTH_MAX[month - 1]

function advanceOneCalendarMonth(fromDateOnlyEpoch, expectedDayOfMonth): epoch
  { year, month } = calendar parts of fromDateOnlyEpoch (UTC, date-only)
  nextMonth = month === 12 ? 1 : month + 1
  nextYear  = month === 12 ? year + 1 : year
  // ALWAYS clamps to expectedDayOfMonth -- the FIXED anchor -- never to
  // fromDateOnlyEpoch's own (possibly already-clamped) day. This is
  // exactly what makes Feb 28 -> Mar 31 correct instead of Feb 28 -> Mar 28.
  clampedDay = min(expectedDayOfMonth, daysInSpecificMonth(nextYear, nextMonth))
  return dateOnlyEpoch(nextYear, nextMonth, clampedDay)
```

`advanceOneCalendarMonth` is called with `expectedDayOfMonth` — the
stored anchor — on every step, never with the previous step's own
(possibly clamped) day. This is the entire mechanism that prevents
permanent drift to the 28th after a February.

### Cycle-satisfaction rule

```
GRACE_DAYS = 7                // constant, not stored
CYCLE_WALK_CAP = 60           // defensive bound only (~5 years) --
                                // guards against corrupted/absurd anchor
                                // data, not a normal-operation limit;
                                // a donor paying monthly for 5 real
                                // years just walks 60 cheap steps

function isCycleSatisfied(cycleExpectedAt, latestActualPaymentAt): boolean
  return latestActualPaymentAt !== null
    && latestActualPaymentAt >= cycleExpectedAt - GRACE_DAYS   // symmetric
    // No upper bound needed here: a payment arbitrarily LATE for this
    // cycle still satisfies it (better late than never -- see risk #2/#6
    // below); lateness itself is measured separately, from "now," not
    // from whether some payment eventually arrived.

function currentCycleExpectedAt(plan, latestActualPaymentAt): epoch
  cycle = plan.nextExpectedPaymentAt
  iterations = 0
  while isCycleSatisfied(cycle, latestActualPaymentAt) and iterations < CYCLE_WALK_CAP:
    cycle = advanceOneCalendarMonth(cycle, plan.expectedDayOfMonth)
    iterations += 1
  return cycle   // the first NOT-YET-satisfied expected cycle
```

This directly answers every one of the eight required cases (worked
through in detail in §8a below): a payment within `±GRACE_DAYS` of a
cycle's expected date satisfies exactly that cycle; a late payment still
satisfies whichever cycle it lands closest-after; two payments in one
month collapse to the same `MAX()` used everywhere else in this codebase;
a skipped month self-corrects the moment a catch-up payment lands; and —
critically — **the walk always advances using `expected_day_of_month`,
never the actual payment's own day**, so a September payment landing on
the 22nd still produces `Oct 18` as the next cycle, not `Oct 22`.

### Putting it together

```
isActive     = plan.endedAt === null
isFullyPaid  = balanceCents <= 0             // derived from JL balance
                                                // directly, always -- see §11
isPastFinal  = now > plan.finalExpectedPaymentAt

cycleAt = currentCycleExpectedAt(plan, latestActualPaymentAt)

daysLate = (isActive && !isFullyPaid && !isPastFinal)
  ? max(0, daysBetween(now, cycleAt) - GRACE_DAYS)
  : 0
isLate                 = daysLate > 0
isOnTrack              = isActive && !isFullyPaid && !isPastFinal && !isLate
isPlanEndedWithBalance = isActive && isPastFinal && !isFullyPaid
isCompleted             = isFullyPaid           // regardless of endedAt or isActive
```

"LATE" means exactly: **`now > cycleAt + 7 calendar days`**, where
`cycleAt` is the first not-yet-satisfied expected cycle (never a raw,
possibly-stale `next_expected_payment_at` read straight off the row) —
this is the precise form of the approved "today > next_expected_payment_date
+ 7 calendar days" rule, generalized to "current cycle" so it stays
correct after any number of elapsed months without a background job ever
rewriting the stored anchor.

`next_expected_payment_at` in the stored record means "the plan's
originally-declared (or last explicitly edited) anchor date." It is
**never** rewritten by background logic — the UI displays the *derived*
`cycleAt` (e.g. "Next expected: Oct 18"), which is always current, while
the stored field stays exactly what the fundraiser last set until they
explicitly `[Edit plan]`. This keeps the "prefer deriving over storing
computed state" discipline intact even under the revised, stricter
calendar-anchored model.

### 8a. Deterministic behavior for the eight required cases

| # | Case | `isCycleSatisfied` outcome | Result |
|---|---|---|---|
| 1 | Payment a few days early (e.g. expected 18th, paid 15th) | `15th >= 18th - 7 = 11th` → satisfied | Cycle satisfied; walk advances to next month's 18th. A payment more than 7 days early does not yet satisfy the upcoming cycle (it may instead satisfy an earlier still-open one, or simply not count yet) — bounded by the same symmetric grace window, not a separate rule. |
| 2 | Payment on the expected date | `18th >= 11th` → satisfied trivially | On track. |
| 3 | Payment during the 7-day grace (e.g. paid the 23rd) | `23rd >= 11th` → satisfied | On track — the whole point of the grace window. |
| 4 | Payment after grace (e.g. paid the 26th, 8 days late) | Still `>= 11th` → eventually satisfied once it lands | The gap between the grace deadline and the actual late payment correctly shows `isLate = true`; the moment the late payment is recorded, the cycle is satisfied and the walk advances — self-correcting, no manual reset needed. |
| 5 | Two payments in one month | `MAX(payment_date)` is the only input | Identical to the Bug 2 fix's own multi-payment handling — the later payment is what's checked; the earlier one is irrelevant. |
| 6 | No payment for one month, then a payment the following month | The skipped cycle is `isLate` throughout the gap; the catch-up payment satisfies whichever cycle it's within grace of | Self-corrects the moment the catch-up payment lands — no special-casing, no manual "resume" action. |
| 7 | Payment below the optional installment amount | Amount is never inspected | Satisfies the cycle exactly the same as a full payment — see the Installment-amount section below for why this is the simple, safe rule. |
| 8 | Payment above the optional installment amount | Amount is never inspected | Same as #7 — a larger payment satisfies the cycle no differently; if it happens to zero the balance, `isCompleted` takes over separately (§11), unrelated to this rule. |

### Installment-amount semantics (confirmed)

`installment_amount_cents` is **purely descriptive** — the
cycle-satisfaction rule never reads it. The "very simple, safe rule"
requested: presence and *date* of a linked payment is what satisfies a
cycle; *amount* is never checked. This is safe because (a) real donors
legitimately vary payment amounts for many benign reasons that shouldn't
trigger false lateness, (b) amount reconciliation is exactly the kind of
accounting-adjacent logic this feature must not become, and (c) the one
case where amount genuinely matters — the pledge being effectively paid
off — is already and separately handled by `isFullyPaid`, which reads the
real JL balance directly, not this rule.

### The month-end problem, now resolved with calendar-month arithmetic

The revised model *does* build the small calendar-month-advancement
function the original version deliberately avoided — because the task's
own worked requirement (schedule must not drift from the 18th, and Feb
28 must not permanently reset a 31st-anchored schedule to the 28th)
cannot be satisfied by a day-count approximation; it requires real
calendar intent. The scope stays minimal: one ~10-line advancement
function, reusing `isLeapYear()` (already exported), storing exactly one
new field (`expected_day_of_month`) to preserve the anchor day across a
clamp — not a general recurrence engine (still monthly-only, still no
recurrence-rule string, still no library).

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

**Paid-off behavior (REVISED — no longer auto-ends the plan).** The
original version of this design recommended auto-setting `ended_at` when
`balance_cents` reaches `0`. **This is rejected**: `ended_at` must
represent only an explicit local ending/editing action; a zero balance is
derived financial state, and the two must not be conflated. Once
`balance_cents <= 0`, `isFullyPaid`/`isCompleted` (§8) already makes the
plan's suppression logic moot on its own — `openPledge` itself becomes
`null` once balance is `<=0` (structural, unrelated to any plan), so
`follow_up_pledge` cannot fire regardless of whether `ended_at` was ever
set. The plan row is left exactly as the fundraiser last left it. The
donor-profile card (§10) may show a passive, non-blocking hint ("This
plan appears complete — paid in full") with the existing `[End plan]`
button still available for the fundraiser to click if/when they want to,
but nothing is written automatically.

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

## 19. KOLX2026 worked example (REVISED — true calendar-month schedule)

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
expected_day_of_month:      18
next_expected_payment_at:   2026-09-18    (one calendar month after Aug 18)
final_expected_payment_at:  2027-05-18    (unchanged from the original design fixture)
note:                       null
ended_at:                   null
```

| Scenario | `latestActualPaymentAt` | `cycleAt` (current unsatisfied cycle) | `daysLate` | Result |
|---|---|---|---|---|
| **Aug 19** (day after the Aug 18 payment) | Aug 18 | Sep 18 (Aug 18 doesn't satisfy Sep 18 — too early: `Aug18 < Sep18-7=Sep11`) | 0 (now < cycleAt) | **ON TRACK** — suppressed |
| **Sep 17** (one day before expected) | Aug 18 | Sep 18 | 0 | **ON TRACK** — suppressed |
| **Sep 18** (exactly on the expected date, no September payment yet) | Aug 18 | Sep 18 | 0 | **ON TRACK** — suppressed (right at the due date, still within grace) |
| **Sep 25** (7 days after expected, no September payment) | Aug 18 | Sep 18 | max(0, 7-7)=0 | **ON TRACK** — exactly at the grace boundary, grace is inclusive |
| **Sep 26** with no September payment | Aug 18 | Sep 18 | max(0, 8-7)=1 | **LATE** — "Check in on the $13,500 pledge payment plan." / "Expected monthly payment appears overdue (last payment Aug 18)." |
| **Sep 22** if a payment arrived that day (4 days after expected, within grace) | Sep 22 | `isCycleSatisfied(Sep18, Sep22)`: `Sep22 >= Sep11` → satisfied → walk advances to `advanceOneCalendarMonth(Sep18, 18) = Oct18`; `isCycleSatisfied(Oct18, Sep22)`: `Sep22 >= Oct11`? No → stop at Oct 18 | 0 (now=Sep22 < Oct18) | **ON TRACK** — the September cycle is satisfied (a few days late is fine); next expected cycle is now Oct 18 |
| **October, after that late-but-within-grace September payment** | Sep 22 | `advanceOneCalendarMonth(Sep18, expectedDayOfMonth=18)` = **Oct 18** — **not** `Sep22 + ~1 month ≈ Oct 22`, because the walk always uses the fixed `expected_day_of_month=18`, never the actual payment's own day | — | Proves no drift: the schedule stays anchored to the 18th regardless of which day payments actually land on |
| **Final date (May 18, 2027) with $0 balance** | — | — | — | **COMPLETED** — `balance<=0` means `openPledge` itself is already `null` structurally; no `follow_up_pledge` candidate at all, unrelated to the plan. The plan row itself is **not** auto-ended (§11, revised) — it simply stops mattering to the recommendation engine. |
| **Final date (May 18, 2027) with $3,000 balance** | — | `isPastFinal = true` overrides on-track status regardless of cycle satisfaction | — | **PLAN ENDED WITH BALANCE** — "Follow up -- the payment plan for the open $3,000 pledge was expected to be complete by May 18, 2027." |

## 20. Edge-case decisions

| # | Risk | Decision |
|---|---|---|
| 1 | Payment a few days early | Naturally handled by the symmetric `±GRACE_DAYS` window in `isCycleSatisfied` (§8/§8a #1) — satisfies the upcoming cycle without redefining the schedule itself. |
| 2 | Payment a few days late | Absorbed by the 7-day grace (§7/§8a #3); no false reactivation. |
| 3 | Two payments in one month | `MAX(payment_date)` already picks the later one correctly (same logic already tested by the Bug 2 fix and reused unchanged here); a bonus payment just satisfies the current cycle a bit more comfortably. |
| 4 | Payment amount differs from expected installment | **Deferred, by design.** `installment_amount_cents` is never validated against actual payments (§8a Installment-amount semantics) — any payment counts as cycle-satisfying activity, avoiding false reactivation over normal real-world variance. |
| 5 | Plan changes midstream | `[Edit plan]` writes an `'updated'` audit row; evaluation is always derived fresh from the current stored anchor, so no migration logic is needed. |
| 6 | Donor skips a month but catches up later | Self-correcting with no special-casing (§8a #4/#6): the skipped cycle correctly shows `isLate` during the gap and the walk automatically advances/re-suppresses the moment the catch-up payment satisfies it — using the fixed `expected_day_of_month` for the next cycle, never drifting to the catch-up payment's own day. |
| 7 | Multiple open pledges | Covered by §15 — always scoped to one `pledge_activity_id`. |
| 8 | JL row replacement/import identity | **Deferred**, with passive detection recommended (§5/§14) — not solved with reconciliation heuristics. |
| 9 | Final date passes with balance | Explicit `isPlanEndedWithBalance` case (§8/§19), overrides on-track status regardless of cycle satisfaction. |
| 10 | Pledge paid early | `isFullyPaid` (derived directly from the live JL balance) takes priority over everything for recommendation purposes — `follow_up_pledge` cannot fire once balance is `<=0`, regardless of the plan. The plan row itself is **not** auto-ended (revised — see §11); it remains until an explicit `[End plan]`. |
| 11 | User forgets to end plan | Mitigated by the required `final_expected_payment_at` backstop (`isPlanEndedWithBalance` still fires) and by `isFullyPaid` already suppressing `follow_up_pledge` on its own once paid off; a stale-but-harmless plan row sitting unended is accepted residual risk for v1, not solved further. |
| 12 | Imported historical payments predate the plan | No special handling needed — `MAX(payment_date)` naturally considers any real payment regardless of when the plan itself was created; confirmed no bug risk here. |

## 21. Files likely to change (implementation phase — not done now)

- `db/schema.ts` — new `pledgePaymentPlans`, `pledgePaymentPlanChanges` tables (including `expectedDayOfMonth`)
- `drizzle/00XX_pledge_payment_plans.sql` (next free migration number after 0032)
- new `lib/relationships/pledge-payment-plan.ts` (or similar) — the small, pure calendar-month arithmetic (`advanceOneCalendarMonth`, reusing `isLeapYear` from `lib/calendar/gregorian-recurring-date.ts`) and cycle-satisfaction walk (`isCycleSatisfied`, `currentCycleExpectedAt`) from §8 — kept separate from `recommendation-evidence.ts` since it's pure date arithmetic, not evidence-shaping, mirroring how `lib/calendar/*.ts` is already split out from the loaders that consume it
- `lib/relationships/recommendation-evidence.ts` — extend `openPledge` with `activePaymentPlan`; derive `isOnTrack`/`isLate`/`daysLate`/`isPlanEndedWithBalance`/`isCompleted` using the above module
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
- `advanceOneCalendarMonth`: Jan 31 → Feb 28 (non-leap) / Feb 29 (leap); Feb 28/29 → Mar 31 (**must** return to 31, not stay pinned at 28 — the core month-end requirement); every other month's ordinary 31→30-day transition (e.g. day 31 anchor into April → 30)
- `isCycleSatisfied`/`currentCycleExpectedAt` (the cycle-satisfaction walk): each of the 8 §8a cases individually — a few days early, on the date, within grace, after grace (self-corrects once paid), two payments in one month, a skipped month followed by a catch-up, amount below/above installment (both must satisfy identically, amount never inspected)
- **The core anti-drift proof**: a September payment landing on a non-anchor day (e.g. the 22nd) must still produce `Oct 18` as the next cycle, never `Oct 22` — the KOLX2026 §19 "proving no drift" scenario, asserted directly
- `activePaymentPlan` derivation: on-track / late / plan-ended-with-balance / completed / no-plan, for every §19 scenario
- `followUpPledgeCandidate`: suppressed when on-track; correct wording when late; correct wording when ended-with-balance; unchanged behavior with no plan
- Multi-pledge isolation: a plan on pledge A never affects pledge B, same donor
- Grace-period boundary: exactly at grace (still on track), one day past grace (late)
- Historical payment predating plan creation still counts (§20 #12)
- Donor merge: plan/plan-changes `donor_id` reassigned; `pledge_activity_id` untouched; no dedup applied
- Staging-reset: new tables present (self-check test should force this)
- Backup/export classification: new tables classified (self-check test should force this)
- API routes: create/edit/end, audit-row correctness, ownership checks (mirroring `asks` route tests)
- Paid-off behavior: `ended_at` is confirmed **not** auto-set when balance reaches zero; `isCompleted`/`isFullyPaid` alone suppresses the candidate
- `expected_day_of_month` auto-derivation from the fundraiser-entered `next_expected_payment_at` at creation/edit time
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

## Approval status (updated this round)

**The overall design is approved**, with one material revision required
and now made: §8's expected-vs-actual mechanism (previously a rejected
`latest actual payment + ~30 days` day-count approximation) has been
replaced with a true calendar-month-anchored schedule (`expected_day_of_
month` + `advanceOneCalendarMonth` + the `isCycleSatisfied` walk, §8/§8a),
and §11's paid-off behavior (previously auto-ending the plan on zero
balance) has been reversed to never auto-set `ended_at`. Every other
previously-approved item (§4's field set otherwise, `ended_at` over a
status enum, `giving_activities.id` linkage, monthly-only cadence, the
fixed 7-day grace, optional/never-validated installment amount,
one-pledge-per-plan, the compact card UX, `follow_up_pledge` becoming
plan-aware rather than a new candidate kind, no JL mutation, no fake
giving rows, no automatic reminders, no general recurrence engine, no
cross-donor reporting, no pipeline/collections architecture, multiple
pledges each having their own plan, "Payment plan" terminology, and the
phased implementation order in §25) is **unchanged and remains approved**
exactly as originally written.

## Unresolved decisions requiring explicit approval

Only the mechanics introduced or changed by *this* revision remain open
— everything else above is confirmed:

1. **The `expected_day_of_month` field itself** (§4/§8) — a new,
   required, auto-derived-not-user-entered field, storing the fixed
   calendar-day anchor separately from `next_expected_payment_at` so a
   February clamp can never permanently lose the true anchor day.
2. **The specific calendar-month advancement algorithm** (§8) —
   `advanceOneCalendarMonth` always clamps to the *fixed*
   `expected_day_of_month`, never to the previous cycle's own (possibly
   already-clamped) day. This is what makes Feb 28 → Mar 31 correct; a
   simpler-but-wrong version would silently produce Feb 28 → Mar 28.
3. **The specific cycle-satisfaction rule** (§8/§8a) — a symmetric
   `±GRACE_DAYS` window around each cycle's expected date, checked via a
   bounded forward walk (`CYCLE_WALK_CAP = 60`, a defensive/data-sanity
   bound only) that finds the first not-yet-satisfied cycle; payment
   *amount* is never inspected for satisfaction purposes.
4. **The reversed paid-off behavior** (§11) — confirming `ended_at` is
   *never* auto-set on zero balance, and that the plan row is left
   exactly as the fundraiser last left it (with only a passive UI hint,
   never a write) once the pledge is fully paid.
5. Confirmation that the phased order in §25 still applies unchanged
   under this revised mechanism, and that Phase 1 (schema + migration
   only, including the new `expected_day_of_month` column, no UI) is
   what gets built first once approved — not the whole feature at once.
