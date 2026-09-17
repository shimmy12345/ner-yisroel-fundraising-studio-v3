// Fundraising Intelligence Brief -- Today-page teaser adapter. Pure, no
// D1 access. Derives a small (default 3-item) teaser DETERMINISTICALLY
// from the already-computed Brief -- no second selection engine, no
// re-ranking, no re-scoring. Mirrors lib/portfolio-focus/today-view.ts's
// own "take the engine's own order, slice it" convention.
import type { FundraisingIntelligenceCandidate } from "./types.ts";
import { buildIntelligenceBriefRows, type IntelligenceBriefRow } from "./dedicated-view.ts";

export const DEFAULT_TEASER_LIMIT = 3;

// Selection rule (documented product choice, see docs/AI-HANDOFF.md):
// 1. Prioritize DO and KNOW_DO items, in the Brief's own order (which
//    already front-loads tier-1/task-like signals).
// 2. If fewer than `limit` actionable (DO/KNOW_DO) items exist, backfill
//    with the strongest KNOW items (also in Brief order) to avoid an
//    oddly sparse teaser -- "pure KNOW items generally live on the
//    dedicated page unless there are too few actionable items."
// 3. If there are ZERO actionable items at all, show just the single
//    strongest KNOW item rather than an empty section -- a genuine,
//    real piece of intelligence is always preferable to an
//    administratively empty Today card, but the teaser deliberately
//    does not balloon to 3 pure-KNOW items in this case (that volume of
//    non-actionable content belongs on the dedicated page instead).
export function buildTodayIntelligenceTeaserRows(items: readonly FundraisingIntelligenceCandidate[], limit: number = DEFAULT_TEASER_LIMIT): IntelligenceBriefRow[] {
  const actionable = items.filter((item) => item.disposition === "DO" || item.disposition === "KNOW_DO");
  const know = items.filter((item) => item.disposition === "KNOW");
  const selected = actionable.length > 0 ? [...actionable, ...know].slice(0, limit) : know.slice(0, 1);
  return buildIntelligenceBriefRows(selected);
}
