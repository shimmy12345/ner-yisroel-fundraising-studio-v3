"use client";

import { useState } from "react";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
const isoDate = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);

export type PledgePlanState = {
  planId: string;
  installmentAmountCents: number | null;
  // The DERIVED next-unsatisfied-cycle date (never the raw, possibly-
  // stale stored anchor) -- so this always reads correctly without a
  // background job ever having to rewrite anything. See
  // lib/relationships/pledge-payment-plan.ts.
  nextExpectedPaymentAt: number | null;
  finalExpectedPaymentAt: number;
  note: string | null;
  isOnTrack: boolean;
  isLate: boolean;
  isPlanEndedWithBalance: boolean;
  isCompleted: boolean;
};

function parseDollarsToCents(value: string): number | null {
  const cleaned = value.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const dollars = Number.parseFloat(cleaned);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

// The inline creation/edit form, shared by "Set payment plan" and
// "Edit plan" -- same collapsible-inline-form pattern as
// AskManagement.tsx's LogAskForm. Cadence is a fixed "Monthly" label,
// never a picker (v1 is monthly-only); expected_day_of_month is never
// exposed here at all -- it's derived server-side from whatever date the
// fundraiser enters.
function PlanForm({ pledgeActivityId, initial, onCancel, onSaved }: {
  pledgeActivityId: string;
  initial?: { installmentAmountCents: number | null; nextExpectedPaymentAt: number; finalExpectedPaymentAt: number; note: string | null; planId: string };
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [installment, setInstallment] = useState(initial?.installmentAmountCents ? String(initial.installmentAmountCents / 100) : "");
  const [nextExpected, setNextExpected] = useState(initial ? isoDate(initial.nextExpectedPaymentAt) : "");
  const [finalExpected, setFinalExpected] = useState(initial ? isoDate(initial.finalExpectedPaymentAt) : "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  async function save() {
    if (status === "saving" || !nextExpected || !finalExpected) return;
    setStatus("saving"); setMessage("");
    try {
      const body = { installmentAmountCents: parseDollarsToCents(installment), nextExpectedPaymentAt: nextExpected, finalExpectedPaymentAt: finalExpected, note: note.trim() };
      const response = initial
        ? await fetch(`/api/pledge-payment-plans/${encodeURIComponent(initial.planId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        : await fetch("/api/pledge-payment-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pledgeActivityId, ...body }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The payment plan could not be saved.");
      onSaved();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The payment plan could not be saved.");
    }
  }

  return (
    <section className="payment-plan-form" aria-label={initial ? "Edit payment plan" : "Set payment plan"}>
      <div className="payment-plan-fields">
        <label>Cadence<input value="Monthly" disabled /></label>
        <label>Installment amount <span>optional</span><input inputMode="decimal" placeholder="$" value={installment} onChange={(event) => setInstallment(event.target.value)} /></label>
        <label>Next expected payment<input type="date" value={nextExpected} onChange={(event) => setNextExpected(event.target.value)} /></label>
        <label>Final expected payment<input type="date" value={finalExpected} onChange={(event) => setFinalExpected(event.target.value)} /></label>
        <label>Note <span>optional</span><textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
      </div>
      <div className="payment-plan-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" disabled={status === "saving" || !nextExpected || !finalExpected} onClick={() => void save()}>{status === "saving" ? "Saving…" : "Save payment plan"}</button>
      </div>
      {message && <p className="giving-action-error" role="alert">{message}</p>}
    </section>
  );
}

// The open-pledge payment-plan card -- compact factual context, never a
// pledge-management screen. Attaches to ONE specific open pledge (never
// donor-wide -- a donor with two open pledges gets two independent
// cards). isOnTrack/isLate/isPlanEndedWithBalance/isCompleted are all
// passed in already-derived from the server's own recommendation
// evidence (buildRecommendationEvidence) -- never recomputed here, so
// this card can never disagree with Suggested Action about the same
// plan's state.
export function OpenPledgePlanCard({ pledgeActivityId, plan }: { pledgeActivityId: string; plan: PledgePlanState | null }) {
  const [mode, setMode] = useState<"view" | "create" | "edit">("view");
  const [endStatus, setEndStatus] = useState<"idle" | "saving" | "error">("idle");
  const [endMessage, setEndMessage] = useState("");

  function refresh() {
    window.setTimeout(() => window.location.reload(), 350);
  }

  async function endPlan() {
    if (!plan || endStatus === "saving") return;
    setEndStatus("saving"); setEndMessage("");
    try {
      const response = await fetch(`/api/pledge-payment-plans/${encodeURIComponent(plan.planId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ ended: true }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The payment plan could not be ended.");
      refresh();
    } catch (error) {
      setEndStatus("error");
      setEndMessage(error instanceof Error ? error.message : "The payment plan could not be ended.");
    }
  }

  if (mode === "create") {
    return <PlanForm pledgeActivityId={pledgeActivityId} onCancel={() => setMode("view")} onSaved={refresh} />;
  }
  if (mode === "edit" && plan) {
    return <PlanForm pledgeActivityId={pledgeActivityId} initial={{ installmentAmountCents: plan.installmentAmountCents, nextExpectedPaymentAt: plan.nextExpectedPaymentAt ?? plan.finalExpectedPaymentAt, finalExpectedPaymentAt: plan.finalExpectedPaymentAt, note: plan.note, planId: plan.planId }} onCancel={() => setMode("view")} onSaved={refresh} />;
  }

  if (!plan) {
    return <button type="button" className="payment-plan-set-button" onClick={() => setMode("create")}>Set payment plan</button>;
  }

  return (
    <div className="payment-plan-card">
      <p className="payment-plan-eyebrow">Payment plan</p>
      <p className="payment-plan-cadence">Monthly{plan.isLate ? <span className="payment-plan-overdue"> · Expected payment overdue</span> : null}</p>
      {plan.nextExpectedPaymentAt !== null && !plan.isCompleted && <p>Next expected: {dateLabel(plan.nextExpectedPaymentAt)}</p>}
      <p>Final expected: {dateLabel(plan.finalExpectedPaymentAt)}</p>
      {plan.installmentAmountCents !== null && <p className="payment-plan-installment">Expected installment: {money(plan.installmentAmountCents)}</p>}
      {plan.isCompleted && <p className="payment-plan-note-inline">This plan appears complete — paid in full.</p>}
      {plan.isPlanEndedWithBalance && <p className="payment-plan-note-inline">The final expected date has passed with balance still open.</p>}
      <div className="payment-plan-actions">
        <button type="button" onClick={() => setMode("edit")}>Edit plan</button>
        <button type="button" className="payment-plan-end" disabled={endStatus === "saving"} onClick={() => void endPlan()}>{endStatus === "saving" ? "Ending…" : "End plan"}</button>
      </div>
      {endMessage && <p className="giving-action-error" role="alert">{endMessage}</p>}
    </div>
  );
}
