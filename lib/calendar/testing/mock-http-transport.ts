// A fully scriptable fake HttpTransport (google-calendar-client.ts) for
// unit-testing every network interaction that file makes without any
// live Google call. Responses are enqueued in the exact order calls are
// expected; each call records its (url, init) for assertions on what was
// actually sent (headers, body, query string).

import type { HttpTransport } from "../google-calendar-client.ts";

export type MockCall = { url: string; init: RequestInit };
export type ScriptedResponse = Response | { throwAbort: true } | { throwNetworkError: true };

export class MockHttpTransport implements HttpTransport {
  calls: MockCall[] = [];
  private queue: ScriptedResponse[] = [];

  enqueue(response: ScriptedResponse): void {
    this.queue.push(response);
  }

  async fetch(input: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url: input, init });
    const next = this.queue.shift();
    if (!next) throw new Error(`MockHttpTransport: no scripted response enqueued for ${input}`);
    if ("throwAbort" in next) {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    if ("throwNetworkError" in next) {
      throw new TypeError("fetch failed");
    }
    return next;
  }
}

// The Fetch spec forbids a non-null body on a 204/205/304 Response (the
// real Calendar API's own successful DELETE returns a bodyless 204) --
// the Response constructor throws if one is supplied, so this passes
// `null` for exactly those statuses regardless of what `body` is given.
const NO_BODY_STATUSES = new Set([204, 205, 304]);

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const responseBody = NO_BODY_STATUSES.has(status) ? null : JSON.stringify(body);
  return new Response(responseBody, { status, headers: { "content-type": "application/json", ...headers } });
}

export function tokenResponse(accessToken = "test-access-token"): Response {
  return jsonResponse(200, { access_token: accessToken, expires_in: 3600, token_type: "Bearer" });
}
