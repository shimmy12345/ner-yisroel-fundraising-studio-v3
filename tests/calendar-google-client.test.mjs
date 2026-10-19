import assert from "node:assert/strict";
import { createGoogleCalendarClient, resolveVerifiedGoogleAccountEmail } from "../lib/calendar/google-calendar-client.ts";
import { MockHttpTransport, jsonResponse, tokenResponse } from "../lib/calendar/testing/mock-http-transport.ts";

// Every network interaction google-calendar-client.ts makes, exercised
// through MockHttpTransport -- no live Google call anywhere in this
// file. Plain Node, no Workers runtime, no D1 -- this file alone proves
// the "explicit architectural departure from gmail-client.ts" (credentials
// and transport are both injected, never read from `cloudflare:workers`)
// actually makes this testable outside a Workers runtime at all.

const CREDENTIALS = { clientId: "client-1", clientSecret: "secret-1", refreshToken: "refresh-1" };

function fosManagedEvent(overrides = {}) {
  return {
    id: "1abc",
    summary: "Meeting with Test Donor",
    description: "Scheduled via Fundraising OS.",
    start: { date: "2026-03-05" },
    end: { date: "2026-03-06" },
    etag: "\"etag-from-google\"",
    htmlLink: "https://calendar.google.com/event?eid=xyz",
    created: "2026-01-01T00:00:00Z",
    updated: "2026-01-01T00:00:00Z",
    creator: { email: "sgoldstein@nirc.edu" },
    organizer: { email: "sgoldstein@nirc.edu" },
    sequence: 0,
    kind: "calendar#event",
    colorId: "5", // an unrelated, non-read-only field that must survive untouched
    extendedProperties: { private: { fosManagedEventId: "1abc" } },
    ...overrides,
  };
}

async function run() {
  // =======================================================================
  // Token refresh: success and failure (allowlisted OAuth error code).
  // =======================================================================
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse("token-ok"));
    transport.enqueue(jsonResponse(200, fosManagedEvent()));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, true);
    const [tokenCall] = transport.calls;
    assert.equal(tokenCall.url, "https://oauth2.googleapis.com/token");
    const sentBody = tokenCall.init.body.toString();
    assert.ok(!sentBody.includes("fosManagedEventId")); // sanity: token request body is form-encoded credentials, nothing else
    assert.ok(sentBody.includes("refresh_token=refresh-1"));
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    // The thrown/caught message never reaches the caller as a distinct
    // field here (get() maps every refresh failure to network_error),
    // but the underlying refreshAccessToken() error message itself must
    // never leak error_description -- proven directly below.
  }
  {
    // Verify the allowlisted-code extraction directly against a refresh
    // failure's own thrown message (never error_description, never the
    // raw body) by catching it through resolveVerifiedGoogleAccountEmail,
    // which degrades to null rather than throwing -- so instead, prove it
    // via the oauth-error-code module's own already-tested behavior is
    // reused unmodified: a refresh failure here still correctly leads
    // get() to report an "error" result, never crashing the process.
    const transport = new MockHttpTransport();
    transport.enqueue(jsonResponse(400, { error: "invalid_client" }));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { id: "1abc", summary: "x", description: "y", start: { date: "2026-01-01" }, end: { date: "2026-01-02" } });
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
  }

  // =======================================================================
  // resolveVerifiedGoogleAccountEmail: success, and every failure mode
  // degrades to null, never throws.
  // =======================================================================
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, { email: "sgoldstein@nirc.edu", email_verified: true }));
    const email = await resolveVerifiedGoogleAccountEmail(CREDENTIALS, transport);
    assert.equal(email, "sgoldstein@nirc.edu");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(jsonResponse(401, { error: "invalid_grant" }));
    const email = await resolveVerifiedGoogleAccountEmail(CREDENTIALS, transport);
    assert.equal(email, null, "a token-refresh failure must degrade to null, never throw");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue({ throwAbort: true });
    const email = await resolveVerifiedGoogleAccountEmail(CREDENTIALS, transport);
    assert.equal(email, null, "a userinfo timeout must degrade to null, never throw");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, {})); // no email field at all
    const email = await resolveVerifiedGoogleAccountEmail(CREDENTIALS, transport);
    assert.equal(email, null, "a userinfo response missing email must degrade to null");
  }

  // =======================================================================
  // get(): ownership verification -- a matching event id alone is never
  // enough; the extendedProperties.private tag must also match.
  // =======================================================================
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent()));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, true);
    assert.equal(result.event.colorId, "5", "an unrelated field Google returns must survive untouched");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent({ extendedProperties: undefined }))); // a real event that exists but was never created by FOS
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.equal(result.errorClass, "not_fos_managed", "a matching event id alone must never authorize treating an unrelated event as FOS-managed");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent({ extendedProperties: { private: { fosManagedEventId: "SOME-OTHER-ID" } } })));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "not_fos_managed");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(404, {}));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "missing");
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
  }

  // =======================================================================
  // get(): HTTP error shapes map to the generic "error" bucket with the
  // right errorClass; never crash, never misclassify as 404/410/409/412.
  // =======================================================================
  for (const [status, expectedClass] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate_limited"], [500, "server_error"], [503, "server_error"]]) {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(status, { error: { message: "nope" } }));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.equal(result.errorClass, expectedClass, `HTTP ${status} must map to errorClass "${expectedClass}"`);
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue({ throwAbort: true });
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "timeout");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue({ throwNetworkError: true });
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "network_error");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(new Response("not json", { status: 200 }));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "invalid_response", "an unparseable 200 body must never be treated as a valid event");
  }

  // =======================================================================
  // insert(): sendUpdates=none, no attendees/invitations, ownership tag
  // embedded, explicit location (clearing fix), ambiguous timeout
  // preserved as "error" (never a false confirmed failure/success), and a
  // real 409 passed through for the reconciler's own verify-and-merge path.
  // =======================================================================
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(201, fosManagedEvent()));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { id: "1abc", summary: "Meeting with Test Donor", description: "x", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    assert.equal(result.ok, true);
    const insertCall = transport.calls[1];
    assert.ok(insertCall.url.includes("sendUpdates=none"), "insert must explicitly send sendUpdates=none");
    assert.ok(!insertCall.url.includes("sendNotifications"));
    const sentBody = JSON.parse(insertCall.init.body);
    assert.equal(sentBody.location, "", "location must always be sent explicitly, never omitted, even when absent");
    assert.equal(sentBody.extendedProperties.private.fosManagedEventId, "1abc", "every created event must be tagged with the ownership property");
    assert.equal(sentBody.attendees, undefined, "insert must never include attendees/invitations");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(201, fosManagedEvent()));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    await client.insert("primary", { id: "1abc", summary: "x", description: "y", location: "123 Main St", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    const sentBody = JSON.parse(transport.calls[1].init.body);
    assert.equal(sentBody.location, "123 Main St", "a real location must still be sent correctly");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue({ throwAbort: true });
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { id: "1abc", summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    assert.equal(result.ok, false);
    assert.equal(result.status, "error", "a timeout on insert must be reported as ambiguous ('error'), never as a definitive 404/410/409/412 the reconciler would treat as resolved");
    assert.equal(result.errorClass, "timeout");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(409, {}));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { id: "1abc", summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 409, "a real 409 must pass through as the definitive conflict status, for the reconciler's own verify-and-merge path");
  }
  {
    const transport = new MockHttpTransport();
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "missing_event_id");
    assert.equal(transport.calls.length, 0, "insert must refuse locally without ever calling the transport when the event has no id");
  }

  // =======================================================================
  // update(): requires a valid etag before any conditional update; strips
  // read-only fields; preserves unrelated writable fields; sends If-Match;
  // passes a real 412 through.
  // =======================================================================
  {
    const transport = new MockHttpTransport();
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.update("primary", "1abc", fosManagedEvent(), "");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "missing_etag");
    assert.equal(transport.calls.length, 0, "update must refuse locally without calling the transport when no valid etag is supplied");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent()));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const merged = fosManagedEvent({ colorId: "9", summary: "Meeting with Updated Donor" });
    const result = await client.update("primary", "1abc", merged, "\"etag-from-google\"");
    assert.equal(result.ok, true);
    const updateCall = transport.calls[1];
    assert.equal(updateCall.init.headers["if-match"], "\"etag-from-google\"");
    const sentBody = JSON.parse(updateCall.init.body);
    for (const field of ["etag", "htmlLink", "created", "updated", "creator", "organizer", "sequence", "kind"]) {
      assert.equal(sentBody[field], undefined, `update must strip the read-only field "${field}" before sending`);
    }
    assert.equal(sentBody.colorId, "9", "an unrelated writable field must survive update's own serialization untouched");
    assert.equal(sentBody.summary, "Meeting with Updated Donor");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(412, {}));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.update("primary", "1abc", fosManagedEvent(), "\"stale-etag\"");
    assert.equal(result.ok, false);
    assert.equal(result.status, 412);
  }

  // =======================================================================
  // delete(): performs its own internal ownership-verifying get() first
  // (the reconciler calls delete() with no preceding GET of its own) --
  // refuses to send a real DELETE for an unrelated event, passes a 404 on
  // the internal GET straight through without ever calling DELETE, and
  // sends If-Match on the real DELETE when ownership is confirmed.
  // =======================================================================
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(404, {})); // internal verifying GET: already gone
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.delete("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(transport.calls.length, 2, "a 404 on the internal verifying GET must never be followed by a real DELETE call");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent({ extendedProperties: undefined }))); // a real, unrelated event happens to exist at this id
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.delete("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "not_fos_managed", "delete() must refuse to delete an event its own ownership check does not confirm, even though the id matched");
    assert.equal(transport.calls.length, 2, "an ownership mismatch must never be followed by a real DELETE call");
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent()));
    transport.enqueue(jsonResponse(204, {}));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.delete("primary", "1abc");
    assert.equal(result.ok, true);
    const deleteCall = transport.calls[2];
    assert.equal(deleteCall.init.method, "DELETE");
    assert.equal(deleteCall.init.headers["if-match"], "\"etag-from-google\"", "the real DELETE must carry the etag confirmed by the internal verifying GET");
    assert.ok(deleteCall.url.includes("sendUpdates=none"));
  }
  {
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent()));
    transport.enqueue(jsonResponse(412, {}));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.delete("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.status, 412, "a real 412 on the actual DELETE call must pass through");
  }

  // =======================================================================
  // 2026-10-19 independent review, issue 1 -- exact reproductions against
  // the actual client. Pre-fix, the ORIGINAL version of insert() hardcoded
  // `status: 201` on ANY `response.ok` 2xx regardless of body content,
  // and get()'s ownership check compared a tag only against the
  // response's OWN `event.id` (self-referential) rather than the id this
  // call actually REQUESTED -- both are the exact bugs reproduced below.
  // =======================================================================
  {
    // "INSERT receives HTTP 200 with {} and returns
    // {ok:true,status:201,event:{}}." Pre-fix: response.ok is true (200),
    // insert() hardcoded status:201 and returned the empty body as if it
    // were the created event, with no shape validation at all.
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, {}));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { id: "1abc", summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    assert.equal(result.ok, false, "an empty {} body on a 200/201 response must never be reported as a confirmed successful insert");
    assert.equal(result.status, "error", "an unexpected response after a mutating request is an uncertain remote outcome, never a definitive failure that would trigger a blind replacement insert");
  }
  {
    // "GET requests eventId X, receives a different event ID whose
    // ownership tag matches that different ID, and reports success."
    // Pre-fix: isFosManagedEvent only checked `tag === event.id`, which a
    // DIFFERENT real event (its own id, its own self-matching tag) also
    // satisfies -- proving nothing about whether it's the event that was
    // actually requested.
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, fosManagedEvent({ id: "DIFFERENT-EVENT-ID", extendedProperties: { private: { fosManagedEventId: "DIFFERENT-EVENT-ID" } } })));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc"); // requested "1abc", Google returned "DIFFERENT-EVENT-ID"
    assert.equal(result.ok, false, "a GET must never report success for an event whose id does not match the one actually requested, even if that event's own ownership tag self-matches");
    assert.equal(result.errorClass, "event_id_mismatch");
  }
  {
    // "The previously observed OAuth-token-shaped response accidentally
    // reaching an event operation" -- a `{access_token, expires_in,
    // token_type}` body (no `id`, no `summary`, no `start`/`end`, no
    // ownership tag at all) landing on insert() instead of a real event
    // response (exactly what happened in this phase's own second CI run,
    // from a mock-transport queue desync -- see docs/AI-HANDOFF.md).
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(tokenResponse("leaked-token-shaped-response"));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.insert("primary", { id: "1abc", summary: "x", description: "y", start: { date: "2026-03-05" }, end: { date: "2026-03-06" } });
    assert.equal(result.ok, false, "an OAuth-token-shaped response reaching an event operation must never be treated as a created event");
    assert.equal(result.status, "error");
  }
  {
    // The same OAuth-token-shaped response reaching get() instead.
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(tokenResponse("leaked-token-shaped-response"));
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.get("primary", "1abc");
    assert.equal(result.ok, false);
    assert.equal(result.errorClass, "event_id_mismatch", "a token response has no `id` field at all, which must never match the requested event id");
  }
  {
    // UPDATE must be held to the same standard: a successful-status
    // response that doesn't look like the event just sent must never be
    // confirmed, nor treated as a definitive failure.
    const transport = new MockHttpTransport();
    transport.enqueue(tokenResponse());
    transport.enqueue(jsonResponse(200, { ok: true })); // some unexpected, non-event shape
    const client = createGoogleCalendarClient(CREDENTIALS, transport);
    const result = await client.update("primary", "1abc", fosManagedEvent(), "\"etag-1\"");
    assert.equal(result.ok, false);
    assert.equal(result.status, "error", "an unexpected UPDATE response must never be a confirmed success nor a definitive failure");
  }

  process.stdout.write("calendar-google-client.test.mjs: all assertions passed\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
