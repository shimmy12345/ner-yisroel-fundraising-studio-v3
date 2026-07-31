"use client";

import { useMemo, useState } from "react";
import { todayData } from "../data";
import { useBriefSpeech } from "./useBriefSpeech";

type BriefExperienceProps = {
  surface: "today" | "assistant";
};

const overview =
  "You have a strong opening with the Chen family today. Their recent engagement and upcoming anniversary make this a natural moment to reconnect. Two thank-yous are also approaching the 48-hour mark.";

const recommendation =
  "Lead the Chen meeting with Maya Rodriguez’s progress and give David the program outcomes he requested. After the meeting, prioritize Marcus Williams’s thank-you while his recent gift is still within the strongest personal-outreach window.";

export function createBriefText() {
  const priorities = todayData.priorities
    .map(
      (priority, index) =>
        `${index + 1}. ${priority.name}. ${priority.reason}. ${priority.why} Recommended action: ${priority.action}.`,
    )
    .join(" ");
  const meetings = todayData.meetings
    .map((meeting) => `${meeting.time} ${meeting.period}, ${meeting.title}, ${meeting.detail}.`)
    .join(" ");
  const gifts = todayData.gifts
    .map((gift) => `${gift.name}, ${gift.amount}, ${gift.detail}.`)
    .join(" ");

  return `Your full morning brief. ${overview} Top priorities. ${priorities} Today’s meetings. ${meetings} New gifts. ${gifts} Recommended focus. ${recommendation}`;
}

export function BriefExperience({ surface }: BriefExperienceProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const briefText = useMemo(createBriefText, []);
  const speech = useBriefSpeech(briefText);
  const id = `${surface}-full-brief`;
  const headingId = `${surface}-brief-title`;
  const canListen = speech.state !== "unsupported";
  const isActive = speech.state === "loading" || speech.state === "playing" || speech.state === "paused";

  return (
    <section className={`assistant-brief brief-experience-${surface}`} aria-labelledby={headingId}>
      <div className="assistant-brief-heading">
        <div>
          <p className="eyebrow">TODAY’S BRIEF</p>
          <h2 id={headingId}>Your complete morning briefing</h2>
        </div>
        <span className="assistant-brief-duration">About 2 minutes</span>
      </div>
      <p className="assistant-brief-overview">{overview}</p>

      <div className="assistant-brief-actions">
        <button
          className="assistant-brief-primary"
          type="button"
          onClick={speech.play}
          disabled={!canListen || speech.state === "loading"}
          aria-busy={speech.state === "loading"}
        >
          {speech.state === "loading" ? "Starting…" : speech.state === "playing" ? "Playing…" : "Listen to full brief"}
        </button>
        <button type="button" onClick={speech.pause} disabled={speech.state !== "playing"}>Pause</button>
        <button type="button" onClick={speech.resume} disabled={speech.state !== "paused"}>Resume</button>
        <button type="button" onClick={speech.stop} disabled={!isActive}>Stop</button>
        <button
          className="assistant-read-brief"
          type="button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          aria-expanded={isExpanded}
          aria-controls={id}
        >
          {isExpanded ? "Collapse full brief" : "Read full brief"}
        </button>
      </div>

      {speech.message && (
        <p className={`assistant-speech-status ${speech.state === "error" || speech.state === "unsupported" ? "error" : ""}`} role="status" aria-live="polite">
          {speech.message}
        </p>
      )}

      {isExpanded && (
        <article className="assistant-full-brief" id={id}>
          <div className="assistant-full-brief-heading">
            <h3>Full brief</h3>
            <button type="button" onClick={() => setIsExpanded(false)} aria-label={`Close ${surface} full brief`}>Close</button>
          </div>
          <p>{overview}</p>

          <section aria-labelledby={`${surface}-brief-priorities`}>
            <h4 id={`${surface}-brief-priorities`}>Top priorities</h4>
            <ol>
              {todayData.priorities.map((priority) => (
                <li key={priority.name}>
                  <strong>{priority.name}</strong>
                  <span>{priority.reason}. {priority.why} Recommended action: {priority.action}.</span>
                </li>
              ))}
            </ol>
          </section>

          <div className="assistant-brief-columns">
            <section aria-labelledby={`${surface}-brief-meetings`}>
              <h4 id={`${surface}-brief-meetings`}>Today’s meetings</h4>
              <ul>
                {todayData.meetings.map((meeting) => (
                  <li key={`${meeting.time}-${meeting.title}`}>
                    <strong>{meeting.time} {meeting.period}</strong>
                    <span>{meeting.title} · {meeting.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby={`${surface}-brief-gifts`}>
              <h4 id={`${surface}-brief-gifts`}>New gifts</h4>
              <ul>
                {todayData.gifts.map((gift) => (
                  <li key={gift.name}>
                    <strong>{gift.name} · {gift.amount}</strong>
                    <span>{gift.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section className="assistant-brief-focus" aria-labelledby={`${surface}-brief-focus`}>
            <h4 id={`${surface}-brief-focus`}>Recommended focus</h4>
            <p>{recommendation}</p>
          </section>
          <button className="assistant-collapse-brief" type="button" onClick={() => setIsExpanded(false)}>
            Collapse full brief
          </button>
        </article>
      )}
    </section>
  );
}
