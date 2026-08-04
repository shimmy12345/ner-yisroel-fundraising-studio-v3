"use client";

import { useState } from "react";

export function DismissQueueSuggestionButton({ queueId, donorId }: { queueId: string; donorId: string }) {
  const [state, setState] = useState<"idle" | "saving" | "dismissed" | "error">("idle");

  async function update(method: "POST" | "DELETE") {
    if (state === "saving") return;
    setState("saving");
    try {
      const response = await fetch("/api/relationship-queue/dismiss", { method, headers: { "content-type": "application/json" }, body: JSON.stringify({ queueId, donorId }) });
      if (!response.ok) throw new Error("Update failed");
      if (method === "DELETE") setState("idle");
      else setState("dismissed");
    } catch {
      setState("error");
    }
  }

  if (state === "dismissed") return <span className="queue-dismissed" role="status">Dismissed <button type="button" onClick={() => void update("DELETE")}>Undo</button></span>;
  return <button type="button" className="dismiss-queue-button" disabled={state === "saving"} onClick={() => void update("POST")}>{state === "saving" ? "Dismissing…" : state === "error" ? "Try dismiss again" : "Dismiss suggestion"}</button>;
}
