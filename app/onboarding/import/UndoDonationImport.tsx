"use client";

import { useState } from "react";

type Preview = {
  safe: boolean;
  blockers: string[];
  totals: { newGiftsRemoved: number; pledgeUpdatesRestored: number; balancesRestored: number; statusesRestored: number };
  newGifts: Array<{ sourceFingerprint: string; donorName: string; activityDate: number; amountCents: number; description: string | null }>;
  pledgeUpdates: Array<{ sourceFingerprint: string; donorName: string; activityDate: number; description: string | null; currentPaidCents: number | null; restoredPaidCents: number | null; currentBalanceCents: number | null; restoredBalanceCents: number | null; currentStatus: string | null; restoredStatus: string | null }>;
};

function money(cents: number | null) {
  return cents === null ? "Not recorded" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function date(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(timestamp * 1000));
}

export function UndoDonationImport({ importId }: { importId: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [backupId, setBackupId] = useState("");
  const [confirmation, setConfirmation] = useState("");

  async function inspect() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/import/rollback?importId=${encodeURIComponent(importId)}`);
      const data = await response.json() as Preview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to prepare the rollback preview.");
      setPreview(data);
      setOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare the rollback preview.");
    } finally {
      setLoading(false);
    }
  }

  async function undo() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/import/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importId, backupConfirmed, backupId, confirmation }),
      });
      const data = await response.json() as { error?: string; blockers?: string[] };
      if (!response.ok) throw new Error([data.error, ...(data.blockers ?? [])].filter(Boolean).join(" "));
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reverse this import.");
      setLoading(false);
    }
  }

  async function downloadBackup() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/import/backup?purpose=donation_rollback&importId=${encodeURIComponent(importId)}`);
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "The backup could not be created.");
      }
      const receipt = response.headers.get("x-workspace-backup-id");
      if (!receipt) throw new Error("The backup was created without a verification receipt.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `fundraising-os-backup-${new Date().toISOString().replaceAll(":", "-")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setBackupId(receipt);
      setBackupConfirmed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The backup could not be created.");
    } finally {
      setLoading(false);
    }
  }

  if (!open) return <div className="import-undo-action"><button type="button" disabled={loading} onClick={inspect}>{loading ? "Preparing preview…" : "Undo"}</button>{error && <p role="alert">{error}</p>}</div>;

  return (
    <section className="import-undo-preview" aria-labelledby={`undo-${importId}`}>
      <div className="import-section-heading"><div><p className="eyebrow">ROLLBACK PREVIEW</p><h3 id={`undo-${importId}`}>Review exactly what will change</h3></div><button type="button" onClick={() => setOpen(false)}>Close</button></div>
      <dl className="import-undo-counts">
        <div><dt>New gifts removed</dt><dd>{preview?.totals.newGiftsRemoved ?? 0}</dd></div>
        <div><dt>Pledge updates restored</dt><dd>{preview?.totals.pledgeUpdatesRestored ?? 0}</dd></div>
        <div><dt>Balances restored</dt><dd>{preview?.totals.balancesRestored ?? 0}</dd></div>
        <div><dt>Statuses restored</dt><dd>{preview?.totals.statusesRestored ?? 0}</dd></div>
      </dl>
      {!!preview?.newGifts.length && <div><h4>New gifts that will be removed</h4><ul>{preview.newGifts.map((gift) => <li key={gift.sourceFingerprint}><strong>{gift.donorName}</strong> · {date(gift.activityDate)} · {money(gift.amountCents)}{gift.description ? ` · ${gift.description}` : ""}</li>)}</ul></div>}
      {!!preview?.pledgeUpdates.length && <div><h4>Pledge values that will be restored</h4><ul>{preview.pledgeUpdates.map((pledge) => <li key={pledge.sourceFingerprint}><strong>{pledge.donorName}</strong> · {date(pledge.activityDate)}{pledge.description ? ` · ${pledge.description}` : ""}<br /><span>Paid {money(pledge.currentPaidCents)} → {money(pledge.restoredPaidCents)}; balance {money(pledge.currentBalanceCents)} → {money(pledge.restoredBalanceCents)}; status {pledge.currentStatus ?? "Not recorded"} → {pledge.restoredStatus ?? "Not recorded"}</span></li>)}</ul></div>}
      {!preview?.safe && <div className="onboarding-error" role="alert"><strong>This import cannot be safely reversed.</strong><ul>{preview?.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      {preview?.safe && <div className="import-undo-confirmation">
        <p><strong>First, back up the current D1 workspace.</strong> The backup contains your owner-scoped donor workspace and should be stored securely.</p>
        <button type="button" onClick={downloadBackup} disabled={loading}>{backupConfirmed ? "Backup downloaded ✓" : loading ? "Creating backup…" : "Download D1 backup"}</button>
        <label><input type="checkbox" checked={backupConfirmed} disabled={!backupId} onChange={(event) => setBackupConfirmed(event.target.checked)} /> I downloaded and safely stored the backup.</label>
        <label>Type <strong>UNDO</strong> to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
        <p>Only batch <code>{importId}</code> will be reversed. Older imports and relationship workspace records are preserved. This undo cannot itself be undone.</p>
        <button type="button" className="danger" disabled={loading || !backupConfirmed || confirmation !== "UNDO"} onClick={undo}>{loading ? "Reversing import…" : "Confirm and undo import"}</button>
      </div>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
    </section>
  );
}
