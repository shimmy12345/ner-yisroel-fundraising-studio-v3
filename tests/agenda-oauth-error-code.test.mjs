import assert from "node:assert/strict";
import { extractAllowlistedOAuthErrorCode } from "../lib/agenda/oauth-error-code.ts";

async function run() {
  // --- Every standard RFC 6749 section 5.2 token-endpoint error code, plus
  // Google's own "deleted_client" extension, is recognized and returned
  // verbatim. ---
  for (const code of [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "deleted_client",
  ]) {
    assert.equal(extractAllowlistedOAuthErrorCode({ error: code }), code);
    assert.equal(
      extractAllowlistedOAuthErrorCode({ error: code, error_description: "some free-text Google wrote" }),
      code,
      "error_description must never affect the result -- only error is ever read",
    );
  }

  // --- A code outside the fixed allowlist is discarded, never returned
  // verbatim -- this is the core safety property: arbitrary server-
  // controlled text must never reach a log line. ---
  assert.equal(extractAllowlistedOAuthErrorCode({ error: "server_error" }), null);
  assert.equal(extractAllowlistedOAuthErrorCode({ error: "<script>alert(1)</script>" }), null);
  assert.equal(
    extractAllowlistedOAuthErrorCode({ error: "invalid_client; client_secret=super-secret-value" }),
    null,
    "a code that merely contains an allowlisted substring, padded with attacker/server-controlled text, must not match",
  );

  // --- Malformed/unexpected shapes all degrade to null, never throw. ---
  assert.equal(extractAllowlistedOAuthErrorCode(null), null);
  assert.equal(extractAllowlistedOAuthErrorCode(undefined), null);
  assert.equal(extractAllowlistedOAuthErrorCode("invalid_client"), null, "a bare string body (not a JSON object) must not match");
  assert.equal(extractAllowlistedOAuthErrorCode(42), null);
  assert.equal(extractAllowlistedOAuthErrorCode([]), null);
  assert.equal(extractAllowlistedOAuthErrorCode({}), null, "an object with no error field");
  assert.equal(extractAllowlistedOAuthErrorCode({ error: null }), null);
  assert.equal(extractAllowlistedOAuthErrorCode({ error: 401 }), null, "a non-string error field must not match");
  assert.equal(extractAllowlistedOAuthErrorCode({ error_description: "invalid_client" }), null, "the wrong field name must not match");

  console.log("agenda-oauth-error-code: all assertions passed");
}

await run();
