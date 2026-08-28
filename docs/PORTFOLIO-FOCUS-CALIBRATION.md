# Portfolio Focus — Human Calibration Round (2026-08-28)

**Purpose of this document:** expose the proposed Portfolio Focus scoring
architecture's *actual, unedited* output against current Independent
Staging data, so Shimmy can evaluate it as a fundraiser before any of it
becomes application code. **This is not a repeat of the Portfolio Focus
Investigation's hand-picked top 15** (see docs/AI-HANDOFF.md) — that list
was a human-synthesized blend of the raw score and editorial judgment.
**This document shows the raw formula's output, unedited**, exactly as
instructed for this round. Where that produces a ranking that looks
wrong, it is *left wrong* here on purpose, with an explanation, so the
weighting can be calibrated against real fundraiser judgment rather than
against what an AI assistant guesses the "right" order should be.

**Read this first:** the raw model's top 15 differs materially from the
prior investigation's published top 15. See "Why this differs from the
prior investigation" immediately below before reading the ranking itself.

**Status:** investigation/calibration only. No code, schema, UI, or
scoring formula was implemented or changed in the application. No D1
write of any kind occurred. Read-only analysis against a fresh pull of
Independent Staging data, run through the same unmodified scoring script
produced during the investigation — not re-tuned for this round.

---

## Why this differs from the prior investigation — read this first

The Portfolio Focus Investigation's published top 15 was **not** the raw
output of the proposed scoring formula. It was explicitly a human
synthesis: several donors the raw formula over-ranked because of a
modest-but-recent pledge (Michie Nudell, Moishe Weber, Dovi Weill) were
edited out on inspection, and several large, evidence-rich relationships
the raw formula under-ranks for lack of a live pledge trigger (Yale
Miller, Manuel Schnaidman, Nachum Rosenberg) were edited in.

**This round does the opposite on purpose.** Per instruction, this is a
fresh re-run of the exact scoring code from the investigation — unedited,
un-curated, not tuned toward any expected answer — so the real behavior
of the proposed weights is visible before anyone decides whether those
weights are right. **The result is a genuinely different top 15** from
the one published in the investigation:

- **Newly present in the raw top 15** that the investigation's curated
  list excluded: Moishe Weber (#7), Dovi Weill (#9), Yaakov Pollack
  (#10), Yehuda Moradian (#13) — each a modest-lifetime donor whose
  Opportunity/Stewardship score is driven by a small-dollar pledge or
  legacy balance, not a large relationship.
- **Absent from the raw top 15** that the investigation's curated list
  included: Yale Miller (raw rank **#25**), Manuel Schnaidman (raw rank
  **#48**), Nachum Rosenberg (raw rank **#82**) — all three of the
  portfolio's largest, most completely undocumented relationships. The
  raw formula's Financial Significance component correctly registers
  their size, but nothing else about them (no pledge, no interaction, no
  fact, no reminder) earns Opportunity or Stewardship points, so they
  fall well down the composite ranking despite being exactly the kind of
  donor the investigation argued the tactical engine misses.

**This is not a data error, a regression, or a methodology drift.** Every
financial-model safeguard from the investigation was re-verified intact
on this run (see "Verification gates," below) — the difference is purely
that this document shows the *unedited* formula, and the investigation
showed a *human-edited* version of it. That gap is itself the single
most important thing this calibration round has to show: **the proposed
weights, left alone, do not yet reproduce the judgment a human editor
applied to them.** Sections 6 and 10 below dig into exactly why.

---

## Verification gates (re-run fresh, all passed)

- All `giving_activities` categories present are within the audited set
  (`completed_gift`, `open_pledge`, `partially_paid_pledge`) — no
  unrecognized category silently ignored.
- 53 `partially_paid_pledge` rows loaded (>= the 40-row regression floor).
- Every `giving_activities` row has an `id`; all 17
  `jl_payment_assignment_audits` rows join to a real pledge row — no
  orphaned join.
- Canary confirmed: category-agnostic paid totals genuinely exceed
  `completed_gift`-only totals for at least one donor (proves
  `partially_paid_pledge` cash is live in the computation, not dead
  code).
- **Jonathan Spetner regression check passed:** `openPledgeCategory =
  partially_paid_pledge`, most recent cash activity 11 days ago,
  trailing-365-day cash $10,000, open balance exactly $2,000, momentum
  label `actively_fulfilling_commitment`, recommendation
  `reconnect_contact_gap` — **not** lapsed, **not** re-engagement.
- Portfolio totals: **248 in-scope donors, $3,470,745.30 lifetime
  received** — identical to the investigation's own total, confirming
  nothing about the underlying financial data changed between rounds.
- 169 of 248 donors (68%) are in the Suggested pool today.

---

## Top 15 — Portfolio Focus, raw model output

Scores are the proposed composite:
`0.35·FS + 0.25·OPP + 0.20·STEW + 0.10·MOM + 0.05·RI + 0.05·TAC`
(all six components are 0–1; see "Proposed scoring formula" at the end
of this document for the exact definitions). **Confidence is never part
of this score** — it is reported separately so thin documentation is
visible, never silently penalized.

### #1 — Mr. & Mrs. Yaakov Zachter — score 0.6243

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| 0.938 | 0.500 | 0.400 | 0.300 (actively fulfilling) | **0.800** | 0.419 | High |

**Why he ranks here:** the only donor in the portfolio where a fresh,
sizable pledge, an on-track payment plan, *and* a live, current,
correctly-un-stale Relationship Fact all line up at once. He is also the
one case in this whole document where the tactical Recommendation
Engine's own answer agrees with the strategic read.

**Evidence:**
- *Financial:* $45,400 lifetime received. $7,300 cash in the last 12
  months vs. $2,800 the year before. A real **$18,000 pledge, made 71
  days ago** (`partially_paid_pledge`), 25% paid ($4,500), **on-track**
  payment plan, $13,500 balance. Most recent payment: $1,500, 10 days
  ago.
- *Relationship:* a real, substantive text 9 days ago ("Texted video
  from first day of Zman and thanked him for his support that makes it
  happen"). One current Relationship Fact, matching that same
  interaction word-for-word — confirmed live-synthesized (Stage 3
  architecture), not stale. No Ask history; no upcoming dates.
- *Recommendation Engine:* `relationship_opportunity`, score 0.4186 —
  "A specific, currently-relevant fact is on file."

**Component explanations:** FS=0.938 (top decile lifetime + a large new
commitment). OPP=0.500 (the $18,000 pledge clears the portfolio-wide
"top 10% of all pledge sizes" bar and is <=120 days old by its own real
commitment date). STEW=0.400 (an on-track pledge, sized against the
portfolio's upper giving tier, plus the pledge's own recency). MOM=0.300
(the `actively_fulfilling_commitment` label is a fixed value, not a
ratio — see formula). **RI=0.800 — the highest Relationship Intelligence
score of anyone in the portfolio**, because a current, non-stale fact
exists and reinforces the same event the interaction already
documents. TAC=0.419 (the real engine score, included as one input).

---

### #2 — Dr. & Mrs. Mordy Goldenberg — score 0.6078 *(0.0165 below #1 — a real gap, not a tie)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| 0.930 | 0.500 | 0.300 | 0.700 (increasing) | 0.000 | 0.548 | Medium |

**Why he ranks here:** a smaller relationship than most of this list
($46,718 lifetime) but with real, dated growth and the portfolio's
highest tactical score among the top 5 — yet he outranks several
larger, better-known relationships purely on the strength of a
fresh-ish pledge and an unusually strong Opportunity score.

**Evidence:**
- *Financial:* $46,718 lifetime. $9,500 cash in the last 12 months vs.
  $2,400 the year before (a real ~4x increase). A **$12,650 new
  commitment in the last 12 months.** A small **$650 open pledge, 119
  days old, $0 paid so far** (`open_pledge`). Historical peak commitment
  $12,000; historical peak single gift $9,000.
- *Relationship:* a real interaction 17 days ago ("spoke to him about
  sponsoring a yungerman for $1,000/month for 12 months and he agreed")
  — the most recent substantive contact of anyone in the top 5. No
  current Relationship Fact; no Ask history.
- *Recommendation Engine:* `follow_up_pledge`, score 0.5483 — "No
  payment activity in 119 days."

**Component explanations:** FS=0.930 (driven mostly by the $12,650
recent-commitment percentile, since $46,718 lifetime alone is only
upper-middle of the portfolio). OPP=0.500 (his historical-peak $12,000
pledge clears the size bar, made within the last 120 days by its
commitment date). STEW=0.300 (a small, unpaid, aging pledge — modest
credit). MOM=0.700, the maximum momentum value this model assigns, from
a ~4x year-over-year cash increase. RI=0 (no structured fact). TAC=0.548
is the highest tactical score among anyone in this top 15 who isn't
Zeffren/Weinschneider (whose scores come from an explicit reminder, a
different mechanism).

---

### #3 — Mr. & Mrs. Mordechai Schwartz — score 0.6001 *(0.0077 below #2 — effectively a near-tie, not a meaningful gap)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| **0.986** | 0.650 | 0.000 | 0.700 (increasing) | 0.000 | 0.450 | Medium |

**Why he ranks here:** the **highest Financial Significance score in
the entire portfolio** — a $101,885 lifetime relationship carrying a
real, fresh, uncollected $36,000 pledge — yet a **zero** Stewardship
score keeps him from clearly separating from Goldenberg's much smaller
relationship above him. See "Explaining the ordering" below for why
that zero happened.

**Evidence:**
- *Financial:* $101,885 lifetime. $36,000 cash in the last 12 months vs.
  $13,080 the year before (+175%). A real **$36,000 open pledge, created
  60 days ago**, **$0 paid so far**. This is his only pledge ever, and
  it is also his single largest gift ever.
- *Relationship:* **zero interactions ever recorded.** No Relationship
  Fact; no Ask history; no upcoming dates.
- *Recommendation Engine:* `follow_up_pledge`, score 0.4500 — "No
  payment activity in 60 days and no completed interaction on file."

**Component explanations:** FS=0.986 (near-maximum: both his lifetime
total and his fresh $36,000 commitment sit at the top of the portfolio's
distribution). OPP=0.650 (the major-pledge bonus, **plus** an additional
credit this model gives specifically because he has *zero* documented
contact ever on a financially significant relationship — see the
critique in Section 10 about this interaction). **STEW=0.000** — despite
a real $36,000 balance, his Stewardship score is zero because his
pledge has **no active payment plan on file** (nothing has been paid
yet, so `evaluatePaymentPlan` has nothing to evaluate as "on-track"),
and the model's Stewardship formula currently requires an on-track plan
to award pledge-size credit. MOM=0.700 (the same maximum as Goldenberg,
from the +175% growth). RI=0. TAC=0.450.

---

### #4 — Dr. & Mrs. Avi Stein — score 0.5420 *(0.0581 below #3 — a real, meaningful gap)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| 0.672 | 0.500 | **0.700** | 0.300 (actively fulfilling) | 0.000 | 0.237 | High |

**Why he ranks here:** the single largest live financial event found
anywhere in this portfolio — a **$75,000 pledge**, roughly 12 days
old — but his lower overall lifetime total, relative to Schwartz and
Ramras above him, caps his Financial Significance score well below
theirs.

**Evidence:**
- *Financial:* $71,332 lifetime received. $27,083 cash in the last 12
  months vs. $20,000 the year before (real, confirmed growth even before
  the new pledge). A real **$75,000 pledge**, created **within the last
  ~12 days** — independently reconciled against the live donor page
  (his pledge row's own database date is 2029, three years in the
  future and not usable as a creation date; the real ~12-day recency
  comes from a $2,083 payment applied 2026-08-16). **11% paid
  ($8,332), on-track**, $66,668 remaining. This is also his
  historical-peak commitment.
- *Relationship:* one broadcast text 8 days ago (a shared "first day of
  Zman" message sent to many donors) — **no one-on-one contact ever.**
  No Relationship Fact; no Ask history.
- *Recommendation Engine:* `reconnect_contact_gap`, score 0.2375 — "No
  contact has ever been recorded for this donor." (`follow_up_pledge` is
  correctly suppressed because his plan is on-track.)

**Component explanations:** FS=0.672 — noticeably lower than his pledge
size alone would suggest, because Financial Significance blends
*lifetime* percentile with *recent-commitment* percentile, and his
$71,332 lifetime total is smaller than Schwartz's or Ramras's. OPP=0.500
(the $75,000 pledge clears every size bar with room to spare).
**STEW=0.700 — the highest Stewardship score of anyone in the top 15,**
because his pledge is both large and genuinely on-track. MOM=0.300 (the
fixed `actively_fulfilling_commitment` value). RI=0 (no structured
fact — only a broadcast touch is on file). TAC=0.237 (the portfolio's
flat, generic floor).

---

### #5 — Rabbi & Mrs. Shimmy Ramras — score 0.5154 *(0.0266 below #4)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| **0.925** | 0.300 | 0.200 | 0.583 (increasing) | 0.000 | 0.368 | Medium |

**Why he ranks here:** one of the ten largest lifetime relationships in
the portfolio, with confirmed real growth, but a small current pledge
keeps his Opportunity/Stewardship scores modest relative to Stein above
him.

**Evidence:**
- *Financial:* $110,155 lifetime received. $22,050 cash in the last 12
  months vs. $11,350 the year before (+94%, real, dated growth). A
  small **$1,500-of-$3,600 open pledge**, 192 days old, 58% paid. An
  additional **$9,000 of cash cannot be precisely dated** (an unaudited
  pledge remainder whose own commitment date is not a reliable past
  date) — counted in his lifetime total but conservatively excluded
  from the 12-month figures above. Historical peak commitment $12,000;
  historical peak single gift $14,400.
- *Relationship:* **zero interactions ever recorded.** No Relationship
  Fact; no Ask history. **A birthday in 6 days.**
- *Recommendation Engine:* `follow_up_pledge`, score 0.3683 — "No
  payment activity in 11 days and no completed interaction on file."

**Component explanations:** FS=0.925 (near-top of the portfolio,
reflecting his six-figure lifetime total). OPP=0.300 (his current
pledge — $3,600 total — is far too small to clear the "major pledge"
absolute-size bar; this is a "personal escalation" partial credit only).
STEW=0.200 (small pledge, modest credit; the imminent birthday adds a
little more). MOM=0.583 (a real, confirmed +94% increase, though smaller
than Schwartz/Goldenberg's ratio). RI=0. TAC=0.368.

---

### #6 — Mr. & Mrs. Jonathan Spetner — score 0.4918 *(0.0236 below #5)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| **0.950** | 0.150 | 0.400 | 0.300 (actively fulfilling) | 0.000 | 0.237 | Medium |

**Why he ranks here — and why this is a stewardship case, not an
urgency case.** See the mandatory regression audit above: this donor's
83%-complete, on-track pledge and near-top-of-portfolio lifetime total
earn him a real slot, but nothing about him should read as "needs
outreach this month." His Opportunity score is deliberately low because
his pledge is old, not new.

**Evidence:**
- *Financial:* $100,361 lifetime received. $10,000 cash in each of the
  last two 12-month windows (steady). A real **$12,000 pledge, created
  336 days ago**, **83% paid ($10,000), on-track**, $2,000 remaining.
  Most recent payment: $1,000, 11 days ago.
- *Relationship:* **zero interactions ever recorded.** No Relationship
  Fact; no Ask history; no upcoming dates.
- *Recommendation Engine:* `reconnect_contact_gap`, score 0.2375 — "No
  contact has ever been recorded for this donor."

**Component explanations:** FS=0.950 (one of the highest in the
portfolio — a genuinely large, steady lifetime relationship). **OPP=0.150
— deliberately low**, because his pledge is 336 days old by its own
real commitment date, well outside the "new opportunity" 120-day window;
only a small residual credit applies. STEW=0.400 (an on-track,
substantial, nearly-complete pledge). MOM=0.300 (fixed
`actively_fulfilling_commitment` value — explicitly **not**
"declining" or "dormant," which is the specific outcome the mandatory
regression check exists to confirm). RI=0. TAC=0.237 (the flat floor).

---

### #7 — Mr. & Mrs. Moishe Weber — score 0.4689 *(0.0229 below #6 — see the critique below; this ranking is questionable)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| **0.463** | 0.500 | **0.700** | 0.300 (actively fulfilling) | 0.000 | 0.237 | High |

**Flag for human review:** this donor's lifetime giving ($9,410) is
roughly **1/11th of Spetner's** ($100,361), yet his composite score is
only 0.023 behind him. This is one of the clearest cases in this
document where the model's Stewardship/Opportunity credit for a small,
on-track pledge nearly closes an eleven-fold financial gap. See Section
10, Case 1.

**Evidence:**
- *Financial:* $9,410 lifetime received — modest. $417 cash in the last
  12 months vs. $30 the year before. A **$5,000 pledge**, 75% paid
  ($3,750), **on-track**, $1,250 remaining. Most recent payment: $417,
  11 days ago. Historical peak commitment $5,000 (his only pledge);
  historical peak single gift $3,600.
- *Relationship:* a real text 9 days ago ("Sent message to welcome son
  (or grandson) back for the new zman"). No Relationship Fact; no Ask
  history.
- *Recommendation Engine:* `reconnect_contact_gap`, score 0.2375 — "No
  contact has ever been recorded for this donor." (The tactical engine
  does not count his recent text as "substantive" contact — it was a
  broadcast-style touch, per the same recipient-role rule used
  throughout Fundraising OS.)

**Component explanations:** FS=0.463 — genuinely low, correctly
reflecting his modest lifetime total. **OPP=0.500 and STEW=0.700 — both
near-maximum**, driven entirely by his $5,000 pledge sitting in the top
decile of the portfolio's own (heavily skewed, low-median) pledge-size
distribution and being on-track. This is the mechanism flagged in the
investigation as a known false-positive risk: a modest pledge can be
"large" only relative to a portfolio where most pledges are under $750.

---

### #8 — Mr. & Mrs. Eitan Zeffren — score 0.4486 *(0.0203 below #7)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| 0.666 | 0.200 | 0.400 | 0.476 (declining) | 0.000 | **0.757** | High |

**Why he ranks here — and why lower than Weber above him is
questionable.** He has 6x Weber's lifetime giving and an active,
already-scheduled solicitation ask (the strongest tactical signal
anywhere in the portfolio), yet ranks below him because Tactical Urgency
is deliberately capped at a 0.05 weight.

**Evidence:**
- *Financial:* $56,920 lifetime received. $18,000 cash in the last 12
  months vs. $36,000 the year before — a real **-50% decline**. No
  current open pledge (his giving has always been outright gifts).
- *Relationship:* a broadcast text 8 days ago (not counted as
  substantive). **An explicit fundraiser-created reminder is already
  scheduled: "Solicit corporate sponsorship for dinner," due
  2026-09-01.**
- *Recommendation Engine:* `honor_reminder`, score 0.7575 — the
  portfolio's tactical #3.

**Component explanations:** FS=0.666 — held down because Financial
Significance partly rewards a *recent new commitment*, and his giving is
all outright gifts, never pledges, so that half of the formula
contributes nothing regardless of his lifetime size (see Section 10,
Case 2). OPP=0.200 (no pledge to trigger the major-commitment bonus;
some credit for the real decline). STEW=0.400 (the explicit open
reminder is directly credited). MOM=0.476 ("declining," scaled down from
the raw -50% by his own Financial Significance). **TAC=0.757 — the
highest tactical score of anyone in this top 15** — but its 0.05 weight
means this enormous tactical signal only contributes ~0.038 to his
composite, which is not enough to overcome Weber's Stewardship/
Opportunity edge above him.

---

### #9 — Mr. & Mrs. Dovi Weill — score 0.4449 *(0.0037 below #8 — effectively tied)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| 0.702 | 0.150 | 0.600 | 0.300 (actively fulfilling) | 0.000 | 0.237 | High |

**Evidence:**
- *Financial:* $8,830 lifetime received — modest. $7,020 cash in the
  last 12 months vs. $0 the year before. A **$6,000 pledge**, 262 days
  old, 75% paid ($4,500), on-track, $1,500 remaining.
- *Relationship:* a text 8 days ago (broadcast, not substantive). **A
  birthday in 12 days.**
- *Recommendation Engine:* `reconnect_contact_gap`, score 0.2375.

**Component explanation:** FS=0.702 is higher than his tiny lifetime
total alone would suggest, because his $6,000 recent commitment (over
2/3 of his entire lifetime giving) scores very high on the
recent-commitment percentile — a small donor whose one pledge is large
*for him* gets credited almost as if it were large for the portfolio.
STEW=0.600 (an on-track pledge plus the upcoming birthday). This is the
same "small pledge in a low-median portfolio" pattern as Weber above.

---

### #10 — Mr. & Mrs. Yaakov Pollack — score 0.4441 *(0.0008 below #9 — this is a tie, not a meaningful ordering)*

| FS | OPP | STEW | MOM | RI | TAC | Confidence |
|---|---|---|---|---|---|---|
| 0.708 | 0.350 | 0.200 | 0.363 (declining) | 0.000 | **0.650** | High |

**Flag for human review:** this donor's presence at #10 rests almost
entirely on a **$60 pledge balance that is 10,101 days old — 27.7
years.** See Section 10, Case 4.

**Evidence:**
- *Financial:* $11,895 lifetime received. $500 cash in the last 12
  months vs. $2,000 the year before. **A $60 open pledge, its own
  commitment date 10,101 days (27.7 years) old**, $0 ever paid toward
  it.
- *Relationship:* a broadcast text 8 days ago. A birthday in 13 days.
- *Recommendation Engine:* `follow_up_pledge`, score **0.6500** — "No
  payment activity in 10,101 days." (Identical tactical score to a
  genuinely current pledge — the Recommendation Engine's urgency
  formula treats an ancient balance the same as a recent one once past
  its own staleness ceiling.)

**Component explanation:** TAC=0.650 is doing almost all of the work
here — a decades-old $60 balance produces the same 0.65 tactical score
as any other overdue pledge, and even at a 0.05 weight that is enough
to tie him with Weill above. FS=0.708 and MOM=0.363 (a real, if modest,
decline) provide the rest.

---

## Explaining the ordering, #1 through #10

| Comparison | Gap | Verdict | What actually caused it |
|---|---|---|---|
| #1 Zachter vs #2 Goldenberg | 0.0165 | Real gap | Zachter's RI=0.8 (a live, current fact) and slightly higher FS edge out Goldenberg's higher MOM/TAC — but MOM and TAC are each only weighted 0.10/0.05, so a documented fact is worth more than a bigger tactical/growth signal under these weights. **Worth asking: should one structured fact really outweigh a 4x cash increase?** |
| #2 Goldenberg vs #3 Schwartz | 0.0077 | **Effectively tied** | Schwartz's much larger lifetime ($101,885 vs $46,718) and pledge ($36,000 vs $12,650) are almost entirely canceled out by his STEW=0 (his pledge has no payment plan on file) against Goldenberg's real interaction 17 days ago and higher TAC. **A $101,885 relationship and a $46,718 relationship landing this close together is a real signal the weighting deserves scrutiny.** |
| #3 Schwartz vs #4 Stein | 0.0581 | Real, meaningful gap | Despite Stein's pledge being **more than double** Schwartz's ($75,000 vs $36,000), Schwartz's higher overall lifetime total gives him the larger FS, and Schwartz's OPP is *higher* than Stein's specifically because Schwartz has *zero* documented contact ever, while Stein has at least one broadcast touch (see Section 10, Case 3). |
| #4 Stein vs #5 Ramras | 0.0266 | Real gap | Stein's fresh $75,000 pledge drives STEW/OPP well above Ramras's small $3,600 pledge; Ramras's larger lifetime total and real growth trend aren't enough to close the gap under these weights. |
| #5 Ramras vs #6 Spetner | 0.0236 | Real gap | Nearly identical FS (0.925 vs 0.950); Ramras wins on OPP/MOM (real recent growth), Spetner wins on STEW (a bigger, further-along pledge). A defensible call either way — this is a genuine "which kind of evidence matters more" question, not a formula artifact. |
| #6 Spetner vs #7 Weber | 0.0229 | **Flag — see Section 10, Case 1** | An eleven-fold lifetime-giving gap ($100,361 vs $9,410) very nearly disappears because Weber's small pledge maxes out OPP/STEW the same way a much larger pledge would, once it clears the (low) absolute-size bar. |
| #7 Weber vs #8 Zeffren | 0.0203 | **Flag — see Section 10, Case 2** | Zeffren has 6x Weber's lifetime giving and an actual scheduled solicitation ask (TAC=0.757, the highest in this top 15) — none of it is enough to overcome Weber's Stewardship/Opportunity edge, because TAC is weighted at only 0.05. |
| #8 Zeffren vs #9 Weill | 0.0037 | **Effectively tied** | A $56,920 lifetime donor with an active fundraiser-scheduled ask and a $8,830 lifetime donor with a modest on-track pledge land within four-thousandths of one another. |
| #9 Weill vs #10 Pollack | 0.0008 | **Tied in every practical sense** | Weill's case (a real, current $6,000 pledge, 75% paid) and Pollack's case (a $60 balance untouched for 27.7 years) are financially incomparable, yet score nearly identically — Pollack's high TAC (from the tactical engine's own staleness-blind urgency formula) substitutes for financial substance that Weill actually has. |

**Pattern across all ten:** every close call above is decided by which
components happen to be non-zero for a given donor, not by a
consistent, defensible notion of "how much should this relationship
matter this month." That is exactly the kind of finding this
calibration round exists to surface.

---

## Ranks 16–25

| Rank | Donor | Score | Attention type | Primary reason | What kept them out of the top 15 |
|---|---|---|---|---|---|
| 16 | Dr. & Mrs. Dov Zeffren | 0.4122 | Learn/reconnect | $25,851 lifetime, +260% YoY, zero interactions ever, not in Suggested pool | Smaller lifetime total than #15; no pledge to boost OPP/STEW |
| 17 | Mr. & Mrs. Dovid Weinberger | 0.4111 | Reconnect | $12,872 lifetime, a fresh $1,800 open pledge (22 days old, $0 paid) | Small dollar amounts throughout; MOM=0.05 ("insufficient data" — his prior-365 window is $0, not enough history to call a trend) |
| 18 | Rabbi & Mrs. Yitzchak Sperka | 0.4067 | Learn/research | $54,837 lifetime, real growth, zero interactions ever, not in Suggested pool | No pledge at all — OPP/STEW both modest |
| 19 | Mr. & Mrs. Paltiel Myers | 0.3808 | Resolve | A $2,000 pledge, its commitment date **3,618 days (9.9 years)** old | High tactical score (0.65) but low FS (small lifetime total) |
| 20 | Mr. Daniel Saidian | 0.3797 | Reconnect | $73,622 lifetime, giving stopped entirely this year, and — unlike Spetner/Stein — his payment plan is genuinely **late**, not on-track | Zero interactions ever; no current pledge activity to lift STEW |
| 21 | Mr. & Mrs. Yaakov M Potesky | 0.3789 | Learn/reconnect | $56,632 lifetime, real decline, zero interactions ever, not in Suggested pool | No pledge; MOM capped by the "declining" formula's own scaling |
| 22 | Mr. & Mrs. Dovid Hillel Schuster | 0.3708 | Reconnect | Small ($9,363) lifetime, real decline, upcoming birthday | Low FS keeps the whole score down despite a real decline signal |
| 23 | Mr. & Mrs. Yissachar Shapiro | 0.3575 | Reconnect | $25,063 lifetime, real decline, zero interactions ever | No pledge, no upcoming date, no fact — nothing to lift OPP/STEW |
| 24 | Rabbi & Mrs. Ahron Schabes | 0.3550 | Resolve | A **$10 pledge balance, 4,018 days (11 years) old** | Trivial dollar amounts throughout despite a high tactical score |
| 25 | Mr. & Mrs. Yale Miller | 0.3544 | **Learn/research — see named-donor audit below** | **#1 lifetime relationship in the entire portfolio** ($199,150), zero interactions ever, entirely absent from the Suggested pool | **Nothing except size** — no pledge, no fact, no reminder, no recent activity of any kind to lift any component besides FS |

**Miller sitting at #25, one slot outside the published top 15, is
itself a finding** — see Section 10 and the named-donor audit for why
this is a genuine weighting question, not a data problem.

---

## Named-donor audit

Per instruction, none of these were promoted because they were named.
Ranks and components are exactly as the raw model computed them.

| Donor | Rank | Score | FS / OPP / STEW / MOM / RI / TAC | Recommendation Engine | Strategic read |
|---|---|---|---|---|---|---|
| **Avi Stein** | #4 | 0.5420 | 0.672 / 0.500 / **0.700** / 0.300 / 0.000 / 0.237 | `reconnect_contact_gap`, 0.2375 | Confirmed: largest live financial event in the portfolio, correctly on-track and un-urgent tactically, correctly scored high strategically for stewardship/acknowledgment. |
| **Mordechai Schwartz** | #3 | 0.6001 | **0.986** / 0.650 / **0.000** / 0.700 / 0.000 / 0.450 | `follow_up_pledge`, 0.4500 | Highest FS in the portfolio, but a real $0 Stewardship score (see Section 10, Case 5) keeps him from clearly separating from much smaller relationships above and around him. |
| **Yale Miller** | **#25** | 0.3544 | 0.700 / 0.150 / 0.000 / 0.600 (increasing) / 0.000 / 0.237 | `reconnect_contact_gap`, 0.2375, **not in Suggested pool** | The portfolio's #1 lifetime relationship, ranked outside the raw top 15 entirely — the single clearest example in this document of a large, completely undocumented relationship the model under-weights because nothing besides size is on file. His "increasing" MOM label is itself a modest false positive — see Section 10, Case 7. |
| **Manuel Schnaidman** | **#48** | 0.3034 | 0.697 / 0.150 / 0.000 / 0.100 (stable) / 0.000 / 0.237 | `reconnect_contact_gap`, 0.2375, **not in Suggested pool** | The portfolio's #2 lifetime relationship ($158,202), flat giving, zero interactions ever — ranks far outside the top 25 under the raw formula despite being one of the two donors the original investigation used as its clearest example of what Portfolio Focus needs to catch. |
| **Tzvi Ray** | #15 | 0.4126 | 0.694 / 0.350 / 0.000 / 0.496 (declining) / 0.000 / **0.650** | `follow_up_pledge`, 0.6500 | A confirmed real -77% YoY decline on a #3-lifetime relationship — but tactically visible only through a trivial **$10 balance, 5.2 years old**, which is also most of what is driving his composite score's TAC contribution. |
| **Shimmy Ramras** | #5 | 0.5154 | **0.925** / 0.300 / 0.200 / 0.583 (increasing) / 0.000 / 0.368 | `follow_up_pledge`, 0.3683 | Confirmed real +94% YoY growth on a top-ten lifetime relationship, correctly scored near the top of this list. |
| **Nachum Rosenberg** | **#82** | 0.2629 | 0.689 / 0.000 / 0.000 / 0.100 (stable) / 0.000 / 0.237 | `reconnect_contact_gap`, 0.2375 | A top-ten lifetime relationship ($107,616) with only ever a broadcast touch — ranks well outside the top 25 because he has no pledge, no growth signal, and no fact of any kind: FS alone cannot lift him. |
| **Dovie Weinschneider** | #11 | 0.4250 | 0.677 / **0.000** / 0.400 / 0.700 (increasing) / 0.000 / **0.757** | `honor_reminder`, 0.7575 (tactical **#1** in the portfolio) | The one donor where the tactical engine's own answer is unambiguously correct, yet the raw strategic model ranks him **#11, not #1** — his Opportunity score is a flat zero because he has no pledge at all, only a real conversation and an explicit reminder. See Section 10, Case 6. |
| **Yaakov Zachter** | #1 | 0.6243 | 0.938 / 0.500 / 0.400 / 0.300 / **0.800** / 0.419 | `relationship_opportunity`, 0.4186 | Confirmed #1 — the cleanest case in the portfolio where every kind of evidence (financial, relationship, tactical) agrees. |
| **Mayer Simcha Klein** | **#80** | 0.2709 | 0.598 / 0.000 / 0.000 / 0.100 (stable) / **0.700** / 0.329 | `reconnect_contact_gap`, 0.3291 | **The closed-loop case.** His Relationship Fact and resolved Snapshot are clean ("Solicited for a plaque ($5k)." — no stale prefix), his declined $5,000 ask from 2025-11-06 is correctly reflected, and his recommendation is correctly `reconnect_contact_gap`, never `solicit`. He ranks #80 — nowhere near the top 15 — because the specific live risk that justified his inclusion in the original investigation (a stale narrative risking a re-solicitation of a declined ask) has already been fixed by the deployed Relationship Snapshot Architecture. His RI=0.700 is real and correctly registers the fact, but nothing about his situation calls for fundraiser time this month. |
| **Jonathan Spetner** | #6 | 0.4918 | **0.950** / 0.150 / 0.400 / 0.300 (actively fulfilling) / 0.000 / 0.237 | `reconnect_contact_gap`, 0.2375 | Confirmed via the mandatory regression check: on-track, 83%-complete, correctly not flagged as lapsed or urgent — ranks in the top 10 for stewardship/documentation reasons only. |

---

## Tactical-vs-strategic disagreements

### Group A — Strategically important, tactically quiet

Donors Portfolio Focus ranks in the top 15-20 while the Recommendation
Engine scores them at or near its generic floor (0.2375,
`reconnect_contact_gap`) and/or excludes them from the Suggested pool
entirely.

| Donor | Strategic rank | Tactical score / rank | Why this is likely correct |
|---|---|---|---|
| Avi Stein | #4 | 0.2375 / tactical rank #210 | Correct — his plan is genuinely on-track, so the tactical engine is right to stay quiet; the strategic layer exists precisely to say "acknowledge this anyway." |
| Jonathan Spetner | #6 | 0.2375 / tactical rank #208 | Correct, for the same reason as Stein. |
| Yale Miller | #25 | 0.2375 / not in pool at all | Correct in direction, but the strategic score (0.354) is arguably too low for the portfolio's single largest relationship — this is the clearest argument in this document for why FS needs more weight, or a floor, for very large lifetime relationships regardless of recent activity. |
| Manuel Schnaidman | #48 | 0.2375 / not in pool at all | Same as Miller, more severe — the #2 lifetime relationship in the portfolio ranks below donors with $3,000-$10,000 lifetime totals. |
| Nachum Rosenberg | #82 | 0.2375 / tactical rank #188 | Same pattern again — a top-ten lifetime relationship with zero non-financial signal ranks in the bottom third of the portfolio strategically. |

**This group is the core evidence for Portfolio Focus's reason to
exist** — but Miller/Schnaidman/Rosenberg's actual *rank* (not merely
their presence below the tactical floor) shows the current weights do
not yet correct for this strongly enough.

### Group B — Tactically urgent, strategically lower

Donors the Recommendation Engine scores near the top of its own range
(0.65+) while Portfolio Focus ranks them well down the list.

| Donor | Tactical score / rank | Strategic rank / score | Why |
|---|---|---|---|
| Mr. & Mrs. Donny Wiesel | 0.7575 / tactical #2 | #107 / 0.2246 | An `honor_reminder` on a small ($3,600 lifetime) relationship — tactically correct to honor a real scheduled commitment, strategically minor. |
| Mr. & Mrs. David Chapman | 0.6500 / tactical #5 | #192 / 0.1007 | A $915 balance, **8,854 days (24.3 years) old.** Almost certainly not a real fundraising opportunity. |
| Mr. Itzik Pollak | 0.6500 / tactical #15 | #215 / 0.0762 | A $100 balance, 964 days old, on a $1,000 lifetime relationship. |
| Mr. & Mrs. Eliave A Sobol | 0.6500 / tactical #20 | #153 / 0.1574 | A **$25** balance, **7,225 days (19.8 years) old.** |
| Dr. & Mrs. Aaron E. Walfish | 0.6500 / tactical #23 | #151 / 0.1581 | A $590 balance, 3,951 days (10.8 years) old. |

**This group is exactly what the strategic layer should suppress** — a
fundraiser working the tactical Suggested queue top-down would spend
real time on a 24-year-old $915 balance before ever reaching Tzvi Ray's
-77% YoY decline on a $114,026 relationship. The strategic ranking
correctly demotes all five; that part of the model is working as
intended.

---

## Missing-information cases

**Principle applied throughout:** "no interaction ever logged" is
reported strictly as **no documented interaction evidence**, never as
"weak relationship," "low priority," or any inferred sentiment. The
donors below would plausibly rank differently if Fundraising OS knew
something it currently does not.

| Donor | What the system knows | What it doesn't know | How the rank might change |
|---|---|---|---|
| Mordechai Schwartz | A real $36,000 pledge, zero interactions ever | Whether this is an existing personal relationship or a purely transactional campaign gift | If a real relationship exists off-system, STEW should likely be much higher than 0 — currently 0 only because no payment plan exists yet |
| Yale Miller / Manuel Schnaidman / Nachum Rosenberg | Large lifetime totals, effectively no relationship history in FOS | Whether Shimmy or another staff member has an off-system relationship with these households | If real relationship depth exists, RI/STEW should reflect it; today the system has no way to know |
| Avi Stein | A $75,000 pledge, one broadcast text | Whether any one-on-one conversation about this pledge has actually happened but was never logged | If a real conversation happened, OPP's "zero contact ever" bonus is currently rewarding a *documentation* gap, not a real one — see Section 10, Case 3 |
| Daniel Saidian | A late, stalled pledge | Whether the lapse reflects a life circumstance, dissatisfaction, or simply an unlogged conversation already in progress | Could move him from "reconnect" to "already being handled" |
| Ramras / Zachter / Weill (upcoming birthdays) | A recorded birthday date | Whether any birthday outreach is already planned outside FOS | STEW currently assumes no plan exists; a false negative is possible here |
| Klein / Rovinsky / Pfeiffer (structured-fact donors) | A clean, correctly-resolved current fact | Why the original ask was declined | Confidence on "what happened" is high; confidence on "why" is necessarily zero — this is a real, permanent limit on what FOS can ever know from its own data |

---

## Model weaknesses — cases needing human judgment

**These are disclosed, not defended.** Per instruction, none of the
weights below were adjusted to make the results look more expected.

**1. Historical dollar magnitude nearly failing to dominate current
relationship reality (Spetner #6 vs. Weber #7).** An eleven-fold
lifetime-giving gap ($100,361 vs. $9,410) shrinks to a 0.023 composite
gap because Weber's small, on-track pledge earns nearly the same
Opportunity/Stewardship credit as a much larger one would, once it
clears the (currently low) absolute-size bar. **This is the single
clearest case in this document of the exact failure mode named in the
instructions.**

**2. Financial Significance conflates "large relationship" with
"currently has a pledge" (Zeffren, FS=0.666 despite $56,920 lifetime and
an active scheduled ask).** Because FS blends lifetime percentile with
*recent-commitment* percentile, a donor who only ever gives outright
gifts — never pledges — is structurally capped below a donor of equal
or lesser lifetime value who happens to have a fresh pledge on file.
This conflates *size* with *funding mechanism*, which are not the same
thing.

**3. The Opportunity component rewards LESS documentation, not more
(Schwartz's OPP=0.650 vs. Stein's OPP=0.500, despite Stein's pledge
being more than double Schwartz's).** Schwartz's higher score comes
partly from a "zero documented contact ever" bonus that Stein does not
get, because Stein has at least one (broadcast) interaction on file.
**This is close to an inversion of the instruction that missing data
should never become a signal** — here, missing data produces a
*positive* signal rather than a neutral one.

**4. A pledge balance is being treated as opportunity when it is really
closer to a bookkeeping question (Pollack #10, a $60/27.7-year-old
balance; Schabes #24, a $10/11-year-old balance; Myers #19, a
$2,000/9.9-year-old balance).** All three owe their ranking mostly to
the Recommendation Engine's own tactical score (0.65), which does not
distinguish a stale legacy balance from a genuinely collectible one.
Carrying that same undifferentiated tactical score into the strategic
composite (even at a 0.05 weight) is enough to produce a top-10 slot for
a $60 balance that is almost certainly not a real 30-day opportunity.

**5. The same underlying fact influences multiple components at once
(Zachter's single $18,000 pledge and the one interaction about it feed
FS, OPP, STEW, and RI simultaneously).** No component is technically
double-counting the same *dollar figure*, but four of six components
are all, in effect, describing the same one event. This is not
necessarily wrong — Zachter's situation genuinely is well-documented
across every dimension — but it means his #1 rank is less a
demonstration of six independent signals agreeing than of one strong
event being visible from six different angles.

**6. A real, agreed-correct tactical answer (Weinschneider) does not
translate into a correspondingly high strategic rank.** Weinschneider is
tactical rank #1 in the entire portfolio (`honor_reminder`, 0.7575) and
was the one donor every round of this investigation series has called
"the clearest case where the system already gets it right" — yet he
ranks **#11** strategically, below several donors with $9,000-$50,000
lifetime totals, because his Opportunity score is a flat zero (he has no
pledge at all, only a conversation and a reminder). The model currently
has no way to credit "a live, warm relationship with an explicit next
step but no dollar commitment yet" as strongly as it credits a dollar
commitment.

**7. Momentum's ratio-based test produces a real false positive on very
large, very quiet relationships (Yale Miller, MOM=0.600 "increasing").**
His last-365-vs-prior-365 swing is $1,800 -> $3,600 — a 2x ratio that
qualifies as "increasing" under the model's threshold, but both numbers
are trivial relative to his $199,150 lifetime total. The ratio test has
no minimum-dollar floor, so noise on a huge, quiet account can register
identically to a real trend on a smaller, active one.

---

## Concise financial methodology (unchanged from the investigation, re-verified this round)

- **A gift** (`completed_gift`): one fully-realized cash event.
- **A pledge**, one row per pledge (`open_pledge` = nothing paid yet,
  `partially_paid_pledge` = partway paid). `paid_cents + balance_cents`
  is the fixed original commitment.
- **A pledge payment never creates a new row.** The pledge's own
  `paid_cents`/`balance_cents` are the current aggregate state;
  `jl_payment_assignment_audits` is the only place an individual
  payment's real date lives.
- **A pledge row's own `activity_date` is NOT reliably its creation
  date.** True for most pledges (Spetner: a real 336-days-ago date) but
  demonstrably false for others (Stein: a 2029 date; several small
  donors this round with future-dated, never-paid pledges) — treating it
  as universally reliable is the single riskiest assumption in this
  model, and is the specific bug this document's own first-draft scoring
  code reproduced once before being caught and fixed (see the
  investigation's Section 10).
- **Cash received in a period** = dated gifts + dated pledge payments +
  any unaudited pledge remainder whose own commitment date is a genuine
  past date. Never includes undated remainders.
- **New commitments in a period** = a pledge's full original total,
  dated by its own commitment date — kept strictly separate from cash
  received.
- **Lifetime received** = category-agnostic sum across all cash-bearing
  categories, dated or not.
- Portfolio-wide, this round: 248 donors, $3,470,745.30 lifetime,
  identical to the prior round.

---

## Proposed scoring formula, exactly as used for this run

```
Composite = 0.35·FS + 0.25·OPP + 0.20·STEW + 0.10·MOM + 0.05·RI + 0.05·TAC
```

- **FS (Financial Significance)** = `0.7 × lifetimePercentile + 0.3 ×
  recentCommitmentPercentile` — percentile rank within the portfolio's
  own distribution of donors with any lifetime giving / any new
  commitment in the trailing 365 days.
- **OPP (Opportunity)**, additive, capped at 1: **+0.5** if the current
  open pledge (or a recently-closed one) is within 120 days of its own
  real commitment date AND its total sits in the top 10% of every
  pledge size in the portfolio; **+0.15** (only if the above didn't
  already fire) if the pledge matches/exceeds this donor's own
  historical peak commitment AND is at least moderately large in
  absolute terms; **+0.2** if >365 days since substantive contact on a
  financially meaningful relationship; **+0.15** if zero documented
  contact ever on a meaningful relationship; **+0.15** if an upcoming
  natural date exists within 30 days on a meaningful relationship;
  **+0.2** if a meaningful relationship is declining/dormant
  ("win-back").
- **STEW (Stewardship)**, additive, capped at 1: up to **+0.4**
  proportional to open-pledge size (on-track plans only) relative to the
  portfolio's own 90th-percentile lifetime giver; **+0.3** for a fresh
  (<=45-day), non-trivial pledge; **+0.2** for an upcoming natural date
  on a meaningful relationship; **+0.4** if an explicit fundraiser
  reminder is already open for this donor.
- **MOM (Momentum)**: `actively_fulfilling_commitment` (an on-track
  plan) = 0.3, fixed; `dormant_lapsed` (no dated cash in >365 days) =
  `0.4 × lifetimePercentile`; `newly_significant` (first-ever giving in
  the trailing year) = 0.9, fixed; `increasing` (last365/prior365 >=
  1.25×) = `min(0.7, 0.3 + (ratio − 1) × 0.3)`; `declining` (ratio <=
  0.6×) = `0.5 × lifetimePercentile`; `stable` = 0.1, fixed;
  `insufficient_data` = 0.05, fixed.
- **RI (Relationship Intelligence)**, additive, capped at 1: +0.5 for
  any current Relationship Fact; +0.3 for any fact clearing the
  actionability relevance floor; +0.2 for any Ask history at all.
- **TAC (Tactical Urgency)** = the real Recommendation Engine `score()`
  output, unmodified, reused as one input among six.
- **Confidence** (never part of the composite): High if >=3 of {any
  interaction ever, any current fact, any Ask history, any historical
  context, any giving history} are present; Medium if >=1; Low
  otherwise.

**Critical implementation detail, disclosed for transparency:** "is this
pledge new" is judged by the pledge's own real commitment date when
known, and falls back to payment-recency **only** when the commitment
date itself is not a usable past date. Conflating the two (using
payment-recency as a proxy for "new commitment" unconditionally) is
exactly the error that first produced an incorrect #2 ranking for
Spetner during this round's own development — caught by the mandatory
regression check, fixed before this report was written, and named here
rather than hidden.

---

**Stopping for review.** This document is exposure of the current
proposed model, not a recommendation to ship it as-is. No weight was
adjusted after seeing an unexpected result. Awaiting fundraiser judgment
before any further calibration, implementation, or code change.
