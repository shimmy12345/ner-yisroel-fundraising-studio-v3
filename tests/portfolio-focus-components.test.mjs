import assert from "node:assert/strict";
import {
  computeFinancialSignificance, computeOpportunity, computeStewardship, computeMomentum, computeTacticalUrgency,
  computeCoverage, computeCoverageFloor,
} from "../lib/portfolio-focus/components.ts";
import { computeFinancialConfidence, computeRelationshipConfidence } from "../lib/portfolio-focus/confidence.ts";
import { classifyPledgeStaleness } from "../lib/portfolio-focus/stale-balance.ts";
import { resolveAttentionType } from "../lib/portfolio-focus/attention-type.ts";

// Portfolio Focus Phase 1 -- unit tests for every Round 3 frozen
// component, against the exact definitions in
// docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md. Synthetic fixtures (this
// repo's established convention for pure-function tests -- see
// tests/relationship-fact-recommendation-actionability.test.mjs) rather
// than live D1; real-data parity is verified separately (read-only,
// against Independent Staging, not part of this suite).

function baseInput(overrides = {}) {
  return {
    donorId: "donor-1", displayName: "Test Donor", donorCode: "1",
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

function baseContext(overrides = {}) {
  // A modest synthetic portfolio: ten donors' lifetime totals spanning
  // $1,000 to $200,000, matching the real portfolio's rough shape
  // (heavily right-skewed) closely enough to exercise percentile
  // behavior meaningfully without depending on live data.
  const lifetimeValuesPositive = [100000, 250000, 500000, 900000, 1500000, 3000000, 5000000, 9000000, 15000000, 20000000];
  return {
    lifetimeValuesPositive,
    historicalPeaksPositive: [50000, 100000, 200000, 500000, 1000000, 2500000],
    distinctYearsPositive: [1, 2, 3, 5, 8, 15, 25],
    financialEventAmounts: [50000, 75000, 100000, 250000, 500000, 750000, 1200000, 1800000, 3600000, 7500000],
    deltaAbsValues: [10000, 50000, 100000, 500000, 1000000],
    ...overrides,
  };
}

const dollars = (d) => d * 100;

async function run() {
  // ---------------- Financial Significance: pledge-independence (Round 2/3 regression requirement) ----------------
  {
    const ctx = baseContext();
    const noPledgeDonor = baseInput({ lifetimeCents: dollars(199150), historicalPeakGiftCents: dollars(25000), distinctActivityYears: 40 });
    const withPledgeDonor = baseInput({ lifetimeCents: dollars(199150), historicalPeakGiftCents: dollars(25000), distinctActivityYears: 40, openPledgeTotalCents: dollars(10000), openPledgeBalanceCents: dollars(5000) });
    const fsNoPledge = computeFinancialSignificance(noPledgeDonor, ctx);
    const fsWithPledge = computeFinancialSignificance(withPledgeDonor, ctx);
    assert.equal(fsNoPledge, fsWithPledge, "Financial Significance must be identical whether or not a donor currently has a pledge -- it never reads pledge fields at all");
    assert.ok(fsNoPledge > 0.85, `a #1-lifetime-tier, high-peak, long-tenured donor must score near-maximal FS even with zero current pledge (got ${fsNoPledge})`);
  }

  // ---------------- Opportunity: missing contact must NOT create Opportunity (Round 2 regression) ----------------
  {
    const ctx = baseContext();
    const zeroEverything = baseInput(); // no pledge, no reminder, no fact, no interaction ever
    const staleClass = classifyPledgeStaleness(zeroEverything);
    const opp = computeOpportunity(zeroEverything, ctx, staleClass);
    assert.equal(opp, 0, "zero documented contact must never itself produce positive Opportunity");
  }

  // ---------------- Opportunity: engagement track registers without any pledge (Weinschneider/Zeffren regression) ----------------
  {
    const ctx = baseContext();
    const warmNoPledge = baseInput({ hasOpenReminder: true, lifetimeCents: dollars(89931) });
    const opp = computeOpportunity(warmNoPledge, ctx, null);
    assert.ok(opp >= 0.6, `an explicit open reminder must register real Opportunity even with zero dollar commitment (got ${opp})`);
  }
  {
    const ctx = baseContext();
    const factDriven = baseInput({ hasActionableFact: true, daysSinceSubstantiveContact: 9, lifetimeCents: dollars(45400) });
    const opp = computeOpportunity(factDriven, ctx, null);
    assert.ok(opp >= 0.4, `a current actionable fact with genuinely recent substantive contact must register Opportunity even with zero pledge (got ${opp})`);
  }

  // ---------------- Opportunity: a stale/artifact pledge contributes zero, regardless of size ----------------
  {
    const ctx = baseContext();
    const staleBigPledge = baseInput({ openPledgeTotalCents: dollars(50000), openPledgeBalanceCents: dollars(50000), pledgeCommitmentAgeDays: 3000 /* ~8.2 years */ });
    const staleClass = classifyPledgeStaleness(staleBigPledge);
    assert.equal(staleClass, "immaterial_artifact");
    const opp = computeOpportunity(staleBigPledge, ctx, staleClass);
    assert.equal(opp, 0, "an ancient, immaterial-artifact-classified pledge must contribute zero Opportunity even if the dollar amount is large");
  }

  // ---------------- Opportunity: the Round 1/2 small-pledge overcredit case, corrected ----------------
  {
    const ctx = baseContext();
    const modest = baseInput({ openPledgeTotalCents: dollars(1500), openPledgeBalanceCents: dollars(1500), pledgeAgeDays: 11, historicalPeakCommitmentCents: dollars(1500) });
    const major = baseInput({ openPledgeTotalCents: dollars(75000), openPledgeBalanceCents: dollars(66668), pledgeAgeDays: 12, historicalPeakCommitmentCents: dollars(75000) });
    const modestOpp = computeOpportunity(modest, ctx, "current");
    const majorOpp = computeOpportunity(major, ctx, "current");
    assert.ok(majorOpp - modestOpp > 0.3, `a $75,000 pledge must score meaningfully higher Opportunity than a $1,500 pledge (modest=${modestOpp}, major=${majorOpp})`);
  }

  // ---------------- Stewardship: no longer requires a payment plan (Round 2 Schwartz regression) ----------------
  {
    const ctx = baseContext();
    const freshUnpaidPledge = baseInput({ openPledgeTotalCents: dollars(36000), openPledgeBalanceCents: dollars(36000), pledgeCommitmentAgeDays: 60, pledgeAgeDays: 60, pledgePlanOnTrack: null, historicalPeakCommitmentCents: dollars(36000) });
    const staleClass = classifyPledgeStaleness(freshUnpaidPledge);
    assert.equal(staleClass, "current");
    const stew = computeStewardship(freshUnpaidPledge, ctx, staleClass);
    assert.ok(stew > 0, `a fresh, large, UNPAID pledge with no payment plan must still earn real Stewardship credit (got ${stew})`);
  }
  {
    const ctx = baseContext();
    const onTrack = baseInput({ openPledgeTotalCents: dollars(12000), openPledgeBalanceCents: dollars(2000), pledgeCommitmentAgeDays: 336, pledgeAgeDays: 11, pledgePlanOnTrack: true, historicalPeakCommitmentCents: dollars(12000) });
    const noPlan = baseInput({ ...onTrack, pledgePlanOnTrack: null });
    const stewOnTrack = computeStewardship(onTrack, ctx, "current");
    const stewNoPlan = computeStewardship(noPlan, ctx, "current");
    assert.ok(stewOnTrack > stewNoPlan, "an active, on-track payment plan must add real Stewardship credit beyond the underlying pledge alone");
  }
  {
    const ctx = baseContext();
    const reminderOnly = baseInput({ hasOpenReminder: true, lifetimeCents: dollars(90000) });
    const stew = computeStewardship(reminderOnly, ctx, null);
    assert.ok(stew > 0, "an explicit fundraiser reminder must add Stewardship credit even with zero pledge");
  }

  // ---------------- Momentum: noise protection (Round 2 Miller regression) ----------------
  {
    const ctx = baseContext();
    const trivialSwingHugeRelationship = baseInput({ lifetimeCents: dollars(199150), last365Cents: dollars(3600), prior365Cents: dollars(1800), daysSinceLastGift: 90 });
    const { label } = computeMomentum(trivialSwingHugeRelationship, ctx);
    assert.equal(label, "noisy_swing", `a 2x ratio swing that is trivial (<3%) relative to a $199,150 lifetime relationship must be labeled noisy_swing, not increasing (got "${label}")`);
  }
  {
    const ctx = baseContext();
    const realDecline = baseInput({ lifetimeCents: dollars(114026), last365Cents: dollars(5760), prior365Cents: dollars(25360), daysSinceLastGift: 107 });
    const { label } = computeMomentum(realDecline, ctx);
    assert.equal(label, "declining", "a real, materially significant decline (both in percentage and relative to the donor's own lifetime) must still register as declining");
  }
  {
    const ctx = baseContext();
    const onTrack = baseInput({ lifetimeCents: dollars(100361), last365Cents: dollars(10000), prior365Cents: dollars(10000), daysSinceLastGift: 11, pledgePlanOnTrack: true });
    const { label, signal } = computeMomentum(onTrack, ctx);
    assert.equal(label, "actively_fulfilling_commitment", "an on-track payment plan must override every other momentum label");
    assert.equal(signal, 0.3);
  }

  // ---------------- Tactical Urgency: stale-balance strategic discount, Recommendation Engine score untouched ----------------
  {
    const rawScore = 0.65;
    const staleInput = { recommendation: { kind: "follow_up_pledge", score: rawScore, action: "x" } };
    assert.equal(computeTacticalUrgency(staleInput, "immaterial_artifact"), 0.15, "an immaterial-artifact pledge's follow_up_pledge score must be capped at 0.15 for strategic purposes");
    assert.equal(computeTacticalUrgency(staleInput, "legacy_needs_verification"), 0.40, "a legacy-needs-verification pledge must be capped at 0.40");
    assert.equal(computeTacticalUrgency(staleInput, "current"), rawScore, "a current pledge's real tactical score passes through completely unmodified");
    const reminderInput = { recommendation: { kind: "honor_reminder", score: 0.7575, action: "x" } };
    assert.equal(computeTacticalUrgency(reminderInput, "immaterial_artifact"), 0.7575, "a real scheduled fundraiser follow-up (honor_reminder) is NEVER discounted, even if an unrelated stale pledge exists");
  }

  // ---------------- Coverage: multiplicative bound, never exceeds Financial Significance ----------------
  {
    const zeroFsHighGap = baseInput(); // FS will be 0 (no lifetime, no peak, no years)
    const fs = 0;
    const coverage = computeCoverage(zeroFsHighGap, fs);
    assert.equal(coverage, 0, "a zero-Financial-Significance donor must have zero Coverage regardless of how little relationship evidence exists -- Coverage can never exceed FS");
  }
  {
    const totalSilence = baseInput(); // no interaction, no fact, no ask, no recent substantive contact
    const partialEvidence = baseInput({ lastInteractionDaysAgo: 8 }); // one documented interaction (e.g. a broadcast)
    const fs = 0.98;
    const covSilence = computeCoverage(totalSilence, fs);
    const covPartial = computeCoverage(partialEvidence, fs);
    assert.ok(covSilence > covPartial, "a donor with truly zero documented evidence must have higher Coverage than one with at least some evidence (Rosenberg vs. Miller distinction)");
    assert.ok(Math.abs(covSilence - fs) < 1e-9, "with zero knowledge of any kind, Coverage must equal Financial Significance exactly (evidenceGap = 1)");
  }
  {
    // Coverage floor: continuous cubic curve, ceiling at 0.45.
    assert.ok(Math.abs(computeCoverageFloor(1) - 0.45) < 1e-9, "coverageFloor at Coverage=1 must equal its 0.45 ceiling exactly");
    assert.equal(computeCoverageFloor(0), 0);
    assert.ok(computeCoverageFloor(0.5) < 0.1, "the cubic curve must keep the floor negligible for moderate Coverage values");
  }

  // ---------------- Confidence: two independent axes, never folded into the score ----------------
  {
    assert.equal(computeFinancialConfidence({ distinctActivityYears: 5 }), "high");
    assert.equal(computeFinancialConfidence({ distinctActivityYears: 2 }), "medium");
    assert.equal(computeFinancialConfidence({ distinctActivityYears: 0 }), "low");
    assert.equal(computeRelationshipConfidence({ lastInteractionDaysAgo: 10, hasCurrentFact: false, askHistoryCount: 0, hasUnconfirmedHistoricalContext: false }), "high");
    assert.equal(computeRelationshipConfidence({ lastInteractionDaysAgo: null, hasCurrentFact: false, askHistoryCount: 0, hasUnconfirmedHistoricalContext: true }), "medium");
    assert.equal(computeRelationshipConfidence({ lastInteractionDaysAgo: null, hasCurrentFact: false, askHistoryCount: 0, hasUnconfirmedHistoricalContext: false }), "low");
  }

  // ---------------- Attention type: the Round 3 labeling correction ----------------
  {
    const components = { financialSignificance: 0.85, opportunity: 0, stewardship: 0, momentum: 0.6, tacticalUrgency: 0.2375 };
    const noRelationshipHistory = { hasOpenReminder: false, pledgePlanOnTrack: null, lastInteractionDaysAgo: null, hasCurrentFact: false, askHistoryCount: 0 };
    const attn = resolveAttentionType(noRelationshipHistory, components, "increasing", false);
    assert.equal(attn, "learn_relationship_review", `a financially significant, zero-relationship-history donor with real growth must be labeled learn/relationship review, never "cultivate" (got "${attn}")`);
  }
  {
    const components = { financialSignificance: 0.85, opportunity: 0, stewardship: 0, momentum: 0.6, tacticalUrgency: 0.2375 };
    const hasSomeHistory = { hasOpenReminder: false, pledgePlanOnTrack: null, lastInteractionDaysAgo: 20, hasCurrentFact: false, askHistoryCount: 0 };
    const attn = resolveAttentionType(hasSomeHistory, components, "increasing", false);
    assert.equal(attn, "cultivate_real_growth", `a donor with at least SOME documented relationship history and real growth may still be labeled cultivate (got "${attn}")`);
  }
  {
    const components = { financialSignificance: 0.5, opportunity: 0, stewardship: 0, momentum: 0.2, tacticalUrgency: 0.237 };
    const coverageTriggered = true;
    const attn = resolveAttentionType(baseInput(), components, "stable", coverageTriggered);
    assert.equal(attn, "coverage_needed", "a coverage-triggered donor must always be labeled coverage_needed, regardless of any other component");
  }
  {
    const components = { financialSignificance: 0.9, opportunity: 0.6, stewardship: 0.3, momentum: 0.3, tacticalUrgency: 0.757 };
    const attn = resolveAttentionType({ hasOpenReminder: true, pledgePlanOnTrack: null, lastInteractionDaysAgo: 10, hasCurrentFact: false, askHistoryCount: 0 }, components, "increasing", false);
    assert.equal(attn, "solicit_scheduled", "an explicit open reminder must always resolve to solicit_scheduled ahead of any other label");
  }

  console.log("portfolio-focus-components: ok");
}

await run();
