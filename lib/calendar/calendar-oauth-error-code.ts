// Pure, dependency-free parsing for Google's OAuth 2.0 token-endpoint
// error response shape (`{"error": "...", "error_description": "..."}`,
// RFC 6749 section 5.2). A deliberate DUPLICATE of
// lib/agenda/oauth-error-code.ts's own identical logic, never an import
// of it -- tests/calendar-sweep-agenda-independence.test.mjs enforces
// (as a previously reviewed, load-bearing invariant) that lib/calendar/
// and lib/agenda/ import NOTHING from each other, so the two feature's
// dependency graphs stay completely disjoint regardless of how each is
// eventually wired into a cron. Keep any future change to the allowlist
// in sync with that file's own copy by hand.
//
// Narrow by construction: this module only ever returns one of a fixed,
// known-safe set of standard OAuth 2.0 error *codes*, or null -- never
// the raw response body, `error_description`, or any code outside this
// allowlist.

const ALLOWLISTED_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "deleted_client",
]);

export function extractAllowlistedOAuthErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  if (typeof code !== "string") return null;
  return ALLOWLISTED_OAUTH_ERROR_CODES.has(code) ? code : null;
}
