"use client";

import { useMemo, useState } from "react";
import { ActivityActions } from "../../components/ActivityActions";
import { CompletePriorityButton } from "../../components/CompletePriorityButton";
import { GivingRecordActions } from "./GivingManagement";
import { buildUnifiedTimeline, TIMELINE_FILTERS, type TimelineFilter, type TimelineGiving, type TimelineInteraction, type TimelineLegacyGift, type TimelinePayment, type TimelineReminder, type TimelineStatus } from "../../../lib/relationships/unified-timeline";
import type { DonorSearchRecord } from "../../../lib/relationships/donor-search";
import { financialDateLabel } from "../../../lib/financial-date";
import { splitInteractionSummary } from "../../../lib/capture/interaction";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const dateTime = (epoch: number, timezone: string) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(epoch * 1000));
const STATUS_LABELS: Record<TimelineStatus, string> = { scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", pending: "Pending · unconfirmed", open: "Open", overdue: "Overdue", "needs-review": "Needs review", excluded: "Excluded from totals" };
// Newest-first history can grow very long for a donor with extensive
// giving activity. Show the most recent RECENT_LIMIT records by default
// (per filter) with an explicit expand/collapse control, rather than
// rendering the entire history inline every time.
const RECENT_LIMIT = 10;

export function UnifiedRelationshipTimeline({ giving, legacyGifts, payments, interactions, reminders, donors, timezone, live, now }: {
  giving: TimelineGiving[];
  legacyGifts: TimelineLegacyGift[];
  payments: TimelinePayment[];
  interactions: TimelineInteraction[];
  reminders: TimelineReminder[];
  donors: DonorSearchRecord[];
  timezone: string;
  live: boolean;
  now: number;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const timeline = useMemo(() => buildUnifiedTimeline({ giving, legacyGifts, payments, interactions, reminders, now }), [giving, legacyGifts, payments, interactions, reminders, now]);
  const counts = useMemo(() => new Map(TIMELINE_FILTERS.map((option) => [option.id, option.id === "all" ? timeline.length : timeline.filter((item) => item.filter === option.id).length])), [timeline]);
  const visible = filter === "all" ? timeline : timeline.filter((item) => item.filter === filter);
  const selectedLabel = TIMELINE_FILTERS.find((item) => item.id === filter)?.label ?? "activity";
  const visibleSlice = showAll ? visible : visible.slice(0, RECENT_LIMIT);
  const visibleGivingIds = new Set(visibleSlice.filter((item) => item.kind === "giving").map((item) => item.giving.id));
  const hiddenCount = visible.length - visibleSlice.length;

  function selectFilter(next: TimelineFilter) {
    setFilter(next);
    setShowAll(false);
  }

  if (!timeline.length) return <div className="unified-timeline-empty"><strong>No relationship activity yet</strong><p>Gifts, conversations, reminders, and scheduled work will appear here in date order.</p></div>;

  return <>
    <nav className="timeline-filters" aria-label="Filter relationship timeline">{TIMELINE_FILTERS.filter((option) => option.id === "all" || (counts.get(option.id) ?? 0) > 0).map((option) => <button key={option.id} type="button" className={filter === option.id ? "active" : ""} aria-pressed={filter === option.id} onClick={() => selectFilter(option.id)}>{option.label}<span>{counts.get(option.id) ?? 0}</span></button>)}</nav>
    {visible.length === 0 ? <div className="unified-timeline-empty"><strong>No {selectedLabel.toLowerCase()} recorded</strong><p>Choose another filter to continue reviewing this donor&apos;s relationship history.</p></div> : <div className="timeline-list unified-timeline-list">{visibleSlice.map((item) => {
      if (item.kind === "giving") {
        const activity = item.giving;
        const amount = activity.committed_cents ?? activity.paid_cents ?? 0;
        // Campaign (e.g. "Annual Dinner", "Chai Campaign") is a distinct
        // concept from transaction type (Gift/Pledge/Payment, shown in the
        // event-type badge below) -- it never replaces that badge. A JL
        // compact-format import has no per-row description/item type at
        // all, so campaign is also used as the title fallback -- otherwise
        // every such row would show the same generic "Gift"/"Pledge" with
        // no way to tell transactions apart without opening raw import
        // data. When Campaign is blank, this falls through to the plain
        // "Gift"/"Pledge" label exactly as before, with no empty
        // placeholder.
        const title = activity.description || activity.item_type || activity.source_campaign || (item.filter === "pledges" ? "Pledge" : "Gift");
        return <article id={`pledge-${activity.id}`} className={`timeline-item unified-timeline-item ${item.status}`} key={item.key}><time><strong>{activity.activity_date ? financialDateLabel(item.eventAt) : "Date not recorded"}</strong></time><span className="timeline-dot gift">$</span><div className="timeline-content"><div><h3>{title}</h3><span className="event-type">{item.filter === "pledges" ? "Pledge" : "Gift"}</span>{activity.source_campaign && <span className="event-campaign">{activity.source_campaign}</span>}<span className={`timeline-status ${item.status}`}>{STATUS_LABELS[item.status]}</span></div><p>{money(amount)} committed{(activity.paid_cents ?? 0) > 0 ? ` · ${money(activity.paid_cents ?? 0)} paid` : ""}{(activity.balance_cents ?? 0) > 0 ? ` · ${money(activity.balance_cents ?? 0)} open` : ""}</p>{live && <GivingRecordActions activity={{ id: activity.id, donorId: activity.donor_id, externalSource: activity.external_source, workspaceStatus: activity.workspace_status, privateNote: activity.private_note, updatedAt: activity.updated_at }} donors={donors} />}</div></article>;
      }
      if (item.kind === "legacy-gift") return <article className="timeline-item unified-timeline-item completed" key={item.key}><time><strong>{financialDateLabel(item.eventAt)}</strong></time><span className="timeline-dot gift">$</span><div className="timeline-content"><div><h3>{item.gift.fund || "Gift"}</h3><span className="event-type">Gift</span><span className="timeline-status completed">Completed</span></div><p>{money(item.gift.amount_cents)} paid</p></div></article>;
      if (item.kind === "payment") {
        const linkedPledgeLabel = item.payment.pledge_description ? `Linked pledge: ${item.payment.pledge_description}` : "View linked pledge";
        // The linked pledge may exist but sit outside the currently
        // truncated slice -- an anchor to it would silently do nothing, so
        // expand to the full history first instead of rendering a dead link.
        const linkedPledgeVisible = item.linkedPledgeExists && visibleGivingIds.has(item.payment.pledge_activity_id);
        return <article className="timeline-item unified-timeline-item completed pledge-payment-event" key={item.key}><time><strong>{financialDateLabel(item.eventAt)}</strong></time><span className="timeline-dot gift">$</span><div className="timeline-content"><div><h3>Payment applied to pledge</h3><span className="event-type">Payment</span>{item.payment.pledge_campaign && <span className="event-campaign">{item.payment.pledge_campaign}</span>}<span className="timeline-status completed">Completed</span></div><p>{money(item.payment.applied_cents)} paid · {money(item.payment.remaining_balance_cents ?? 0)} remaining</p>{linkedPledgeVisible ? <a className="timeline-linked-record" href={`#pledge-${encodeURIComponent(item.payment.pledge_activity_id)}`}>{linkedPledgeLabel}</a> : item.linkedPledgeExists ? <button type="button" className="timeline-linked-record timeline-linked-record-expand" onClick={() => setShowAll(true)}>{linkedPledgeLabel} · Show all to view</button> : <small className="timeline-link-unavailable">Linked pledge is unavailable</small>}</div></article>;
      }
      if (item.kind === "reminder") return <article className={`timeline-item unified-timeline-item ${item.status}`} key={item.key}><time><strong>{dateTime(item.eventAt, timezone)}</strong></time><span className="timeline-dot note">!</span><div className="timeline-content"><div><h3>{item.reminder.action}</h3><span className="event-type">Reminder</span><span className={`timeline-status ${item.status}`}>{STATUS_LABELS[item.status]}</span></div><p>{item.reminder.reason || (item.reminder.status === "completed" ? "Completed reminder" : "No additional context recorded.")}</p>{live && item.reminder.status === "open" && <CompletePriorityButton recommendationId={item.reminder.id} />}</div></article>;
      const activity = item.interaction;
      const { timelineTitle, timelineNote } = splitInteractionSummary(activity.summary);
      const followUp = activity.source.includes("followup:");
      const typeLabel = `${item.noResponse ? "No response · " : item.status === "completed" ? followUp ? "Completed follow-up · " : "Completed · " : item.status === "cancelled" ? "Cancelled · " : "Scheduled · "}${activity.type}`;
      const scheduled = item.status === "scheduled";
      return <article className={`timeline-item unified-timeline-item ${item.status}`} key={item.key}><time><strong>{dateTime(item.eventAt, timezone)}</strong></time><span className="timeline-dot">•</span><div className="timeline-content"><div><h3>{timelineTitle}</h3><span className="event-type">{typeLabel}</span><span className={`timeline-status ${item.status}`}>{STATUS_LABELS[item.status]}</span></div>{item.plannedAt && item.status === "completed" && <small className="timeline-planned-date">Originally planned for {dateTime(item.plannedAt, timezone)}</small>}<p>{timelineNote}</p>{live && scheduled && <a className="timeline-outcome-link" href={`/interactions/${encodeURIComponent(activity.id)}/outcome`}>Log Outcome</a>}{live && item.status === "cancelled" && <a className="timeline-outcome-link secondary" href={`/interactions/${encodeURIComponent(activity.id)}/outcome`}>Edit or reopen</a>}{live && item.status !== "cancelled" && <ActivityActions activityId={activity.id} editHref={`/interactions/${encodeURIComponent(activity.id)}/edit`} scheduled={scheduled} canCancel={scheduled && activity.occurred_at > now} />}</div></article>;
    })}</div>}
    {hiddenCount > 0 && <button type="button" className="timeline-more" onClick={() => setShowAll(true)}>Show all {visible.length} {selectedLabel.toLowerCase()} records ({hiddenCount} more)</button>}
    {showAll && visible.length > RECENT_LIMIT && <button type="button" className="timeline-more" onClick={() => setShowAll(false)}>Show recent {RECENT_LIMIT}</button>}
  </>;
}
