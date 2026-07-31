"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function WelcomeExperience() {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");

  async function continueWithSamples() {
    if (status === "loading") return;
    setStatus("loading");
    try {
      const response = await fetch("/api/onboarding/continue", { method: "POST" });
      if (!response.ok) throw new Error("Continue failed");
      router.refresh();
    } catch {
      setStatus("error");
    }
  }

  return (
    <main className="onboarding-welcome">
      <div className="onboarding-mark">F</div>
      <p className="eyebrow">FUNDRAISING OS</p>
      <h1>Welcome to Fundraising OS.</h1>
      <p>Let&apos;s bring over your existing donor information so your workspace is ready.</p>
      <div className="onboarding-welcome-actions">
        <a className="onboarding-primary" href="/onboarding/import">Import My Donor Data</a>
        <button type="button" onClick={continueWithSamples} disabled={status === "loading"}>
          {status === "loading" ? "Opening sample workspace…" : "Continue with Sample Data"}
        </button>
      </div>
      {status === "error" && <p className="onboarding-error" role="alert">The sample workspace could not be opened. Try again.</p>}
    </main>
  );
}
