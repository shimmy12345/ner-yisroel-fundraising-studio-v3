"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspacePriority } from "../../lib/workspace/live-data";
import type { RelationshipQueueBucket } from "../../lib/workspace/relationship-queue";
import { removeQueueItem, restoreQueueItem } from "../../lib/workspace/optimistic-dismissal";
import { CompletePriorityButton } from "./CompletePriorityButton";
import { donorNavigationHref, meetingBriefNavigationHref } from "../../lib/navigation/donor-navigation";
import { GiftAcknowledgmentActions } from "../donors/[id]/GivingManagement";

const GROUPS: Array<{ key: RelationshipQueueBucket; title: string; description: string }> = [
  { key: "overdue", title: "Overdue", description: "Follow-ups that need attention first" },
  { key: "today", title: "Due today", description: "Calls, follow-ups, gifts, and reminders for today" },
  { key: "thisWeek", title: "This Week", description: "Due in the next seven days" },
  { key: "upcoming", title: "Later", description: "Open commitments and future relationship work" },
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

export function RelationshipQueueExperience({ initialQueue, priorityCount, showAll, scope, expanded = false }: { initialQueue: Record<RelationshipQueueBucket, WorkspacePriority[]>; priorityCount: number; showAll: boolean; scope: "agenda" | "coming"; expanded?: boolean }) {
  const scopeGroups = useMemo(() => GROUPS.filter((group) => scope === "agenda" ? group.key === "overdue" || group.key === "today" : group.key === "thisWeek" || group.key === "upcoming"), [scope]);
  const initialItems = useMemo(() => scopeGroups.flatMap((group) => initialQueue[group.key]), [initialQueue, scopeGroups]);
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
  const queueAnchor = scope === "agenda" ? "relationship-queue" : "coming-up-queue";
  const queueReturnTo = showAll ? `/?priorities=all#${queueAnchor}` : `/#${queueAnchor}`;
  const displayLimit = showAll ? visibleCount : expanded ? 5 : scope === "agenda" ? 5 : 3;
  const displayIds = new Set(items.slice(0, displayLimit).map((item) => item.queueId));
  const displayedCount = Math.min(visibleCount, displayLimit);

  return <>
    <div className={`relationship-queue command-queue ${scope}`} id={scope === "agenda" ? "relationship-queue" : "coming-up-queue"}>
      {visibleCount ? <div className="relationship-queue-groups">{scopeGroups.map((group) => grouped[group.key].some((item) => displayIds.has(item.queueId)) ? <section key={group.key} className={`relationship-queue-group ${group.key}`}><header><div><h3>{group.title}</h3><p>{group.description}</p></div><span>{grouped[group.key].length}</span></header><div className="priority-list">{grouped[group.key].filter((item) => displayIds.has(item.queueId)).map((priority) => <article key={priority.queueId} className={`priority-card relationship-queue-card ${priority.bucket}`}>
        <div className="avatar">{priority.initials}</div><div className="priority-main"><div className="priority-heading"><div><h3><a href={donorNavigationHref(priority.donorId, queueReturnTo, "queue")}>{priority.name}</a></h3>{priority.donorCode && <span className="donor-code">{priority.donorCode}</span>}</div><span className={`signal ${priority.signal}`}>{priority.label}</span></div><p>{priority.reason}</p><div className="why"><span aria-hidden="true">✦</span><span>{priority.why}</span></div><time>{priority.dueLabel}</time></div>
        <div className="priority-actions">{priority.giftSource && priority.giftId ? <GiftAcknowledgmentActions giftSource={priority.giftSource} giftId={priority.giftId} initialStatus={null} compact /> : <a className="action-button" href={queueActionHref(priority, queueReturnTo)}>{priority.action}<span aria-hidden="true">→</span></a>}{priority.recommendationId ? <CompletePriorityButton recommendationId={priority.recommendationId} onOptimisticComplete={() => completeOptimistically(priority)} onCompleteFailed={() => restoreFailedCompletion(priority)} /> : <button type="button" className="dismiss-queue-button" disabled={busyIds.has(priority.queueId)} onClick={() => void dismiss(priority)}>{busyIds.has(priority.queueId) ? "Restoring…" : "Dismiss suggestion"}</button>}</div>
      </article>)}</div></section> : null)}</div> : null}
      {!showAll && (visibleCount > displayedCount || adjustedPriorityCount > visibleCount) ? <a className="view-all-link queue-view-all" href={`/?priorities=all#${queueAnchor}`}>View all priorities</a> : showAll ? <a className="view-all-link queue-view-all" href={`/#${queueAnchor}`}>Show top actions</a> : null}
    </div>

    <div className="queue-toast-region" aria-live="polite" aria-atomic="false">{Object.values(toasts).map((toast) => <div className={`queue-toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} key={toast.item.queueId}><span>{toast.message}</span>{toast.kind === "dismissed" && <button type="button" onClick={() => void undo(toast.item)}>Undo</button>}</div>)}</div>
  </>;
}
