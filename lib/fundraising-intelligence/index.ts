// Fundraising Intelligence Brief -- Phase 1 public entry point. Pure,
// in-memory, ZERO new D1 queries (see docs/FUNDRAISING-INTELLIGENCE-
// BRIEF-DESIGN.md §16/§21 and docs/FUNDRAISING-INTELLIGENCE-BRIEF-
// PHASE1-CALIBRATION.md for the real-data run this was calibrated
// against). Consumes Portfolio Focus's already-computed per-donor
// output (PortfolioFocusDonorInput[] / PortfolioFocusResult[]) plus the
// SAME raw asks/relationshipFacts rows Portfolio Focus's own bounded
// 12-query pull (lib/portfolio-focus/data.ts) already fetches -- never a
// second query pipeline, never a re-run of Portfolio Focus's own
// scoring, never a new weighted composite.
import { aggregatePortfolioFocusInputs, type PortfolioFocusRawData, type RawAskRow, type RawRelationshipFactRow } from "../portfolio-focus/aggregate.ts";
import { buildPortfolioContext } from "../portfolio-focus/context.ts";
import { scorePortfolioFocus } from "../portfolio-focus/score.ts";
import type { PortfolioFocusDonorInput, PortfolioFocusResult } from "../portfolio-focus/types.ts";
import { detectSituations } from "./situations.ts";
import { buildNoSituationCandidate, synthesizeDonorCandidate } from "./synthesize.ts";
import type { BriefDisposition, FundraisingIntelligenceBriefResult, FundraisingIntelligenceCandidate } from "./types.ts";

const SELECTION_CAP = 15;

function group<T, K extends string>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

// Deterministic final ordering (§17): priority tier first (fixed,
// per-situation-type -- see situations.ts's priorityTier/priorityOrder),
// then the EXISTING financialSignificance percentile component as a
// tie-breaker (never a new score), then Portfolio Focus rank, then
// donorId for full determinism.
function compareCandidates(a: FundraisingIntelligenceCandidate, b: FundraisingIntelligenceCandidate): number {
  const tierA = a.debug.priorityTier ?? 99;
  const tierB = b.debug.priorityTier ?? 99;
  if (tierA !== tierB) return tierA - tierB;
  if (a.debug.financialSignificance !== b.debug.financialSignificance) return b.debug.financialSignificance - a.debug.financialSignificance;
  if (a.debug.portfolioFocusRank !== b.debug.portfolioFocusRank) return a.debug.portfolioFocusRank - b.debug.portfolioFocusRank;
  return a.donorId.localeCompare(b.donorId);
}

export function buildFundraisingIntelligenceBrief(
  donorInputs: readonly PortfolioFocusDonorInput[],
  results: readonly PortfolioFocusResult[],
  asksByDonor: ReadonlyMap<string, RawAskRow[]>,
  factsByDonor: ReadonlyMap<string, RawRelationshipFactRow[]>,
  now: number,
): FundraisingIntelligenceBriefResult {
  const resultByDonorId = new Map(results.map((r) => [r.donorId, r]));

  const withSituation: FundraisingIntelligenceCandidate[] = [];
  const noSituation: FundraisingIntelligenceCandidate[] = [];

  for (const donor of donorInputs) {
    const result = resultByDonorId.get(donor.donorId);
    if (!result) continue; // defensive -- every donorInput has a matching result by construction of scorePortfolioFocus
    const asks = asksByDonor.get(donor.donorId) ?? [];
    const facts = factsByDonor.get(donor.donorId) ?? [];
    const signals = detectSituations(donor, result, asks, facts, now);
    const candidate = synthesizeDonorCandidate(donor, result, signals);
    if (candidate) withSituation.push(candidate);
    else noSituation.push(buildNoSituationCandidate(donor, result));
  }

  withSituation.sort(compareCandidates);

  const items = withSituation.slice(0, SELECTION_CAP).map((c) => ({ ...c, included: true }));
  const excludedByCap = withSituation.slice(SELECTION_CAP).map((c) => ({ ...c, included: false, suppressionReason: "excluded_by_selection_cap" }));

  const rejected = [...excludedByCap, ...noSituation];

  const suppressionReasonCounts: Record<string, number> = {};
  for (const r of rejected) {
    const key = r.suppressionReason ?? "unknown";
    suppressionReasonCounts[key] = (suppressionReasonCounts[key] ?? 0) + 1;
  }

  const dispositionCounts: Record<BriefDisposition, number> = { KNOW: 0, DO: 0, KNOW_DO: 0 };
  for (const item of items) dispositionCounts[item.disposition] += 1;

  const situationTypeCounts: Record<string, number> = {};
  for (const item of items) situationTypeCounts[item.situationType] = (situationTypeCounts[item.situationType] ?? 0) + 1;

  return {
    items,
    rejected,
    computedAt: now,
    donorCount: donorInputs.length,
    suppressionReasonCounts,
    dispositionCounts,
    situationTypeCounts,
  };
}

// Convenience wrapper for callers (Today page, calibration script) that
// only have the raw D1 pull -- reuses the exact same, already-fetched
// bounded raw data Portfolio Focus's own `loadPortfolioFocusRawData()`
// returns. Runs Portfolio Focus's real aggregation/scoring exactly
// once, never twice, and never issues a query of its own.
export function buildFundraisingIntelligenceBriefFromRaw(raw: PortfolioFocusRawData, now: number, timezone: string): FundraisingIntelligenceBriefResult {
  const { donorInputs, financialEventAmounts } = aggregatePortfolioFocusInputs(raw, now, timezone);
  const ctx = buildPortfolioContext(donorInputs, financialEventAmounts);
  const results = scorePortfolioFocus(donorInputs, ctx);
  const asksByDonor = group(raw.asks, (a) => a.donor_id);
  const factsByDonor = group(raw.relationshipFacts, (f) => f.donor_id);
  return buildFundraisingIntelligenceBrief(donorInputs, results, asksByDonor, factsByDonor, now);
}

export type { FundraisingIntelligenceBriefResult, FundraisingIntelligenceCandidate } from "./types.ts";
export type { DetectedSignal } from "./situations.ts";
