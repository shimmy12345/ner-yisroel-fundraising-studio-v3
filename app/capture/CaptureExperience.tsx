"use client";

import { useMemo, useState } from "react";

const example = "Coffee with Elena at Tatte. She loved Maya’s research update and said she and David want to visit campus this fall. David would like the latest scholarship outcomes before they choose a date. I promised to send the brief tomorrow and follow up next week.";
type SaveResult = { interactionId: string; extracted: { type: string; sentiment: string; commitments: string[]; memory: string; nextAction: string } };

export function CaptureExperience() {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [result, setResult] = useState<SaveResult | null>(null);
  const ready = note.trim().length >= 12;
  const preview = useMemo(() => ({
    type: /coffee|lunch|met|meeting/i.test(note) ? "In-person meeting" : "Interaction",
    sentiment: /loved|excited|strong|interested/i.test(note) ? "Warm, engaged" : "Neutral",
    commitments: /send|promised|follow up/i.test(note) ? ["Send scholarship outcomes", "Follow up next week"] : [],
    memory: /David/i.test(note) ? "David wants outcomes before scheduling a fall visit." : "AI will identify durable relationship context.",
  }), [note]);

  async function saveInteraction() {
    if (!ready || status === "saving") return;
    setStatus("saving");
    try {
      const response = await fetch("/api/interactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId: "elena-chen", note }),
      });
      if (!response.ok) throw new Error("Save failed");
      setResult(await response.json() as SaveResult);
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }

  if (status === "saved" && result) {
    return (
      <main className="capture-page capture-success">
        <div className="success-mark">✓</div>
        <p className="eyebrow">INTERACTION CAPTURED</p>
        <h1>Relationship context is up to date.</h1>
        <p className="capture-lede">Your note was saved once. Fundraising OS handled the structure and carried it everywhere it belongs.</p>
        <section className="update-receipt" aria-label="Updated relationship surfaces">
          <article><span>↗</span><div><strong>Timeline updated</strong><p>Coffee meeting added for today.</p></div><b>Done</b></article>
          <article><span>◇</span><div><strong>Institutional memory updated</strong><p>{result.extracted.memory}</p></div><b>Done</b></article>
          <article><span>✦</span><div><strong>Relationship summary refreshed</strong><p>Fall campus visit interest and current momentum are now reflected.</p></div><b>Done</b></article>
          <article><span>→</span><div><strong>Next actions created</strong><p>{result.extracted.nextAction}</p></div><b>Done</b></article>
        </section>
        <div className="success-actions">
          <a className="capture-primary" href="/donors/elena-chen">View updated relationship <span>→</span></a>
          <button onClick={() => { setNote(""); setResult(null); setStatus("idle"); }}>Log another</button>
        </div>
      </main>
    );
  }

  return (
    <main className="capture-page">
      <header className="capture-header">
        <div><p className="eyebrow">CAPTURE LAYER</p><h1>What happened?</h1><p className="capture-lede">Write it the way you would tell a colleague. AI will organize the rest.</p></div>
        <a href="/donors/elena-chen" aria-label="Close interaction capture">×</a>
      </header>
      <div className="capture-layout">
        <section className="capture-composer-card">
          <div className="capture-context">
            <div className="mini-avatar" style={{ background: "#d9e8df" }}>EC</div>
            <div><strong>Elena & David Chen</strong><span>Detected from where you started</span></div>
            <button aria-label="Change donor">Change</button>
          </div>
          <textarea autoFocus value={note} onChange={(event) => { setNote(event.target.value); setStatus("idle"); }} placeholder="Example: Coffee with Elena. She loved Maya’s update and wants to visit campus this fall. I promised to send the outcomes brief tomorrow…" aria-label="Describe the interaction" />
          <div className="capture-tools">
            <div><span>Today, 4:42 PM</span><span>Private to your team</span></div>
            <button className="example-button" onClick={() => setNote(example)}>Use example</button>
          </div>
          {ready && (
            <div className="extraction-preview" aria-live="polite">
              <div className="extraction-heading"><span>✦</span><strong>Understood</strong><small>Nothing else required</small></div>
              <div className="extraction-chips"><span>{preview.type}</span><span>{preview.sentiment}</span><span>Today</span>{preview.commitments.length > 0 && <span>{preview.commitments.length} commitments</span>}</div>
              <div className="extracted-detail"><label>New relationship memory</label><p>{preview.memory}</p></div>
            </div>
          )}
          {status === "error" && <p className="capture-error">The interaction could not be saved. Your note is still here—try again.</p>}
          <button className="capture-save" disabled={!ready || status === "saving"} onClick={saveInteraction}>{status === "saving" ? "Updating relationship…" : <>Save interaction <span>⌘ ↵</span></>}</button>
          <p className="capture-assurance">Reviewable and reversible. Fundraising OS never sends messages automatically.</p>
        </section>
        <aside className="automation-panel">
          <p className="eyebrow">ONE NOTE, USED EVERYWHERE</p><h2>No duplicate entry.</h2>
          <p>Your words stay intact as the source. AI proposes structure and updates the relationship around it.</p>
          <div className="automation-flow">
            <article><span>1</span><div><strong>Timeline</strong><p>Adds the interaction with date and channel</p></div></article>
            <article><span>2</span><div><strong>Institutional memory</strong><p>Preserves durable personal context</p></div></article>
            <article><span>3</span><div><strong>AI relationship summary</strong><p>Refreshes the story and momentum</p></div></article>
            <article><span>4</span><div><strong>Suggested next actions</strong><p>Turns commitments into follow-through</p></div></article>
          </div>
          <div className="trust-note"><span>✓</span><p><strong>You stay in control.</strong> AI shows what it inferred and keeps the original note as the source of truth.</p></div>
        </aside>
      </div>
    </main>
  );
}
