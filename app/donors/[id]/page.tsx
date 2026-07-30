import type { Metadata } from "next";
import { AppShell } from "../../components/AppShell";
import { donor } from "../../data";

export const metadata: Metadata = { title: donor.name };

export default function DonorPage() {
  return (
    <AppShell active="donors">
      <header className="donor-header">
        <div className="donor-identity">
          <div className="avatar" style={{ background: "#d9e8df" }}>EC</div>
          <div><h1>{donor.name}</h1><p>{donor.location}</p></div>
        </div>
        <div className="header-actions">
          <button>Log interaction</button>
          <a className="primary" href="/assistant">Prepare for meeting</a>
        </div>
      </header>
      <div className="relationship-grid">
        <main>
          <section className="story-card">
            <p className="eyebrow">AI RELATIONSHIP SUMMARY</p>
            <p className="summary">{donor.summary}</p>
            <div className="health">
              <strong>Relationship health</strong>
              <div className="health-track"><i /></div>
              <span>Strong · 82</span>
            </div>
            <div className="next-action">
              <p className="eyebrow">✦ NEXT BEST ACTION</p>
              <p>{donor.nextAction}</p>
            </div>
          </section>
          <section className="story-card timeline">
            <h2>Relationship timeline</h2>
            {donor.timeline.map((item) => (
              <article className="timeline-item" key={item.date + item.title}>
                <time>{item.date}</time><span className="timeline-dot" />
                <div><h3>{item.title}</h3><p>{item.body}</p></div>
              </article>
            ))}
          </section>
        </main>
        <aside>
          <section className="detail-card">
            <h2>What matters to them</h2>
            <div className="facts">
              <div className="fact"><label>Interests</label><p>First-generation students, access to higher education, student research</p></div>
              <div className="fact"><label>Communication</label><p>Personal email; concise updates with one meaningful story</p></div>
              <div className="fact"><label>Family</label><p>Daughter, Lily, graduated in 2016. Anniversary: August 3.</p></div>
            </div>
          </section>
          <section className="detail-card">
            <h2>Giving history</h2>
            <div className="giving-total">$112,500</div>
            <p className="giving-caption">Lifetime giving · 7 gifts since 2018</p>
          </section>
          <section className="detail-card">
            <h2>Contact</h2>
            <div className="facts">
              <div className="fact"><label>Email</label><p>elena.chen@example.org</p></div>
              <div className="fact"><label>Phone</label><p>(617) 555-0148</p></div>
            </div>
          </section>
        </aside>
      </div>
    </AppShell>
  );
}
