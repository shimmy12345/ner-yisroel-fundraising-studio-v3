"use client";

import { useState } from "react";
import type { PledgeReviewItem, PersistedPledgeReviewStatus } from "../../lib/relationships/pledge-review";
import { PLEDGE_REVIEW_CHOICES, summarizePledgeReviewProgress } from "../../lib/relationships/pledge-review";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
// timeZone: "UTC" required -- activity_date/payment_date are date-only
// epochs (UTC midnight); without this a UTC-midnight date can render as
// the previous calendar day west of UTC. Same convention as
// PledgePaymentPlanManagement.tsx's dateLabel.
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(epoch * 1000));

// D1 (pledge_payment_plan_reviews, via /api/pledge-payment-plan-reviews/
// [pledgeActivityId]) is the ONLY authoritative store for review
// decisions -- this component holds React state purely as an optimistic
// UI mirror of what was last successfully saved, initialized directly
// from the server-rendered `initialReviews` prop (itself a fresh D1 read
// on every page load, since the page is force-dynamic/revalidate:0).
// There is no sessionStorage/localStorage involved anywhere in this
// component: an earlier round used sessionStorage as the only store, but
// that could never survive a browser close or another device, and kept
// alive risked a stale cached value overwriting a newer persisted
// decision -- removed entirely rather than carefully reconciled.
type SaveState = "idle" | "saving" | "error";

function PledgeRow({ item, status, saveState, onChoose, onClear }: {
  item: PledgeReviewItem;
  status: PersistedPledgeReviewStatus | null;
  saveState: SaveState;
  onChoose: (value: PersistedPledgeReviewStatus) => void;
  onClear: () => void;
}) {
  return (
    <div className="pledge-review-row" data-reviewed={status ? "true" : "false"}>
      <div className="pledge-review-row-main">
        <div className="pledge-review-donor">
          <a href={`/donors/${encodeURIComponent(item.donorId)}`}>{item.donorName}</a>
          <span className="pledge-review-donor-code">Code {item.donorCode ?? "—"}</span>
        </div>
        <span className={`pledge-review-paid-badge pledge-review-paid-badge--${item.paidStatus}`}>
          {item.paidStatus === "partially_paid" ? "Partially paid" : "Unpaid"}
        </span>
        {item.planStatus === "old_inactive_plan" && <span className="pledge-review-plan-badge">Old/inactive plan existed</span>}
      </div>

      <dl className="pledge-review-facts">
        <div><dt>JL Activity Date</dt><dd>{dateLabel(item.activityDate)}{item.isFutureDated ? " (future-dated)" : ""}</dd></div>
        <div><dt>Campaign</dt><dd>{item.campaign || "—"}</dd></div>
        <div><dt>Original</dt><dd>{money(item.originalCents)}</dd></div>
        <div><dt>Paid</dt><dd>{money(item.paidCents)}</dd></div>
        <div><dt>Balance</dt><dd>{money(item.balanceCents)}</dd></div>
        <div><dt>Last payment</dt><dd>
          {item.lastPaymentDate !== null
            ? `${dateLabel(item.lastPaymentDate)} · ${money(item.lastPaymentAmountCents ?? 0)}`
            : item.hasReliableHistory
              ? "No payment recorded"
              : <span className="pledge-review-caveat">Payment recorded; detailed payment history unavailable</span>}
        </dd></div>
      </dl>
      {item.description && <p className="pledge-review-description">{item.description}</p>}
      <p className="pledge-review-pledge-id">Pledge ID: {item.pledgeId}</p>

      <div className="pledge-review-choices" role="group" aria-label={`Review decision for ${item.donorName}`}>
        {PLEDGE_REVIEW_CHOICES.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={saveState === "saving"}
            className={status === option.value ? "pledge-review-choice pledge-review-choice--selected" : "pledge-review-choice"}
            onClick={() => onChoose(option.value)}
          >
            {option.label}
          </button>
        ))}
        {status !== null && (
          <button type="button" className="pledge-review-choice pledge-review-choice--clear" disabled={saveState === "saving"} onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {saveState === "saving" && <p className="pledge-review-save-status">Saving…</p>}
      {saveState === "error" && <p className="pledge-review-save-status pledge-review-save-status--error" role="alert">Could not save -- try again.</p>}
    </div>
  );
}

export function PledgeReviewList({ items, initialReviews }: { items: PledgeReviewItem[]; initialReviews: Record<string, PersistedPledgeReviewStatus> }) {
  const [statuses, setStatuses] = useState<Record<string, PersistedPledgeReviewStatus>>(initialReviews);
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});

  async function choose(pledgeId: string, value: PersistedPledgeReviewStatus) {
    const previous = statuses[pledgeId] ?? null;
    setStatuses((prev) => ({ ...prev, [pledgeId]: value }));
    setSaveStates((prev) => ({ ...prev, [pledgeId]: "saving" }));
    try {
      const response = await fetch(`/api/pledge-payment-plan-reviews/${encodeURIComponent(pledgeId)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: value }),
      });
      if (!response.ok) throw new Error("save failed");
      setSaveStates((prev) => ({ ...prev, [pledgeId]: "idle" }));
    } catch {
      setStatuses((prev) => (previous === null ? (() => { const next = { ...prev }; delete next[pledgeId]; return next; })() : { ...prev, [pledgeId]: previous }));
      setSaveStates((prev) => ({ ...prev, [pledgeId]: "error" }));
    }
  }

  async function clear(pledgeId: string) {
    const previous = statuses[pledgeId] ?? null;
    if (previous === null) return;
    setStatuses((prev) => { const next = { ...prev }; delete next[pledgeId]; return next; });
    setSaveStates((prev) => ({ ...prev, [pledgeId]: "saving" }));
    try {
      const response = await fetch(`/api/pledge-payment-plan-reviews/${encodeURIComponent(pledgeId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("clear failed");
      setSaveStates((prev) => ({ ...prev, [pledgeId]: "idle" }));
    } catch {
      setStatuses((prev) => ({ ...prev, [pledgeId]: previous }));
      setSaveStates((prev) => ({ ...prev, [pledgeId]: "error" }));
    }
  }

  const progress = summarizePledgeReviewProgress(items, statuses);

  return (
    <div className="pledge-review-list">
      <div className="pledge-review-progress">
        <strong>Reviewed {progress.reviewedCount} of {progress.totalCount}</strong>
        <span className="pledge-review-progress-counts">
          Needs payment plan: {progress.counts.needs_payment_plan} · No payment plan needed: {progress.counts.no_payment_plan_needed} · Need to investigate: {progress.counts.need_to_investigate} · Unreviewed: {progress.unreviewedCount}
        </span>
        <span className="pledge-review-progress-note">Saved to your Fundraising OS workspace -- available from any browser or device signed in to it.</span>
      </div>
      {items.map((item) => (
        <PledgeRow
          key={item.pledgeId}
          item={item}
          status={statuses[item.pledgeId] ?? null}
          saveState={saveStates[item.pledgeId] ?? "idle"}
          onChoose={(value) => void choose(item.pledgeId, value)}
          onClear={() => void clear(item.pledgeId)}
        />
      ))}
    </div>
  );
}
