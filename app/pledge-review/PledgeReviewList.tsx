"use client";

import { useEffect, useState } from "react";
import type { PledgeReviewItem, PledgeReviewChoice } from "../../lib/relationships/pledge-review";
import { PLEDGE_REVIEW_CHOICES } from "../../lib/relationships/pledge-review";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
// timeZone: "UTC" required -- activity_date/payment_date are date-only
// epochs (UTC midnight); without this a UTC-midnight date can render as
// the previous calendar day west of UTC. Same convention as
// PledgePaymentPlanManagement.tsx's dateLabel.
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(epoch * 1000));

const STORAGE_KEY = "pledge-review-choices-v1";

// Review choices are deliberately NOT sent to the server anywhere in this
// component -- no fetch, no API route. They live only in this browser
// tab's sessionStorage (cleared when the tab closes), which is why the
// page explicitly labels this "not saved" rather than implying durable
// state. Persisting these choices durably would mean either reusing an
// existing field for a new structured purpose or adding new schema --
// both were deliberately left as an open decision rather than picked
// silently; see docs/AI-HANDOFF.md's entry for this round.
function loadChoices(): Record<string, PledgeReviewChoice> {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as Record<string, PledgeReviewChoice> : {};
  } catch {
    return {};
  }
}
function saveChoices(choices: Record<string, PledgeReviewChoice>) {
  try { window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(choices)); } catch { /* best-effort only */ }
}

function PledgeRow({ item, choice, onChoose }: { item: PledgeReviewItem; choice: PledgeReviewChoice | undefined; onChoose: (value: PledgeReviewChoice) => void }) {
  return (
    <div className="pledge-review-row" data-reviewed={choice ? "true" : "false"}>
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
            className={choice === option.value ? "pledge-review-choice pledge-review-choice--selected" : "pledge-review-choice"}
            onClick={() => onChoose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function PledgeReviewList({ items }: { items: PledgeReviewItem[] }) {
  const [choices, setChoices] = useState<Record<string, PledgeReviewChoice>>({});
  const [hydrated, setHydrated] = useState(false);

  // sessionStorage only exists client-side -- reading it during the
  // server-rendered first pass (or in a lazy useState initializer, which
  // hydration would not re-run) would either crash on the server or
  // permanently miss the stored choices. Reading it once after mount,
  // here, is the correct pattern for this exact SSR/client-storage case.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setChoices(loadChoices()); setHydrated(true); }, []);

  function choose(pledgeId: string, value: PledgeReviewChoice) {
    setChoices((prev) => {
      const next = { ...prev, [pledgeId]: value };
      saveChoices(next);
      return next;
    });
  }

  const reviewedCount = hydrated ? items.filter((item) => choices[item.pledgeId]).length : 0;

  return (
    <div className="pledge-review-list">
      <div className="pledge-review-progress">
        <strong>Reviewed {reviewedCount} of {items.length}</strong>
        <span className="pledge-review-progress-note">Not saved to the server -- remembered only in this browser tab for this session.</span>
      </div>
      {items.map((item) => (
        <PledgeRow key={item.pledgeId} item={item} choice={choices[item.pledgeId]} onChoose={(value) => choose(item.pledgeId, value)} />
      ))}
    </div>
  );
}
