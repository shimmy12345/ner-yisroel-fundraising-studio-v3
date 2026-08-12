import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { requireChatGPTUser } from "../../../chatgpt-auth";
import { ensureUserProfile } from "../../../../lib/auth/profile";
import { loadMeetingBrief } from "../../../../lib/relationships/meeting-brief";
import { donorNavigationHref, safeDonorOrigin, safeInternalReturnPath } from "../../../../lib/navigation/donor-navigation";
import { financialDateLabel } from "../../../../lib/financial-date";
import { donorInitials, numericDonorCode } from "../../../../lib/relationships/donor-identity";
import { splitInteractionSummary } from "../../../../lib/capture/interaction";

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
  const latestInteraction = brief.lastMeaningfulContact ? splitInteractionSummary(brief.lastMeaningfulContact.summary) : null;

  return <AppShell active="donors"><main className="meeting-brief-page">
    <div className="donor-breadcrumb"><a href="/">Workspace</a><span>/</span><a href="/donors">Donors</a><span>/</span><a href={donorHref}>{brief.donor.displayName}</a><span>/</span><strong>Meeting brief</strong></div>
    <header className="meeting-brief-header">
      <div><p className="eyebrow">MEETING PREP</p><h1>Prepare for {brief.donor.displayName}</h1>{donorCode && <span className="donor-code meeting-header-code">{donorCode}</span>}<p>A one-minute briefing from this donor&apos;s recorded relationship history.</p></div>
      <a className="meeting-outcome-button" href={`/capture?donorId=${encodeURIComponent(id)}&type=meeting`}>Log Meeting Outcome</a>
    </header>

    <section className="meeting-identity-card">
      <div className="meeting-donor-identity"><span className="avatar">{initials}</span><div><p className="eyebrow">DONOR &amp; HOUSEHOLD</p><h2>{brief.donor.displayName}</h2>{donorCode && <span className="donor-code">{donorCode}</span>}<p>{members.length ? members.join(" & ") : "Household member names are not recorded."}</p></div></div>
      <div><p className="eyebrow">CONTACT</p>{brief.donor.email ? <a href={`mailto:${brief.donor.email}`}>{brief.donor.email}</a> : <p>No email recorded.</p>}{brief.donor.phone ? <a href={`tel:${brief.donor.phone.replace(/\D/g, "")}`}>{brief.donor.phone}</a> : brief.donor.homePhone ? <a href={`tel:${brief.donor.homePhone.replace(/\D/g, "")}`}>{brief.donor.homePhone}</a> : <p>No phone recorded.</p>}{brief.donor.address.length ? <address>{brief.donor.address.map((line) => <span key={line}>{line}</span>)}</address> : <p>No address recorded.</p>}</div>
    </section>

    <div className="meeting-brief-essential-grid">
      <section className="meeting-brief-card meeting-brief-last-interaction"><div className="meeting-card-heading"><p className="eyebrow">LAST INTERACTION</p><h2>{brief.lastMeaningfulContact ? date(brief.lastMeaningfulContact.occurredAt, profile.timezone) : "None recorded"}</h2></div>{latestInteraction ? <><strong>{latestInteraction.timelineTitle}</strong><p>{latestInteraction.timelineNote}</p><span className="event-type">{brief.lastMeaningfulContact?.type}</span></> : <p className="meeting-empty">No previous interaction is recorded.</p>}{brief.unconfirmedHistoricalContextCount > 0 && <p className="meeting-unconfirmed-note">{brief.unconfirmedHistoricalContextCount} unconfirmed historical note{brief.unconfirmedHistoricalContextCount === 1 ? "" : "s"} from imported sources -- not verified, not counted as contact.</p>}</section>
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">RECENT DISCUSSION TOPICS</p><h2>What has been discussed</h2></div>{brief.recentDiscussionTopics.length ? <ul className="meeting-topic-list">{brief.recentDiscussionTopics.map((topic) => <li key={topic}>{topic}</li>)}</ul> : <p className="meeting-empty">No discussion topics are recorded yet.</p>}</section>
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">OPEN COMMITMENTS</p><h2>What still needs attention</h2></div>{brief.openReminders.length ? <div className="meeting-commitment-list">{brief.openReminders.map((item) => <article key={item.id}><strong>{item.action}</strong><span>{item.dueAt ? `Due ${date(item.dueAt, profile.timezone)}` : "No due date"}</span>{item.reason && <p>{item.reason}</p>}</article>)}</div> : <p className="meeting-empty">No open commitments are recorded.</p>}</section>
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">LAST GIFT</p><h2>Giving context</h2></div><div className="meeting-last-gift"><GiftSummary gift={brief.recentGift} empty="No paid gift recorded" /></div><p className="meeting-giving-context">{brief.lifetimePaidCents ? `${money(brief.lifetimePaidCents)} lifetime paid` : "No paid giving recorded"}{brief.openPledgeCents ? ` · ${money(brief.openPledgeCents)} open pledge balance` : ""}</p></section>
      <section className="meeting-brief-card"><div className="meeting-card-heading"><p className="eyebrow">PEOPLE MENTIONED</p><h2>Names to remember</h2></div>{brief.peopleMentioned.length ? <ul className="meeting-people-list">{brief.peopleMentioned.map((person) => <li key={person}>{person}</li>)}</ul> : <p className="meeting-empty">No additional people are mentioned in recent notes.</p>}</section>
      <section className="meeting-brief-card meeting-preparation-card"><div className="meeting-card-heading"><p className="eyebrow">SUGGESTED PREPARATION</p><h2>Before the conversation</h2></div><ol className="meeting-suggestions">{brief.discussionTopics.map((topic) => <li key={topic.title}><strong>{topic.title}</strong><p>{topic.detail}</p></li>)}</ol><a className="meeting-outcome-button" href={`/capture?donorId=${encodeURIComponent(id)}&type=meeting`}>Log Meeting Outcome</a></section>
    </div>
  </main></AppShell>;
}
