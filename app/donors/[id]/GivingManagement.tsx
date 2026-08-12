"use client";

import { useState } from "react";
import { DonorAutocomplete } from "../../capture/DonorAutocomplete";
import type { DonorSearchRecord } from "../../../lib/relationships/donor-search";
import { GIFT_ACKNOWLEDGMENT_ACTION_LABELS, GIFT_ACKNOWLEDGMENT_LABELS, GIFT_ACKNOWLEDGMENT_STATUSES, type GiftAcknowledgmentStatus, type GiftSource } from "../../../lib/giving/acknowledgment";

type Activity = { id: string; donorId: string; externalSource: string; workspaceStatus: string; privateNote: string | null; updatedAt: number };

// Lightweight "Mark thank-you sent" control -- deliberately never touches
// interactions, recommendations, or relationship_summary/institutional_memory.
// It only ever writes a new gift_acknowledgments row (never an UPDATE), so
// a later status change never erases the record of what was marked
// before. Reused wherever a paid gift is shown: the giving timeline, the
// donor page's Suggested Action card, and the homepage/Today queue.
export function GiftAcknowledgmentActions({ giftSource, giftId, initialStatus, compact }: { giftSource: GiftSource; giftId: string; initialStatus: GiftAcknowledgmentStatus | null; compact?: boolean }) {
  const [status, setStatus] = useState<GiftAcknowledgmentStatus | null>(initialStatus);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState<GiftAcknowledgmentStatus | null>(null);
  const [error, setError] = useState("");

  async function mark(next: GiftAcknowledgmentStatus) {
    if (saving) return;
    setSaving(next); setError("");
    try {
      const response = await fetch("/api/giving/acknowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ giftSource, giftId, status: next }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The acknowledgment could not be saved.");
      setStatus(next);
      setEditing(false);
      window.setTimeout(() => window.location.reload(), 350);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The acknowledgment could not be saved.");
    } finally {
      setSaving(null);
    }
  }

  if (status && !editing) {
    return <div className="gift-acknowledgment gift-acknowledgment-set"><span className="gift-acknowledgment-status">{GIFT_ACKNOWLEDGMENT_LABELS[status]}</span><button type="button" className="gift-acknowledgment-change" onClick={() => setEditing(true)}>Change</button></div>;
  }
  return <div className={`gift-acknowledgment ${compact ? "gift-acknowledgment-compact" : ""}`}>
    {GIFT_ACKNOWLEDGMENT_STATUSES.map((option) => <button key={option} type="button" disabled={saving !== null} onClick={() => void mark(option)}>{saving === option ? "Saving…" : GIFT_ACKNOWLEDGMENT_ACTION_LABELS[option]}</button>)}
    {status && editing && <button type="button" onClick={() => setEditing(false)}>Cancel</button>}
    {error && <p className="giving-action-error" role="alert">{error}</p>}
  </div>;
}

export function GivingRecordActions({ activity, donors }: { activity: Activity; donors: DonorSearchRecord[] }) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");
  const [note, setNote] = useState(activity.privateNote ?? "");
  const [donorId, setDonorId] = useState(activity.donorId);

  async function update(action: string, extra: Record<string, unknown> = {}) {
    if (status === "saving") return;
    if (["hide", "duplicate", "invalid", "move"].includes(action) && !window.confirm(action === "move" ? "Move this giving record and its linked pledge-payment events to the selected donor?" : "Apply this reversible status? The record will remain in history but leave workspace totals.")) return;
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch(`/api/giving/${encodeURIComponent(activity.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, expectedUpdatedAt: activity.updatedAt, ...extra }) });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "The giving record could not be updated.");
      setMessage(result.message ?? "Giving record updated.");
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "The giving record could not be updated."); }
  }

  const excluded = activity.workspaceStatus !== "active";
  return <div className="giving-record-management">
    <div className="giving-record-state"><span className={`giving-status ${activity.workspaceStatus}`}>{activity.workspaceStatus === "active" ? activity.externalSource === "Fundraising OS" ? "Unconfirmed pending gift" : "Included in totals" : activity.workspaceStatus.replace("_", " ")}</span>{activity.externalSource === "JL Solutions" && <small>JL date and amounts are read-only</small>}</div>
    {activity.privateNote && <p className="private-gift-note"><strong>Private note</strong>{activity.privateNote}</p>}
    <details><summary>Manage record</summary><div className="giving-action-grid">
      {excluded ? <button type="button" disabled={status === "saving" || activity.workspaceStatus === "merged"} onClick={() => void update("restore")}>{activity.workspaceStatus === "merged" ? "Confirmed by JL import" : "Restore to workspace"}</button> : <>
        <button type="button" disabled={status === "saving"} onClick={() => void update("hide")}>Hide from workspace</button>
        <button type="button" disabled={status === "saving"} onClick={() => void update("duplicate")}>Mark duplicate</button>
        <button type="button" disabled={status === "saving"} onClick={() => void update("needs_review")}>Mark needs review</button>
        <button type="button" disabled={status === "saving"} onClick={() => void update("invalid")}>Mark invalid</button>
      </>}
      <label><span>Private note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} /><button type="button" disabled={status === "saving"} onClick={() => void update("note", { note })}>Save private note</button></label>
      <div><DonorAutocomplete donors={donors} selectedId={donorId} onSelect={setDonorId} inputId={`giving-donor-${activity.id}`} label="Correct donor match" /><button type="button" disabled={status === "saving" || !donorId || donorId === activity.donorId} onClick={() => void update("move", { donorId })}>Move to selected donor</button></div>
    </div></details>
    {message && <p className={status === "error" ? "giving-action-error" : "giving-action-message"} role="status">{message}</p>}
  </div>;
}

export function PendingGiftForm({ donors, initialDonorId }: { donors: DonorSearchRecord[]; initialDonorId: string }) {
  const [open, setOpen] = useState(false);
  const [donorId, setDonorId] = useState(initialDonorId);
  const [date, setDate] = useState(() => {
    const today = new Date();
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  });
  const [amount, setAmount] = useState("");
  const [designation, setDesignation] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  async function save() {
    if (!donorId || !date || Number(amount) <= 0 || status === "saving") return;
    setStatus("saving"); setMessage("");
    try {
      const response = await fetch("/api/giving/pending", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ donorId, date, amount, designation, note }) });
      const result = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error || "The pending gift could not be recorded.");
      setMessage(result.message ?? "Pending gift recorded.");
      window.setTimeout(() => window.location.reload(), 450);
    } catch (error) { setStatus("error"); setMessage(error instanceof Error ? error.message : "The pending gift could not be recorded."); }
  }

  return <div className="pending-gift-entry"><button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>Record Pending Gift</button>{open && <section className="pending-gift-form" aria-label="Record pending gift"><p>Save an unconfirmed gift without changing confirmed giving totals.</p><DonorAutocomplete donors={donors} selectedId={donorId} onSelect={setDonorId} inputId="pending-gift-donor" label="Donor" /><div className="pending-gift-fields"><label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>Amount<input type="number" min="0.01" max="100000000" step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /></label><label>Designation <span>optional</span><input value={designation} maxLength={160} onChange={(event) => setDesignation(event.target.value)} /></label><label>Private note <span>optional</span><textarea value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} /></label></div><div className="pending-gift-actions"><button type="button" onClick={() => setOpen(false)}>Cancel</button><button type="button" disabled={!donorId || !date || Number(amount) <= 0 || status === "saving"} onClick={() => void save()}>{status === "saving" ? "Saving…" : "Save as unconfirmed"}</button></div>{message && <p className={status === "error" ? "giving-action-error" : "giving-action-message"} role="status">{message}</p>}</section>}</div>;
}
