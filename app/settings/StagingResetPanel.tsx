"use client";

import { useState } from "react";
import { STAGING_RESET_CONFIRMATION } from "../../lib/operations/staging-reset";

export function StagingResetPanel() {
  const [confirmation, setConfirmation] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  async function runReset() {
    if (state === "saving" || confirmation !== STAGING_RESET_CONFIRMATION) return;
    setState("saving"); setMessage("");
    try {
      const response = await fetch("/api/operations/staging-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmation }) });
      const body = await response.json() as { report?: unknown; error?: string };
      if (!response.ok || !body.report) throw new Error(body.error || "The reset could not be completed.");
      setState("success");
      setMessage("Reset complete. Reload the page to see Workspace Health reflect the empty environment.");
      setConfirmation("");
    } catch (error) {
      setState("error"); setMessage(error instanceof Error ? error.message : "The reset could not be completed.");
    }
  }

  return <section className="legacy-test-cleanup" aria-labelledby="staging-reset-title">
    <div><p className="eyebrow">OWNER-ONLY · INDEPENDENT STAGING</p><h3 id="staging-reset-title">Reset staging to a pristine state</h3><p>Permanently deletes every donor, gift, interaction, import, reminder, note, and AI-generated record in this environment. The verified schema baseline, migrations, and your own account are never touched. This cannot be undone.</p></div>
    <div className="legacy-cleanup-confirm"><label>Type {STAGING_RESET_CONFIRMATION}<input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label><button type="button" className="danger-button" disabled={state === "saving" || confirmation !== STAGING_RESET_CONFIRMATION} onClick={() => void runReset()}>{state === "saving" ? "Resetting…" : "Confirm and reset staging"}</button></div>
    {message && <p className={state === "error" ? "capture-error" : "capture-assurance"} role={state === "error" ? "alert" : "status"}>{message}</p>}
  </section>;
}
