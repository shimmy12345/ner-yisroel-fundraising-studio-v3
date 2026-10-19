// A STATEFUL fake GoogleCalendarClient: unlike ScriptedCalendarClient
// (which replays an exact, pre-enqueued sequence of responses per call),
// every method here reads and writes the SAME internal event map, the
// way a real calendar actually behaves -- insert fails 409 if the event
// already exists, get/update/delete 404 if it doesn't, update enforces
// If-Match against the stored etag. This lets a test assert "exactly one
// active event exists" (or "this exact event id is gone") by querying
// the fake's own persisted state directly, rather than only inspecting
// the call log -- the same distinction the 2026-10-21 review draws
// between "actual result: two remote events exist" and merely counting
// calls made.

import { randomUUID } from "node:crypto";
import type { GoogleApiResult, GoogleCalendarClient, GoogleEventBody } from "../calendar-sync-types.ts";

type Op = "get" | "insert" | "update" | "delete";

export class StatefulCalendarClient implements GoogleCalendarClient {
  calls: Array<{ op: Op; calendarId: string; eventId: string | undefined }> = [];
  private events = new Map<string, { event: GoogleEventBody; etag: string }>(); // key: `${calendarId}:${eventId}`

  private key(calendarId: string, eventId: string): string {
    return `${calendarId}:${eventId}`;
  }

  // Every event id currently actually present on this simulated
  // calendar -- the ground truth a test checks against, independent of
  // what any individual call claimed to do.
  activeEventIds(calendarId: string): string[] {
    const prefix = `${calendarId}:`;
    return [...this.events.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  }

  async get(calendarId: string, eventId: string): Promise<GoogleApiResult<GoogleEventBody>> {
    this.calls.push({ op: "get", calendarId, eventId });
    const existing = this.events.get(this.key(calendarId, eventId));
    if (!existing) return { ok: false, status: 404 };
    return { ok: true, status: 200, event: existing.event, etag: existing.etag };
  }

  async insert(calendarId: string, event: GoogleEventBody): Promise<GoogleApiResult<GoogleEventBody>> {
    this.calls.push({ op: "insert", calendarId, eventId: event.id });
    const key = this.key(calendarId, event.id!);
    if (this.events.has(key)) return { ok: false, status: 409 }; // real Google behavior: a deleted event's id can never be reinserted; an existing one collides
    const etag = `etag-${randomUUID()}`;
    this.events.set(key, { event, etag });
    return { ok: true, status: 201, event, etag };
  }

  async update(calendarId: string, eventId: string, event: GoogleEventBody, ifMatchEtag: string): Promise<GoogleApiResult<GoogleEventBody>> {
    this.calls.push({ op: "update", calendarId, eventId });
    const key = this.key(calendarId, eventId);
    const existing = this.events.get(key);
    if (!existing) return { ok: false, status: 404 };
    if (existing.etag !== ifMatchEtag) return { ok: false, status: 412 };
    const etag = `etag-${randomUUID()}`;
    this.events.set(key, { event, etag });
    return { ok: true, status: 200, event, etag };
  }

  async delete(calendarId: string, eventId: string): Promise<GoogleApiResult<never>> {
    this.calls.push({ op: "delete", calendarId, eventId });
    const key = this.key(calendarId, eventId);
    if (!this.events.has(key)) return { ok: false, status: 404 }; // idempotent: already gone counts as success upstream
    this.events.delete(key);
    return { ok: true, status: 204 };
  }
}
