"use client";

import { useState } from "react";

// Mirrors CompletePriorityButton.tsx exactly, posting to /dismiss instead
// of /complete. Local Fundraising OS state only -- see
// app/api/recommendations/[id]/dismiss/route.ts.
export function DismissPriorityButton({ recommendationId, onOptimisticDismiss, onDismissFailed }: { recommendationId: string; onOptimisticDismiss?: () => void; onDismissFailed?: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "dismissed" | "error">("idle");

  async function dismiss() {
    if (state === "saving") return;
    setState("saving");
    onOptimisticDismiss?.();
    try {
      const response = await fetch(`/api/recommendations/${encodeURIComponent(recommendationId)}/dismiss`, { method: "POST" });
      if (!response.ok) throw new Error("Dismiss failed");
      setState("dismissed");
    } catch {
      setState("error");
      onDismissFailed?.();
    }
  }

  if (state === "dismissed") return null;
  return <button type="button" className="dismiss-priority-button" onClick={dismiss} disabled={state === "saving"}>
    {state === "saving" ? "Dismissing…" : state === "error" ? "Try again" : "Dismiss"}
  </button>;
}
