import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { loadMeetingBrief } from "../../../../lib/relationships/meeting-brief";
import { donorNavigationHref, safeDonorOrigin, safeInternalReturnPath } from "../../../../lib/navigation/donor-navigation";
import { financialDateLabel } from "../../../../lib/financial-date";
import { donorInitials, numericDonorCode } from "../../../../lib/relationships/donor-identity";

export const metadata: Metadata = { title: "Meeting brief" };
export const dynamic = "force-dynamic";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const date = (epoch: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));

function GiftSummary({ gift, empty }: { gift: { paidCents: number; occurredAt: number | null; description: string | null } | null; empty: string }) {
  if (!gift) return <span>{empty}</span>;
  return <><strong>{money(gift.paidCents)}</strong><span>{gift.occurredAt ? financialDateLabel(gift.occurredAt) : "Date not recorded"}{gift.description ? ` · ${gift.description}` : ""}</span></>;
}

export default async function MeetingBriefPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; origin?: string }> }) {
  const { id } = await params;
  const requestedNavigation = await searchParams;
  const priorReturnTo = safeInternalReturnPath(requestedNavigation.from, "/donors");
  const priorOrigin = safeDonorOrigin(requestedNavigation.origin, priorReturnTo);
  const meetingBriefPath = `/donors/${encodeURIComponent(id)}/meeting-brief?${new URLSearchParams({ from: priorReturnTo, origin: priorOrigin }).toString()}`;
  const donorHref = donorNavigationHref(id, meetingBriefPath, "meeting-brief");
  const identity = await requireChatGPTUser(meetingBriefPath);
  const profile = await ensureUserProfile(identity);
  const brief = await loadMeetingBrief(profile.id, id);
  if (!brief) notFound();
  const members = [brief.donor.primaryName, brief.donor.spouseName].filter(Boolean);
  const donorCode = numericDonorCode({ donorCode: brief.donor.donorCode, externalId: brief.donor.externalId });
  const initials = donorInitials({ displayName: brief.donor.displayName, primaryFirstName: brief.donor.primaryFirstName, lastName: brief.donor.lastName });

  return <AppShell active="donors"><main className="meeting-brief-page">
    <div className="donor-breadcrumb"><a href="/">Workspace</a><span>/</span><a href="/donors">Donors</a><span>/</span><a href={donorHref}>{brief.donor.displayName}</a><span>/</span><strong>Meeting brief</strong></div>
    <header className="meeting-brief-header">
      <div><p className="eyebrow">MEETING BRIEF · LIVE DATA</p><h1>Prepare for {brief.donor.displayName}</h1>{donorCode && <span className="donor-code meeting-header-code">{donorCode}</span>}<p>Built only from this household’s authenticated relationship record. Missing information is shown explicitly.</p></div>
      <a className="meeting-outcome-button" href={`/capture?donorId=${encodeURIComponent(id)}&type=meeting`}>Log Meeting Outcome</a>
    </header>

    <section className="meeting-identity-card">
      <div className="meeting-donor-identity"><span className="avatar">{initials}</span><div><p className="eyebrow">DONOR &amp; HOUSEHOLD</p><h2>{brief.donor.displayName}</h2>{donorCode && <span className="donor-code">{donorCode}</span>}<p>{members.length ? members.join(" & ") : "Household member names are not recorded."}</p></div></div>
      <div><p className="eyebrow">CONTACT</p>{brief.donor.email ? <a href={`mailto:${brief.donor.email}`}>{brief.donor.email}</a> : <p>No email recorded.</p>}{brief.donor.phone ? <a href={`tel:${brief.donor.phone.replace(/\D/g, "")}`}>{brief.donor.phone}</a> : brief.donor.homePhone ? <a href={`tel:${brief.donor.homePhone.replace(/\D/g, "")}`}>{brief.donor.homePhone}</a> : <p>No phone recorded.</p>}{brief.donor.address.length ? <address>{brief.donor.address.map((line) => <span key={line}>{line}</span>)}</address> : <p>No address recorded.</p>}</div>
    </section>

    <section className="meeting-giving-grid" aria-label="Giving snapshot">
      <article><p>Lifetime paid</p><strong>{money(brief.lifetimePaidCents)}</strong><span>{brief.lifetimePaidCents ? "From recorded paid giving" : "No paid giving recorded"}</span></article>
      <article><p>Recent gift</p><GiftSummary gift={brief.recentGift} empty="No paid gift recorded" /></article>
      <article><p>Largest gift</p><GiftSummary gift={brief.largestGift} empty="No paid gift recorded" /></article>
      <article><p>Open pledge balance</p><strong>{money(brief.openPledgeCents)}</strong><span>{brief.openPledgeCents ? "Recorded outstanding balance" : "No open pledge balance"}</span></article>
    </section>

    <div className="meeting-brief-grid">
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">RECENT INTERACTIONS</p><h2>Relationship context</h2></div>{brief.recentInteractions.length ? <div className="meeting-record-list">{brief.recentInteractions.map((item) => <article key={item.id}><time>{date(item.occurredAt, profile.timezone)}</time><div><strong>{item.summary.split("\n")[0]}</strong><p>{item.summary.split("\n").slice(1).join("\n") || "No additional notes recorded."}</p><span>{item.type}</span></div></article>)}</div> : <p className="meeting-empty">No prior interactions are recorded for this household.</p>}</section>
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">OPEN REMINDERS &amp; COMMITMENTS</p><h2>Unfinished work</h2></div>{brief.openReminders.length ? <div className="meeting-record-list">{brief.openReminders.map((item) => <article key={item.id}><time>{item.dueAt ? date(item.dueAt, profile.timezone) : "No due date"}</time><div><strong>{item.action}</strong><p>{item.reason}</p></div></article>)}</div> : <p className="meeting-empty">No open reminders or commitments are recorded.</p>}</section>
      <section className="meeting-brief-card meeting-last-contact"><div className="meeting-card-heading"><p className="eyebrow">LAST MEANINGFUL CONTACT</p><h2>{brief.lastMeaningfulContact ? date(brief.lastMeaningfulContact.occurredAt, profile.timezone) : "None recorded"}</h2></div><p>{brief.lastMeaningfulContact ? brief.lastMeaningfulContact.summary.split("\n")[0] : "There is no completed interaction to summarize."}</p></section>
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">3 DISCUSSION TOPICS</p><h2>Data-backed conversation</h2></div><ol className="meeting-suggestions">{brief.discussionTopics.map((topic) => <li key={topic.title}><strong>{topic.title}</strong><p>{topic.detail}</p></li>)}</ol></section>
      <section className="meeting-brief-card meeting-follow-up"><div className="meeting-card-heading"><p className="eyebrow">SUGGESTED FOLLOW-UP</p><h2>After the meeting</h2></div><ol className="meeting-suggestions">{brief.followUpActions.map((action) => <li key={action.title}><strong>{action.title}</strong><p>{action.detail}</p></li>)}</ol><a href={`/capture?donorId=${encodeURIComponent(id)}&type=meeting`}>Log Meeting Outcome</a></section>
    </div>
  </main></AppShell>;
}
