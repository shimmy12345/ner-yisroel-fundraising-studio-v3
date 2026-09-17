# Fundraising Intelligence Brief -- Phase 1 Final Calibration: Ask Resolution Recency Only

**Status:** intentionally narrow, final calibration round before any UI decision. The ONLY change this round: `ask_resolution`'s Brief-eligibility window for a **declined or withdrawn** ask. Everything else -- the 3-slot KNOW reservation, `relationship_visibility`, Portfolio Focus, the Recommendation Engine, Relationship Intelligence, pledge/financial-change/stewardship logic, the 15-item cap, and KNOW/DO/KNOW_DO semantics -- is untouched. No UI, schema, D1 writes, free-text inference, or new score.

**Method:** real data re-verified for drift before this run (254 donors / 5,428 giving rows / 6 asks / 8 facts / 3 reminders -- identical to all three prior rounds, zero rows written), then the real, unmodified engine run against all 254 real Independent Staging donors, read-only.

## 1. The product distinction (why this round exists)

Two different questions were being answered by one number:

- **(A) Historical truth / recommendation suppression:** a declined or withdrawn ask must permanently prevent that solicitation from ever being read as a live opportunity. This is **structural**, not a window -- no detector in `lib/fundraising-intelligence/situations.ts` ever reads Ask status to manufacture a *new* solicitation signal, regardless of age. Untouched this round, and re-verified by a new direct test (`tests/fundraising-intelligence.test.mjs`, "Historical-truth suppression is permanent...").
- **(B) Brief novelty:** whether a *resolved* ask still deserves one of the Brief's 15 scarce, today-facing slots. A decline from 315+ days ago is not "news" the way a 29-day-old decline is, even though both remain equally, permanently true under (A).

The prior implementation used one 545-day window for both concerns, which conflated them: an ask resolved over a year ago could still occupy a Brief slot indefinitely as if it were current news.

## 2. Ask-resolution windows tested

The real declined/withdrawn Ask population in Independent Staging is small (4 rows) and sharply clustered:

| Donor | Status | Age (days) |
|---|---|---|
| Paul S. Richman | declined | 29 |
| Dr. & Dr. Joseph Resnikoff | withdrawn (test data -- "Staging withdraw test") | 29 |
| Mayer Simcha Klein | declined | 315 |
| Allen Pfeiffer | declined | 367 |

30, 60, 90, and 180-day windows were tested against this real population. **Result: all four windows produce an identical real-world outcome** -- Richman (29 days) qualifies under every one; Klein (315) and Pfeiffer (367) fail every one. There is no real data point between 30 and 315 days to differentiate the candidate windows.

**Chosen threshold: 90 days.** Since the real data could not distinguish between the candidates, the simplest defensible choice was made by reusing an **already-existing** convention rather than inventing a new number: `lib/relationships/fact-classification.ts`'s `CATEGORY_DECAY_WINDOW_DAYS.solicitation` is already 90 days -- the exact window Relationship Intelligence's own fact-decay architecture already uses for "how long does a solicitation stay current." `ASK_RESOLUTION_BRIEF_NOVELTY_WINDOW_DAYS = 90` in `lib/fundraising-intelligence/situations.ts` directly reuses that precedent.

**No threshold was selected to force a particular donor into the final 15** -- 90 was fixed before re-running the real 254-donor calibration in §8, and the resulting inclusion/exclusion set (§8/§9) was accepted as computed, not hand-tuned afterward.

## 3. Current-relevance exception: NOT implemented

Investigated per instruction whether an old resolved ask should regain Brief eligibility when a separate, current, *structured* event makes it newly relevant. Considered:

- **A newer pending ask exists:** already handled for free by the existing "most recent ask only" logic -- a newer pending ask simply becomes the evaluated ask, superseding the old resolution automatically. No exception needed.
- **A recent interaction "relates to" the prior ask:** would require correlating an interaction to a specific ask by content/meaning, which is narrative inference -- explicitly out of scope this round. Not implemented.
- **New giving materially changes the context:** a clean, structured signal *does* exist (`mostRecentCashKind`/`mostRecentCashCents`/`daysSinceLastGift`) -- but it does not need to be wired into `ask_resolution` at all, because it already independently produces its own, separate situation (`financial_change`'s "recent meaningful gift" sub-signal, `detectRecentMeaningfulGift`). A donor with an old declined ask and a fresh, unrelated gift gets a real `financial_change` Brief item on its own merits, not a resurrected `ask_resolution` item. **Verified directly** in a new test ("No current-relevance exception was implemented").

**Conclusion: no exception was added.** The existing multi-detector, one-winner-per-donor architecture already covers "something new and relevant happened" through its own independent detectors; a bespoke ask-specific exception would either require narrative inference (disallowed) or duplicate logic that already exists elsewhere. This matches the instruction's own fallback: "if there is no clean existing signal, do not add this exception in Phase 1."

## 4. Exact final 15 (real, unedited)

1. **[KNOW_DO] pledge_follow_up -- Mordechai Schwartz** (rank 3) -- unchanged from V2.
2. **[KNOW_DO] explicit_follow_up -- Dovie Weinschneider** (rank 2) -- unchanged.
3. **[KNOW_DO] pledge_follow_up -- Mordy Goldenberg** (rank 13) -- unchanged.
4. **[KNOW_DO] explicit_follow_up -- Eitan Zeffren** (rank 5) -- unchanged.
5. **[KNOW_DO] pledge_follow_up -- Joshua Broide** (rank 8) -- unchanged.
6. **[DO] pledge_follow_up -- Shimmy Pianko** (rank 78) -- unchanged.
7. **[KNOW] ask_resolution -- Paul S. Richman** (rank 122) -- unchanged (29 days, well within the new 90-day window).
8. **[DO] pledge_follow_up -- Elie Grinblatt** (rank 135) -- unchanged.
9. **[DO] explicit_follow_up -- Donny Wiesel** (rank 17) -- unchanged.
10. **[DO] pledge_follow_up -- Moshe Herzog** (rank 199) -- unchanged.
11. **[KNOW] financial_change -- Tzvi Ray** (rank 16) -- **NEW**, naturally re-entered (real decline $25,360 -> $5,760), not forced.
12. **[KNOW] financial_change -- Nachum Rosenberg** (rank 34) -- **NEW**, naturally re-entered (real $2,000 gift, 16 days ago), not forced.
13. **[KNOW] stewardship_moment -- Yaakov Zachter** (rank 4) -- unchanged from V2.
14. **[KNOW] stewardship_moment -- Avi Stein** (rank 1) -- unchanged from V2.
15. **[KNOW] stewardship_moment -- Michie Nudell** (rank 6) -- unchanged from V2.

**Donors added vs. V2:** Tzvi Ray, Nachum Rosenberg.
**Donors removed vs. V2:** Mayer Simcha Klein, Allen Pfeiffer (both now correctly excluded as standalone items -- their resolutions are 315 and 367 days old).

**Disposition:** KNOW 6, DO 4, KNOW_DO 5 -- identical totals to V1 and V2.
**Situation-type distribution:** `pledge_follow_up` 6, `explicit_follow_up` 3, `financial_change` 2, `stewardship_moment` 3, `ask_resolution` 1 (down from 3 in V2 -- the direct, intended effect of this round's change).

## 5. What filled the vacated slots

Klein and Pfeiffer's two vacated slots were filled by the next-highest-ranked real candidates already in the general pool: **Tzvi Ray** (rank 16, `financial_change`, a real, dated giving decline) and **Nachum Rosenberg** (rank 34, `financial_change`, a real recent gift) -- both already present as real near-misses in the V1/V2 calibration reports, now naturally promoted. Notably, **Pfeiffer himself still has a real signal** (his own `financial_change`, from the same giving decline that was already visible as secondary evidence in his V2 `ask_resolution` item) -- he is not silently erased, he simply now competes on that signal's own (lower, rank-103) merit and loses the cap to Ray/Rosenberg. This is exactly the intended distinction: Pfeiffer's *ask resolution* stopped being news; a donor is never invisible to the Brief merely because one detector aged out, if another real signal exists.

## 6. Regression results (required real cases)

| Donor | Requirement | Result |
|---|---|---|
| Paul S. Richman | recent decline, eligible within window | **Met** -- included, unchanged. |
| Mayer Simcha Klein | old decline, no longer a standalone slot; suppression intact | **Met** -- excluded as a Brief item (`reconnect_fallback_only_no_independent_situation`); direct test confirms his declined ask + matching solicitation fact still never produces an opportunity item at any age. |
| Allen Pfeiffer | same test | **Met** -- excluded as `ask_resolution`; his own real `financial_change` signal survives independently but loses the cap on rank. |
| Avi Stein | must remain in final Brief under the 3-slot reservation | **Met** -- unchanged, rank 1, `stewardship_moment`. |
| Yaakov Zachter | existing classification unchanged | **Met** -- unchanged. |
| Jonathan Spetner | inspect whether he naturally re-enters; do not force | **Inspected: he does not naturally re-enter.** The vacated slots went to Ray (rank 16) and Rosenberg (rank 34), both ranked better than Spetner's `commitment_progress` (rank 20) -- no rule was added to change this. He remains a real, disclosed near-miss (`excluded_by_selection_cap`), identical in kind to his V2 status. |
| Tzvi Ray | inspect whether financial_change naturally re-enters; do not force | **Met -- naturally re-entered**, exactly as anticipated, with no code change directed at him specifically. |
| Mordechai Schwartz | synthesis unchanged | **Met** -- unchanged. |
| Dovie Weinschneider | remains included | **Met** -- unchanged. |
| Joshua Broide | remains included | **Met** -- unchanged. |

## 7. Historical-truth suppression: confirmed intact

A new, direct test (`tests/fundraising-intelligence.test.mjs`) constructs a donor with a 315-day-old declined ask **and** a matching solicitation-category relationship fact about the same ask, and asserts the Brief produces **no item at all**, specifically no item whose text contains "opportunity" or "solicit." This is the concrete proof that removing an old ask's *Brief slot* did not weaken its *permanent suppression* -- the two concerns are now independently governed, exactly as the round's product principle required.

A real, pre-existing, unrelated data-quality detail surfaced while checking this: Dr. & Dr. Joseph Resnikoff has two literal test-data Ask rows ("Staging ask test" / "Staging withdraw test") at the **exact same timestamp**. Because `detectAskResolution` only ever evaluates the single most-recently-asked row, and JavaScript's stable sort preserves the original (D1 query) row order on an exact tie, the `committed` row wins the tie over the `withdrawn` one, and no `ask_resolution` signal fires for either. This is pre-existing behavior (this round changed nothing about tie-breaking), disclosed for completeness -- not a new finding this round created, but one this round's investigation happened to surface. The design doc's existing open decision to clean up these two test rows (docs/FUNDRAISING-INTELLIGENCE-BRIEF-DESIGN.md §20 item 7) remains the right place to resolve it, not a code change here.

## 8. Strongest improvement

Klein and Pfeiffer's decade-old-feeling (315/367-day) declined asks no longer occupy 2 of the Brief's 15 scarcest slots as if they were today's news, and the freed capacity was absorbed by two *more currently relevant* real financial signals (Ray's real decline, Rosenberg's real recent gift) -- with zero loss of the safety property those old asks exist to provide. The "historical truth vs. current actionability" principle (already the design doc's own §15) is now enforced for Ask data exactly as it always has been for narrative Relationship Facts.

## 9. Remaining false positive

None found. Every item in the final 15 is accurate, evidenced, and appropriately worded; no suppressed historical fact was misrepresented.

## 10. Remaining false negative

Unchanged from V2 and explicitly out of scope this round: Yale Miller and Manuel Schnaidman's `relationship_visibility` signal still does not survive the real 254-donor cap (both far outranked by the 3 reserved `stewardship_moment` slots); Dr. Jacques Semmelman remains a documented, unsolved `no_qualifying_situation` case (unstructured-context gap, deliberately not addressed via narrative inference).

## 11. Performance

**Zero new D1 queries, zero writes, zero schema.** The only change is a constant (window length, in days) and its accompanying comment inside an already-pure, already-in-memory function (`detectAskResolution`). No new field is read that wasn't already part of `RawAskRow`; no additional pass over the data was introduced.

## 12. Confirmations

- **Zero D1 mutation** -- every command run this round, including the pre-run freshness check, was read-only.
- **No schema added. No UI added. Nothing deployed.**
- **No other situation type was tuned** -- `relationship_visibility`, the 3-slot KNOW reservation, pledge/financial-change/stewardship logic, and the 15-item cap are byte-for-byte unchanged from Round 2.
- **Historical-truth suppression is intact and independently verified** -- an old declined ask, at any age, never becomes a live opportunity; only its *standalone Brief-slot eligibility* changed.
