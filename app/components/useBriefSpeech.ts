"use client";

import { useEffect, useRef, useState } from "react";

export type SpeechState = "idle" | "loading" | "playing" | "paused" | "error" | "unsupported";

export function useBriefSpeech(text: string) {
  const [state, setState] = useState<SpeechState>("idle");
  const [message, setMessage] = useState("");
  const sessionRef = useRef(0);

  useEffect(() => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setState("unsupported");
      setMessage("Listening is not supported in this browser. You can still read the complete brief.");
    }

    return () => {
      sessionRef.current += 1;
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  const play = () => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      setState("unsupported");
      setMessage("Listening is not supported in this browser. You can still read the complete brief.");
      return;
    }

    try {
      sessionRef.current += 1;
      const session = sessionRef.current;
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.96;
      utterance.pitch = 1;
      utterance.onstart = () => {
        if (session !== sessionRef.current) return;
        setState("playing");
        setMessage("Playing the full brief.");
      };
      utterance.onpause = () => {
        if (session !== sessionRef.current) return;
        setState("paused");
        setMessage("Full brief paused.");
      };
      utterance.onresume = () => {
        if (session !== sessionRef.current) return;
        setState("playing");
        setMessage("Playing the full brief.");
      };
      utterance.onend = () => {
        if (session !== sessionRef.current) return;
        setState("idle");
        setMessage("Full brief finished.");
      };
      utterance.onerror = (event) => {
        if (session !== sessionRef.current) return;
        if (event.error === "canceled" || event.error === "interrupted") {
          setState("idle");
          setMessage("Playback stopped.");
          return;
        }
        setState("error");
        setMessage("The brief could not be played. Please try again or read it below.");
      };

      setState("loading");
      setMessage("Starting the full brief…");
      window.speechSynthesis.speak(utterance);
    } catch {
      setState("error");
      setMessage("The brief could not be played. Please try again or read it below.");
    }
  };

  const pause = () => {
    if (!("speechSynthesis" in window) || state !== "playing") return;
    try {
      window.speechSynthesis.pause();
    } catch {
      setState("error");
      setMessage("Playback could not be paused. Stop it and try again.");
    }
  };

  const resume = () => {
    if (!("speechSynthesis" in window) || state !== "paused") return;
    try {
      window.speechSynthesis.resume();
    } catch {
      setState("error");
      setMessage("Playback could not be resumed. Start the brief again.");
    }
  };

  const stop = () => {
    if (!("speechSynthesis" in window)) return;
    sessionRef.current += 1;
    window.speechSynthesis.cancel();
    setState("idle");
    setMessage("Playback stopped.");
  };

  return { state, message, play, pause, resume, stop };
}
