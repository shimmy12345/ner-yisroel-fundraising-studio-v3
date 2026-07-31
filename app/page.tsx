import { AppShell } from "./components/AppShell";
import { LocalDate } from "./components/LocalDate";
import { todayData } from "./data";

function PriorityCard({
  priority,
  index,
}: {
  priority: (typeof todayData.priorities)[number];
  index: number;
}) {
  return (
    <article className="priority-card">
      <div className="priority-rank">{index + 1}</div>
      <div className="avatar" style={{ background: priority.color }}>
        {priority.initials}
      </div>
      <div className="priority-main">
        <div className="priority-heading">
          <h3>{priority.name}</h3>
          <span className={`signal ${priority.signal}`}>{priority.label}</span>
        </div>
        <p>{priority.reason}</p>
        <div className="why">
          <span className="spark">✦</span>
          <span>{priority.why}</span>
        </div>
      </div>
      <a className="action-button" href={priority.href}>
        {priority.action}
        <span aria-hidden="true">→</span>
      </a>
    </article>
  );
}

export default function TodayPage() {
  return (
    <AppShell active="today">
      <header className="page-header">
        <div>
          <p className="eyebrow today-date"><LocalDate /></p>
          <h1>Good morning, Sarah.</h1>
          <p className="subhead">Here’s where your attention will matter most today.</p>
        </div>
        <button className="brief-button">
          <span className="brief-icon">☼</span>
          Listen to morning brief
          <span className="duration">2 min</span>
        </button>
      </header>

      <section className="morning-brief" aria-labelledby="brief-title">
        <div className="ai-orb">✦</div>
        <div>
          <p className="eyebrow" id="brief-title">YOUR MORNING BRIEF</p>
          <p>
            You have a strong opening with the Chen family today. Their recent
            engagement and upcoming anniversary make this a natural moment to
            reconnect. Two thank-yous are also approaching the 48-hour mark.
          </p>
        </div>
        <button className="text-button">View full brief <span>→</span></button>
      </section>

      <div className="dashboard-grid">
        <main>
          <div className="section-title">
            <div>
              <h2>Top priorities</h2>
              <p>Ranked by relationship momentum and timing</p>
            </div>
            <span className="updated"><i /> Updated 8:12 AM</span>
          </div>
          <div className="priority-list">
            {todayData.priorities.map((priority, index) => (
              <PriorityCard key={priority.name} priority={priority} index={index} />
            ))}
          </div>
          <button className="show-more">Show 3 more priorities <span>↓</span></button>
        </main>

        <aside className="right-rail">
          <section className="rail-card">
            <div className="rail-heading">
              <div><span className="rail-icon">□</span><h2>Today’s meetings</h2></div>
              <span className="count">3</span>
            </div>
            {todayData.meetings.map((meeting) => (
              <article className="meeting" key={meeting.time}>
                <div className="meeting-time"><strong>{meeting.time}</strong><span>{meeting.period}</span></div>
                <div className="meeting-line" />
                <div>
                  <h3>{meeting.title}</h3>
                  <p>{meeting.detail}</p>
                  {meeting.prep && <a href="/donors/elena-chen">Prepare with AI →</a>}
                </div>
              </article>
            ))}
          </section>

          <section className="rail-card">
            <div className="rail-heading">
              <div><span className="rail-icon gift-icon">◇</span><h2>New gifts</h2></div>
              <span className="count">2</span>
            </div>
            {todayData.gifts.map((gift) => (
              <article className="gift-row" key={gift.name}>
                <div className="mini-avatar" style={{ background: gift.color }}>{gift.initials}</div>
                <div><h3>{gift.name}</h3><p>{gift.detail}</p></div>
                <strong>{gift.amount}</strong>
              </article>
            ))}
            <button className="full-button">Review thank-you queue</button>
          </section>

          <section className="rail-card compact-card">
            <div className="rail-heading">
              <div><span className="rail-icon">↗</span><h2>Quick actions</h2></div>
            </div>
            <div className="quick-grid">
              <a href="/capture"><span>＋</span>Log interaction</a>
              <a href="/assistant"><span>✦</span>Ask Assistant</a>
              <button><span>⌕</span>Find donor</button>
              <button><span>✎</span>Draft a note</button>
            </div>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}
