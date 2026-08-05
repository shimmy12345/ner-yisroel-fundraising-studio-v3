import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { AppShell } from "../../components/AppShell";
import { requireChatGPTUser } from "../../chatgpt-auth";
import { ensureUserProfile } from "../../../lib/auth/profile";
import { getDataMode } from "../../../lib/workspace/mode";
import { DONOR_GIVING_SQL } from "../../../lib/relationships/giving";
import { isCancelledActivity, isScheduledActivity, sanitizeScheduledRelationshipContext } from "../../../lib/workspace/scheduled-activity";
import { PendingGiftForm } from "./GivingManagement";
import { countsInGivingTotals } from "../../../lib/giving/management";
import type { DonorSearchRecord } from "../../../lib/relationships/donor-search";
import { UnifiedRelationshipTimeline } from "./UnifiedRelationshipTimeline";
import { DonorBackNavigation } from "../../components/DonorNavigation";
import { donorBackLabel, donorNavigationHref, meetingBriefNavigationHref, safeDonorOrigin, safeInternalReturnPath } from "../../../lib/navigation/donor-navigation";
import { financialDateLabel } from "../../../lib/financial-date";

export const metadata: Metadata = { title: "Donor relationship" };
export const dynamic = "force-dynamic";
type Donor = { id: string; display_name: string; donor_code: string | null; email: string | null; phone: string | null; home_phone: string | null; address_line_1: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null; primary_first_name: string | null; spouse: string | null; spouse_first_name: string | null; primary_title: string | null; spouse_title: string | null; external_id: string | null; external_source: string | null; contact_note: string | null; relationship_summary: string | null; institutional_memory: string | null; archived_at: number | null; merged_into_donor_id: string | null };
type Activity = { id: string; donor_id: string; external_source: string; activity_date: number | null; committed_cents: number | null; paid_cents: number | null; balance_cents: number | null; item_type: string | null; description: string | null; category: string; workspace_status: string; private_note: string | null; confirmed_by_activity_id: string | null; updated_at: number };
type PaymentEvent = { id: string; payment_date: number; applied_cents: number; remaining_balance_cents: number | null; pledge_activity_id: string; pledge_description: string | null };
type Gift = { id: string; received_at: number; amount_cents: number; fund: string };
type Interaction = { id: string; type: string; occurred_at: number; summary: string; source: string; created_at: number; status_changed_at: number | null };
type Recommendation = { id: string; action: string; reason: string; status: string; due_at: number | null; created_at: number; updated_at: number };
type ContactAudit = { id: string; action: string; changed_fields: string; created_at: number };
const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const date = (epoch: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
const dateTime = (epoch: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(epoch * 1000));

export default async function DonorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; origin?: string }> }) {
  const { id } = await params;
  const requestedNavigation = await searchParams;
  const returnTo = safeInternalReturnPath(requestedNavigation.from, "/donors");
  const origin = safeDonorOrigin(requestedNavigation.origin, returnTo);
  const currentHref = donorNavigationHref(id, returnTo, origin);
  const identity = await requireChatGPTUser(currentHref);
  const profile = await ensureUserProfile(identity);
  const mode = await getDataMode(profile.id);
  const donor = await env.DB.prepare(`SELECT id, display_name, donor_code, email, phone, home_phone, address_line_1, city, state, postal_code, country, primary_first_name, spouse, spouse_first_name, primary_title, spouse_title, external_id, external_source, contact_note, relationship_summary, institutional_memory, archived_at, merged_into_donor_id FROM donors WHERE id = ? AND ${mode === "demo" ? "data_source = 'sample'" : "owner_user_id = ? AND data_source = 'live'"} LIMIT 1`).bind(...(mode === "demo" ? [id] : [id, profile.id])).first<Donor>();
  if (!donor) notFound();
  if (mode === "live" && donor.archived_at && donor.merged_into_donor_id) redirect(donorNavigationHref(donor.merged_into_donor_id, returnTo, origin));
  if (mode === "live" && !donor.archived_at) {
    const viewedAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`INSERT INTO donor_views (user_id,donor_id,viewed_at) VALUES (?,?,?)
      ON CONFLICT(user_id,donor_id) DO UPDATE SET viewed_at=excluded.viewed_at`).bind(profile.id, donor.id, viewedAt).run();
  }
  const [activityResult, giftResult, interactionResult, recommendationResult, paymentEventResult, contactAuditResult, donorDirectoryResult] = await Promise.all([
    (mode === "demo" ? env.DB.prepare("SELECT id, donor_id, external_source, activity_date, committed_cents, paid_cents, balance_cents, item_type, description, category, workspace_status, private_note, confirmed_by_activity_id, updated_at FROM giving_activities WHERE donor_id = ? AND record_origin = 'sample' ORDER BY activity_date DESC LIMIT 500").bind(id) : env.DB.prepare(DONOR_GIVING_SQL).bind(id, profile.id)).all<Activity>(),
    env.DB.prepare("SELECT id, received_at, amount_cents, fund FROM gifts WHERE donor_id = ? ORDER BY received_at DESC LIMIT 500").bind(id).all<Gift>(),
    env.DB.prepare(`SELECT id, type, occurred_at, summary, source, created_at, ${mode === "demo" ? "NULL" : "(SELECT created_at FROM activity_status_audits WHERE interaction_id=interactions.id AND user_id=? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1)"} AS status_changed_at FROM interactions WHERE donor_id = ? ${mode === "demo" ? "" : "AND user_id = ?"} AND source NOT LIKE 'archived:%' ORDER BY occurred_at DESC LIMIT 500`).bind(...(mode === "demo" ? [id] : [profile.id, id, profile.id])).all<Interaction>(),
    env.DB.prepare(`SELECT id, action, reason, status, due_at, created_at, updated_at FROM recommendations WHERE donor_id = ? ${mode === "demo" ? "" : "AND user_id = ?"} AND status IN ('open','completed') ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, due_at, updated_at DESC LIMIT 200`).bind(...(mode === "demo" ? [id] : [id, profile.id])).all<Recommendation>(),
    mode === "demo"
      ? Promise.resolve({ results: [] as PaymentEvent[] })
      : env.DB.prepare(`SELECT audit.id, audit.payment_date, audit.applied_cents, audit.remaining_balance_cents,
          audit.pledge_activity_id, pledge.description AS pledge_description
        FROM jl_payment_assignment_audits audit
        INNER JOIN data_imports batch ON batch.id = audit.import_id AND batch.user_id = audit.user_id AND batch.status IN ('active','completed')
        INNER JOIN giving_activities pledge ON pledge.id = audit.pledge_activity_id AND pledge.owner_user_id = audit.user_id AND pledge.donor_id = audit.donor_id
        WHERE audit.user_id = ? AND audit.donor_id = ? AND audit.decision_type = 'apply_to_pledge'
          AND audit.applied_cents > 0 AND audit.payment_date IS NOT NULL
        ORDER BY audit.payment_date DESC, audit.created_at DESC`).bind(profile.id, id).all<PaymentEvent>(),
    mode === "demo" ? Promise.resolve({ results: [] as ContactAudit[] }) : env.DB.prepare("SELECT id,action,changed_fields,created_at FROM donor_contact_audits WHERE donor_id=? AND user_id=? ORDER BY created_at DESC LIMIT 5").bind(id, profile.id).all<ContactAudit>(),
    mode === "demo" ? Promise.resolve({ results: [] as DonorSearchRecord[] }) : env.DB.prepare(`SELECT id,display_name AS name,last_name AS lastName,COALESCE(spouse,spouse_first_name) AS spouse,COALESCE(external_id,donor_code) AS code,email,COALESCE(phone,alternate_mobile_phone,home_phone) AS phone FROM donors WHERE owner_user_id=? AND data_source='live' AND archived_at IS NULL ORDER BY COALESCE(NULLIF(last_name,''),display_name) COLLATE NOCASE,display_name COLLATE NOCASE LIMIT 1000`).bind(profile.id).all<DonorSearchRecord>(),
  ]);
  const activities = activityResult.results;
  const countedActivities = activities.filter(countsInGivingTotals);
  const paymentEvents = paymentEventResult.results;
  const legacyGifts = giftResult.results;
  const paid = countedActivities.reduce((sum, item) => sum + (item.paid_cents ?? 0), 0) + legacyGifts.reduce((sum, item) => sum + item.amount_cents, 0);
  const open = countedActivities.reduce((sum, item) => sum + Math.max(0, item.balance_cents ?? 0), 0);
  const pledgeIdsWithPaymentEvents = new Set(paymentEvents.map((event) => event.pledge_activity_id));
  const countedActivityIds = new Set(countedActivities.map((item) => item.id));
  const mostRecent = [
    ...paymentEvents.filter((event) => countedActivityIds.has(event.pledge_activity_id)).map((event) => ({ amount: event.applied_cents, occurredAt: event.payment_date })),
    ...countedActivities.filter((item) => !pledgeIdsWithPaymentEvents.has(item.id) && (item.paid_cents ?? 0) > 0 && item.activity_date).map((item) => ({ amount: item.paid_cents ?? 0, occurredAt: item.activity_date! })),
    ...legacyGifts.map((gift) => ({ amount: gift.amount_cents, occurredAt: gift.received_at })),
  ].sort((a, b) => b.occurredAt - a.occurredAt)[0];
  const people = [donor.primary_first_name && `${donor.primary_title ? `${donor.primary_title} ` : ""}${donor.primary_first_name}`, (donor.spouse || donor.spouse_first_name) && `${donor.spouse_title ? `${donor.spouse_title} ` : ""}${donor.spouse || donor.spouse_first_name}`].filter(Boolean).join(" & ");
  const address = [donor.address_line_1, [donor.city, donor.state, donor.postal_code].filter(Boolean).join(" "), donor.country].filter(Boolean);
  const next = recommendationResult.results.find((item) => item.status === "open");
  const completedInteractions = interactionResult.results.filter((item) => !isScheduledActivity(item.source, item.occurred_at, item.created_at) && !isCancelledActivity(item.source));
  const relationshipContext = sanitizeScheduledRelationshipContext(donor.relationship_summary, donor.institutional_memory, interactionResult.results.map((item) => ({ type: item.type, summary: item.summary, source: item.source, occurredAt: item.occurred_at, createdAt: item.created_at })));
  const donorDirectoryHref = returnTo === "/donors" || returnTo.startsWith("/donors?") ? returnTo : "/donors";
  return <AppShell active="donors"><div className="donor-breadcrumb"><a href="/">Workspace</a><span>/</span><a href={donorDirectoryHref}>Donors</a><span>/</span><strong>{donor.display_name}</strong></div>
    <DonorBackNavigation returnTo={returnTo} label={donorBackLabel(origin)} />
    <header className="donor-header"><div className="donor-identity"><div className="avatar donor-avatar">{donor.display_name.slice(0, 2).toUpperCase()}</div><div><div className="identity-line"><h1>{donor.display_name}</h1>{mode === "demo" ? <span className="relationship-badge">Demo record</span> : <span className="relationship-badge">{donor.external_source === "Manual" ? "Manual" : "JL Solutions"}</span>}</div>{people && <p>{people}</p>}<div className="contact-row">{donor.email && <a href={`mailto:${donor.email}`}>✉ {donor.email}</a>}{donor.phone && <a href={`tel:${donor.phone.replace(/\D/g, "")}`}>☎ {donor.phone}</a>}</div></div></div>{mode === "live" && <div className="header-actions"><a href={`/donors/${encodeURIComponent(id)}/edit`}>Edit Contact Details</a><a href={`/donors/${encodeURIComponent(id)}/resolve-duplicate`}>Resolve Duplicate</a><a href={`/capture?donorId=${encodeURIComponent(id)}`}>＋ Log interaction</a></div>}</header>
    {mode === "live" && <nav className="meeting-brief-entry" aria-label="Meeting preparation"><div><strong>Meeting coming up?</strong><span>Review a concise brief built only from this donor’s live record.</span></div><a href={meetingBriefNavigationHref(id, currentHref, origin)}>Prepare for Meeting</a></nav>}
    <section className="donor-snapshot-grid"><article className="snapshot-card"><p>Lifetime paid</p><strong>{money(paid)}</strong><span>{countedActivities.length + legacyGifts.length} confirmed giving record{countedActivities.length + legacyGifts.length === 1 ? "" : "s"}</span></article><article className="snapshot-card"><p>Most recent paid gift</p><strong>{mostRecent ? money(mostRecent.amount) : "—"}</strong><span>{mostRecent ? financialDateLabel(mostRecent.occurredAt) : "No paid gift recorded"}</span></article><article className="snapshot-card"><p>Open commitments</p><strong>{money(open)}</strong><span>From included giving history</span></article><article className="snapshot-card"><p>Next action</p><strong>{next?.action || "None set"}</strong><span>{next?.due_at ? `Due ${date(next.due_at, profile.timezone)}` : "No dated reminder"}</span></article></section>
    <div className="relationship-grid"><main className="relationship-main">
      <section className="story-card ai-summary-card"><div className="card-heading"><div><p className="eyebrow">RELATIONSHIP SUMMARY · RULE-BASED</p><h2>{relationshipContext.summary ? "Current relationship context" : "No relationship summary yet"}</h2></div></div><p className="summary">{relationshipContext.summary || "Log a completed interaction to begin building a relationship summary from this household’s actual activity."}</p><div className="next-action"><div className="next-action-icon">→</div><div><p className="eyebrow">NEXT ACTION</p><h3>{next?.action || "No next action set"}</h3><p>{next?.reason || "Add a reminder when the next step becomes clear."}</p></div></div></section>
      <section className="story-card memory-card"><div className="card-heading"><div><p className="eyebrow">INSTITUTIONAL MEMORY</p><h2>{relationshipContext.memory ? "Recorded relationship context" : "No institutional memory recorded"}</h2></div></div>{relationshipContext.memory && <p className="summary">{relationshipContext.memory}</p>}</section>
      <section className="story-card timeline unified-relationship-timeline"><div className="card-heading"><div><p className="eyebrow">UNIFIED RELATIONSHIP TIMELINE</p><h2>One chronological story</h2><p>Giving, conversations, reminders, and scheduled work—ordered by when each event happened or is due.</p></div>{mode === "live" && <PendingGiftForm donors={donorDirectoryResult.results} initialDonorId={id} />}</div><UnifiedRelationshipTimeline giving={activities} legacyGifts={legacyGifts} payments={paymentEvents} interactions={interactionResult.results} reminders={recommendationResult.results} donors={donorDirectoryResult.results} timezone={profile.timezone} live={mode === "live"} now={Math.floor(Date.now() / 1000)} /></section>
    </main><aside className="relationship-rail"><section className="detail-card"><div className="detail-heading"><h2>Household</h2></div><dl className="at-a-glance"><div><dt>Members</dt><dd>{people || "Not supplied"}</dd></div><div><dt>{donor.external_source === "Manual" ? "Source" : "JL reference"}</dt><dd>{donor.external_source === "Manual" ? "Manual" : donor.external_id || donor.donor_code || "Not supplied"}</dd></div><div><dt>Last meaningful contact</dt><dd>{completedInteractions[0] ? date(completedInteractions[0].occurred_at, profile.timezone) : "None recorded"}</dd></div></dl></section><section className="detail-card"><div className="detail-heading"><h2>Contact</h2></div><div className="facts contact-facts">{donor.email && <div className="fact"><label>Email</label><a href={`mailto:${donor.email}`}>{donor.email}</a></div>}{donor.phone && <div className="fact"><label>Mobile</label><a href={`tel:${donor.phone.replace(/\D/g, "")}`}>{donor.phone}</a></div>}{donor.home_phone && <div className="fact"><label>Home</label><a href={`tel:${donor.home_phone.replace(/\D/g, "")}`}>{donor.home_phone}</a></div>}{address.length > 0 && <div className="fact"><label>Mailing address</label>{address.map((line) => <p key={line}>{line}</p>)}</div>}{donor.contact_note && <div className="fact"><label>Contact note</label><p>{donor.contact_note}</p></div>}</div></section>{contactAuditResult.results.length > 0 && <section className="detail-card contact-audit"><div className="detail-heading"><h2>Contact history</h2></div>{contactAuditResult.results.map((audit) => { let fields: string[] = []; try { fields = JSON.parse(audit.changed_fields); } catch { fields = []; } return <div key={audit.id}><strong>{audit.action === "created" ? "Contact created" : audit.action === "merged_with_jl" ? "Linked to JL record" : "Contact updated"}</strong><span>{dateTime(audit.created_at, profile.timezone)}</span>{fields.length > 0 && <small>{fields.join(", ")}</small>}</div>; })}</section>}</aside></div>
  </AppShell>;
}
