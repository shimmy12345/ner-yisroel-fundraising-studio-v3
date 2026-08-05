"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceMorningBrief, WorkspacePriority } from "../../lib/workspace/live-data";
import type { RelationshipQueueBucket } from "../../lib/workspace/relationship-queue";
import { removeQueueItem, restoreQueueItem } from "../../lib/workspace/optimistic-dismissal";
import { CompletePriorityButton } from "./CompletePriorityButton";
import { donorNavigationHref, meetingBriefNavigationHref } from "../../lib/navigation/donor-navigation";

const GROUPS: Array<{ key: RelationshipQueueBucket; title: string; description: string }> = [
  { key: "overdue", title: "Overdue", description: "Follow-ups that need attention first" },
  { key: "today", title: "Today", description: "Work that matters before the day ends" },
  { key: "thisWeek", title: "This Week", description: "Due in the next seven days" },
  { key: "upcoming", title: "Upcoming", description: "Important work without an immediate deadline" },
];

type Toast = { item: WorkspacePriority; kind: "dismissed" | "restored" | "completed" | "error"; message: string };

async function persist(method: "POST" | "DELETE", item: WorkspacePriority) {
  const response = await fetch("/api/relationship-queue/dismiss", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId: item.queueId, donorId: item.donorId }) });
  return response.ok;
}

function queueActionHref(item: WorkspacePriority, returnTo: string) {
  if (item.href.includes("/meeting-brief")) return meetingBriefNavigationHref(item.donorId, returnTo, "queue");
  if (item.href.startsWith("/donors/")) return donorNavigationHref(item.donorId, returnTo, "queue");
  return item.href;
}

export function RelationshipQueueExperience({ initialQueue, morningBrief, priorityCount, showAll }: { initialQueue: Record<RelationshipQueueBucket, WorkspacePriority[]>; morningBrief: WorkspaceMorningBrief; priorityCount: number; showAll: boolean }) {
  const initialItems = useMemo(() => GROUPS.flatMap((group) => initialQueue[group.key]), [initialQueue]);
  const order = useMemo(() => new Map(initialItems.map((item, index) => [item.queueId, index])), [initialItems]);
  const [items, setItems] = useState(initialItems);
  const [toasts, setToasts] = useState<Record<string, Toast>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlight = useRef(new Map<string, Promise<boolean>>());
  const desiredDismissed = useRef(new Map<string, boolean>());

  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);

  function clearToastLater(queueId: string, milliseconds = 10_000) {
    const current = timers.current.get(queueId);
    if (current) clearTimeout(current);
    timers.current.set(queueId, setTimeout(() => {
      setToasts((value) => { const next = { ...value }; delete next[queueId]; return next; });
      timers.current.delete(queueId);
    }, milliseconds));
  }

  function showToast(item: WorkspacePriority, kind: Toast["kind"], message: string, milliseconds = 10_000) {
    setToasts((value) => ({ ...value, [item.queueId]: { item, kind, message } }));
    clearToastLater(item.queueId, milliseconds);
  }

  async function dismiss(item: WorkspacePriority) {
    if (busyIds.has(item.queueId)) return;
    desiredDismissed.current.set(item.queueId, true);
    setItems((value) => removeQueueItem(value, item.queueId));
    showToast(item, "dismissed", "Suggestion dismissed");
    const request = persist("POST", item);
    inFlight.current.set(item.queueId, request);
    const saved = await request;
    inFlight.current.delete(item.queueId);
    if (!saved && desiredDismissed.current.get(item.queueId)) {
      desiredDismissed.current.set(item.queueId, false);
      setItems((value) => restoreQueueItem(value, item, order));
      showToast(item, "error", "Suggestion could not be dismissed. It has been restored.", 6_000);
    }
  }

  async function undo(item: WorkspacePriority) {
    if (!desiredDismissed.current.get(item.queueId)) return;
    desiredDismissed.current.set(item.queueId, false);
    setItems((value) => restoreQueueItem(value, item, order));
    setBusyIds((value) => new Set(value).add(item.queueId));
    showToast(item, "restored", "Suggestion restored", 3_000);
    const pendingDismissal = inFlight.current.get(item.queueId);
    const dismissalSaved = pendingDismissal ? await pendingDismissal : true;
    const restored = !dismissalSaved || await persist("DELETE", item);
    setBusyIds((value) => { const next = new Set(value); next.delete(item.queueId); return next; });
    if (!restored && !desiredDismissed.current.get(item.queueId)) {
      desiredDismissed.current.set(item.queueId, true);
      setItems((value) => removeQueueItem(value, item.queueId));
      showToast(item, "error", "Undo could not be saved. The suggestion remains dismissed.", 6_000);
    }
  }

  function completeOptimistically(item: WorkspacePriority) {
    setItems((value) => removeQueueItem(value, item.queueId));
    showToast(item, "completed", "Action completed", 4_000);
  }

  function restoreFailedCompletion(item: WorkspacePriority) {
    setItems((value) => restoreQueueItem(value, item, order));
    showToast(item, "error", "Action could not be completed. It has been restored.", 6_000);
  }

  const grouped = useMemo(() => Object.fromEntries(GROUPS.map((group) => [group.key, items.filter((item) => item.bucket === group.key)])) as Record<RelationshipQueueBucket, WorkspacePriority[]>, [items]);
  const visibleCount = items.length;
  const adjustedPriorityCount = Math.max(0, priorityCount - (initialItems.length - visibleCount));
  const suggestedPriority = items[0] ?? null;
  const queueReturnTo = showAll ? "/?priorities=all#relationship-queue" : "/#relationship-queue";

  return <>
    <section className="today-morning-brief" aria-labelledby="morning-brief-title">
      <div className="section-title"><div><p className="eyebrow">MORNING BRIEF</p><h2 id="morning-brief-title">What deserves attention today</h2><p>Live counts from your meetings, follow-ups, giving, and reminders</p></div><a className="view-all-link" href="/assistant">Open Assistant</a></div>
      <div className="morning-brief-grid">
        <article><strong>{morningBrief.meetingsToday}</strong><span>Meetings today</span></article>
        <article><strong>{morningBrief.overdueFollowUps}</strong><span>Overdue follow-ups</span></article>
        <article><strong>{morningBrief.recentGifts}</strong><span>Recent gifts</span></article>
        <article><strong>{morningBrief.upcomingReminders}</strong><span>Upcoming reminders</span></article>
        <article className="morning-suggested-priority"><span>Suggested priority</span>{suggestedPriority ? <><strong>{suggestedPriority.name}</strong>{suggestedPriority.donorCode && <span className="donor-code">{suggestedPriority.donorCode}</span>}<p>{suggestedPriority.reason}</p><a href={donorNavigationHref(suggestedPriority.donorId, queueReturnTo, "queue")}>Open relationship →</a></> : <p>No time-sensitive priority is available.</p>}</article>
      </div>
    </section>

    <section className="relationship-queue" id="relationship-queue">
      <div className="section-title"><div><p className="eyebrow">RELATIONSHIP QUEUE</p><h2>{showAll ? "All current relationship work" : "Your next relationship actions"}</h2><p>One clear reason per donor, ordered by urgency. Completing a reminder or closing an activity removes it automatically.</p></div><span className="count" aria-label={`${visibleCount} visible relationship actions`}>{visibleCount}</span></div>
      {visibleCount ? <div className="relationship-queue-groups">{GROUPS.map((group) => grouped[group.key].length ? <section key={group.key} className={`relationship-queue-group ${group.key}`}><header><div><h3>{group.title}</h3><p>{group.description}</p></div><span>{grouped[group.key].length}</span></header><div className="priority-list">{grouped[group.key].map((priority) => <article key={priority.queueId} className={`priority-card relationship-queue-card ${priority.bucket}`}>
        <div className="avatar">{priority.initials}</div><div className="priority-main"><div className="priority-heading"><div><h3><a href={donorNavigationHref(priority.donorId, queueReturnTo, "queue")}>{priority.name}</a></h3>{priority.donorCode && <span className="donor-code">{priority.donorCode}</span>}</div><span className={`signal ${priority.signal}`}>{priority.label}</span></div><p>{priority.reason}</p><div className="why"><span aria-hidden="true">✦</span><span>{priority.why}</span></div><time>{priority.dueLabel}</time></div>
        <div className="priority-actions"><a className="action-button" href={queueActionHref(priority, queueReturnTo)}>{priority.action}<span aria-hidden="true">→</span></a>{priority.recommendationId ? <CompletePriorityButton recommendationId={priority.recommendationId} onOptimisticComplete={() => completeOptimistically(priority)} onCompleteFailed={() => restoreFailedCompletion(priority)} /> : <button type="button" className="dismiss-queue-button" disabled={busyIds.has(priority.queueId)} onClick={() => void dismiss(priority)}>{busyIds.has(priority.queueId) ? "Restoring…" : "Dismiss suggestion"}</button>}</div>
      </article>)}</div></section> : null)}</div> : <section className="directory-empty"><h2>Your relationship queue is clear</h2><p>There are no open reminders, scheduled activities, unacknowledged gifts, commitments, or contact gaps requiring attention.</p><a href="/capture?returnTo=%2F">Log an interaction</a></section>}
      {adjustedPriorityCount > visibleCount ? <a className="view-all-link queue-view-all" href="/?priorities=all#relationship-queue">View all {adjustedPriorityCount}</a> : showAll ? <a className="view-all-link queue-view-all" href="/#relationship-queue">Show top actions</a> : null}
    </section>

    <div className="queue-toast-region" aria-live="polite" aria-atomic="false">{Object.values(toasts).map((toast) => <div className={`queue-toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} key={toast.item.queueId}><span>{toast.message}</span>{toast.kind === "dismissed" && <button type="button" onClick={() => void undo(toast.item)}>Undo</button>}</div>)}</div>
  </>;
}
