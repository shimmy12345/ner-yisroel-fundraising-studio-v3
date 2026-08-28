import assert from "node:assert/strict";
import { scorePortfolioFocus } from "../lib/portfolio-focus/score.ts";
import { buildPortfolioContext } from "../lib/portfolio-focus/context.ts";
import { buildTodayPortfolioFocusRows, formatPortfolioFocusWhyNow, ATTENTION_TYPE_DISPLAY_LABELS } from "../lib/portfolio-focus/today-view.ts";

// Portfolio Focus Phase 2A -- Today-page presentation adapter tests
// (docs/PORTFOLIO-FOCUS-UX-DESIGN.md). Real component functions score a
// realistic synthetic portfolio (same convention as
// tests/portfolio-focus-regression.test.mjs) so these tests exercise the
// adapter against genuine PortfolioFocusResult shapes, never a hand-typed
// stand-in -- the adapter itself must stay pure (asserted in
// tests/today.test.mjs, which also covers the page-level wiring/CSS/
// placement/no-raw-score requirements).

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

// A right-skewed portfolio realistic enough that percentile-based
// components (FS, Coverage) behave non-degenerately, plus one donor of
// each attention type this adapter needs to translate.
const donors = [
  donor({ donorId: "d-small-1", displayName: "Small One", lifetimeCents: dollars(500), distinctActivityYears: 1 }),
  donor({ donorId: "d-small-2", displayName: "Small Two", lifetimeCents: dollars(1200), distinctActivityYears: 2 }),
  donor({ donorId: "d-small-3", displayName: "Small Three", lifetimeCents: dollars(3600), distinctActivityYears: 3 }),
  donor({ donorId: "d-small-4", displayName: "Small Four", lifetimeCents: dollars(9000), distinctActivityYears: 4 }),
  // Coverage-driven: financially significant, zero real relationship history.
  donor({
    donorId: "d-coverage", displayName: "Coverage Case", donorCode: "77", lifetimeCents: dollars(199150), distinctActivityYears: 54,
    historicalPeakGiftCents: dollars(25000), lastInteractionDaysAgo: null, hasCurrentFact: false, askHistoryCount: 0,
  }),
  // Scheduled solicitation follow-up, no pledge required.
  donor({
    donorId: "d-solicit", displayName: "Solicit Case", lifetimeCents: dollars(40000), distinctActivityYears: 6,
    hasOpenReminder: true, openReminderAction: "Follow up on Giving follow-up", lastInteractionDaysAgo: 5, hasCurrentFact: true,
  }),
  // Active, on-track pledge being fulfilled (Spetner-shaped: an old
  // commitment date -- so it no longer reads as a "new opportunity" --
  // with very recent payment activity).
  donor({
    donorId: "d-steward", displayName: "Steward Case", lifetimeCents: dollars(100000), distinctActivityYears: 30,
    openPledgeBalanceCents: dollars(2000), openPledgeTotalCents: dollars(12000), pledgePlanOnTrack: true,
    pledgeAgeDays: 11, pledgeCommitmentAgeDays: 336, daysSinceLastGift: 11, lastInteractionDaysAgo: 20, hasCurrentFact: true,
  }),
  // A large, recent, currently-active commitment.
  donor({
    donorId: "d-cultivate-steward", displayName: "Cultivate Steward Case", lifetimeCents: dollars(75000), distinctActivityYears: 5,
    openPledgeTotalCents: dollars(75000), pledgeAgeDays: 12, pledgeCommitmentAgeDays: 12, lastInteractionDaysAgo: 8, hasCurrentFact: true,
  }),
  // Real, dated decline on a financially significant relationship.
  donor({
    donorId: "d-reconnect", displayName: "Reconnect Case", lifetimeCents: dollars(110000), distinctActivityYears: 17,
    historicalPeakGiftCents: dollars(14400), prior365Cents: dollars(11350), last365Cents: dollars(2200),
    lastInteractionDaysAgo: 200, hasCurrentFact: true, askHistoryCount: 1,
  }),
];

const financialEventAmounts = [dollars(500), dollars(1200), dollars(3600), dollars(9000), dollars(12000), dollars(75000)];
const ctx = buildPortfolioContext(donors, financialEventAmounts);
const results = scorePortfolioFocus(donors, ctx);

// ---- buildTodayPortfolioFocusRows: order/count/no-curation ----
{
  const top5 = buildTodayPortfolioFocusRows(results, 5);
  assert.equal(top5.length, 5, "must return exactly 5 rows when at least 5 results exist");
  assert.deepEqual(top5.map((r) => r.donorId), results.slice(0, 5).map((r) => r.donorId), "must be the engine's own top 5, in the engine's own order -- no re-sorting, no curation");
  assert.deepEqual(top5.map((r) => r.rank), [1, 2, 3, 4, 5], "rank must be preserved exactly as assigned by scorePortfolioFocus");

  const fewer = buildTodayPortfolioFocusRows(results.slice(0, 3), 5);
  assert.equal(fewer.length, 3, "fewer than 5 available results must render fewer than 5 rows, never padded with arbitrary donors");

  const none = buildTodayPortfolioFocusRows([], 5);
  assert.deepEqual(none, [], "zero results must produce zero rows");
}

// ---- Row shape: WHO/WHY/WHAT KIND OF ATTENTION only, never raw scoring ----
{
  const [row] = buildTodayPortfolioFocusRows(results, 1);
  assert.deepEqual(Object.keys(row).sort(), ["attentionLabel", "displayName", "donorCode", "donorId", "rank", "whyNow"].sort(), "a Today row must expose only display fields -- never compositeScore, components, coverage, momentumLabel, or pledgeStaleClass");
}

// ---- Attention-type display vocabulary (docs/PORTFOLIO-FOCUS-UX-DESIGN.md Section 8) ----
{
  assert.equal(ATTENTION_TYPE_DISPLAY_LABELS.coverage_needed, "Relationship Review");
  assert.equal(ATTENTION_TYPE_DISPLAY_LABELS.learn_relationship_review, "Relationship Review", "coverage_needed and learn_relationship_review must share one fundraiser-facing label even though the internal enum keeps them distinct");
  assert.notEqual(ATTENTION_TYPE_DISPLAY_LABELS.coverage_needed, undefined);
  for (const type of Object.keys(ATTENTION_TYPE_DISPLAY_LABELS)) {
    assert.doesNotMatch(ATTENTION_TYPE_DISPLAY_LABELS[type], /coverage_needed|learn_relationship_review|solicit_scheduled|cultivate_steward_active|steward_active_fulfillment|reconnect_understand_decline|cultivate_real_growth|monitor_routine/, `display label for ${type} must never leak an internal enum token`);
  }

  const coverageResult = results.find((r) => r.donorId === "d-coverage");
  assert.ok(coverageResult, "coverage fixture must exist in the scored results");
  assert.equal(coverageResult.attentionType, "coverage_needed", "the coverage fixture must actually trigger coverage_needed, or this test proves nothing");
  const coverageRow = buildTodayPortfolioFocusRows([coverageResult], 1)[0];
  assert.equal(coverageRow.attentionLabel, "Relationship Review");
  assert.doesNotMatch(coverageRow.whyNow, /\bask\b|\bsolicit\b/i, "a coverage-driven row must never imply solicitation");
  assert.match(coverageRow.whyNow, /limited current relationship documentation/);
  assert.match(coverageRow.whyNow, /\$199,150/, "the why-now text must be derived from real evidence (lifetime giving), never invented");
}

// ---- Active-commitment vs. active-fulfillment must read differently (item 12/13) ----
{
  const solicit = results.find((r) => r.donorId === "d-solicit");
  const solicitRow = buildTodayPortfolioFocusRows([solicit], 1)[0];
  assert.equal(solicitRow.attentionLabel, "Solicitation Opportunity");
  assert.match(solicitRow.whyNow, /Follow up on Giving follow-up/, "a scheduled solicitation follow-up must show its own real reminder text, not invented copy");

  const steward = results.find((r) => r.donorId === "d-steward");
  const stewardRow = buildTodayPortfolioFocusRows([steward], 1)[0];
  assert.equal(stewardRow.attentionLabel, "Active Stewardship");
  assert.match(stewardRow.whyNow, /on track/);
  assert.doesNotMatch(stewardRow.whyNow, /overdue|follow up|collect/i, "an on-track pledge fulfillment must never read as an overdue collection");
}

// ---- formatPortfolioFocusWhyNow is pure and evidence-only ----
{
  const evidence = { lifetimeCents: dollars(50000), last365Cents: 0, prior365Cents: 0, openPledgeBalanceCents: null, openPledgeTotalCents: null, pledgeStaleClass: null, mostRecentCashCents: null, mostRecentCashKind: null, daysSinceLastGift: null, daysSinceSubstantiveContact: null, hasCurrentFact: false, hasOpenReminder: false, openReminderAction: null, currentSnapshotSummary: null, upcomingDateDescription: null, recommendationKind: null, recommendationScore: null };
  assert.equal(formatPortfolioFocusWhyNow("learn_relationship_review", evidence), formatPortfolioFocusWhyNow("coverage_needed", evidence), "the two coverage-adjacent types must produce identical fundraiser-facing wording given identical evidence");
  assert.equal(formatPortfolioFocusWhyNow("monitor_routine", evidence), "No significant financial or relationship signal this period.");
}

process.stdout.write("Portfolio Focus Today-view adapter checks passed.\n");
