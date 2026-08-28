import assert from "node:assert/strict";
import { scorePortfolioFocus } from "../lib/portfolio-focus/score.ts";
import { buildPortfolioContext } from "../lib/portfolio-focus/context.ts";
import { buildDedicatedPortfolioFocusRows, PORTFOLIO_FOCUS_FILTERS, RELATIONSHIP_CONTEXT_LABELS } from "../lib/portfolio-focus/dedicated-view.ts";

// Portfolio Focus Phase 2B -- dedicated-view adapter tests
// (docs/PORTFOLIO-FOCUS-UX-DESIGN.md). Real component functions score a
// realistic synthetic portfolio (same convention as
// tests/portfolio-focus-regression.test.mjs / tests/portfolio-focus-
// today-view.test.mjs) so these tests exercise the adapter against
// genuine PortfolioFocusResult shapes, never a hand-typed stand-in.

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

const donors = [
  donor({ donorId: "d-small-1", displayName: "Small One", lifetimeCents: dollars(500), distinctActivityYears: 1 }),
  donor({ donorId: "d-small-2", displayName: "Small Two", lifetimeCents: dollars(1200), distinctActivityYears: 2 }),
  donor({ donorId: "d-small-3", displayName: "Small Three", lifetimeCents: dollars(3600), distinctActivityYears: 3 }),
  donor({ donorId: "d-small-4", displayName: "Small Four", lifetimeCents: dollars(9000), distinctActivityYears: 4 }),
  // Coverage-driven (Miller-shaped): financially maximal, zero real
  // relationship history, a generic low-priority Recommendation Engine
  // fallback (never a real actionable suggestion).
  donor({
    donorId: "d-coverage", displayName: "Coverage Case", lifetimeCents: dollars(199150), distinctActivityYears: 54,
    historicalPeakGiftCents: dollars(25000), lastInteractionDaysAgo: null, hasCurrentFact: false, askHistoryCount: 0,
    recommendation: { kind: "reconnect_contact_gap", score: 0.24, action: "Reach out to re-establish contact" },
  }),
  // Solicitation opportunity with NO pledge (Weinschneider-shaped).
  donor({
    donorId: "d-solicit", displayName: "Solicit Case", lifetimeCents: dollars(40000), distinctActivityYears: 6,
    hasOpenReminder: true, openReminderAction: "Follow up on Giving follow-up", lastInteractionDaysAgo: 5, hasCurrentFact: true,
    currentSnapshotSummary: "Discussed a gift and said to follow up after the holiday.",
    recommendation: { kind: "honor_reminder", score: 0.76, action: "Follow up on “Giving follow-up”" },
  }),
  // Active, on-track pledge fulfillment (Spetner-shaped: old commitment
  // date so it no longer reads as "new," very recent payment activity).
  donor({
    donorId: "d-steward", displayName: "Steward Case", lifetimeCents: dollars(100000), distinctActivityYears: 30,
    openPledgeBalanceCents: dollars(2000), openPledgeTotalCents: dollars(12000), pledgePlanOnTrack: true,
    pledgeAgeDays: 11, pledgeCommitmentAgeDays: 336, daysSinceLastGift: 11, lastInteractionDaysAgo: null, hasCurrentFact: false,
    recommendation: { kind: "reconnect_contact_gap", score: 0.24, action: "Reach out to re-establish contact" },
  }),
  // A large, recent, currently-active commitment.
  donor({
    donorId: "d-cultivate-steward", displayName: "Cultivate Steward Case", lifetimeCents: dollars(75000), distinctActivityYears: 5,
    openPledgeTotalCents: dollars(75000), pledgeAgeDays: 12, pledgeCommitmentAgeDays: 12, lastInteractionDaysAgo: 8, hasCurrentFact: true,
    recommendation: { kind: "follow_up_pledge", score: 0.45, action: "Follow up on the open $75,000 pledge." },
  }),
];

const financialEventAmounts = [dollars(500), dollars(1200), dollars(3600), dollars(9000), dollars(12000), dollars(75000)];
const ctx = buildPortfolioContext(donors, financialEventAmounts);
const results = scorePortfolioFocus(donors, ctx);
const rows = buildDedicatedPortfolioFocusRows(results);

function rowFor(donorId) {
  const row = rows.find((r) => r.donorId === donorId);
  assert.ok(row, `expected a row for ${donorId}`);
  return row;
}

// ---- Row shape: no raw score present anywhere outside `technical` ----
{
  const row = rowFor("d-coverage");
  for (const key of ["compositeScore", "baseComposite", "coverage", "coverageFloor", "coverageTriggered", "momentumLabel"]) {
    assert.ok(!(key in row), `${key} must not appear at the row's top level -- only inside row.technical`);
  }
  assert.ok(typeof row.technical.compositeScore === "number", "technical detail must still carry the real composite score, for the explicit disclosure only");
}

// ---- Coverage-driven explanation is explicitly non-solicitation ----
{
  const row = rowFor("d-coverage");
  assert.equal(row.attentionLabel, "Relationship Review");
  assert.match(row.explanation.lede, /relationship-review signal, not a solicitation recommendation/);
  // "Ask history" (a real evidence-category noun, from the engine's own
  // whyNow sentence) is expected and fine here -- what must never appear
  // is an imperative to actually solicit this donor.
  for (const forbidden of [/\bask this donor\b/i, /\bask for\b/i, /\bsolicit (him|her|them)\b/i]) {
    assert.doesNotMatch(row.explanation.lede, forbidden);
    assert.doesNotMatch(row.explanation.opportunity, forbidden);
  }
  assert.match(row.explanation.opportunity, /No current solicitation opportunity identified/);
  assert.match(row.explanation.relationshipVisibility, /limited current relationship information/i);
  assert.doesNotMatch(row.explanation.relationshipVisibility, /weak/i, "missing information must never be described as a weak relationship");
  assert.equal(row.contextLabel, "Limited relationship context");
  assert.equal(row.hasSuggestedAction, false, "a generic reconnect_contact_gap fallback must not be flagged as a real Suggested Action");
  assert.equal(row.explanation.tactical, "No urgent Suggested Action on file.");
}

// ---- Spetner-shaped active fulfillment never reads as overdue/new ----
{
  const row = rowFor("d-steward");
  assert.equal(row.attentionLabel, "Active Stewardship");
  assert.match(row.explanation.opportunity, /not a new solicitation opportunity/);
  assert.match(row.explanation.stewardship, /actively being fulfilled/);
  assert.match(row.explanation.stewardship, /\$2,000 remaining of \$12,000/);
  for (const forbidden of [/overdue/i, /lapsed/i, /follow up on the balance/i, /collect/i]) {
    assert.doesNotMatch(row.explanation.opportunity, forbidden);
    assert.doesNotMatch(row.explanation.stewardship, forbidden);
    assert.doesNotMatch(row.explanation.lede, forbidden);
  }
}

// ---- Weinschneider-shaped: opportunity without any pledge ----
{
  const row = rowFor("d-solicit");
  assert.equal(row.attentionLabel, "Solicitation Opportunity");
  assert.match(row.explanation.opportunity, /Follow up on Giving follow-up/);
  assert.equal(row.explanation.stewardship, "No active stewardship signal on file right now.", "no pledge exists, so no stewardship signal should be manufactured");
  assert.equal(row.hasSuggestedAction, true);
  assert.match(row.explanation.tactical, /Suggested Action: Follow up on/);
}

// ---- Confidence / relationship-context vocabulary (item 16) ----
{
  assert.deepEqual(RELATIONSHIP_CONTEXT_LABELS, { high: "Well documented", medium: "Some context", low: "Limited relationship context" });
  for (const label of Object.values(RELATIONSHIP_CONTEXT_LABELS)) {
    for (const forbidden of [/error/i, /bad data/i, /weak/i, /warning/i]) assert.doesNotMatch(label, forbidden);
  }
}

// ---- No donor-specific special case anywhere in the adapter source ----
{
  const source = await (await import("node:fs/promises")).readFile(new URL("../lib/portfolio-focus/dedicated-view.ts", import.meta.url), "utf8");
  for (const name of ["Weber", "Miller", "Stein", "Schwartz", "Spetner", "Weinschneider", "Zachter", "Schnaidman", "Ray", "Zeffren", "Goldenberg", "Ramras"]) {
    assert.doesNotMatch(source, new RegExp(name), `the dedicated-view adapter must never special-case donor "${name}" by name`);
  }
  assert.doesNotMatch(source, /cloudflare:workers|env\.DB/, "the dedicated-view adapter must stay pure/read-only, with no direct D1 access of its own");
}

// ---- Filters group by DISPLAY label, not raw enum, and never renumber ----
{
  const reviewFilter = PORTFOLIO_FOCUS_FILTERS.find((f) => f.id === "relationship_review");
  assert.ok(reviewFilter.matches("coverage_needed"));
  assert.ok(reviewFilter.matches("learn_relationship_review"));
  assert.ok(!reviewFilter.matches("solicit_scheduled"));

  // Simulate what the client component does: filter the already-ranked
  // rows array, never re-sort, never reassign rank.
  const solicitFilter = PORTFOLIO_FOCUS_FILTERS.find((f) => f.id === "solicit_scheduled");
  const filtered = rows.filter((r) => solicitFilter.matches(r.attentionType));
  const originalRanksById = new Map(rows.map((r) => [r.donorId, r.rank]));
  for (const row of filtered) assert.equal(row.rank, originalRanksById.get(row.donorId), "a filtered row's rank must be identical to its rank in the full, unfiltered result -- filtering must never renumber");
}

// ---- Row order matches the engine's own order exactly ----
{
  assert.deepEqual(rows.map((r) => r.donorId), results.map((r) => r.donorId), "buildDedicatedPortfolioFocusRows must preserve the engine's own order exactly -- no re-sorting, no curation");
  for (let i = 0; i < rows.length; i += 1) assert.equal(rows[i].rank, results[i].rank);
}

process.stdout.write("Portfolio Focus dedicated-view adapter checks passed.\n");
