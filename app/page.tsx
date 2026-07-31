import { AppShell } from "./components/AppShell";
import { BriefExperience } from "./components/BriefExperience";
import { LocalDate } from "./components/LocalDate";
import { WelcomeExperience } from "./onboarding/WelcomeExperience";
import { requireChatGPTUser } from "./chatgpt-auth";
import { ensureUserProfile } from "../lib/auth/profile";
import { loadWorkspaceBrief, type WorkspacePriority } from "../lib/workspace/live-data";
import { shouldShowOnboarding } from "../lib/onboarding/status";
import { getDataMode } from "../lib/workspace/mode";

export const dynamic = "force-dynamic";

function PriorityCard({ priority, index }: { priority: WorkspacePriority; index: number }) {
  return <article className="priority-card"><div className="priority-rank">{index + 1}</div><div className="avatar">{priority.initials}</div><div className="priority-main"><div className="priority-heading"><h3>{priority.name}</h3><span className={`signal ${priority.signal}`}>{priority.label}</span></div><p>{priority.reason}</p><div className="why"><span className="spark">✦</span><span>{priority.why}</span></div></div><a className="action-button" href={priority.href}>{priority.action}<span aria-hidden="true">→</span></a></article>;
}

export default async function TodayPage() {
  if (await shouldShowOnboarding()) return <WelcomeExperience />;
  const identity = await requireChatGPTUser("/");
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const data = await loadWorkspaceBrief(profile.id, profile.timezone, mode);
  return <AppShell active="today">
    <header className="page-header"><div><p className="eyebrow today-date"><LocalDate timezone={profile.timezone} /> · {mode === "demo" ? "DEMO MODE" : "LIVE WORKSPACE"}</p><h1>Good morning, {profile.preferredFirstName}.</h1><p className="subhead">Here’s where your attention will matter most today.</p></div></header>
    <BriefExperience surface="today" data={data} />
    <div className="dashboard-grid"><main><div className="section-title"><div><h2>Top priorities</h2><p>Derived from live reminders, gifts, pledges, and relationship activity</p></div></div>{data.priorities.length ? <div className="priority-list">{data.priorities.map((item, index) => <PriorityCard key={item.donorId} priority={item} index={index} />)}</div> : <section className="directory-empty"><h2>No priorities yet</h2><p>Your workspace has no due reminders, open pledges, recent gifts, or lapsed relationships requiring attention.</p><a href="/capture">Log an interaction</a></section>}</main>
      <aside className="right-rail"><section className="rail-card"><div className="rail-heading"><div><span className="rail-icon">□</span><h2>Upcoming meetings</h2></div><span className="count">{data.meetings.length}</span></div>{data.meetings.length ? data.meetings.map((item) => <article className="meeting" key={`${item.donorId}-${item.time}`}><div className="meeting-time"><strong>{item.time}</strong><span>{item.period}</span></div><div><h3>{item.title}</h3><p>{item.detail}</p><a href={`/donors/${encodeURIComponent(item.donorId)}`}>Open relationship →</a></div></article>) : <p className="empty-copy">No upcoming meetings are recorded.</p>}</section>
      <section className="rail-card"><div className="rail-heading"><div><span className="rail-icon gift-icon">◇</span><h2>Recent gifts</h2></div><span className="count">{data.gifts.length}</span></div>{data.gifts.length ? data.gifts.map((gift) => <a className="gift-row" key={gift.id} href={`/donors/${encodeURIComponent(gift.donorId)}`}><div className="mini-avatar">{gift.initials}</div><div><h3>{gift.name}</h3><p>{gift.detail}</p></div><strong>{gift.amount}</strong></a>) : <p className="empty-copy">No gifts were recorded in the last 30 days.</p>}</section>
      <section className="rail-card compact-card"><div className="rail-heading"><div><span className="rail-icon">↗</span><h2>Quick actions</h2></div></div><div className="quick-grid"><a href="/capture"><span>＋</span>Log interaction</a><a href="/assistant"><span>✦</span>Ask Assistant</a><a href="/donors"><span>⌕</span>Find donor</a><a href="/onboarding/import"><span>⇧</span>Import data</a></div></section></aside></div>
  </AppShell>;
}
