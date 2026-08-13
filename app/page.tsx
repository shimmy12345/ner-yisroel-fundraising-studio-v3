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
// later without another homepage change). Deliberately unconditional --
// this list is never filtered by, or competing against, the canonical
// recommendation ranking; it's a direct read of "is this date inside its
// lead window," nothing more. Rendering it never writes anything.
function RelationshipDateEventCard({ event }: { event: WorkspaceRelationshipDateEvent }) {
  const openHref = donorNavigationHref(event.donorId, "/#coming-up-title", "today");
  return <article className="meeting today-meeting-card relationship-date-event-card">
    <div className="meeting-time"><strong>{event.dateLabel}</strong></div>
    <div className="meeting-line" />
    <div className="mini-avatar scheduled-donor-avatar">{event.initials}</div>
    <div>
      <div className="scheduled-activity-heading"><span className="event-type">{event.label}</span><h3><a href={openHref}>{event.donorName}</a></h3>{event.donorCode && <span className="donor-code">{event.donorCode}</span>}</div>
      <p>{event.detail}</p>
      {event.ambiguous && <small className="capture-error">A future occurrence falls in a leap year -- the date shown is valid as recorded, but the specific recurrence needs review.</small>}
      <div className="meeting-links"><a href={openHref}>Open donor</a></div>
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
  const data = await loadWorkspaceBrief(profile.id, profile.timezone, mode, now, showAll ? 50 : 10);
  const greeting = timeOfDayGreeting(now, profile.timezone);
  const agendaQueueCount = data.relationshipQueue.overdue.length + data.relationshipQueue.today.length;
  const comingQueueCount = data.relationshipQueue.thisWeek.length + data.relationshipQueue.upcoming.length;
  const agendaIsEmpty = agendaQueueCount === 0 && data.todaySchedule.length === 0;
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
        <div className="command-section-heading"><div><p className="eyebrow">TODAY</p><h2 id="today-agenda-title">Today's Agenda</h2></div><span className="count">{agendaQueueCount + data.todaySchedule.length}</span></div>
        {data.todaySchedule.length ? <div className="today-meeting-list command-activity-list">{data.todaySchedule.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} key={item.id} />)}</div> : null}
        {agendaQueueCount ? <RelationshipQueueExperience scope="agenda" initialQueue={data.relationshipQueue} priorityCount={data.priorityCount} showAll={showAll} expanded={showAll} /> : null}
        {agendaIsEmpty && <p className="command-empty">✓ No activities or follow-ups need attention today.</p>}
      </section>

      <section className="today-command-section today-coming-up" aria-labelledby="coming-up-title">
        <div className="command-section-heading"><div><p className="eyebrow">NEXT</p><h2 id="coming-up-title">Coming Up</h2></div><span className="count">{comingQueueCount + data.upcomingActivities.length + data.upcomingRelationshipDates.length}</span></div>
        {data.upcomingRelationshipDates.length ? <div className="today-meeting-list command-activity-list">{data.upcomingRelationshipDates.map((event) => <RelationshipDateEventCard event={event} key={event.id} />)}</div> : null}
        {visibleUpcomingActivities.length ? <div className="today-meeting-list command-activity-list">{visibleUpcomingActivities.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} upcoming key={item.id} />)}</div> : null}
        {comingQueueCount ? <RelationshipQueueExperience scope="coming" initialQueue={data.relationshipQueue} priorityCount={data.priorityCount} showAll={showAll} expanded={showAll || agendaIsEmpty} /> : null}
        {!showAll && data.upcomingActivities.length > visibleUpcomingActivities.length && <a className="view-all-link command-view-all" href="/?priorities=all#coming-up-title">View all upcoming activities</a>}
        {comingIsEmpty && <p className="command-empty">No meetings, reminders, commitments, or relationship dates are coming up.</p>}
        <p className="future-placeholder"><span aria-hidden="true">○</span> Birthdays and anniversaries will appear here in a future update.</p>
      </section>
    </div>
  </AppShell>;
}
