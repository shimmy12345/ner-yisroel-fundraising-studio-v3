"use client";

import { useState } from "react";

export function CompletePriorityButton({ recommendationId, onOptimisticComplete, onCompleteFailed }: { recommendationId: string; onOptimisticComplete?: () => void; onCompleteFailed?: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "completed" | "error">("idle");

  async function complete() {
    if (state === "saving") return;
    setState("saving");
    onOptimisticComplete?.();
    try {
      const response = await fetch(`/api/recommendations/${encodeURIComponent(recommendationId)}/complete`, { method: "POST" });
      if (!response.ok) throw new Error("Completion failed");
      setState("completed");
    } catch {
      setState("error");
      onCompleteFailed?.();
    }
  }

  if (state === "completed") return null;
  return <button type="button" className="complete-priority-button" onClick={complete} disabled={state === "saving"}>
    {state === "saving" ? "Completing…" : state === "error" ? "Try again" : "Complete"}
  </button>;
}
