# Pledge Payment-Plan Cleanup Audit (READ-ONLY)

**Status: read-only investigation. Zero D1 mutations. Zero application
code changes.** Produced ahead of the "payment plan ending soon" alert
feature, to find outstanding pledges that should get a payment plan
before that feature ships. See `docs/PLEDGE-PAYMENT-PLAN-DESIGN.md` for
the already-approved and partially-implemented payment-plan feature
(`pledge_payment_plans` / `pledge_payment_plan_changes`, migration
`0033`, `lib/relationships/pledge-payment-plan.ts`'s `evaluatePaymentPlan`)
this audit reuses the exact same tables and definitions from.

Run against Independent Staging (`fundraising-os-staging-db`), owner
`user_sgoldstein@nirc.edu`, via read-only `wrangler d1 execute` queries
only. No row was inserted, updated, or deleted.

---

## 1. Cutoff date

**Today (execution time, UTC): 2026-10-07.**
**Cutoff: 2024-10-07T00:00:00Z** (exactly 2 years before today).
A pledge's `activity_date` must be `>= 2024-10-07` to be in scope for the
main cleanup list below.

## 2. Data model verified before querying

- **`giving_activities`** is the pledge's own row (JL Solutions is system
  of record). `activity_date` is JL's own recorded date for the row —
  confirmed from `docs/PLEDGE-PAYMENT-PLAN-DESIGN.md` §1 that this is
  "never touched again" after import, i.e. it is JL's original recorded
  date for that specific line, not a field this app computes. **Caveat
  discovered during this audit**: for installment/multi-year pledges
  (e.g. annual dinner pledges spread across a due schedule), this date
  can be in the future relative to today — 26 of the 90 open/
  partially-paid rows in Independent Staging have a future `activity_date`
  (campaigns like `DIN2025`/`DIN2026`, one `PL2026` dated **2029-04-21**).
  This is JL's own data, not a bug — but it means "pledge date" in this
  audit is JL's recorded date for the row, which is not always literally
  "the day the donor committed." Flagged, not altered.
- **Balance / paid / completed status** — `paid_cents`/`balance_cents`
  are updated in place on the same row as payments apply (never a second
  row). `category` is computed once at import time
  (`lib/import/jl-donations.ts`): `open_pledge` (nothing paid yet),
  `partially_paid_pledge` (some paid, balance remains), `completed_gift`
  (balance = 0), plus `needs_review`/`nonfinancial_entry`/`pending_gift`/
  `event_or_ad` for other row types. **"Outstanding unpaid balance, not
  completed"** = `category IN ('open_pledge','partially_paid_pledge')
  AND balance_cents > 0`.
- **Cancelled/voided/declined pledges** — **the current data model has
  no such category or status.** The only non-canonical-record state is
  `workspace_status` (`active`/`hidden`/`duplicate`/`needs_review`/
  `invalid`/`merged`); the app's own canonical "counts as real giving
  data" filter, reused verbatim here
  (`lib/giving/management.ts`'s `COUNTED_GIVING_SQL`), is
  `workspace_status = 'active' AND category NOT IN ('needs_review',
  'nonfinancial_entry','pending_gift')`. On Independent Staging today,
  every `open_pledge`/`partially_paid_pledge` row is `workspace_status =
  'active'` already (the only non-active rows found anywhere in
  `giving_activities` are 2 `duplicate` `completed_gift` rows, already
  excluded by category). There is nothing to treat as "no longer
  collectible" beyond this — a pledge with a positive balance is
  collectible by definition in this model unless a fundraiser has
  manually marked the row `hidden`/`invalid`/`duplicate`/`merged`, none
  of which occur in the current open-pledge population.
- **How payment plans attach** — `pledge_payment_plans.pledge_activity_id`
  is a required FK to exactly one `giving_activities.id` (never
  donor-wide). `ended_at IS NULL` = active; non-null = ended. No `UNIQUE`
  constraint — a pledge can have more than one plan row over time
  (renegotiated terms), so "has a plan" must check for **any row with
  `ended_at IS NULL`**, not just "any row at all."

### Exact definition used for "does not have a payment plan"

> **No `pledge_payment_plans` row exists for this pledge's
> `giving_activities.id` with `ended_at IS NULL`.**

This matches the stated intent exactly: "there is no current
payment-plan structure governing the remaining balance." Two
sub-states are reported separately, never conflated:

- **NONE** — no `pledge_payment_plans` row has ever existed for this
  pledge, active or ended.
- **OLD/INACTIVE PLAN EXISTS** — at least one `pledge_payment_plans` row
  exists for this pledge, but every one of them has `ended_at` set, and
  the pledge still carries an outstanding balance.

A pledge with an **active** plan (`ended_at IS NULL`) is excluded from
the main list entirely, regardless of how close to/past its
`final_expected_payment_at` that plan is — it currently has a payment-plan
structure, by the definition above. (One such case exists and is
reported separately in Anomalies, §5.)

## 3. Summary totals

| Metric | Value |
|---|---|
| Total qualifying pledges | **22** |
| Distinct donors | **20** |
| Total outstanding balance | **$59,293.00** |
| Count with NO payment plan ever | **22** |
| Count with OLD/INACTIVE plan but balance remains | **0** |
| By year (pledge date) | 2024: 2 · 2025: 10 · 2026: 10 |

(For reference only, not mixed into the list above: 28 additional
open/partially-paid pledges are older than the 2024-10-07 cutoff and 40
already have an active payment plan — excluded from scope by design, not
by data problems.)

## 4. Full qualifying pledge table

Sorted by newest pledge date, then largest outstanding balance. All
amounts in USD. "Last payment" is from `jl_payment_assignment_audits`
(the real applied-payment ledger) scoped to this exact pledge — **not**
available for every row; see the note under the table.

| Donor Code | Donor Name | Pledge Date | Original | Paid | Balance | Campaign | Plan Status | Last Payment Date | Last Payment Amt | Cleanup |
|---|---|---|---|---|---|---|---|---|---|---|
| 57932 | Rabbi & Mrs. Shlomo Kutoff | 2026-12-15 (future) | $5,000.00 | $4,790.00 | $210.00 | DIN2023 | NONE | n/a† | n/a† | C |
| 37064 | Rabbi Michoel A. Rovinsky | 2026-11-01 (future) | $1,250.00 | $0.00 | $1,250.00 | DYSP5786 | NONE | — | — | C |
| 48910 | Rabbi & Mrs. Joshua Broide | 2026-09-16 | $2,500.00 | $0.00 | $2,500.00 | DIN2026 | NONE | — | — | C |
| 77118 | Mr. & Mrs. Ezra Wisotsky | 2026-09-16 | $1,000.00 | $0.00 | $1,000.00 | DIN2026 | NONE | — | — | C |
| 44846 | Dr. & Mrs. Joseph N Shams | 2026-09-01 | $150.00 | $0.00 | $150.00 | CHSP2013 | NONE | — | — | C |
| 62148 | Mr. & Mrs. Dovid Weinberger | 2026-08-06 | $1,800.00 | $0.00 | $1,800.00 | KOL2026 | NONE | — | — | C |
| 59139 | Mr. & Mrs. Dovi Kreismann | 2026-06-30 | $1,500.00 | $1,125.00 | $375.00 | DIN2024 | NONE | n/a† | n/a† | A |
| 56283 | Mr. & Mrs. Mordechai Schwartz | 2026-06-29 | $36,000.00 | $0.00 | $36,000.00 | DIN2026 | NONE | — | — | B |
| 64792 | Dr. & Mrs. Mordy Goldenberg | 2026-05-01 | $650.00 | $0.00 | $650.00 | CHSP2026 | NONE | — | — | B |
| 48910 | Rabbi & Mrs. Joshua Broide | 2026-02-01 | $2,000.00 | $0.00 | $2,000.00 | DYSP5786 | NONE | — | — | B |
| 68391 | Dr. & Mrs. Mordechai Trestman | 2025-12-25 | $600.00 | $450.00 | $150.00 | NDLK | NONE | 2026-08-25 | $50.00 | A |
| 61693 | Dr. & Mrs. Yonason D Musman | 2025-12-17 | $3,600.00 | $1,000.00 | $2,600.00 | DIN2025 | NONE | 2026-08-11 | $1,000.00 | A |
| 74337 | Mr. Elie Grinblatt | 2025-12-16 | $500.00 | $0.00 | $500.00 | DIN2025 | NONE | — | — | B |
| 65768 | Rabbi & Mrs. Ahron Schabes | 2025-12-15 | $3,000.00 | $1,550.00 | $1,450.00 | DIN2025 | NONE | 2026-09-02 | $1,500.00 | A |
| 58183 | Mr. & Mrs. Yaakov Pollack | 2025-12-11 | $1,800.00 | $500.00 | $1,300.00 | DIN2025 | NONE | n/a† | n/a† | A |
| 68418 | Mr. & Mrs. Mordechai Y Goldman | 2025-11-26 | $1,200.00 | $1,000.00 | $200.00 | KOLX2025 | NONE | 2026-08-25 | $100.00 | A |
| 4930 | Mr. & Mrs. Shmuel Luxenburg | 2025-11-24 | $5,500.00 | $2,000.00 | $3,500.00 | DIN2025 | NONE | n/a† | n/a† | A |
| 78188 | Mr. & Mrs. Benjy Weil | 2025-11-20 | $240.00 | $200.00 | $40.00 | CT2025 | NONE | 2026-08-19 | $20.00 | A |
| 48910 | Rabbi & Mrs. Joshua Broide | 2025-11-11 | $2,500.00 | $0.00 | $2,500.00 | DIN2025 | NONE | — | — | B |
| 67974 | Mr. & Mrs. Avi Dear | 2025-10-29 | $1,008.00 | $840.00 | $168.00 | NDLK | NONE | 2026-08-24 | $84.00 | A |
| 61707 | Rabbi & Mrs. Ovadiah J Bander | 2024-12-16 | $1,800.00 | $1,500.00 | $300.00 | DIN2024 | NONE | n/a† | n/a† | A |
| 65769 | Mr. & Mrs. Shimmy Pianko | 2024-10-14 | $1,200.00 | $550.00 | $650.00 | NDLK | NONE | n/a† | n/a† | A |

**All dollar figures above are exactly as stored**
(`committed_cents`/`paid_cents`/`balance_cents` ÷ 100), re-verified
programmatically against the raw D1 query results before publishing
this table.

† **"n/a" means a payment was applied to this pledge
(`paid_cents > 0`) but no corresponding row exists in
`jl_payment_assignment_audits` for it** — see Anomaly §5.2. For these 6
rows, a real payment happened at some point, but this audit cannot state
its date or amount from the available ledger; this is reported as
"n/a," never guessed.

## 5. Anomalies (listed only — nothing fixed or altered)

### 5.1 Active plan already past its final date, with balance remaining
One real `pledge_payment_plans` row exists today (not synthetic/test
data — created during this feature's own staging rollout):

- Pledge `2af73169-ecd5-4682-9160-454e49a4466d`, donor **68231** (Mr. &
  Mrs. Baruch Katz), balance **$18.00**, `final_expected_payment_at`
  **2026-10-03** (4 days before this audit's execution date),
  `ended_at` still `NULL`.
- This pledge is **excluded from the main list** (§4) because it
  currently has an active plan by the definition in §2 — but that plan's
  own final date has already passed with balance remaining
  (`isPlanEndedWithBalance` per `evaluatePaymentPlan`). This is exactly
  the state the design's "ending soon" feature is meant to surface —
  flagged here, not touched.

### 5.2 Payments applied with no linked payment-assignment-audit row
**6 of the 22 qualifying pledges** have `paid_cents > 0` on the pledge
row itself but **zero** matching rows in `jl_payment_assignment_audits`:
donor codes **57932, 59139, 58183, 4930, 61707, 65769**. This means
their `paid_cents` value was set some other way than the audited
"apply payment" flow this app's own payment-plan evidence logic relies
on for `latestActualPaymentAt` — most likely pre-dating the
payment-assignment-audit system, or set directly by an import snapshot.
**Effect on this audit**: "Last payment date/amount" is reported as
"n/a" for these 6, not guessed from `activity_date` or any other proxy.
**Effect on the future "ending soon" feature**: if a payment plan is
created for any of these 6 pledges, its on-track/late evaluation will
have no `latestActualPaymentAt` to compare against until a new,
audit-trail payment is applied — worth knowing before relying on that
feature for these specific donors.

### 5.3 Multiple open pledges, same donor
Within the 22-row qualifying list: **1 donor** (donor code **48910**,
Rabbi & Mrs. Joshua Broide) has **3** separate qualifying open pledges
(`$2,500.00` 2026-09-16, `$2,000.00` 2026-02-01, `$2,500.00`
2025-11-11 — $7,000 total, 3 different campaigns/dates). Not an error — a donor can
legitimately have several concurrent open pledges — but worth a
fundraiser's eye before setting up 3 separate payment plans for the same
person.

Looking wider than the 22-row list, across **all 90** open/
partially-paid pledges (including ones excluded by the 2-year cutoff or
an existing plan): **19 donors** have more than one open/
partially-paid row. Most of the ones excluded here are old (pre-2018),
penny-level balances (as low as $0.10–$0.75) that read as legacy
rounding/reconciliation artifacts rather than real outstanding
commitments — listed for awareness, not acted on.

### 5.4 Orphaned payment plans
**None found.** All 40 `pledge_payment_plans` rows resolve to a real,
existing `giving_activities` row (checked against all 5,459 rows in the
table, not just the 90 open ones).

### 5.5 Data-consistency check
**No mismatches found.** `committed_cents = paid_cents + balance_cents`
holds exactly for all 90 open/partially-paid pledges on Independent
Staging; no negative amounts anywhere in the set.

### 5.6 Future-dated pledges
**26 of the 90** open/partially-paid pledges (not just the 22
qualifying ones) have an `activity_date` later than today — see §2's
caveat. 2 of the 22 qualifying pledges are future-dated (donor 57932,
37064) and are classified `C` below specifically because they are not
yet due.

## 6. Cleanup classification (for review only — nothing acted on)

Classified using only observable evidence, exactly as instructed — never
by dollar amount alone, and never by guessing donor intent. Rule used
(stated plainly so it can be checked or overridden):

1. **Future-dated** (`activity_date` hasn't arrived yet) → **C** — too
   early to assess; nothing is overdue.
2. Else, **any payment on record** (`paid_cents > 0`, whether via a
   clean audit-trail row or the "n/a" §5.2 case) → **A** — the donor has
   already made at least one partial payment against this balance
   without any plan tracking it.
3. Else (**zero payments ever**) and pledge is **under 90 days old** →
   **C** — recently pledged, nothing to suggest a struggle or a missed
   schedule yet.
4. Else (**zero payments ever** and **90+ days old**) → **B** — aging
   with no payment activity at all; genuinely ambiguous whether this is
   a forgotten pledge, an intentional single future payment, or
   something the fundraiser already knows the full story on. Not
   enough evidence either way.

| Category | Count | Donor codes |
|---|---|---|
| **A — Likely needs payment plan** | 11 | 59139, 68391, 61693, 65768, 58183, 68418, 4930, 78188, 67974, 61707, 65769 |
| **B — Review first** | 5 | 56283, 64792, 48910 (2026-02-01 pledge), 74337, 48910 (2025-11-11 pledge) |
| **C — Possibly intentional, no plan needed (yet)** | 6 | 57932, 37064, 48910 (2026-09-16 pledge), 77118, 44846, 62148 |

None of these are a plan creation, a pledge edit, or a donor edit — all
22 remain exactly as found.

## 7. Model/data issues discovered

1. **`activity_date` can be a future due date, not an origination date**
   (§2, §5.6) — real JL behavior for multi-year/installment pledges, not
   a bug, but worth knowing when reading "pledge date" anywhere in this
   app.
2. **No cancelled/voided/declined concept exists in this schema today**
   (§2) — if JL ever needs to represent a pledge the organization no
   longer considers collectible, there is currently no field for it
   beyond the generic `workspace_status` values, none of which are
   actually used for that purpose today.
3. **`paid_cents` can be nonzero with no corresponding
   `jl_payment_assignment_audits` row** (§5.2) — a real gap between the
   pledge's own running balance and the audited payment ledger the new
   payment-plan feature's lateness evaluation depends on. Not fixed
   here; flagged for awareness before relying on `evaluatePaymentPlan`
   for these specific pledges.
4. **One real, already-created payment plan is already past its final
   date with balance remaining** (§5.1) — a live example of exactly the
   state the planned "ending soon" alert feature needs to catch.

---

*No `donor_rebbeim`, `giving_activities`, `pledge_payment_plans`, or any
other table was written to during this audit. Every number above comes
from direct, read-only `wrangler d1 execute` queries against Independent
Staging, re-derivable at any time.*
