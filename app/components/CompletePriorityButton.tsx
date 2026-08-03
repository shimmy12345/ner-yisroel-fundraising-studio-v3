"use client";

import { useState } from "react";

export function CompletePriorityButton({ recommendationId }: { recommendationId: string }) {
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");

  async function complete() {
    if (state === "saving") return;
    setState("saving");
    try {
      const response = await fetch(`/api/recommendations/${encodeURIComponent(recommendationId)}/complete`, { method: "POST" });
      if (!response.ok) throw new Error("Completion failed");
      window.location.reload();
    } catch {
      setState("error");
    }
  }

  return <button type="button" className="complete-priority-button" onClick={complete} disabled={state === "saving"}>
    {state === "saving" ? "Completing…" : state === "error" ? "Try again" : "Complete"}
  </button>;
}
