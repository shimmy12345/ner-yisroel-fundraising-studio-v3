import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { interpretSharedActivityResponse, UNKNOWN_OUTCOME_MESSAGE, NETWORK_FAILURE_MESSAGE } from "../lib/capture/shared-activity-response.ts";

// "Failed to execute 'json' on 'Response': Unexpected end of JSON input"
// incident (docs/AI-HANDOFF.md). Live D1 inspection at the time of the
// report confirmed ZERO WRITE: shared_activities/interactions/
// shared_activity_recipient_audits all still showed their pre-incident
// row counts and latest timestamps, unchanged by the failed attempt. The
// new A-Z donor directory (commit 4af3fdc) was confirmed NOT to have
// touched app/capture/CaptureExperience.tsx at all (`git diff 4af3fdc~1
// 4af3fdc -- app/capture/CaptureExperience.tsx` is empty) and to leave
// RecipientPicker's selectedIds/toggle()/onChange contract exactly as it
// was, so the submitted payload shape was never affected by that redesign.
// Root cause: app/api/interactions/shared/route.ts had two unguarded,
// pre-write D1 calls (the profile upsert and the donor-ownership SELECT)
// that, if they threw for any reason, would propagate as an uncaught
// exception out of the Worker's fetch handler -- whose own fallback
// response is controlled by the Workers runtime, not this route, and is
// not guaranteed to be JSON or even non-empty. This is exactly consistent
// with the browser's "Unexpected end of JSON input".

// ---- interpretSharedActivityResponse(): the full client-side response matrix ----

{
  // 2xx with a well-formed success body.
  const outcome = interpretSharedActivityResponse(true, { ok: true, sharedActivityId: "s1", interactionIds: ["i1", "i2"], recipientCount: 2, occurredAt: "2026-09-10T12:00:00.000Z", databaseChangesMade: true });
  assert.equal(outcome.kind, "success");
  assert.equal(outcome.result.sharedActivityId, "s1");
}

{
  // 2xx or non-2xx with an empty/unparseable body -- payload is null
  // because response.json() itself threw. Must never be treated as
  // success or as a confirmed-safe failure.
  for (const responseOk of [true, false]) {
    const outcome = interpretSharedActivityResponse(responseOk, null);
    assert.equal(outcome.kind, "unknown_outcome");
    assert.equal(outcome.message, UNKNOWN_OUTCOME_MESSAGE);
    assert.doesNotMatch(outcome.message, /try again/i, "an unknown outcome must never tell the user it is safe to retry");
  }
}

{
  // 204 No Content -- response.json() throws on an empty body exactly like
  // the empty-body case above; simulated the same way (payload === null).
  const outcome = interpretSharedActivityResponse(true, null);
  assert.equal(outcome.kind, "unknown_outcome");
}

{
  // 4xx with a well-formed JSON validation error -- the server's own
  // ok:false is a confirmed-zero-write signal, safe to retry.
  const outcome = interpretSharedActivityResponse(false, { ok: false, error: "A summary is required", databaseChangesMade: false });
  assert.equal(outcome.kind, "known_failure");
  assert.equal(outcome.message, "A summary is required");
}

{
  // 4xx with an empty/unparseable body.
  const outcome = interpretSharedActivityResponse(false, null);
  assert.equal(outcome.kind, "unknown_outcome");
}

{
  // 5xx with a well-formed JSON error (the route's own caught-exception path).
  const outcome = interpretSharedActivityResponse(false, { ok: false, error: "Shared activity could not be saved", databaseChangesMade: false });
  assert.equal(outcome.kind, "known_failure");
}

{
  // 5xx with an empty body -- an uncaught exception reaching the runtime's
  // own fallback, exactly the reported incident's shape.
  const outcome = interpretSharedActivityResponse(false, null);
  assert.equal(outcome.kind, "unknown_outcome");
}

{
  // An HTML/Cloudflare interstitial response would fail response.json()
  // the same way an empty body does -- payload is null either way from
  // this function's point of view, so it is already covered by the
  // empty-body cases above. A response that DOES parse as JSON but isn't
  // shaped like this route's contract (e.g. a stray array, or an object
  // missing `ok`) must also come back unknown, never success.
  for (const stray of [[], "a string", 42, {}, { unrelated: true }]) {
    const outcome = interpretSharedActivityResponse(true, stray);
    assert.notEqual(outcome.kind, "success", `stray payload ${JSON.stringify(stray)} must never be treated as success`);
  }
}

{
  // A 2xx response whose body doesn't match the success shape (missing
  // fields) must not be treated as success even though responseOk is true.
  const outcome = interpretSharedActivityResponse(true, { ok: true, sharedActivityId: "s1" });
  assert.notEqual(outcome.kind, "success");
}

{
  assert.equal(typeof NETWORK_FAILURE_MESSAGE, "string");
  assert.match(NETWORK_FAILURE_MESSAGE, /try again/i, "a genuine network failure (request never reached the server) is safe to retry");
}

console.log("Shared activity response-interpretation checks passed.");

// ---- Server-side atomicity / idempotency / response-shape guarantees ----
// (source inspection -- see tests/shared-activity-ux.test.mjs's own header
// comment for why this codebase's API layer is tested this way.)

const sharedRoute = await readFile(new URL("../app/api/interactions/shared/route.ts", import.meta.url), "utf8");
const captureExperience = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");

{
  // Every application-controlled response carries ok/databaseChangesMade.
  assert.match(sharedRoute, /function failure\(error: string, status: number, extra: Record<string, unknown> = \{\}\) \{\s*return Response\.json\(\{ ok: false, error, databaseChangesMade: false, \.\.\.extra \}, \{ status \}\);/);
  assert.match(sharedRoute, /ok: true,\s*sharedActivityId,\s*interactionIds,\s*recipientCount: donorIds\.length,\s*occurredAt: occurredAt\.toISOString\(\),\s*databaseChangesMade: true,/, "the success response must explicitly confirm the write happened");
}

{
  // The two pre-write D1 calls (profile upsert, donor-ownership check) are
  // now inside their OWN, SEPARATE try/catch blocks with distinct log
  // event names -- so an exception in either can never propagate uncaught
  // out of the handler, and a future failure never again collapses into
  // one ambiguous log event (docs/AI-HANDOFF.md, the "too many SQL
  // variables" follow-up incident).
  const profileTry = sharedRoute.indexOf("const profile = await ensureUserProfile(user);");
  const profileCatch = sharedRoute.indexOf("shared_activity_profile_precheck_failed");
  assert.ok(profileTry !== -1 && profileCatch !== -1 && profileTry < profileCatch, "the profile upsert must be wrapped in its own try/catch");

  const ownershipTry = sharedRoute.indexOf("const chunks = chunk(donorIds, OWNERSHIP_QUERY_CHUNK_SIZE);");
  const ownershipCatch = sharedRoute.indexOf("shared_activity_ownership_precheck_failed");
  assert.ok(ownershipTry !== -1 && ownershipCatch !== -1 && ownershipTry < ownershipCatch, "the donor-ownership lookup must be wrapped in its own try/catch, distinct from the profile upsert's");
  assert.ok(profileCatch < ownershipTry, "the profile precheck must run, and be fully resolved, before the ownership lookup begins");

  const ownershipBlock = sharedRoute.slice(ownershipTry, ownershipCatch);
  assert.match(ownershipBlock, /SELECT id FROM donors WHERE owner_user_id/, "the donor-ownership check must be inside its own guarded block");
}

{
  // The ownership lookup is chunked to stay under D1's 100-bound-parameter
  // limit -- live-confirmed on Independent Staging: 101 donors (102 bound
  // params) failed with "D1_ERROR: too many SQL variables at offset 280:
  // SQLITE_ERROR"; 99 donors (100 bound params) succeeded.
  assert.match(sharedRoute, /const OWNERSHIP_QUERY_CHUNK_SIZE = 90;/);
  assert.ok(1 + 90 <= 100, "OWNERSHIP_QUERY_CHUNK_SIZE plus the owner_user_id bind must stay at or under D1's 100-parameter limit");
  assert.match(sharedRoute, /chunk\(donorIds, OWNERSHIP_QUERY_CHUNK_SIZE\)/);
  assert.match(sharedRoute, /Promise\.all\(chunks\.map\(/, "ownership chunks are independent reads and should run concurrently, not one at a time");
  assert.match(sharedRoute, /new Set\(chunkResults\.flatMap\(\(result\) => result\.results\.map\(\(row\) => row\.id\)\)\)/, "owned ids from every chunk must be merged into one set, not just the last chunk's");
}

{
  // The write itself is a single D1 batch -- atomic by construction (D1's
  // batch() commits all statements or none), so no subset of donors can
  // ever end up partially linked.
  assert.match(sharedRoute, /await env\.DB\.batch\(statements\);/);
  const batchCount = (sharedRoute.match(/await env\.DB\.batch\(/g) ?? []).length;
  assert.equal(batchCount, 1, "there must be exactly one batch() call -- the whole shared activity is written atomically in one transaction");
}

{
  // A logging failure after a successful write must never be allowed to
  // mask that the write succeeded.
  const batchIndex = sharedRoute.indexOf("await env.DB.batch(statements);");
  const afterBatch = sharedRoute.slice(batchIndex);
  assert.match(afterBatch, /try \{\s*logger\.info\("shared_activity_captured"/, "logging after a successful write must be its own try block");
  assert.match(afterBatch, /catch \{ \/\* never let a logging failure mask a successful write \*\/ \}/);
}

{
  // Idempotent retry guard: an identical resubmission (same user, type,
  // occurred_at, summary, recipient_count) within the dedupe window
  // returns the EXISTING shared activity instead of writing a new one.
  assert.match(sharedRoute, /const DEDUPE_WINDOW_SECONDS = 300;/);
  assert.match(sharedRoute, /WHERE user_id = \? AND type = \? AND occurred_at = \? AND summary = \? AND recipient_count = \? AND created_at >= \?/, "the dedupe lookup must match on real content, not a client-supplied key");
  assert.match(sharedRoute, /databaseChangesMade: false,\s*\}, \{ status: 200 \}\);/, "returning an existing activity on a duplicate retry must report databaseChangesMade: false");
  // The dedupe check must run BEFORE the new-activity insert statements are
  // built, so a genuine duplicate never reaches the write path at all.
  const dedupeIndex = sharedRoute.indexOf("DEDUPE_WINDOW_SECONDS");
  const insertIndex = sharedRoute.indexOf("const statements = [");
  assert.ok(dedupeIndex !== -1 && insertIndex !== -1 && dedupeIndex < insertIndex);
}

{
  // Single donor save is untouched by this fix -- the single-donor route
  // and its request shape are a different file entirely.
  assert.doesNotMatch(sharedRoute, /"\/api\/interactions"/, "the shared route must never reference the single-donor route's own path");
}

{
  // The client's own retry-safety copy: an unknown outcome must never be
  // followed by "try again", and a known-safe failure still is.
  assert.match(captureExperience, /setSharedRetryUnsafe\(outcome\.kind === "unknown_outcome"\);/);
  assert.match(captureExperience, /\{sharedErrorMessage\}\{!sharedRetryUnsafe && " Your note is still here—try again\."\}/);
}

{
  // The network-failure and body-parse-failure paths are genuinely
  // distinct code paths in the client, matching the two different failure
  // modes this incident is about.
  const saveSharedStart = captureExperience.indexOf("async function saveSharedActivity(");
  const saveSharedEnd = captureExperience.indexOf("\n  }\n\n  function resetShared");
  const saveSharedBody = captureExperience.slice(saveSharedStart, saveSharedEnd);
  assert.match(saveSharedBody, /catch \{\s*setSharedErrorMessage\(NETWORK_FAILURE_MESSAGE\);/, "a fetch()-level failure must use the network-failure message, not the generic one");
  assert.match(saveSharedBody, /let payload: unknown = null;\s*try \{ payload = await response\.json\(\); \} catch \{ payload = null; \}/, "a response.json() failure must be caught locally, never left to crash the whole save flow");
}

console.log("Shared activity route safety checks passed.");
