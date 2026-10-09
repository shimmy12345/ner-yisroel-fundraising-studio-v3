"use client";

import { useState } from "react";
import { validateCustomDurationInput, MIN_COMMITMENT_DURATION_MONTHS, MAX_COMMITMENT_DURATION_MONTHS } from "../../../lib/capture/pledge-payment-plan";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
// timeZone: "UTC" is required here -- these are date-only epochs (UTC
// midnight, the same convention lib/financial-date.ts's parseFinancialDate/
// financialDateLabel use for every other financial date in this app).
// Without it, Intl.DateTimeFormat falls back to the browser's local
// timezone and a UTC-midnight date can display as the PREVIOUS calendar
// day west of UTC -- the exact date-only/timezone bug class already fixed
// once for open-pledge activity dates (see resolveOpenPledgeActivityDate's
// doc comment).
const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(epoch * 1000));
const isoDate = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);

// Offered as convenient one-click choices in the duration selector below
// -- never a restriction on what can be stored. "Custom" covers any other
// verified whole-month length (validated server-side, see lib/capture/
// pledge-payment-plan.ts's validateCommitmentDurationMonths for the
// actual accepted range).
const COMMITMENT_DURATION_PRESETS = [6, 12, 18, 24] as const;

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
  // Pledge Renewal Reminders, Part 1 (2026-10-08, see docs/AI-HANDOFF.md)
  // -- optional, fundraiser-VERIFIED only; null until explicitly entered
  // here, never inferred. commitmentDurationMonths (correction,
  // 2026-10-08) is the length of the donor's COMMITMENT, never the
  // payment-plan's own collection schedule -- also optional,
  // fundraiser-VERIFIED only, never inferred from installment count/
  // frequency or finalExpectedPaymentAt. BOTH are required (together)
  // for renewal-reminder eligibility, but each is independently optional
  // for simply saving the plan. renewalDate is the DERIVED renewal date
  // (lib/relationships/pledge-payment-plan.ts's evaluatePledgeRenewal,
  // computed server-side) -- null whenever EITHER originalPledgeDate or
  // commitmentDurationMonths is null, never recomputed in this
  // component, the same "server derives, card only displays" discipline
  // isOnTrack/isLate/etc. above already follow.
  originalPledgeDate: number | null;
  commitmentDurationMonths: number | null;
  renewalDate: number | null;
  // Mark Renewal Addressed (2026-10-09, see docs/AI-HANDOFF.md) -- both
  // server-derived from evaluatePledgeRenewal/the plan's own stored
  // renewal_acknowledged_at, never recomputed here. isRenewalFollowUpNeeded
  // is what actually gates the button below (it is already false once
  // acknowledged, ended, or simply not yet due); renewalAcknowledgedAt
  // is kept only to show a quiet confirmation once set.
  isRenewalFollowUpNeeded: boolean;
  renewalAcknowledgedAt: number | null;
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
  initial?: { installmentAmountCents: number | null; nextExpectedPaymentAt: number; finalExpectedPaymentAt: number; note: string | null; originalPledgeDate: number | null; commitmentDurationMonths: number | null; planId: string };
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [installment, setInstallment] = useState(initial?.installmentAmountCents ? String(initial.installmentAmountCents / 100) : "");
  const [nextExpected, setNextExpected] = useState(initial ? isoDate(initial.nextExpectedPaymentAt) : "");
  const [finalExpected, setFinalExpected] = useState(initial ? isoDate(initial.finalExpectedPaymentAt) : "");
  const [note, setNote] = useState(initial?.note ?? "");
  // Pledge Renewal Reminders, Part 1 (2026-10-08, see docs/AI-HANDOFF.md)
  // -- blank when absent (shows "not yet verified," never a guessed
  // date), same blank-means-unset convention installment/note already
  // use above. The fundraiser can clear a previously-entered date by
  // emptying this field -- an empty string is sent through as `null`
  // (see save() below), not omitted, so clearing genuinely clears it.
  const [originalPledgeDate, setOriginalPledgeDate] = useState(initial?.originalPledgeDate ? isoDate(initial.originalPledgeDate) : "");
  // Commitment-duration correction (2026-10-08, see docs/AI-HANDOFF.md).
  // `durationChoice` is "" (not set), a preset's own string value, or
  // "custom"; `customDuration` only matters while durationChoice ===
  // "custom". An initial value that isn't one of the presets (any
  // fundraiser-verified custom length, including one entered as
  // "custom" previously) opens directly into the custom text input
  // rather than silently snapping to the nearest preset -- the stored
  // value must never be reinterpreted.
  const initialDurationIsPreset = initial?.commitmentDurationMonths != null && (COMMITMENT_DURATION_PRESETS as readonly number[]).includes(initial.commitmentDurationMonths);
  const [durationChoice, setDurationChoice] = useState<string>(
    initial?.commitmentDurationMonths == null ? "" : initialDurationIsPreset ? String(initial.commitmentDurationMonths) : "custom",
  );
  const [customDuration, setCustomDuration] = useState<string>(
    initial?.commitmentDurationMonths != null && !initialDurationIsPreset ? String(initial.commitmentDurationMonths) : "",
  );
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  // Recomputed fresh on every render from customDuration -- never a
  // second, driftable piece of state to keep in sync. Only meaningful
  // while durationChoice === "custom"; the presets and "Not set" never
  // go through this check at all; (requirement: "Preset selections
  // remain functional").
  const customDurationValidation = durationChoice === "custom" ? validateCustomDurationInput(customDuration) : null;
  const isCustomDurationInvalid = customDurationValidation !== null && !customDurationValidation.ok;

  function resolvedCommitmentDurationMonths(): number | null {
    if (durationChoice === "") return null;
    if (durationChoice === "custom") {
      // Never falls back to a truncated/partial parse -- an invalid
      // custom value resolves to null here ONLY as a defensive fallback;
      // save() itself refuses to submit at all while isCustomDurationInvalid,
      // so this path is never actually reached with bad input in practice.
      return customDurationValidation?.ok ? customDurationValidation.months : null;
    }
    return Number.parseInt(durationChoice, 10);
  }

  async function save() {
    if (status === "saving" || !nextExpected || !finalExpected || isCustomDurationInvalid) return;
    setStatus("saving"); setMessage("");
    try {
      const body = { installmentAmountCents: parseDollarsToCents(installment), nextExpectedPaymentAt: nextExpected, finalExpectedPaymentAt: finalExpected, note: note.trim(), originalPledgeDate: originalPledgeDate || null, commitmentDurationMonths: resolvedCommitmentDurationMonths() };
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
        <label>Original pledge date <span>optional, verified only</span><input type="date" max={isoDate(Math.floor(Date.now() / 1000))} value={originalPledgeDate} onChange={(event) => setOriginalPledgeDate(event.target.value)} /></label>
        <label>Commitment duration <span>optional, verified only</span>
          <select value={durationChoice} onChange={(event) => setDurationChoice(event.target.value)}>
            <option value="">Not set</option>
            {COMMITMENT_DURATION_PRESETS.map((months) => <option key={months} value={String(months)}>{months} months</option>)}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {durationChoice === "custom" && <label>Custom duration (months) <span>whole number, {MIN_COMMITMENT_DURATION_MONTHS}-{MAX_COMMITMENT_DURATION_MONTHS}</span><input type="text" inputMode="numeric" pattern="[0-9]*" aria-invalid={isCustomDurationInvalid} value={customDuration} onChange={(event) => setCustomDuration(event.target.value)} /></label>}
        <label>Note <span>optional</span><textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label>
      </div>
      {isCustomDurationInvalid && customDurationValidation && !customDurationValidation.ok && <p className="giving-action-error" role="alert">{customDurationValidation.reason}</p>}
      <p className="payment-plan-help">Only set the original pledge date and commitment duration if you've confirmed them -- neither is ever guessed (not from JL's own "Due Date," not from the installment count or collection schedule, which can run longer or shorter than the actual commitment). Leave either blank if you're not sure. A renewal reminder requires BOTH to be set -- 5 days before, and on, the renewal date (original pledge date + commitment duration).</p>
      <div className="payment-plan-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" disabled={status === "saving" || !nextExpected || !finalExpected || isCustomDurationInvalid} onClick={() => void save()}>{status === "saving" ? "Saving…" : "Save payment plan"}</button>
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
  // Mark Renewal Addressed (2026-10-09, see docs/AI-HANDOFF.md) -- its
  // own independent saving/error state, deliberately separate from
  // endStatus/endMessage above: acknowledging a renewal and ending a
  // plan are two different actions a fundraiser can take from the same
  // card, never combined into one request.
  const [acknowledgeStatus, setAcknowledgeStatus] = useState<"idle" | "saving" | "error">("idle");
  const [acknowledgeMessage, setAcknowledgeMessage] = useState("");

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

  // Mark Renewal Addressed -- records that the fundraiser has handled
  // this plan's standing renewal follow-up. Never means the donor
  // renewed/paid/made a new commitment; never touches endedAt, the
  // payment plan's own schedule, originalPledgeDate, commitmentDurationMonths,
  // or any financial record -- see the API route for the actual write.
  async function acknowledgeRenewal() {
    if (!plan || acknowledgeStatus === "saving") return;
    setAcknowledgeStatus("saving"); setAcknowledgeMessage("");
    try {
      const response = await fetch(`/api/pledge-payment-plans/${encodeURIComponent(plan.planId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ acknowledgeRenewal: true }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The renewal follow-up could not be acknowledged.");
      refresh();
    } catch (error) {
      setAcknowledgeStatus("error");
      setAcknowledgeMessage(error instanceof Error ? error.message : "The renewal follow-up could not be acknowledged.");
    }
  }

  if (mode === "create") {
    return <PlanForm pledgeActivityId={pledgeActivityId} onCancel={() => setMode("view")} onSaved={refresh} />;
  }
  if (mode === "edit" && plan) {
    return <PlanForm pledgeActivityId={pledgeActivityId} initial={{ installmentAmountCents: plan.installmentAmountCents, nextExpectedPaymentAt: plan.nextExpectedPaymentAt ?? plan.finalExpectedPaymentAt, finalExpectedPaymentAt: plan.finalExpectedPaymentAt, note: plan.note, originalPledgeDate: plan.originalPledgeDate, commitmentDurationMonths: plan.commitmentDurationMonths, planId: plan.planId }} onCancel={() => setMode("view")} onSaved={refresh} />;
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
      {/* Pledge Renewal Reminders, Part 1 (2026-10-08, see docs/AI-HANDOFF.md;
          commitment-duration correction 2026-10-08) -- each shown once
          verified, independently (a plan can have one verified without
          the other); renewalDate is server-derived
          (evaluatePledgeRenewal), never recomputed here, and only ever
          non-null once BOTH fields are verified. */}
      {(plan.originalPledgeDate !== null || plan.commitmentDurationMonths !== null) && <p className="payment-plan-original-pledge-date">
        {plan.originalPledgeDate !== null && <>Original pledge date: {dateLabel(plan.originalPledgeDate)}</>}
        {plan.originalPledgeDate !== null && plan.commitmentDurationMonths !== null && " · "}
        {plan.commitmentDurationMonths !== null && <>Commitment: {plan.commitmentDurationMonths} months</>}
        {plan.renewalDate !== null && <> · Renewal date: {dateLabel(plan.renewalDate)}</>}
      </p>}
      {plan.isCompleted && <p className="payment-plan-note-inline">This plan appears complete — paid in full.</p>}
      {plan.isPlanEndedWithBalance && <p className="payment-plan-note-inline">The final expected date has passed with balance still open.</p>}
      {/* Mark Renewal Addressed (2026-10-09, see docs/AI-HANDOFF.md) --
          shown ONLY while this plan currently has a standing renewal
          follow-up (requirement: display the button only when an
          active plan has a standing renewal follow-up). Acknowledging
          means "I've addressed this," never "the donor renewed" -- the
          confirmation copy says so explicitly so it is never mistaken
          for a renewal/new-commitment record. */}
      {plan.isRenewalFollowUpNeeded && <p className="payment-plan-note-inline">Renewal follow-up needed.</p>}
      {!plan.isRenewalFollowUpNeeded && plan.renewalAcknowledgedAt !== null && <p className="payment-plan-note-inline">Renewal follow-up addressed {dateLabel(plan.renewalAcknowledgedAt)} — this does not mean the donor has renewed or made a new commitment.</p>}
      <div className="payment-plan-actions">
        <button type="button" onClick={() => setMode("edit")}>Edit plan</button>
        <button type="button" className="payment-plan-end" disabled={endStatus === "saving"} onClick={() => void endPlan()}>{endStatus === "saving" ? "Ending…" : "End plan"}</button>
        {plan.isRenewalFollowUpNeeded && <button type="button" className="payment-plan-acknowledge-renewal" disabled={acknowledgeStatus === "saving"} onClick={() => void acknowledgeRenewal()}>{acknowledgeStatus === "saving" ? "Saving…" : "Mark renewal addressed"}</button>}
      </div>
      {acknowledgeMessage && <p className="giving-action-error" role="alert">{acknowledgeMessage}</p>}
      {endMessage && <p className="giving-action-error" role="alert">{endMessage}</p>}
    </div>
  );
}
