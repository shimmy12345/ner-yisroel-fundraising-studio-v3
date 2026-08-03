"use client";

import { useState } from "react";

export function ActivityActions({ activityId, editHref, scheduled, canCancel }: { activityId: string; editHref: string; scheduled: boolean; canCancel: boolean }) {
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const action = scheduled ? "cancel" : "archive";
  const showStateAction = scheduled ? canCancel : true;

  async function changeState() {
    const message = scheduled ? "Cancel this future scheduled activity? It will leave Today and Upcoming but remain marked as cancelled in the donor timeline." : "Archive this completed interaction? It will leave the active timeline but remain preserved in the database.";
    if (!window.confirm(message)) return;
    setStatus("saving");
    try {
      const response = await fetch(`/api/interactions/${encodeURIComponent(activityId)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || "The activity could not be updated.");
      window.location.reload();
    } catch {
      setStatus("error");
    }
  }

  return <div className="activity-actions">
    <a href={editHref}>Edit</a>
    {showStateAction && <button type="button" onClick={changeState} disabled={status === "saving"}>{status === "saving" ? "Updating…" : scheduled ? "Cancel" : "Archive"}</button>}
    {status === "error" && <small role="alert">Could not update activity. Try again.</small>}
  </div>;
}
