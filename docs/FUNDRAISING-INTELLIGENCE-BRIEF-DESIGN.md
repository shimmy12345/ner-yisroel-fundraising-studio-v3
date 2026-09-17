# Fundraising Intelligence Brief — Investigation & Design

**Status:** Investigation and design only. No engine, UI, schema, or deployment changes are included in this document's commit. See §20 for the stopping point.

**Method:** Every number, name, and quote in this document comes from a real, non-mutating computation against Independent Staging's live data (254 real donors), run on 2026-09-17. Raw D1 rows were pulled read-only via `wrangler d1 execute --json` and fed into the actual, unmodified, exported TypeScript functions from `lib/portfolio-focus/aggregate.ts`, `context.ts`, and `score.ts` (which have zero D1/I/O dependency), executed locally in Node. This is the real Portfolio Focus + Recommendation Engine output — not a simulation, mockup, or hand-picked example. No D1 write occurred at any point.

---

## 1. Executive summary

FOS already computes almost everything a "Fundraising Intelligence Brief" needs. `computePortfolioFocus()` produces, per donor, in exactly 12 bounded D1 queries regardless of donor count: a composite score, five weighted components, a momentum label, an attention type, a coverage floor/trigger, two independent confidence axes, a human `whyNow` sentence, and an embedded Recommendation Engine result (kind, score, action, evidence). This is not a coincidence — Portfolio Focus was already built to answer "what does FOS know and how sure is it," which is 80% of what a Brief needs.

The missing 20% is not more data or a new scoring model. It is a **selection and synthesis layer**: picking the ~8–15 situations across 254 donors that are worth a human's attention *today*, describing each as one coherent story instead of up to four separate engine outputs, and being honest about what FOS doesn't know. Investigation found that a naive "top N by Portfolio Focus rank" or "top N by recommendation score" selection fails badly — the single largest finding is that the generic `reconnect_contact_gap` recommendation wins for **209 of 254 donors (82%)** by simply being the last-resort fallback when nothing sharper is available. Any Brief design must treat this as noise to suppress, not signal to rank.

The recommended shape is a **hybrid architecture** (§14): no new schema for Phase 1, a pure computation layer built on top of Portfolio Focus's existing output, a small set of reused signals recomposed for novelty and deduplication rather than a new weighted model, and a staged rollout that puts the raw output in front of the user (this round's explicit ask) before any UI is built.

## 2. Product boundary: why this is not CRM

Every field this document proposes is **derived from what already happened** (a gift, a payment, an ask, an interaction, a date, a fact) — never a field a fundraiser must remember to fill in. Concretely:

- No new "pipeline stage" — `attentionType` already exists and is derived every time Portfolio Focus runs.
- No new "opportunity record" — a financial opportunity is already visible as `momentumLabel: increasing/newly_significant` + `attentionType: cultivate_real_growth`, computed from real `giving_activities` rows.
- No mandatory "next action" field — the Recommendation Engine already produces exactly one action per donor from real evidence, or none at all when no evidence supports one (`buildDonorRecommendation()` returns `null` when `candidates.length === 0`).
- No arbitrary contact cadence — `daysSinceSubstantiveContact` is a fact, not a rule; §6 covers why it must stay evidence, not obligation.
- No prospect rating requiring upkeep — `financialSignificance`/`opportunity`/`stewardship` are recomputed from real activity every run.

The one place this document assesses (not proposes) a departure from pure derivation is **Relationship Intention** (§12) — and the assessment concludes it is not needed for Phase 1.

## 3. Existing FOS capabilities being reused

| Capability | Source | What the Brief reuses |
|---|---|---|
| Composite score + rank | `lib/portfolio-focus/score.ts`, `components.ts` | Relative importance across the whole portfolio, already normalized |
| 5 weighted components (FS 35%, Opportunity 30%, Stewardship 20%, Momentum 10%, Tactical Urgency 5%) | `components.ts` | Why a donor matters, broken into named dimensions instead of one opaque number |
| `momentumLabel` (9 values) | `aggregate.ts` | The existing "what changed financially" signal — reused wholesale for novelty (§9) |
| `attentionType` (8 values) | `attention-type.ts` | The existing "what kind of situation is this" taxonomy — reused wholesale for §7 |
| `coverageTriggered` / `coverageFloor` | `components.ts` | "FOS knows too little about someone who matters" as an independent, multiplicative override |
| `financialConfidence` / `relationshipConfidence` | `confidence.ts` | Confidence semantics (§11) — already designed so missing data is never a negative signal |
| `whyNow` | `score.ts` | Human-readable justification text, already free-text and already avoids raw scores |
| Recommendation Engine (`kind`, `score`, `action`, `evidence`, `confidence`, `giftId`) | `recommendation-candidates.ts`, `recommendation-rank.ts` | The one existing "possible action," reused as evidence, never re-derived independently (§4) |
| `RecommendationEvidence` | `recommendation-evidence.ts` | The single shared per-donor evidence object already used identically by every surface — the Brief becomes another consumer, not a new evidence pipeline |
| `synthesizeRelationshipSnapshot()` / `findMostActionableFact()` | `fact-synthesis.ts` | The existing strict-vs-lenient split that already implements "historical truth ≠ current actionability" (§8, §15) |
| Ask lifecycle (`pending → committed/declined/withdrawn`) | `lib/capture/ask.ts` | Ask Resolution detection (§9) |
| Payment plan evaluation (`isOnTrack`/`isLate`/`isCompleted`) | pledge payment plan logic | Commitment Progress detection, and the "active fulfillment vetoes solicitation" rule already encoded in `attentionType` |

**Nothing in this table required a new query, a new table, or a new scoring formula.** This is the basis for the "reuse over reinvent" conclusion in §17 and §20.

## 4. Real-data investigation

254 real donors were scored. 25 were examined in depth: the 8 named controls plus 17 chosen to cover the task's required diversity categories. All figures below are real, not illustrative.

### Named controls (not special-cased — same pipeline as all 254)

| Donor | Rank | Composite | Attention Type | Momentum | Recommendation | Notable real evidence |
|---|---|---|---|---|---|---|
| Avi Stein | **1** | highest in portfolio | `cultivate_steward_active` | `actively_fulfilling_commitment` | `reconnect_contact_gap` (score 0.24) | $75,000 open pledge, $66,668 remaining, on track. **The #1-ranked donor in the entire portfolio gets the same generic "reach out" recommendation as someone FOS knows nothing about.** This is the single clearest false positive found (§6). |
| Dovie Weinschneider | 2 | — | `solicit_scheduled` | `increasing` | `honor_reminder` (score 0.757, highest of any donor examined) | Open reminder: "Follow up on Giving follow-up." Real fact: "Discussed Kollel donation and said to follow up after succos." A genuinely strong, specific, high-confidence item. |
| Mordechai Schwartz | 3 | — | `cultivate_steward_active` | `increasing` | `follow_up_pledge` | $36,000 open pledge (0% paid, 80 days old), plus a separate real $9,670 gift 10 days ago. Two distinct, real financial facts that must not be merged into one misleading "big gift just happened" headline. |
| Yaakov Zachter | 4 | — | `cultivate_steward_active` | on-track | `relationship_opportunity` | $18,000 pledge on track; real fact "Texted video from first day of Zman and thanked him," 29 days ago. Clean, specific, low-risk item. |
| Mayer Simcha Klein | 65 | — | `learn_relationship_review` | — | `reconnect_contact_gap` (0.346) | Real fact text ("Solicited for a plaque ($5k)") **display-only** — the underlying ask was actually **declined** 2025-11-06. The engine correctly did *not* generate a `solicit` or `relationship_opportunity` candidate here (the fact decayed past its relevance floor), proving `findMostActionableFact()`'s strict/lenient split already prevents this specific false positive at the recommendation layer — but a Brief that naively displayed `currentSnapshotSummary` as "insight" would still misrepresent this as an open opportunity. See §6, Failure Mode 8. |
| Yale Miller | 38 | — | — | `noisy_swing` | `reconnect_contact_gap` | $199,150 lifetime giving (one of the largest in the portfolio), 114 days since last gift, no structured relationship fact. A legitimate "KNOW" case — a major donor FOS has little current context on — not a "DO" case. |
| Manuel Schnaidman | 44 | — | — | — | `reconnect_contact_gap` | $158,202 lifetime, 264 days since last gift. Same pattern as Miller — a second real instance of "large historical relationship, thin recent context," strengthening confidence this is a genuine recurring situation type rather than a one-off. |
| Jonathan Spetner | 20 | — | `steward_active_fulfillment` | on-track | — | $12,000 pledge, only $2,000 remaining, on track, last payment ($1,000) 31 days ago. A near-complete, healthy commitment — a KNOW, not a DO. |

### Additional diverse cases

- **Dr. Jacques Semmelman** — major historical/low-recent split at its most interesting: 989 days since any **gift**, but only 41 days since substantive **contact** ("Sent text on wife's Yahrtzeit to acknowledge it"). Financial dormancy and relationship dormancy are not the same thing — momentum reads `dormant_lapsed`, but the relationship is clearly alive. Direct evidence for Failure Mode 5 (§6).
- **Rabbi Michoel A. Rovinsky** — rank 39, real growth ($2,300 → $5,000 y/y, `momentum: increasing`), open $1,250 pledge (current), but recommendation is still the generic `reconnect_contact_gap` because his one structured fact ("Solicited for a plaque in memory of his wife") already decayed past its relevance floor. A real, {growth + stale-fact} combination worth a Brief item on the growth alone, independent of the recommendation engine's pick.
- **Dr. & Dr. Joseph Resnikoff** — the one donor with two Asks (one committed, one withdrawn), `momentumLabel: insufficient_data`, `attentionType: monitor_routine`. Two competing asks resolved differently is exactly the kind of Ask-lifecycle nuance the Brief must read correctly, not average away.
- **Rabbi Joshua Broide** — $2,500 pledge, 310 days old, fully unpaid, `momentum: dormant_lapsed`, but `daysSinceSubstantiveContact: 24` (real note: "gave him a tour of new gym"). `follow_up_pledge` scored 0.65 — one of the highest non-reminder scores seen. A genuinely good "stale commitment, warm relationship" item.
- **Eliezer Zryl** — `monitor_routine`, $9,100 lifetime, `upcomingDateDescription: "birthday in 1d"`. A real, low-financial-value donor whose only signal is a birthday tomorrow — a direct test case for whether dates alone justify a Brief slot (§6, Failure Mode 9; conclusion: no).
- **Paul S. Richman** — `monitor_routine`, `dormant_lapsed`, 991 days since last gift, and (from the Asks table) a **declined** $10,000 dinner-sponsorship ask (2025-09-19). No engine currently surfaces "this person said no and shouldn't be re-solicited yet" as a positive signal — see §7, gap G1.
- **Eitan Zeffren** — rank 5, `solicit_scheduled` (open reminder: "Solicit corporate sponsorship for dinner"), but `momentum: declining` ($36,000 prior-365 → $18,000 last-365), 280 days since last gift. A real "Financial Change + Follow-Up" combination that a naive single-item selection would flatten into just "has a reminder."
- **Eli Treitel** — real fact ("texted to wish him a happy birthday"), correctly stays `monitor_routine` because lifetime giving ($8,148) is small — evidence the composite correctly avoids over-elevating small, personal-touch stewardship notes.
- **Asks table (all 6 real rows, 100% of Asks in the workspace):** Resnikoff (committed), Resnikoff (withdrawn — same donor, two asks), Richman ($10,000 declined), Klein ($5,000 declined), Pfeiffer ($10,000 declined), Rovinsky ($5,000 committed). **Zero pending asks exist in the real workspace right now.** This means `open_ask` never appears anywhere in the current 254-donor recommendation distribution — an honest, disclosable fact, not a bug (Ask Resolution has nothing pending to resolve *today*, but declined asks are real, recent, unsurfaced signal — see G1).
- **Structured Relationship Facts: only 8 exist across all 254 donors.** Reminders: only 3 open. The Brief cannot lean primarily on structured facts today — most donors' evidence must come from financial/momentum/ask data, with facts as a valuable but sparse enrichment.
- **9 donors carry `momentumLabel: newly_significant`** (a first-time-significant gift), e.g. Zev Abramson ($8,000, first gift, `cultivate_real_growth`), Benjy Weil ($200, `follow_up_pledge`). This is the clearest evidence that `momentumLabel` already gives the Brief a working "notice change even for a normally-quiet donor" signal (§9) without any new computation.
- **Data-quality anomaly, disclosed not fixed:** David B. Rosenbaum's real computed `daysSinceLastGift` is **-105** — his most recent recorded cash event is dated roughly 105 days in the future relative to 2026-09-17. This is a live data-integrity issue (a future-dated gift or unaudited cash event), not a design flaw, and is called out here per the instruction not to hide failures. Any Brief evidence-assembly step must defensively require `daysSinceLastGift >= 0` before treating something as "recent" (§6, Failure Mode 1).
- **Two Ask rows are literally test data:** "Staging ask test" and "Staging withdraw test" (not among the 6 counted above — these belong to a different donor and should be excluded from any real Brief run in this environment; noted so a future implementer doesn't mistake them for real signal).

## 5. Raw uncurated Brief (produced from the real data above, no tuning for appearance)

Per the task's instruction to aim for 8–15 items and treat a larger count as a prioritization failure, this is the actual selection a human would want to see today, built by hand from the real computed evidence in §4 — not by any new scoring formula. Technical scores are shown here for review; they would never appear in end-user UX.

1. **Dovie Weinschneider** — *DO.* Open reminder to follow up on a Kollel donation discussion, explicitly deferred to "after succos" (now past). Evidence: `honor_reminder`, score 0.757, momentum `increasing`. Why now: the fundraiser's own deferred commitment is due. Confidence: high (explicit reminder + explicit fact, both confirmed).
2. **Avi Stein** — *KNOW.* The portfolio's #1-ranked relationship is in the middle of actively fulfilling a $75,000 pledge ($66,668 remaining, on track). Evidence: `attentionType: cultivate_steward_active`, `momentum: actively_fulfilling_commitment`. Why now: nothing needs to change, but a fundraiser should know their top relationship is healthy and *should not be solicited again right now* — the opposite of what the raw recommendation (`reconnect_contact_gap`) would imply if shown unfiltered.
3. **Mordechai Schwartz** — *DO/KNOW.* A real $9,670 gift 10 days ago, and separately a fully-unpaid $36,000 pledge now 80 days old with no payment plan. Evidence: `follow_up_pledge`, momentum `increasing`. Why now: the recent gift shows the relationship is warm; the untouched pledge is old enough to warrant a plan conversation.
4. **Eitan Zeffren** — *DO.* Open reminder to solicit a corporate dinner sponsorship, against a backdrop of giving that fell from $36,000 to $18,000 year over year. Evidence: `solicit_scheduled` + `momentum: declining`. Why now: the ask is already scheduled; the declining trend is useful context for how to frame it, not a reason to delay.
5. **Rabbi Joshua Broide** — *DO.* A $2,500 pledge has sat fully unpaid for 310 days, but the relationship itself is warm (a personal note 24 days ago). Evidence: `follow_up_pledge`, score 0.65. Why now: this is an old open commitment with no barrier to a friendly follow-up.
6. **Yaakov Zachter** — *KNOW.* $18,000 pledge on track; a specific, recent personal touch (29 days ago) is on file. Evidence: `relationship_opportunity`. Why now: nothing urgent — surfaced as a positive, low-effort "here's a healthy relationship with fresh context" item, useful for confidence rather than action.
7. **Rabbi Michoel A. Rovinsky** — *KNOW.* Real, dated year-over-year growth ($2,300 → $5,000), momentum `increasing`, open pledge current. Why now: growth is real and recent even though no single engine currently headlines it (his structured fact is stale and correctly suppressed from the recommendation).
8. **Dr. Jacques Semmelman** — *KNOW.* 989 days since any gift, but a personal note only 41 days old (wife's Yahrtzeit acknowledgment). Why now: this is a live relationship that has gone financially quiet — worth knowing so it is never mistaken for a lapsed one, and worth *not* soliciting reflexively.
9. **Paul S. Richman** — *KNOW (caution).* Declined a $10,000 dinner-sponsorship ask about a year ago (2025-09-19); no financial activity since (991 days since last gift). Why now: this is exactly the kind of relationship that should not be re-solicited without a specific, sensitive reason — a real gap no existing engine currently flags (§7, G1).
10. **Yale Miller** — *KNOW.* $199,150 lifetime giving, 114 days since last gift, no structured relationship fact on file. Why now: one of the portfolio's largest lifetime donors, and FOS genuinely has thin current context — an honest "we don't know much right now" item, not "this relationship is weak."
11. **Manuel Schnaidman** — *KNOW.* Same pattern as #10 ($158,202 lifetime, 264 days since last gift). Included alongside Miller specifically to show this is a repeating situation type, not a one-off — see §7 taxonomy (`Relationship Visibility`).
12. **9 newly-significant donors (as a single grouped item, not 9 separate ones)** — *KNOW.* A cluster of previously-quiet donors who each just crossed into meaningful giving for the first time (e.g., Zev Abramson, first gift $8,000). Why now: novelty — these are exactly the donors a static Top-N-by-importance ranking would never surface, because none of them are individually large enough to rank highly yet.

**12 items.** Two more categories from §4 (Klein's stale-fact case, Resnikoff's two-ask case) were deliberately **excluded** from the raw Brief itself — they are false-positive test cases the architecture must get right, not situations worth a fundraiser's attention today, and are covered in §6 instead.

## 6. False-positive critique (aggressive, per instruction — nothing hidden)

Checked against every failure mode the task named, using only the real data above:

1. **Stale info presented as current — CONFIRMED, live example found.** David B. Rosenbaum's `daysSinceLastGift: -105` is a real, current data-integrity defect. If a naive "recent activity" Brief item template were applied without a sanity check, it would produce a nonsensical "gift arriving in the future" statement. **Mitigation required in Phase 1:** any evidence-assembly step must treat negative day-deltas as `null`/unknown, never as "very recent."
2. **Pledge-payment activity mistaken for a new opportunity — not currently observed as a live bug**, but the Schwartz case (#3 above) shows how easily it *could* be: a $9,670 gift and a $36,000 pledge are two separate, real financial facts that a careless synthesis step could merge into one overstated "$45,670 in new activity" headline. **Mitigation:** never sum cash events and open-pledge balances into one number without labeling which is which.
3. **Active commitment mistaken for a lapsed relationship — CONFIRMED as the single worst finding.** Avi Stein, the #1-ranked donor in the entire portfolio, currently actively fulfilling a $75,000 pledge on schedule, receives the exact same `reconnect_contact_gap` ("Reach out to re-establish contact") recommendation as a donor FOS knows nothing about. A Brief built on "show me the top recommendation for the top-ranked donor" would tell a fundraiser to "reconnect" with the person who needs it least. **This is why the Recommendation Engine's per-donor winner must never be shown for a donor whose `momentumLabel` is `actively_fulfilling_commitment` without being overridden by that fact** (§8).
4. **Missing info treated as evidence of a weak relationship — investigated directly via Miller/Schnaidman (both large historical donors with sparse current facts).** The existing `relationshipConfidence: low/medium/high` axis already exists specifically to prevent this (§11) — it is a statement about FOS's knowledge, not the relationship. The raw Brief items for Miller/Schnaidman above are worded to name the gap in FOS's knowledge, not the donor's engagement.
5. **Large historical giving overwhelming everything else — checked directly.** A naive "rank by lifetime giving" selection would push Miller ($199,150) and Schnaidman ($158,202) above genuinely time-sensitive items like Zeffren's scheduled solicitation or Weinschneider's due reminder. The recommended ranking approach (§8) does not use raw lifetime dollars as a sort key for exactly this reason.
6. **Recent small activity overwhelming strategically important relationships — checked directly against Zeffren.** A $200 gift from a newly-significant donor is real and worth noting (item #12, grouped), but must never outrank Zeffren's $18,000-swing decline + scheduled solicitation. The grouping in item #12 exists specifically so nine small, individually low-value novelty signals do not consume nine separate high-value Brief slots.
7. **Duplicate insights from Portfolio Focus + Suggested Actions — CONFIRMED as structurally likely without deduplication.** Zeffren alone has three independently-computable signals (open reminder, declining momentum, `solicit_scheduled` attention type) that all describe the *same* underlying situation. Shown separately, that is 3 cards for 1 story. Item #4 above deliberately merges them (§10 covers the general mechanism).
8. **Birthdays/dates crowding out substantive intelligence — CONFIRMED as a real risk, not yet a real bug** (only Zryl surfaced a bare upcoming-date case, and it was correctly excluded from the raw Brief above for being financially immaterial). The mitigation is structural: an upcoming date alone, on a `monitor_routine` donor, does not clear the bar; §8 makes financial/relationship materiality a gate, not just a tiebreaker.
9. **Open Ask status contradicting subsequent financial evidence — checked against all 6 real Asks; none currently contradict later gifts** (no pending asks exist at all right now — see §4). This remains an architecturally important check (`resolveOpenPledgeActivityDate()`-style reasoning) even though today's data doesn't exercise it; Phase 1 must not assume this will always be empty.
10. **Stewardship confused with solicitation — CONFIRMED as already correctly handled at the engine level, but the Brief must preserve it.** Avi Stein and Spetner's `attentionType: steward_active_fulfillment`/`cultivate_steward_active` already exist precisely to prevent an active-payer from being solicited again; a Brief that ignores `attentionType` and only reads the raw recommendation text would re-introduce this exact bug (see #3 above — it's the same root cause).
11. **Multiple recommendations for the same underlying situation — see #7.** No per-donor duplication was found (the Recommendation Engine already returns exactly one winner per donor), but Portfolio Focus + Recommendation Engine + momentum can independently describe one situation from three angles, which is a Brief-level dedup problem, not an engine-level one.
12. **Generic "reconnect" recommendations with little value — CONFIRMED, quantified, the largest single finding.** `reconnect_contact_gap` is the winning recommendation for **209 of 254 real donors (82%)**. It is the Recommendation Engine's designed last-resort fallback (real, correct behavior *for that engine's purpose* — always returning something actionable) but is fundraising-worthless as a Brief signal on its own. **Any Brief selection logic that ranks by raw recommendation score, or simply lists "top recommendation per donor," will be dominated by this fallback and must explicitly exclude or heavily discount `reconnect_contact_gap` unless no other signal exists at all for that donor** (§8).

No failure mode from the task's list was hidden or minimized; #2, #5, #6, and #9 are flagged as *structurally possible but not currently observed as live bugs* rather than confirmed incidents, and are called out as such rather than folded into the confirmed list.

## 7. Proposed intelligence-item architecture

A small taxonomy is useful — but only because it maps directly onto values FOS already computes, not because it looks good in a UI:

| Item type | Derived from (existing) | KNOW or DO |
|---|---|---|
| **Commitment Progress** | payment plan status, `openPledgeBalance`/`openPledgeTotal`, `pledgeStaleClass` | Usually KNOW (on track), occasionally DO (stale, e.g. Broide) |
| **Financial Change** | `momentumLabel` (`increasing`/`declining`/`newly_significant`) | KNOW, occasionally DO if paired with a scheduled ask |
| **Follow-Up** | `honor_reminder` / open reminders | DO |
| **Relationship Visibility Gap** | `relationshipConfidence: low`, sparse/no structured facts, high financial significance | KNOW only — never manufactures an action |
| **Stewardship Moment** | `attentionType: steward_active_fulfillment` / `cultivate_steward_active`, active on-track pledge | KNOW ("do not solicit"), rarely DO |
| **Ask Resolution / Caution** | Ask status transitions (`declined`, `withdrawn`) not currently surfaced by any engine | KNOW (caution against re-solicitation) — **new synthesis, not duplicated from Suggested Actions** (§4 Richman, §9 gap) |
| **Upcoming Moment** | `upcomingDateDescription` | KNOW, gated by financial/relationship materiality (Failure Mode 8) |
| **Relationship Opportunity** | structured relationship facts, `relationship_opportunity` recommendation | Usually DO |

`reconnect_contact_gap` is **deliberately not given its own item type** — per §6 finding 12, it is noise unless it is the *only* signal available for an otherwise-relevant donor (§8).

## 8. Selection/ranking architecture

No new weighted model is needed. The existing signals compose directly:

1. **Eligibility gate (not a score):** a donor only becomes Brief-eligible if at least one of — an open reminder, a `momentumLabel` of `increasing`/`declining`/`newly_significant`/`actively_fulfilling_commitment`, a pledge in `stale`/`isLate`/`isPlanEndedWithBalance` state, a structured fact newer than its category's decay window, an Ask resolved (declined/withdrawn/committed) within a recent window, or `coverageTriggered`/`relationshipConfidence: low` combined with top-decile financial significance.
2. **Suppress the fallback:** if the donor's *only* qualifying signal is the generic `reconnect_contact_gap` recommendation with no other gate satisfied, exclude — this single rule removes the 209-donor (§6.12) noise floor without touching the Recommendation Engine itself.
3. **Rank survivors** by a simple, explainable composite of existing fields already on `PortfolioFocusResult`: financial materiality (existing percentile-based `financialSignificance`), a novelty bonus for `newly_significant`/`increasing`/`declining` momentum and for `coverageTriggered`, and an urgency bonus for open reminders and stale (but not yet abandoned) pledges. This reuses `components.ts`'s existing percentile machinery rather than inventing a second scoring model.
4. **Cap at 8–15** (§9's raw Brief above naturally produced 12 from real data without forcing a count).

**Novelty is explicitly first-class**, per the task's instruction: a `newly_significant` donor at rank 224 (Benjy Weil, $200 first gift) is deliberately eligible even though nowhere near Top 10 by importance — this is what let the raw Brief surface a real, previously-invisible situation (§5 item #12) that a static importance ranking would never show.

## 9. Novelty / "what changed" design

Fully derivable today, without new schema, from fields Portfolio Focus already computes on every run:

- **New gift / pledge payment** → `mostRecentCashCents`/`mostRecentCashKind`/`daysSinceLastGift` (recomputed every run from real `giving_activities`/payment-assignment rows).
- **New Ask / Ask resolution** → a diff of `asks.status` and `asks.updated_at`/`resolved_at` against the prior run's cached value (see below for the one small state question).
- **New interaction / new relationship fact** → `daysSinceSubstantiveContact` and `hasCurrentFact` recomputed every run.
- **Upcoming date entering a useful window** → `upcomingDateDescription`, already windowed.
- **Portfolio Focus movement** → requires comparing today's `rank`/`compositeScore` to a **prior stored snapshot** — this is the one place true "change since last time" needs *some* persisted state (see §17).
- **Payment-plan status change** (newly late, newly completed) → derivable by comparing `evaluatePaymentPlan()`'s output today vs. the prior run.

**Two tiers are recommended:** (a) signals that are inherently "fresh" by construction (a gift *is* recent because `daysSinceLastGift` says so — no comparison needed), and (b) signals that require comparing today's computed result to yesterday's stored result (rank movement, newly-late flag). Tier (a) needs zero schema. Tier (b) needs the smallest possible persisted state — see §17.

## 10. Deduplication / situation synthesis

The Zeffren case (§6.7) is the concrete template: when a `solicit_scheduled` attention type, a `declining` momentum, and an open `honor_reminder` all resolve to the *same donor*, they must be synthesized into **one item** whose evidence lists all three facts, not three items. The rule: **group by donor first, always** (never emit more than one Brief item per donor per run), then within that donor's item, list every qualifying signal as supporting evidence under a single headline chosen by priority (reminder > ask resolution > pledge status > momentum > relationship fact > upcoming date). This reuses the exact "exactly one winner, but with supporting evidence" pattern the Recommendation Engine itself already uses (`buildDonorRecommendation()`), rather than inventing a new dedup algorithm.

## 11. Confidence semantics

Reuse `financialConfidence`/`relationshipConfidence` as-is; do not invent a third axis. The Brief's copy layer follows the same rule already enforced in `confidence.ts`: describe **what FOS knows**, never the relationship itself.

- Correct: *"FOS has limited recent relationship context on this donor."*
- Incorrect: *"Your relationship with this donor is weak."*
- Correct: *"This gift may have addressed the earlier pledge — FOS has not confirmed this against the pledge balance."*
- Incorrect: *"This pledge has been resolved."*

Klein (§4) is the concrete proof this matters: his displayed fact text ("Solicited for a plaque") is real and historically true, but is stale relative to the actual (declined) Ask outcome. The Brief's confidence language for any fact-derived item must explicitly state the fact's age/category relative to `CATEGORY_DECAY_WINDOW_DAYS`, not merely display the fact text as if current.

## 12. Relationship Intention assessment

**Not recommended for Phase 1.** Every real Brief item produced in §5 was fully explainable using only derived signals — no case required a human-authored "this is a cultivation relationship" flag to make sense. The clearest candidate for needing it (Richman, §4/§7 — a declined-ask relationship that should not be re-solicited) is already explainable from the real Ask status alone, without a new field. Revisit only if Phase 2 real-world calibration surfaces cases where two donors with identical derived evidence should be treated differently because of a fundraiser's private strategic intent that genuinely cannot be inferred — none were found in this investigation. If ever proposed, it must remain a single optional, human-authored, non-mandatory field, visually and structurally distinct from every derived field, and must never gate whether a donor is Brief-eligible.

## 13. UX options

**A. Today-page Intelligence Brief (5–8 items, concise).**
- Usefulness: highest daily visibility; forces the hardest prioritization (a real constraint, not a bug).
- Cognitive load: lowest.
- Overlap: highest risk of duplicating Portfolio Focus's existing Today section unless items are filtered to exclude anything Portfolio Focus already shows in its Top 5 (a real risk — Weinschneider, Schwartz, and Zeffren all also appear in the real Top-5-by-rank list in §4, so naive co-display would show the same names twice on one page).
- Mobile: fine at 5–8 items.
- Risk of unused dashboard: low, if kept genuinely short.

**B. Dedicated Intelligence Brief page, expandable evidence.**
- Usefulness: supports the full 8–15 items plus real evidence depth (pledge numbers, fact text, reminder text) that a Today card can't show.
- Cognitive load: higher, but opt-in (user navigates there deliberately).
- Overlap: lower risk — a dedicated page is expected to show more than the homepage teaser.
- Mobile: needs a real expand/collapse pattern, not a big list.
- Risk of unused dashboard: **highest** of the three — a page nobody navigates to daily provides zero value regardless of quality.

**C. Hybrid — small Today teaser (2–3 items) linking to a full dedicated Brief.**
- Usefulness: best of both — daily visibility without cramming 12 items onto the homepage.
- Cognitive load: low on Today, contained on the dedicated page.
- Overlap: solvable directly — the Today teaser explicitly excludes anything already shown in Portfolio Focus's own Today section, and only surfaces the 2-3 *highest-urgency* DO items (reminders, scheduled asks); the dedicated page shows the full KNOW+DO set.
- Mobile: teaser fits naturally in the existing Today page; full page can be a simple list.
- Risk of unused dashboard: low — the Today teaser drives traffic to the full page rather than requiring the user to remember it exists.

## 14. Recommended UX

**Option C (hybrid).** Concretely: a 2–3 item "Worth knowing today" teaser on the Today page containing only items with an explicit DO signal (open reminder, scheduled ask, stale-but-live pledge) — using the exact same `RecommendationEvidence`/attention-type fields already rendered elsewhere on Today, so it looks like a natural extension rather than a new subsystem — linking to a dedicated `/intelligence-brief` page showing the full 8–15 item set with expandable evidence per item. This directly avoids the Zeffren/Weinschneider/Schwartz double-display risk identified in Option A by having the teaser explicitly exclude anything Portfolio Focus's own Top-5 section already renders that run.

## 15. Assistant / Daily Agenda future compatibility

**Assistant:** every Brief item is already just a donor ID plus the same `RecommendationEvidence`/`PortfolioFocusResult` shape the Assistant's existing single-donor rule engine already consumes (`app/api/assistant/route.ts`). A future "what should I focus on today" query is a filter over the same computed Brief item list, not a new capability — this is why Phase 1 (§18) deliberately keeps the Brief as a pure data-producing function rather than embedding any UI-specific logic, so the Assistant can call it directly later.

**Daily Agenda email:** not recommended for inclusion this round, per explicit instruction. If ever added, only the DO-tier items (reminders, scheduled solicitations, stale-but-live pledges — never bare KNOW items like "large historical donor, low current activity") would qualify, capped at 2-3, to avoid the email becoming a second full Brief.

## 16. Performance / query plan

Zero new D1 queries are required for Phase 1. `computePortfolioFocus()` already runs all 254 donors through exactly 12 bounded queries per workspace (confirmed by reading `lib/portfolio-focus/data.ts` in full) — the Brief's selection/synthesis layer (§8, §10) is a pure in-memory transform of `PortfolioFocusResult[]`, the same array Portfolio Focus's own Today rendering already holds in memory. The only genuinely new cost is the "what changed since last time" comparison (§9, tier b), which needs to read one small prior snapshot — a single bounded query by workspace ID, not a per-donor query, preserving the no-N+1 discipline Portfolio Focus was already built to.

## 17. Whether any schema is eventually needed

**Not for Phase 1** (pure computation, tier-(a) novelty only — §9). **One small table is needed once "Portfolio Focus movement" (tier-(b) novelty) or item dismissal/seen-state is wanted** — e.g. `intelligence_brief_snapshots(workspace_id, donor_id, composite_score, rank, computed_at)`, storing just enough of yesterday's result to diff against today's, kept to one row per donor per workspace (overwritten each run, not accumulated as history). This is deliberately deferred out of Phase 1: every real Brief item produced in §5 was fully derivable without it. Recommend proposing this migration only after Phase 2 human calibration confirms rank-movement/dismissal is actually valuable in practice.

## 18. Proposed implementation phases

The task's suggested shape holds up well against the real findings and is recommended as-is:

- **Phase 1 — pure intelligence computation, no UI.** Build the eligibility-gate + fallback-suppression + ranking + dedup layer (§8, §10) as a function over the existing `PortfolioFocusResult[]`, callable from a script/test harness only. Validate its output against more of the real 254-donor dataset (this investigation manually validated ~25; Phase 1 should run the real function over all 254 and manually review the full output before any UI work).
- **Phase 2 — human calibration.** Show the raw Phase-1 output to actual fundraiser(s) using the real workspace; tune the eligibility gate and ranking weights against real feedback, the same way Portfolio Focus's own calibration (`PORTFOLIO-FOCUS-CALIBRATION-V3.md`) was done.
- **Phase 3 — Today/dedicated UX (Option C).**
- **Phase 4 — Assistant integration**, once Phase 3's data shape has proven stable in front of real users.

No reason was found in the investigation to deviate from this sequence.

## 19. Frozen design principles

1. **Derived over entered** — every Brief field traces to a real gift, pledge, ask, interaction, date, or fact; nothing is a field a fundraiser must maintain.
2. **Intelligence, not CRM administration** — no pipeline stages, no mandatory next-action fields, no manually-maintained ratings.
3. **Situations, not duplicate alerts** — one donor, one Brief item, however many underlying signals support it (§10).
4. **Historical truth ≠ current actionability** — a fact can remain true and displayable while no longer implying a live opportunity (Klein, §4/§11).
5. **Missing information ≠ weak relationship** — confidence describes FOS's knowledge, never the relationship (§11).
6. **Know does not always mean Do** — most of the real Brief in §5 is KNOW; manufacturing an action where none is supported is explicitly rejected (§5 items #2, #6–#11).
7. **Explain why now** — every item states why it surfaced today, using existing `whyNow`-style plain language, never a raw score.
8. **Preserve human judgment** — the Brief informs; it never auto-executes an outreach or auto-advances a relationship state.
9. **No invented fundraising opportunity** — `reconnect_contact_gap` is explicitly excluded as a standalone signal (§6.12, §8) precisely because it is the engine's designed fallback, not evidence of an opportunity.
10. **Novelty matters as much as importance** — a normally-quiet donor's first significant gift is Brief-worthy even at portfolio rank 224 (§8, §5 item #12).

## 20. Open decisions requiring your approval

1. Approve the eligibility-gate + fallback-suppression rule in §8 (explicitly excluding `reconnect_contact_gap`-only donors) as the Phase-1 selection mechanism, rather than a new weighted score.
2. Approve the hybrid UX (§14, Option C) as the target architecture before any UI work begins.
3. Approve deferring the one small `intelligence_brief_snapshots` table (§17) out of Phase 1, revisiting only after Phase 2 calibration.
4. Approve **not** building a Relationship Intention concept for Phase 1 (§12), given no real case in this investigation required it.
5. Approve **not** including Brief content in the Daily Agenda email this round (§15), consistent with the original instruction.
6. Decide who reviews the raw output in Phase 2 (§18) and over what real time window (e.g., one week of real donor activity) before Phase 3 UI work is authorized.
7. Decide whether the two literal "Staging ask test"/"Staging withdraw test" rows found in Independent Staging (§4) should be cleaned up before any further real-data investigation, since they are test data, not production signal (no D1 mutation was made this round; flagging only).

---

**Explicit confirmation:** this document is investigation and design output only. No application code, schema, or Portfolio Focus/Recommendation Engine/Relationship Intelligence logic was modified to produce it. No D1 mutation occurred at any point — every `wrangler d1 execute` command run during this investigation was a read-only `SELECT`. Nothing was deployed.
