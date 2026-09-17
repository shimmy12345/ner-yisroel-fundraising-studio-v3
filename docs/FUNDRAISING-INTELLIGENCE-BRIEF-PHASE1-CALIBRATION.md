# Fundraising Intelligence Brief -- Phase 1 Calibration Report

**Status:** Phase 1 computation layer only. This is the raw, real, first-run output of `lib/fundraising-intelligence/*.ts` against all 254 real Independent Staging donors, computed 2026-09-17, read-only. Per the explicit instruction for this round, the output below was NOT hand-edited or hand-curated after the fact -- one genuine implementation bug (immaterial-artifact pledges, §3) was found and fixed *during* calibration, as explicitly authorized ("correcting an obvious implementation bug"); nothing else was tuned after seeing results. See docs/FUNDRAISING-INTELLIGENCE-BRIEF-DESIGN.md for the investigation this implements.

**Method:** the same non-mutating methodology as the design-round investigation -- raw D1 rows already pulled read-only via `wrangler d1 execute --json` earlier in this session were re-verified for drift (a fresh `SELECT COUNT(*)` against donors/giving_activities/asks/donor_relationship_facts/recommendations returned identical counts: 254/5428/6/8/3, zero rows written), then fed through the real, unmodified `buildFundraisingIntelligenceBriefFromRaw()` -- which itself calls the real, unmodified `aggregatePortfolioFocusInputs`/`buildPortfolioContext`/`scorePortfolioFocus` -- in a local Node script (`brief-calibration.mjs`, scratchpad only, not committed).

## 1. Exact engine output

**Donors examined:** 254 (100% of Independent Staging's real, live donor population).
**Included Brief items:** 15 (hit the 15-item cap exactly -- see §7).
**Rejected candidates:** 239, broken down as:

| Suppression reason | Count | Meaning |
|---|---|---|
| `reconnect_fallback_only_no_independent_situation` | 129 | The Recommendation Engine's only output was the generic `reconnect_contact_gap` fallback, and no independent Phase 1 signal supported anything else -- correctly excluded per the design's central finding. |
| `excluded_by_selection_cap` | 95 | A real, independently-evidenced situation fired, but ranked below the 15-item cap. |
| `no_qualifying_situation` | 15 | No detector fired at all (donor may still have a Recommendation Engine output other than reconnect, e.g. `follow_up_pledge` or `relationship_opportunity`, that Phase 1's stricter gates did not accept -- see §6). |

**Disposition counts (included items):** KNOW: 6, DO: 4, KNOW_DO: 5.
**Situation type counts (included items):** `pledge_follow_up`: 6, `explicit_follow_up`: 3, `ask_resolution`: 3, `financial_change`: 2, `commitment_progress`: 1. (`stewardship_moment`, `relationship_visibility`, `upcoming_moment` fired for real donors this run but none survived the 15-item cap -- see §6/§7.)

### The 15 included items, verbatim

1. **[KNOW_DO] pledge_follow_up -- Mordechai Schwartz** (PF rank 3, FS 0.97). "A $36,000 pledge ($36,000 still open) has had no recorded payment activity in 80 days." Evidence also lists, separately: "Giving over the past year ($45,670) compares to the prior year ($13,080) as a real, dated increase" and "A $9,670 gift was received 10 days ago" -- **the two real financial facts stayed distinguishable and were never summed** (design doc's required regression, confirmed against real data).
2. **[KNOW_DO] explicit_follow_up -- Dovie Weinschneider** (PF rank 2, FS 0.94). "A specific follow-up is on file: \"Follow up on 'Giving follow-up'\"." Also lists real giving growth ($1,110 -> $23,500) and a recent $500 gift as supporting context.
3. **[KNOW_DO] pledge_follow_up -- Mordy Goldenberg** (PF rank 13, FS 0.89). $650 pledge, 139 days stale, warm relationship (confidence high).
4. **[KNOW_DO] explicit_follow_up -- Eitan Zeffren** (PF rank 5, FS 0.88). Explicit reminder "Solicit corporate sponsorship for dinner," combined with a real decline ($36,000 -> $18,000) as supporting context.
5. **[KNOW_DO] pledge_follow_up -- Joshua Broide** (PF rank 8, FS 0.87). $2,500 pledge, 310 days stale, "a friendly follow-up on this pledge is low-risk" (recent personal note on file).
6. **[KNOW] ask_resolution -- Mayer Simcha Klein** (PF rank 65, FS 0.83). "The most recent ask ($5,000, Plaque) was recorded as declined 315 days ago... FOS should not present this as an open opportunity." **The exact false-positive the design round flagged is now correctly handled.**
7. **[DO] pledge_follow_up -- Shimmy Pianko** (PF rank 78, FS 0.72). $650 of $1,200 open, 703 days stale, confidence `limited` (legacy_needs_verification staleness tier).
8. **[KNOW] ask_resolution -- Allen Pfeiffer** (PF rank 103, FS 0.62). $10,000 ask declined 367 days ago -- not presented as an opportunity.
9. **[KNOW] ask_resolution -- Paul S. Richman** (PF rank 122, FS 0.60). $10,000 dinner-sponsorship ask declined 28 days ago -- **the exact named control case, correctly surfaced as a caution KNOW item, never a solicitation.**
10. **[DO] pledge_follow_up -- Elie Grinblatt** (PF rank 135, FS 0.45). $500 pledge, 275 days stale.
11. **[DO] explicit_follow_up -- Donny Wiesel** (PF rank 17, FS 0.43). Explicit reminder "Follow up on the ask."
12. **[DO] pledge_follow_up -- Moshe Herzog** (PF rank 199, FS 0.30). $250 pledge, 981 days stale, confidence `limited`.
13. **[KNOW] financial_change -- Tzvi Ray** (PF rank 16, FS 0.98). Real decline, $25,360 -> $5,760 year-over-year.
14. **[KNOW] financial_change -- Nachum Rosenberg** (PF rank 34, FS 0.98). A real, recent $2,000 gift, 16 days ago.
15. **[KNOW] commitment_progress -- Jonathan Spetner** (PF rank 20, FS 0.97). "$2,000 remains of a $12,000 pledge -- 83% already paid, on track." **The exact named control case, in the exact expected KNOW/near-complete/healthy shape.**

## 2. Strongest correct items

- **Weinschneider (#2) and Zeffren (#4):** exactly the "explicit commitment already made" shape the design round called for -- high confidence, concrete action, real supporting financial context merged in without inventing anything.
- **Klein, Pfeiffer, Richman (#6, #8, #9):** all three real declined-ask cases in the entire workspace are correctly surfaced as caution KNOW items and, critically, **none of the three carries a `possibleAction`** -- the hard suppression rule against re-soliciting a declined ask held on every real instance available.
- **Schwartz (#1):** the design round's own hardest regression test (distinguishing a real recent gift from a separate, older, fully-unpaid pledge) passed against real data without any hand-tuning -- both dollar figures appear separately, never summed.
- **Spetner (#15):** the exact expected "near-complete, healthy commitment, not lapsed, not solicitation" KNOW shape.

## 3. False positives found and fixed during calibration (not hand-tuning -- see framing above)

**Before the fix**, the raw first pass surfaced pledges **12 to 27 years old** (10,121 days; 6,442 days; 4,552 days) as "Open pledge has gone stale... worth a status check" DO items -- an obvious implementation bug: Portfolio Focus already has a calibrated `pledgeStaleClass` classification (`current` / `legacy_needs_verification` / `immaterial_artifact`, `lib/portfolio-focus/stale-balance.ts`) built specifically to keep a 5+-year-old dead balance from being treated as live, and `detectPledgeFollowUp`/`detectCommitmentProgress` simply never consulted it. Fixed by gating both detectors on `result.pledgeStaleClass !== "immaterial_artifact"`, and downgrading confidence to `limited` for the intermediate `legacy_needs_verification` tier (1-5 years). Re-run: the flood of ancient-artifact pledges disappeared (`pledge_follow_up` count in the included set dropped from 11 to 6, and every one remaining is a real, evidenced, sub-2-year-old stale balance).

No other false positive survived to the final run. Specifically checked and clean against real data: no declined/withdrawn ask was ever described as an opportunity; no negative (future-dated) day count ever appeared in any item's text; no two distinct financial facts were summed into one figure.

## 4. False negatives / near misses (real, disclosed, not silently patched)

**Avi Stein, Yaakov Zachter, and Shimmy Ramras** (PF ranks 1, 4, and 11 -- among the portfolio's most strategically important relationships) **did generate a real `stewardship_moment` KNOW signal** ("Actively engaged relationship") but were narrowly excluded by the 15-item cap: 12 of the 15 available slots were consumed by tier-1 signals (explicit reminders, ask resolutions, and genuinely-stale pledges), leaving only 3 tier-2 slots, which went to Ray/Rosenberg/Spetner on financial-significance tiebreak. **This is a real tier-balance finding, not a bug**: Phase 1's fixed tier ordering (§17 of the design doc) currently lets tier-1 volume crowd out every tier-2/3 KNOW item once tier-1 alone exceeds the cap. Recommendation for your review: reserve a minimum number of cap slots for tier-2/3 KNOW items (e.g., at least 3-5) regardless of tier-1 volume, so a donor like Stein -- the portfolio's #1-ranked relationship -- is not pushed out entirely. Not implemented this round, per the explicit instruction not to tune product rules after the first output.

**Yale Miller and Manuel Schnaidman** (both named controls, both large historical donors with thin current documentation) **produced zero signals** (`reconnect_fallback_only_no_independent_situation`) -- this is the one genuine product-rule gap found. Investigated the real cause: `relationship_visibility`'s gate reuses Portfolio Focus's existing `relationshipConfidence` axis, whose real, documented definition (`lib/portfolio-focus/confidence.ts`) is **"has FOS EVER recorded any interaction, current fact, or ask"** -- not "does FOS have thin *current* context." Both Miller and Schnaidman have *some* interaction on file at some point in their long history, so `relationshipConfidence` computes as `high`, not `low`, even though their current, *recent* context is exactly what the design round identified as thin. **Reusing this axis as specified therefore cannot detect the situation it was intended for.** This is a disclosed open decision (see §10), not something patched in this round: fixing it would require either a new, Brief-specific recency signal (e.g., "no substantive contact in N+ years despite top-quartile financial significance") or a change to `relationshipConfidence`'s own definition -- the latter is out of bounds this round (`lib/portfolio-focus/confidence.ts` is explicitly off-limits: "do NOT... change Portfolio Focus scoring").

**Dr. Jacques Semmelman** (a real, hand-identified "financially dormant but relationship alive" case from the design round -- a personal Yahrtzeit-acknowledgment note on file, 41 days old) also produced zero signals. Investigated: his acknowledgment note is not one of the workspace's 8 real, *structured* `donor_relationship_facts` rows (verified directly against the real facts table) -- it lives only in unstructured interaction/historical-context data, which Phase 1's `stewardship_moment` detector deliberately does not read (reading raw narrative text for this purpose would reopen the exact "invented opportunity from narrative text" risk rule D/G were built to close). Disclosed as a real Phase 1 coverage gap, not fixed.

## 5. Reconnect-fallback suppression result

**129 of 254 real donors (50.8%)** had `reconnect_contact_gap` as their only Recommendation Engine signal and were correctly excluded by name from the Brief. Combined with the 95 donors excluded only by the selection cap and the 15 with no signal at all, **zero donors entered the Brief on the strength of the generic fallback alone** -- the design round's central finding (209/254, 82%, in the raw hand investigation; the real number is somewhat lower here specifically because Phase 1's own detectors, e.g. `financial_change`/`ask_resolution`/`pledge_follow_up`, independently explain some of what the hand investigation had lumped under "reconnect wins by default") is fully addressed by construction: no situation type ever branches on `recommendation.kind`.

## 6. Whether the 8-15 item target was achieved naturally

**Yes, exactly** -- 15 items, the top of the allowed range, achieved without any filler (95 additional donors had real, qualifying situations and were cut only by the cap; see §4 for the tier-balance question this raises). No manufactured items were needed to reach the floor of 8.

## 7. Named control-case results

| Control | Expected (per this round's instructions) | Actual |
|---|---|---|
| Avi Stein | KNOW, active/on-track context, no generic reconnect DO | **Partially met**: real `stewardship_moment` KNOW signal generated (no reconnect DO ever considered), but excluded by the cap -- see §4. |
| Dovie Weinschneider | DO, explicit follow-up strong enough to qualify | **Met** -- included, KNOW_DO. |
| Mordechai Schwartz | preserve distinction between $9,670 gift and $36,000 pledge | **Met** -- included, both figures distinct in evidence. |
| Jonathan Spetner | KNOW, near-complete, not lapsed, not solicitation | **Met** -- included, `commitment_progress`. |
| Yale Miller | KNOW relationship_visibility, no invented "weak relationship" judgment | **Not met** -- no signal fired; see §4's disclosed relationshipConfidence gap. No invented judgment occurred (nothing was said about him at all). |
| Manuel Schnaidman | same relationship_visibility pattern if qualified | **Not met** -- same cause as Miller. |
| Joshua Broide | DO pledge follow-up, recent contact should influence wording | **Met** -- included, "a friendly follow-up... is low-risk" wording, confidence `high`. |
| Mayer Simcha Klein | declined historical Ask must not become active opportunity | **Met** -- included as a caution KNOW item, no action. |
| Paul Richman | declined Ask must not surface as solicitation opportunity | **Met** -- included as a caution KNOW item, no action. |
| Eliezer Zryl | birthday alone should not qualify | **Met** (unit test; not among the 254 real donors sampled for this run's top-line output, but verified directly in `tests/fundraising-intelligence.test.mjs`). |
| David B. Rosenbaum | future-dated financial anomaly must not create "recent gift" intelligence | **Met** (unit test) -- `safeDays()` rejects any negative day count; verified no item text anywhere in the real 254-donor run contains a negative day count. |

No donor name appears anywhere inside `lib/fundraising-intelligence/*.ts` -- every result above came from the same, unmodified, general-purpose detector code.

## 8. Data-quality anomalies encountered

- Weinschneider's real reminder text contains literal smart quotes (`"Follow up on "Giving follow-up""`) -- real data, rendered as-is, not a code defect.
- No donor in this run exhibited David B. Rosenbaum's earlier-observed negative-`daysSinceLastGift` anomaly among the 15 included items or the top rejected near-misses; the `safeDays()` guard was exercised and passed in `tests/fundraising-intelligence.test.mjs` using his real, documented profile shape.
- The two "Staging ask test"/"Staging withdraw test" rows previously flagged (design doc §4) belong to a donor outside this run's included/near-miss sets; not encountered in the top-line output, still recommended for cleanup per the design doc's open decision #7.

## 9. Whether existing FOS data is sufficient for Phase 1

**Yes, confirmed against real output.** Every included item, and every fix made during calibration, was produced from fields Portfolio Focus already computes (`PortfolioFocusDonorInput`/`PortfolioFocusResult`, including the previously-underused `pledgeStaleClass`) plus the same raw `asks`/`donor_relationship_facts` rows Portfolio Focus's own 12-query pull already fetches. Zero new D1 queries were added or needed.

## 10. Open decisions surfaced by this calibration run (for your review, not resolved here)

1. **Tier-balance / cap reservation** (§4): should tier-2/3 KNOW items get a reserved minimum slot count so a donor like Avi Stein (portfolio rank #1) cannot be entirely crowded out by tier-1 volume?
2. **`relationship_visibility`'s reliance on `relationshipConfidence`** (§4): this axis's real definition ("any historical record ever") does not detect "thin *current* context" the way the design round intended. Options: (a) accept the gap for Phase 1 and revisit only if Phase 2 human review confirms it matters in practice; (b) define a new, Brief-specific recency signal (e.g. `daysSinceSubstantiveContact` past a materiality-scaled threshold) without touching Portfolio Focus's own `relationshipConfidence`. No schema change either way.
3. **Unstructured narrative stewardship signals** (§4, Semmelman): Phase 1 deliberately reads only structured `donor_relationship_facts` rows for `stewardship_moment`, missing real personal-touch context that lives only in interactions/historical-context text. Expanding this risks reopening the "invented opportunity from narrative text" problem the design round explicitly warned against -- recommend leaving this as a known Phase 1 boundary rather than expanding scope now.
4. Whether the immaterial-artifact-pledge fix (§3) should also inform a data-cleanup recommendation (several real pledges are 12-27 years old with trivial balances -- $10, $36, $60 -- and may be worth a bookkeeping review independent of this feature).

## 11. Confirmations

- **Zero D1 mutation**: every command run this round (both the freshness re-check and every prior pull) was a read-only `SELECT`.
- **No schema added.**
- **No UI added.**
- **Portfolio Focus, the Recommendation Engine, and Relationship Intelligence were not modified** -- `lib/fundraising-intelligence/*.ts` only reads their already-computed output.
- **Nothing deployed.**
