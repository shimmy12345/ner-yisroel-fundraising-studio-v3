// Fundraising Intelligence Brief -- dedicated-page rendering. No client
// state needed (the evidence disclosure below is native <details>, which
// works without JavaScript) -- a plain server component, same as the
// rest of this page. Renders ONLY already-computed IntelligenceBriefRow
// data; never re-derives a disposition, group, or label.
import { donorNavigationHref } from "../../lib/navigation/donor-navigation";
import { groupIntelligenceBriefRows, INTELLIGENCE_GROUP_LABELS, INTELLIGENCE_GROUP_ORDER, type IntelligenceBriefRow } from "../../lib/fundraising-intelligence/dedicated-view";

// KNOW cards intentionally carry no checkbox, no "Complete" action, and
// no overdue/urgency styling -- they read as strategic intelligence, not
// a task. DO/KNOW+DO cards show the engine-supplied action as a plain
// sentence, never a task-management control (status, due date, owner,
// snooze) -- this phase is intelligence display, not task management.
function IntelligenceCard({ row }: { row: IntelligenceBriefRow }) {
  const openHref = donorNavigationHref(row.donorId, "/fundraising-intelligence", "fundraising-intelligence");
  return <article className={`fib-card fib-card-${row.disposition.toLowerCase()}`}>
    <div className="fib-card-top">
      <span className={`fib-badge fib-badge-${row.disposition.toLowerCase()}`}>{row.dispositionLabel}</span>
      <span className="event-type">{row.situationLabel}</span>
    </div>
    <h3 className="fib-card-name"><a href={openHref}>{row.displayName}</a></h3>
    <p className="fib-card-headline">{row.headline}</p>
    <p className="fib-card-explanation">{row.explanation}</p>
    <p className="fib-card-why"><span className="fib-field-label">Why now</span>{row.whyNow}</p>
    {row.whatFosDoesNotKnow && <p className="fib-card-gap">{row.whatFosDoesNotKnow}</p>}
    {row.possibleAction && <p className="fib-card-action"><span className="fib-field-label">Worth doing</span>{row.possibleAction}</p>}
    <div className="fib-card-footer">
      <a href={openHref}>Open donor →</a>
      <details className="fib-evidence">
        <summary>Why FOS surfaced this</summary>
        <ul>
          {row.evidenceLines.map((line, index) => <li key={index}>{line}</li>)}
          <li className="fib-evidence-confidence">{row.confidenceLabel} -- {row.confidenceExplanation}</li>
          <li className="fib-evidence-rank">Portfolio Focus rank: #{row.portfolioFocusRank}</li>
        </ul>
      </details>
    </div>
  </article>;
}

export function FundraisingIntelligenceExperience({ rows }: { rows: IntelligenceBriefRow[] }) {
  const groups = groupIntelligenceBriefRows(rows);
  return <>
    <p className="fib-scope">{rows.length} {rows.length === 1 ? "item" : "items"}, based on current Fundraising OS data.</p>
    {INTELLIGENCE_GROUP_ORDER.map((groupId) => {
      const groupRows = groups[groupId];
      if (groupRows.length === 0) return null;
      return <section className="fib-group" aria-labelledby={`fib-group-${groupId}-title`} key={groupId}>
        <div className="command-section-heading">
          <h2 id={`fib-group-${groupId}-title`}>{INTELLIGENCE_GROUP_LABELS[groupId]}</h2>
          <span className="count">{groupRows.length}</span>
        </div>
        <div className="fib-card-list">{groupRows.map((row) => <IntelligenceCard row={row} key={row.donorId} />)}</div>
      </section>;
    })}
  </>;
}
