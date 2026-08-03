import { AppShell } from "./components/AppShell";
import { BriefExperience } from "./components/BriefExperience";
import { CompletePriorityButton } from "./components/CompletePriorityButton";
import { LocalDate } from "./components/LocalDate";
import { WelcomeExperience } from "./onboarding/WelcomeExperience";
import { requireChatGPTUser } from "./chatgpt-auth";
import { ensureUserProfile } from "../lib/auth/profile";
import { loadWorkspaceBrief, type WorkspaceMeeting, type WorkspacePriority } from "../lib/workspace/live-data";
import { shouldShowOnboarding } from "../lib/onboarding/status";
import { getDataMode } from "../lib/workspace/mode";

export const dynamic = "force-dynamic";

function PriorityCard({ priority, index }: { priority: WorkspacePriority; index: number }) {
  return <article className="priority-card">
    <div className="priority-rank">{index + 1}</div>
    <div className="avatar">{priority.initials}</div>
    <div className="priority-main">
      <div className="priority-heading"><h3>{priority.name}</h3><span className={`signal ${priority.signal}`}>{priority.label}</span></div>
      <p>{priority.reason}</p>
      <div className="why"><span className="spark">✦</span><span>{priority.why}</span></div>
    </div>
    <div className="priority-actions">
      <a className="action-button" href={priority.href}>{priority.action}<span aria-hidden="true">→</span></a>
      {priority.recommendationId && <CompletePriorityButton recommendationId={priority.recommendationId} />}
    </div>
  </article>;
}

function MeetingCard({ meeting, live }: { meeting: WorkspaceMeeting; live: boolean }) {
  return <article className="meeting today-meeting-card">
    <div className="meeting-time"><strong>{meeting.time}</strong><span>{meeting.period}</span></div>
    <div className="meeting-line" />
    <div>
      <h3>{meeting.title}</h3>
      <p>{meeting.detail}</p>
      <div className="meeting-links">
        {live && <a href={`/donors/${encodeURIComponent(meeting.donorId)}/meeting-brief`}>Prepare for Meeting</a>}
        <a href={`/donors/${encodeURIComponent(meeting.donorId)}`}>Open relationship →</a>
      </div>
    </div>
  </article>;
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ priorities?: string }> }) {
  if (await shouldShowOnboarding()) return <WelcomeExperience />;
  const identity = await requireChatGPTUser("/");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const showAll = (await searchParams).priorities === "all";
  const data = await loadWorkspaceBrief(profile.id, profile.timezone, mode, Math.floor(Date.now() / 1000), showAll ? 50 : 8);
  const nextMeeting = mode === "live" ? data.meetings[0] : null;

  return <AppShell active="today">
    <header className="page-header today-header"><div><p className="eyebrow today-date"><LocalDate timezone={profile.timezone} /> · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Good morning, {profile.preferredFirstName}.</h1><p className="subhead">Here’s where your attention will matter most today.</p></div></header>

    <nav className="today-quick-actions" aria-label="Quick actions">
      <a href="/capture?returnTo=%2F"><span>＋</span><strong>Log Interaction</strong><small>Capture a call, email, or note</small></a>
      <a href="/capture?type=meeting&returnTo=%2F"><span>○</span><strong>Schedule Meeting</strong><small>Choose a donor and future time</small></a>
      <a href="/donors"><span>⌕</span><strong>Find Donor</strong><small>Search your live relationships</small></a>
      <a href={nextMeeting ? `/donors/${encodeURIComponent(nextMeeting.donorId)}/meeting-brief` : "/donors"}><span>☼</span><strong>Prepare for Meeting</strong><small>{nextMeeting ? "Open your next donor brief" : "Choose a donor to prepare"}</small></a>
    </nav>

    <section className="today-upcoming">
      <div className="section-title"><div><h2>Upcoming meetings</h2><p>Your next scheduled donor conversations</p></div><span className="count">{data.meetings.length}</span></div>
      {data.meetings.length ? <div className="today-meeting-list">{data.meetings.map((item) => <MeetingCard meeting={item} live={mode === "live"} key={`${item.donorId}-${item.time}`} />)}</div> : <p className="empty-copy">No upcoming meetings are recorded. Use Schedule Meeting to add one.</p>}
    </section>

    <BriefExperience surface="today" data={data} />

    <section className="today-priorities" id="priorities">
      <div className="section-title"><div><h2>{showAll ? "All current priorities" : "Top priorities"}</h2><p>Ranked by overdue reminders, today’s meetings, recent gifts, open commitments, and contact gaps</p></div>{data.priorityCount > data.priorities.length ? <a className="view-all-link" href="/?priorities=all#priorities">View all {data.priorityCount}</a> : showAll ? <a className="view-all-link" href="/#priorities">Show top priorities</a> : null}</div>
      {data.priorities.length ? <div className="priority-list">{data.priorities.map((item, index) => <PriorityCard key={item.donorId} priority={item} index={index} />)}</div> : <section className="directory-empty"><h2>No priorities yet</h2><p>Your workspace has no due reminders, meetings, gifts, open commitments, or contact gaps requiring attention.</p><a href="/capture?returnTo=%2F">Log an interaction</a></section>}
    </section>

    <section className="today-recent-activity">
      <div className="section-title"><div><h2>Recent giving activity</h2><p>Paid gifts recorded in the last 30 days</p></div><span className="count">{data.gifts.length}</span></div>
      {data.gifts.length ? <div className="today-gift-list">{data.gifts.map((gift) => <a className="gift-row" key={gift.id} href={`/donors/${encodeURIComponent(gift.donorId)}`}><div className="mini-avatar">{gift.initials}</div><div><h3>{gift.name}</h3><p>{gift.detail}</p></div><strong>{gift.amount}</strong></a>)}</div> : <p className="empty-copy">No gifts were recorded in the last 30 days.</p>}
    </section>
  </AppShell>;
}
