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

// Round 2 calibration finding: with no reservation, tier-1 (task-like)
// signals alone can consume the entire cap and crowd out a strategically
// important KNOW item -- Avi Stein, the portfolio's #1-ranked donor, was
// excluded entirely in the V1 real-data run despite a genuine, real
// `stewardship_moment` signal. 3 was chosen after testing 0/3/4/5 against
// the real 254-donor population (see docs/FUNDRAISING-INTELLIGENCE-
// BRIEF-PHASE1-CALIBRATION-V2.md §2/§3): the real tier-1 population is
// exactly 12 items, and cap(15) - 3 = 12 -- so 3 is the LARGEST
// reservation size that still lets every real tier-1 (explicit-
// follow-up/ask-resolution/stale-pledge) item through untouched. At 3,
// the 3 reserved slots go to the 3 highest-Portfolio-Focus-rank
// remaining KNOW candidates found in the real data (ranks #1, #4, #6 --
// Avi Stein among them), a clean swap for 3 lower-ranked KNOW items that
// would otherwise have filled the same slots naturally, with ZERO DO/
// KNOW_DO items displaced. 4 and 5 recover nothing further of comparable
// strategic value and instead start displacing real DO items (confirmed
// against the real run: DO count drops from 4 to 3 to 2 as the
// reservation grows from 3 to 4 to 5) -- exactly the "do not suppress
// obviously urgent DO items" failure mode this round warned against.
export const DEFAULT_RESERVED_KNOW_SLOTS = 3;

// Reservation eligibility (§4 of the Round 2 instruction): reused
// materiality gate is intentionally the SAME existing
// financialSignificance percentile threshold already used by
// detectFinancialChange -- not a new score, and not the sole criterion
// (a candidate must ALSO already carry a real, independently-fired KNOW
// situation to reach this pool at all; see synthesizeDonorCandidate).
// This is what keeps a low-materiality "on-track $10 pledge"
// stewardship_moment from ever claiming a reserved slot.
const KNOW_RESERVATION_FS_FLOOR = 0.5;

export function isReservedKnowEligible(candidate: FundraisingIntelligenceCandidate): boolean {
  return candidate.disposition === "KNOW" && candidate.debug.financialSignificance >= KNOW_RESERVATION_FS_FLOOR;
}

// Within the reserved pool, select by Portfolio Focus's own overall
// RANK (composite score -- financial significance, opportunity,
// stewardship, momentum, tactical urgency combined), not by the
// financialSignificance component alone. Found necessary during
// calibration: Avi Stein is the portfolio's #1-ranked relationship
// specifically because of his active pledge (Opportunity/Stewardship),
// not because he has the single highest financialSignificance
// percentile in the portfolio -- sorting the reserved pool by FS alone
// kept recovering higher-FS-but-lower-rank donors (e.g. a bigger
// lifetime-giving donor with no current activity) instead of Stein. The
// FS floor above still GATES eligibility (so a low-materiality KNOW
// item never enters this pool at all); rank only decides ORDER among
// pool members that already cleared that gate -- rank is a tie-break
// on top of the materiality gate, never the sole qualification.
function byPortfolioFocusRank(a: FundraisingIntelligenceCandidate, b: FundraisingIntelligenceCandidate): number {
  if (a.debug.portfolioFocusRank !== b.debug.portfolioFocusRank) return a.debug.portfolioFocusRank - b.debug.portfolioFocusRank;
  if (a.debug.financialSignificance !== b.debug.financialSignificance) return b.debug.financialSignificance - a.debug.financialSignificance;
  return a.donorId.localeCompare(b.donorId);
}

// The smallest deterministic balancing mechanism tested (§3): fill most
// of the cap by normal priority order, reserve a small number of slots
// specifically for strategically meaningful KNOW items that would
// otherwise lose to tier-1 task volume, and return any UNUSED reserved
// slots to the general pool rather than leaving them empty or padding
// with weak filler.
export function selectWithKnowReservation(
  sorted: readonly FundraisingIntelligenceCandidate[],
  cap: number,
  reservedSlots: number,
): { included: FundraisingIntelligenceCandidate[]; excluded: FundraisingIntelligenceCandidate[] } {
  const regularCapacity = Math.max(0, cap - reservedSlots);
  const regularFill = sorted.slice(0, regularCapacity);
  const regularFillIds = new Set(regularFill.map((c) => c.donorId));

  const reservedPool = sorted.filter((c) => !regularFillIds.has(c.donorId) && isReservedKnowEligible(c)).sort(byPortfolioFocusRank);
  const reservedFill = reservedPool.slice(0, reservedSlots);
  const reservedFillIds = new Set(reservedFill.map((c) => c.donorId));

  const usedSlots = regularFill.length + reservedFill.length;
  const backfillCapacity = Math.max(0, cap - usedSlots); // unused reserved slots return to the general pool, per instruction
  const backfillPool = sorted.filter((c) => !regularFillIds.has(c.donorId) && !reservedFillIds.has(c.donorId));
  const backfill = backfillPool.slice(0, backfillCapacity);

  const includedIds = new Set([...regularFillIds, ...reservedFillIds, ...backfill.map((c) => c.donorId)]);
  return {
    included: sorted.filter((c) => includedIds.has(c.donorId)), // preserve the original deterministic order
    excluded: sorted.filter((c) => !includedIds.has(c.donorId)),
  };
}

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
  reservedKnowSlots: number = DEFAULT_RESERVED_KNOW_SLOTS,
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

  const { included: selected, excluded: excludedByCapOrReservation } = selectWithKnowReservation(withSituation, SELECTION_CAP, reservedKnowSlots);
  const items = selected.map((c) => ({ ...c, included: true }));
  const excludedByCap = excludedByCapOrReservation.map((c) => ({ ...c, included: false, suppressionReason: "excluded_by_selection_cap" }));

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
export function buildFundraisingIntelligenceBriefFromRaw(
  raw: PortfolioFocusRawData,
  now: number,
  timezone: string,
  reservedKnowSlots: number = DEFAULT_RESERVED_KNOW_SLOTS,
): FundraisingIntelligenceBriefResult {
  const { donorInputs, financialEventAmounts } = aggregatePortfolioFocusInputs(raw, now, timezone);
  const ctx = buildPortfolioContext(donorInputs, financialEventAmounts);
  const results = scorePortfolioFocus(donorInputs, ctx);
  const asksByDonor = group(raw.asks, (a) => a.donor_id);
  const factsByDonor = group(raw.relationshipFacts, (f) => f.donor_id);
  return buildFundraisingIntelligenceBrief(donorInputs, results, asksByDonor, factsByDonor, now, reservedKnowSlots);
}

export type { FundraisingIntelligenceBriefResult, FundraisingIntelligenceCandidate } from "./types.ts";
export type { DetectedSignal } from "./situations.ts";
