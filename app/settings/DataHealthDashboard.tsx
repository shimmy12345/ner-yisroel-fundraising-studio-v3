"use client";

import { useEffect, useState } from "react";
import type { DataHealthReport, HealthCheck, HealthStatus } from "../../lib/data-health/model";
import { DataHealthIssueDetails } from "./DataHealthIssueDetails";
import { LegacyTestOrphanCleanup } from "./LegacyTestOrphanCleanup";

const icons: Record<HealthStatus, string> = { healthy: "✓", attention: "!", critical: "×", info: "i", unavailable: "—" };

function formatTimestamp(value: string, useLocalTime: boolean) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  if (useLocalTime) return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  return `${date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

function displayValue(check: HealthCheck, useLocalTime: boolean) {
  if (!["household-refresh", "donation-refresh", "backup"].includes(check.id) || !check.value.includes("T")) return check.value;
  return formatTimestamp(check.value, useLocalTime);
}

export function DataHealthDashboard({ initialReport }: { initialReport: DataHealthReport }) {
  const [report, setReport] = useState(initialReport);
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [useLocalTime, setUseLocalTime] = useState(false);
  const [selectedCheckId, setSelectedCheckId] = useState<string | null>(null);

  useEffect(() => setUseLocalTime(true), []);
  const selectedCheck = report.checks.find((check) => check.id === selectedCheckId) ?? null;

  async function runHealthCheck() {
    if (state === "loading") return;
    setState("loading");
    setMessage("");
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      const body = await response.json() as DataHealthReport | { error?: string };
      if ("checks" in body && Array.isArray(body.checks)) {
        setReport(body);
        setState("success");
        setMessage(body.status === "healthy" ? "Health check complete. Everything is healthy." : "Health check complete. Review the highlighted items below.");
        return;
      }
      throw new Error("error" in body && body.error ? body.error : "The health check could not be completed.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "The health check could not be completed.");
    }
  }

  return <section className="support-card data-health" id="data-health" aria-labelledby="data-health-title">
    <div className="data-health-header">
      <div><p className="eyebrow">DATA HEALTH</p><h2 id="data-health-title">Workspace health</h2><p>One private summary of your live data and application foundation. Names, amounts, and source rows are never shown here.</p></div>
      <div className={`data-health-overall ${report.status}`}><span aria-hidden="true">{report.status === "healthy" ? "✓" : report.status === "critical" ? "×" : "!"}</span><strong>{report.status === "healthy" ? "Healthy" : report.status === "critical" ? "Needs attention" : "Review recommended"}</strong></div>
    </div>
    <div className="data-health-run">
      <div><strong>{report.summary}</strong><small>Last checked {formatTimestamp(report.checkedAt, useLocalTime)}</small></div>
      <button type="button" onClick={runHealthCheck} disabled={state === "loading"} aria-describedby="health-check-status">{state === "loading" ? "Running health check…" : "Run health check"}</button>
    </div>
    {message && <p id="health-check-status" className={state === "error" ? "capture-error" : "capture-assurance"} role={state === "error" ? "alert" : "status"}>{message}</p>}
    <div className="data-health-grid">
      {report.checks.map((check) => <article className={`data-health-check ${check.status}`} key={check.id}>
        <span className="data-health-icon" aria-hidden="true">{icons[check.status]}</span>
        <div><div className="data-health-check-heading"><h3>{check.label}</h3><strong>{displayValue(check, useLocalTime)}</strong></div><p>{check.explanation}</p>{["critical", "attention", "unavailable"].includes(check.status) && <button className="health-inspect-button" type="button" onClick={() => setSelectedCheckId(check.id)} aria-expanded={selectedCheckId === check.id}>Inspect details <span aria-hidden="true">↓</span></button>}</div>
      </article>)}
    </div>
    {selectedCheck && <DataHealthIssueDetails check={selectedCheck} onClose={() => setSelectedCheckId(null)} onReport={setReport} />}
    <LegacyTestOrphanCleanup onReport={setReport} />
  </section>;
}
