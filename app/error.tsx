"use client";

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="assistant-hero">
      <div className="ai-orb">!</div>
      <h1>Something interrupted the workspace.</h1>
      <p>Your information is safe. Try loading this view again.</p>
      <button className="full-button" onClick={reset}>Try again</button>
    </main>
  );
}
