"use client";

import { useState } from "react";

// Manual Pledge Balance Corrections (see docs/AI-HANDOFF.md) -- a
// controlled, auditable exception for the rare case where the real
// JL error has already been corrected but the correction never
// reached the spreadsheet FOS imports from (the real Shlomo Kutoff /
// DIN2023 case). Never a new payment, never a replacement for the JL
// import process -- this control only ever writes to
// pledge_balance_corrections (migration 0042), never giving_activities/
// gifts/jl_payment_assignment_audits.

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(epoch * 1000));

export type PledgeBalanceCorrectionHistoryEntry = {
  id: string;
  importedBalanceCentsAtCorrection: number;
  correctedBalanceCents: number;
  reason: string;
  createdAt: number;
  reversedAt: number | null;
  reversalReason: string | null;
};

// Server-derived only -- importedBalanceCents/effectiveBalanceCents are
// never recomputed here (same "server derives, card only displays"
// discipline every other payment-plan field on this page already
// follows); effectiveBalanceCents is literally the SAME value already
// shown as this pledge's own balance elsewhere on the page (the server
// query already applies lib/relationships/pledge-balance-correction.ts's
// effectiveBalanceCents rule), so this control can never disagree with
// the rest of the page about the same pledge.
export type PledgeBalanceCorrectionState = {
  pledgeActivityId: string;
  importedBalanceCents: number;
  effectiveBalanceCents: number;
  active: { id: string; correctedBalanceCents: number; reason: string; createdAt: number } | null;
  history: PledgeBalanceCorrectionHistoryEntry[];
};

function parseDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export function PledgeBalanceCorrectionControl({ donorName, donorCode, campaign, originalPledgeCents, state }: {
  donorName: string;
  donorCode: string | null;
  campaign: string | null;
  originalPledgeCents: number;
  state: PledgeBalanceCorrectionState;
}) {
  const [mode, setMode] = useState<"view" | "form" | "history">("view");
  const [correctedInput, setCorrectedInput] = useState(state.active ? String(state.active.correctedBalanceCents / 100) : "");
  const [reason, setReason] = useState(state.active?.reason ?? "");
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const [reverseStatus, setReverseStatus] = useState<"idle" | "saving" | "error">("idle");

  function refresh() {
    window.setTimeout(() => window.location.reload(), 350);
  }

  const correctedCents = parseDollarsToCents(correctedInput);

  // Requirement: require confirmation before applying the correction --
  // the first click only reveals the confirmation copy; a second,
  // explicit click actually submits. Any further edit to the amount or
  // reason resets confirmation, so a stale confirmation can never apply
  // to a value the fundraiser hasn't re-reviewed.
  async function save() {
    if (correctedCents === null || !reason.trim() || status === "saving") return;
    if (!confirming) { setConfirming(true); return; }
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch("/api/pledge-balance-corrections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pledgeActivityId: state.pledgeActivityId, correctedBalanceCents: correctedCents, reason }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The balance correction could not be saved.");
      setStatus("saved");
      refresh();
    } catch (error) {
      setStatus("error"); setConfirming(false);
      setMessage(error instanceof Error ? error.message : "The balance correction could not be saved.");
    }
  }

  async function remove() {
    if (!state.active || reverseStatus === "saving") return;
    setReverseStatus("saving"); setMessage("");
    try {
      const response = await fetch(`/api/pledge-balance-corrections/${encodeURIComponent(state.active.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reverse: true }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The correction could not be removed.");
      refresh();
    } catch (error) {
      setReverseStatus("error");
      setMessage(error instanceof Error ? error.message : "The correction could not be removed.");
    }
  }

  if (mode === "form") {
    return (
      <section className="balance-correction-form" aria-label="Correct balance">
        <p className="balance-correction-identity">{donorName}{donorCode && <> · {donorCode}</>}{campaign && <> · {campaign}</>}</p>
        <p>Original pledge amount: {money(originalPledgeCents)}</p>
        <p>Current imported outstanding balance: {money(state.importedBalanceCents)}</p>
        <p>Current effective outstanding balance: {money(state.effectiveBalanceCents)}</p>
        <label>Corrected outstanding balance <span>required</span>
          <input inputMode="decimal" placeholder="$" value={correctedInput} onChange={(event) => { setCorrectedInput(event.target.value); setConfirming(false); }} />
        </label>
        <label>Reason <span>required</span>
          <textarea value={reason} maxLength={2000} onChange={(event) => { setReason(event.target.value); setConfirming(false); }} placeholder="Explain why FOS's outstanding balance differs from the amount actually owed (e.g. a JL correction that never reached this spreadsheet)." />
        </label>
        {confirming && correctedCents !== null && <p className="balance-correction-confirm-copy">This changes the EFFECTIVE outstanding balance shown in FOS to {money(correctedCents)}. The real imported balance, giving totals, donation history, and payment records are never changed. Click Save again to confirm.</p>}
        <div className="payment-plan-actions">
          <button type="button" onClick={() => { setMode("view"); setConfirming(false); setMessage(""); }}>Cancel</button>
          <button type="button" disabled={status === "saving" || correctedCents === null || !reason.trim()} onClick={() => void save()}>{status === "saving" ? "Saving…" : confirming ? "Confirm correction" : "Save"}</button>
        </div>
        {status === "saved" && <p className="balance-correction-saved">Balance corrected</p>}
        {message && <p className="giving-action-error" role="alert">{message}</p>}
      </section>
    );
  }

  if (mode === "history") {
    return (
      <section className="balance-correction-history" aria-label="Balance correction history">
        <p className="payment-plan-eyebrow">Correction history</p>
        {state.history.length === 0 && <p>No corrections recorded.</p>}
        {state.history.map((entry) => (
          <article key={entry.id} className="balance-correction-history-row">
            <p>{dateLabel(entry.createdAt)} — {money(entry.importedBalanceCentsAtCorrection)} → {money(entry.correctedBalanceCents)}{entry.reversedAt !== null && <> (removed {dateLabel(entry.reversedAt)})</>}</p>
            <p className="balance-correction-reason">{entry.reason}</p>
            {entry.reversalReason && <p className="balance-correction-reason">Removal note: {entry.reversalReason}</p>}
          </article>
        ))}
        <button type="button" onClick={() => setMode("view")}>Close</button>
      </section>
    );
  }

  return (
    <div className="balance-correction-control">
      {state.active && <p className="balance-correction-badge">Manually corrected</p>}
      <div className="payment-plan-actions">
        <button type="button" onClick={() => { setMode("form"); setMessage(""); setStatus("idle"); }}>{state.active ? "Edit correction" : "Correct Balance"}</button>
        {state.history.length > 0 && <button type="button" onClick={() => setMode("history")}>View history</button>}
        {state.active && <button type="button" className="payment-plan-end" disabled={reverseStatus === "saving"} onClick={() => void remove()}>{reverseStatus === "saving" ? "Removing…" : "Remove correction"}</button>}
      </div>
      {message && <p className="giving-action-error" role="alert">{message}</p>}
    </div>
  );
}
