"use client";

import { useState } from "react";
import { toLocalDateTimeValue } from "../../../../lib/capture/scheduling";

type OutcomeActivity = {
  id: string;
  donorId: string;
  donorName: string;
  type: string;
  plannedLabel: string;
  subject: string;
  notes: string;
};

type OutcomeAction = "complete" | "cancel" | "reschedule" | "no-response";

const typeLabel = (type: string) => type === "personal" ? "Personal interaction" : `${type.charAt(0).toUpperCase()}${type.slice(1)}`;

export function OutcomeExperience({ activity, initialCompletedValue, initialRescheduleValue }: { activity: OutcomeActivity; initialCompletedValue: string; initialRescheduleValue: string }) {
  const [outcome, setOutcome] = useState("");
  const [completedAt, setCompletedAt] = useState(initialCompletedValue);
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUp, setFollowUp] = useState("");
  const [followUpAt, setFollowUpAt] = useState(initialRescheduleValue);
  const [rescheduledAt, setRescheduledAt] = useState(initialRescheduleValue);
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");

  function isoValue(value: string) {
    const parsed = new Date(value);
    return value && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
  }

  async function submit(action: OutcomeAction) {
    if (status === "saving") return;
    if (action === "cancel" && !window.confirm("Cancel this activity? It will leave Today and Upcoming and remain marked as cancelled in the donor timeline.")) return;
    setStatus("saving");
    setError("");
    try {
      const response = await fetch(`/api/interactions/${encodeURIComponent(activity.id)}/outcome`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          outcome,
          completedAt: isoValue(completedAt),
          followUp: followUpEnabled ? followUp : undefined,
          followUpAt: followUpEnabled ? isoValue(followUpAt) : undefined,
          rescheduledAt: isoValue(rescheduledAt),
        }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The activity could not be updated.");
      window.location.assign(`/donors/${encodeURIComponent(activity.donorId)}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The activity could not be updated.");
      setStatus("error");
    }
  }

  const followUpReady = !followUpEnabled || (followUp.trim().length >= 2 && Boolean(followUpAt));
  return <main className="outcome-page">
    <header className="outcome-header">
      <div><p className="eyebrow">ACTIVITY OUTCOME</p><h1>Close the loop</h1><p>Record what happened without creating a duplicate interaction.</p></div>
      <a href={`/donors/${encodeURIComponent(activity.donorId)}`} aria-label="Close outcome form">×</a>
    </header>

    <section className="outcome-plan-card" aria-label="Original planned activity">
      <div><span className="event-type">{typeLabel(activity.type)}</span><h2>{activity.subject}</h2><p>{activity.donorName}</p></div>
      <dl>
        <div><dt>Planned</dt><dd>{activity.plannedLabel}</dd></div>
        <div><dt>Original notes</dt><dd>{activity.notes}</dd></div>
      </dl>
    </section>

    <section className="outcome-form-card">
      <label htmlFor="activity-outcome">Outcome / result</label>
      <textarea id="activity-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="What happened?" autoFocus />
      <label htmlFor="activity-completed-at">Completed date &amp; time</label>
      <div className="outcome-date-row"><input id="activity-completed-at" type="datetime-local" value={completedAt} onChange={(event) => setCompletedAt(event.target.value)} /><button type="button" onClick={() => setCompletedAt(toLocalDateTimeValue(new Date()))}>Now</button></div>

      <label className="outcome-follow-up-toggle"><input type="checkbox" checked={followUpEnabled} onChange={(event) => setFollowUpEnabled(event.target.checked)} /> Add a follow-up activity</label>
      {followUpEnabled && <div className="outcome-follow-up-fields">
        <label htmlFor="activity-follow-up">Follow-up</label>
        <input id="activity-follow-up" value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="What should happen next?" />
        <label htmlFor="activity-follow-up-at">Follow-up date &amp; time</label>
        <input id="activity-follow-up-at" type="datetime-local" value={followUpAt} onChange={(event) => setFollowUpAt(event.target.value)} />
      </div>}

      {error && <p className="capture-error" role="alert">{error}</p>}
      <button className="capture-save" type="button" disabled={status === "saving" || outcome.trim().length < 2 || !followUpReady} onClick={() => submit("complete")}>{status === "saving" ? "Updating activity…" : "Close Activity"}</button>
    </section>

    <section className="outcome-did-not-happen">
      <div><p className="eyebrow">DID NOT HAPPEN</p><h2>Keep the history accurate</h2></div>
      <div className="outcome-reschedule"><label htmlFor="activity-rescheduled-at">New date &amp; time</label><input id="activity-rescheduled-at" type="datetime-local" value={rescheduledAt} onChange={(event) => setRescheduledAt(event.target.value)} /></div>
      <div className="outcome-alternate-actions">
        <button type="button" disabled={status === "saving"} onClick={() => submit("cancel")}>Cancel</button>
        <button type="button" disabled={status === "saving" || !rescheduledAt} onClick={() => submit("reschedule")}>Reschedule</button>
        <button type="button" disabled={status === "saving" || !followUpReady} onClick={() => submit("no-response")}>No response</button>
      </div>
    </section>
  </main>;
}
