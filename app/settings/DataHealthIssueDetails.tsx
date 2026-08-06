"use client";

import { useEffect, useState } from "react";
import { DonorAutocomplete } from "../capture/DonorAutocomplete";
import type { DataHealthReport, HealthCheck } from "../../lib/data-health/model";
import type { HealthIssue, HealthIssueResponse, HealthRepairAction } from "../../lib/data-health/issues";
import { formatTimestamp } from "./dataHealthFormat";

type PendingRepair = { issue: HealthIssue; action: HealthRepairAction; targetDonorId: string | null };

const actionLabel: Record<HealthRepairAction, string> = {
  reattach: "Reattach to donor",
  move_to_survivor: "Move to surviving donor",
  archive: "Archive",
  dismiss_false_positive: "Dismiss as false positive",
};

function repairExplanation(pending: PendingRepair) {
  if (pending.action === "reattach") return `This will move the existing ${pending.issue.recordType} to the selected donor without creating a copy.`;
  if (pending.action === "move_to_survivor") return `This will move the existing ${pending.issue.recordType} from the archived donor to its surviving donor.`;
  if (pending.action === "archive") return `This will hide the ${pending.issue.recordType} from active workspace views while preserving its history and audit record.`;
  return "This leaves the record unchanged and records why this specific donor link should no longer count as a health issue.";
}

export function DataHealthIssueDetails({ check, onClose, onReport, useLocalTime }: { check: HealthCheck; onClose: () => void; onReport: (report: DataHealthReport) => void; useLocalTime: boolean }) {
  const orphanCheck = check.id === "orphaned-interactions" || check.id === "orphaned-reminders";
  const [data, setData] = useState<HealthIssueResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">(orphanCheck ? "loading" : "ready");
  const [message, setMessage] = useState("");
  const [selectedDonors, setSelectedDonors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingRepair | null>(null);

  useEffect(() => {
    if (!orphanCheck) return;
    const controller = new AbortController();
    setStatus("loading");
    setMessage("");
    fetch(`/api/health/issues?check=${encodeURIComponent(check.id)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as HealthIssueResponse | { error?: string };
        if (!response.ok || !("issues" in body)) throw new Error("error" in body && body.error ? body.error : "Issue details could not be loaded");
        setData(body);
        setStatus("ready");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Issue details could not be loaded");
      });
    return () => controller.abort();
  }, [check.id, orphanCheck]);

  function reviewRepair(issue: HealthIssue, action: HealthRepairAction) {
    const targetDonorId = action === "reattach" ? selectedDonors[issue.recordId] || null : action === "move_to_survivor" ? issue.survivingDonorId : null;
    if (action === "reattach" && !targetDonorId) {
      setStatus("error");
      setMessage("Choose an active donor before reviewing this repair.");
      return;
    }
    setPending({ issue, action, targetDonorId });
    setStatus("ready");
    setMessage("");
  }

  async function confirmRepair() {
    if (!pending || status === "saving") return;
    setStatus("saving");
    setMessage("");
    try {
      const response = await fetch("/api/health/issues", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ recordType: pending.issue.recordType, recordId: pending.issue.recordId, action: pending.action, targetDonorId: pending.targetDonorId, confirmed: true }) });
      const body = await response.json() as { report?: DataHealthReport; auditId?: string; error?: string };
      if (!response.ok || !body.report) throw new Error(body.error || "The repair could not be saved");
      onReport(body.report);
      setData((current) => current ? { ...current, issues: current.issues.filter((issue) => issue.recordId !== pending.issue.recordId) } : current);
      setSelectedDonors((current) => { const next = { ...current }; delete next[pending.issue.recordId]; return next; });
      setMessage(`${actionLabel[pending.action]} completed. The original record was updated in place.`);
      setPending(null);
      setStatus("ready");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The repair could not be saved");
    }
  }

  return <section className="data-health-detail" aria-labelledby="health-detail-title">
    <div className="data-health-detail-header"><div><p className="eyebrow">DIAGNOSTIC</p><h3 id="health-detail-title">{check.label}</h3><p>{check.explanation}</p></div><button type="button" onClick={onClose} aria-label="Close health diagnostic">Close</button></div>
    {check.diagnosticLines?.length ? <div className="migration-diagnostic">
      <strong>{check.id === "staging-migration-history" ? "Missing from the migration ledger" : check.id === "production-readiness" ? "Blocking checks" : "Details"}</strong>
      <ul>{check.diagnosticLines.map((line) => <li key={line}>{line}</li>)}</ul>
      {check.id === "staging-migration-history" && <p>The SQL files are packaged, but production launch remains blocked until ledger repair is rehearsed without replaying migrations.</p>}
    </div> : null}
    {check.evidence ? <div className="health-general-diagnostic">
      <dl>
        <div><dt>Current result</dt><dd>{check.value}</dd></div>
        <div><dt>Expected</dt><dd>{check.evidence.expected}</dd></div>
        <div><dt>Actual</dt><dd>{check.evidence.actual}</dd></div>
        <div><dt>Evidence source</dt><dd>{check.evidence.evidenceSource}</dd></div>
        <div><dt>Last successful verification</dt><dd>{check.evidence.lastVerifiedAt ? formatTimestamp(check.evidence.lastVerifiedAt, useLocalTime) : "Not yet verified"}</dd></div>
        <div><dt>Severity</dt><dd>{check.evidence.severity}</dd></div>
        <div><dt>Business data at risk</dt><dd>{check.evidence.businessDataAtRisk ? "Yes" : "No"}</dd></div>
        <div><dt>Repair step</dt><dd>{check.evidence.repairStep}</dd></div>
      </dl>
      {check.actionHref && <a href={check.actionHref}>{check.actionLabel ?? "Open related workspace"}</a>}
    </div> : (!orphanCheck && !check.diagnosticLines?.length ? <div className="health-general-diagnostic"><strong>Current result: {check.value}</strong><p>{check.explanation}</p>{check.actionHref && <a href={check.actionHref}>{check.actionLabel ?? "Open related workspace"}</a>}</div> : null)}
    {status === "loading" && <p className="health-detail-state" role="status">Loading affected records…</p>}
    {message && <p className={status === "error" ? "capture-error" : "capture-assurance"} role={status === "error" ? "alert" : "status"}>{message}</p>}
    {orphanCheck && data && !data.issues.length ? <div className="health-detail-empty"><strong>No unresolved records remain.</strong><p>The health count has been refreshed.</p></div> : null}
    {data?.issues.map((issue) => <article className="health-issue-record" key={`${issue.recordType}-${issue.recordId}`}>
      <div className="health-issue-heading"><div><span>{issue.recordType === "interaction" ? "Interaction" : "Reminder"}</span><h4>{issue.title}</h4></div><time dateTime={issue.date ?? undefined}>{issue.date ? new Date(issue.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable"}</time></div>
      <dl><div><dt>Internal record ID</dt><dd>{issue.recordId}</dd></div><div><dt>Current donor ID</dt><dd>{issue.currentDonorId}</dd></div><div><dt>Why it is orphaned</dt><dd>{issue.whyOrphaned}</dd></div><div><dt>Likely cause</dt><dd>{issue.likelyCause}</dd></div><div><dt>Suggested repair</dt><dd>{issue.suggestedRepair}</dd></div></dl>
      <div className="health-repair-controls">
        <DonorAutocomplete donors={data.donors} selectedId={selectedDonors[issue.recordId] ?? ""} onSelect={(donorId) => setSelectedDonors((current) => ({ ...current, [issue.recordId]: donorId }))} inputId={`health-donor-${issue.recordId}`} label="Reattach to an active donor" clearable />
        <div className="health-repair-actions"><button type="button" disabled={!selectedDonors[issue.recordId] || status === "saving"} onClick={() => reviewRepair(issue, "reattach")}>Review reattachment</button>{issue.survivingDonorId && <button type="button" onClick={() => reviewRepair(issue, "move_to_survivor")}>Move to surviving donor</button>}<button type="button" onClick={() => reviewRepair(issue, "archive")}>Archive</button>{issue.canDismiss && <button type="button" onClick={() => reviewRepair(issue, "dismiss_false_positive")}>Dismiss as false positive</button>}</div>
      </div>
    </article>)}
    {pending && <div className="health-repair-confirmation" role="alertdialog" aria-labelledby="repair-confirm-title" aria-describedby="repair-confirm-description">
      <strong id="repair-confirm-title">Confirm: {actionLabel[pending.action]}</strong><p id="repair-confirm-description">{repairExplanation(pending)}</p><p>This action is owner-scoped and will be recorded in the repair audit log.</p><div><button type="button" onClick={() => setPending(null)} disabled={status === "saving"}>Go back</button><button type="button" onClick={() => void confirmRepair()} disabled={status === "saving"}>{status === "saving" ? "Saving repair…" : `Confirm ${actionLabel[pending.action]}`}</button></div>
    </div>}
  </section>;
}
