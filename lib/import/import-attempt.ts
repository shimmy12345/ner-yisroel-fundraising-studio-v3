// Idempotency and outcome-recovery logic for a single donation-import
// commit attempt. Each commit gets an attemptId, recorded in `data_imports`
// as soon as the request starts processing (before any heavy work), so a
// lost response can always be reconciled later by looking that id up --
// this is the "did it actually write?" question a bare fetch() failure
// cannot answer on its own.

export type ImportAttemptStatus = "processing" | "completed" | "failed" | string;
export type ImportAttemptRow = { id: string; status: ImportAttemptStatus; report_json: string; created_at: number };

// How long a "processing" attempt is still plausibly running. Comfortably
// above realistic commit-path execution time; past this, the Worker almost
// certainly died mid-request and the outcome cannot be trusted either way.
export const ATTEMPT_STILL_PROCESSING_WINDOW_SECONDS = 120;

// What the commit route itself should do when a request arrives with an
// attemptId that already has a row:
// - "replay": the attempt already completed. Return the stored report
//   as-is -- never re-run the financial write for the same attemptId.
// - "reject_in_progress": another invocation of this exact attempt is (or
//   was) mid-flight. Refuse to run a second write concurrently; direct the
//   caller to the status endpoint instead of guessing.
// - "run": no attempt exists yet, or the prior one cleanly failed (and so
//   provably wrote nothing) -- safe to (re-)run under the same id.
export type AttemptCommitAction = "run" | "replay" | "reject_in_progress";

export function resolveAttemptCommitAction(existing: ImportAttemptRow | null | undefined): AttemptCommitAction {
  if (!existing) return "run";
  if (existing.status === "completed") return "replay";
  if (existing.status === "processing") return "reject_in_progress";
  return "run";
}

// What the status endpoint reports. "unknown" is returned instead of
// guessing whenever the true outcome cannot be established -- never claim
// "not written" just because the response was lost.
export type AttemptOutcomeStatus = "committed" | "not_committed" | "processing" | "unknown";

export function classifyAttemptOutcome(existing: ImportAttemptRow | null | undefined, now: number): AttemptOutcomeStatus {
  if (!existing) return "not_committed";
  if (existing.status === "completed") return "committed";
  if (existing.status === "failed") return "not_committed";
  if (existing.status === "processing") {
    return now - existing.created_at <= ATTEMPT_STILL_PROCESSING_WINDOW_SECONDS ? "processing" : "unknown";
  }
  return "unknown";
}
