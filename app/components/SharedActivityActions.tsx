"use client";

import { useState } from "react";
import { interactionKindLabel, type InteractionKind } from "../../lib/capture/interaction";
import { toLocalDateTimeValue } from "../../lib/capture/scheduling";

const kinds: InteractionKind[] = ["call", "email", "meeting", "visit", "note", "personal", "text"];

// Deliberately two separate, differently-labeled, differently-styled
// actions -- never one button that could be mistaken for the other.
// "Remove from this activity" only ever affects the current donor; "Delete
// shared activity" is destructive to every linked donor and gets its own,
// stronger confirmation wording.
export function SharedActivityActions({ sharedActivityId, donorId, initialSummary, initialType, initialOccurredAt, recipientCount }: {
  sharedActivityId: string;
  donorId: string;
  initialSummary: string;
  initialType: string;
  initialOccurredAt: number;
  // How many donors this activity is currently linked to -- shown in the
  // edit warning so "this affects everyone" is a concrete number, not a
  // vague caveat. Never used to gate behavior, only to inform it.
  recipientCount: number;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [summary, setSummary] = useState(initialSummary);
  const [type, setType] = useState<InteractionKind>(kinds.includes(initialType as InteractionKind) ? (initialType as InteractionKind) : "note");
  const [occurredAt, setOccurredAt] = useState(() => toLocalDateTimeValue(new Date(initialOccurredAt * 1000)));
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [message, setMessage] = useState("");

  async function saveEdit() {
    setStatus("saving");
    setMessage("");
    try {
      const response = await fetch(`/api/interactions/shared/${encodeURIComponent(sharedActivityId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ summary, type, occurredAt: new Date(occurredAt).toISOString() }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "The shared activity could not be updated.");
      window.location.reload();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The shared activity could not be updated.");
    }
  }

  async function removeSelf() {
    if (!window.confirm("Remove this donor from the shared activity? Other linked donors and the activity itself are not affected.")) return;
    setStatus("saving");
    try {
      const response = await fetch(`/api/interactions/shared/${encodeURIComponent(sharedActivityId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove-recipient", donorId }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not remove this donor.");
      window.location.reload();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not remove this donor.");
    }
  }

  async function deleteWhole() {
    if (!window.confirm("Delete this shared activity entirely? This removes it from every linked donor's timeline, not just this one. This cannot be undone from here.")) return;
    setStatus("saving");
    try {
      const response = await fetch(`/api/interactions/shared/${encodeURIComponent(sharedActivityId)}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete-activity" }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "The shared activity could not be deleted.");
      window.location.reload();
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "The shared activity could not be deleted.");
    }
  }

  return <div className="shared-activity-actions-wrap">
    <details open={editOpen} onToggle={(event) => setEditOpen((event.target as HTMLDetailsElement).open)}>
      <summary>Edit shared activity</summary>
      <div className="shared-activity-edit-form">
        <p className="shared-activity-edit-warning">This change affects all {recipientCount} donor{recipientCount === 1 ? "" : "s"} linked to this activity -- it edits the one shared summary, type, and date, not just {"this donor's"} copy.</p>
        <label>Type<select value={type} onChange={(event) => setType(event.target.value as InteractionKind)}>
          {kinds.map((kind) => <option key={kind} value={kind}>{interactionKindLabel(kind)}</option>)}
        </select></label>
        <label>Date &amp; time<input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} /></label>
        <label>Summary<textarea value={summary} onChange={(event) => setSummary(event.target.value)} /></label>
        <button type="button" disabled={status === "saving" || summary.trim().length < 4} onClick={saveEdit}>{status === "saving" ? "Saving…" : `Save for all ${recipientCount} donors`}</button>
      </div>
    </details>
    <div className="shared-activity-actions">
      {/* A separate, non-destructive path for donor-specific context (e.g.
          one recipient of a 20-donor broadcast replies with something
          unique) -- reuses the existing single-donor capture form exactly
          as-is (prefilled via ?donorId=, the same pattern as the donor
          page's own "+ Log interaction" link) rather than forking the
          shared content or inventing new schema. This always creates an
          ordinary, independent interactions row (shared_activity_id and
          role both null) -- it can never touch the shared parent or any
          other donor's timeline. */}
      <a className="shared-activity-note-link" href={`/capture?donorId=${encodeURIComponent(donorId)}`}>Add note for this donor</a>
      <button type="button" disabled={status === "saving"} onClick={removeSelf}>Remove this donor from the activity</button>
      <button type="button" className="danger-button" disabled={status === "saving"} onClick={deleteWhole}>Delete shared activity</button>
    </div>
    {status === "error" && message && <small role="alert">{message}</small>}
  </div>;
}
