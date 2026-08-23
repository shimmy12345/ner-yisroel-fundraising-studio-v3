"use client";

import { useState } from "react";
import type { ReminderChoice } from "../../../lib/capture/interaction";
import { localDayKey } from "../../../lib/workspace/local-time";
import { RescheduleButton } from "../../components/RescheduleButton";

export type AskStatus = "pending" | "committed" | "declined" | "withdrawn";
export type AskItem = { id: string; amountCents: number | null; purpose: string | null; status: AskStatus; askedAt: number; note: string | null };
// The ask's own open follow-up reminder, if any -- matched server-side by
// the existing "ask-<askId>-" recommendation id convention (see
// app/api/asks/[id]/reminder/route.ts), never a second reminder system.
// null when this ask has no active follow-up yet.
export type AskFollowUp = { id: string; dueAt: number | null };

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
const STATUS_LABEL: Record<AskStatus, string> = { pending: "Pending", committed: "Committed", declined: "Declined", withdrawn: "Stopped pursuing" };
const followUpReminderOptions: Array<[ReminderChoice, string]> = [["tomorrow", "Tomorrow"], ["next-week", "Next week"], ["custom", "Custom"]];

// A single open (pending) ask -- compact, factual, never a management
// dashboard. Amount is shown only when present; a null amount never
// renders as "$0" (see design). Mark committed/Declined are the emphasized
// actions; "Stop pursuing" (the withdrawn status, which requires a reason
// at the application layer) is a secondary, less-prominent action, kept
// out of the primary button row on purpose so this never reads as
// pipeline-management software.
export function OpenAskCard({ ask, followUp, timezone, minCustomDate }: { ask: AskItem; followUp: AskFollowUp | null; timezone: string; minCustomDate: string }) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState("");

  async function transition(next: "committed" | "declined" | "withdrawn", note?: string) {
    if (status === "saving") return;
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch(`/api/asks/${encodeURIComponent(ask.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next, ...(note ? { note } : {}) }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The ask could not be updated.");
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The ask could not be updated.");
    }
  }

  return (
    <article className="open-ask-card">
      <p className="open-ask-eyebrow">Open ask</p>
      {ask.amountCents !== null && <p className="open-ask-amount">{money(ask.amountCents)}</p>}
      {ask.purpose && <p className="open-ask-purpose">{ask.purpose}</p>}
      {ask.amountCents === null && !ask.purpose && <p className="open-ask-purpose">Support requested</p>}
      <p className="open-ask-date">Asked {dateLabel(ask.askedAt)}</p>
      <div className="open-ask-actions">
        <button type="button" disabled={status === "saving"} onClick={() => void transition("committed")}>{status === "saving" ? "Saving…" : "Mark committed"}</button>
        <button type="button" disabled={status === "saving"} onClick={() => void transition("declined")}>Declined</button>
        <button type="button" className="open-ask-more" disabled={status === "saving"} onClick={() => setShowWithdraw((value) => !value)} aria-expanded={showWithdraw} aria-label="More actions">•••</button>
      </div>
      {showWithdraw && (
        <div className="open-ask-withdraw">
          <label>Reason for stopping <span>required</span><textarea value={withdrawReason} onChange={(event) => setWithdrawReason(event.target.value)} maxLength={2000} /></label>
          <div className="open-ask-withdraw-actions">
            <button type="button" onClick={() => setShowWithdraw(false)}>Cancel</button>
            <button type="button" disabled={!withdrawReason.trim() || status === "saving"} onClick={() => void transition("withdrawn", withdrawReason.trim())}>Stop pursuing</button>
          </div>
        </div>
      )}
      <AskFollowUpControl askId={ask.id} followUp={followUp} timezone={timezone} minCustomDate={minCustomDate} />
      {message && <p className="giving-action-error" role="alert">{message}</p>}
    </article>
  );
}

// Whichever of the two applies -- never both, never a duplicate reminder.
// No existing active follow-up: a small "+ Add follow-up" disclosure with
// the same reminder-picker fieldset pattern LogAskForm already uses
// (minus "None", since the entire point of this control is adding one).
// An existing active follow-up: its own due date plus the existing,
// already-built RescheduleButton (POST /api/recommendations/[id]/
// reschedule) -- the smallest coherent way to let a fundraiser correct a
// follow-up date without a second, ask-specific reschedule mechanism.
function AskFollowUpControl({ askId, followUp, timezone, minCustomDate }: { askId: string; followUp: AskFollowUp | null; timezone: string; minCustomDate: string }) {
  const [open, setOpen] = useState(false);
  const [reminder, setReminder] = useState<ReminderChoice>("tomorrow");
  const [customDate, setCustomDate] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");
  const [savedDueAt, setSavedDueAt] = useState<number | null>(followUp?.dueAt ?? null);
  const [savedReminderId, setSavedReminderId] = useState<string | null>(followUp?.id ?? null);

  async function save() {
    if (status === "saving" || (reminder === "custom" && !customDate)) return;
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch(`/api/asks/${encodeURIComponent(askId)}/reminder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reminder, customDate: reminder === "custom" ? customDate : undefined }),
      });
      const result = await response.json() as { error?: string; reminderId?: string; dueAt?: string };
      if (!response.ok) throw new Error(result.error || "The follow-up could not be saved.");
      setStatus("idle");
      setOpen(false);
      if (result.reminderId && result.dueAt) { setSavedReminderId(result.reminderId); setSavedDueAt(Math.floor(new Date(result.dueAt).getTime() / 1000)); }
      else window.location.reload();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The follow-up could not be saved.");
    }
  }

  if (savedReminderId && savedDueAt !== null) {
    return (
      <div className="open-ask-followup">
        <p className="open-ask-followup-date">Follow-up: {dateLabel(savedDueAt)}</p>
        <RescheduleButton recommendationId={savedReminderId} currentDueDate={localDayKey(savedDueAt, timezone)} onOptimisticReschedule={(dueDate) => setSavedDueAt(Math.floor(new Date(`${dueDate}T12:00:00`).getTime() / 1000))} />
      </div>
    );
  }

  return (
    <div className="open-ask-followup">
      <button type="button" className="open-ask-add-followup" onClick={() => setOpen((value) => !value)} aria-expanded={open}>+ Add follow-up</button>
      {open && (
        <div className="open-ask-followup-form">
          <fieldset className="reminder-picker">
            <legend>Follow-up date</legend>
            <div>
              {followUpReminderOptions.map(([value, label]) => (
                <button type="button" key={value} className={reminder === value ? "active" : ""} aria-pressed={reminder === value} onClick={() => setReminder(value)}>{label}</button>
              ))}
            </div>
            {reminder === "custom" && <input aria-label="Custom follow-up date" type="date" min={minCustomDate} value={customDate} onChange={(event) => setCustomDate(event.target.value)} />}
          </fieldset>
          <div className="open-ask-followup-actions">
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" disabled={status === "saving" || (reminder === "custom" && !customDate)} onClick={() => void save()}>{status === "saving" ? "Saving…" : "Save follow-up"}</button>
          </div>
          {message && <p className="giving-action-error" role="alert">{message}</p>}
        </div>
      )}
    </div>
  );
}

// Historical (committed/declined/withdrawn) asks -- collapsed by default,
// same "don't consume space when not actionable" pattern GivingManagement's
// <details>/<summary> already uses.
export function AskHistory({ asks }: { asks: AskItem[] }) {
  if (asks.length === 0) return null;
  return (
    <details className="ask-history">
      <summary>Past asks ({asks.length})</summary>
      <ul>
        {asks.map((ask) => (
          <li key={ask.id}>
            <span className="ask-history-status">{STATUS_LABEL[ask.status]}</span>
            <span>{ask.amountCents !== null ? money(ask.amountCents) : ask.purpose ?? "Support requested"}{ask.amountCents !== null && ask.purpose ? ` — ${ask.purpose}` : ""}</span>
            <span className="ask-history-date">Asked {dateLabel(ask.askedAt)}</span>
            {ask.note && <p className="ask-history-note">{ask.note}</p>}
          </li>
        ))}
      </ul>
    </details>
  );
}

const reminderOptions: Array<[ReminderChoice, string]> = [["none", "None"], ["tomorrow", "Tomorrow"], ["next-week", "Next week"], ["custom", "Custom"]];

// "+ Log ask" -- direct creation, no interaction required. Same collapsible-
// inline-form pattern as GivingManagement.tsx's PendingGiftForm. Status is
// always 'pending' -- no stage selector is ever shown.
export function LogAskForm({ donorId, minCustomDate }: { donorId: string; minCustomDate: string }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [askedAt, setAskedAt] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [note, setNote] = useState("");
  const [reminder, setReminder] = useState<ReminderChoice>("none");
  const [customDate, setCustomDate] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  function parseDollarsToCents(value: string): number | null {
    const cleaned = value.replace(/[^0-9.]/g, "");
    if (!cleaned) return null;
    const dollars = Number.parseFloat(cleaned);
    if (!Number.isFinite(dollars) || dollars <= 0) return null;
    return Math.round(dollars * 100);
  }

  async function save() {
    if (status === "saving" || !askedAt || (reminder === "custom" && !customDate)) return;
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch("/api/asks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId, amountCents: parseDollarsToCents(amount), purpose: purpose.trim(), askedAt: new Date(`${askedAt}T12:00:00`).toISOString(), note: note.trim(), reminder, customDate: reminder === "custom" ? customDate : undefined }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The ask could not be saved.");
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The ask could not be saved.");
    }
  }

  return (
    <div className="log-ask-entry">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>+ Log ask</button>
      {open && (
        <section className="log-ask-form" aria-label="Log an ask">
          <div className="log-ask-fields">
            <label>Amount <span>optional</span><input inputMode="decimal" placeholder="$" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
            <label>Purpose <span>optional</span><input value={purpose} maxLength={200} onChange={(event) => setPurpose(event.target.value)} /></label>
            <label>Date asked<input type="date" value={askedAt} onChange={(event) => setAskedAt(event.target.value)} /></label>
            <label>Note <span>optional</span><textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
          </div>
          <fieldset className="reminder-picker">
            <legend>Follow-up reminder <span>optional</span></legend>
            <div>
              {reminderOptions.map(([value, label]) => (
                <button type="button" key={value} className={reminder === value ? "active" : ""} aria-pressed={reminder === value} onClick={() => setReminder(value)}>{label}</button>
              ))}
            </div>
            {reminder === "custom" && <input aria-label="Custom reminder date" type="date" min={minCustomDate} value={customDate} onChange={(event) => setCustomDate(event.target.value)} />}
          </fieldset>
          <div className="log-ask-actions">
            <button type="button" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" disabled={status === "saving" || (reminder === "custom" && !customDate)} onClick={() => void save()}>{status === "saving" ? "Saving…" : "Save ask"}</button>
          </div>
          {message && <p className="giving-action-error" role="alert">{message}</p>}
        </section>
      )}
    </div>
  );
}
