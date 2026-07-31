"use client";

import { useMemo, useState } from "react";
import type { WorkspaceBrief } from "../../lib/workspace/live-data";
import { useBriefSpeech } from "./useBriefSpeech";

export function createBriefText(data: WorkspaceBrief) {
  const priorities = data.priorities.map((item, index) => `${index + 1}. ${item.name}. ${item.reason}. ${item.why} Recommended action: ${item.action}.`).join(" ") || "No current priorities.";
  const meetings = data.meetings.map((item) => `${item.time} ${item.period}, ${item.title}, ${item.detail}.`).join(" ") || "No upcoming meetings recorded.";
  const gifts = data.gifts.map((item) => `${item.name}, ${item.amount}, ${item.detail}.`).join(" ") || "No recent gifts recorded.";
  return `Your full morning brief. ${data.overview} Top priorities. ${priorities} Upcoming meetings. ${meetings} Recent gifts. ${gifts} Recommended focus. ${data.recommendation}`;
}

export function BriefExperience({ surface, data }: { surface: "today" | "assistant"; data: WorkspaceBrief }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const briefText = useMemo(() => createBriefText(data), [data]);
  const speech = useBriefSpeech(briefText);
  const id = `${surface}-full-brief`;
  const active = ["loading", "playing", "paused"].includes(speech.state);
  return <section className={`assistant-brief brief-experience-${surface}`} aria-labelledby={`${surface}-brief-title`}>
    <div className="assistant-brief-heading"><div><p className="eyebrow">TODAY’S BRIEF · LIVE WORKSPACE</p><h2 id={`${surface}-brief-title`}>Your complete morning briefing</h2></div><span className="assistant-brief-duration">Current data</span></div>
    <p className="assistant-brief-overview">{data.overview}</p>
    <div className="assistant-brief-actions">
      <button className="assistant-brief-primary" type="button" onClick={speech.play} disabled={speech.state === "unsupported" || speech.state === "loading"} aria-busy={speech.state === "loading"}>{speech.state === "loading" ? "Starting…" : speech.state === "playing" ? "Playing…" : "Listen to full brief"}</button>
      <button type="button" onClick={speech.pause} disabled={speech.state !== "playing"}>Pause</button><button type="button" onClick={speech.resume} disabled={speech.state !== "paused"}>Resume</button><button type="button" onClick={speech.stop} disabled={!active}>Stop</button>
      <button className="assistant-read-brief" type="button" onClick={() => setIsExpanded((value) => !value)} aria-expanded={isExpanded} aria-controls={id}>{isExpanded ? "Collapse full brief" : "Read full brief"}</button>
    </div>
    {speech.message && <p className={`assistant-speech-status ${speech.state === "error" || speech.state === "unsupported" ? "error" : ""}`} role="status" aria-live="polite">{speech.message}</p>}
    {isExpanded && <article className="assistant-full-brief" id={id}>
      <div className="assistant-full-brief-heading"><h3>Full brief</h3><button type="button" onClick={() => setIsExpanded(false)} aria-label={`Close ${surface} full brief`}>Close</button></div><p>{data.overview}</p>
      <section><h4>Top priorities</h4>{data.priorities.length ? <ol>{data.priorities.map((item) => <li key={item.donorId}><strong>{item.name}</strong><span>{item.reason}. {item.why} Recommended action: {item.action}.</span></li>)}</ol> : <p>No time-sensitive priorities are available.</p>}</section>
      <div className="assistant-brief-columns"><section><h4>Upcoming meetings</h4>{data.meetings.length ? <ul>{data.meetings.map((item) => <li key={`${item.donorId}-${item.time}`}><strong>{item.time} {item.period}</strong><span>{item.title} · {item.detail}</span></li>)}</ul> : <p>No upcoming meetings are recorded.</p>}</section><section><h4>Recent gifts</h4>{data.gifts.length ? <ul>{data.gifts.map((item) => <li key={item.id}><strong>{item.name} · {item.amount}</strong><span>{item.detail}</span></li>)}</ul> : <p>No recent gifts are recorded.</p>}</section></div>
      <section className="assistant-brief-focus"><h4>Recommended focus</h4><p>{data.recommendation}</p></section><button className="assistant-collapse-brief" type="button" onClick={() => setIsExpanded(false)}>Collapse full brief</button>
    </article>}
  </section>;
}
