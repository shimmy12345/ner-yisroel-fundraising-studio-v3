import assert from "node:assert/strict";
import { scorePortfolioFocus, scorePortfolioFocusDonor } from "../lib/portfolio-focus/score.ts";
import { buildPortfolioContext } from "../lib/portfolio-focus/context.ts";

// Portfolio Focus Phase 1 -- mandatory regression tests, per
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md Sections 8/13/14/15. Fixtures
// are the REAL, documented profiles of the named regression donors as
// established across the calibration rounds (dollar amounts, ages,
// evidence presence) -- not live D1 reads (this suite is pure/
// deterministic; real-data parity is verified separately, read-only,
// against Independent Staging).

const dollars = (d) => d * 100;

// A realistic-SHAPED synthetic portfolio (heavily right-skewed, like the
// real 248-donor Independent Staging portfolio) so percentile-based
// components behave non-degenerately -- a single-donor context would
// trivially put every percentile at 1.0, which is not representative of
// how any of these components actually behave in production. Exact
// real-world parity (not merely realistic shape) is verified separately,
// read-only, against live Independent Staging data.
function realisticContext() {
  return buildPortfolioContext(
    [
      donor({ lifetimeCents: dollars(500), distinctActivityYears: 1 }),
      donor({ lifetimeCents: dollars(1200), distinctActivityYears: 2 }),
      donor({ lifetimeCents: dollars(3600), distinctActivityYears: 3 }),
      donor({ lifetimeCents: dollars(9000), distinctActivityYears: 4 }),
      donor({ lifetimeCents: dollars(21000), distinctActivityYears: 8, historicalPeakGiftCents: dollars(5000) }),
      donor({ lifetimeCents: dollars(45000), distinctActivityYears: 10, historicalPeakCommitmentCents: dollars(18000), prior365Cents: dollars(2800), last365Cents: dollars(7300) }),
      donor({ lifetimeCents: dollars(71000), distinctActivityYears: 3, historicalPeakCommitmentCents: dollars(75000), prior365Cents: dollars(20000), last365Cents: dollars(27083) }),
      donor({ lifetimeCents: dollars(102000), distinctActivityYears: 23, historicalPeakGiftCents: dollars(36000), prior365Cents: dollars(13080), last365Cents: dollars(36000) }),
      donor({ lifetimeCents: dollars(110000), distinctActivityYears: 17, historicalPeakGiftCents: dollars(14400), prior365Cents: dollars(11350), last365Cents: dollars(22050) }),
      donor({ lifetimeCents: dollars(199150), distinctActivityYears: 54, historicalPeakGiftCents: dollars(25000), prior365Cents: dollars(1800), last365Cents: dollars(3600) }),
    ],
    [dollars(500), dollars(1200), dollars(3600), dollars(9000), dollars(18000), dollars(36000), dollars(75000)],
  );
}

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

async function run() {
  // ---------------- Jonathan Spetner -- mandatory financial regression ----------------
  // Real, documented profile (Portfolio Focus Investigation + all three
  // calibration rounds, re-verified fresh each round): a $12,000 pledge
  // created 336 days ago, 83% paid ($10,000), $2,000 remaining, most
  // recent payment 11 days ago, active on-track plan, zero interactions
  // ever, zero facts, zero asks.
  {
    const spetner = donor({
      donorId: "spetner", lifetimeCents: dollars(100361), last365Cents: dollars(10000), prior365Cents: dollars(10000),
      distinctActivityYears: 31, historicalPeakGiftCents: dollars(30000), historicalPeakCommitmentCents: dollars(12000),
      mostRecentCashKind: "pledge_payment", mostRecentCashCents: dollars(1000), daysSinceLastGift: 11,
      openPledgeBalanceCents: dollars(2000), openPledgeTotalCents: dollars(12000), openPledgeCategory: "partially_paid_pledge",
      pledgeAgeDays: 11, pledgeCommitmentAgeDays: 336, pledgePlanOnTrack: true,
      recommendation: { kind: "reconnect_contact_gap", score: 0.2375, action: "x" },
    });
    const ctx = realisticContext();
    const result = scorePortfolioFocusDonor(spetner, ctx);

    assert.equal(result.momentumLabel, "actively_fulfilling_commitment", "Spetner must be understood as actively fulfilling his existing commitment");
    assert.notEqual(result.momentumLabel, "dormant_lapsed", "Spetner must NEVER be classified as lapsed");
    assert.ok(result.components.opportunity < 0.2, `Spetner's Opportunity must stay near-zero -- his commitment is 336 days old, not new (got ${result.components.opportunity})`);
    assert.equal(result.pledgeStaleClass, "current", "an on-track, actively-fulfilling pledge is always classified current regardless of its age");
    assert.equal(result.attentionType, "steward_active_fulfillment", "Spetner's attention type must be stewardship-oriented, never solicit/reconnect/coverage");
    assert.ok(!result.coverageTriggered, "Spetner has real, current pledge activity -- Coverage must not need to trigger to explain his ranking");
  }

  // ---------------- Mandatory stale-balance regressions ----------------
  // Real, documented ages/amounts from the calibration rounds. All six
  // must classify as immaterial_artifact and have their tactical score
  // capped, without any database or Recommendation Engine change (this
  // suite only proves the pure classification/scoring logic).
  const staleCases = [
    { name: "Yaakov Pollack", amount: dollars(60), ageDays: 10101 },
    { name: "Ahron Schabes", amount: dollars(10), ageDays: 4018 },
    { name: "Paltiel Myers", amount: dollars(2000), ageDays: 3618 },
    { name: "David Chapman", amount: dollars(915), ageDays: 8854 },
    { name: "Eliave Sobol", amount: dollars(25), ageDays: 7225 },
    { name: "Tzvi Ray", amount: dollars(10), ageDays: 1914 },
  ];
  for (const { name, amount, ageDays } of staleCases) {
    const d = donor({
      donorId: name, openPledgeBalanceCents: amount, openPledgeTotalCents: amount,
      pledgeCommitmentAgeDays: ageDays, pledgeAgeDays: ageDays, pledgePlanOnTrack: null,
      recommendation: { kind: "follow_up_pledge", score: 0.65, action: "x" },
    });
    const ctx = realisticContext();
    const result = scorePortfolioFocusDonor(d, ctx);
    assert.equal(result.pledgeStaleClass, "immaterial_artifact", `${name}'s ${ageDays}-day-old balance must classify as an immaterial artifact`);
    assert.equal(result.components.tacticalUrgency, 0.15, `${name}'s strategic Tactical Urgency must be capped at 0.15 (Recommendation Engine's own score of 0.65 is untouched)`);
    assert.equal(result.components.opportunity, 0, `${name}'s ancient balance must contribute zero Opportunity`);
  }

  // ---------------- Strong active cases must remain strategically interesting (Round 3 Section 13) ----------------
  {
    const stein = donor({
      donorId: "stein", lifetimeCents: dollars(71332), last365Cents: dollars(27083), prior365Cents: dollars(20000),
      distinctActivityYears: 3, historicalPeakGiftCents: dollars(25000), historicalPeakCommitmentCents: dollars(75000),
      openPledgeBalanceCents: dollars(66668), openPledgeTotalCents: dollars(75000), openPledgeCategory: "partially_paid_pledge",
      pledgeAgeDays: 12, pledgeCommitmentAgeDays: null, pledgePlanOnTrack: true,
      lastInteractionDaysAgo: 8,
      recommendation: { kind: "reconnect_contact_gap", score: 0.2375, action: "x" },
    });
    const ctx = realisticContext();
    const result = scorePortfolioFocusDonor(stein, ctx);
    assert.ok(result.components.opportunity > 0.7, `Stein's $75,000 active pledge must score high real Opportunity (got ${result.components.opportunity})`);
    assert.ok(result.compositeScore > 0.6, `Stein's composite must remain in the strong-active tier (got ${result.compositeScore})`);
  }

  // ---------------- Deterministic ordering / tie handling ----------------
  {
    const a = donor({ donorId: "b-donor", lifetimeCents: dollars(1000) });
    const b = donor({ donorId: "a-donor", lifetimeCents: dollars(1000) });
    const ctx = buildPortfolioContext([a, b], []);
    const results = scorePortfolioFocus([a, b], ctx);
    assert.equal(results[0].compositeScore, results[1].compositeScore, "sanity: both fixtures are identical apart from id");
    assert.equal(results[0].donorId, "a-donor", "a true tie must break deterministically by donorId ascending, never by insertion order");
    assert.equal(results[0].rank, 1);
    assert.equal(results[1].rank, 2);
  }

  console.log("portfolio-focus-regression: ok");
}

await run();
