// Shared types for the Google Calendar sync core. Pure (no cloudflare:workers
// import anywhere in lib/calendar/) -- every type/interface here is
// implementable by an in-memory fake for fast interleaving tests AND by a
// real node:sqlite-backed store for schema-level persistence tests, and
// later (not in this round) by a real D1 adapter. Nothing in this module
// touches a network or a database itself.

export type DesiredState = "present" | "absent";
// "failed": a genuine, non-ambiguous, RETRYABLE failure (network/5xx/429
// that resolved past the ambiguous "might have happened" window, or any
// failure with no more specific category) -- eligible for bounded-
// backoff automatic retry via `nextRetryAt` below.
// "invalid" (2026-10-19 review, issue 2): a DEFINITIVE, PERMANENT
// rejection -- either this app's own pre-mutation validation
// (validateMeetingDesiredFields) or a real Google 400 -- never retried
// automatically; only an explicit correction (a reschedule that changes
// the content) or an explicit manual retry moves it back to "pending".
// "auth_required" (2026-10-19 review, issue 2): a 401/403 -- an
// authentication/configuration problem, not a content problem; never
// retried on the normal backoff schedule either, since retrying with
// the SAME broken credentials cannot succeed -- requires explicit
// reauthorization (or an explicit manual retry, once credentials are
// fixed) to resume.
export type SyncStatus = "pending" | "synced" | "failed" | "invalid" | "auth_required" | "missing_remotely";
// "invalid" (2026-10-19 review, issue 2): mirrors SyncStatus's own
// "invalid" -- this generation's create attempt was definitively,
// permanently rejected (pre-mutation validation or a real Google 400).
// Distinct from "in_flight", which means genuinely ambiguous/unresolved
// (timeout, network exception, malformed response) -- an "invalid"
// generation is NOT retried by the normal insert-on-404 path the way an
// "in_flight" one still legitimately is.
export type CreateStatus = "not_attempted" | "in_flight" | "succeeded" | "failed" | "invalid";
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
  // 2026-10-19 review, issue 2: bounded-backoff scheduling for a
  // `syncStatus: "failed"` link -- null means "eligible now" (no backoff
  // in effect, e.g. not currently in a retryable-failure state, or never
  // failed). listNeedingReconciliation(now) excludes a "failed" link
  // whose nextRetryAt is still in the future, so a transient failure is
  // retried with increasing delay rather than hammered every sweep tick
  // ("avoid retry storms"). Never consulted for "invalid"/"auth_required"
  // links -- those are excluded from automatic reconciliation entirely,
  // regardless of this field's value, until an explicit correction/retry.
  nextRetryAt: number | null;
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

// 2026-10-19 review, issue 2: `400` was added to the definitive-status
// union (it was previously only reachable via the generic `"error"`
// bucket, making a real, permanent Google validation rejection
// indistinguishable from a transient timeout at the bookkeeping level --
// the exact limitation the 2026-10-18 phase reported rather than hid).
// A definitive 400 is never ambiguous: Google has unambiguously rejected
// the request content itself, so it is always safe to treat as
// permanent, never retried the way `"error"` (timeout/network/5xx/429)
// still legitimately is.
export type GoogleApiResult<T> =
  | { ok: true; status: 200 | 201 | 204; event?: T; etag?: string }
  | { ok: false; status: 400 | 404 | 410 | 409 | 412; event?: T }
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
  // Low-level; enrollMeetingForSync uses insertLinkWithHistory below
  // instead, which also creates generation 0's history row atomically.
  // Kept on the interface for store implementations/tests that need the
  // link row alone.
  insertLink(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null>;
  // Bug 2 (2026-10-20 review): "a crash between link creation and
  // history creation leaves an unrecoverable enrollment." Creates the
  // link row AND generation 0's history row together as ONE atomic unit
  // (a real SQL transaction for the SQLite/D1 store; a single
  // uninterrupted synchronous operation, with the link insert undone if
  // the history insert fails, for the in-memory one) -- a reader can
  // never observe the link existing without its generation-0 history
  // row, which is what made the original bug possible (a history-less
  // link silently passed every later "does history exist" check as a
  // no-op instead of a detectable integrity failure). Fails (returns
  // null) under the same condition insertLink does.
  insertLinkWithHistory(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null>;
  // Bug 2 (2026-10-20 review): idempotent self-heal -- creates the
  // (linkId, generation) history row ONLY if it doesn't already exist
  // (never overwrites an existing one), and always returns the row as it
  // exists immediately after (existing or freshly created). This is the
  // repair primitive every code path that depends on history existing
  // (enrollment's "already exists" branch, a present-state reconcile
  // attempt, and generation cleanup) calls defensively before doing
  // anything else, so "missing required history" can never silently pass
  // as an ordinary no-op regardless of how the gap arose. `cleanupNeeded`
  // defaults to false (a freshly-repaired row has no known-needed cleanup
  // yet); cleanup's own call site passes true, since by construction it
  // is only ever invoked when cleanup genuinely is needed.
  ensureHistory(linkId: string, generation: number, googleEventId: string, now: number, cleanupNeeded?: boolean): Promise<CalendarLinkHistoryRow>;
  // Acquires the lease iff currently unheld or expired, storing the
  // caller-supplied `leaseOwner` as the lease token. Returns true on
  // success, false if contended. 2026-10-19 review (follow-up): this
  // store never generates the token itself -- the CALLER must pass a
  // value that is unique per acquisition attempt (never a value reused
  // across separate attempts for the same link), or two distinct
  // attempts can be mistaken for the same lease holder once an older
  // one's lease has genuinely expired and a newer one has taken over.
  // See calendar-sync-reconciler.ts's runReconciliationSweep for where
  // that uniqueness is actually generated (a fresh randomUUID() per
  // acquisition) for every production caller.
  acquireLease(linkId: string, leaseOwner: string, now: number, ttlSeconds: number): Promise<boolean>;
  // Only succeeds if this exact leaseOwner currently holds the lease --
  // a stale worker whose lease already expired-and-was-reacquired must
  // never clear the new holder's lease (Issue 1).
  releaseLease(linkId: string, leaseOwner: string): Promise<boolean>;
  // Only succeeds if this exact leaseOwner currently holds the lease AND
  // the lease has not expired as of `now` -- the same guard as
  // releaseLease, PLUS an expiry check, applied to every bookkeeping
  // write a reconcile attempt makes while holding the lease. A stale
  // worker whose lease already expired-and-was-reacquired by someone
  // else must never overwrite newer bookkeeping through this method
  // (Issue 1).
  // 2026-10-19 review, issue 3: the ORIGINAL version of this method
  // checked `lease_owner` alone, never `lease_expires_at` -- an EXPIRED
  // worker could still successfully write bookkeeping through this
  // method as long as no one else had yet acquired the lease (expiry
  // alone does not clear `lease_owner`; only a NEW acquireLease call, or
  // an explicit release, does). `now` is now a required parameter,
  // checked atomically INSIDE this same guarded write (never trusted
  // from an earlier, possibly-stale caller-side check) -- an expired
  // lease holder's write is rejected here even when no replacement has
  // acquired the lease yet.
  updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, now: number, patch: Partial<CalendarLinkRow>): Promise<boolean>;
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
  // arithmetic happens inside the store itself.
  // Bug 3 (2026-10-21 review): ALSO atomically re-checks desired_state ==
  // 'present' as part of the SAME statement/unit, rather than trusting a
  // caller's own earlier read (recordReschedule used to check this
  // itself before awaiting the store call -- insufficient, since a
  // cancel landing in that gap would leave the stale check having
  // already passed). Returns the row as it exists immediately after a
  // successful bump, or null if the link doesn't exist OR is not
  // currently 'present' (not enrolled, already cancelled, or cancelled
  // out from under a racing caller -- reopen() is the right call for
  // that case, never a reschedule).
  applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null>;
  // Same atomic-increment guarantee as applyReschedule, PLUS flips
  // desired_state to 'absent' and resets sync_status, as one indivisible
  // unit together with marking the CURRENT generation's history row
  // cleanup_needed=1 -- both the link-row change and the history-row
  // change are applied together (a single transaction for the real
  // SQLite/D1 store; no intervening await for the in-memory one), so a
  // concurrent reader can never observe desired_state='absent' with
  // cleanup_needed still 0, or vice versa.
  // Bug 3 (2026-10-21 review): the generation to flag is now determined
  // FRESH, atomically, by this method itself reading the link's own
  // current generation at the moment it runs -- no longer a `generation`
  // parameter supplied by the caller from an earlier read. A caller-
  // supplied value could go stale if a reopen landed between the
  // caller's read and this call, flagging the WRONG (old) generation for
  // cleanup while the actual current one is silently never flagged
  // ("cleanup cannot target the wrong generation"). Idempotent: if the
  // link is already 'absent' (computed fresh here, never from a stale
  // caller-side check), returns the current row unchanged -- no new
  // revision bump, no re-flagging.
  applyCancel(linkId: string, now: number): Promise<CalendarLinkRow | null>;
  // Same atomic-increment guarantee again, this time incrementing BOTH
  // desired_revision and generation by exactly 1 together, resetting the
  // per-generation fields (google_event_id/etag/sync_status/last_error/
  // attempt_count) back to a fresh-generation starting state, AND
  // inserting the new generation's own history row -- all as ONE atomic
  // unit (Bug 2, 2026-10-20 review: "apply the same fix to recordReopen,
  // which currently advances the link before inserting the new
  // generation's history"). A reader can never observe the link's
  // generation field already bumped without that generation's history
  // row existing.
  // Bug 3 (2026-10-21 review): "overlapping reopen requests can allocate
  // two new generations for a single cancellation." Checking
  // desired_state in recordReopen before awaiting the store operation is
  // insufficient -- two concurrent callers can both read 'absent', one
  // wins and transitions to present, and the other (stale) must NOT
  // unconditionally bump the generation again. `expectedGeneration` is
  // the CANCELED generation this reopen is specifically reopening (the
  // transition's own identity) -- not a value trusted blindly, but
  // compared atomically against the link's true current state inside
  // this same operation:
  //  - current generation == expectedGeneration AND desired_state ==
  //    'absent': the real transition -- perform it, allocating exactly
  //    one new generation, atomically with its history row.
  //  - current generation == expectedGeneration + 1 AND desired_state ==
  //    'present': this exact transition already won (a concurrent
  //    caller completed it first) -- REUSE it; return the current row
  //    unchanged, never allocate a further generation ("repeated
  //    requests for that same reopen must reuse the winning transition").
  //  - anything else: this request no longer matches a real, still-
  //    pending cancellation (it reopened, and/or was cancelled again,
  //    since this caller last read fresh) -- reject (return null), so a
  //    stale reopen request can never reopen a later, separately
  //    canceled meeting it was never asked to reopen.
  applyReopen(linkId: string, expectedGeneration: number, now: number): Promise<CalendarLinkRow | null>;
  getHistory(linkId: string, generation: number): Promise<CalendarLinkHistoryRow | null>;
  insertHistory(row: Omit<CalendarLinkHistoryRow, "createdAt" | "updatedAt">, now: number): Promise<void>;
  updateHistory(linkId: string, generation: number, patch: Partial<CalendarLinkHistoryRow>): Promise<void>;
  // Every generation, across every link, still owed a cleanup attempt --
  // never joined against or gated by the current generation's own
  // create/update work (Issue 2's "keep deletion retries separate").
  // 2026-10-19 review (follow-up): `userId`, when provided, restricts
  // this to generations belonging to that one owner's own links only --
  // required so runReconciliationSweep's own owner-scoped call (Trip
  // Planning's "best-effort immediate reconcile" after an authenticated
  // owner's own action) can never even see, let alone touch, another
  // owner's pending cleanup. Omitted, this is the original, unscoped
  // every-owner query a future global cron still needs.
  listPendingCleanup(now: number, userId?: string): Promise<CalendarLinkHistoryRow[]>;
  // Every link row needing attention (sync_status != 'synced' or a
  // revision mismatch) -- the sweep's ONLY source of work. It never scans
  // `interactions` directly, which is what makes "retry already-enrolled
  // work" and "enroll a new meeting" structurally distinct operations.
  // 2026-10-19 review (follow-up): same `userId` scoping as
  // listPendingCleanup above, and for the same reason.
  listNeedingReconciliation(now: number, userId?: string): Promise<CalendarLinkRow[]>;
}
