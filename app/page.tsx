import { AppShell } from "./components/AppShell";
import { BriefExperience } from "./components/BriefExperience";
import { CompletePriorityButton } from "./components/CompletePriorityButton";
import { DismissQueueSuggestionButton } from "./components/DismissQueueSuggestionButton";
import { LocalDate } from "./components/LocalDate";
import { ActivityActions } from "./components/ActivityActions";
import { WelcomeExperience } from "./onboarding/WelcomeExperience";
import { requireChatGPTUser } from "./chatgpt-auth";
import { ensureUserProfile } from "../lib/auth/profile";
import { loadWorkspaceBrief, type WorkspaceDonorLink, type WorkspacePriority, type WorkspaceScheduledActivity } from "../lib/workspace/live-data";
import { shouldShowOnboarding } from "../lib/onboarding/status";
import { getDataMode } from "../lib/workspace/mode";
import type { RelationshipQueueBucket } from "../lib/workspace/relationship-queue";

export const dynamic = "force-dynamic";

const QUEUE_GROUPS: Array<{ key: RelationshipQueueBucket; title: string; description: string }> = [
  { key: "overdue", title: "Overdue", description: "Follow-ups that need attention first" },
  { key: "today", title: "Today", description: "Work that matters before the day ends" },
  { key: "thisWeek", title: "This Week", description: "Due in the next seven days" },
  { key: "upcoming", title: "Upcoming", description: "Important work without an immediate deadline" },
];

function QueueCard({ priority }: { priority: WorkspacePriority }) {
  return <article className={`priority-card relationship-queue-card ${priority.bucket}`}>
    <div className="avatar">{priority.initials}</div>
    <div className="priority-main">
      <div className="priority-heading"><h3><a href={`/donors/${encodeURIComponent(priority.donorId)}`}>{priority.name}</a></h3><span className={`signal ${priority.signal}`}>{priority.label}</span></div>
      <p>{priority.reason}</p>
      <div className="why"><span aria-hidden="true">✦</span><span>{priority.why}</span></div>
      <time>{priority.dueLabel}</time>
    </div>
    <div className="priority-actions">
      <a className="action-button" href={priority.href}>{priority.action}<span aria-hidden="true">→</span></a>
      {priority.recommendationId ? <CompletePriorityButton recommendationId={priority.recommendationId} /> : <DismissQueueSuggestionButton queueId={priority.queueId} donorId={priority.donorId} />}
    </div>
  </article>;
}

function ScheduledActivityCard({ activity, live, upcoming = false }: { activity: WorkspaceScheduledActivity; live: boolean; upcoming?: boolean }) {
  return <article className="meeting today-meeting-card scheduled-activity-card">
    <div className="meeting-time"><strong>{activity.time}</strong><span>{activity.period}</span>{upcoming && <small>{activity.date}</small>}</div>
    <div className="meeting-line" />
    <div>
      <div className="scheduled-activity-heading"><span className="event-type">{activity.typeLabel}</span><h3><a href={activity.openHref}>{activity.donorName}</a></h3></div>
      <strong className="scheduled-subject">{activity.subject}</strong>
      <p>{activity.note}</p>
      <div className="meeting-links">
        {live && activity.prepareHref ? <a href={activity.prepareHref}>Prepare</a> : <a href={activity.openHref}>Open donor</a>}
        {live && activity.logOutcomeHref && <a href={activity.logOutcomeHref}>Log Outcome</a>}
      </div>
      {live && <ActivityActions activityId={activity.id} editHref={activity.editHref} scheduled canCancel={activity.canCancel} />}
    </div>
  </article>;
}

function DonorStrip({ title, description, donors }: { title: string; description: string; donors: WorkspaceDonorLink[] }) {
  return <section className="today-relationship-strip"><div className="section-title"><div><h2>{title}</h2><p>{description}</p></div><span className="count">{donors.length}</span></div>
    {donors.length ? <div className="relationship-link-list">{donors.map((donor) => <a href={donor.href} key={donor.donorId}><span className="mini-avatar">{donor.initials}</span><span><strong>{donor.name}</strong><small>{donor.detail}</small></span><span aria-hidden="true">→</span></a>)}</div> : <p className="empty-copy">Nothing to show yet. Open or update a donor relationship and it will appear here.</p>}
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
  const queueCount = Object.values(data.relationshipQueue).reduce((sum, items) => sum + items.length, 0);

  return <AppShell active="today">
    <header className="page-header today-header"><div><p className="eyebrow today-date"><LocalDate timezone={profile.timezone} /> · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Good morning, {profile.preferredFirstName}.</h1><p className="subhead">Your daily relationship workspace—start with what needs attention, then move through the queue.</p></div></header>

    <nav className="today-quick-actions" aria-label="Quick actions">
      <a href="/capture?returnTo=%2F"><span>＋</span><strong>Log Interaction</strong><small>Capture a call, email, or note</small></a>
      <a href="/capture?type=meeting&returnTo=%2F"><span>◷</span><strong>Schedule Meeting</strong><small>Choose a donor and future time</small></a>
      <a href="/donors"><span>⌕</span><strong>Find Donor</strong><small>Search your live relationships</small></a>
      <a href="/donors/new"><span>＋</span><strong>New Donor</strong><small>Add a relationship manually</small></a>
      <a href={nextMeeting ? `/donors/${encodeURIComponent(nextMeeting.donorId)}/meeting-brief` : "/donors"}><span>☼</span><strong>Prepare for Meeting</strong><small>{nextMeeting ? "Open your next donor brief" : "Choose a donor to prepare"}</small></a>
    </nav>

    <section className="today-morning-brief" aria-labelledby="morning-brief-title">
      <div className="section-title"><div><p className="eyebrow">MORNING BRIEF</p><h2 id="morning-brief-title">What deserves attention today</h2><p>Live counts from your meetings, follow-ups, giving, and reminders</p></div><a className="view-all-link" href="/assistant">Open Assistant</a></div>
      <div className="morning-brief-grid">
        <article><strong>{data.morningBrief.meetingsToday}</strong><span>Meetings today</span></article>
        <article><strong>{data.morningBrief.overdueFollowUps}</strong><span>Overdue follow-ups</span></article>
        <article><strong>{data.morningBrief.recentGifts}</strong><span>Recent gifts</span></article>
        <article><strong>{data.morningBrief.upcomingReminders}</strong><span>Upcoming reminders</span></article>
        <article className="morning-suggested-priority"><span>Suggested priority</span>{data.morningBrief.suggestedPriority ? <><strong>{data.morningBrief.suggestedPriority.name}</strong><p>{data.morningBrief.suggestedPriority.reason}</p><a href={`/donors/${encodeURIComponent(data.morningBrief.suggestedPriority.donorId)}`}>Open relationship →</a></> : <p>No time-sensitive priority is available.</p>}</article>
      </div>
    </section>

    <section className="relationship-queue" id="relationship-queue">
      <div className="section-title"><div><p className="eyebrow">RELATIONSHIP QUEUE</p><h2>{showAll ? "All current relationship work" : "Your next relationship actions"}</h2><p>One clear reason per donor, ordered by urgency. Completing a reminder or closing an activity removes it automatically.</p></div><span className="count">{queueCount}</span></div>
      {queueCount ? <div className="relationship-queue-groups">{QUEUE_GROUPS.map((group) => data.relationshipQueue[group.key].length ? <section key={group.key} className={`relationship-queue-group ${group.key}`}><header><div><h3>{group.title}</h3><p>{group.description}</p></div><span>{data.relationshipQueue[group.key].length}</span></header><div className="priority-list">{data.relationshipQueue[group.key].map((item) => <QueueCard key={item.queueId} priority={item} />)}</div></section> : null)}</div> : <section className="directory-empty"><h2>Your relationship queue is clear</h2><p>There are no open reminders, scheduled activities, unacknowledged gifts, commitments, or contact gaps requiring attention.</p><a href="/capture?returnTo=%2F">Log an interaction</a></section>}
      {data.priorityCount > queueCount ? <a className="view-all-link queue-view-all" href="/?priorities=all#relationship-queue">View all {data.priorityCount}</a> : showAll ? <a className="view-all-link queue-view-all" href="/#relationship-queue">Show top actions</a> : null}
    </section>

    <section className="today-upcoming today-schedule">
      <div className="section-title"><div><h2>Today's Schedule</h2><p>Calls, emails, meetings, visits, notes, and personal interactions scheduled for today</p></div><span className="count">{data.todaySchedule.length}</span></div>
      {data.todaySchedule.length ? <div className="today-meeting-list">{data.todaySchedule.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} key={item.id} />)}</div> : <p className="empty-copy">No relationship activities are scheduled for today.</p>}
    </section>

    <section className="today-upcoming">
      <div className="section-title"><div><h2>Upcoming scheduled activities</h2><p>Future calls, emails, meetings, visits, notes, and personal interactions</p></div><span className="count">{data.upcomingActivities.length}</span></div>
      {data.upcomingActivities.length ? <div className="today-meeting-list">{data.upcomingActivities.map((item) => <ScheduledActivityCard activity={item} live={mode === "live"} upcoming key={item.id} />)}</div> : <p className="empty-copy">No future relationship activities are scheduled.</p>}
    </section>

    <BriefExperience surface="today" data={data} />

    <div className="today-relationship-strips">
      <DonorStrip title="Recently viewed donors" description="Return to relationships you opened most recently" donors={data.recentlyViewed} />
      <DonorStrip title="Recently updated relationships" description="Donors with recent contact, giving, reminder, or profile changes" donors={data.recentlyUpdated} />
    </div>

    <section className="today-recent-activity">
      <div className="section-title"><div><h2>Recent giving activity</h2><p>Paid gifts recorded in the last 30 days</p></div><span className="count">{data.gifts.length}</span></div>
      {data.gifts.length ? <div className="today-gift-list">{data.gifts.map((gift) => <a className="gift-row" key={gift.id} href={`/donors/${encodeURIComponent(gift.donorId)}`}><div className="mini-avatar">{gift.initials}</div><div><h3>{gift.name}</h3><p>{gift.detail}</p></div><strong>{gift.amount}</strong></a>)}</div> : <p className="empty-copy">No gifts were recorded in the last 30 days.</p>}
    </section>
  </AppShell>;
}
