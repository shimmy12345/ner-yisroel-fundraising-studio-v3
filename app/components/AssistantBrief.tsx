"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { todayData } from "../data";

type SpeechState = "idle" | "loading" | "playing" | "paused" | "error" | "unsupported";

const overview =
  "You have a strong opening with the Chen family today. Their recent engagement and upcoming anniversary make this a natural moment to reconnect. Two thank-yous are also approaching the 48-hour mark.";

const recommendation =
  "Lead the Chen meeting with Maya Rodriguez’s progress and give David the program outcomes he requested. After the meeting, prioritize Marcus Williams’s thank-you while his recent gift is still within the strongest personal-outreach window.";

function createBriefText() {
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

export function AssistantBrief() {
  const [isExpanded, setIsExpanded] = useState(false);
  const [speechState, setSpeechState] = useState<SpeechState>("idle");
  const [speechMessage, setSpeechMessage] = useState("");
  const sessionRef = useRef(0);
  const briefText = useMemo(createBriefText, []);

  useEffect(() => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setSpeechState("unsupported");
      setSpeechMessage("Listening is not supported in this browser. You can still read the complete brief below.");
    }

    return () => {
      sessionRef.current += 1;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  const play = () => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setSpeechState("unsupported");
      setSpeechMessage("Listening is not supported in this browser. You can still read the complete brief below.");
      return;
    }

    try {
      sessionRef.current += 1;
      const session = sessionRef.current;
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(briefText);
      utterance.rate = 0.96;
      utterance.pitch = 1;
      utterance.onstart = () => {
        if (session !== sessionRef.current) return;
        setSpeechState("playing");
        setSpeechMessage("Playing the full brief.");
      };
      utterance.onpause = () => {
        if (session !== sessionRef.current) return;
        setSpeechState("paused");
        setSpeechMessage("Full brief paused.");
      };
      utterance.onresume = () => {
        if (session !== sessionRef.current) return;
        setSpeechState("playing");
        setSpeechMessage("Playing the full brief.");
      };
      utterance.onend = () => {
        if (session !== sessionRef.current) return;
        setSpeechState("idle");
        setSpeechMessage("Full brief finished.");
      };
      utterance.onerror = (event) => {
        if (session !== sessionRef.current) return;
        if (event.error === "canceled" || event.error === "interrupted") {
          setSpeechState("idle");
          setSpeechMessage("Playback stopped.");
          return;
        }
        setSpeechState("error");
        setSpeechMessage("The brief could not be played. Please try again or read it below.");
      };

      setSpeechState("loading");
      setSpeechMessage("Starting the full brief…");
      window.speechSynthesis.speak(utterance);
    } catch {
      setSpeechState("error");
      setSpeechMessage("The brief could not be played. Please try again or read it below.");
    }
  };

  const pause = () => {
    if (!("speechSynthesis" in window) || speechState !== "playing") return;
    try {
      window.speechSynthesis.pause();
    } catch {
      setSpeechState("error");
      setSpeechMessage("Playback could not be paused. Stop it and try again.");
    }
  };

  const resume = () => {
    if (!("speechSynthesis" in window) || speechState !== "paused") return;
    try {
      window.speechSynthesis.resume();
    } catch {
      setSpeechState("error");
      setSpeechMessage("Playback could not be resumed. Start the brief again.");
    }
  };

  const stop = () => {
    if (!("speechSynthesis" in window)) return;
    sessionRef.current += 1;
    window.speechSynthesis.cancel();
    setSpeechState("idle");
    setSpeechMessage("Playback stopped.");
  };

  const canListen = speechState !== "unsupported";
  const isActive = speechState === "loading" || speechState === "playing" || speechState === "paused";

  return (
    <section className="assistant-brief" aria-labelledby="assistant-brief-title">
      <div className="assistant-brief-heading">
        <div>
          <p className="eyebrow">TODAY’S BRIEF</p>
          <h2 id="assistant-brief-title">Your complete morning briefing</h2>
        </div>
        <span className="assistant-brief-duration">About 2 minutes</span>
      </div>
      <p className="assistant-brief-overview">{overview}</p>

      <div className="assistant-brief-actions">
        <button
          className="assistant-brief-primary"
          type="button"
          onClick={play}
          disabled={!canListen || speechState === "loading"}
          aria-busy={speechState === "loading"}
        >
          {speechState === "loading" ? "Starting…" : speechState === "playing" ? "Playing…" : "Listen to full brief"}
        </button>
        <button type="button" onClick={pause} disabled={speechState !== "playing"}>Pause</button>
        <button type="button" onClick={resume} disabled={speechState !== "paused"}>Resume</button>
        <button type="button" onClick={stop} disabled={!isActive}>Stop</button>
        <button
          className="assistant-read-brief"
          type="button"
          onClick={() => setIsExpanded((expanded) => !expanded)}
          aria-expanded={isExpanded}
          aria-controls="assistant-full-brief"
        >
          {isExpanded ? "Collapse full brief" : "Read full brief"}
        </button>
      </div>

      {speechMessage && (
        <p className={`assistant-speech-status ${speechState === "error" || speechState === "unsupported" ? "error" : ""}`} role="status" aria-live="polite">
          {speechMessage}
        </p>
      )}

      {isExpanded && (
        <article className="assistant-full-brief" id="assistant-full-brief">
          <div className="assistant-full-brief-heading">
            <h3>Full brief</h3>
            <button type="button" onClick={() => setIsExpanded(false)} aria-label="Close full brief">Close</button>
          </div>
          <p>{overview}</p>

          <section aria-labelledby="brief-priorities">
            <h4 id="brief-priorities">Top priorities</h4>
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
            <section aria-labelledby="brief-meetings">
              <h4 id="brief-meetings">Today’s meetings</h4>
              <ul>
                {todayData.meetings.map((meeting) => (
                  <li key={`${meeting.time}-${meeting.title}`}>
                    <strong>{meeting.time} {meeting.period}</strong>
                    <span>{meeting.title} · {meeting.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="brief-gifts">
              <h4 id="brief-gifts">New gifts</h4>
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

          <section className="assistant-brief-focus" aria-labelledby="brief-focus">
            <h4 id="brief-focus">Recommended focus</h4>
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
