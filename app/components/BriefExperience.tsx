"use client";

import { useEffect, useMemo, useState } from "react";
import type { WorkspaceBrief } from "../../lib/workspace/live-data";
import { useBriefSpeech } from "./useBriefSpeech";

export function createBriefText(data: WorkspaceBrief) {
  const priorities = data.priorities.map((item, index) => `${index + 1}. ${item.name}. ${item.reason}. ${item.why} Recommended action: ${item.action}.`).join(" ") || "No current priorities.";
  const todaySchedule = data.todaySchedule.map((item) => `${item.time} ${item.period}, ${item.typeLabel} with ${item.donorName}, ${item.subject}.`).join(" ") || "No relationship activities are scheduled for today.";
  const upcoming = data.upcomingActivities.map((item) => `${item.date} at ${item.time} ${item.period}, ${item.typeLabel} with ${item.donorName}, ${item.subject}.`).join(" ") || "No future relationship activities are scheduled.";
  const gifts = data.gifts.map((item) => `${item.name}, ${item.amount}, ${item.detail}.`).join(" ") || "No recent gifts recorded.";
  return `Your full morning brief. ${data.overview} Today’s schedule. ${todaySchedule} Upcoming activities. ${upcoming} Top priorities. ${priorities} Recent gifts. ${gifts} Recommended focus. ${data.recommendation}`;
}

export function BriefExperience({ surface, data }: { surface: "today" | "assistant"; data: WorkspaceBrief }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [completedToday, setCompletedToday] = useState(false);
  const [showAgain, setShowAgain] = useState(false);
  const briefText = useMemo(() => createBriefText(data), [data]);
  const speech = useBriefSpeech(briefText);
  const id = `${surface}-full-brief`;
  const active = ["loading", "playing", "paused"].includes(speech.state);
  const completionKey = useMemo(() => `fundraising-os:morning-brief:${new Date().toLocaleDateString("en-CA")}`, []);

  useEffect(() => {
    if (surface === "today" && window.localStorage.getItem(completionKey) === "completed") setCompletedToday(true);
  }, [completionKey, surface]);

  useEffect(() => {
    if (surface === "today" && speech.message === "Full brief finished.") {
      window.localStorage.setItem(completionKey, "completed");
      setCompletedToday(true);
      setShowAgain(false);
      setIsExpanded(false);
    }
  }, [completionKey, speech.message, surface]);

  function markComplete() {
    if (surface !== "today") return;
    window.localStorage.setItem(completionKey, "completed");
    setCompletedToday(true);
  }

  function readBrief() {
    const next = !isExpanded;
    setIsExpanded(next);
    if (next) {
      markComplete();
      setShowAgain(true);
    } else {
      setShowAgain(false);
    }
  }

  if (surface === "today" && completedToday && !showAgain) return <section className="morning-brief-complete" aria-labelledby={`${surface}-brief-title`}><span aria-hidden="true">✓</span><div><h3 id={`${surface}-brief-title`}>Morning Brief completed today</h3><p>{data.overview}</p></div><button type="button" onClick={() => { setShowAgain(true); setIsExpanded(true); }}>Read Again</button></section>;

  return <section className={`assistant-brief brief-experience-${surface}`} aria-labelledby={`${surface}-brief-title`}>
    <div className="assistant-brief-heading"><div><p className="eyebrow">{surface === "today" ? "YOUR DAY AT A GLANCE" : "TODAY’S BRIEF · LIVE WORKSPACE"}</p><h2 id={`${surface}-brief-title`}>{surface === "today" ? "Start with the relationships that matter most" : "Your complete morning briefing"}</h2></div>{surface === "assistant" && <span className="assistant-brief-duration">Current data</span>}</div>
    <p className="assistant-brief-overview">{data.overview}</p>
    <div className="assistant-brief-actions">
      <button className="assistant-brief-primary" type="button" onClick={speech.play} disabled={speech.state === "unsupported" || speech.state === "loading"} aria-busy={speech.state === "loading"}>{speech.state === "loading" ? "Starting…" : speech.state === "playing" ? "Playing…" : "Listen to full brief"}</button>
      <button type="button" onClick={speech.pause} disabled={speech.state !== "playing"}>Pause</button><button type="button" onClick={speech.resume} disabled={speech.state !== "paused"}>Resume</button><button type="button" onClick={speech.stop} disabled={!active}>Stop</button>
      <button className="assistant-read-brief" type="button" onClick={readBrief} aria-expanded={isExpanded} aria-controls={id}>{isExpanded ? "Collapse full brief" : "Read full brief"}</button>
      {surface === "today" && <button className="assistant-dismiss-brief" type="button" onClick={() => { speech.stop(); markComplete(); setShowAgain(false); setIsExpanded(false); }}>Dismiss for today</button>}
    </div>
    {speech.message && <p className={`assistant-speech-status ${speech.state === "error" || speech.state === "unsupported" ? "error" : ""}`} role="status" aria-live="polite">{speech.message}</p>}
    {isExpanded && <article className="assistant-full-brief" id={id}>
      <div className="assistant-full-brief-heading"><h3>Full brief</h3><button type="button" onClick={() => { setIsExpanded(false); setShowAgain(false); }} aria-label={`Close ${surface} full brief`}>Close</button></div><p>{data.overview}</p>
      <section><h4>Top priorities</h4>{data.priorities.length ? <ol>{data.priorities.map((item) => <li key={item.donorId}><strong>{item.name}</strong>{item.donorCode && <span className="donor-code">{item.donorCode}</span>}<span>{item.reason}. {item.why} Recommended action: {item.action}.</span></li>)}</ol> : <p>No time-sensitive priorities are available.</p>}</section>
      <div className="assistant-brief-columns"><section><h4>Today’s schedule</h4>{data.todaySchedule.length ? <ul>{data.todaySchedule.map((item) => <li key={item.id}><strong>{item.time} {item.period} · {item.typeLabel}</strong><span>{item.donorName}{item.donorCode ? ` · ${item.donorCode}` : ""} · {item.subject}</span></li>)}</ul> : <p>No relationship activities are scheduled for today.</p>}</section><section><h4>Upcoming activities</h4>{data.upcomingActivities.length ? <ul>{data.upcomingActivities.map((item) => <li key={item.id}><strong>{item.date} · {item.time} {item.period}</strong><span>{item.typeLabel} with {item.donorName}{item.donorCode ? ` · ${item.donorCode}` : ""} · {item.subject}</span></li>)}</ul> : <p>No future relationship activities are scheduled.</p>}</section></div>
      <section><h4>Recent gifts</h4>{data.gifts.length ? <ul>{data.gifts.map((item) => <li key={item.id}><strong>{item.name} · {item.amount}</strong>{item.donorCode && <span className="donor-code">{item.donorCode}</span>}<span>{item.detail}</span></li>)}</ul> : <p>No recent gifts are recorded.</p>}</section>
      <section className="assistant-brief-focus"><h4>Recommended focus</h4><p>{data.recommendation}</p></section><button className="assistant-collapse-brief" type="button" onClick={() => { setIsExpanded(false); setShowAgain(false); }}>Collapse full brief</button>
    </article>}
  </section>;
}
