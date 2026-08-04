import { AppShell } from "./components/AppShell";
import { BriefExperience } from "./components/BriefExperience";
import { RelationshipQueueExperience } from "./components/RelationshipQueueExperience";
import { LocalDate } from "./components/LocalDate";
import { ActivityActions } from "./components/ActivityActions";
import { WelcomeExperience } from "./onboarding/WelcomeExperience";
import { requireChatGPTUser } from "./chatgpt-auth";
import { ensureUserProfile } from "../lib/auth/profile";
import { loadWorkspaceBrief, type WorkspaceDonorLink, type WorkspaceScheduledActivity } from "../lib/workspace/live-data";
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
    <div>
      <div className="scheduled-activity-heading"><span className="event-type">{activity.typeLabel}</span><h3><a href={openHref}>{activity.donorName}</a></h3></div>
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

function DonorStrip({ id, title, description, donors }: { id: string; title: string; description: string; donors: WorkspaceDonorLink[] }) {
  const returnTo = `/#${id}`;
  return <section className="today-relationship-strip" id={id}><div className="section-title"><div><h2>{title}</h2><p>{description}</p></div><span className="count">{donors.length}</span></div>
    {donors.length ? <div className="relationship-link-list">{donors.map((donor) => <a href={donorNavigationHref(donor.donorId, returnTo, "recent")} key={donor.donorId}><span className="mini-avatar">{donor.initials}</span><span><strong>{donor.name}</strong><small>{donor.detail}</small></span><span aria-hidden="true">→</span></a>)}</div> : <p className="empty-copy">Nothing to show yet. Open or update a donor relationship and it will appear here.</p>}
  </section>;
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ priorities?: string }> }) {
  if (await shouldShowOnboarding()) return <WelcomeExperience />;
  const identity = await requireChatGPTUser("/");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const showAll = (await searchParams).priorities === "all";
  const data = await loadWorkspaceBrief(profile.id, profile.timezone, mode, Math.floor(Date.now() / 1000), showAll ? 50 : 10);
  const nextMeeting = mode === "live" ? data.meetings[0] : null;

  return <AppShell active="today">
    <header className="page-header today-header"><div><p className="eyebrow today-date"><LocalDate timezone={profile.timezone} /> · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Good morning, {profile.preferredFirstName}.</h1><p className="subhead">Your daily relationship workspace—start with what needs attention, then move through the queue.</p></div></header>

    <nav className="today-quick-actions" aria-label="Quick actions">
      <a href="/capture?returnTo=%2F"><span>＋</span><strong>Log Interaction</strong><small>Capture a call, email, or note</small></a>
      <a href="/capture?type=meeting&returnTo=%2F"><span>◷</span><strong>Schedule Meeting</strong><small>Choose a donor and future time</small></a>
      <a href="/donors"><span>⌕</span><strong>Find Donor</strong><small>Search your live relationships</small></a>
      <a href="/donors/new"><span>＋</span><strong>New Donor</strong><small>Add a relationship manually</small></a>
      <a href={nextMeeting ? meetingBriefNavigationHref(nextMeeting.donorId, "/", "today") : "/donors"}><span>☼</span><strong>Prepare for Meeting</strong><small>{nextMeeting ? "Open your next donor brief" : "Choose a donor to prepare"}</small></a>
    </nav>

    <RelationshipQueueExperience initialQueue={data.relationshipQueue} morningBrief={data.morningBrief} priorityCount={data.priorityCount} showAll={showAll} />

    <section className="today-upcoming today-schedule" id="today-schedule">
      <div className="section-title"><div><h2>Today's Schedule</h2><p>Calls, emails, meetings, visits, notes, and personal interactions scheduled for today</p></div><span className="count">{data.todaySchedule.length}</span></div>
      {data.todaySchedule.length ? <div className="today-meeting-list">{data.todaySchedule.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} key={item.id} />)}</div> : <p className="empty-copy">No relationship activities are scheduled for today.</p>}
    </section>

    <section className="today-upcoming" id="upcoming-schedule">
      <div className="section-title"><div><h2>Upcoming scheduled activities</h2><p>Future calls, emails, meetings, visits, notes, and personal interactions</p></div><span className="count">{data.upcomingActivities.length}</span></div>
      {data.upcomingActivities.length ? <div className="today-meeting-list">{data.upcomingActivities.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} upcoming key={item.id} />)}</div> : <p className="empty-copy">No future relationship activities are scheduled.</p>}
    </section>

    <BriefExperience surface="today" data={data} />

    <div className="today-relationship-strips">
      <DonorStrip id="recently-viewed" title="Recently viewed donors" description="Return to relationships you opened most recently" donors={data.recentlyViewed} />
      <DonorStrip id="recently-updated" title="Recently updated relationships" description="Donors with recent contact, giving, reminder, or profile changes" donors={data.recentlyUpdated} />
    </div>

    <section className="today-recent-activity" id="recent-activity">
      <div className="section-title"><div><h2>Recent giving activity</h2><p>Paid gifts recorded in the last 30 days</p></div><span className="count">{data.gifts.length}</span></div>
      {data.gifts.length ? <div className="today-gift-list">{data.gifts.map((gift) => <a className="gift-row" key={gift.id} href={donorNavigationHref(gift.donorId, "/#recent-activity", "recent")}><div className="mini-avatar">{gift.initials}</div><div><h3>{gift.name}</h3><p>{gift.detail}</p></div><strong>{gift.amount}</strong></a>)}</div> : <p className="empty-copy">No gifts were recorded in the last 30 days.</p>}
    </section>
  </AppShell>;
}
