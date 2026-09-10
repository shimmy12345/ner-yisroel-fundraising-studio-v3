// Interpreting the response from POST /api/interactions/shared
// (docs/AI-HANDOFF.md: the "Failed to execute 'json' on 'Response':
// Unexpected end of JSON input" incident). Pure and DB-free so the full
// response matrix -- 2xx with a body, 2xx with an empty/unparseable body,
// 4xx/5xx with a body, 4xx/5xx empty -- is genuinely unit-testable, unlike
// the route handler itself (which needs the real D1 binding).
//
// The one property this function exists to guarantee: it must NEVER claim
// success, and must NEVER claim "safe to retry" (known_failure), unless the
// server's own JSON body says so explicitly. Anything the body can't prove
// -- including a response that failed to parse as JSON at all -- comes back
// as unknown_outcome, whose whole purpose is to stop the caller from
// re-submitting a write it cannot confirm didn't already happen.

export type SharedSaveResult = { sharedActivityId: string; interactionIds: string[]; recipientCount: number; occurredAt: string; databaseChangesMade: true };

export type SharedActivityOutcome =
  | { kind: "success"; result: SharedSaveResult }
  // The server itself confirmed nothing was written (a validation error, or
  // an exception caught before any write statement ran) -- retrying is
  // genuinely safe.
  | { kind: "known_failure"; message: string }
  // The response could not be read as the expected JSON shape at all -- we
  // cannot prove whether the server wrote anything. Never phrase this as
  // safe to retry.
  | { kind: "unknown_outcome"; message: string }
  // The fetch() call itself never completed (network error, request never
  // reached the server, or the server never responded) -- the request could
  // not have been processed, so retrying is genuinely safe.
  | { kind: "network_failure"; message: string };

export const UNKNOWN_OUTCOME_MESSAGE = "We couldn't confirm whether the interaction was saved. Do not submit again yet -- check the donor timeline before retrying.";
export const NETWORK_FAILURE_MESSAGE = "The shared activity could not be saved. Nothing was sent -- try again.";
const DEFAULT_FAILURE_MESSAGE = "The shared activity could not be saved.";

function isSuccessPayload(value: Record<string, unknown>): value is SharedSaveResult {
  return value.ok === true
    && typeof value.sharedActivityId === "string"
    && Array.isArray(value.interactionIds)
    && typeof value.recipientCount === "number"
    && typeof value.occurredAt === "string";
}

// `payload` is whatever `await response.json()` produced, or `null` if that
// call itself threw (an empty body, non-JSON body, or a truncated stream --
// exactly the incident this exists to handle safely). `responseOk` is the
// fetch Response's own `.ok` (2xx) flag.
export function interpretSharedActivityResponse(responseOk: boolean, payload: unknown): SharedActivityOutcome {
  if (payload === null || typeof payload !== "object") {
    return { kind: "unknown_outcome", message: UNKNOWN_OUTCOME_MESSAGE };
  }
  const record = payload as Record<string, unknown>;
  if (responseOk && isSuccessPayload(record)) {
    return { kind: "success", result: record };
  }
  // ok === false is the server's own explicit "confirmed no write" signal
  // (see app/api/interactions/shared/route.ts -- every validation and
  // pre-write-exception response sets it). A 2xx response that nonetheless
  // fails isSuccessPayload's shape check is treated the same as an explicit
  // failure below, never as success.
  if (record.ok === false) {
    const message = typeof record.error === "string" && record.error ? record.error : DEFAULT_FAILURE_MESSAGE;
    return { kind: "known_failure", message };
  }
  // A body arrived and parsed as JSON, but it matches neither the success
  // shape nor an explicit ok:false failure -- the server's own contract was
  // not followed for whatever produced this response, so the write outcome
  // cannot be trusted either way.
  return { kind: "unknown_outcome", message: UNKNOWN_OUTCOME_MESSAGE };
}
