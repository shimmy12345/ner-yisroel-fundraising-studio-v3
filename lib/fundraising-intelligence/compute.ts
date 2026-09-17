// Fundraising Intelligence Brief -- server-side compute entry points
// (UI phase). This is the ONLY file in lib/fundraising-intelligence/
// that touches D1 (via lib/portfolio-focus/data.ts, which imports
// `cloudflare:workers`) -- kept separate from index.ts/situations.ts/
// synthesize.ts/dedicated-view.ts/today-view.ts/labels.ts specifically
// so those stay importable from plain Node (tests, calibration scripts)
// without pulling in a Workers-runtime-only module. Never called from
// tests -- only from Worker-runtime page components.
//
// Issues exactly the SAME bounded, 12-query raw pull Portfolio Focus's
// own computePortfolioFocus() already uses (lib/portfolio-focus/data.ts's
// loadPortfolioFocusRawData) -- zero new D1 queries. computePortfolio
// FocusAndBrief() below does this pull exactly ONCE and derives both the
// Portfolio Focus result set and the Brief from it, so a caller (the
// Today page) that needs both never pays for the raw pull twice.
import { loadPortfolioFocusRawData } from "../portfolio-focus/data.ts";
import { aggregatePortfolioFocusInputs } from "../portfolio-focus/aggregate.ts";
import { buildPortfolioContext } from "../portfolio-focus/context.ts";
import { scorePortfolioFocus } from "../portfolio-focus/score.ts";
import type { PortfolioFocusResult } from "../portfolio-focus/types.ts";
import { buildFundraisingIntelligenceBrief, group, DEFAULT_RESERVED_KNOW_SLOTS } from "./index.ts";
import type { FundraisingIntelligenceBriefResult } from "./types.ts";

async function computeBoth(userId: string, timezone: string, now: number): Promise<{ portfolioFocus: PortfolioFocusResult[]; brief: FundraisingIntelligenceBriefResult }> {
  const raw = await loadPortfolioFocusRawData(userId);
  const { donorInputs, financialEventAmounts } = aggregatePortfolioFocusInputs(raw, now, timezone);
  const ctx = buildPortfolioContext(donorInputs, financialEventAmounts);
  const portfolioFocus = scorePortfolioFocus(donorInputs, ctx);
  const asksByDonor = group(raw.asks, (a) => a.donor_id);
  const factsByDonor = group(raw.relationshipFacts, (f) => f.donor_id);
  const brief = buildFundraisingIntelligenceBrief(donorInputs, portfolioFocus, asksByDonor, factsByDonor, now, DEFAULT_RESERVED_KNOW_SLOTS);
  return { portfolioFocus, brief };
}

// For the dedicated /fundraising-intelligence page -- one raw pull, the
// full calibrated Brief.
export async function computeFundraisingIntelligenceBrief(userId: string, timezone: string, now: number): Promise<FundraisingIntelligenceBriefResult> {
  const { brief } = await computeBoth(userId, timezone, now);
  return brief;
}

// For the Today page, which already needs Portfolio Focus's own result
// set for its existing Portfolio Focus section -- returns BOTH from one
// shared raw pull, so adding the Intelligence Brief teaser to Today
// costs zero additional D1 queries.
export async function computePortfolioFocusAndBrief(userId: string, timezone: string, now: number): Promise<{ portfolioFocus: PortfolioFocusResult[]; brief: FundraisingIntelligenceBriefResult }> {
  return computeBoth(userId, timezone, now);
}
