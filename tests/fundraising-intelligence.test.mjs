import assert from "node:assert/strict";
import { buildPortfolioContext } from "../lib/portfolio-focus/context.ts";
import { scorePortfolioFocus, scorePortfolioFocusDonor } from "../lib/portfolio-focus/score.ts";
import { buildFundraisingIntelligenceBrief, selectWithKnowReservation, isReservedKnowEligible, DEFAULT_RESERVED_KNOW_SLOTS } from "../lib/fundraising-intelligence/index.ts";
import { safeDays } from "../lib/fundraising-intelligence/situations.ts";

// Fundraising Intelligence Brief -- Phase 1 tests. Fixtures reuse the
// REAL, documented regression profiles already established in
// tests/portfolio-focus-regression.test.mjs (Spetner, Stein) plus
// realistic-shaped profiles matching the real numbers found in the
// live-data investigation (docs/FUNDRAISING-INTELLIGENCE-BRIEF-DESIGN.md
// §4) for Klein, Schwartz, Miller, Schnaidman, Weinschneider, Richman,
// Zryl, and Rosenbaum -- never hardcoded by name inside the production
// module itself (lib/fundraising-intelligence/*.ts never references a
// donor name or id).

const NOW = Math.floor(Date.parse("2026-09-17T12:00:00Z") / 1000);
const DAY = 86400;
const dollars = (d) => d * 100;

function donor(overrides) {
  return {
    donorId: "x", displayName: "x", donorCode: null,
    lifetimeCents: 0, last365Cents: 0, prior365Cents: 0, distinctActivityYears: 0,
    historicalPeakGiftCents: null, historicalPeakCommitmentCents: null,
    mostRecentCashKind: null, mostRecentCashCents: null, daysSinceLastGift: null,
    openPledgeBalanceCents: null, openPledgeTotalCents: null, openPledgeCategory: null,
    pledgeAgeDays: null, pledgeCommitmentAgeDays: null, pledgePlanOnTrack: null,
    askHistoryCount: 0, hasOpenReminder: false, openReminderAction: null,
    lastInteractionDaysAgo: null, daysSinceSubstantiveContact: null,
    hasCurrentFact: false, hasActionableFact: false, hasUnconfirmedHistoricalContext: false,
    currentSnapshotSummary: null, upcomingDateDescription: null,
    recommendation: null,
    ...overrides,
  };
}

// Same realistic-shaped background population as the Portfolio Focus
// regression suite, so percentile-based gates (financialSignificance
// >= 0.5 / 0.75) behave non-degenerately.
function backgroundDonors() {
  return [
    donor({ donorId: "bg1", lifetimeCents: dollars(500), distinctActivityYears: 1 }),
    donor({ donorId: "bg2", lifetimeCents: dollars(1200), distinctActivityYears: 2 }),
    donor({ donorId: "bg3", lifetimeCents: dollars(3600), distinctActivityYears: 3 }),
    donor({ donorId: "bg4", lifetimeCents: dollars(9000), distinctActivityYears: 4 }),
    donor({ donorId: "bg5", lifetimeCents: dollars(21000), distinctActivityYears: 8, historicalPeakGiftCents: dollars(5000) }),
    donor({ donorId: "bg6", lifetimeCents: dollars(45000), distinctActivityYears: 10, historicalPeakCommitmentCents: dollars(18000), prior365Cents: dollars(2800), last365Cents: dollars(7300) }),
    donor({ donorId: "bg7", lifetimeCents: dollars(71000), distinctActivityYears: 3, historicalPeakCommitmentCents: dollars(75000), prior365Cents: dollars(20000), last365Cents: dollars(27083) }),
    donor({ donorId: "bg8", lifetimeCents: dollars(102000), distinctActivityYears: 23, historicalPeakGiftCents: dollars(36000), prior365Cents: dollars(13080), last365Cents: dollars(36000) }),
    donor({ donorId: "bg9", lifetimeCents: dollars(110000), distinctActivityYears: 17, historicalPeakGiftCents: dollars(14400), prior365Cents: dollars(11350), last365Cents: dollars(22050) }),
    donor({ donorId: "bg10", lifetimeCents: dollars(199150), distinctActivityYears: 54, historicalPeakGiftCents: dollars(25000), prior365Cents: dollars(1800), last365Cents: dollars(3600) }),
  ];
}

// Scores one probe donor against the realistic background (the same
// pattern tests/portfolio-focus-regression.test.mjs already uses) and
// runs it through the Brief in isolation.
function briefForOne(probe, asks = [], facts = []) {
  const bg = backgroundDonors();
  const ctx = buildPortfolioContext(bg, [dollars(500), dollars(1200), dollars(3600), dollars(9000), dollars(18000), dollars(36000), dollars(75000)]);
  const result = { ...scorePortfolioFocusDonor(probe, ctx), rank: 1 };
  const asksByDonor = new Map(asks.length ? [[probe.donorId, asks]] : []);
  const factsByDonor = new Map(facts.length ? [[probe.donorId, facts]] : []);
  return buildFundraisingIntelligenceBrief([probe], [result], asksByDonor, factsByDonor, NOW);
}

function ask(overrides) {
  return { id: "ask1", donor_id: "x", amount_cents: null, purpose: null, status: "pending", asked_at: NOW, source_interaction_id: null, ...overrides };
}
function fact(overrides) {
  return { donor_id: "x", category: "general", lifecycle: "durable", status: "current", fact_text: "x", source_interaction_id: null, source_interaction_occurred_at: NOW, ...overrides };
}

const SCORE_LIKE_PATTERN = /\b0\.\d{2,4}\b/;
function assertNoRawScoreInText(item) {
  for (const field of [item.headline, item.explanation, item.whyNow, item.whatFosDoesNotKnow ?? "", item.possibleAction ?? ""]) {
    assert.ok(!SCORE_LIKE_PATTERN.test(field), `end-user text must never contain a raw decimal score: "${field}"`);
  }
}

async function run() {
  // ---------------- 1. Generic reconnect fallback alone does not qualify ----------------
  {
    const d = donor({ donorId: "generic", lifetimeCents: dollars(5000), daysSinceLastGift: 400, recommendation: { kind: "reconnect_contact_gap", score: 0.2375, action: "Reach out to re-establish contact." } });
    const brief = briefForOne(d);
    assert.equal(brief.items.length, 0, "a donor whose only engine output is the generic reconnect fallback must not appear in the Brief");
    assert.equal(brief.rejected[0].suppressionReason, "reconnect_fallback_only_no_independent_situation");
  }

  // ---------------- 2. A meaningful reconnect-flavored situation CAN still qualify, via independent evidence (Yale Miller / Manuel Schnaidman shape) ----------------
  {
    const miller = donor({
      donorId: "miller", lifetimeCents: dollars(199150), last365Cents: 0, prior365Cents: 0,
      distinctActivityYears: 20, historicalPeakGiftCents: dollars(40000), daysSinceLastGift: 114,
      hasCurrentFact: false, daysSinceSubstantiveContact: null,
      recommendation: { kind: "reconnect_contact_gap", score: 0.24, action: "Reach out to re-establish contact." },
    });
    const brief = briefForOne(miller);
    assert.equal(brief.items.length, 1, "a large historical donor with thin current relationship context must independently qualify");
    assert.equal(brief.items[0].situationType, "relationship_visibility");
    assert.equal(brief.items[0].disposition, "KNOW");
    assert.equal(brief.items[0].possibleAction, null, "relationship_visibility must never invent an action");
    assert.ok(brief.items[0].explanation.includes("FOS has limited recent relationship context"), "must use the neutral, knowledge-describing phrase");
  }

  // ---------------- 3. Active on-track pledge suppresses a generic reconnect/solicitation DO (Avi Stein shape, real documented fixture) ----------------
  {
    const stein = donor({
      donorId: "stein", lifetimeCents: dollars(71332), last365Cents: dollars(27083), prior365Cents: dollars(20000),
      distinctActivityYears: 3, historicalPeakGiftCents: dollars(25000), historicalPeakCommitmentCents: dollars(75000),
      openPledgeBalanceCents: dollars(66668), openPledgeTotalCents: dollars(75000), openPledgeCategory: "partially_paid_pledge",
      pledgeAgeDays: 12, pledgeCommitmentAgeDays: null, pledgePlanOnTrack: true,
      lastInteractionDaysAgo: 8,
      recommendation: { kind: "reconnect_contact_gap", score: 0.2375, action: "Reach out to re-establish contact." },
    });
    const brief = briefForOne(stein);
    assert.equal(brief.items.length, 1, "Stein must produce exactly one Brief item");
    assert.equal(brief.items[0].situationType, "stewardship_moment");
    assert.equal(brief.items[0].disposition, "KNOW", "an actively-fulfilling top relationship must be KNOW, never a solicitation/reconnect DO");
    assert.equal(brief.items[0].possibleAction, null);
  }

  // ---------------- 4. Explicit reminder qualifies (Dovie Weinschneider shape) ----------------
  {
    const weinschneider = donor({
      donorId: "weinschneider", lifetimeCents: dollars(20000), hasOpenReminder: true,
      openReminderAction: "Follow up on Giving follow-up.",
      recommendation: { kind: "honor_reminder", score: 0.757, action: "Follow up on Giving follow-up." },
    });
    const facts = [fact({ donor_id: "weinschneider", category: "commitment_followup", lifecycle: "follow_up", fact_text: "Discussed Kollel donation and said to follow up after succos." })];
    const brief = briefForOne(weinschneider, [], facts);
    assert.equal(brief.items.length, 1);
    assert.equal(brief.items[0].situationType, "explicit_follow_up");
    assert.equal(brief.items[0].disposition, "DO");
    assert.ok(brief.items[0].possibleAction, "an explicit follow-up must always carry a concrete action");
  }

  // ---------------- 5/6. Declined and withdrawn Asks must never surface as an opportunity (Mayer Simcha Klein / Paul Richman shape) ----------------
  {
    for (const status of ["declined", "withdrawn"]) {
      const d = donor({ donorId: `ask-${status}`, lifetimeCents: dollars(8250) });
      const asks = [ask({ donor_id: `ask-${status}`, status, amount_cents: dollars(10000), purpose: "Dinner sponsorship", asked_at: NOW - 300 * DAY })];
      const facts = [fact({ donor_id: `ask-${status}`, category: "solicitation", lifecycle: "time_bound", fact_text: `Solicited for a ${status} ask ($100)`, source_interaction_occurred_at: NOW - 300 * DAY })];
      const brief = briefForOne(d, asks, facts);
      assert.equal(brief.items.length, 1, `a ${status} ask must still surface as a KNOW caution item, not silently vanish`);
      assert.equal(brief.items[0].situationType, "ask_resolution");
      assert.equal(brief.items[0].disposition, "KNOW");
      assert.equal(brief.items[0].possibleAction, null, `a ${status} ask must never carry a solicitation-flavored action`);
      assert.ok(!/is an opportunity|represents an opportunity|open opportunity for/i.test(brief.items[0].explanation + brief.items[0].whyNow), `a ${status} ask must never be affirmatively described as an opportunity`);
    }
  }

  // ---------------- 7. A committed Ask does not, by itself, produce an ask_resolution item (documented Phase 1 limitation) ----------------
  {
    const d = donor({ donorId: "committed", lifetimeCents: dollars(17336) });
    const asks = [ask({ donor_id: "committed", status: "committed", amount_cents: dollars(5000), purpose: "Plaque", asked_at: NOW - 350 * DAY })];
    const brief = briefForOne(d, asks);
    assert.equal(brief.items.length, 0, "a committed ask alone (no other independent signal) must not generate a Brief item");
  }

  // ---------------- 8. Birthday-only, financially immaterial donor does not qualify (Eliezer Zryl shape) ----------------
  {
    const zryl = donor({ donorId: "zryl", lifetimeCents: dollars(9100), upcomingDateDescription: "birthday in 1d" });
    const brief = briefForOne(zryl);
    assert.equal(brief.items.length, 0, "an upcoming date alone on a financially immaterial donor must not qualify");
  }
  // ...but the SAME date, on a financially significant relationship, does qualify.
  {
    const bigDonorWithBirthday = donor({ donorId: "big-birthday", lifetimeCents: dollars(199150), upcomingDateDescription: "birthday in 1d" });
    const brief = briefForOne(bigDonorWithBirthday);
    assert.equal(brief.items.length, 1, "the same upcoming date on a financially significant relationship must qualify");
    assert.equal(brief.items[0].situationType, "upcoming_moment");
    assert.equal(brief.items[0].disposition, "DO");
    assert.ok(brief.items[0].possibleAction);
  }

  // ---------------- 9. Future-dated gift must never be described as "recent" (David B. Rosenbaum shape: real, live daysSinceLastGift = -105 anomaly) ----------------
  {
    assert.equal(safeDays(-105), null, "safeDays must reject a negative (future-dated) day count");
    assert.equal(safeDays(0), 0);
    assert.equal(safeDays(null), null);

    const rosenbaum = donor({
      donorId: "rosenbaum", lifetimeCents: dollars(60000), last365Cents: dollars(8420), prior365Cents: dollars(1000),
      distinctActivityYears: 5, daysSinceLastGift: -105,
      openPledgeBalanceCents: dollars(5000), openPledgeTotalCents: dollars(6000), pledgeAgeDays: -105, pledgePlanOnTrack: null,
    });
    const brief = briefForOne(rosenbaum);
    for (const item of brief.items) {
      const allText = `${item.explanation} ${item.whyNow} ${item.whatFosDoesNotKnow ?? ""}`;
      assert.ok(!/-\d+ days?/.test(allText), `must never surface a negative day count: "${allText}"`);
      assert.ok(!/in -?\d+ days? ago/.test(allText));
    }
  }

  // ---------------- 10. Newly-significant gift can qualify ----------------
  {
    const d = donor({ donorId: "newly-sig", lifetimeCents: dollars(8000), last365Cents: dollars(8000), prior365Cents: 0 });
    const bg = backgroundDonors();
    const ctx = buildPortfolioContext(bg, [dollars(500)]);
    const result = { ...scorePortfolioFocusDonor(d, ctx), rank: 1, momentumLabel: "newly_significant" };
    const brief = buildFundraisingIntelligenceBrief([d], [result], new Map(), new Map(), NOW);
    assert.equal(brief.items.length, 1);
    assert.equal(brief.items[0].situationType, "financial_change");
    assert.equal(brief.items[0].disposition, "KNOW");
  }
  // A tiny newly-significant first gift, below the materiality floor, correctly does not qualify.
  {
    const d = donor({ donorId: "newly-sig-tiny", lifetimeCents: dollars(200), last365Cents: dollars(200), prior365Cents: 0 });
    const bg = backgroundDonors();
    const ctx = buildPortfolioContext(bg, [dollars(500)]);
    const result = { ...scorePortfolioFocusDonor(d, ctx), rank: 1, momentumLabel: "newly_significant" };
    const brief = buildFundraisingIntelligenceBrief([d], [result], new Map(), new Map(), NOW);
    assert.equal(brief.items.length, 0, "a tiny first gift must not flood Phase 1 (see calibration doc's documented clustering gap)");
  }

  // ---------------- 11. Missing relationship context wording stays neutral ----------------
  {
    const { assertSafeBriefText } = await import("../lib/fundraising-intelligence/text-safety.ts");
    assert.throws(() => assertSafeBriefText("This donor's relationship is weak.", "test"), /banned/);
    assert.throws(() => assertSafeBriefText("This is a weak relationship overall.", "test"), /banned/);
    assert.doesNotThrow(() => assertSafeBriefText("FOS has limited recent relationship context on this donor.", "test"));
  }

  // ---------------- 12. Duplicate engine signals for one donor synthesize into ONE item (Stein again: momentum AND on-track plan both independently fire stewardship_moment) ----------------
  {
    const stein = donor({
      donorId: "stein2", lifetimeCents: dollars(71332), last365Cents: dollars(27083), prior365Cents: dollars(20000),
      openPledgeBalanceCents: dollars(66668), openPledgeTotalCents: dollars(75000), pledgePlanOnTrack: true,
    });
    const brief = briefForOne(stein);
    assert.equal(brief.items.length, 1, "multiple engines/signals agreeing about one situation must produce exactly one Brief item");
  }

  // ---------------- 13. Distinct financial situations are not incorrectly merged (Mordechai Schwartz shape: separate recent gift + separate stale, fully-unpaid pledge) ----------------
  {
    const schwartz = donor({
      donorId: "schwartz", lifetimeCents: dollars(120000), last365Cents: dollars(46000), prior365Cents: dollars(10000),
      mostRecentCashKind: "gift", mostRecentCashCents: dollars(9670), daysSinceLastGift: 10,
      openPledgeBalanceCents: dollars(36000), openPledgeTotalCents: dollars(36000), pledgeAgeDays: 80, pledgePlanOnTrack: null,
    });
    const brief = briefForOne(schwartz);
    assert.equal(brief.items.length, 1);
    const item = brief.items[0];
    assert.equal(item.situationType, "pledge_follow_up", "the stale, fully-unpaid pledge must be the winning (highest-priority) situation");
    assert.equal(item.disposition, "KNOW_DO", "a distinct, independently material recent gift must upgrade this to KNOW_DO, not replace the pledge story");
    const allEvidence = item.sourceSignals.map((s) => s.detail).join(" | ");
    assert.ok(allEvidence.includes("36,000") || allEvidence.includes("36000"), "the pledge amount must appear in evidence");
    assert.ok(allEvidence.includes("9,670") || allEvidence.includes("9670"), "the separate gift amount must appear in evidence");
    assert.ok(!/\$45,670|\$45670/.test(allEvidence + item.explanation), "the two distinct financial facts must never be summed into one misleading figure");
  }

  // ---------------- 14. KNOW can exist with no action; 15. DO/KNOW_DO always carries an action (general invariant, checked across every case above) ----------------
  {
    const bg = backgroundDonors();
    const probes = [
      donor({ donorId: "inv-miller", lifetimeCents: dollars(199150), daysSinceLastGift: 114 }),
      donor({ donorId: "inv-weinschneider", lifetimeCents: dollars(20000), hasOpenReminder: true, openReminderAction: "Follow up." }),
      donor({ donorId: "inv-stein", lifetimeCents: dollars(71332), openPledgeBalanceCents: dollars(66668), openPledgeTotalCents: dollars(75000), pledgePlanOnTrack: true }),
      donor({ donorId: "inv-spetner", lifetimeCents: dollars(100361), openPledgeBalanceCents: dollars(2000), openPledgeTotalCents: dollars(12000), pledgePlanOnTrack: true }),
    ];
    const ctx = buildPortfolioContext(bg, [dollars(500)]);
    const results = probes.map((p, i) => ({ ...scorePortfolioFocusDonor(p, ctx), rank: i + 1 }));
    const brief = buildFundraisingIntelligenceBrief(probes, results, new Map(), new Map(), NOW);
    for (const item of brief.items) {
      if (item.disposition === "KNOW") assert.equal(item.possibleAction, null, `KNOW item for ${item.donorId} must not carry an action`);
      if (item.disposition === "DO" || item.disposition === "KNOW_DO") assert.ok(item.possibleAction, `${item.disposition} item for ${item.donorId} must carry an evidence-backed action`);
      assertNoRawScoreInText(item);
    }
  }

  // ---------------- 16/17. Selection cap: no more than 15 items, fewer than 8 is allowed, no filler ----------------
  {
    // 20 donors that would all independently qualify (explicit reminders -- tier 1, unambiguous).
    const many = Array.from({ length: 20 }, (_, i) => donor({ donorId: `many-${i}`, lifetimeCents: dollars(1000 + i), hasOpenReminder: true, openReminderAction: `Follow up ${i}` }));
    const ctx = buildPortfolioContext([...backgroundDonors(), ...many], [dollars(500)]);
    const results = scorePortfolioFocus(many, ctx);
    const brief = buildFundraisingIntelligenceBrief(many, results, new Map(), new Map(), NOW);
    assert.equal(brief.items.length, 15, "the Brief must cap at 15 items even when more genuinely qualify");
    assert.equal(brief.rejected.filter((r) => r.suppressionReason === "excluded_by_selection_cap").length, 5);

    const few = [donor({ donorId: "solo", lifetimeCents: dollars(5000), hasOpenReminder: true, openReminderAction: "Follow up." })];
    const ctxFew = buildPortfolioContext([...backgroundDonors(), ...few], [dollars(500)]);
    const resultsFew = scorePortfolioFocus(few, ctxFew);
    const briefFew = buildFundraisingIntelligenceBrief(few, resultsFew, new Map(), new Map(), NOW);
    assert.equal(briefFew.items.length, 1, "fewer than 8 genuinely-qualifying items must be returned as-is, never padded with filler");
  }

  // ---------------- 18. Deterministic ordering ----------------
  {
    const probes = [
      donor({ donorId: "z-donor", lifetimeCents: dollars(50000), hasOpenReminder: true, openReminderAction: "A" }),
      donor({ donorId: "a-donor", lifetimeCents: dollars(50000), hasOpenReminder: true, openReminderAction: "B" }),
    ];
    const ctx = buildPortfolioContext([...backgroundDonors(), ...probes], [dollars(500)]);
    const results = scorePortfolioFocus(probes, ctx);
    const brief1 = buildFundraisingIntelligenceBrief(probes, results, new Map(), new Map(), NOW);
    const brief2 = buildFundraisingIntelligenceBrief(probes, results, new Map(), new Map(), NOW);
    assert.deepEqual(brief1.items.map((i) => i.donorId), brief2.items.map((i) => i.donorId), "ordering must be deterministic across identical runs");
  }

  // ==================================================================
  // Round 2: KNOW-reservation mechanism (§3-4) + recency-based
  // relationship_visibility (§5-9). See docs/FUNDRAISING-INTELLIGENCE-
  // BRIEF-PHASE1-CALIBRATION-V2.md for the real-data calibration this
  // implements.
  // ==================================================================

  function makeCandidate(overrides) {
    return {
      donorId: "x", displayName: "x", disposition: "DO", situationType: "pledge_follow_up",
      headline: "h", explanation: "e", whyNow: "w", whatFosDoesNotKnow: null, possibleAction: "a",
      confidence: "medium", sourceSignals: [], included: false, suppressionReason: null,
      debug: { portfolioFocusRank: 1, compositeScore: 0.5, financialSignificance: 0.9, recommendationKind: null, recommendationScore: null, priorityTier: 1 },
      ...overrides,
      debug: { portfolioFocusRank: 1, compositeScore: 0.5, financialSignificance: 0.9, recommendationKind: null, recommendationScore: null, priorityTier: 1, ...(overrides.debug ?? {}) },
    };
  }

  // ---------------- Reservation activates only when legitimate KNOW candidates exist; unused reserved slots return to the general pool ----------------
  {
    // 5 tier-1 DO candidates, zero KNOW candidates at all.
    const doOnly = Array.from({ length: 5 }, (_, i) => makeCandidate({ donorId: `do-${i}`, disposition: "DO", debug: { portfolioFocusRank: i + 1, financialSignificance: 0.9, priorityTier: 1 } }));
    const { included, excluded } = selectWithKnowReservation(doOnly, 15, 3);
    assert.equal(included.length, 5, "with no KNOW candidates at all, every real DO candidate must still be included -- reserved slots must not sit empty or force filler");
    assert.equal(excluded.length, 0);
  }

  // ---------------- Urgent DO items are not incorrectly dropped when tier-1 supply exactly matches the general capacity ----------------
  {
    const tier1 = Array.from({ length: 12 }, (_, i) => makeCandidate({ donorId: `t1-${i}`, disposition: "DO", debug: { portfolioFocusRank: i + 1, financialSignificance: 0.9, priorityTier: 1 } }));
    const tier2Know = Array.from({ length: 3 }, (_, i) => makeCandidate({ donorId: `t2-${i}`, disposition: "KNOW", debug: { portfolioFocusRank: 20 + i, financialSignificance: 0.8, priorityTier: 2 } }));
    const all = [...tier1, ...tier2Know];
    const { included } = selectWithKnowReservation(all, 15, DEFAULT_RESERVED_KNOW_SLOTS);
    for (const t of tier1) assert.ok(included.some((c) => c.donorId === t.donorId), `tier-1 DO candidate ${t.donorId} must not be dropped by reservation when it exactly fills the general capacity`);
  }

  // ---------------- Weak KNOW filler does not get forced into a reserved slot (real competing supply exists) ----------------
  {
    const tier1 = Array.from({ length: 20 }, (_, i) => makeCandidate({ donorId: `t1-${i}`, disposition: "DO", debug: { portfolioFocusRank: i + 1, financialSignificance: 0.9, priorityTier: 1 } }));
    const weakKnow = makeCandidate({ donorId: "weak-know", disposition: "KNOW", debug: { portfolioFocusRank: 200, financialSignificance: 0.1, priorityTier: 2 } });
    const sorted = [...tier1, weakKnow].sort((a, b) => a.debug.priorityTier - b.debug.priorityTier || b.debug.financialSignificance - a.debug.financialSignificance);
    const { included } = selectWithKnowReservation(sorted, 15, 3);
    assert.ok(!included.some((c) => c.donorId === "weak-know"), "a low-materiality KNOW item must never be forced into a reserved slot when real, higher-priority supply exists");
    assert.ok(!isReservedKnowEligible(weakKnow));
  }

  // ---------------- Avi-Stein-style: an active-stewardship KNOW item, crowded out by tier-1 volume, survives the final cap via reservation ----------------
  {
    const tier1 = Array.from({ length: 15 }, (_, i) => makeCandidate({ donorId: `t1-${i}`, disposition: "DO", debug: { portfolioFocusRank: 50 + i, financialSignificance: 0.6, priorityTier: 1 } }));
    const stein = makeCandidate({ donorId: "stein-like", disposition: "KNOW", situationType: "stewardship_moment", possibleAction: null, debug: { portfolioFocusRank: 1, financialSignificance: 0.87, priorityTier: 2 } });
    const sorted = [...tier1, stein].sort((a, b) => a.debug.priorityTier - b.debug.priorityTier || b.debug.financialSignificance - a.debug.financialSignificance);
    const { included: withoutReservation } = selectWithKnowReservation(sorted, 15, 0);
    assert.ok(!withoutReservation.some((c) => c.donorId === "stein-like"), "sanity check: without reservation, 15 tier-1 items alone fill the cap and crowd out the strategic KNOW item");
    const { included: withReservation } = selectWithKnowReservation(sorted, 15, DEFAULT_RESERVED_KNOW_SLOTS);
    assert.ok(withReservation.some((c) => c.donorId === "stein-like"), "with reservation, the #1-ranked strategic KNOW item must survive the final cap");
  }

  // ---------------- Miller-style: a major historical donor with stale current context now produces relationship_visibility ----------------
  {
    const miller = donor({ donorId: "miller2", lifetimeCents: dollars(199150), distinctActivityYears: 20, historicalPeakGiftCents: dollars(40000), daysSinceLastGift: 114, daysSinceSubstantiveContact: null });
    const brief = briefForOne(miller); // no asks, no facts -- zero structured evidence ever
    assert.equal(brief.items.length, 1);
    assert.equal(brief.items[0].situationType, "relationship_visibility");
    assert.equal(brief.items[0].disposition, "KNOW");
    assert.equal(brief.items[0].possibleAction, null, "relationship_visibility must never auto-create a DO action");
  }

  // ---------------- Low-value donor with the same contact gap does not qualify ----------------
  {
    const lowValue = donor({ donorId: "low-value", lifetimeCents: dollars(1500), daysSinceSubstantiveContact: null });
    const brief = briefForOne(lowValue);
    assert.equal(brief.items.length, 0, "a below-median-significance donor must not trigger relationship_visibility regardless of contact gap");
  }

  // ---------------- Recent contact suppresses relationship_visibility ----------------
  {
    const recentContact = donor({ donorId: "recent-contact", lifetimeCents: dollars(199150), distinctActivityYears: 20, historicalPeakGiftCents: dollars(40000), daysSinceSubstantiveContact: 30 });
    const brief = briefForOne(recentContact);
    assert.equal(brief.items.length, 0, "recent substantive contact must suppress the visibility gap");
  }

  // ---------------- Recent structured fact suppresses relationship_visibility ----------------
  {
    const recentFactDonor = donor({ donorId: "recent-fact", lifetimeCents: dollars(199150), distinctActivityYears: 20, historicalPeakGiftCents: dollars(40000), daysSinceSubstantiveContact: null });
    const facts = [fact({ donor_id: "recent-fact", category: "engagement", lifecycle: "durable", fact_text: "Recent note.", source_interaction_occurred_at: NOW - 60 * DAY })];
    const brief = briefForOne(recentFactDonor, [], facts);
    // The same recent fact is also legitimate stewardship evidence in its own right (a different, correct
    // situation type) -- the requirement here is only that relationship_visibility specifically stays suppressed.
    assert.ok(!brief.items.some((i) => i.situationType === "relationship_visibility"), "a recent structured relationship fact must suppress the visibility gap even with no logged interaction");
  }

  // ---------------- Missing-context wording stays neutral (new phrasing) ----------------
  {
    const miller = donor({ donorId: "miller3", lifetimeCents: dollars(199150), distinctActivityYears: 20, historicalPeakGiftCents: dollars(40000), daysSinceSubstantiveContact: null });
    const brief = briefForOne(miller);
    assert.ok(brief.items[0].explanation.includes("FOS has limited recent relationship context"), "must use the neutral, knowledge-describing phrase");
    assertNoRawScoreInText(brief.items[0]);
  }

  // ---------------- Generic reconnect fallback still cannot independently qualify (re-verified after Round 2 changes) ----------------
  {
    const d = donor({ donorId: "generic2", lifetimeCents: dollars(5000), daysSinceLastGift: 400, recommendation: { kind: "reconnect_contact_gap", score: 0.2375, action: "Reach out to re-establish contact." } });
    const brief = briefForOne(d);
    assert.equal(brief.items.length, 0);
    assert.equal(brief.rejected[0].suppressionReason, "reconnect_fallback_only_no_independent_situation");
  }

  console.log("fundraising-intelligence.test.mjs: all assertions passed");
}

run();
