// A real Cloudflare D1-backed CalendarLinkStore, built against migration
// 0048_google_calendar_sync.sql, against a REAL D1Database binding (the
// hand-rolled cloudflare-env.d.ts type -- never @cloudflare/workers-types).
//
// D1 has NO cross-round-trip transaction mechanism -- no BEGIN/COMMIT, no
// `.transaction()` method. `db.batch()` is the only atomic multi-statement
// primitive Cloudflare documents, and it cannot branch on an earlier
// statement's own result within the same batch: every statement in a
// batch is prepared and submitted up front, not one decided in response
// to a prior one's outcome. This is NOT a drop-in port of
// SqliteCalendarStore's BEGIN IMMEDIATE/COMMIT transactions (that
// mechanism simply does not exist here) -- every write below is instead
// either (a) a single statement whose own WHERE clause embeds the entire
// compare-and-swap guard, so the arithmetic and the precondition check
// happen atomically inside ONE D1 round trip, exactly like
// applyReschedule's `desired_revision = desired_revision + 1 WHERE ...
// AND desired_state = 'present'` already does even in the SQLite version,
// or (b) a `db.batch()` of statements that either reference each other
// only through values ALREADY known in JS before the batch starts (e.g.
// applyReopen's new generation number is `expectedGeneration + 1`, never
// a value that has to be read back from an earlier statement in the same
// batch) or reference each other through a correlated subquery against
// the live row's CURRENT state -- which, within one batch, means "as of
// that later statement's own turn, including whatever the earlier
// statement in the same batch just wrote" (applyCancel's history-flag
// statement reads the link's `generation` this way). See applyCancel's
// and applyReopen's own comments for exactly why each one's specific
// combination of guards is safe, including the one documented case
// (a harmless redundant/orphan write, never a wrong one) each accepts
// rather than needing a more complex guard to rule out entirely.

import { randomUUID } from "node:crypto";
import type { CalendarLinkHistoryRow, CalendarLinkRow, CalendarLinkStore, CreateStatus, CleanupStatus, DesiredState, SyncStatus } from "./calendar-sync-types.ts";
import { deriveGoogleEventId } from "./calendar-event-id.ts";

type RawRow = Record<string, unknown>;

// 2026-10-19 review (second follow-up): an opaque, caller-supplied SQL
// boolean fragment, AND-ed into a guarded statement's own WHERE clause
// (applyCancelStatements here; trip-calendar-sync.ts's own schedule
// intent plan uses the identical shape for its own meeting-side guard --
// see each caller's own doc comment for what it checks and why). `sql`
// must reference only `?` placeholders (never caller-controlled
// strings/identifiers -- every caller in this codebase uses a fixed
// literal EXISTS(...)/NOT EXISTS(...) fragment with bound values, never
// anything derived from request input).
export type D1CrossTableGuard = { sql: string; params: ReadonlyArray<string | number> };

function toLinkRow(row: RawRow): CalendarLinkRow {
  return {
    id: row.id as string,
    interactionId: row.interaction_id as string,
    userId: row.user_id as string,
    googleCalendarId: row.google_calendar_id as string,
    generation: row.generation as number,
    googleEventId: row.google_event_id as string | null,
    googleEtag: row.google_etag as string | null,
    desiredState: row.desired_state as DesiredState,
    desiredRevision: row.desired_revision as number,
    syncedRevision: row.synced_revision as number,
    syncStatus: row.sync_status as SyncStatus,
    lastError: row.last_error as string | null,
    attemptCount: row.attempt_count as number,
    leaseOwner: row.lease_owner as string | null,
    leaseExpiresAt: row.lease_expires_at as number | null,
    nextRetryAt: row.next_retry_at as number | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function toHistoryRow(row: RawRow): CalendarLinkHistoryRow {
  return {
    id: row.id as string,
    linkId: row.link_id as string,
    generation: row.generation as number,
    googleEventId: row.google_event_id as string,
    createStatus: row.create_status as CreateStatus,
    cleanupNeeded: Boolean(row.cleanup_needed),
    cleanupStatus: row.cleanup_status as CleanupStatus,
    cleanupAttempts: row.cleanup_attempts as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

const LINK_PATCH_COLUMNS: Record<string, string> = {
  googleEventId: "google_event_id",
  googleEtag: "google_etag",
  desiredState: "desired_state",
  desiredRevision: "desired_revision",
  syncedRevision: "synced_revision",
  syncStatus: "sync_status",
  lastError: "last_error",
  attemptCount: "attempt_count",
  generation: "generation",
  leaseOwner: "lease_owner",
  leaseExpiresAt: "lease_expires_at",
  nextRetryAt: "next_retry_at",
  updatedAt: "updated_at",
};

const HISTORY_PATCH_COLUMNS: Record<string, string> = {
  createStatus: "create_status",
  cleanupNeeded: "cleanup_needed",
  cleanupStatus: "cleanup_status",
  cleanupAttempts: "cleanup_attempts",
  updatedAt: "updated_at",
};

// D1 wraps the underlying SQLite failure in a thrown Error (observed,
// against a real local D1 binding, to be prefixed `D1_ERROR` with the
// raw SQLite message -- e.g. "UNIQUE constraint failed: ..." --
// appended; see docs/AI-HANDOFF.md for the exact captured text from the
// Linux CI run this was verified against). Narrowly matching on this
// substring, in BOTH the error's own message and its `.cause` chain, is
// what lets insertLink/insertLinkWithHistory distinguish "the real
// UNIQUE(interaction_id) duplicate-prevention backstop fired" (expected,
// returns null) from every other database failure (rethrown, never
// silently reported as "already exists" -- an operational failure must
// never be misreported as a conflict).
const UNIQUE_VIOLATION_PATTERN = /UNIQUE constraint failed/i;

// Exported (2026-10-19, follow-up review) so a caller building its own
// retry loop around a *Statements() builder -- e.g. trips-data.ts's
// scheduleProspectMeeting, which must distinguish "a concurrent enroll
// won the race, re-read and retry" from a genuine, unexpected failure --
// can recognize this same condition without a second copy of the regex.
export function isUniqueConstraintViolation(error: unknown): boolean {
  if (error instanceof Error) {
    if (UNIQUE_VIOLATION_PATTERN.test(error.message)) return true;
    if (error.cause instanceof Error && UNIQUE_VIOLATION_PATTERN.test(error.cause.message)) return true;
  }
  return false;
}

export class D1CalendarStore implements CalendarLinkStore {
  private readonly db: D1Database;
  constructor(db: D1Database) {
    this.db = db;
  }

  async getLinkByInteraction(interactionId: string): Promise<CalendarLinkRow | null> {
    const row = await this.db.prepare("SELECT * FROM calendar_event_links WHERE interaction_id = ?").bind(interactionId).first<RawRow>();
    return row ? toLinkRow(row) : null;
  }

  async getLinkById(linkId: string): Promise<CalendarLinkRow | null> {
    const row = await this.db.prepare("SELECT * FROM calendar_event_links WHERE id = ?").bind(linkId).first<RawRow>();
    return row ? toLinkRow(row) : null;
  }

  async insertLink(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null> {
    try {
      await this.db
        .prepare(
          `INSERT INTO calendar_event_links
          (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, next_retry_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.interactionId, row.userId, row.googleCalendarId, row.generation, row.googleEventId, row.googleEtag, row.desiredState, row.desiredRevision, row.syncedRevision, row.syncStatus, row.lastError, row.attemptCount, row.leaseOwner, row.leaseExpiresAt, row.nextRetryAt, now, now)
        .run();
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return null; // the real UNIQUE(interaction_id) backstop -- an expected conflict, not a failure
      throw error; // any other database failure must surface as a failure, never be silently reported as "already exists"
    }
    return this.getLinkById(row.id);
  }

  // Atomic via db.batch(): D1's documented guarantee is that every
  // statement in one batch call commits together or none do (the same
  // "if any statement fails, the whole batch fails and no writes are
  // committed" semantics SQLite's own BEGIN IMMEDIATE/COMMIT gives the
  // reference store) -- so a crash/failure between the link row and
  // generation 0's history row existing is exactly as impossible here as
  // it is in SqliteCalendarStore. Neither statement here depends on a
  // value read back from the other, so a single batch call is sufficient
  // -- no RETURNING, no follow-up read needed.
  async insertLinkWithHistory(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null> {
    try {
      await this.db.batch(this.insertLinkWithHistoryStatements(row, now));
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return null; // UNIQUE(interaction_id) collision -- the whole batch rolled back, nothing partially committed
      throw error;
    }
    return this.getLinkById(row.id);
  }

  // 2026-10-19 review (follow-up), Integration safety "commit the meeting
  // change and durable sync intent atomically": the un-executed statement
  // pair this method builds is the exact same SQL insertLinkWithHistory
  // itself runs via db.batch() above -- exposed separately so a CALLER
  // that already has its own db.batch() call for an unrelated write (e.g.
  // trips-data.ts's own interactions/trip_prospects update) can append
  // these statements to that SAME batch, making the meeting change and the
  // durable calendar intent commit as one indivisible D1 operation rather
  // than two sequential ones. Never executes anything itself.
  insertLinkWithHistoryStatements(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `INSERT INTO calendar_event_links
          (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, next_retry_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.interactionId, row.userId, row.googleCalendarId, row.generation, row.googleEventId, row.googleEtag, row.desiredState, row.desiredRevision, row.syncedRevision, row.syncStatus, row.lastError, row.attemptCount, row.leaseOwner, row.leaseExpiresAt, row.nextRetryAt, now, now),
      this.db
        .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, 0, ?, 'not_attempted', 0, 'not_needed', 0, ?, ?)`)
        .bind(randomUUID(), row.id, deriveGoogleEventId(row.interactionId, 0), now, now),
    ];
  }

  // Idempotent self-heal -- `INSERT ... ON CONFLICT DO NOTHING` never
  // overwrites an existing row. Two separate round trips (insert, then
  // select), exactly like SqliteCalendarStore's own version -- this was
  // never transactional there either: a concurrent insert landing between
  // the two statements is harmless either way, since by the time the
  // SELECT runs the row (whoever created it) already exists with the
  // correct, final values.
  async ensureHistory(linkId: string, generation: number, googleEventId: string, now: number, cleanupNeeded = false): Promise<CalendarLinkHistoryRow> {
    await this.db
      .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'not_attempted', ?, 'not_needed', 0, ?, ?) ON CONFLICT(link_id, generation) DO NOTHING`)
      .bind(randomUUID(), linkId, generation, googleEventId, cleanupNeeded ? 1 : 0, now, now)
      .run();
    const row = await this.db.prepare("SELECT * FROM calendar_event_link_history WHERE link_id = ? AND generation = ?").bind(linkId, generation).first<RawRow>();
    return toHistoryRow(row as RawRow);
  }

  async acquireLease(linkId: string, leaseOwner: string, now: number, ttlSeconds: number): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE calendar_event_links SET lease_owner = ?, lease_expires_at = ? WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?)`).bind(leaseOwner, now + ttlSeconds, linkId, now).run();
    return result.meta.changes === 1;
  }

  async releaseLease(linkId: string, leaseOwner: string): Promise<boolean> {
    const result = await this.db.prepare(`UPDATE calendar_event_links SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`).bind(linkId, leaseOwner).run();
    return result.meta.changes === 1;
  }

  // 2026-10-19 review, issue 3: ALSO guards `AND lease_expires_at > ?`
  // (bound to `now`, now a required parameter) -- the ORIGINAL version
  // checked `lease_owner` alone, which let an EXPIRED worker's write
  // still land as long as no one else had yet acquired the lease
  // (expiry alone does not clear `lease_owner`; only a NEW acquireLease
  // call, or an explicit release, does). Checked atomically as part of
  // the SAME guarded UPDATE, never a separate, possibly-stale JS check.
  async updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, now: number, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([key]) => key in LINK_PATCH_COLUMNS);
    if (entries.length === 0) return true;
    const setClause = entries.map(([key]) => `${LINK_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number | null> = entries.map(([, value]) => (value as string | number | null));
    const result = await this.db.prepare(`UPDATE calendar_event_links SET ${setClause} WHERE id = ? AND lease_owner = ? AND lease_expires_at > ?`).bind(...values, linkId, leaseOwner, now).run();
    return result.meta.changes === 1;
  }

  async writeIntent(linkId: string, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([key]) => key in LINK_PATCH_COLUMNS);
    if (entries.length === 0) return true;
    const setClause = entries.map(([key]) => `${LINK_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number | null> = entries.map(([, value]) => (value as string | number | null));
    const result = await this.db.prepare(`UPDATE calendar_event_links SET ${setClause} WHERE id = ?`).bind(...values, linkId).run();
    return result.meta.changes === 1;
  }

  // The `+ 1` and the `desired_state = 'present'` precondition both live
  // inside this ONE UPDATE statement's own WHERE clause -- there is
  // nothing D1's lack of cross-statement transactions even affects here:
  // a single guarded statement is already the whole atomic unit, exactly
  // as it is in SqliteCalendarStore.
  // 2026-10-19 review, issue 2: the CASE now resets OUT OF any terminal
  // failure state too -- 'failed', 'invalid', and 'auth_required' all
  // reset to 'pending' (with next_retry_at cleared), not just 'synced'
  // -- see SqliteCalendarStore's own identical comment on this method.
  async applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const result = await this.applyRescheduleStatements(linkId, now)[0].run();
    if (result.meta.changes === 0) return null;
    return this.getLinkById(linkId);
  }

  // Un-executed form of the single guarded UPDATE above, for a caller
  // that needs to append it to its OWN db.batch() call -- see
  // insertLinkWithHistoryStatements' own comment for why this exists.
  // Always exactly one statement (the WHOLE atomic unit is this one
  // guarded UPDATE already -- see this method's own header comment on
  // calendar-sync-types.ts's applyReschedule), so a caller can always
  // safely spread this into a larger batch without needing to know how
  // many statements it contains.
  applyRescheduleStatements(linkId: string, now: number): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `UPDATE calendar_event_links SET
            desired_revision = desired_revision + 1,
            sync_status = CASE WHEN sync_status IN ('synced','failed','invalid','auth_required') THEN 'pending' ELSE sync_status END,
            next_retry_at = CASE WHEN sync_status IN ('synced','failed','invalid','auth_required') THEN NULL ELSE next_retry_at END,
            updated_at = ?
          WHERE id = ? AND desired_state = 'present'`,
        )
        .bind(now, linkId),
    ];
  }

  // D1-native shape (see this file's own header): ONE guarded UPDATE
  // flips desired_state (its WHERE clause -- `desired_state != 'absent'`
  // -- is the entire idempotency guard: if the link is already absent,
  // or doesn't exist, this matches zero rows and nothing below fires
  // wrongly), and a SECOND statement, in the SAME db.batch() call, flags
  // the CURRENT generation's history row via a correlated subquery
  // against calendar_event_links -- read, within the same batch, AFTER
  // the first statement's own write, which is exactly why this reads the
  // CORRECT (not stale) generation: applyCancel never changes
  // `generation` itself, so the value the subquery sees is the same one
  // either way, but reading it via a live subquery rather than a value
  // captured by the caller earlier is what makes this immune to a reopen
  // racing in between an earlier read and this call (Bug 3's own class).
  //
  // The second statement runs even when the first one matched zero rows
  // (link doesn't exist, or already absent) -- its own WHERE/subquery
  // then also matches zero rows (comparing against NULL, for a
  // nonexistent link) or redundantly re-flags an already-flagged
  // cleanup_needed=1 on an unchanged generation. The latter is a
  // deliberate, verified-harmless simplification, not an oversight: every
  // consumer of cleanup_needed (reconcileGenerationCleanupLocked,
  // listPendingCleanup) ALSO gates on cleanup_status, and a generation
  // whose cleanup already reached 'done' is filtered out / short-
  // circuited everywhere before cleanup_needed is ever consulted again --
  // so redundantly setting an already-'done' generation's cleanup_needed
  // back to 1 has no observable effect anywhere. This is simpler and
  // fully atomic (one db.batch() call, no RETURNING, no follow-up read),
  // at the cost of this one documented redundant-write case.
  async applyCancel(linkId: string, now: number, guard?: D1CrossTableGuard): Promise<CalendarLinkRow | null> {
    await this.db.batch(this.applyCancelStatements(linkId, now, guard));
    return this.getLinkById(linkId);
  }

  // Un-executed form of applyCancel's own two-statement db.batch() above
  // -- see insertLinkWithHistoryStatements' own comment for why this
  // exists. Always exactly these two statements, in this order, so a
  // caller spreading this into a larger batch gets the same atomic pair
  // this method already runs on its own.
  //
  // 2026-10-19 review (second follow-up), Integration safety "prevent
  // stale actions from canceling... a later transition": `guard`, when
  // provided, is an opaque boolean SQL fragment (plus its own bind
  // params) AND-ed into BOTH statements' own WHERE clause, re-verified
  // fresh at EXECUTION time, never from a value the caller captured
  // earlier. This module has no knowledge of what the fragment checks
  // (trips-data.ts's own caller supplies one that re-verifies
  // trip_prospects' current status matches what it read before deciding
  // to cancel) -- it only needs the guarantee that BOTH statements here
  // succeed or both fail together, in lockstep with whatever OTHER
  // statement in the caller's own combined batch shares the identical
  // condition. Without this, a stale cancel request (racing a concurrent
  // status change that already moved the prospect on, e.g. to
  // meeting_completed) could still durably cancel the calendar link even
  // though the caller's own guarded meeting-side write correctly
  // rejected the very same stale request as a conflict.
  applyCancelStatements(linkId: string, now: number, guard?: D1CrossTableGuard): D1PreparedStatement[] {
    const extraSql = guard ? ` AND ${guard.sql}` : "";
    const extraParams = guard?.params ?? [];
    return [
      this.db.prepare(`UPDATE calendar_event_links SET desired_revision = desired_revision + 1, desired_state = 'absent', sync_status = 'pending', next_retry_at = NULL, updated_at = ? WHERE id = ? AND desired_state != 'absent'${extraSql}`).bind(now, linkId, ...extraParams),
      this.db.prepare(`UPDATE calendar_event_link_history SET cleanup_needed = 1 WHERE link_id = ? AND generation = (SELECT generation FROM calendar_event_links WHERE id = ?)${extraSql}`).bind(linkId, linkId, ...extraParams),
    ];
  }

  // D1-native shape (see this file's own header). Statement 1 attempts
  // the real transition: generation/desired_revision bump, full
  // fresh-generation field reset, guarded by `generation = ? AND
  // desired_state = 'absent'` bound to `expectedGeneration` -- the exact
  // same transition-identity check Bug 3's fix requires, just expressed
  // as one statement's WHERE clause instead of a value a surrounding
  // transaction re-verified. Statement 2, in the SAME db.batch() call,
  // inserts the new generation's history row -- `newGeneration =
  // expectedGeneration + 1` is already known in JS before the batch even
  // starts (unlike applyCancel's generation-to-flag, which only becomes
  // knowable fresh off the live row), so no RETURNING/follow-up read is
  // needed to make these two statements' identities agree; its own `WHERE
  // NOT EXISTS (... same link_id/generation ...)` guard makes it safe to
  // run unconditionally alongside statement 1 regardless of whether
  // statement 1 itself matched: if statement 1 just won, no row exists
  // yet, so this inserts it; if statement 1 lost (a concurrent winner, or
  // this generation was already reached and is now historical), a row
  // already exists, so this is a no-op; the only remaining case -- a
  // genuinely stale/rejected request whose target generation+1 was NEVER
  // reached by anyone -- would insert an inert, never-looked-up orphan
  // history row (nothing in this codebase ever reads a generation's
  // history except through the link row's OWN current generation), which
  // is harmless clutter, not a correctness hazard, and is what this
  // method's own return-value check below (never trusting the batch's
  // own statement-level success/failure, always re-deriving the real
  // outcome from a fresh read of the link row afterward) is written to
  // never depend on being absent.
  async applyReopen(linkId: string, expectedGeneration: number, now: number): Promise<CalendarLinkRow | null> {
    const before = await this.getLinkById(linkId);
    if (!before) return null;
    const newGeneration = expectedGeneration + 1;

    await this.db.batch(this.applyReopenStatements(linkId, before.interactionId, expectedGeneration, now));

    const current = await this.getLinkById(linkId);
    if (!current) return null;
    if (current.generation === newGeneration && current.desiredState === "present") return current; // this exact transition won OR was already won (replay) -- reuse it either way
    return null; // no longer matches any real, still-pending cancellation this request was meant to reopen
  }

  // Un-executed form of applyReopen's own two-statement db.batch() above
  // -- see insertLinkWithHistoryStatements' own comment for why this
  // exists. `interactionId` must be the SAME link's own interaction_id
  // (applyReopen's own caller reads it off the live row immediately
  // beforehand, since the new generation's deterministic Google event id
  // is derived from it) -- never a value a caller already had cached from
  // an earlier, possibly-stale read.
  applyReopenStatements(linkId: string, interactionId: string, expectedGeneration: number, now: number): D1PreparedStatement[] {
    const newGeneration = expectedGeneration + 1;
    return [
      this.db
        .prepare(
          `UPDATE calendar_event_links SET
            generation = ?,
            desired_revision = desired_revision + 1,
            desired_state = 'present',
            google_event_id = NULL,
            google_etag = NULL,
            sync_status = 'pending',
            last_error = NULL,
            attempt_count = 0,
            next_retry_at = NULL,
            updated_at = ?
          WHERE id = ? AND generation = ? AND desired_state = 'absent'`,
        )
        .bind(newGeneration, now, linkId, expectedGeneration),
      this.db
        .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) SELECT ?, ?, ?, ?, 'not_attempted', 0, 'not_needed', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM calendar_event_link_history WHERE link_id = ? AND generation = ?)`)
        .bind(randomUUID(), linkId, newGeneration, deriveGoogleEventId(interactionId, newGeneration), now, now, linkId, newGeneration),
    ];
  }

  async getHistory(linkId: string, generation: number): Promise<CalendarLinkHistoryRow | null> {
    const row = await this.db.prepare("SELECT * FROM calendar_event_link_history WHERE link_id = ? AND generation = ?").bind(linkId, generation).first<RawRow>();
    return row ? toHistoryRow(row) : null;
  }

  async insertHistory(row: Omit<CalendarLinkHistoryRow, "createdAt" | "updatedAt">, now: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.id, row.linkId, row.generation, row.googleEventId, row.createStatus, row.cleanupNeeded ? 1 : 0, row.cleanupStatus, row.cleanupAttempts, now, now)
      .run();
  }

  async updateHistory(linkId: string, generation: number, patch: Partial<CalendarLinkHistoryRow>): Promise<void> {
    const entries = Object.entries(patch).filter(([key]) => key in HISTORY_PATCH_COLUMNS);
    if (entries.length === 0) return;
    const setClause = entries.map(([key]) => `${HISTORY_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number> = entries.map(([key, value]) => (key === "cleanupNeeded" ? (value ? 1 : 0) : (value as string | number)));
    await this.db.prepare(`UPDATE calendar_event_link_history SET ${setClause} WHERE link_id = ? AND generation = ?`).bind(...values, linkId, generation).run();
  }

  // 2026-10-19 review (follow-up): `userId`, when provided, joins against
  // the owning link row so this can never return -- let alone let the
  // sweep acquire a lease on and mutate -- a generation belonging to a
  // DIFFERENT owner's meeting. `calendar_event_link_history` itself has
  // no `user_id` column (it only ever makes sense in terms of its own
  // link), so the join is the real guard here, not a WHERE on a column
  // that doesn't exist on this table.
  async listPendingCleanup(_now: number, userId?: string): Promise<CalendarLinkHistoryRow[]> {
    if (userId) {
      const { results } = await this.db
        .prepare(
          `SELECT h.* FROM calendar_event_link_history h
          JOIN calendar_event_links l ON l.id = h.link_id
          WHERE h.cleanup_needed = 1 AND h.cleanup_status != 'done' AND l.user_id = ?`,
        )
        .bind(userId)
        .all<RawRow>();
      return results.map(toHistoryRow);
    }
    const { results } = await this.db.prepare(`SELECT * FROM calendar_event_link_history WHERE cleanup_needed = 1 AND cleanup_status != 'done'`).all<RawRow>();
    return results.map(toHistoryRow);
  }

  // 2026-10-19 review, issue 2: EXCLUDES 'invalid'/'auth_required' --
  // both permanent-until-explicitly-corrected states that must never be
  // retried on the normal sweep schedule -- and defers a 'failed' link
  // whose next_retry_at is still in the future (bounded backoff).
  // 2026-10-19 review (follow-up): `userId`, when provided, restricts
  // this to that one owner's own links only -- see this method's own
  // interface doc comment (calendar-sync-types.ts) for why this is
  // required, not merely convenient, for Trip Planning's owner-scoped
  // immediate sweep.
  async listNeedingReconciliation(now: number, userId?: string): Promise<CalendarLinkRow[]> {
    const ownerClause = userId ? "AND user_id = ?" : "";
    const bindings = userId ? [now, userId] : [now];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM calendar_event_links
        WHERE sync_status NOT IN ('missing_remotely','invalid','auth_required')
          AND (sync_status != 'synced' OR synced_revision != desired_revision)
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
          ${ownerClause}`,
      )
      .bind(...bindings)
      .all<RawRow>();
    return results.map(toLinkRow);
  }
}
