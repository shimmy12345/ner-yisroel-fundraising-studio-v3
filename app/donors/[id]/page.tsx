import type { Metadata } from "next";
import { AppShell } from "../../components/AppShell";
import { donor } from "../../data";
import { getRelationshipUpdates } from "../../../lib/relationships/read";
import { interactionKindLabel } from "../../../lib/capture/interaction";
import { env } from "cloudflare:workers";
import { calculateGivingSnapshot, type GivingActivity } from "../../../lib/import/jl-donations";

export const metadata: Metadata = { title: donor.name };
export const dynamic = "force-dynamic";

type ImportedDonor = { id: string; display_name: string; email: string | null; phone: string | null; home_phone: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null; primary_first_name: string | null; spouse_first_name: string | null; primary_title: string | null; spouse_title: string | null; external_id: string | null };
type GivingActivityRow = { source_fingerprint: string; external_household_id: string; activity_date: number | null; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; item_type: string | null; description: string | null; source_campaign: string | null; category: GivingActivity["category"]; source_snapshot: string };

function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }

function ImportedRelationship({ household, activities }: { household: ImportedDonor; activities: GivingActivity[] }) {
  const people = [household.primary_first_name && `${household.primary_title ? `${household.primary_title} ` : ""}${household.primary_first_name}`, household.spouse_first_name && `${household.spouse_title ? `${household.spouse_title} ` : ""}${household.spouse_first_name}`].filter(Boolean).join(" & ");
  const address = [household.address_line_1, [household.city, household.state, household.postal_code].filter(Boolean).join(" "), household.country].filter(Boolean);
  const giving = calculateGivingSnapshot(activities);
  const hasGiving = activities.some((activity) => !["nonfinancial_entry", "needs_review"].includes(activity.category));
  return <AppShell active="donors"><div className="donor-breadcrumb"><a href="/">Today</a><span>/</span><strong>Household relationship</strong></div>
    <header className="donor-header"><div className="donor-identity"><div className="avatar donor-avatar">{household.display_name.slice(0, 2).toUpperCase()}</div><div><div className="identity-line"><h1>{household.display_name}</h1></div>{people && <p>{people}</p>}<div className="contact-row">{household.email && <a href={`mailto:${household.email}`}>✉ {household.email}</a>}{household.phone && <a href={`tel:${household.phone.replace(/\D/g, "")}`}>☎ {household.phone}</a>}</div></div></div><div className="header-actions"><a href="/capture">＋ Log interaction</a></div></header>
    {hasGiving && <section className="giving-snapshot-section"><div className="card-heading"><div><p className="eyebrow">GIVING SNAPSHOT</p><h2>Paid giving and open commitments</h2></div><span className="updated">{giving.yearsOfGiving} giving year{giving.yearsOfGiving === 1 ? "" : "s"} · {giving.trend} trend</span></div><div className="giving-snapshot-grid"><article><span>Lifetime paid</span><strong>{money(giving.lifetimePaidCents)}</strong></article><article><span>Last 12 months</span><strong>{money(giving.last12MonthsCents)}</strong></article><article><span>Most recent gift</span><strong>{giving.mostRecent ? money(giving.mostRecent.paidCents ?? 0) : "—"}</strong><small>{giving.mostRecent?.activityDate ? new Date(giving.mostRecent.activityDate * 1000).toLocaleDateString() : "No paid gifts"}</small></article><article><span>Largest gift</span><strong>{giving.largest ? money(giving.largest.paidCents ?? 0) : "—"}</strong></article><article><span>Open commitments</span><strong>{money(giving.outstandingCents)}</strong></article></div></section>}
    <div className="relationship-grid"><main className="relationship-main">{hasGiving && <section className="story-card giving-history"><div className="card-heading"><div><p className="eyebrow">GIVING HISTORY</p><h2>A concise history of paid and committed support</h2></div><span className="updated">Typical paid gift {money(giving.typicalPaidCents)}</span></div><div>{[...activities].filter((activity) => !["nonfinancial_entry", "needs_review"].includes(activity.category)).sort((a, b) => (b.activityDate ?? 0) - (a.activityDate ?? 0)).slice(0, 30).map((activity) => <article key={activity.fingerprint}><time>{activity.activityDate ? new Date(activity.activityDate * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Date unavailable"}</time><div><strong>{activity.description || activity.itemType || "Giving activity"}</strong><small>{(activity.paidCents ?? 0) > 0 ? `${money(activity.paidCents ?? 0)} paid` : `${money(activity.committedCents ?? 0)} committed`}{(activity.balanceCents ?? 0) > 0 ? ` · ${money(activity.balanceCents ?? 0)} open` : ""}</small></div></article>)}</div></section>}<section className="story-card ai-summary-card"><div className="card-heading"><div><p className="eyebrow">RELATIONSHIP BRIEF</p><h2>Start building this household relationship</h2></div></div><p className="summary">No relationship summary is available yet. Log an interaction to begin building useful context.</p><div className="next-action"><div className="next-action-icon">→</div><div><p className="eyebrow">NEXT ACTION</p><h3>No next action set</h3><p>Add a reminder when the next step becomes clear.</p></div></div></section><section className="story-card memory-card"><div className="card-heading"><div><p className="eyebrow">INSTITUTIONAL MEMORY</p><h2>No institutional memory recorded yet</h2></div></div></section><section className="story-card timeline"><div className="card-heading"><div><p className="eyebrow">RELATIONSHIP HISTORY</p><h2>No interactions recorded yet</h2></div></div></section></main>
      <aside className="relationship-rail"><section className="detail-card"><div className="detail-heading"><h2>Household</h2></div><dl className="at-a-glance"><div><dt>Household members</dt><dd>{people || "Not supplied"}</dd></div><div><dt>Giving history</dt><dd>{hasGiving ? `${money(giving.lifetimePaidCents)} lifetime paid` : "No giving history imported yet"}</dd></div>{household.external_id && <div><dt>JL reference</dt><dd>{household.external_id}</dd></div>}</dl></section><section className="detail-card"><div className="detail-heading"><h2>Contact</h2></div><div className="facts contact-facts">{household.email && <div className="fact"><label>Email</label><a href={`mailto:${household.email}`}>{household.email}</a></div>}{household.phone && <div className="fact"><label>Main mobile</label><a href={`tel:${household.phone.replace(/\D/g, "")}`}>{household.phone}</a></div>}{household.home_phone && <div className="fact"><label>Home phone</label><a href={`tel:${household.home_phone.replace(/\D/g, "")}`}>{household.home_phone}</a></div>}{address.length > 0 && <div className="fact"><label>Mailing address</label>{address.map((line) => <p key={line}>{line}</p>)}</div>}</div></section></aside></div>
  </AppShell>;
}

export default async function DonorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id !== "elena-chen") {
    const household = await env.DB.prepare("SELECT id, display_name, email, phone, home_phone, address_line_1, city, state, postal_code, country, primary_first_name, spouse_first_name, primary_title, spouse_title, external_id FROM donors WHERE id = ? LIMIT 1").bind(id).first<ImportedDonor>();
    if (household) {
      const activityRows = await env.DB.prepare("SELECT source_fingerprint, external_household_id, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, source_campaign, category, source_snapshot FROM giving_activities WHERE donor_id = ? ORDER BY activity_date DESC LIMIT 500").bind(id).all<GivingActivityRow>();
      const activities: GivingActivity[] = activityRows.results.map((row) => ({ rowNumber: 0, fingerprint: row.source_fingerprint, externalHouseholdId: row.external_household_id, sourceName: "", activityDate: row.activity_date, committedCents: row.committed_cents, paidCents: row.paid_cents, balanceCents: row.balance_cents, itemType: row.item_type ?? "", description: row.description ?? "", sourceCampaign: row.source_campaign ?? "", category: row.category, suspiciousDate: false, reviewReason: null, sourceValues: {} }));
      return <ImportedRelationship household={household} activities={activities} />;
    }
  }
  const updates = await getRelationshipUpdates("elena-chen");
  const summary = updates.summary ?? donor.summary;
  const nextAction = updates.nextAction ?? donor.nextAction;
  const memory = updates.memory
    ? [{ icon: "✦", label: "Latest captured context", body: updates.memory, source: "From the most recent logged interaction" }, ...donor.memory]
    : donor.memory;
  const timeline = updates.interaction
    ? [{
        date: updates.interaction.occurredAt.toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toUpperCase(),
        year: updates.interaction.occurredAt.getFullYear().toString(),
        icon: updates.interaction.kind === "call" ? "☎" : updates.interaction.kind === "email" ? "✉" : updates.interaction.kind === "personal" ? "♡" : "○",
        type: updates.interaction.kind,
        label: interactionKindLabel(updates.interaction.kind).toUpperCase(),
        title: updates.interaction.subject,
        body: updates.interaction.note,
        insight: "Captured once and applied to the relationship automatically.",
      }, ...donor.timeline]
    : donor.timeline;
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
          <a href="/capture">＋ Log interaction</a>
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
              <span className="updated"><i /> {updates.interaction ? "Updated from latest interaction" : "Updated today, 8:12 AM"}</span>
            </div>
            <p className="summary">{summary}</p>
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
                <p>{nextAction}</p>
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
              {memory.map((memory) => (
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
              {timeline.map((item) => (
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
            <a href="/capture"><span>＋</span><div><strong>Log interaction</strong><small>Capture a note in under 20 seconds</small></div><b>→</b></a>
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
