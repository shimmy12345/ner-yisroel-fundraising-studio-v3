// A real GoogleCalendarClient (calendar-sync-types.ts) against the live
// Google Calendar v3 REST API, plus verified-account lookup against
// Google's userinfo endpoint. NOT wired into any live route, Settings
// page, cron, or the agenda email path by this change -- see
// docs/AI-HANDOFF.md for what remains before that's authorized.
//
// Deliberate architectural departure from lib/agenda/gmail-client.ts:
// that file imports "cloudflare:workers" directly for its secrets, which
// means it can only ever be imported inside a Workers runtime, so it has
// no plain-Node unit test of its own. This file takes credentials AND an
// HttpTransport as explicit parameters instead of reading `env` itself --
// nothing here imports "cloudflare:workers" -- specifically so it can be
// fully unit-tested in plain Node with a mocked transport (see
// tests/calendar-google-client.test.mjs). A future route/Settings/cron
// call site (not part of this phase) is what would read
// GOOGLE_CALENDAR_OAUTH_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN from
// `cloudflare:workers` env and pass them in here.
//
// Security/logging rules, same as gmail-client.ts's own header:
// - Never include the client secret, refresh token, access token, or any
//   Authorization/If-Match header VALUE in a thrown Error's message or
//   any log line. Only HTTP status/statusText and (token-refresh
//   failures only) one allowlisted OAuth error code -- see
//   calendar-oauth-error-code.ts, a deliberate same-logic DUPLICATE of
//   lib/agenda/oauth-error-code.ts, never an import of it (see that
//   file's own header for why lib/calendar/ and lib/agenda/ must stay
//   completely import-disjoint).
// - Never log a full Calendar API response body. Event content read from
//   Google (summary/description/location) can include donor-identifying
//   text (Issue: this app's own minimal-content design for calendar
//   events) -- it is returned to callers (the reconciler) as a typed
//   GoogleEventBody for them to use, never written to a log line by this
//   file itself.
//
// Ownership verification ("a matching event ID alone must not authorize
// modifying an unrelated event"): every event this client creates is
// tagged, via Google's `extendedProperties.private` (a hidden,
// account-scoped key-value field Google itself never surfaces to other
// viewers/apps), with FOS_OWNERSHIP_PROPERTY_KEY = the event's own
// deterministic id. get() verifies this tag matches the response's own
// `id` on every 200; a mismatch (or absence) is reported as the generic
// `{status:"error", errorClass:"not_fos_managed"}` GoogleApiResult
// variant -- an ALREADY-EXISTING slot in the frozen calendar-sync-types.ts
// union, so no core type change was needed. delete()'s own interface
// (calendarId, eventId) carries no caller-supplied "expected owner," and
// the reconciler's own reconcileGenerationCleanupLocked calls
// client.delete() directly with no preceding GET -- so delete() performs
// its OWN internal ownership-verifying get() first (reusing this same
// check) before ever sending the real DELETE.

import { extractAllowlistedOAuthErrorCode } from "./calendar-oauth-error-code.ts";
import type { GoogleApiResult, GoogleCalendarClient, GoogleEventBody } from "./calendar-sync-types.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v3/userinfo";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const REQUEST_TIMEOUT_MS = 10_000;

const FOS_OWNERSHIP_PROPERTY_KEY = "fosManagedEventId";

// Google-documented read-only fields on an Event resource -- stripped
// before re-sending a GET's response body back as a PUT (Issue: "preserve
// unrelated writable event fields without blindly sending read-only
// response fields back in an UPDATE"). `mergeFosFieldsIntoExistingEvent`
// (the frozen core) spreads the ENTIRE existing event into the merged
// body specifically so unrelated writable fields survive -- this strips
// only the ones Google documents as server-assigned/read-only, applied
// here at THIS file's own HTTP-serialization boundary, never by changing
// the frozen core.
const READ_ONLY_EVENT_FIELDS = ["etag", "htmlLink", "iCalUID", "created", "updated", "creator", "organizer", "sequence", "kind"] as const;

export type CalendarOAuthCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

// Injectable, matching the global fetch() shape exactly -- a real
// transport is `{ fetch: globalThis.fetch.bind(globalThis) }`; tests
// supply a fully scriptable fake. This is the "explicit architectural
// departure from gmail-client.ts" the design calls for: every network
// interaction this file makes goes through this one seam, so
// tests/calendar-google-client.test.mjs can exercise every HTTP
// interaction (including timeouts and network exceptions) without any
// live Google call.
export interface HttpTransport {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export const realHttpTransport: HttpTransport = {
  fetch: (input, init) => fetch(input, init),
};

export class CalendarOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarOAuthError";
  }
}

function errorClassFromStatus(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "bad_request"; // includes 400 -- see this file's own doc comment in calendar-sync-reconciler-adjacent docs for the known in-flight/timeout ambiguity this shares
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function withTimeout<T>(signalConsumer: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await signalConsumer(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Shared by the client's own calls AND resolveVerifiedGoogleAccountEmail
// -- both need an access token via the exact same refresh_token grant.
async function refreshAccessToken(credentials: CalendarOAuthCredentials, transport: HttpTransport): Promise<string> {
  let response: Response;
  try {
    response = await withTimeout((signal) =>
      transport.fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
        signal,
      }),
    );
  } catch (error) {
    throw new CalendarOAuthError(isAbortError(error) ? "Calendar token refresh timed out" : "Calendar token refresh network error");
  }
  if (!response.ok) {
    let code: string | null = null;
    try {
      code = extractAllowlistedOAuthErrorCode(await response.json());
    } catch {
      code = null;
    }
    const codeSuffix = code ? ` (${code})` : "";
    throw new CalendarOAuthError(`Calendar token refresh failed: HTTP ${response.status} ${response.statusText}${codeSuffix}`);
  }
  let payload: { access_token?: string };
  try {
    payload = (await response.json()) as { access_token?: string };
  } catch {
    throw new CalendarOAuthError("Calendar token refresh response was not valid JSON");
  }
  if (!payload.access_token) throw new CalendarOAuthError("Calendar token refresh response did not include an access token");
  return payload.access_token;
}

// Resolves the Google account actually authorized by these credentials,
// for calendar-sync-guard.ts's `verifiedEmail` input (Issue 4: "verify
// the authorized account through Google rather than a manually entered
// label"). Never throws -- any failure (network, timeout, malformed
// response, missing email) degrades to null, matching the guard's own
// "null means refuse" contract; callers must never treat a thrown
// exception here as distinct from "verification unavailable."
export async function resolveVerifiedGoogleAccountEmail(credentials: CalendarOAuthCredentials, transport: HttpTransport): Promise<string | null> {
  try {
    const accessToken = await refreshAccessToken(credentials, transport);
    const response = await withTimeout((signal) =>
      transport.fetch(USERINFO_ENDPOINT, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
      }),
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.length > 0 ? payload.email : null;
  } catch {
    return null;
  }
}

function stripReadOnlyFields(body: GoogleEventBody): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...body };
  for (const field of READ_ONLY_EVENT_FIELDS) delete clone[field];
  return clone;
}

// Always sends `location` as an explicit value (never omits the key) --
// Google's events.update is a full-resource REPLACE with undocumented
// omission semantics; the only way to reliably CLEAR a previously-set
// location is to send it as an explicit empty string, never to omit the
// field and hope Google treats that as "clear it." Applied at this
// file's own HTTP-serialization boundary only -- the frozen
// calendar-event-body.ts core is untouched and still legitimately omits
// `location` when there isn't one.
function serializeEventBodyForRequest(body: GoogleEventBody, ownershipEventId: string): Record<string, unknown> {
  const stripped = stripReadOnlyFields(body);
  const existingExtendedProperties = (stripped.extendedProperties as { private?: Record<string, string> } | undefined) ?? {};
  return {
    ...stripped,
    location: (body.location as string | undefined) ?? "",
    extendedProperties: {
      ...existingExtendedProperties,
      private: { ...existingExtendedProperties.private, [FOS_OWNERSHIP_PROPERTY_KEY]: ownershipEventId },
    },
  };
}

function isFosManagedEvent(event: Record<string, unknown>): boolean {
  const extendedProperties = event.extendedProperties as { private?: Record<string, unknown> } | undefined;
  const tag = extendedProperties?.private?.[FOS_OWNERSHIP_PROPERTY_KEY];
  return typeof tag === "string" && tag === event.id;
}

function parseEtag(response: Response, body: Record<string, unknown>): string | undefined {
  const headerEtag = response.headers.get("etag");
  if (headerEtag) return headerEtag;
  return typeof body.etag === "string" ? body.etag : undefined;
}

export function createGoogleCalendarClient(credentials: CalendarOAuthCredentials, transport: HttpTransport): GoogleCalendarClient {
  // A single cached access token per client instance, refreshed only
  // when missing or within 60s of its known expiry -- Calendar sync is
  // sweep-driven (potentially many calls per sweep tick), unlike Gmail's
  // one-send-per-day model, so re-requesting a fresh token on every call
  // would be wasteful and could itself approach Google's own rate limits.
  let cachedToken: { accessToken: string; expiresAtMs: number } | null = null;

  async function getAccessToken(): Promise<string> {
    const now = Date.now();
    if (cachedToken && cachedToken.expiresAtMs - 60_000 > now) return cachedToken.accessToken;
    const accessToken = await refreshAccessToken(credentials, transport);
    cachedToken = { accessToken, expiresAtMs: now + 55 * 60 * 1000 }; // Google access tokens are documented as 1-hour-lived; cached conservatively short of that
    return accessToken;
  }

  async function authorizedRequest(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    const accessToken = await getAccessToken();
    return transport.fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${accessToken}` } });
  }

  async function parseEventResponse(response: Response): Promise<{ ok: true; event: Record<string, unknown>; etag?: string } | { ok: false; errorClass: string }> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, errorClass: "invalid_response" };
    }
    if (typeof body !== "object" || body === null) return { ok: false, errorClass: "invalid_response" };
    const event = body as Record<string, unknown>;
    return { ok: true, event, etag: parseEtag(response, event) };
  }

  async function get(calendarId: string, eventId: string): Promise<GoogleApiResult<GoogleEventBody>> {
    let response: Response;
    try {
      response = await withTimeout((signal) => authorizedRequest(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "GET", signal }));
    } catch (error) {
      return { ok: false, status: "error", errorClass: isAbortError(error) ? "timeout" : "network_error" };
    }
    if (response.status === 404 || response.status === 410) return { ok: false, status: response.status };
    if (!response.ok) return { ok: false, status: "error", errorClass: errorClassFromStatus(response.status) };
    const parsed = await parseEventResponse(response);
    if (!parsed.ok) return { ok: false, status: "error", errorClass: parsed.errorClass };
    if (!isFosManagedEvent(parsed.event)) return { ok: false, status: "error", errorClass: "not_fos_managed" };
    return { ok: true, status: 200, event: parsed.event as unknown as GoogleEventBody, etag: parsed.etag };
  }

  async function insert(calendarId: string, event: GoogleEventBody): Promise<GoogleApiResult<GoogleEventBody>> {
    if (!event.id) return { ok: false, status: "error", errorClass: "missing_event_id" };
    const body = serializeEventBodyForRequest(event, event.id);
    let response: Response;
    try {
      response = await withTimeout((signal) =>
        authorizedRequest(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (error) {
      // Issue: "preserve ambiguous creation outcomes rather than treating
      // a timeout as confirmed failure" -- this "error" shape is exactly
      // what lets the reconciler's own finishFailed path leave
      // createStatus at "in_flight" rather than resolving it either way.
      return { ok: false, status: "error", errorClass: isAbortError(error) ? "timeout" : "network_error" };
    }
    if (response.status === 409) return { ok: false, status: 409 };
    if (!response.ok) return { ok: false, status: "error", errorClass: errorClassFromStatus(response.status) };
    const parsed = await parseEventResponse(response);
    if (!parsed.ok) return { ok: false, status: "error", errorClass: parsed.errorClass };
    return { ok: true, status: 201, event: parsed.event as unknown as GoogleEventBody, etag: parsed.etag };
  }

  async function update(calendarId: string, eventId: string, event: GoogleEventBody, ifMatchEtag: string): Promise<GoogleApiResult<GoogleEventBody>> {
    // Issue: "require a valid ETag before conditional updates" -- an
    // empty/missing etag must refuse outright, never fall back to an
    // unconditional (unsafe, last-write-wins) PUT.
    if (!ifMatchEtag) return { ok: false, status: "error", errorClass: "missing_etag" };
    const body = serializeEventBodyForRequest(event, eventId);
    let response: Response;
    try {
      response = await withTimeout((signal) =>
        authorizedRequest(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
          method: "PUT",
          headers: { "content-type": "application/json", "if-match": ifMatchEtag },
          body: JSON.stringify(body),
          signal,
        }),
      );
    } catch (error) {
      return { ok: false, status: "error", errorClass: isAbortError(error) ? "timeout" : "network_error" };
    }
    if (response.status === 404 || response.status === 410 || response.status === 412) return { ok: false, status: response.status };
    if (!response.ok) return { ok: false, status: "error", errorClass: errorClassFromStatus(response.status) };
    const parsed = await parseEventResponse(response);
    if (!parsed.ok) return { ok: false, status: "error", errorClass: parsed.errorClass };
    return { ok: true, status: 200, event: parsed.event as unknown as GoogleEventBody, etag: parsed.etag };
  }

  // The reconciler's own reconcileGenerationCleanupLocked calls
  // client.delete() directly with no preceding GET -- this performs its
  // OWN internal ownership-verifying get() first (see this file's own
  // header), and only sends the real DELETE once that GET both succeeds
  // AND the event carries this app's own ownership tag.
  async function del(calendarId: string, eventId: string): Promise<GoogleApiResult<never>> {
    const verify = await get(calendarId, eventId);
    if (!verify.ok) {
      // 404/410 (already gone) and a genuine error both pass straight
      // through -- a 404/410 here means "nothing to delete" (the
      // reconciler's own deletedOrAlreadyGone check treats this as
      // success), and an ownership mismatch or any other error must
      // never be masked by attempting a DELETE anyway.
      return verify as unknown as GoogleApiResult<never>;
    }
    let response: Response;
    try {
      response = await withTimeout((signal) =>
        authorizedRequest(`${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
          method: "DELETE",
          headers: verify.etag ? { "if-match": verify.etag } : {},
          signal,
        }),
      );
    } catch (error) {
      return { ok: false, status: "error", errorClass: isAbortError(error) ? "timeout" : "network_error" };
    }
    if (response.status === 404 || response.status === 410 || response.status === 412) return { ok: false, status: response.status };
    if (!response.ok) return { ok: false, status: "error", errorClass: errorClassFromStatus(response.status) };
    return { ok: true, status: 204 };
  }

  return { get, insert, update, delete: del };
}
