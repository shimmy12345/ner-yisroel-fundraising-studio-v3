// Pure, dependency-free parsing for Google's OAuth 2.0 token-endpoint error
// response shape (`{"error": "...", "error_description": "..."}`, RFC 6749
// section 5.2). Deliberately has NO "cloudflare:workers" import -- unlike
// gmail-client.ts, which can't be imported outside a Workers runtime at all
// -- so this file alone is what's actually unit-tested (same split this
// codebase already uses for mime-message.ts).
//
// Narrow by construction: this module only ever returns one of a fixed,
// known-safe set of standard OAuth 2.0 error *codes*, or null. It never
// returns the raw response body, `error_description` (Google's own free-text
// field, which this module deliberately never reads), or any code outside
// this allowlist -- a malformed body, a non-object body, a missing/non-string
// `error` field, or an unrecognized code all degrade silently to null rather
// than ever surfacing arbitrary server-controlled text in a log line.

const ALLOWLISTED_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  // RFC 6749 section 5.2's full standard set for the token endpoint.
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  // Google's own documented extension, returned when the OAuth client
  // backing client_id has been deleted in Google Cloud Console.
  "deleted_client",
]);

export function extractAllowlistedOAuthErrorCode(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const code = (body as Record<string, unknown>).error;
  if (typeof code !== "string") return null;
  return ALLOWLISTED_OAUTH_ERROR_CODES.has(code) ? code : null;
}
