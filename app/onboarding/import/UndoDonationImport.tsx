"use client";

import { useState } from "react";
import { financialDateLabel } from "../../../lib/financial-date";

type Preview = {
  safe: boolean;
  blockers: string[];
  totals: { newGiftsRemoved?: number; pledgeUpdatesRestored?: number; balancesRestored?: number; statusesRestored?: number; householdsRemoved?: number; householdsRecreated?: number; householdsRestored?: number; laterEditsPreserved?: number; batchRecordsRemoved?: number };
  newGifts?: Array<{ sourceFingerprint: string; donorName: string; activityDate: number; amountCents: number; description: string | null }>;
  pledgeUpdates?: Array<{ sourceFingerprint: string; donorName: string; activityDate: number; description: string | null; currentPaidCents: number | null; restoredPaidCents: number | null; currentBalanceCents: number | null; restoredBalanceCents: number | null; currentStatus: string | null; restoredStatus: string | null }>;
  fileName?: string;
  completedAt?: number | null;
  created?: Array<{ donorId: string; donorName: string }>;
  recreates?: Array<{ donorId: string; donorName: string }>;
  restores?: Array<{ donorId: string; donorName: string; preservedFields: string[]; changeType: "update" | "merge" }>;
};

type LegacyRepair = {
  automaticRepairSafe: boolean;
  exactAttributionProven: boolean;
  candidates: Array<{ donorId: string; donorName: string; storedLastName: string | null; donorCode: string | null; probableChange: "possible_insert" | "possible_update"; evidence: string[] }>;
  directoryDiagnostics: Array<{ donorId: string; donorName: string; donorCode: string | null; storedLastName: string | null; ownerScopedLive: boolean }>;
  blockers: string[];
  manualRepairPlan: string[];
};

const LEGACY_HOUSEHOLD_BATCH_ID = "95f0c912-b57c-43de-be25-fbd2c082f052";

function money(cents: number | null) {
  return cents === null ? "Not recorded" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function date(timestamp: number) {
  return financialDateLabel(timestamp);
}

export function UndoDonationImport({ importId, kind = "donation" }: { importId: string; kind?: "donation" | "household" }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [backupId, setBackupId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [legacyRepair, setLegacyRepair] = useState<LegacyRepair | null>(null);

  async function inspect() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/import/${kind === "household" ? "household-rollback" : "rollback"}?importId=${encodeURIComponent(importId)}`);
      const data = await response.json() as Preview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to prepare the rollback preview.");
      if (kind === "household" && importId === LEGACY_HOUSEHOLD_BATCH_ID) {
        const repairResponse = await fetch("/api/import/legacy-household-repair", { cache: "no-store" });
        const repair = await repairResponse.json() as LegacyRepair & { error?: string };
        if (!repairResponse.ok) throw new Error(repair.error ?? "Unable to prepare the legacy repair assessment.");
        setLegacyRepair(repair);
      }
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
      const response = await fetch(`/api/import/${kind === "household" ? "household-rollback" : "rollback"}`, {
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
      const response = await fetch(`/api/import/backup?purpose=${kind === "household" ? "household_rollback" : "donation_rollback"}&importId=${encodeURIComponent(importId)}`);
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

  if (!open) return <div className="import-undo-action"><button type="button" disabled={loading} onClick={inspect}>{loading ? "Preparing preview…" : kind === "household" ? "View Details & Undo" : "Undo"}</button>{error && <p role="alert">{error}</p>}</div>;

  return (
    <section className="import-undo-preview" aria-labelledby={`undo-${importId}`}>
      <div className="import-section-heading"><div><p className="eyebrow">ROLLBACK PREVIEW</p><h3 id={`undo-${importId}`}>Review exactly what will change</h3></div><button type="button" onClick={() => setOpen(false)}>Close</button></div>
      {kind === "household" && <p><strong>{preview?.fileName}</strong>{preview?.completedAt ? ` · ${date(preview.completedAt)}` : ""}<br />Batch ID: <code>{importId}</code></p>}
      <dl className="import-undo-counts">
        {kind === "household" ? <><div><dt>New households removed</dt><dd>{preview?.totals.householdsRemoved ?? 0}</dd></div><div><dt>Merged households recreated</dt><dd>{preview?.totals.householdsRecreated ?? 0}</dd></div><div><dt>Households restored</dt><dd>{preview?.totals.householdsRestored ?? 0}</dd></div><div><dt>Batch records removed</dt><dd>{preview?.totals.batchRecordsRemoved ?? 0}</dd></div><div><dt>Later edits preserved</dt><dd>{preview?.totals.laterEditsPreserved ?? 0}</dd></div></> : <><div><dt>New gifts removed</dt><dd>{preview?.totals.newGiftsRemoved ?? 0}</dd></div><div><dt>Pledge updates restored</dt><dd>{preview?.totals.pledgeUpdatesRestored ?? 0}</dd></div><div><dt>Balances restored</dt><dd>{preview?.totals.balancesRestored ?? 0}</dd></div><div><dt>Statuses restored</dt><dd>{preview?.totals.statusesRestored ?? 0}</dd></div></>}
      </dl>
      {kind === "household" && !!preview?.created?.length && <div><h4>Households created by this batch</h4><ul>{preview.created.map((donor) => <li key={donor.donorId}>{donor.donorName}</li>)}</ul></div>}
      {kind === "household" && !!preview?.recreates?.length && <div><h4>Previously separate households restored by undo</h4><ul>{preview.recreates.map((donor) => <li key={donor.donorId}>{donor.donorName}</li>)}</ul></div>}
      {kind === "household" && !!preview?.restores?.length && <div><h4>Existing households changed by this batch</h4><ul>{preview.restores.map((donor) => <li key={donor.donorId}><strong>{donor.donorName}</strong> · {donor.changeType === "merge" ? "manual/JL merge will be restored" : "prior contact values will be restored"}{donor.preservedFields.length ? ` · later edits preserved: ${donor.preservedFields.join(", ")}` : ""}</li>)}</ul></div>}
      {!!preview?.newGifts?.length && <div><h4>New gifts that will be removed</h4><ul>{preview.newGifts.map((gift) => <li key={gift.sourceFingerprint}><strong>{gift.donorName}</strong> · {date(gift.activityDate)} · {money(gift.amountCents)}{gift.description ? ` · ${gift.description}` : ""}</li>)}</ul></div>}
      {!!preview?.pledgeUpdates?.length && <div><h4>Pledge values that will be restored</h4><ul>{preview.pledgeUpdates.map((pledge) => <li key={pledge.sourceFingerprint}><strong>{pledge.donorName}</strong> · {date(pledge.activityDate)}{pledge.description ? ` · ${pledge.description}` : ""}<br /><span>Paid {money(pledge.currentPaidCents)} → {money(pledge.restoredPaidCents)}; balance {money(pledge.currentBalanceCents)} → {money(pledge.restoredBalanceCents)}; status {pledge.currentStatus ?? "Not recorded"} → {pledge.restoredStatus ?? "Not recorded"}</span></li>)}</ul></div>}
      {!preview?.safe && <div className="onboarding-error" role="alert"><strong>This import cannot be safely reversed.</strong><ul>{preview?.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      {legacyRepair && <section className="legacy-repair-assessment" aria-label="One-time legacy batch repair assessment">
        <h4>One-time legacy batch repair assessment</h4>
        <p><strong>Automatic repair blocked.</strong> The records below are candidates, not proven batch changes.</p>
        <h4>Directory row diagnostics</h4><ul>{legacyRepair.directoryDiagnostics.map((donor) => <li key={donor.donorId}><strong>{donor.donorName}</strong>{donor.donorCode ? ` · donor code ${donor.donorCode}` : ""}<br /><span>Stored last name: {donor.storedLastName || "Not recorded"} · {donor.ownerScopedLive ? "Active owner-scoped live row" : "Not in the active owner scope"}</span></li>)}</ul>
        {legacyRepair.candidates.length > 0 ? <ul>{legacyRepair.candidates.map((candidate) => <li key={candidate.donorId}><strong>{candidate.donorName}</strong>{candidate.donorCode ? ` · donor code ${candidate.donorCode}` : ""}<br /><span>{candidate.probableChange === "possible_insert" ? "Possible insert" : "Possible update"}: {candidate.evidence.join(" ")}</span></li>)}</ul> : <p>No candidate donor rows could be attributed even tentatively.</p>}
        <h4>Why automatic repair is unsafe</h4><ul>{legacyRepair.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        <h4>Manual repair plan</h4><ol>{legacyRepair.manualRepairPlan.map((step) => <li key={step}>{step}</li>)}</ol>
      </section>}
      {preview?.safe && <div className="import-undo-confirmation">
        <p><strong>First, back up the current D1 workspace.</strong> The backup contains your owner-scoped donor workspace and should be stored securely.</p>
        <button type="button" onClick={downloadBackup} disabled={loading}>{backupConfirmed ? "Backup downloaded ✓" : loading ? "Creating backup…" : "Download D1 backup"}</button>
        <label><input type="checkbox" checked={backupConfirmed} disabled={!backupId} onChange={(event) => setBackupConfirmed(event.target.checked)} /> I downloaded and safely stored the backup.</label>
        <label>Type <strong>UNDO</strong> to confirm<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
        <p>Only batch <code>{importId}</code> will be reversed. Older imports and relationship workspace records are preserved. Later unrelated edits are retained. This undo cannot itself be undone.</p>
        <button type="button" className="danger" disabled={loading || !backupConfirmed || confirmation !== "UNDO"} onClick={undo}>{loading ? "Reversing import…" : "Confirm and undo import"}</button>
      </div>}
      {error && <p className="onboarding-error" role="alert">{error}</p>}
    </section>
  );
}
