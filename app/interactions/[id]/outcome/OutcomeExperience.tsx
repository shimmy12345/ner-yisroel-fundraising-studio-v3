"use client";

import { useMemo, useState } from "react";
import { toLocalDateTimeValue } from "../../../../lib/capture/scheduling";
import { donorInitials, numericDonorCode } from "../../../../lib/relationships/donor-identity";
import { extractInteraction, interactionKindLabel, type InteractionKind } from "../../../../lib/capture/interaction";

type ActivityStatus = "scheduled" | "completed" | "no-response" | "cancelled" | "archived" | "logged";
type OutcomeActivity = {
  id: string; donorId: string; donorName: string; primaryFirstName: string | null; lastName: string | null; donorCode: string | null; type: string; status: ActivityStatus; plannedLabel: string; completedLabel: string | null; subject: string; notes: string; outcome: string;
  // Option A (2026-08-21): the donor's CURRENT stored Relationship
  // Snapshot/Institutional Memory, shown alongside the proposed value
  // below so accepting a new one is never a silent replacement -- the
  // main capture form (CaptureExperience.tsx) doesn't show this today;
  // this route deliberately goes further, since an outcome is closing
  // out a pre-existing scheduled activity for a donor who may already
  // have real, previously-accepted relationship history, a materially
  // higher risk than an ordinary fresh capture.
  currentRelationshipSummary: string | null; currentInstitutionalMemory: string | null;
};
type OutcomeAction = "complete" | "cancel" | "reschedule" | "no-response" | "reopen" | "undo";
type FollowUp = { id: string; type: string; at: string; subject: string; notes: string } | null;
type Audit = { id: string; action: string; from_status: string; to_status: string; createdLabel: string; undone_at: number | null };
type Result = { error?: string; auditId?: string; followUpId?: string; followUpHref?: string; activityHref?: string; message?: string; status?: ActivityStatus; relationshipUpdated?: boolean };
const typeLabel = (type: string) => interactionKindLabel(type as InteractionKind) || `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
const statusLabel = (status: ActivityStatus) => status === "no-response" ? "No response" : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
// Matches the server route's own `kinds` fallback exactly (any type not
// in this set -- shouldn't happen for a real interaction row, but keeps
// the client preview and the server's extraction input identical).
const VALID_KINDS = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);

export function OutcomeExperience({ activity, initialCompletedValue, initialRescheduleValue, followUp, audits }: { activity: OutcomeActivity; initialCompletedValue: string; initialRescheduleValue: string; followUp: FollowUp; audits: Audit[] }) {
  const [outcome, setOutcome] = useState(activity.outcome);
  const [notes, setNotes] = useState(activity.notes);
  const [completedAt, setCompletedAt] = useState(initialCompletedValue);
  const [followUpEnabled, setFollowUpEnabled] = useState(Boolean(followUp));
  const [followUpType, setFollowUpType] = useState(followUp?.type ?? "call");
  const [followUpSubject, setFollowUpSubject] = useState(followUp?.subject ?? "");
  const [followUpNotes, setFollowUpNotes] = useState(followUp?.notes ?? "");
  const [followUpAt, setFollowUpAt] = useState(followUp?.at ?? initialRescheduleValue);
  const [rescheduledAt, setRescheduledAt] = useState(initialRescheduleValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  // Explicit acceptance, default false, same as CaptureExperience.tsx's
  // `acceptRelationshipSnapshot` -- never checked automatically, and
  // never carried over from a previous submission (this component's
  // state is fresh on every page load; editing/reopening an outcome
  // later means loading this page again, starting unchecked again).
  const [acceptRelationshipSnapshot, setAcceptRelationshipSnapshot] = useState(false);
  const currentStatus = result?.status ?? activity.status;
  const isoValue = (value: string) => { const parsed = new Date(value); return value && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined; };

  // Live preview, computed from the exact same inputs the server route
  // extracts from at submit time (`${notes}\nOutcome: ${outcome}`, same
  // kind-fallback rule, same subject) -- mirrors CaptureExperience.tsx's
  // own `preview = useMemo(() => extractInteraction(...))` pattern
  // exactly. Only meaningful for the "complete"/"no-response" actions
  // (the only ones that can ever write relationship data server-side);
  // shown regardless of which of those two the user ends up clicking; a
  // one-word "No response" won't trip any fact signal so unhelpful blank
  // proposals aren't a real concern there.
  const kind = VALID_KINDS.has(activity.type as InteractionKind) ? (activity.type as InteractionKind) : "note";
  const preview = useMemo(
    () => extractInteraction(`${notes}\nOutcome: ${outcome.trim()}`, kind, activity.subject),
    [notes, outcome, kind, activity.subject],
  );

  async function submit(action: OutcomeAction, auditId?: string) {
    if (saving) return;
    const confirmations: Partial<Record<OutcomeAction, string>> = {
      complete: followUpEnabled ? "Close this activity and schedule the follow-up?" : "Mark this activity completed?",
      "no-response": "Mark this activity as no response? You can edit or reopen it later.",
      cancel: "Cancel this activity? It will leave Today and Upcoming but remain in the timeline.",
      reschedule: "Reschedule this same activity? No duplicate will be created.",
      reopen: "Reopen this activity for editing? The same activity record will be restored.",
    };
    if (confirmations[action] && !window.confirm(confirmations[action]!)) return;
    setSaving(true); setError("");
    try {
      const response = await fetch(`/api/interactions/${encodeURIComponent(activity.id)}/outcome`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        action, auditId, outcome, notes, completedAt: isoValue(completedAt), rescheduledAt: isoValue(rescheduledAt), followUpEnabled,
        followUpType, followUpSubject, followUpNotes, followUpAt: isoValue(followUpAt),
        // Gated on the CURRENT preview, not just the checkbox's own state
        // -- identical reasoning and identical expression to
        // CaptureExperience.tsx's saveInteraction(): if the notes/outcome
        // text changed after the box was checked (or nothing meaningful
        // was ever detected), this must never send true.
        acceptRelationshipSnapshot: acceptRelationshipSnapshot && preview.relationshipSummary !== null,
      }) });
      const data = await response.json() as Result;
      if (!response.ok) throw new Error(data.error || "The activity could not be updated.");
      if (action === "undo") window.location.reload(); else setResult(data);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The activity could not be updated."); }
    finally { setSaving(false); }
  }

  const followUpReady = !followUpEnabled || (Boolean(followUpType) && Boolean(followUpAt));
  const canClose = outcome.trim().length >= 2 && followUpReady;
  const code = numericDonorCode({ donorCode: activity.donorCode });
  return <main className="outcome-page">
    <header className="outcome-header"><div><p className="eyebrow">ACTIVITY OUTCOME</p><h1>Close the loop</h1><p>Update the original activity without creating a duplicate.</p></div><a href={`/donors/${encodeURIComponent(activity.donorId)}`} aria-label="Close outcome form">×</a></header>
    <section className="outcome-plan-card" aria-label="Activity details">
      <div className="outcome-activity-identity"><span className="mini-avatar">{donorInitials({ displayName: activity.donorName, primaryFirstName: activity.primaryFirstName, lastName: activity.lastName })}</span><div><span className="event-type">{typeLabel(activity.type)}</span><span className={`activity-status activity-status-${currentStatus}`}>{statusLabel(currentStatus)}</span><h2>{activity.subject}</h2><p>{activity.donorName}</p>{code && <span className="donor-code">{code}</span>}</div></div>
      <dl><div><dt>Scheduled</dt><dd>{activity.plannedLabel}</dd></div>{activity.completedLabel && <div><dt>Completed</dt><dd>{activity.completedLabel}</dd></div>}</dl>
    </section>

    {result && <section className="outcome-confirmation" role="status"><h2>Saved</h2><p>{result.message}</p>
      {result.relationshipUpdated && <p className="outcome-relationship-receipt"><strong>Relationship snapshot updated.</strong> The accepted proposal was saved.</p>}
      {!result.relationshipUpdated && acceptRelationshipSnapshot && preview.relationshipSummary !== null && <p className="outcome-relationship-receipt"><strong>Relationship snapshot not updated.</strong> The donor's snapshot changed since this page loaded -- nothing was overwritten. Refresh and try again if you still want to accept it.</p>}
      <div><a href={`/donors/${encodeURIComponent(activity.donorId)}`}>Open donor timeline</a>{result.followUpHref && <a href={result.followUpHref}>Open scheduled follow-up</a>} {result.auditId && <button type="button" disabled={saving} onClick={() => submit("undo", result.auditId)}>Undo this change</button>}</div></section>}

    <section className="outcome-form-card">
      <label htmlFor="activity-notes">Activity notes</label><textarea id="activity-notes" value={notes} onChange={(event) => setNotes(event.target.value)} />
      <label htmlFor="activity-outcome">Outcome / result</label><textarea id="activity-outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)} autoFocus />
      <label htmlFor="activity-completed-at">Completed date &amp; time</label><div className="outcome-date-row"><input id="activity-completed-at" type="datetime-local" value={completedAt} onChange={(event) => setCompletedAt(event.target.value)} /><button type="button" onClick={() => setCompletedAt(toLocalDateTimeValue(new Date()))}>Now</button></div>
      <label className="outcome-follow-up-toggle"><input type="checkbox" checked={followUpEnabled} onChange={(event) => setFollowUpEnabled(event.target.checked)} /> Add a follow-up activity</label>
      {followUpEnabled && <div className="outcome-follow-up-fields">
        <label htmlFor="activity-follow-up-type">Follow-up type <span aria-hidden="true">*</span></label><select id="activity-follow-up-type" required value={followUpType} onChange={(event) => setFollowUpType(event.target.value)}>{["call", "email", "meeting", "visit", "note", "personal", "text"].map((type) => <option key={type} value={type}>{typeLabel(type)}</option>)}</select>
        <label htmlFor="activity-follow-up-at">Follow-up date &amp; time <span aria-hidden="true">*</span></label><input id="activity-follow-up-at" required type="datetime-local" value={followUpAt} onChange={(event) => setFollowUpAt(event.target.value)} />
        <label htmlFor="activity-follow-up-subject">Subject (optional)</label><input id="activity-follow-up-subject" value={followUpSubject} onChange={(event) => setFollowUpSubject(event.target.value)} />
        <label htmlFor="activity-follow-up-notes">Notes (optional)</label><textarea id="activity-follow-up-notes" value={followUpNotes} onChange={(event) => setFollowUpNotes(event.target.value)} />
      </div>}

      {/* Only ever offers a real fact to opt into -- never a generic
          category label or boilerplate the user would have to manually
          reject. Same rule as CaptureExperience.tsx: `preview.
          relationshipSummary === null` means nothing specific and
          donor-relevant was actually found, and no checkbox is shown at
          all in that case. Additionally shows the donor's CURRENT stored
          snapshot (if any) so accepting a replacement is never silent --
          see the OutcomeActivity type comment above for why this route
          shows more than the main capture form does. */}
      <div className="extraction-preview" aria-live="polite">
        {preview.relationshipSummary !== null ? (
          <div className="relationship-snapshot-preview">
            {(activity.currentRelationshipSummary || activity.currentInstitutionalMemory) && (
              <p className="outcome-current-snapshot">
                <strong>Current Relationship Snapshot:</strong>{" "}
                {activity.currentRelationshipSummary || <em>None yet</em>}
                {activity.currentInstitutionalMemory && <><br /><strong>Current Institutional Memory:</strong> {activity.currentInstitutionalMemory}</>}
              </p>
            )}
            <label>
              <input type="checkbox" checked={acceptRelationshipSnapshot} onChange={(event) => setAcceptRelationshipSnapshot(event.target.checked)} />
              <span><strong>Use this relationship snapshot</strong><small>Nothing generated is saved unless you check this box.{(activity.currentRelationshipSummary || activity.currentInstitutionalMemory) ? " Accepting replaces the current snapshot above." : ""}</small></span>
            </label>
            <p><strong>Proposed Relationship Snapshot:</strong> {preview.relationshipSummary}</p>
          </div>
        ) : (
          // null here means no NEW durable fact was found -- never that this
          // outcome itself was meaningless. The activity still closes out
          // and still counts as real contact regardless (see
          // lib/relationships/meeting-brief.ts).
          <p className="relationship-snapshot-preview relationship-snapshot-empty">No new relationship details to save. This interaction is still recorded as stewardship activity.</p>
        )}
      </div>

      {error && <p className="capture-error" role="alert">{error}</p>}
      <button className="capture-save" type="button" disabled={saving || !canClose} onClick={() => submit("complete")}>{saving ? "Saving…" : followUpEnabled ? "Close and Schedule Follow-up" : currentStatus === "scheduled" ? "Close Activity" : "Save Outcome Changes"}</button>
      {currentStatus !== "scheduled" && <button className="secondary-button" type="button" disabled={saving} onClick={() => submit("reopen")}>Reopen activity</button>}
    </section>

    <section className="outcome-did-not-happen"><div><p className="eyebrow">STATUS</p><h2>Change or reschedule</h2></div><div className="outcome-reschedule"><label htmlFor="activity-rescheduled-at">New scheduled date &amp; time</label><input id="activity-rescheduled-at" type="datetime-local" value={rescheduledAt} onChange={(event) => setRescheduledAt(event.target.value)} /></div><div className="outcome-alternate-actions"><button type="button" disabled={saving} onClick={() => submit("cancel")}>Cancelled</button><button type="button" disabled={saving || !rescheduledAt} onClick={() => submit("reschedule")}>Reschedule</button><button type="button" disabled={saving || !followUpReady} onClick={() => submit("no-response")}>No response</button></div></section>
    <section className="outcome-audit"><p className="eyebrow">ACTIVITY HISTORY</p><h2>Status changes</h2>{audits.length === 0 ? <p>No status changes yet.</p> : <ol>{audits.map((audit) => <li key={audit.id}><strong>{audit.from_status} → {audit.to_status}</strong><span>{audit.createdLabel}{audit.undone_at ? " · Undone" : ""}</span></li>)}</ol>}</section>
  </main>;
}
