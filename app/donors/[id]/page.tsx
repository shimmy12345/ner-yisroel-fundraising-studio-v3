import type { Metadata } from "next";
import { AppShell } from "../../components/AppShell";
import { donor } from "../../data";

export const metadata: Metadata = { title: donor.name };

export default function DonorPage() {
  return (
    <AppShell active="donors">
      <div className="donor-breadcrumb">
        <a href="/">Today</a><span>/</span><a href="#donors">Donors</a><span>/</span>
        <strong>{donor.code}</strong>
      </div>

      <header className="donor-header">
        <div className="donor-identity">
          <div className="avatar donor-avatar" style={{ background: "#d9e8df" }}>EC</div>
          <div>
            <div className="identity-line">
              <h1>{donor.name}</h1>
              <span className="relationship-badge"><i /> Strong relationship</span>
            </div>
            <p>{donor.location} <span>·</span> Partners since 2018 <span>·</span> Leadership Circle</p>
            <div className="contact-row">
              <a href={`mailto:${donor.email}`}>✉ {donor.email}</a>
              <a href={`tel:${donor.phone.replace(/\D/g, "")}`}>☎ {donor.phone}</a>
              <span>Preferred: personal email</span>
            </div>
          </div>
        </div>
        <div className="header-actions">
          <button>＋ Log interaction</button>
          <a href="/assistant">✦ Draft outreach</a>
          <a className="primary" href="/assistant">Prepare for meeting <span>→</span></a>
        </div>
      </header>

      <section className="donor-snapshot-grid" aria-label="Donor relationship snapshot">
        <article className="snapshot-card">
          <p>Lifetime giving</p>
          <strong>{donor.lifetimeGiving}</strong>
          <span>7 gifts · 8-year relationship</span>
        </article>
        <article className="snapshot-card">
          <p>Most recent gift</p>
          <strong>$25,000</strong>
          <span>Scholarship Fund · Mar 18</span>
        </article>
        <article className="snapshot-card">
          <p>Relationship health</p>
          <div className="snapshot-health"><strong>82</strong><span>↑ 6</span></div>
          <span>Strong · momentum rising</span>
        </article>
        <article className="snapshot-card next-meeting-card">
          <p>Next touchpoint</p>
          <strong>Today · 2:00 PM</strong>
          <span>The Garden Room · 45 min</span>
        </article>
      </section>

      <div className="relationship-grid">
        <main className="relationship-main">
          <section className="story-card ai-summary-card">
            <div className="card-heading">
              <div>
                <p className="eyebrow">✦ AI RELATIONSHIP BRIEF</p>
                <h2>Longstanding scholarship partners with growing readiness</h2>
              </div>
              <span className="updated"><i /> Updated today, 8:12 AM</span>
            </div>
            <p className="summary">{donor.summary}</p>
            <div className="brief-signals">
              <article><span className="signal-icon heart">♡</span><div><label>What matters</label><p>First-generation access and direct student impact.</p></div></article>
              <article><span className="signal-icon momentum">↗</span><div><label>Why now</label><p>Three recent engagement signals before today’s meeting.</p></div></article>
              <article><span className="signal-icon watch">○</span><div><label>Keep in mind</label><p>They prefer substance and stories over formal recognition.</p></div></article>
            </div>
            <div className="next-action">
              <div className="next-action-icon">→</div>
              <div>
                <p className="eyebrow">RECOMMENDED NEXT ACTION</p>
                <h3>Make today’s meeting about Maya’s progress</h3>
                <p>{donor.nextAction}</p>
                <div className="recommendation-why">
                  <span>Why this recommendation</span>
                  <p>Elena revisited Maya’s story in the latest update, and both Chens spent time with her at the June reception.</p>
                </div>
              </div>
              <a href="/assistant">Prepare with AI <span>→</span></a>
            </div>
          </section>

          <section className="story-card memory-card">
            <div className="card-heading">
              <div><p className="eyebrow">INSTITUTIONAL MEMORY</p><h2>The context your team should never lose</h2></div>
              <button className="quiet-button">＋ Add memory</button>
            </div>
            <div className="memory-grid">
              {donor.memory.map((memory) => (
                <article key={memory.label}>
                  <span className="memory-icon">{memory.icon}</span>
                  <div><label>{memory.label}</label><p>{memory.body}</p><small>{memory.source}</small></div>
                </article>
              ))}
            </div>
          </section>

          <section className="story-card timeline">
            <div className="card-heading timeline-heading">
              <div><p className="eyebrow">RELATIONSHIP HISTORY</p><h2>A relationship gaining momentum</h2></div>
              <button className="quiet-button">All activity ⌄</button>
            </div>
            <div className="timeline-list">
              {donor.timeline.map((item) => (
                <article className="timeline-item" key={item.date + item.title}>
                  <time><strong>{item.date}</strong><span>{item.year}</span></time>
                  <span className={`timeline-dot ${item.type}`} aria-hidden="true">{item.icon}</span>
                  <div className="timeline-content">
                    <div><h3>{item.title}</h3><span className="event-type">{item.label}</span></div>
                    <p>{item.body}</p>
                    {item.insight && <small>✦ {item.insight}</small>}
                  </div>
                </article>
              ))}
            </div>
            <button className="timeline-more">View full relationship history <span>↓</span></button>
          </section>
        </main>

        <aside className="relationship-rail">
          <section className="detail-card quick-actions-card">
            <p className="eyebrow">QUICK ACTIONS</p>
            <a className="rail-primary-action" href="/assistant"><span>✦</span><div><strong>Prepare for meeting</strong><small>Brief, talking points, questions</small></div><b>→</b></a>
            <button><span>＋</span><div><strong>Log interaction</strong><small>Capture a note in under 20 seconds</small></div><b>→</b></button>
            <a href={`mailto:${donor.email}`}><span>✉</span><div><strong>Send an email</strong><small>Draft with full relationship context</small></div><b>→</b></a>
            <a href="/assistant"><span>✎</span><div><strong>Draft thank-you</strong><small>Personalized to their impact</small></div><b>→</b></a>
          </section>

          <section className="detail-card">
            <div className="detail-heading"><h2>Relationship at a glance</h2><button aria-label="Edit relationship details">Edit</button></div>
            <dl className="at-a-glance">
              <div><dt>Primary relationship</dt><dd>Elena Chen</dd></div>
              <div><dt>Giving significance</dt><dd><span className="level-dot" /> Leadership</dd></div>
              <div><dt>Affinity</dt><dd>Scholarships · High</dd></div>
              <div><dt>Last personal contact</dt><dd>June 12 · 48 days ago</dd></div>
              <div><dt>Assigned to</dt><dd><span className="owner-avatar">SM</span> Sarah Mitchell</dd></div>
            </dl>
          </section>

          <section className="detail-card" id="giving">
            <div className="detail-heading"><h2>Giving</h2><a href="#giving">View history</a></div>
            <div className="giving-total">{donor.lifetimeGiving}</div>
            <p className="giving-caption">Lifetime giving across 7 gifts</p>
            <div className="giving-breakdown">
              <div><span>Scholarship Fund</span><strong>$100,000</strong></div>
              <div><span>Annual Fund</span><strong>$12,500</strong></div>
            </div>
            <div className="giving-pattern"><span>Pattern</span><p>Annual giving, usually in March · 3 consecutive years at $25K</p></div>
          </section>

          <section className="detail-card">
            <div className="detail-heading"><h2>Contact & preferences</h2><button aria-label="Edit contact details">Edit</button></div>
            <div className="facts contact-facts">
              <div className="fact"><label>Email</label><a href={`mailto:${donor.email}`}>{donor.email}</a></div>
              <div className="fact"><label>Phone</label><a href={`tel:${donor.phone.replace(/\D/g, "")}`}>{donor.phone}</a></div>
              <div className="fact"><label>Address</label><p>24 Brattle Street<br />Cambridge, MA 02138</p></div>
              <div className="fact"><label>Preference</label><p>Personal email · No calls before 10 AM</p></div>
            </div>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}
