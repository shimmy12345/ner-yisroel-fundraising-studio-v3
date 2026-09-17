# Fundraising Intelligence Brief -- Phase 1 Calibration Round 2

**Status:** narrow calibration round, addressing exactly two product-rule gaps found in `docs/FUNDRAISING-INTELLIGENCE-BRIEF-PHASE1-CALIBRATION.md` (V1). Computation only -- no UI, no schema, no D1 mutation, no change to Portfolio Focus scoring, the Recommendation Engine, or `relationshipConfidence`'s existing definition, no new narrative/free-text inference.

**Method:** real data re-verified for drift before this run (`SELECT COUNT(*)` against donors/giving_activities/asks/donor_relationship_facts/recommendations returned 254/5,428/6/8/3, identical to both prior rounds, zero rows written), then the real, unmodified `buildFundraisingIntelligenceBriefFromRaw()` was run against all 254 real Independent Staging donors, read-only, in a local Node script.

## 1. Baseline V1 result (for reference)

15 items, KNOW 6 / DO 4 / KNOW_DO 5. Avi Stein (PF rank #1, real `stewardship_moment` signal) was excluded entirely by the 15-item cap. Yale Miller and Manuel Schnaidman produced zero signal at all because `relationship_visibility` reused `relationshipConfidence`, whose real definition ("has FOS ever recorded any interaction/fact/ask") stayed `high` for both despite genuinely thin *current* context. Full detail in the V1 doc.

## 2. KNOW-reservation variants tested

All four variants were run against the real 254-donor population, holding the rest of the architecture fixed.

| Variant | Reserved slots | Total | KNOW | DO | KNOW_DO | Avi Stein | Yaakov Zachter | Jonathan Spetner | DO items lost vs. baseline |
|---|---|---|---|---|---|---|---|---|---|
| A (baseline) | 0 | 15 | 6 | 4 | 5 | excluded | excluded | **included** | -- |
| B | 3 | 15 | 6 | 4 | 5 | **included** | **included** | excluded | **none** |
| C | 4 | 15 | 7 | 3 | 5 | included | included | excluded | 1 (Moshe Herzog) |
| D | 5 | 15 | 8 | 2 | 5 | included | included | excluded | 2 (Herzog, Donny Wiesel) |

Mechanism tested (the smallest deterministic balancing rule, per instruction): fill `cap - reservedSlots` slots by the existing tier-then-financialSignificance order (unchanged from V1); fill the remaining `reservedSlots` from the pool of KNOW-disposition candidates that clear an existing materiality floor (`financialSignificance >= 0.5`, the same threshold `financial_change` already uses -- no new score) not already selected, ordered by **Portfolio Focus's own overall rank** (not by `financialSignificance` alone -- see §3); return any unused reserved slots to the general pool.

**Why B (3) was chosen over C/D:** the real tier-1 (task-like: explicit follow-up, ask resolution, stale pledge) population in this dataset is exactly 12 items, and `15 - 3 = 12` -- 3 is the *exact* largest reservation size at which every real tier-1 item still fits in the general pool untouched. At 4 and 5, the shrinking general-pool capacity starts cutting into real tier-1 DO items (Herzog at 4; Herzog and Wiesel at 5) -- precisely the "does not suppress obviously urgent DO items" failure this round warned against. 3 recovers the named goal (Stein) plus a bonus (Zachter) at zero DO cost; nothing above 3 was worth that cost.

## 3. Chosen KNOW reservation rule

**`DEFAULT_RESERVED_KNOW_SLOTS = 3`**, applied in `lib/fundraising-intelligence/index.ts`'s `selectWithKnowReservation()`:

1. Eligibility gate: `disposition === "KNOW"` AND `financialSignificance >= 0.5` (existing percentile component, reused; not a new score; not the sole criterion -- the candidate must also have independently cleared a real situation detector to exist at all).
2. Within the eligible pool, order by **Portfolio Focus's overall rank** (composite score), not by `financialSignificance` alone. This correction was necessary: an FS-based ordering kept recovering the highest-*financial-significance* donors (Tzvi Ray, Nachum Rosenberg -- both FS 0.98) rather than Avi Stein, who is the portfolio's #1-ranked relationship specifically because of his Opportunity/Stewardship components (an active $75,000 pledge), not his FS component alone (0.87). Rank-based ordering recovers exactly the donor the instruction named.
3. Unused reserved slots return to the general pool (tested directly: with zero KNOW-eligible candidates present, all reserved capacity flows back to real DO/KNOW_DO items -- see `tests/fundraising-intelligence.test.mjs`).

**Disclosed trade-off:** this rank-based reservation, at 3 slots, recovers Stein (#1) and Zachter (#4) but does **not** recover Jonathan Spetner (#20) -- real rank competition from other, higher-ranked KNOW candidates (Michie Nudell, #6) fills the third slot instead. Spetner's own per-donor classification remains exactly correct and unchanged (`commitment_progress`, KNOW, no reconnect action -- verified directly in `tests/fundraising-intelligence.test.mjs`, independent of population-level competition); he is a real, disclosed near-miss in the 254-donor run, the same category of trade-off Stein/Zachter themselves were in V1. The real supply of legitimate tier-2/3 KNOW candidates clearing the reservation's materiality floor is large (at least 20 real near-misses were found ranked #7-#30 in this run alone -- see §7) -- 3 slots cannot carry all of them, and enlarging the reservation further to try was rejected in §2 for costing real DO items instead.

## 4. Recent-relationship-visibility variants tested

Three day-threshold variants were tested against the real population, holding the FS-band structure fixed (top band `financialSignificance >= 0.9`, mid band `>= 0.75`, no signal below):

| Variant | Top-band threshold | Mid-band threshold | Donors qualifying |
|---|---|---|---|
| 1 (chosen) | 180 days | 365 days | 46 |
| 2 (looser) | 270 days | 545 days | 45 |
| 3 (stricter) | 120 days | 270 days | 48 |

**Finding:** the threshold *day count* barely moved the qualifying population (45-48 across a 2x range of thresholds). Real cause, confirmed directly: of the ~46-48 donors clearing the FS band, all but 2-3 have **`mostRecentStructuredEvidenceDays = null`** -- meaning FOS has literally *zero* structured touchpoint (no substantive contact, no current fact, no Ask) ever recorded for them, not merely an *old* one. With only 8 real structured facts and 6 real Asks across 254 donors, threshold tuning has little room to matter in this dataset; the real, load-bearing lever is the FS-band gate itself (which donors are strategically significant enough to flag at all), not the specific day count. This is an honest data-sparsity finding, not a defect in the threshold logic.

## 5. Chosen recency/significance rule

Variant 1 (180 / 365 days) was kept as the simplest, roundest, most defensible choice (6 months / 12 months), since the alternatives produced materially the same result. The full rule:

```
if financialSignificance >= 0.9:  threshold = 180 days
elif financialSignificance >= 0.75: threshold = 365 days
else: no relationship_visibility signal at all (not strategically significant enough)

mostRecentEvidenceDays = min(daysSinceSubstantiveContact, every current fact's age, every Ask's age)
  -- using only non-negative (safeDays()) values; null if none exist at all

fires only if mostRecentEvidenceDays is null OR > threshold
```

This is tied entirely to the *existing* `financialSignificance` percentile component (no new score) and reads only structured, already-available fields already fetched by Portfolio Focus's own bounded pull -- `daysSinceSubstantiveContact` (per-donor input), `donor_relationship_facts.source_interaction_occurred_at`, and `asks.asked_at`. No free-text/narrative inference, per instruction.

## 6. Exact raw final V2 Brief (15 items, real, unedited)

1. **[KNOW_DO] pledge_follow_up -- Mordechai Schwartz** (rank 3). Stale $36,000 pledge; separately, real growth and a $9,670 gift 10 days ago; also carries a `relationship_visibility` secondary note (limited recent context despite the financial activity).
2. **[KNOW_DO] explicit_follow_up -- Dovie Weinschneider** (rank 2). Explicit reminder, real giving growth as context.
3. **[KNOW_DO] pledge_follow_up -- Mordy Goldenberg** (rank 13). $650 pledge, 139 days stale, warm relationship.
4. **[KNOW_DO] explicit_follow_up -- Eitan Zeffren** (rank 5). Explicit reminder to solicit; real decline as context; also carries a `relationship_visibility` secondary note.
5. **[KNOW_DO] pledge_follow_up -- Joshua Broide** (rank 8). $2,500 pledge, 310 days stale, recent personal note.
6. **[KNOW] ask_resolution -- Mayer Simcha Klein** (rank 65). Declined $5,000 ask, no action.
7. **[DO] pledge_follow_up -- Shimmy Pianko** (rank 78). $650 of $1,200 open, 703 days, confidence `limited`.
8. **[KNOW] ask_resolution -- Allen Pfeiffer** (rank 103). Declined $10,000 ask, no action.
9. **[KNOW] ask_resolution -- Paul S. Richman** (rank 122). Declined $10,000 dinner-sponsorship ask, no action.
10. **[DO] pledge_follow_up -- Elie Grinblatt** (rank 135). $500 pledge, 275 days stale.
11. **[DO] explicit_follow_up -- Donny Wiesel** (rank 17). Explicit reminder.
12. **[DO] pledge_follow_up -- Moshe Herzog** (rank 199). $250 pledge, 981 days stale, confidence `limited`.
13. **[KNOW] stewardship_moment -- Yaakov Zachter** (rank 4) -- **NEW in V2.** "Actively fulfilling a $18,000 pledge on schedule ($13,500 remaining)."
14. **[KNOW] stewardship_moment -- Avi Stein** (rank 1) -- **NEW in V2, the round's headline goal.** "Actively fulfilling a $75,000 pledge on schedule ($66,668 remaining)," plus a real, honest `relationship_visibility` secondary note despite the active commitment.
15. **[KNOW] stewardship_moment -- Michie Nudell** (rank 6) -- **NEW in V2.** "Actively fulfilling a $10,000 pledge on schedule ($9,000 remaining)."

**Disposition counts:** KNOW 6, DO 4, KNOW_DO 5 (unchanged totals from V1; composition shifted -- see §9).
**Situation-type counts:** `pledge_follow_up` 6, `explicit_follow_up` 3, `ask_resolution` 3, `stewardship_moment` 3 (`financial_change` and `commitment_progress`, present in V1's final 15, are absent from V2's final 15 -- see §9).

## 7. Top rejected near-misses (real, ranked)

The 20 highest-ranked donors excluded only by the cap, in rank order: Yaakov Yisroel Klein (#7, commitment_progress), Daniel Saidian (#9, commitment_progress), Moishe Weber (#10, stewardship_moment), Shimmy Ramras (#11, stewardship_moment), Moshe Aharon Rosenbaum (#12, commitment_progress), Yehuda Moradian (#14, financial_change/KNOW_DO), Tzvi Ray (#16, financial_change), Yisroel Dahan (#18, stewardship_moment), Aaron Martin (#19, financial_change), **Jonathan Spetner (#20, commitment_progress)**, Michael J Krull (#21, financial_change), Perry Lazar (#22, commitment_progress), David B. Rosenbaum (#23, financial_change), Yitzchak Sperka (#24, financial_change), Eli Davis (#25, financial_change), Dov Zeffren (#26, financial_change), Eitan Pfeiffer (#27, financial_change), Yaakov Milch (#28, commitment_progress), **Shlomo Horowitz (#29, relationship_visibility)**, Moshe Matz (#30, stewardship_moment). This confirms real, abundant KNOW supply well beyond 3 slots -- and that Shlomo Horowitz is the highest-ranked real donor whose *only* signal is `relationship_visibility` (rank 29, still not competitive enough for a reserved slot against rank 1/4/6 stewardship items).

## 8. Strongest improvements

- **Avi Stein now appears**, in exactly the shape intended: KNOW, `stewardship_moment`, no solicitation/reconnect action -- the round's headline goal, achieved with zero cost to any DO item.
- **A genuinely nuanced real finding surfaced by the fix**: Stein's item carries *both* "actively fulfilling a $75,000 pledge" (financial engagement, strong) *and* a secondary "FOS has limited recent relationship context" note (personal-touchpoint visibility, thin) -- proving these are two real, independent axes, and the new detector correctly identifies a gap that `relationshipConfidence` alone would have hidden even for a donor who is otherwise the portfolio's top financial relationship.
- **Yale Miller and Manuel Schnaidman's detector-level gap is closed**: both now produce a real `relationship_visibility` signal (previously zero signal of any kind). They do not survive the final 15 in this specific real population (see §9), but the underlying product-rule gap named in V1 -- "the detector cannot see this situation at all" -- is fixed.

## 9. New false positives / trade-offs introduced

None found that misrepresent evidence. The real, disclosed **trade-offs** (not false positives -- every item's evidence remains accurate):

- **Jonathan Spetner exits the final 15** (see §3) -- a real, rank-driven near-miss, not a bug; his own classification is unaffected and unit-tested.
- **`financial_change` and `commitment_progress` situation types drop out of the final 15 entirely** in this specific run (present in V1: 2 and 1 items respectively) -- their natural "leftover tier-1-capacity" slots were reallocated by the rank-based reservation to 3 `stewardship_moment` items with better overall Portfolio Focus rank (Stein #1, Zachter #4, Nudell #6, vs. Ray #16 / Rosenberg #34 / Spetner #20). Net effect: **situation-type diversity in the final 15 decreased from 5 types to 4**, while **strategic-rank representation improved** (the average/best rank among included KNOW items dropped from ranks 16/20/34 to ranks 1/4/6). This is presented as the actual trade-off the rank-based rule makes, for your review, not hidden.

## 10. Remaining false negatives

- **Yale Miller and Manuel Schnaidman** produce a real `relationship_visibility` signal but do not survive the 15-item cap in this real population (both far outranked, #38 and #44, by the 3 stewardship items that win the reserved slots). The detector-level gap named in V1 is fixed; final-list inclusion remains governed by the separate, already-working reservation/priority mechanism, which this round did not further tune beyond §3's rank-based correction.
- **Dr. Jacques Semmelman** remains a `no_qualifying_situation` donor, exactly as instructed -- his only real recent touchpoint (a Yahrtzeit-acknowledgment note) lives in unstructured interaction data, not a structured `donor_relationship_facts` row, and Round 2 deliberately does not read narrative text. **Documented limitation, not solved this round, per explicit instruction.**

## 11. Named control results

| Control | Expected | Actual (V2) |
|---|---|---|
| Avi Stein | appear if balancing works; KNOW/stewardship-active; no reconnect DO | **Met** -- KNOW, `stewardship_moment`, no action. |
| Yale Miller | eligible for relationship_visibility if his gap satisfies the new rule; neutral wording; no invented action | **Met at the detector level** -- fires, `relationship_visibility`, `possibleAction: null`; excluded from final 15 by rank (disclosed, §10). |
| Manuel Schnaidman | same test | **Met at the detector level**, same disclosed cap exclusion. |
| Jonathan Spetner | must remain healthy KNOW commitment_progress, no reconnect action | **Classification met** (verified directly, independent of population competition, in `tests/fundraising-intelligence.test.mjs`); **excluded from the real 254-donor final 15** by rank -- disclosed trade-off, §3/§9. |
| Mordechai Schwartz | remain correctly synthesized; gift and pledge distinct | **Met**, unchanged from V1, plus a new real `relationship_visibility` secondary note. |
| Dovie Weinschneider | explicit follow-up remains included | **Met**, unchanged. |
| Eitan Zeffren | explicit follow-up remains included | **Met**, unchanged, plus a new secondary `relationship_visibility` note. |
| Joshua Broide | pledge follow-up remains included | **Met**, unchanged. |
| Klein / Pfeiffer / Richman | declined-Ask safety intact | **Met** for all three, unchanged, `possibleAction: null` on every one. |
| Eliezer Zryl | birthday-only remains excluded | **Met** (still excluded from the final Brief in real data; note: his real Portfolio Focus `financialSignificance` (0.57) clears the existing, pre-existing, unrelated `upcoming_moment` materiality gate from V1, so his detector produces a signal that is then cut by the cap -- this is pre-existing V1 behavior confirmed unrelated to this round's changes, not a new regression). |
| Jacques Semmelman | do NOT solve via free text; document the limitation | **Met** -- unchanged, explicitly documented, §10. |

## 12. Situation-type distribution (final 15)

`pledge_follow_up`: 6, `explicit_follow_up`: 3, `ask_resolution`: 3, `stewardship_moment`: 3. (`commitment_progress`, `financial_change`, `relationship_visibility`, `upcoming_moment`: 0 in the final 15 this run -- all present among real near-misses, see §7.)

## 13. Disposition distribution (final 15)

KNOW: 6, DO: 4, KNOW_DO: 5 -- identical totals to V1; composition changed (3 `stewardship_moment` KNOW items replaced 2 `financial_change` + 1 `commitment_progress` KNOW items -- see §9).

## 14. Suppression counts

239 total rejected: `excluded_by_selection_cap` 106 (up from 95 in V1 -- more real situations are now being *detected*, e.g. Miller/Schnaidman/Zachter/Stein/Nudell all moved from "no signal" or "cap-excluded-differently" into this bucket), `reconnect_fallback_only_no_independent_situation` 121 (down from 129 -- some of those donors' real signal is now correctly detected instead of falling through to the fallback-only bucket), `no_qualifying_situation` 12 (down from 15 -- Miller and Schnaidman moved out of this bucket into "detected but cap-excluded," exactly the intended fix).

## 15. Whether the output still feels like intelligence rather than task management

**Yes, more so than V1.** The final 15 now contains 3 genuine "here is a healthy, important relationship, no action needed" KNOW items at the very top of the real portfolio (ranks #1, #4, #6) alongside the task-like DO items, directly answering "what should I know" as well as "what should I do" -- which was the specific, named shortfall V1's calibration surfaced. The one honest cost is a mild reduction in situation-type variety within the visible 15 (§9); this is disclosed, not hidden, and is a legitimate open question for your review (§16 of the design doc's original framing already anticipated this kind of trade-off).

## 16. Performance

**Query count: unchanged from Phase 1 -- zero new D1 queries.** The reservation mechanism (`selectWithKnowReservation`) and the new recency signal (`mostRecentStructuredEvidenceDays`) are both pure, in-memory operations over data Portfolio Focus's existing 12-query pull and Phase 1's existing per-donor detector inputs already provide. Incremental cost: `selectWithKnowReservation` is three linear passes over the already-computed candidate list (bounded by the ~254-donor population, not the whole workspace's raw row count); `mostRecentStructuredEvidenceDays` iterates one donor's own (small, already-loaded) facts/asks arrays, exactly as `detectAskResolution`/`detectPledgeFollowUp` already did in Phase 1. No N+1 introduced.

## 17. Confirmations

- **Zero D1 mutation** -- every command run this round, including the pre-run freshness re-check, was a read-only `SELECT`.
- **No schema added.**
- **No UI added.**
- **Portfolio Focus scoring, Recommendation Engine scoring, and `relationshipConfidence`'s existing definition were not modified** -- the new recency signal is a separate, Brief-specific computation living entirely in `lib/fundraising-intelligence/situations.ts`.
- **No free-text/narrative inference was added** -- Semmelman remains an explicitly documented, unsolved limitation.
- **Nothing deployed.**
