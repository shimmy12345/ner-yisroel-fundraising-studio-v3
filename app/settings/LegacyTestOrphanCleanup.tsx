"use client";

import { useState } from "react";
import type { DataHealthReport } from "../../lib/data-health/model";
import { LEGACY_TEST_CLEANUP_CONFIRMATION, type LegacyTestCleanupPreview } from "../../lib/data-health/legacy-test-cleanup";

type CleanupResult = { auditId: string; archived: { interactions: number; reminders: number }; report: DataHealthReport; error?: string };

export function LegacyTestOrphanCleanup({ onReport }: { onReport: (report: DataHealthReport) => void }) {
  const [preview, setPreview] = useState<LegacyTestCleanupPreview | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "saving" | "success" | "error">("idle");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState("");

  async function loadPreview() {
    if (state === "loading" || state === "saving") return;
    setState("loading"); setMessage("");
    try {
      const response = await fetch("/api/health/legacy-test-cleanup", { cache: "no-store" });
      const body = await response.json() as LegacyTestCleanupPreview | { error?: string };
      if (!response.ok || !("candidates" in body)) throw new Error(("error" in body && body.error) || "The cleanup preview could not be prepared.");
      setPreview(body); setState("ready");
    } catch (error) {
      setState("error"); setMessage(error instanceof Error ? error.message : "The cleanup preview could not be prepared.");
    }
  }

  async function runCleanup() {
    if (!preview || state === "saving" || confirmation !== LEGACY_TEST_CLEANUP_CONFIRMATION) return;
    setState("saving"); setMessage("");
    try {
      const response = await fetch("/api/health/legacy-test-cleanup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previewToken: preview.previewToken, confirmation, confirmed: true }) });
      const body = await response.json() as CleanupResult;
      if (!response.ok || !body.report) throw new Error(body.error || "The cleanup could not be completed.");
      onReport(body.report);
      setPreview((current) => current ? { ...current, candidates: [], counts: { interactions: 0, reminders: 0 } } : current);
      setConfirmation(""); setState("success");
      setMessage(`Cleanup complete: ${body.archived.interactions} interactions and ${body.archived.reminders} reminders were archived. Audit ${body.auditId}.`);
    } catch (error) {
      setState("error"); setMessage(error instanceof Error ? error.message : "The cleanup could not be completed.");
    }
  }

  return <section className="legacy-test-cleanup" aria-labelledby="legacy-cleanup-title">
    <div><p className="eyebrow">OWNER-ONLY CLEANUP</p><h3 id="legacy-cleanup-title">Legacy test orphans</h3><p>Preview activity proven to be sample data by database metadata. Descriptions, dates, donor names, and similarity are never used as deletion criteria.</p></div>
    <button type="button" onClick={() => void loadPreview()} disabled={state === "loading" || state === "saving"}>{state === "loading" ? "Preparing preview…" : preview ? "Refresh preview" : "Preview cleanup"}</button>
    {message && <p className={state === "error" ? "capture-error" : "capture-assurance"} role={state === "error" ? "alert" : "status"}>{message}</p>}
    {preview && <div className="legacy-cleanup-preview">
      <p><strong>{preview.counts.interactions} interactions</strong> and <strong>{preview.counts.reminders} reminders</strong> are proven sample records.</p>
      {preview.candidates.length ? <div className="legacy-cleanup-records">{preview.candidates.map((record) => <article key={`${record.recordType}-${record.recordId}`}><strong>{record.recordType === "interaction" ? "Interaction" : "Reminder"}</strong><dl><div><dt>Record ID</dt><dd>{record.recordId}</dd></div><div><dt>Source marker</dt><dd>{record.sourceMarker}</dd></div><div><dt>Why safe</dt><dd>{record.reason}</dd></div></dl></article>)}</div> : <p>No proven legacy test records remain.</p>}
      {preview.blocked.length > 0 && <div className="legacy-cleanup-blocked"><strong>{preview.blocked.length} uncertain records are blocked from cleanup.</strong>{preview.blocked.map((record) => <p key={`${record.recordType}-${record.recordId}`}>{record.recordType} {record.recordId}: {record.reason}</p>)}</div>}
      {preview.candidates.length > 0 && <div className="legacy-cleanup-confirm"><p>This soft-archives the listed records and writes an immutable audit entry. Uncertain and live records are not changed.</p><label>Type {LEGACY_TEST_CLEANUP_CONFIRMATION}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button type="button" className="danger-button" disabled={state === "saving" || confirmation !== LEGACY_TEST_CLEANUP_CONFIRMATION} onClick={() => void runCleanup()}>{state === "saving" ? "Archiving proven records…" : "Confirm and archive proven records"}</button></div>}
    </div>}
  </section>;
}
