"use client";

import { useId, useRef, useState } from "react";

// currentDueDate is a plain YYYY-MM-DD calendar date, already resolved in
// the caller's display timezone -- formatted at UTC here (it's already a
// calendar date, not an instant) so this label can never disagree with the
// date the card itself is showing.
const isoDateLabel = (iso: string) => {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(Date.UTC(year, month - 1, day)));
};

// A native <details>/<summary> disclosure (the same pattern already used
// for historical-context-disclosure) gives a touch-friendly, fully
// keyboard-accessible inline popover with no modal/portal machinery --
// Escape closes it without saving, same as Cancel.
export function RescheduleButton({ recommendationId, currentDueDate, onOptimisticReschedule, onRescheduleFailed }: {
  recommendationId: string;
  currentDueDate: string;
  onOptimisticReschedule?: (dueDate: string) => void;
  onRescheduleFailed?: () => void;
}) {
  const [dueDate, setDueDate] = useState(currentDueDate);
  const [savedDueDate, setSavedDueDate] = useState(currentDueDate);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const inputId = useId();

  function cancel() {
    setDueDate(savedDueDate);
    setState("idle");
    if (detailsRef.current) detailsRef.current.open = false;
  }

  async function save() {
    if (state === "saving" || !dueDate) return;
    setState("saving");
    try {
      const response = await fetch(`/api/recommendations/${encodeURIComponent(recommendationId)}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate }),
      });
      if (!response.ok) throw new Error("Reschedule failed");
      setSavedDueDate(dueDate);
      setState("idle");
      if (detailsRef.current) detailsRef.current.open = false;
      onOptimisticReschedule?.(dueDate);
    } catch {
      setState("error");
      onRescheduleFailed?.();
    }
  }

  return <details className="reschedule-control" ref={detailsRef} onKeyDown={(event) => { if (event.key === "Escape") cancel(); }}>
    <summary className="reschedule-priority-button">Reschedule</summary>
    <div className="reschedule-popover">
      <p className="reschedule-current">Currently due {isoDateLabel(savedDueDate)}</p>
      <label htmlFor={inputId}>New due date</label>
      <input id={inputId} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
      {state === "error" && <p className="capture-error" role="alert">Couldn't reschedule -- try again.</p>}
      <div className="reschedule-actions">
        <button type="button" className="secondary-button" onClick={cancel} disabled={state === "saving"}>Cancel</button>
        <button type="button" onClick={save} disabled={state === "saving" || !dueDate}>{state === "saving" ? "Saving…" : "Save"}</button>
      </div>
    </div>
  </details>;
}
