// Shared types for the Google Calendar sync core. Pure (no cloudflare:workers
// import anywhere in lib/calendar/) -- every type/interface here is
// implementable by an in-memory fake for fast interleaving tests AND by a
// real node:sqlite-backed store for schema-level persistence tests, and
// later (not in this round) by a real D1 adapter. Nothing in this module
// touches a network or a database itself.

export type DesiredState = "present" | "absent";
export type SyncStatus = "pending" | "synced" | "failed" | "missing_remotely";
export type CreateStatus = "not_attempted" | "in_flight" | "succeeded" | "failed";
export type CleanupStatus = "not_needed" | "pending" | "uncertain" | "done";

export type CalendarLinkRow = {
  id: string;
  interactionId: string;
  userId: string;
  googleCalendarId: string;
  generation: number;
  googleEventId: string | null;
  googleEtag: string | null;
  desiredState: DesiredState;
  desiredRevision: number;
  syncedRevision: number;
  syncStatus: SyncStatus;
  lastError: string | null;
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type CalendarLinkHistoryRow = {
  id: string;
  linkId: string;
  generation: number;
  googleEventId: string;
  createStatus: CreateStatus;
  cleanupNeeded: boolean;
  cleanupStatus: CleanupStatus;
  cleanupAttempts: number;
  createdAt: number;
  updatedAt: number;
};

// The current, authoritative "what should this meeting's calendar event
// look like" fact, always re-read fresh from `interactions` (or the trip
// mirror) at the point a reconcile attempt actually builds a payload --
// never a value captured earlier and replayed. See calendar-event-body.ts
// for how this becomes a Google event body.
export type MeetingDesiredFields = {
  interactionId: string;
  donorDisplayName: string;
  allDay: boolean;
  allDayDate: string | null; // 'YYYY-MM-DD', all-day meetings only
  occurredAt: number | null; // instant, timed meetings only
  endAt: number | null; // instant, timed meetings only
  timezone: string | null; // IANA zone, timed meetings only
  location: string | null;
  fosUrl: string;
};

// A Google Calendar Event resource, trimmed to the fields this design
// reads/writes. `[key: string]: unknown` lets update logic preserve any
// field Google returns that FOS doesn't know about (Issue 5's "preserve
// unrelated Google event fields" requirement) without this type needing
// to enumerate Google's full schema.
export type GoogleEventBody = {
  id?: string;
  summary: string;
  description: string;
  location?: string;
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
  [key: string]: unknown;
};

export type GoogleApiResult<T> =
  | { ok: true; status: 200 | 201 | 204; event?: T; etag?: string }
  | { ok: false; status: 404 | 410 | 409 | 412; event?: T }
  | { ok: false; status: "error"; errorClass: string };

// The impure boundary -- a real implementation calls the live Calendar API
// with the stored OAuth credentials; tests supply a fully scriptable fake.
// Every method is async so tests can control exact interleaving via
// deferred promises (node:sqlite itself is synchronous, but production D1
// and the real Calendar API are both async, so the reconciler is written
// against this async shape throughout).
export interface GoogleCalendarClient {
  get(calendarId: string, eventId: string): Promise<GoogleApiResult<GoogleEventBody>>;
  insert(calendarId: string, event: GoogleEventBody): Promise<GoogleApiResult<GoogleEventBody>>;
  update(calendarId: string, eventId: string, event: GoogleEventBody, ifMatchEtag: string): Promise<GoogleApiResult<GoogleEventBody>>;
  delete(calendarId: string, eventId: string): Promise<GoogleApiResult<never>>;
}

// The persistence boundary. Every write that must behave as a
// compare-and-swap says so in its own name/signature -- there is no
// "just UPDATE it" method, by design, so a caller can never accidentally
// skip the guard that makes lease/revision safety real rather than
// aspirational.
export interface CalendarLinkStore {
  getLinkByInteraction(interactionId: string): Promise<CalendarLinkRow | null>;
  getLinkById(linkId: string): Promise<CalendarLinkRow | null>;
  // Creates generation 0. Fails (returns null) if a row already exists --
  // callers must go through recordDesiredState for an existing meeting.
  insertLink(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null>;
  // Acquires the lease iff currently unheld or expired. Returns the lease
  // token (== leaseOwner) on success, null if contended.
  acquireLease(linkId: string, leaseOwner: string, now: number, ttlSeconds: number): Promise<boolean>;
  // Only succeeds if this exact leaseOwner currently holds the lease --
  // a stale worker whose lease already expired-and-was-reacquired must
  // never clear the new holder's lease (Issue 1).
  releaseLease(linkId: string, leaseOwner: string): Promise<boolean>;
  // Only succeeds if this exact leaseOwner currently holds the lease --
  // the same guard as releaseLease, applied to every bookkeeping write a
  // reconcile attempt makes while holding the lease. A stale worker whose
  // lease already expired-and-was-reacquired by someone else must never
  // overwrite newer bookkeeping through this method (Issue 1).
  updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, patch: Partial<CalendarLinkRow>): Promise<boolean>;
  // Unconditional -- NOT lease-gated. The durable-intent write path
  // (reschedule/cancel/reopen): a user-initiated change must succeed
  // regardless of whether a reconcile attempt happens to be holding the
  // lease at that exact moment ("a Google failure must never lose the
  // saved FOS meeting" extends to "a slow sync attempt must never block a
  // new edit"). Reconcile bookkeeping (syncedRevision/syncStatus/etag)
  // NEVER goes through this method -- only updateLinkAsLeaseHolder does.
  // Still useful as a general single-field intent write; the three
  // revision/generation-bumping transitions below must NOT be built on
  // top of it (see their own doc comments for why).
  writeIntent(linkId: string, patch: Partial<CalendarLinkRow>): Promise<boolean>;
  // Issue 4 (2026-10-19 review): atomically increments desired_revision
  // by exactly 1 (`desired_revision = desired_revision + 1` inside a
  // single UPDATE, never a read-then-compute-then-write in application
  // code) and applies the rest of `patch` in the SAME statement. Two
  // truly simultaneous callers can never both read the same pre-
  // increment value and both compute the same post-increment one -- the
  // arithmetic happens inside the store itself. Returns the row as it
  // exists immediately after, or null if the link doesn't exist.
  applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null>;
  // Same atomic-increment guarantee as applyReschedule, PLUS flips
  // desired_state to 'absent' and resets sync_status, as one indivisible
  // unit together with marking the given generation's history row
  // cleanup_needed=1 -- both the link-row change and the history-row
  // change are applied together (a single transaction for the real
  // SQLite/D1 store; no intervening await for the in-memory one), so a
  // concurrent reader can never observe desired_state='absent' with
  // cleanup_needed still 0, or vice versa.
  applyCancel(linkId: string, generation: number, now: number): Promise<CalendarLinkRow | null>;
  // Same atomic-increment guarantee again, this time incrementing BOTH
  // desired_revision and generation by exactly 1 together, and resetting
  // the per-generation fields (google_event_id/etag/sync_status/
  // last_error/attempt_count) back to a fresh-generation starting state,
  // all in one indivisible unit. The caller still inserts the new
  // generation's own history row as an immediate follow-up (using the
  // freshly-allocated generation number this method returns) -- that
  // insert targets a BRAND NEW, already-uniquely-allocated generation
  // number, so it can never collide with or corrupt a concurrent
  // transition the way the bare revision/generation fields themselves
  // could before this fix.
  applyReopen(linkId: string, now: number): Promise<CalendarLinkRow | null>;
  getHistory(linkId: string, generation: number): Promise<CalendarLinkHistoryRow | null>;
  insertHistory(row: Omit<CalendarLinkHistoryRow, "createdAt" | "updatedAt">, now: number): Promise<void>;
  updateHistory(linkId: string, generation: number, patch: Partial<CalendarLinkHistoryRow>): Promise<void>;
  // Every generation, across every link, still owed a cleanup attempt --
  // never joined against or gated by the current generation's own
  // create/update work (Issue 2's "keep deletion retries separate").
  listPendingCleanup(now: number): Promise<CalendarLinkHistoryRow[]>;
  // Every link row needing attention (sync_status != 'synced' or a
  // revision mismatch) -- the sweep's ONLY source of work. It never scans
  // `interactions` directly, which is what makes "retry already-enrolled
  // work" and "enroll a new meeting" structurally distinct operations.
  listNeedingReconciliation(now: number): Promise<CalendarLinkRow[]>;
}
