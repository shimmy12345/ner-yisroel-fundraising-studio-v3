import { AppShell } from "./components/AppShell";
import { BriefExperience } from "./components/BriefExperience";
import { RelationshipQueueExperience } from "./components/RelationshipQueueExperience";
import { LocalDate } from "./components/LocalDate";
import { ActivityActions } from "./components/ActivityActions";
import { WelcomeExperience } from "./onboarding/WelcomeExperience";
import { requireChatGPTUser } from "./chatgpt-auth";
import { ensureUserProfile } from "../lib/auth/profile";
import { loadWorkspaceBrief, type WorkspaceScheduledActivity } from "../lib/workspace/live-data";
import type { WorkspaceRelationshipDateEvent } from "../lib/workspace/relationship-date-events";
import { timeOfDayGreeting } from "../lib/workspace/local-time";
import { shouldShowOnboarding } from "../lib/onboarding/status";
import { getDataMode } from "../lib/workspace/mode";
import { donorNavigationHref, meetingBriefNavigationHref } from "../lib/navigation/donor-navigation";
import { computePortfolioFocus } from "../lib/portfolio-focus/index";
import { buildTodayPortfolioFocusRows, type TodayPortfolioFocusRow } from "../lib/portfolio-focus/today-view";
import { logger } from "../lib/logger";

export const dynamic = "force-dynamic";

function ScheduledActivityCard({ activity, live, upcoming = false }: { activity: WorkspaceScheduledActivity; live: boolean; upcoming?: boolean }) {
  const returnTo = upcoming ? "/#upcoming-schedule" : "/#today-schedule";
  const openHref = donorNavigationHref(activity.donorId, returnTo, "today");
  const prepareHref = meetingBriefNavigationHref(activity.donorId, returnTo, "today");
  return <article className="meeting today-meeting-card scheduled-activity-card">
    <div className="meeting-time"><strong>{activity.time}</strong><span>{activity.period}</span>{upcoming && <small>{activity.date}</small>}</div>
    <div className="meeting-line" />
    <div className="mini-avatar scheduled-donor-avatar">{activity.initials}</div>
    <div>
      <div className="scheduled-activity-heading"><span className="event-type">{activity.typeLabel}</span><h3><a href={openHref}>{activity.donorName}</a></h3>{activity.donorCode && <span className="donor-code">{activity.donorCode}</span>}</div>
      <strong className="scheduled-subject">{activity.subject}</strong>
      <p>{activity.note}</p>
      <div className="meeting-links">
        {live && activity.prepareHref ? <a href={prepareHref}>Prepare</a> : <a href={openHref}>Open donor</a>}
        {live && activity.logOutcomeHref && <a href={activity.logOutcomeHref}>Log Outcome</a>}
      </div>
      {live && <ActivityActions activityId={activity.id} editHref={activity.editHref} scheduled canCancel={activity.canCancel} />}
    </div>
  </article>;
}

// Date-driven relationship events (currently yahrtzeits; birthdays and
// anniversaries plug into the same WorkspaceRelationshipDateEvent shape
// later, rendered by this same row -- nothing here is yahrtzeit-specific
// except the copy the event itself supplies). Deliberately unconditional --
// this list is never filtered by, or competing against, the canonical
// recommendation ranking; it's a direct read of "is this date inside its
// lead window," nothing more. Rendering it never writes anything.
//
// Compact by design: a single row, not a card, so a handful of events read
// like a calendar rather than a second priority list. The provenance name
// (e.g. deceased name) is intentionally the lowest-priority line -- it stays
// on its own truncated line even when it happens to repeat the relationship
// text verbatim (e.g. relationship "Mother", deceased name "mother"), since
// those are two independent fields, not a duplicate render.
function RelationshipDateEventRow({ event, today = false }: { event: WorkspaceRelationshipDateEvent; today?: boolean }) {
  const openHref = donorNavigationHref(event.donorId, today ? "/#today-agenda-title" : "/#coming-up-title", "today");
  return <article className="relationship-date-row">
    <div className="relationship-date-row-date">{event.dateLabel}</div>
    <div className="relationship-date-row-body">
      <div className="relationship-date-row-heading">
        <a href={openHref}>{event.donorName}</a>
        {event.donorCode && <span className="donor-code">{event.donorCode}</span>}
      </div>
      <p className="relationship-date-row-meaning">
        <span className="event-type">{event.label}</span>
        {event.relationshipPhrase}{event.secondaryDateLabel ? ` · ${event.secondaryDateLabel}` : ""}
      </p>
      {event.provenanceName && <p className="relationship-date-row-provenance">
        Deceased: {event.provenanceName}
        {event.provenanceNameHebrew && <> · <bdi dir="rtl">{event.provenanceNameHebrew}</bdi></>}
      </p>}
      {event.ambiguous && <small className="capture-error">A future occurrence falls in a leap year -- the date shown is valid as recorded, but the specific recurrence needs review.</small>}
    </div>
  </article>;
}

// Portfolio Focus (Phase 2A, 2026-08-28) -- strategic orientation
// ("where should limited attention go this month"), never a task list.
// Rank is rendered small/muted (never the dominant element) and no raw
// score, component value, or internal classification name is ever shown
// here -- see docs/PORTFOLIO-FOCUS-UX-DESIGN.md Sections 5/7/8. The row
// name is the only link, matching RelationshipDateEventRow/
// ScheduledActivityCard's own convention above.
function PortfolioFocusRow({ row }: { row: TodayPortfolioFocusRow }) {
  const openHref = donorNavigationHref(row.donorId, "/#portfolio-focus-title", "today");
  return <article className="portfolio-focus-row">
    <div className="portfolio-focus-row-rank" aria-hidden="true">{row.rank}</div>
    <div className="portfolio-focus-row-body">
      <div className="portfolio-focus-row-heading">
        <a href={openHref}>{row.displayName}</a>
        {row.donorCode && <span className="donor-code">{row.donorCode}</span>}
      </div>
      <p className="portfolio-focus-row-why">
        <span className="event-type">{row.attentionLabel}</span>
        {row.whyNow}
      </p>
    </div>
  </article>;
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ priorities?: string }> }) {
  if (await shouldShowOnboarding()) return <WelcomeExperience />;
  const identity = await requireChatGPTUser("/");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const showAll = (await searchParams).priorities === "all";
  const now = Math.floor(Date.now() / 1000);

  // Portfolio Focus (Phase 2A): strategic, additive to Today, never
  // required for the page to render, and never sharing a query/loader
  // with loadWorkspaceBrief -- it reads via its own bounded, batched 12
  // D1 queries (lib/portfolio-focus/data.ts). Run alongside
  // loadWorkspaceBrief (Promise.all) rather than after it so the two
  // independent loads overlap instead of adding sequential latency.
  // computePortfolioFocus() only has meaning against real live data
  // (data.ts has no demo branch), so it's skipped entirely outside live
  // mode -- not called then discarded. This function always resolves
  // (never rejects): a computation failure degrades this one section to
  // empty (see item 18's zero-result handling below) rather than failing
  // the whole Today page, and is logged, never swallowed silently, and
  // never backed by fake/stale data.
  async function loadPortfolioFocusForToday(): Promise<TodayPortfolioFocusRow[]> {
    if (mode !== "live") return [];
    try {
      const results = await computePortfolioFocus(profile.id, profile.timezone, now);
      return buildTodayPortfolioFocusRows(results, 5);
    } catch (error) {
      logger.error("portfolio_focus_today_load_failed", error, { userId: profile.id });
      return [];
    }
  }

  const [data, portfolioFocusRows] = await Promise.all([
    loadWorkspaceBrief(profile.id, profile.timezone, mode, now, showAll ? 50 : 10, "today"),
    loadPortfolioFocusForToday(),
  ]);
  const greeting = timeOfDayGreeting(now, profile.timezone);
  const agendaQueueCount = data.relationshipQueue.overdue.length + data.relationshipQueue.today.length;
  const comingQueueCount = data.relationshipQueue.thisWeek.length + data.relationshipQueue.upcoming.length;
  const agendaIsEmpty = agendaQueueCount === 0 && data.todaySchedule.length === 0 && data.todayRelationshipDates.length === 0;
  const comingIsEmpty = comingQueueCount === 0 && data.upcomingActivities.length === 0 && data.upcomingRelationshipDates.length === 0;
  const visibleUpcomingActivities = showAll ? data.upcomingActivities : data.upcomingActivities.slice(0, agendaIsEmpty ? 5 : 3);

  return <AppShell active="today">
    <header className="page-header today-header"><div><p className="eyebrow today-date"><LocalDate timezone={profile.timezone} /></p><h1>{greeting}, {profile.preferredFirstName}.</h1><p className="subhead">Start with today. The most urgent relationship work is already at the top.</p></div></header>

    <section className="today-brief-section" aria-labelledby="morning-brief-section-title"><div className="command-section-heading"><div><p className="eyebrow">DAILY PREP</p><h2 id="morning-brief-section-title">Morning Brief</h2></div></div><BriefExperience surface="today" data={data} timezone={profile.timezone} /></section>

    <section className={`today-actions-section ${agendaIsEmpty && comingIsEmpty ? "emphasized" : ""}`} aria-labelledby="quick-actions-title">
      <div className="command-section-heading"><div><p className="eyebrow">START SOMETHING</p><h2 id="quick-actions-title">Quick Actions</h2></div></div>
      <nav className="today-quick-actions" aria-label="Quick actions">
        <a href="/donors"><span>⌕</span><strong>Search Donor</strong><small>Find any relationship</small></a>
        <a href="/onboarding/import"><span>⇧</span><strong>Import JL Export</strong><small>Refresh households or gifts</small></a>
        <a href="/capture?returnTo=%2F"><span>＋</span><strong>Add Interaction</strong><small>Log a call, email, or note</small></a>
        <a href="/capture?returnTo=%2F"><span>✓</span><strong>Create Reminder</strong><small>Add it with an interaction</small></a>
        <a href="/settings#data-health"><span>◇</span><strong>Workspace Health</strong><small>Check data integrity</small></a>
      </nav>
    </section>

    <div className={`today-command-grid ${agendaIsEmpty ? "agenda-empty" : ""}`}>
      <section className="today-command-section today-agenda" aria-labelledby="today-agenda-title">
        <div className="command-section-heading"><div><p className="eyebrow">TODAY</p><h2 id="today-agenda-title">Today's Agenda</h2></div><span className="count">{agendaQueueCount + data.todaySchedule.length + data.todayRelationshipDates.length}</span></div>
        {data.todayRelationshipDates.length ? <div className="relationship-date-list">{data.todayRelationshipDates.map((event) => <RelationshipDateEventRow event={event} today key={event.id} />)}</div> : null}
        {data.todaySchedule.length ? <div className="today-meeting-list command-activity-list">{data.todaySchedule.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} key={item.id} />)}</div> : null}
        {agendaQueueCount ? <RelationshipQueueExperience scope="agenda" initialQueue={data.relationshipQueue} priorityCount={data.priorityCount} showAll={showAll} expanded={showAll} /> : null}
        {agendaIsEmpty && <p className="command-empty">✓ No activities or follow-ups need attention today.</p>}
      </section>

      <section className="today-command-section today-coming-up" aria-labelledby="coming-up-title">
        <div className="command-section-heading"><div><p className="eyebrow">NEXT</p><h2 id="coming-up-title">Coming Up</h2></div><span className="count">{comingQueueCount + data.upcomingActivities.length + data.upcomingRelationshipDates.length}</span></div>
        {/* Desktop-only bounded/scrollable body (see .today-coming-up .command-panel-body
            in globals.css) -- keeps the header pinned above the fold and lets a long
            Coming Up list (up to ~20 entries) scroll internally instead of stretching
            the whole page. Below the desktop breakpoint this wrapper has no height
            constraint, so tablet/mobile keep the existing natural, single-scroll stack. */}
        <div className="command-panel-body">
          {data.upcomingRelationshipDates.length ? <div className="relationship-date-list">{data.upcomingRelationshipDates.map((event) => <RelationshipDateEventRow event={event} key={event.id} />)}</div> : null}
          {visibleUpcomingActivities.length ? <div className="today-meeting-list command-activity-list">{visibleUpcomingActivities.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} upcoming key={item.id} />)}</div> : null}
          {comingQueueCount ? <RelationshipQueueExperience scope="coming" initialQueue={data.relationshipQueue} priorityCount={data.priorityCount} showAll={showAll} expanded={showAll || agendaIsEmpty} /> : null}
          {!showAll && data.upcomingActivities.length > visibleUpcomingActivities.length && <a className="view-all-link command-view-all" href="/?priorities=all#coming-up-title">View all upcoming activities</a>}
          {comingIsEmpty && <p className="command-empty">No meetings, reminders, commitments, or relationship dates are coming up.</p>}
        </div>
      </section>
    </div>

    {portfolioFocusRows.length > 0 && <section className="today-command-section portfolio-focus-section" aria-labelledby="portfolio-focus-title">
      <div className="command-section-heading"><div><p className="eyebrow">THIS MONTH</p><h2 id="portfolio-focus-title">Portfolio Focus</h2></div></div>
      <p className="portfolio-focus-intro">Five relationships worth keeping in mind this month, independent of today&rsquo;s scheduled work.</p>
      <div className="portfolio-focus-list">{portfolioFocusRows.map((row) => <PortfolioFocusRow row={row} key={row.donorId} />)}</div>
      <a className="view-all-link command-view-all" href="/portfolio-focus">See full portfolio →</a>
    </section>}
  </AppShell>;
}
