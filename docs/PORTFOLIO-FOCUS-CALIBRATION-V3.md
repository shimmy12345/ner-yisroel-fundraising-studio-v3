# Portfolio Focus — Human Calibration Round 3 (2026-08-28)

**Purpose:** Round 2 fixed the major structural defects (Financial
Significance no longer pledge-dependent; the missing-contact-as-
Opportunity inversion removed; Stewardship no longer requires a payment
plan; Momentum's noise problem fixed; ancient balances neutralized).
Round 2's own honest self-critique left two open questions: (1) small
active pledges still scored Opportunity too close to major commitments,
and (2) the portfolio's largest, quietest relationships (Miller,
Schnaidman, Rosenberg) had nowhere to register except "financially
significant, ranked outside the top 30." **This round makes the
smallest necessary conceptual corrections to both, freezes the result,
and runs it once.** It does not re-litigate anything Round 2 already
fixed.

**Status:** investigation/calibration only. No code, schema, UI, or
Recommendation Engine change. No D1 write of any kind. Read-only.

---

## 1. Executive findings

- **All financial-model verification gates passed, including a fresh
  Jonathan Spetner regression check.** Data is unchanged from Rounds 1
  and 2 (248 donors, $3,470,745.30 lifetime).
- **All ten Round 2 regression requirements held** (Section 8 confirms
  each one individually against fresh output).
- **The small-pledge Opportunity overcredit problem is substantially
  fixed.** Yaakov Milch's Opportunity fell from 0.748 to 0.420; Moshe
  Matz from 0.725 to 0.384; Ezra Fox from 0.647 to 0.363; Dovid
  Weinberger from 0.739 to 0.432. All four dropped meaningfully in rank
  (Milch #10 -> #19, Matz #11 -> #23, Fox #12 -> #41). **Moishe Weber
  remains the one partial holdout** — his Opportunity fell (0.826 ->
  0.583) but he still ranks #6, ahead of several six-figure
  relationships. Disclosed, not hidden (Section 11).
- **Relationship Coverage, built as a non-competing floor (Option B),
  successfully surfaces Yale Miller (#32 -> #9), Manuel Schnaidman (#40
  -> #14), and Tzvi Ray (#17 -> #12)** with the correct, honest
  attention type — **"Relationship coverage needed (learn/review)"** —
  never "solicit," never an invented opportunity. Nachum Rosenberg's
  Coverage does **not** trigger (he has at least one documented
  interaction, unlike the other three), correctly distinguishing "truly
  zero visibility" from "thin but present" documentation.
- **Every mandatory strong-active-case regression held**: Stein #1,
  Schwartz #2, Weinschneider #3, Zachter #4, Zeffren #5 — the same five
  donors occupy the same five slots as Round 2, in a slightly reordered
  but fully explicable sequence.
- **All five stale-balance regression cases remain neutralized** with
  zero database or Recommendation Engine change.
- **New questionable cases were found and are disclosed in Section 11**
  — none are conceptual defects; all are refinement-level questions
  (Coverage's ceiling occasionally outranks small-but-genuinely-active
  donors; one attention-type labeling ordering bug; Weber's residual
  elevation).
- **Recommendation: B — ready with one small, specific adjustment**
  (Section 13).

---

## 2. Round 3 — Top 15, raw and unedited

Composite: `max(0.35·FS + 0.30·OPP + 0.20·STEW + 0.10·MOM + 0.05·TAC, coverageFloor)`
— **no weight changed from Round 2.** Coverage is a floor, not a
seventh weighted term (Section 7 explains the choice).

### #1 — Dr. & Mrs. Avi Stein — 0.7278 *(Round 2: #1, 0.7429)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.866 | 0.930 | 0.518 | 0.300 (actively fulfilling) | 0.237 | 0.606 (floor 0.100 — not triggered) | Financial: high / Relationship: high |

**Recommendation Engine:** `reconnect_contact_gap`, 0.2375.
**Attention type:** Cultivate/steward (active commitment).

**Evidence:** $71,332 lifetime, a real **$75,000 pledge** ~12 days old,
11% paid, on-track. Only one broadcast text on file.

**Why he still ranks #1:** his Opportunity dipped slightly (0.967 ->
0.930) under the corrected materiality formula — the new formula is
more conservative everywhere, including at the very top — but he
remains the largest live financial event in the portfolio by a wide
margin, and nothing else in the portfolio combines size, recency, and
active fulfillment this strongly.

---

### #2 — Mr. & Mrs. Mordechai Schwartz — 0.6992 *(Round 2: #2, 0.7289)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.969 | 0.723 | 0.253 | 0.700 (increasing) | 0.450 | 0.969 (floor 0.410 — not triggered) | Financial: high / Relationship: medium |

**Recommendation Engine:** `follow_up_pledge`, 0.4500.
**Attention type:** Cultivate/steward (active commitment).

**Evidence:** $101,885 lifetime, a real **$36,000 open pledge**, 60 days
old, $0 paid yet, +175% YoY growth. Zero interactions ever.

**Note his Coverage (0.969) is nearly as high as Miller's (0.996) — he
too has essentially zero relationship documentation** — but his own
real Opportunity/Stewardship evidence (0.723 / 0.253) comfortably
exceeds the coverage floor (0.410), so the floor has no effect on him.
This is the floor architecture working exactly as designed: it only
ever matters when nothing else does.

---

### #3 — Mr. & Mrs. Dovie Weinschneider — 0.6862 *(Round 2: #4, 0.6915)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.937 | 0.600 | 0.351 | 0.700 (increasing) | 0.757 | 0.375 (floor 0.024) | Financial: high / Relationship: high |

**Recommendation Engine:** `honor_reminder`, 0.7575 (tactical #1).
**Attention type:** Solicit (honor scheduled commitment).

**Why he moved from #4 to #3:** his own score barely changed (0.6915 ->
0.6862); he passed Zachter because Zachter's Opportunity fell slightly
more under the corrected materiality curve (Zachter's pledge, while
large, is smaller than Weinschneider's engagement-track credit is
stable at). Not a meaningful reordering — see Section 4.

---

### #4 — Mr. & Mrs. Yaakov Zachter — 0.6640 *(Round 2: #3, 0.7149)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.903 | 0.689 | 0.452 | 0.300 (actively fulfilling) | 0.419 | 0.135 (floor 0.001) | Financial: high / Relationship: high |

**Recommendation Engine:** `relationship_opportunity`, 0.4186.
**Attention type:** Cultivate/steward (active commitment).

**Evidence:** unchanged from Round 2 — a real $18,000 pledge, 71 days
old, on-track, tied to a current, live-synthesized Relationship Fact
and a 9-day-old substantive text.

**Why his Opportunity fell (0.81 -> 0.689):** his $18,000 pledge scores
lower under the fixed absolute-dollar curve than it did under Round 2's
portfolio-relative-only curve — this is the corrected formula applying
consistently, not a defect specific to him. His Coverage is
appropriately near-zero (0.135) — he has real, current documentation, so
no coverage concern exists for him at all.

---

### #5 — Mr. & Mrs. Eitan Zeffren — 0.6290 *(Round 2: #5, 0.6320 — essentially unchanged)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.880 | 0.600 | 0.278 | 0.476 (declining) | 0.757 | 0.616 (floor 0.105) | Financial: high / Relationship: high |

**Recommendation Engine:** `honor_reminder`, 0.7575.
**Attention type:** Solicit (honor scheduled commitment).

**Unchanged in substance.** His Opportunity comes entirely from the
engagement track (an explicit scheduled ask), which Round 3 did not
touch — confirming his Round 2 result was never dependent on the
now-fixed materiality formula in the first place.

---

### #6 — Mr. & Mrs. Moishe Weber — 0.5198 *(Round 2: #6, 0.6196)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.680 | 0.583 | 0.324 | 0.300 (actively fulfilling) | 0.237 | 0.476 (floor 0.049) | Financial: high / Relationship: high |

**Recommendation Engine:** `reconnect_contact_gap`, 0.2375.
**Attention type:** Cultivate/steward (active commitment).

**Flag for human review — the one small-pledge case Round 3 did not
fully resolve.** His Opportunity fell substantially (0.826 -> 0.583,
a real, meaningful reduction) but a **$9,410 lifetime relationship
still ranks ahead of Ramras ($110,155), Goldenberg ($46,718), and
every donor Coverage surfaces.** See Section 11, Case 1.

---

### #7 — Rabbi & Mrs. Shimmy Ramras — 0.5157 *(Round 2: #8, 0.5638)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.947 | 0.210 | 0.223 | 0.583 (increasing) | 0.368 | 0.947 (floor 0.382 — not triggered) | Financial: high / Relationship: medium |

**Recommendation Engine:** `follow_up_pledge`, 0.3683.
**Attention type:** Cultivate (real growth).

**Evidence:** $110,155 lifetime, +94% YoY real growth, a small $3,600
pledge, zero interactions ever, birthday in 6 days.

**Worth noting:** his Coverage (0.947) is nearly as high as Miller's —
he too has zero documented interactions — but his real pledge activity
keeps his base score above the floor, so Coverage never surfaces for
him even though the same underlying evidence gap exists. See Section
11, Case 2.

---

### #8 — Dr. & Mrs. Mordy Goldenberg — 0.4714 *(Round 2: #7, 0.5695)*

Real ~4x YoY growth, a real interaction 17 days ago, a small $650
unpaid pledge. His Opportunity fell (0.375 -> 0.11) as the corrected
formula gives his tiny pledge much less credit. **Attention type:**
Cultivate (real growth).

---

### #9 — Mr. & Mrs. Yale Miller — 0.4446 *(Round 2: #32, 0.3991 — the headline Coverage result)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| **0.996** | 0 | 0.083 | 0.05 (noisy_swing) | 0.237 | **0.996 (floor 0.4446 — TRIGGERED)** | Financial: high / Relationship: **low** |

**Recommendation Engine:** `reconnect_contact_gap`, 0.2375, **not in the
Suggested pool.**

**Attention type: Relationship coverage needed (learn/review) — never
"solicit," never an invented opportunity.**

**Evidence:** $199,150 lifetime received — **the largest in the entire
portfolio**, 54 distinct years of activity, a historical peak gift of
$25,000. **Zero interactions ever, zero facts, zero asks.**

**Why he ranks #9:** his composite is not driven by his base score
(0.3821 — nearly identical to Round 2's 0.3991) but by the Coverage
floor (0.4446), which fires because his Financial Significance is
essentially maximal (0.996) **and** the system genuinely knows nothing
about the relationship (evidence gap = 1.0). **The explanation a
fundraiser would see is explicit: this is the portfolio's largest
relationship and Fundraising OS has no current relationship
intelligence about it — find out what's happening, do not treat this as
a solicitation cue.**

---

### #10 — Mr. & Mrs. Dovid Weinberger — 0.4399 *(Round 2: #9, 0.5535)*

A real, small ($1,800) pledge, 22 days old. His Opportunity fell (0.739
-> 0.432) under the corrected formula but remains real enough to place
him just above the Coverage-driven cluster below him. **Attention
type:** Cultivate/steward (active commitment).

---

### #11 — Dr. & Mrs. Dov Zeffren — 0.4374 *(Round 2: #14, 0.4510)*

$25,851 lifetime, zero interactions ever, real growth, a yahrtzeit in 16
days. **Attention type:** Cultivate (real growth) — see Section 11,
Case 4 for why this label is questionable for a zero-contact donor.

---

### #12 — Mr. & Mrs. Tzvi Ray — 0.4333 *(Round 2: #17, 0.4392 — score nearly unchanged, mechanism completely different)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.987 | 0 | 0.122 | 0.496 (declining) | 0.15 | **0.987 (floor 0.4333 — TRIGGERED)** | Financial: high / Relationship: **low** |

**Recommendation Engine:** `follow_up_pledge`, 0.6500 (his stale $10
balance, correctly discounted to TAC=0.15 for strategic purposes).

**Attention type: Relationship coverage needed (learn/review).**

**Evidence:** $114,026 lifetime (#3 in the portfolio), a real **-77%
YoY decline**, zero interactions ever. His trivial $10/1,914-day pledge
remains classified `immaterial_artifact`.

**Why his score barely moved despite the mechanism changing entirely:**
in Round 2 he ranked here via a mix of real FS and a modest declining-
momentum credit; in Round 3, the Coverage floor now does most of the
work, because his real decline plus total silence makes this a coverage
case, not merely a momentum case. **The correct read: a top-3 lifetime
relationship just lost most of its annual giving and nobody has talked
to them — find out why, this is not a pledge-collection problem.**

---

### #13 — Rabbi & Mrs. Yehuda Moradian — 0.4310

$37,708 lifetime, zero interactions ever, real growth. **Attention
type:** Cultivate (real growth) — same Section 11 Case 4 concern.

---

### #14 — Mr. & Mrs. Manuel Schnaidman — 0.4310 *(Round 2: #40, 0.3808 — the second headline Coverage result)*

| FS | OPP | STEW | MOM | TAC | Coverage | Confidence |
|---|---|---|---|---|---|---|
| 0.986 | 0 | 0.027 | 0.1 (stable) | 0.237 | **0.986 (floor 0.4310 — TRIGGERED)** | Financial: high / Relationship: **medium** |

**Recommendation Engine:** `reconnect_contact_gap`, not in pool.
**Attention type: Relationship coverage needed (learn/review).**

**Evidence:** $158,202 lifetime — **#2 in the portfolio**, 36 distinct
years, zero interactions ever.

**This is the direct, intended fix for the exact case Round 2's own
report flagged as unresolved** ("Does the #2 lifetime relationship still
fall behind many small-pledge donors solely because of missing
documentation?" — see Round 2 Sanity Check B). He now lands at #14,
just behind the strong-active cluster and Coverage-driven Miller/Ray,
correctly framed as a coverage concern rather than an opportunity.

---

### #15 — Rabbi & Mrs. Yitzchak Sperka — 0.4299

$54,837 lifetime, 37 distinct years, zero interactions ever, real
modest growth. **Attention type:** Cultivate (real growth).

---

## 3. Ranks 16–25

| Rank | Donor | Score | Attention type | Coverage triggered? |
|---|---|---|---|---|
| 16 | Jonathan Spetner | 0.4278 | **Steward (active fulfillment)** | No (0.978 coverage, but base 0.4278 narrowly exceeds floor 0.421 — see Section 8, Sanity F) |
| 17 | Donny Wiesel | 0.4269 | Solicit (honor scheduled commitment) | No |
| 18 | Aaron Martin | 0.4238 | Cultivate (real growth) | No |
| 19 | Yaakov Milch | 0.4129 | Cultivate/steward (active commitment) | No |
| 20 | Michael J Krull | 0.4098 | Cultivate (real growth) | No |
| 21 | Eli Davis | 0.4079 | Cultivate (real growth) | No |
| 22 | David B. Rosenbaum | 0.4078 | Cultivate (real growth) | No |
| 23 | Moshe Matz | 0.4071 | Steward (active fulfillment) | No |
| 24 | Joshua Broide | 0.4064 | Learn/relationship review | No |
| 25 | Eitan Pfeiffer | 0.4022 | Cultivate (real growth) | No |

---

## 4. Round 2 → Round 3 movement (mandatory donors)

| Donor | R2 rank | R3 rank | R2 score | R3 score | Conceptual reason |
|---|---|---|---|---|---|
| Avi Stein | #1 | #1 | 0.7429 | 0.7278 | Opportunity fell modestly under the corrected, more conservative materiality curve — applies uniformly, doesn't change his relative position |
| Mordechai Schwartz | #2 | #2 | 0.7289 | 0.6992 | Same mechanism as Stein |
| Yaakov Zachter | #3 | #4 | 0.7149 | 0.6640 | His pledge ($18,000) sits in the middle of the corrected curve, so it lost more relative ground than Stein/Schwartz's larger pledges did |
| Dovie Weinschneider | #4 | #3 | 0.6915 | 0.6862 | Essentially unchanged (his score never depended on pledge materiality); passed Zachter only because Zachter fell |
| Eitan Zeffren | #5 | #5 | 0.6320 | 0.6290 | Unchanged — his Opportunity is engagement-track only, untouched by this round's changes |
| Moishe Weber | #6 | #6 | 0.6196 | 0.5198 | Meaningfully reduced but not enough to change rank — see Section 11, Case 1 |
| Dovid Weinberger | #9 | #10 | 0.5535 | 0.4399 | Small-pledge correction working as intended |
| Yaakov Milch | #10 | #19 | 0.5481 | 0.4129 | Small-pledge correction working as intended — a 9-rank drop |
| Moshe Matz | #11 | #23 | 0.5472 | 0.4071 | Same mechanism, a 12-rank drop |
| Ezra Fox | #12 | #41 | 0.4843 | 0.3656 | Same mechanism, a 29-rank drop |
| Shimmy Ramras | #8 | #7 | 0.5638 | 0.5157 | His own small pledge lost some Opportunity credit, but several small-pledge donors above him in Round 2 fell further, net effect a slight rank rise |
| Jonathan Spetner | #16 | #16 | 0.4405 | 0.4278 | Unchanged in substance — Coverage nearly but does not trigger (Sanity F) |
| Tzvi Ray | #17 | #12 | 0.4392 | 0.4333 | Score nearly identical, but the mechanism flipped from momentum-driven to Coverage-driven — see #12 detail above |
| Yale Miller | #32 | #9 | 0.3991 | 0.4446 | **The direct, intended effect of the Coverage floor** |
| Manuel Schnaidman | #40 | #14 | 0.3808 | 0.4310 | Same — the direct, intended effect of Coverage |
| Nachum Rosenberg | #29 | #29 | 0.4117 | 0.3894 | Coverage does not trigger for him (he has one documented interaction, unlike Miller/Schnaidman/Ray) — correctly unchanged in kind, modestly lower in score from the same STEW/OPP corrections affecting everyone |
| Mayer Simcha Klein | #57 | #55 | 0.3426 | 0.3354 | Essentially unchanged — Coverage is exactly 0 for him (full documentation: an interaction, a fact, and an ask all on file), confirming the closed-loop finding from prior rounds still holds |

**No movement above is "good" or "bad" in itself** — Zachter's drop and
Weinschneider's rise are both artifacts of the same formula correction
applied uniformly; Miller/Schnaidman's rise is the intended new
mechanism; Milch/Matz/Fox's drops are the intended correction.

---

## 5. Opportunity magnitude redesign

**Problem (Round 2):** the shared `materiality()` helper combined a
log-scale term anchored to *whatever the portfolio's own largest pledge
happened to be* with a portfolio-percentile term computed against a
distribution dominated by small pledges — both effects compressed the
difference between a $1,500 pledge and a $75,000 pledge far more than
their 50x dollar difference warranted.

**Fix:** replaced the log-scale term with one anchored to **fixed,
real-dollar brackets** ($500 = negligible / $100,000 = maximal),
independent of this portfolio's current largest pledge. Re-weighted the
blend so the fixed absolute term dominates (0.70), with portfolio
percentile (0.15) and donor-relative size (0.15) as bounded secondary
inputs — per instruction, donor-relative significance can no longer
overwhelm absolute significance.

```
absoluteMateriality(amount) = clamp((log10(amount) - log10(500)) / (log10(100000) - log10(500)), 0, 1)
materiality(amount, ownPeak) = 0.70 × absoluteMateriality(amount) + 0.15 × portfolioPercentile(amount) + 0.15 × min(1, amount/ownPeak)
```

### Absolute dollar sensitivity (own-peak case — isolates the curve itself)

| Amount | Absolute term | Portfolio percentile | Donor-relative | **Materiality** |
|---|---|---|---|---|
| $500 | 0.000 | 0.793 | 1.000 | **0.269** |
| $1,000 | 0.131 | 0.895 | 1.000 | **0.376** |
| $2,500 | 0.304 | 0.953 | 1.000 | **0.506** |
| $5,000 | 0.435 | 0.980 | 1.000 | **0.601** |
| $10,000 | 0.565 | 0.992 | 1.000 | **0.695** |
| $18,000 | 0.676 | 0.997 | 1.000 | **0.773** |
| $36,000 | 0.807 | 1.000 | 1.000 | **0.865** |
| $75,000 | 0.946 | 1.000 | 1.000 | **0.962** |
| $100,000 | 1.000 | 1.000 | 1.000 | **1.000** |

**This is a monotonic, continuous, no-cliff curve that now genuinely
separates the tiers**: $500-$2,500 (trivial-to-modest, 0.27-0.51),
$5,000-$18,000 (real but mid-sized, 0.60-0.77), $36,000+ (major,
0.87-1.0). Compare to Round 2's equivalent curve, which put a $1,500
pledge around 0.65-0.75 — this round's $1,000-$2,500 band sits at
0.38-0.51, a real, visible correction.

### Donor-relative sensitivity

| Case | Materiality | What changed and why |
|---|---|---|
| A: $5,000 pledge / $7,500 lifetime (peak ~$7,500) | **0.551** | Higher — this $5,000 is nearly this donor's entire history |
| B: $5,000 pledge / $100,000 lifetime (peak ~$20,000) | **0.489** | Lower — the identical dollar amount is proportionally smaller for this donor, but the gap (0.551 vs 0.489, a 0.062 difference) is bounded, never dominant, because donor-relative is only 15% of the formula |
| C: $25,000 pledge / $30,000 lifetime (peak ~$25,000) | **0.817** | Both a large absolute amount AND this donor's own peak |
| D: $25,000 pledge / $250,000 lifetime (peak ~$50,000) | **0.742** | Same real dollar amount scores slightly lower for the larger-history donor, again a bounded (0.075) difference — the $25,000 itself remains solidly "material" regardless of context, exactly the intended behavior |

**Confirms the intended principle:** donor-relative context matters and
visibly shifts the score, but never by more than roughly ±0.06-0.08 —
it can nudge, never overwhelm, the absolute-dollar read.

---

## 6. Relationship Coverage design

**What it answers:** "Given how important this relationship is, do we
currently know enough to manage it responsibly?" — explicitly **not**
"is there a solicitation opportunity" and **not** "is this relationship
weak."

```
knowledgeScore = 0.30×(any interaction ever) + 0.25×(any current Relationship Fact)
               + 0.15×(any Ask history) + 0.30×(substantive contact within 365 days)
evidenceGap = 1 − knowledgeScore
Coverage = FinancialSignificance × evidenceGap
```

**Why multiplicative, not additive:** a low-FS donor's Coverage is
automatically near zero regardless of how little is documented about
them — nobody needs a "coverage" flag for a $500 lifetime donor with no
interactions. Coverage can never exceed FS itself; it is a *conditional*
read on FS, not a second, independent bonus stacked next to it. This is
the direct answer to the item-8 double-counting concern: Coverage and
Financial Significance are mathematically coupled by construction, not
merely correlated by coincidence.

**Real-donor evidence for the multiplicative design:** Nachum Rosenberg
(FS=0.983) has one documented broadcast interaction, which alone drops
his knowledgeScore to 0.3 and his Coverage to 0.688 — meaningfully lower
than Miller/Schnaidman/Ray's 0.986-0.996 (all three have absolutely
zero interaction, fact, or ask evidence of any kind). The formula
correctly distinguishes "truly zero visibility" from "thin but
present" documentation using real, already-collected evidence, with no
new data required.

---

## 7. Component vs. floor comparison (Option A vs. Option B)

**Option A tested (not adopted):** add Coverage as a seventh weighted
composite term, e.g. `+0.15×Coverage`, rescaling other weights down.
Modeled against real data: at a 0.15 weight, Miller's Coverage (0.996)
would add ~0.149 directly on top of his base composite (~0.38),
producing ~0.53 — **higher than Weinschneider (0.686) is not reached,
but higher than Zachter's post-correction 0.664 would require careful
rebalancing to avoid**, and at any meaningfully higher weight, Coverage
would risk pushing a totally silent, totally inactive relationship
(Miller) above donors with real, current, active fundraising evidence
(Zachter, Weinschneider) — the exact outcome the instructions warned
against ("without being artificially promoted above genuinely active
major opportunities").

**Option B (adopted):** a floor, `max(baseComposite, coverageFloor)`,
with `coverageFloor = 0.45 × Coverage³`. Real-donor behavior:
- For Miller/Schnaidman/Ray (base composite far below the floor), the
  floor determines their rank entirely — Coverage does its job.
- For Schwartz/Ramras/Stein (base composite already well above any
  possible floor value, since the floor's own ceiling is 0.45 and their
  base scores are 0.52-0.70), Coverage computes a real, sometimes very
  high number (Schwartz: 0.969) but has **zero effect** — it never
  competes with genuine active evidence.
- The cubic exponent keeps the floor negligible except when Coverage is
  genuinely close to 1.0 (both maximal FS and near-total silence) —
  continuous, no cliff, consistent with the instruction's stated
  preference throughout this calibration series.

**Verdict: Option B produces more sensible fundraising behavior.** It
guarantees consideration for the most significant, least-visible
relationships without ever letting silence outrank real activity — which
is precisely the distinction the instructions asked this round to
draw (Section 10: "focus ≠ solicitation," and by extension, "focus ≠
whichever relationship we happen to know least about").

---

## 8. Regression confirmation (Round 2 requirements, Section 1)

| Requirement | Status | Evidence |
|---|---|---|
| Stein vs. Schwartz on real evidence, not missing-contact bonus | ✅ Held | Neither donor's score depends on contact absence anywhere in the formula; Stein's higher Opportunity/Stewardship (0.930/0.518 vs 0.723/0.253) reflects his larger, actively-fulfilled pledge |
| Weinschneider registers without a pledge | ✅ Held | Opportunity 0.600, entirely from the engagement track, zero dollar commitment |
| Zeffren registers despite outright-gift-only giving | ✅ Held | FS=0.880 (unaffected by lack of a pledge); Opportunity 0.600 from the engagement track |
| FS pledge-independent | ✅ Held | Miller (FS=0.996) and Schnaidman (FS=0.986) — both zero-pledge donors — sit at the top of the entire portfolio's FS distribution |
| Ancient balances neutralized | ✅ Held | Pollack #59, Schabes #95, Myers #67, Sobol #151, Chapman #187 — all `immaterial_artifact`, TAC capped at 0.15 |
| Spetner: actively fulfilling, not lapsed/new | ✅ Held | Momentum=`actively_fulfilling_commitment`; Opportunity=0.05 (near-zero, correctly not "new"); ranked #16 for stewardship reasons only |
| RI no independent bonus | ✅ Held | No RI term exists in the Round 3 formula at all |
| Momentum materiality/noise protection | ✅ Held | Miller still `noisy_swing` (0.05), not a false "increasing" |
| Missing relationship data ≠ positive Opportunity evidence | ✅ Held | Verified directly: Miller/Schnaidman/Ray's Opportunity is exactly 0, not boosted by their total silence |
| Recommendation Engine unchanged | ✅ Held | Zero modifications; Portfolio Focus only discounts its own strategic *consumption* of `follow_up_pledge` scores on stale balances, exactly as in Round 2 |

**Spetner full regression (item 15):** $12,000 pledge, created 336 days
ago (a genuine past date), 83% paid ($10,000), $2,000 remaining, most
recent payment 11 days ago, on-track plan. `Momentum:
actively_fulfilling_commitment`. `Opportunity: 0.05` (near-zero — his
commitment is not new). **No false "lapsed" interpretation. No false
"new opportunity" interpretation.** Current data is unchanged from
Rounds 1 and 2 — no drift to document.

---

## 9. Remaining questionable cases (new to Round 3, disclosed not fixed)

**1. Moishe Weber (#6) remains partially overpromoted.** His Opportunity
fell from 0.826 to 0.583 — a real, meaningful correction — but a $9,410
lifetime relationship still outranks Ramras ($110,155), Goldenberg
($46,718), and the entire Coverage-driven cluster. His pledge ($5,000,
75% paid, on-track) is genuinely real and genuinely his own historical
peak, which the formula correctly rewards — the residual overcredit is
smaller than Round 2's but not eliminated.

**2. Coverage as a pure floor cannot surface for financially-active
donors, even when their relationship documentation is equally thin.**
Shimmy Ramras's Coverage (0.947) is nearly as high as Miller's (0.996)
— he too has zero interactions, zero facts, zero asks — but his real
$3,600 pledge keeps his base score (0.5157) comfortably above the floor
(0.382), so no coverage concern ever surfaces for him. This is not
necessarily wrong (Ramras genuinely has more going on than Miller does),
but it means a fundraiser reading only the "attention type" label would
never learn that Ramras, too, has essentially no documented relationship
history — that fact is visible only in his confidence label
("Financial: high, Relationship: medium"), not in his headline
attention type.

**3. An attention-type labeling ordering issue.** Several zero-contact,
FS>0.6, `increasing`-momentum donors (Dov Zeffren, Yehuda Moradian,
Aaron Martin, Michael Krull, Eli Davis, David B. Rosenbaum, Eitan
Pfeiffer — roughly a third of ranks 11-25) are labeled **"Cultivate
(real growth)."** "Cultivate" implies an existing relationship thread to
build on; none of these donors has any documented relationship at all.
The attention-type decision tree checks `momentumLabel === "increasing"`
before it checks `FS > 0.6` (which would route to "Learn/relationship
review"), so a zero-contact donor with real growth gets the wrong verb.
**This is a small, mechanical labeling-order fix, not a scoring
problem** — the underlying composite score and rank for these donors is
not in question, only the word used to describe what to do about them.

**4. Recent commitments still touch three components at once for the
same underlying event (Stein/Schwartz/Zachter).** A single pledge
continues to inform Opportunity (is it a chance to grow the
relationship), Stewardship (does it need active care), and Momentum
(via the `actively_fulfilling_commitment` override when on-track) —
carried forward unchanged from Round 2, where this was reviewed and
judged legitimate overlap (three genuinely different fundraising
questions about the same real event) rather than double-counting. Not
re-litigated this round; named here only because item 19 asks whether it
recurs — it does, unchanged, and the Round 2 justification still holds
on inspection.

**5. Momentum-on-a-small-base can still outrank a larger, flat
relationship.** Nachum Rosenberg ($107,616 lifetime, `stable` momentum,
rank #29) sits behind Eli Davis ($20,616, rank #21) and David B.
Rosenbaum ($19,620, rank #22) — both roughly 5x smaller — purely because
Davis and Rosenbaum each have a real percentage increase off a small
base while Rosenberg's giving is merely steady. This is the same
Round-1/Round-2 tension (a meaningful percentage swing on a small
relationship can outweigh flat consistency on a large one) recurring in
a new pairing; the materiality-gating fix from Round 2 prevents *noise*
from creating false momentum, but does not prevent *real, if modest*,
momentum from outweighing size — this may or may not be the right
tradeoff, and is named for judgment rather than resolved here.

---

## 10. Implementation-readiness recommendation

**B — READY WITH ONE SMALL, SPECIFIC ADJUSTMENT.**

Both of this round's primary questions were answered with a defensible,
tested, minimal-footprint mechanism: the Opportunity/Stewardship
materiality formula now uses fixed real-dollar brackets instead of a
portfolio-relative scale, and Relationship Coverage — implemented as a
non-competing floor, chosen over an additive component after comparing
both against real donor data — successfully surfaces Miller, Schnaidman,
and Ray with an honest "needs relationship review" framing rather than
inventing an opportunity. Every Round 2 regression requirement held.
All five stale-balance controls and the Spetner regression held with
zero drift.

**The one specific adjustment:** fix the attention-type decision tree's
ordering (Section 9, Case 3) so a donor with zero documented interaction
of any kind is labeled "Learn/relationship review" rather than
"Cultivate (real growth)," regardless of whether their Momentum happens
to be increasing. This is a labeling fix inside the reporting/
explainability layer, not a change to any score, rank, or weight — it
can be made and verified in the same implementation pass that builds
the read-only computation module, without requiring another calibration
round.

**Not blocking, to monitor during implementation:** Weber's residual
elevation (Case 1) and the Coverage-floor-vs-active-donor tension (Case
2) are real, disclosed, and worth watching once real fundraiser usage
exists, but neither represents a conceptual defect requiring a redesign
— both are calibration questions (is 0.45 the right Coverage ceiling?
should Ramras's thin documentation be separately flagged despite his
real pledge?) suitable for the calibration-pass step already planned in
the staged implementation plan (Portfolio Focus Investigation, Section
16, Step 1).

---

## 11. Exact frozen Round 3 formula

**Unchanged from Round 2** (regression requirements, Section 1): the
financial reconstruction, verification gates, Financial Significance,
Momentum, Tactical Urgency (including the stale-balance discount), and
the stale-balance classifier itself.

**Changed — the shared materiality function** (feeds both Opportunity's
financial track and Stewardship's event track):
```
absoluteMateriality(amountCents) = clamp(
  (log10(amountCents/100) - log10(500)) / (log10(100000) - log10(500)), 0, 1
)
materiality(amountCents, ownPeakCents) =
  0.70 × absoluteMateriality(amountCents)
+ 0.15 × portfolioPercentile(amountCents, allFinancialEventAmounts)
+ 0.15 × min(1, amountCents / ownPeakCents)
```

**New — Relationship Coverage:**
```
knowledgeScore = 0.30×hasAnyInteractionEver + 0.25×hasCurrentFact
               + 0.15×hasAskHistory + 0.30×hasSubstantiveContactWithin365Days
evidenceGap = 1 − knowledgeScore
Coverage = FinancialSignificance × evidenceGap
coverageFloor = 0.45 × Coverage³
```

**Composite (frozen before this run):**
```
baseComposite = 0.35×FS + 0.30×OPP + 0.20×STEW + 0.10×MOM + 0.05×TAC   [UNCHANGED weights from Round 2]
Composite = max(baseComposite, coverageFloor)
```

**No weight was changed from Round 2.** Coverage's floor mechanism
required no weight parameter at all — it operates entirely outside the
five-way weighted split, per the instruction to attempt a definitional
fix before considering any weight change.

---

**Stopping for review. No weight or component definition was adjusted
after seeing this ranking. No implementation, code, schema, or
Recommendation Engine change was made. Do not proceed to implementation
without further instruction, even though this round's recommendation is
"ready with one small adjustment."**
