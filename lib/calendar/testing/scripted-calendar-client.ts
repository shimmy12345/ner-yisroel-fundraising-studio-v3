// A fully scriptable, deferred-promise-based fake GoogleCalendarClient.
// Tests enqueue exactly which response each call should receive, and can
// hold a call open indefinitely (via createDeferred()) to construct
// precise, deliberate interleavings of two or more concurrent reconcile
// attempts -- not just sequential happy-path sequencing.

import type { GoogleApiResult, GoogleCalendarClient, GoogleEventBody } from "../calendar-sync-types.ts";

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const ok200 = (event: GoogleEventBody, etag = "etag-1"): GoogleApiResult<GoogleEventBody> => ({ ok: true, status: 200, event, etag });
export const ok201 = (event: GoogleEventBody, etag = "etag-1"): GoogleApiResult<GoogleEventBody> => ({ ok: true, status: 201, event, etag });
export const ok204 = (): GoogleApiResult<never> => ({ ok: true, status: 204 });
export const err404 = (): GoogleApiResult<never> => ({ ok: false, status: 404 });
export const err410 = (): GoogleApiResult<never> => ({ ok: false, status: 410 });
export const err409 = (): GoogleApiResult<never> => ({ ok: false, status: 409 });
export const err412 = (): GoogleApiResult<never> => ({ ok: false, status: 412 });
export const errNetwork = (): GoogleApiResult<never> => ({ ok: false, status: "error", errorClass: "network_timeout" });

type Responder = (...args: unknown[]) => Promise<GoogleApiResult<unknown>>;
type Op = "get" | "insert" | "update" | "delete";

export class ScriptedCalendarClient implements GoogleCalendarClient {
  calls: Array<{ op: Op; calendarId: string; eventId: string | undefined }> = [];
  private queues = new Map<string, Responder[]>();

  private key(op: Op, eventId: string | undefined): string {
    return `${op}:${eventId ?? "*"}`;
  }

  // Enqueues one response for the next call matching (op, eventId).
  // Pass eventId=undefined to match ANY eventId for that op as a fallback
  // when the specific-id queue is empty.
  enqueue(op: Op, eventId: string | undefined, responder: Responder): void {
    const k = this.key(op, eventId);
    if (!this.queues.has(k)) this.queues.set(k, []);
    this.queues.get(k)!.push(responder);
  }

  enqueueValue(op: Op, eventId: string | undefined, value: GoogleApiResult<unknown>): void {
    this.enqueue(op, eventId, async () => value);
  }

  private async respond(op: Op, eventId: string | undefined, calendarId: string, ...args: unknown[]): Promise<GoogleApiResult<unknown>> {
    this.calls.push({ op, calendarId, eventId });
    const specific = this.queues.get(this.key(op, eventId));
    if (specific && specific.length) return specific.shift()!(...args);
    const wildcard = this.queues.get(this.key(op, undefined));
    if (wildcard && wildcard.length) return wildcard.shift()!(...args);
    throw new Error(`ScriptedCalendarClient: no scripted response enqueued for ${op} ${eventId ?? ""}`);
  }

  async get(calendarId: string, eventId: string): Promise<GoogleApiResult<GoogleEventBody>> {
    return (await this.respond("get", eventId, calendarId, calendarId, eventId)) as GoogleApiResult<GoogleEventBody>;
  }
  async insert(calendarId: string, event: GoogleEventBody): Promise<GoogleApiResult<GoogleEventBody>> {
    return (await this.respond("insert", event.id, calendarId, calendarId, event)) as GoogleApiResult<GoogleEventBody>;
  }
  async update(calendarId: string, eventId: string, event: GoogleEventBody, ifMatchEtag: string): Promise<GoogleApiResult<GoogleEventBody>> {
    return (await this.respond("update", eventId, calendarId, calendarId, eventId, event, ifMatchEtag)) as GoogleApiResult<GoogleEventBody>;
  }
  async delete(calendarId: string, eventId: string): Promise<GoogleApiResult<never>> {
    return (await this.respond("delete", eventId, calendarId, calendarId, eventId)) as GoogleApiResult<never>;
  }
}
