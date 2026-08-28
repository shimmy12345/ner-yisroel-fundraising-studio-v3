# Portfolio Focus — Human Calibration Round 2 (2026-08-28)

**Purpose:** Round 1 (`docs/PORTFOLIO-FOCUS-CALIBRATION.md`) exposed real
structural weaknesses in the proposed scoring model — not weighting
problems, but problems in what the components *meant*. This round
**redesigns the component definitions first**, freezes the resulting
formula in writing, runs it once against current Independent Staging
data, and reports the raw result honestly — including where the redesign
introduces *new* problems. No weight was tuned to move a named donor
toward an expected position.

**Status:** investigation/calibration only. No code, schema, UI, or
Recommendation Engine change. No D1 write of any kind. Read-only.

---

## 1. Executive findings

- **All financial-model verification gates passed**, including a fresh
  Jonathan Spetner regression check. The underlying data is unchanged
  from Round 1 (248 donors, $3,470,745.30 lifetime).
- **The Round 2 Top 15 differs materially from Round 1's**, and for
  defensible reasons this time: **Avi Stein now ranks #1** (was #4),
  **Mordechai Schwartz #2** (was #3), **Yaakov Zachter #3** (was #1),
  **Dovie Weinschneider #4** (was #11) — a much more coherent top of the
  list than Round 1 produced.
- **All five mandatory stale-balance regression cases (Pollack, Schabes,
  Myers, Chapman, Sobol) were successfully neutralized** by the new
  staleness gate — each now classified `immaterial_artifact`, each with
  its Tactical Urgency contribution capped, each ranked well outside the
  top 15 (ranks 70, 110, 75, 189, 156 respectively). Tzvi Ray's
  previously-flagged trivial $10 balance is **also** now correctly
  caught by the same gate, even though he wasn't one of the five named
  cases.
- **The Schwartz-vs-Stein "missing contact = opportunity" inversion is
  gone.** Stein now correctly outranks Schwartz on real financial/
  stewardship grounds (a larger, actively-fulfilled pledge), not because
  he has less documented contact.
- **Yale Miller and Manuel Schnaidman's Financial Significance scores
  are now genuinely close to the maximum possible** (0.996 and 0.986)
  — the redesign fixed the concern that their size wasn't being
  registered. They still land outside a top-15/20 view (#32, #40)
  because literally every other component is zero for lack of any
  current activity, plan, contact, or reminder. **This is now an honest,
  traceable outcome, not an artifact of a flawed component** — but it is
  a real result worth your judgment (Sanity Check A/B, below).
- **A new problem surfaced that Round 1 did not have**: several very
  small relationships (Yaakov Milch, $6,297 lifetime; Moshe Matz, $6,620;
  Dovid Weinberger, $12,872) now rank in the **top 12**, ahead of
  Rosenberg, Klein, and dozens of larger relationships, because a small
  ($400-$1,800) on-track pledge still scores surprisingly high on
  Opportunity under the redesigned materiality formula. This is disclosed
  in full in Section 7 — it was not tuned away.
- **Recommendation on implementation readiness: not yet.** The
  structural fixes this round targeted are real and verified working.
  The small-pledge overcrediting problem (Section 7, Case 1) and the
  large-quiet-donor floor question (Sanity Check A) both need a human
  decision before this is ready to become application code.

---

## 2. Round 2 — Top 15, raw and unedited

Composite: `0.35·FS + 0.30·OPP + 0.20·STEW + 0.10·MOM + 0.05·TAC`
(Relationship Intelligence is no longer an independent weighted term —
see Section 8.)

### #1 — Dr. & Mrs. Avi Stein — 0.7429 *(Round 1: #4, 0.542)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| 0.866 | **0.967** | 0.538 | 0.300 (actively fulfilling) | 0.237 | Financial: high / Relationship: high |

**Recommendation Engine:** `reconnect_contact_gap`, 0.2375 (correctly
quiet — his plan is on-track).

**Evidence:** $71,332 lifetime received, 3 distinct years of activity. A
real **$75,000 pledge**, ~12 days old by its real recency (his pledge
row's own database date is 2029 and unusable — independently reconciled
against the live donor page in the original investigation), 11% paid,
on-track. This is also his historical-peak commitment. Only one
broadcast text on file; no one-on-one contact ever.

**Why he ranks #1:** the largest live financial event in the portfolio,
scored on its own real merits — size, recency, and active fulfillment —
with **no credit at all for his lack of documented contact** (the exact
mechanism removed this round). **Attention type: steward/cultivate** —
acknowledge the commitment; the plan needs no payment nudge.

---

### #2 — Mr. & Mrs. Mordechai Schwartz — 0.7289 *(Round 1: #3, 0.6001)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| **0.969** | 0.803 | 0.281 | 0.700 (increasing) | 0.450 | Financial: high / Relationship: medium |

**Recommendation Engine:** `follow_up_pledge`, 0.4500.

**Evidence:** $101,885 lifetime, 23 distinct years of activity. A real
**$36,000 open pledge, 60 days old, $0 paid yet.** +175% YoY cash growth.
Zero interactions ever.

**Why he ranks #2, and why his Stewardship (0.281) is lower than
Stein's (0.538) despite a real, large pledge:** Stewardship's biggest
lever is *active fulfillment* — an on-track payment plan, which
Schwartz's pledge does not have (nothing has been paid yet). His 0.281
comes entirely from the "a significant financial event just happened"
term, materiality-scaled and recency-decayed, with **no bonus and no
penalty for having zero contact.** **Attention type:** cultivate the
relationship behind the pledge; this is now a real, well-evidenced
signal, not a missing-data artifact.

---

### #3 — Mr. & Mrs. Yaakov Zachter — 0.7149 *(Round 1: #1, 0.6243)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| 0.903 | 0.810 | 0.525 | 0.300 (actively fulfilling) | 0.419 | Financial: high / Relationship: high |

**Recommendation Engine:** `relationship_opportunity`, 0.4186.

**Evidence:** $45,400 lifetime, 10 distinct years of activity. A real
**$18,000 pledge, 71 days old**, 25% paid, on-track. A real, current
Relationship Fact and a substantive text 9 days ago, describing the same
event.

**Why he moved from #1 to #3, and why this is not a demotion in
substance:** his composite score actually **rose** (0.6243 -> 0.7149).
Relationship Intelligence is no longer counted as an independent term
(Section 8), so the 0.8-weighted RI credit he uniquely had in Round 1 is
gone — but his Opportunity (0.5 -> 0.81) and Stewardship (0.4 -> 0.525)
both grew under the redesigned, more generous-but-defensible materiality
formulas, driven by the same real pledge and real contact, independent
of any fact-based bonus. **He remains strong for genuinely independent
financial and relationship reasons — see Sanity Check G.** **Attention
type:** cultivate — continue the relationship on the strength already
documented.

---

### #4 — Mr. & Mrs. Dovie Weinschneider — 0.6915 *(Round 1: #11, 0.425)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| 0.937 | **0.600** | 0.378 | 0.700 (increasing) | **0.757** | Financial: high / Relationship: high |

**Recommendation Engine:** `honor_reminder`, 0.7575 (tactical #1 in the
portfolio).

**Evidence:** $89,931 lifetime, 12 distinct years. +38x YoY dated cash
growth ($23,500 vs. $610). A real, substantive conversation 10 days ago
("Discussed Kollel donation and said to follow up after succos"), with
an **explicit fundraiser-created follow-up already scheduled.** No
pledge at all.

**Why he moved from #11 to #4 — this is the item-8 fix working as
intended:** his Opportunity score is a full 0.6, generated entirely by
the new engagement track (an explicit open reminder), with **zero
dollar commitment on file.** This is the general "a live, warm
opportunity exists even without money committed" mechanic, not a
special rule — the same mechanic independently produces Zeffren's #5
rank below. **Attention type: solicit** — honor the "after Succos"
commitment on schedule; the system now agrees with itself.

---

### #5 — Mr. & Mrs. Eitan Zeffren — 0.6320 *(Round 1: #8, 0.4486)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| 0.880 | 0.600 | 0.293 | 0.476 (declining) | 0.757 | Financial: high / Relationship: high |

**Recommendation Engine:** `honor_reminder`, 0.7575.

**Evidence:** $56,920 lifetime. A real **-50% YoY decline** ($18,000 vs.
$36,000). **An explicit "Solicit corporate sponsorship for dinner"
reminder already scheduled.** No pledge — all his giving is outright
gifts.

**Why he ranks here — the item-3 fix visible in a second case:** his
Financial Significance (0.880) is no longer capped by "does he currently
have a pledge" (Round 1 penalized him for this specifically). His
Opportunity again comes from the engagement track, exactly as
Weinschneider's does. **Attention type: solicit** — execute the
scheduled ask; the real decline is worth a private note on sizing.

---

### #6 — Mr. & Mrs. Moishe Weber — 0.6196 *(Round 1: #7, 0.4689 — largely unchanged rank, worth scrutiny)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| 0.680 | **0.826** | 0.459 | 0.300 (actively fulfilling) | 0.237 | Financial: high / Relationship: high |

**Recommendation Engine:** `reconnect_contact_gap`, 0.2375.

**Evidence:** $9,410 lifetime — modest. A **$5,000 pledge**, 75% paid,
on-track.

**Flag for human review:** his lifetime giving is a small fraction of
several donors ranked below him (Ramras: $110,155; Spetner: $100,361).
His Opportunity score (0.826) is nearly as high as Stein's (0.967)
despite a 15x smaller pledge. See Section 7, Case 1 — this is the
clearest **remaining** failure mode this round did not fully solve.

---

### #7 — Dr. & Mrs. Mordy Goldenberg — 0.5695 *(Round 1: #2, 0.6078)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| 0.895 | 0.375 | 0.231 | 0.700 (increasing) | 0.548 | Financial: high / Relationship: high |

**Recommendation Engine:** `follow_up_pledge`, 0.5483.

**Evidence:** $46,718 lifetime, real ~4x YoY growth, a real interaction
17 days ago, a small ($650) unpaid pledge.

**Why he dropped from #2 to #7:** his Opportunity score fell (0.5 ->
0.375) because his $650 pledge is genuinely tiny and the redesigned
materiality formula, while imperfect (Section 7), still scores it well
below Stein/Schwartz/Zachter's much larger commitments. **Attention
type:** cultivate the real growth trend.

---

### #8 — Rabbi & Mrs. Shimmy Ramras — 0.5638 *(Round 1: #5, 0.5154)*

| FS | OPP | STEW | MOM | TAC | Confidence |
|---|---|---|---|---|---|
| **0.947** | 0.340 | 0.269 | 0.583 (increasing) | 0.368 | Financial: high / Relationship: medium |

**Recommendation Engine:** `follow_up_pledge`, 0.3683.

**Evidence:** $110,155 lifetime, +94% YoY real growth, zero interactions
ever, birthday in 6 days.

**Attention type:** cultivate/learn — a top-ten lifetime relationship
with confirmed real growth and no documented relationship history.

---

### #9-11 — Dovid Weinberger (0.5535), Yaakov Milch (0.5481), Moshe Matz (0.5472)

**Flag for human review — all three are new to any top-15 view and
share the same pattern:** small lifetime totals ($12,872 / $6,297 /
$6,620) with a small ($400-$1,800) on-track pledge driving Opportunity
scores of 0.74/0.75/0.73 — nearly as high as Stein's 0.967. **This is
the single most important finding of Round 2's own critique** (Section
7, Case 1) — the materiality formula's log-scale and portfolio-percentile
terms do not separate a $1,500 pledge from a $75,000 one nearly as much
as their 50x dollar difference would suggest, because most financial
events in this portfolio are themselves small. **Recommendation
Engine:** `follow_up_pledge`/`reconnect_contact_gap` at the generic
floor for all three. **Attention type: unclear — see Section 7.** These
are presented exactly as computed, not removed, per instruction.

---

### #12-15 — Dr. Ezra Fox (0.4843), Yitzchak Sperka (0.4516), Dov Zeffren (0.4510), Yehuda Moradian (0.4437)

- **Ezra Fox** ($4,508 lifetime): the same small-pledge pattern as #9-11.
- **Yitzchak Sperka** ($54,837 lifetime, 37 distinct years of activity,
  zero interactions ever, a real but modest YoY increase): **attention
  type: learn/research** — a genuinely large, long-tenured, completely
  undocumented relationship.
- **Dov Zeffren** ($25,851 lifetime, zero interactions ever, real growth,
  a yahrtzeit in 16 days): **attention type: learn/cultivate.**
- **Yehuda Moradian** ($37,708 lifetime, zero interactions ever, real
  growth, a birthday in 22 days): **attention type: learn/cultivate.**

**Pattern across all four:** large-to-mid lifetime relationships, zero
documented interaction of any kind, a real but not dramatic recent
increase, landing in the top 15 primarily on Financial Significance plus
a modest Momentum contribution. **Confidence is Low or Medium on the
relationship axis for all four** — flagged, not hidden (see Section 5).

---

## 3. Ranks 16–25

| Rank | Donor | Score | Stale class | Attention type | Primary reason | Notes |
|---|---|---|---|---|---|---|
| 16 | Jonathan Spetner | 0.4405 | current | **Steward only** | 83%-complete on-track pledge, zero interactions ever | Confirmed correctly NOT lapsed/urgent — see Sanity Check F |
| 17 | Tzvi Ray | 0.4392 | **immaterial_artifact** | Reconnect/learn | Real -77% YoY decline on a #3-lifetime relationship | His $10/1,914-day balance is now correctly neutralized (TAC capped 0.65->0.15) |
| 18 | Aaron Martin | 0.4355 | — | Cultivate | $44,921 lifetime, real growth, zero interactions | |
| 19 | Donny Wiesel | 0.4348 | — | Solicit | Explicit `honor_reminder` on a $3,600 lifetime relationship | See Section 7, Case 5 |
| 20 | Dovi Weill | 0.4304 | current | Steward | Small on-track pledge, birthday in 12 days | |
| 21 | Joshua Broide | 0.4294 | current | Reconnect | $2,500 pledge, 290 days old, giving stopped this year | Not yet stale-classified (under the 2-year mark) |
| 22 | Michael J Krull | 0.4279 | — | Learn/cultivate | $51,255 lifetime, real growth, zero interactions | |
| 23 | David B. Rosenbaum | 0.4270 | — | Cultivate | $19,620 lifetime, real growth, zero interactions | |
| 24 | Yaakov Dov Cohen | 0.4260 | current | (Thin — see Section 7) | Tiny ($600) on-track pledge | Same small-pledge pattern as #9-11 |
| 25 | Max Singer | 0.4222 | current | (Thin — see Section 7) | Small ($1,000) on-track pledge | Same pattern |

---

## 4. Round 1 → Round 2 movement (mandatory donors)

| Donor | R1 rank | R2 rank | Movement | Underlying conceptual reason |
|---|---|---|---|---|
| Yaakov Zachter | #1 | #3 | -2 | RI removed as an independent term; his OPP/STEW grew under the new definitions from the SAME real evidence, netting a HIGHER composite score despite the rank slipping past two donors whose scores grew even faster |
| Mordy Goldenberg | #2 | #7 | -5 | His pledge is genuinely tiny ($650) — the redesigned Opportunity formula, despite still being generous to small pledges (Section 7), gives him noticeably less credit than Round 1's percentile-cliff did |
| Mordechai Schwartz | #3 | #2 | +1 | Stewardship redefinition (item 7) gave him a real, non-zero score (0 -> 0.281) for the first time, on top of an already-high FS |
| Avi Stein | #4 | #1 | +3 | Financial Significance redesign (item 3) now correctly weighs his real magnitude without being dragged down by a smaller lifetime total relative to Schwartz; Opportunity redesign (item 6) gives his $75,000 pledge substantially more credit than Round 1's flatter percentile gate did |
| Shimmy Ramras | #5 | #8 | -3 | His pledge is small (item 6 correctly gives it modest credit); several donors with fresh, large, well-evidenced pledges (Stein, Schwartz, Zachter) or explicit reminders (Weinschneider, Zeffren) moved up past him |
| Jonathan Spetner | #6 | #16 | -10 | **This is the redesign working as intended, not a demotion of a mistake.** His Opportunity fell (0.15 -> 0.064) because his pledge's real commitment date (336 days) now correctly excludes him from any "new commitment" credit; his Stewardship also fell (0.4 -> 0.185) because Stewardship no longer gives blanket credit for "has an on-track plan" alone -- it requires either a genuinely recent event or the plan's own size to be materially large, and his plan's *remaining* balance ($2,000) is small relative to his own peak |
| Moishe Weber | #7 | #6 | +1 | Essentially unchanged in substance — still the clearest remaining small-pledge-overcredit case (Section 7, Case 1) |
| Dovi Weill | #9 | #20 | -11 | Same mechanism as Ramras/Goldenberg — his small pledge earns proportionally less under the redesigned formula once larger, better-evidenced commitments are scored on the same continuous scale |
| Yaakov Pollack | #10 | #70 | **-60** | **The stale-balance gate (item 5) working exactly as designed.** His $60/27.7-year balance is now classified `immaterial_artifact`; both his Opportunity contribution and his Tactical Urgency contribution (0.65 -> 0.15, strategically) are zeroed/capped |
| Dovie Weinschneider | #11 | #4 | +7 | The item-8 engagement-opportunity mechanic directly credits his real conversation + explicit next step for the first time, independent of the fact he has no pledge |
| Yale Miller | #25 | #32 | -7 | His Financial Significance rose sharply (0.7 -> 0.996) — the redesign fixed the underlying concern — but his Momentum was correctly relabeled from a false-positive "increasing" to "noisy_swing" (item 9), and every other component remains genuinely zero for lack of any activity, so his composite moved only slightly and his RANK slipped as other donors' scores rose faster around him |
| Manuel Schnaidman | #48 | #40 | +8 | Same FS fix as Miller; his rank rose modestly as several Round-1-inflated small-pledge donors (Weber's neighbors) didn't move as far up as Schwartz/Stein did |
| Tzvi Ray | #15 | #17 | -2 | Financial Significance rose sharply (0.694 -> 0.987, correctly reflecting his #3-lifetime status) but the stale-balance gate simultaneously removed his tactical-score contribution (0.65 -> 0.15) that Round 1 had let inflate him for the wrong reason — the net effect is nearly a wash, landing him at almost the same rank for entirely different, now-correct reasons |
| Nachum Rosenberg | #82 | #29 | +53 | The Financial Significance redesign is the direct cause — his $107,616 lifetime and multi-year history are now fully credited (FS 0.689 -> 0.983) with no pledge-status penalty at all |
| Mayer Simcha Klein | #80 | #57 | +23 | Same FS mechanism; Klein still correctly shows no Opportunity or urgent Stewardship signal — the closed-loop finding from the original investigation (his stale-Ask-narrative risk is fixed, nothing left to flag) still holds |

**Do not read "moved up" as "better" uniformly.** Zachter's rank fell
while his real evidence and score both improved. Pollack's rank
collapsed because a genuine defect was fixed. Both are correct outcomes
under the new definitions, for opposite-looking reasons.

---

## 5. Mandatory sanity checks

**A. Yale Miller.** Does the portfolio's #1 lifetime relationship still
land outside the meaningful strategic-focus range? **Yes — rank #32,
composite 0.3991.** But the *reason* has fundamentally changed: his
Financial Significance (0.996) is now essentially maximal, correctly
reflecting his stature. He lands outside the top 15-20 solely because
every other component (Opportunity, Stewardship, Momentum-beyond-noise,
Tactical) is genuinely zero or near-zero — there is no pledge, no
interaction, no fact, no reminder, and no real recent dollar swing once
noise is filtered out. **This is now an honest result, not an artifact.**
Whether a 0.35 weight on Financial Significance is enough to guarantee
the portfolio's single largest relationship a top-15 slot regardless of
current activity is a real, unresolved policy question for your
judgment — this round did not decide it either way.

**B. Manuel Schnaidman.** Does the #2 lifetime relationship still fall
behind many small-pledge donors solely because of missing
documentation? **Partially, and this is worth your attention.** His FS
(0.986) is now correctly near-maximal and no longer penalized for
lacking a pledge. He still ranks #40 — behind Milch ($6,297 lifetime,
#10), Matz ($6,620, #11), and others — because those donors' small
pledges earn real (if arguably oversized) Opportunity/Stewardship
credit that Schnaidman, with zero current activity of any kind, cannot
earn under any component. **This is the direct, visible consequence of
Section 7 Case 1** — it is not "missing documentation" being punished
directly, but a genuine formula interaction worth scrutinizing.

**C. Avi Stein vs. Mordechai Schwartz.** Is their ordering now driven
by meaningful financial/stewardship evidence rather than a bonus for
missing interactions? **Yes, confirmed directly.** Stein's Opportunity
(0.967) and Stewardship (0.538) both exceed Schwartz's (0.803 / 0.281)
because Stein's pledge is larger AND actively being fulfilled (an
on-track plan), not because he has more or less documented contact —
**both donors have essentially zero real relationship documentation**
(Stein: one broadcast; Schwartz: nothing at all), and neither's score
was affected by that fact in either direction. The inversion Round 1
exhibited is gone.

**D. Weinschneider.** Does a real warm relationship + explicit next step
now register strategically without requiring a pledge? **Yes — rank #4,
Opportunity 0.600, entirely from the engagement track, with zero dollar
commitment on file.** The same mechanic independently produces Zeffren's
#5 rank, confirming this is a general concept, not a special case.

**E. Pollack / Schabes / Myers / Chapman / Sobol.** Are ancient balances
strategically neutralized while remaining untouched in the database and
tactical system? **Yes, fully confirmed.** All five are classified
`immaterial_artifact` by the new staleness gate; their Opportunity
contribution from these balances is zero; their Tactical Urgency
contribution is capped at 0.15 (down from the Recommendation Engine's
own unmodified 0.65 score). **No database value was altered** — every
balance is exactly as it was; **the Recommendation Engine itself is
unmodified** — the real tactical system would still show these as
0.65-scored `follow_up_pledge` items if you looked at Suggested Actions
directly; only Portfolio Focus's own strategic consumption of that score
is discounted.

**F. Spetner.** Is he still correctly understood as actively fulfilling
an existing commitment rather than lapsed/new opportunity? **Yes,
unambiguously.** Momentum label: `actively_fulfilling_commitment`.
Opportunity: 0.064 (deliberately near-zero — his commitment is 336 days
old, well outside any "new" window). He ranks #16 for stewardship/
documentation reasons only (a large, quietly-fulfilling relationship
with zero interactions ever), never for urgency.

**G. Zachter.** Does he remain strong for defensible independent
reasons, or did removing correlated double-counting materially change
the interpretation? **He remains strong for independent reasons, and
his actual composite score rose (0.6243 -> 0.7149) despite losing his
Round 1 Relationship Intelligence credit entirely.** His Opportunity and
Stewardship scores both grew under the redesigned formulas, driven by
the same real $18,000 on-track pledge and the same real 9-day-old
substantive contact — evidence that was always there, now counted
through cleaner, non-overlapping channels rather than being partially
re-counted via a fact-based bonus on top of it.

---

## 6. Tactical-vs-strategic disagreements

### Strategically important, tactically quiet

| Donor | Strategic rank | Tactical score | Why this is correct |
|---|---|---|---|
| Avi Stein | #1 | 0.2375 (rank #210) | On-track plan — correctly quiet tactically; strategically the largest live financial event in the portfolio |
| Mordechai Schwartz | #2 | 0.4500 (rank #27) | A real, fresh $36,000 pledge under-served by a generic tactical framing |
| Jonathan Spetner | #16 | 0.2375 (rank #208) | Correctly quiet — see Sanity Check F |
| Yale Miller | #32 | 0.2375, not in pool | See Sanity Check A |
| Manuel Schnaidman | #40 | 0.2375, not in pool | See Sanity Check B |
| Nachum Rosenberg | #29 | 0.2375 (rank #188) | A top-ten lifetime relationship the tactical engine has nothing to say about |

### Tactically urgent, strategically lower

| Donor | Tactical rank/score | Strategic rank | Stale class | Why |
|---|---|---|---|---|
| David Chapman | #5, 0.65 | #189, 0.1466 | immaterial_artifact | A $915 balance, ~24 years old |
| Aaron Bezalel Kopstick | #10, 0.65 | #135, 0.2465 | immaterial_artifact | A stale, small balance |
| Dovi Kreismann | #11, 0.65 | #188, 0.1474 | immaterial_artifact | A stale, small balance |
| Paltiel Myers | #12, 0.65 | #75, 0.3238 | immaterial_artifact | A $2,000 balance, ~9.9 years old |
| Itzik Pollak | #15, 0.65 | #233, 0.0774 | legacy_needs_verification | A $100 balance, 964 days old |
| Yaakov Pollack | #14, 0.65 | #70, 0.3285 | immaterial_artifact | A $60 balance, 27.7 years old |
| Ahron Schabes | #18, 0.65 | #110, 0.2778 | immaterial_artifact | A $10 balance, 11 years old |
| Eliave Sobol | #20, 0.65 | #156, 0.2074 | immaterial_artifact | A $25 balance, 19.8 years old |
| Tzvi Ray | #16, 0.65 | #17, 0.4392 | immaterial_artifact | Ray's strategic rank is close to his tactical rank *by coincidence* — his real -77% decline (via FS/MOM) happens to land him near the same position his (now-discounted) stale $10 balance did |

**This group is exactly what the strategic layer should suppress, and
now does** — every one of these donors' tactical score is driven by an
ancient, immaterial balance, and every one is now correctly discounted
in the strategic view while remaining fully visible (and unmodified) in
the tactical Recommendation Engine.

---

## 7. Remaining and new questionable cases

**These are disclosed, not defended, per instruction.**

**1. Small pledges still earn Opportunity scores too close to major
commitments (Milch, Matz, Weber, Fox, Cohen, Singer).** This is the
central unresolved problem of Round 2. A $1,500 pledge (Milch) scores
Opportunity ≈0.75; a $75,000 pledge (Stein) scores ≈0.97 — a real but
modest gap for a 50x dollar difference. **Root cause:** the materiality
formula's log-scale term compresses large-value differences by design
(a defensible general property of log scales), and its
portfolio-percentile term is computed against a distribution where most
individual financial events genuinely are small — so even a $1,500
pledge sits at a high percentile. **This is a genuinely new failure
mode** — Round 1 had a hard cliff (a pledge either cleared the 90th
percentile or it didn't); Round 2 replaced the cliff with a continuous
scale, but the scale itself doesn't stretch far enough at the low end
for this portfolio's actual size distribution. A future round should
consider a materiality basis anchored more directly to real dollar
brackets (e.g., explicit tiers) rather than percentile rank within a
donor population.

**2. A cluster of large, completely undocumented relationships (Sperka,
Dov Zeffren, Moradian, Martin, Krull, David B. Rosenbaum) occupy roughly
a third of the top 25**, essentially on Financial Significance plus a
modest, real-but-unremarkable Momentum uptick, with **zero interaction,
fact, ask, or reminder evidence of any kind.** Is a real but small
dollar increase on an otherwise silent relationship really equivalent
"30-day attention" evidence to Stein's $75,000 pledge or Weinschneider's
explicit scheduled ask? This is not necessarily wrong, but it produces a
top 25 that is disproportionately populated by donors about whom
nothing beyond size and a mild trend is actually known — worth a human
read of whether this is the right shape for a monthly focus list.

**3. Donny Wiesel (#19) — a $3,600 lifetime relationship — ranks above
several $19,000-$54,000 lifetime relationships (Rosenbaum, Sperka,
Krull) purely because an explicit reminder gives him Opportunity=0.6.**
The engagement-opportunity mechanic (item 8) was designed to correct
Weinschneider's undercrediting, and does so correctly there — but it
does not currently scale by the size of the relationship it's attached
to, so a trivial-dollar relationship with a reminder can outrank a
much larger relationship with none. Worth considering whether the
engagement track should be modulated by Financial Significance, the way
several Opportunity/Stewardship terms already are.

**4. Momentum's "declining" and "increasing" labels contribute similarly
-shaped positive amounts to the composite, without distinguishing
direction as a strategic signal.** Zeffren's real -50% decline
(MOM=0.476) and Goldenberg's real +296% increase (MOM=0.700) both simply
add points toward "this deserves attention" — the model has no way to
say a decline on a major relationship is a *different kind* of urgent
than growth on one, only that both are non-trivial.

**5. Broide (#21) sits just below the 2-year staleness threshold** (his
$2,500 pledge is 290 days old) and is classified `current`, receiving
full tactical weight (0.65) and a real, non-zero Opportunity
contribution — reasonably, since it genuinely isn't old yet. But this
means the staleness gate has a real boundary a fundraiser should be
aware of: a pledge is treated identically to a fresh one right up until
it crosses into "legacy" territory at the 1-year (`hasRecentPaymentActivity`)
and 2-year (`legacy_needs_verification`) marks — there is no gradual
warming-down in between, which reintroduces a milder version of the
"cliff" problem this round otherwise tried to avoid.

**6. Poor-data donors receiving a specific, legible label rather than
false certainty.** This is a genuine improvement, not a failure, but
worth confirming explicitly: donors like Weinberger, Milch, and Matz are
correctly labeled `"Financially well-documented; relationship
intelligence limited"` rather than silently scoring lower or higher —
confidence is doing its job. The remaining risk is that a reader could
still mistake a high composite score alone (without reading the
confidence label) as "this relationship is well understood," when for
several top-25 donors it is not.

---

## 8. Round 2 component definitions and formula (exactly as run)

**Financial Significance (FS)** — redefined, no longer touches pledges
or recent commitments at all:
```
FS = 0.60 × lifetimePercentile + 0.25 × historicalPeakPercentile + 0.15 × multiYearSupportPercentile
```
- `lifetimePercentile`: percentile rank of category-agnostic lifetime
  cash received among donors with any.
- `historicalPeakPercentile`: percentile rank of the single largest
  financial event ever (a gift OR a pledge total, whichever is larger)
  — captures demonstrated capacity regardless of funding mechanism.
- `multiYearSupportPercentile`: percentile rank of the count of distinct
  calendar years with any real dated cash activity — a new signal,
  capturing sustained support.
- **Deliberately excludes** recent commitment size/recency (moved
  entirely to Opportunity) and recent cash magnitude (already covered by
  Momentum) — magnitude and trend are now cleanly separated concepts.

**Opportunity (OPP)** — redefined around materiality and a new
engagement track:
```
financialOpp = staleGate("current") × recencyDecay(commitmentAgeDays) × materiality(pledgeTotal, ownPeak)
engagementOpp = 0.6 if an explicit fundraiser reminder is open
              = 0.4 if a current actionable fact exists AND substantive contact <=45 days ago
              = 0 otherwise
OPP = min(1, max(financialOpp, engagementOpp) + [+0.1 if both >= 0.4])
```
where:
```
materiality(amount, ownPeak) = 0.85 × globalMateriality(amount) + 0.15 × min(1, amount/ownPeak)
globalMateriality(amount)    = 0.7 × logScale(amount) + 0.3 × portfolioPercentile(amount)
logScale(amount)             = log10(amount+1) / log10(maxPortfolioEvent+1)
recencyDecay(days)           = clamp(1 − days/365, 0, 1)
```
- `financialOpp` ONLY considers open pledges (never a completed gift —
  a gift already happened; it feeds Stewardship, not Opportunity).
- Gated on the staleness classifier below — a non-"current" pledge
  contributes zero regardless of size.
- **No credit of any kind for absence of documented contact** (the
  Round 1 Schwartz-vs-Stein defect is structurally impossible now — that
  code path does not exist).

**Stewardship (STEW)** — redefined, no longer requires a payment plan:
```
STEW = min(1,
    0.35 × recencyDecay(eventAgeDays) × materiality(eventAmount, ownPeak)   [a recent significant pledge OR gift]
  + 0.20 × (onTrack ? materiality(pledgeTotal, ownPeak) : 0)                [active fulfillment, decoupled from recency]
  + 0.20 × (hasOpenReminder ? 1 : 0)
  + 0.15 × (hasUpcomingDate AND meaningfulRelationship ? 1 : 0)
  + 0.10 × (daysSinceSubstantiveContact <= 45 ? 1 : 0)
)
```

**Relationship Momentum (MOM)** — redefined with a materiality gate on
top of the existing ratio test:
```
if lifetime == 0:                          "no_giving_history",  0
else if onTrackPlan:                       "actively_fulfilling_commitment", 0.3   (fixed, overrides all else)
else if no dated cash in >365 days:        "dormant_lapsed",      0.4 × lifetimePercentile
else if first-ever giving this year:       "newly_significant",   0.4 + 0.5 × materialityOfLast365
else if prior365 > 0:
   ratio = last365 / prior365
   deltaMaterialityPct   = percentile rank of |last365-prior365| among all donors' real swings
   deltaRelativeToLifetime = |last365-prior365| / lifetime
   meaningfulSwing = deltaMaterialityPct >= 0.4 AND deltaRelativeToLifetime >= 0.03
   if ratio >= 1.25 AND meaningfulSwing:    "increasing", min(0.7, 0.3 + (ratio−1)×0.3)
   else if ratio <= 0.6 AND meaningfulSwing: "declining", 0.5 × lifetimePercentile
   else if ratio outside [0.6, 1.25]:        "noisy_swing", 0.05    (ratio crossed the threshold but the dollar swing is immaterial)
   else:                                      "stable", 0.1
else: "insufficient_data", 0.05
```

**Tactical Urgency (TAC)** — the real Recommendation Engine score,
consumed with a strategic discount for stale pledge follow-ups only:
```
TAC = recommendation.score
if recommendation.kind === "follow_up_pledge":
   if staleClass === "immaterial_artifact":       TAC = min(TAC, 0.15)
   else if staleClass === "legacy_needs_verification": TAC = min(TAC, 0.40)
```
The Recommendation Engine itself is never modified — this is Portfolio
Focus's own consumption of its output.

**Relationship Intelligence** — no longer an independent weighted term.
Its one legitimate scoring contribution (a current, actionable fact
reinforcing real engagement) is folded into `engagementOpp` above. Its
remaining role is explainability (surfaced in evidence text) and, where
relevant, the confidence assessment.

**Stale-balance strategic relevance gate (item 5):**
```
classifyPledgeStaleness(donor):
  if no open pledge: null
  realAge = pledgeCommitmentAgeDays (known past date) ?? pledgeAgeDays (if >= 0, else unknown)
  onTrack = active payment plan AND not late
  recentSubstantive = substantive contact within 365 days
  if onTrack OR (realAge <= 365) OR recentSubstantive:  "current"
  else if realAge > 1825 (5 years):                     "immaterial_artifact"
  else:                                                  "legacy_needs_verification"
```

**Composite (frozen before this run):**
```
Composite = 0.35·FS + 0.30·OPP + 0.20·STEW + 0.10·MOM + 0.05·TAC
```
**The only weight change from Round 1** (which was
0.35/0.25/0.20/0.10/0.05/0.05 across FS/OPP/STEW/MOM/RI/TAC): RI's 0.05
slot was mechanically merged into OPP (0.25 -> 0.30) because RI's
function moved there. No other weight was touched.

**Confidence (never part of the composite):**
```
financialConfidence   = "high" if >=3 distinct years of activity, "medium" if 1-2, "low" if 0
relationshipConfidence = "high" if any interaction/fact/ask exists, "medium" if only unconfirmed historical context, "low" otherwise
```

---

## 9. Methodology and verification gates

Identical financial reconstruction to both prior rounds, re-run fresh
against a new Independent Staging pull:
- Category-agnostic cash (gift + audited pledge payments + past-dated
  unaudited remainder), excluding future-dated remainders from period
  attribution.
- Pledge "is this new" judged by the pledge's own commitment date when
  it is a genuine past date; falls back to last-activity recency only
  when the commitment date itself is unusable (Stein).
- All gates re-run and passed: category set valid; >=40
  `partially_paid_pledge` rows (53 found); every `giving_activities` row
  has an `id`; every payment-audit row joins to a real pledge; the
  category-agnostic-cash canary fired; **the Spetner regression check
  passed** (daysSinceLastGift=11, last365=$10,000, openPledgeBalance=
  $2,000, recommendation=`reconnect_contact_gap`).
- Portfolio totals: 248 donors, $3,470,745.30 lifetime, 169 in the
  Suggested pool — identical to both prior rounds, confirming zero data
  drift.

---

## 10. Recommendation on implementation readiness

**Not yet.** The redesign successfully fixed every structural defect it
targeted: Financial Significance is now magnitude-only (Sanity Checks
A/B confirm it), the missing-contact-as-Opportunity inversion is gone
(Sanity Check C), Stewardship no longer requires a payment plan (Section
4, Schwartz), the stale-balance gate correctly neutralizes all five
mandatory regression cases and a sixth (Ray) it wasn't even asked to
find (Sanity Check E), the engagement-opportunity mechanic generalizes
correctly across two independent donors (Sanity Check D), Momentum's
false-positive-on-noise problem is fixed, and the Spetner regression
holds (Sanity Check F).

**But Round 2 introduced a real, new problem of its own** (Section 7,
Case 1): small pledges still earn Opportunity credit too close to major
commitments, populating several thin-evidence donors into the top 12.
This needs either a redesigned materiality basis (explicit dollar tiers
rather than log+percentile) or an explicit human decision that this
result is acceptable before any of this becomes application code. The
large-quiet-donor question (Sanity Check A/B) is a policy call, not a
bug, and also needs your judgment before proceeding.

**Recommended next step, if you want one:** a Round 3 focused narrowly
on Case 1's materiality basis, informed by your read of whether
Milch/Matz/Weber's rankings feel right — not a broader re-litigation of
everything fixed this round.

---

**Stopping for review. No weight was adjusted after seeing this
ranking. No implementation, code, schema, or Recommendation Engine
change was made.**
