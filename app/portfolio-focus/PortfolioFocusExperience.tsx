"use client";

// Portfolio Focus -- dedicated view, client-side filtering/expansion
// (Phase 2B, 2026-08-28). Mirrors the existing UnifiedRelationshipTimeline
// convention (app/donors/[id]/UnifiedRelationshipTimeline.tsx): the full,
// already-scored, already-server-computed result set arrives as props
// (a single engine call, made once by the server component -- see
// app/portfolio-focus/page.tsx) and every filter/expand interaction
// here only slices/filters that same in-memory array. Nothing is
// recomputed, refetched, or re-ranked -- a donor's `rank` field is set
// once, server-side, from the engine's own full-portfolio order, and
// survives every filter untouched (docs/PORTFOLIO-FOCUS-UX-DESIGN.md's
// own principle: filtering must never renumber).
import { useMemo, useState } from "react";
import { donorNavigationHref } from "../../lib/navigation/donor-navigation";
import { PORTFOLIO_FOCUS_FILTERS, type DedicatedPortfolioFocusRow, type PortfolioFocusFilterId } from "../../lib/portfolio-focus/dedicated-view";

const DEFAULT_VISIBLE = 25;

function PortfolioFocusRow({ row }: { row: DedicatedPortfolioFocusRow }) {
  const openHref = donorNavigationHref(row.donorId, "/portfolio-focus", "portfolio-focus");
  const t = row.technical;
  return <details className="pf-row">
    <summary className="pf-row-summary">
      <span className="pf-row-rank" aria-hidden="true">{row.rank}</span>
      <span className="pf-row-name">{row.displayName}{row.donorCode && <span className="donor-code">{row.donorCode}</span>}</span>
      <span className="event-type">{row.attentionLabel}</span>
      <span className="pf-row-why">{row.whyNow}</span>
      <span className="pf-context"><span className={`pf-context-dot ${row.contextLevel}`} aria-hidden="true" />{row.contextLabel}</span>
      {row.hasSuggestedAction && <span className="pf-suggested-flag">Suggested Action</span>}
      <span className="pf-row-chevron" aria-hidden="true">›</span>
    </summary>
    <div className="pf-row-detail">
      <p className="pf-explain-lede">{row.explanation.lede}</p>
      <div className="pf-explain-grid">
        <div><span className="pf-explain-label">Financial significance</span><p>{row.explanation.financialSignificance}</p></div>
        <div><span className="pf-explain-label">Opportunity</span><p>{row.explanation.opportunity}</p></div>
        <div><span className="pf-explain-label">Stewardship</span><p>{row.explanation.stewardship}</p></div>
        <div><span className="pf-explain-label">Relationship visibility</span><p>{row.explanation.relationshipVisibility}</p></div>
      </div>
      <p className="pf-explain-tactical">{row.explanation.tactical}</p>
      <p className="pf-explain-confidence">{row.explanation.confidence}</p>
      <div className="pf-row-actions">
        <a href={openHref}>Open donor →</a>
        <details className="tech-toggle">
          <summary>Show technical detail</summary>
          <dl className="pf-tech-grid">
            <div><dt>Composite score</dt><dd>{t.compositeScore.toFixed(4)}</dd></div>
            <div><dt>Base composite</dt><dd>{t.baseComposite.toFixed(4)}</dd></div>
            <div><dt>Financial Significance</dt><dd>{t.financialSignificance.toFixed(4)}</dd></div>
            <div><dt>Opportunity</dt><dd>{t.opportunity.toFixed(4)}</dd></div>
            <div><dt>Stewardship</dt><dd>{t.stewardship.toFixed(4)}</dd></div>
            <div><dt>Momentum</dt><dd>{t.momentum.toFixed(4)} ({t.momentumLabel})</dd></div>
            <div><dt>Tactical Urgency</dt><dd>{t.tacticalUrgency.toFixed(4)}</dd></div>
            <div><dt>Relationship Coverage</dt><dd>{t.coverage.toFixed(4)}</dd></div>
            <div><dt>Coverage floor</dt><dd>{t.coverageFloor.toFixed(4)} {t.coverageTriggered ? "-- determined this donor's composite score" : "-- not triggered"}</dd></div>
            <div><dt>Financial confidence</dt><dd>{t.financialConfidence}</dd></div>
            <div><dt>Relationship confidence</dt><dd>{t.relationshipConfidence}</dd></div>
            {t.pledgeStaleClass && <div><dt>Pledge staleness classification</dt><dd>{t.pledgeStaleClass}</dd></div>}
          </dl>
        </details>
      </div>
    </div>
  </details>;
}

export function PortfolioFocusExperience({ rows }: { rows: DedicatedPortfolioFocusRow[] }) {
  const [filter, setFilter] = useState<PortfolioFocusFilterId>("all");
  const [suggestedOnly, setSuggestedOnly] = useState(false);
  const [visibleCount, setVisibleCount] = useState(DEFAULT_VISIBLE);

  const suggestedFiltered = useMemo(() => suggestedOnly ? rows.filter((row) => row.hasSuggestedAction) : rows, [rows, suggestedOnly]);
  const counts = useMemo(() => new Map(PORTFOLIO_FOCUS_FILTERS.map((option) => [option.id, suggestedFiltered.filter((row) => option.matches(row.attentionType)).length])), [suggestedFiltered]);
  // Filtering only ever narrows the same already-ranked array -- never
  // re-sorted, so each surviving row keeps its true portfolio-wide rank.
  const visible = filter === "all" ? suggestedFiltered : suggestedFiltered.filter((row) => PORTFOLIO_FOCUS_FILTERS.find((option) => option.id === filter)?.matches(row.attentionType));
  const selectedLabel = PORTFOLIO_FOCUS_FILTERS.find((option) => option.id === filter)?.label ?? "ranked";
  const visibleSlice = visible.slice(0, visibleCount);
  const hiddenCount = visible.length - visibleSlice.length;

  function selectFilter(next: PortfolioFocusFilterId) {
    setFilter(next);
    setVisibleCount(DEFAULT_VISIBLE);
  }

  function toggleSuggestedOnly() {
    setSuggestedOnly((value) => !value);
    setVisibleCount(DEFAULT_VISIBLE);
  }

  return <>
    <p className="portfolio-focus-scope">
      Showing {visibleSlice.length} of {visible.length} {filter === "all" ? "ranked relationships" : `${selectedLabel} relationships`}.
      {hiddenCount > 0 && <button type="button" onClick={() => setVisibleCount(visible.length)}>Show full portfolio</button>}
      {visibleCount > DEFAULT_VISIBLE && visible.length > DEFAULT_VISIBLE && <button type="button" onClick={() => setVisibleCount(DEFAULT_VISIBLE)}>Show top {DEFAULT_VISIBLE} only</button>}
    </p>
    <nav className="portfolio-focus-filters" aria-label="Filter Portfolio Focus by attention type">
      {PORTFOLIO_FOCUS_FILTERS.filter((option) => option.id === "all" || (counts.get(option.id) ?? 0) > 0).map((option) => <button key={option.id} type="button" className={filter === option.id ? "active" : ""} aria-pressed={filter === option.id} onClick={() => selectFilter(option.id)}>{option.label}<span>{counts.get(option.id) ?? 0}</span></button>)}
    </nav>
    <label className="portfolio-focus-toggle">
      <input type="checkbox" checked={suggestedOnly} onChange={toggleSuggestedOnly} />
      Suggested Action available only
    </label>
    {visible.length === 0
      ? <div className="pf-empty"><strong>No {selectedLabel.toLowerCase()} relationships right now</strong><p>Choose another filter to continue reviewing the ranked portfolio.</p></div>
      : <div className="pf-list">{visibleSlice.map((row) => <PortfolioFocusRow row={row} key={row.donorId} />)}</div>}
  </>;
}
