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

function isUniqueConstraintViolation(error: unknown): boolean {
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
          (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(row.id, row.interactionId, row.userId, row.googleCalendarId, row.generation, row.googleEventId, row.googleEtag, row.desiredState, row.desiredRevision, row.syncedRevision, row.syncStatus, row.lastError, row.attemptCount, row.leaseOwner, row.leaseExpiresAt, now, now)
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
      await this.db.batch([
        this.db
          .prepare(
            `INSERT INTO calendar_event_links
            (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(row.id, row.interactionId, row.userId, row.googleCalendarId, row.generation, row.googleEventId, row.googleEtag, row.desiredState, row.desiredRevision, row.syncedRevision, row.syncStatus, row.lastError, row.attemptCount, row.leaseOwner, row.leaseExpiresAt, now, now),
        this.db
          .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, 0, ?, 'not_attempted', 0, 'not_needed', 0, ?, ?)`)
          .bind(randomUUID(), row.id, deriveGoogleEventId(row.interactionId, 0), now, now),
      ]);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return null; // UNIQUE(interaction_id) collision -- the whole batch rolled back, nothing partially committed
      throw error;
    }
    return this.getLinkById(row.id);
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

  async updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([key]) => key in LINK_PATCH_COLUMNS);
    if (entries.length === 0) return true;
    const setClause = entries.map(([key]) => `${LINK_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number | null> = entries.map(([, value]) => (value as string | number | null));
    const result = await this.db.prepare(`UPDATE calendar_event_links SET ${setClause} WHERE id = ? AND lease_owner = ?`).bind(...values, linkId, leaseOwner).run();
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
  async applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const result = await this.db.prepare(`UPDATE calendar_event_links SET desired_revision = desired_revision + 1, sync_status = CASE WHEN sync_status = 'synced' THEN 'pending' ELSE sync_status END, updated_at = ? WHERE id = ? AND desired_state = 'present'`).bind(now, linkId).run();
    if (result.meta.changes === 0) return null;
    return this.getLinkById(linkId);
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
  async applyCancel(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    await this.db.batch([
      this.db.prepare(`UPDATE calendar_event_links SET desired_revision = desired_revision + 1, desired_state = 'absent', sync_status = 'pending', updated_at = ? WHERE id = ? AND desired_state != 'absent'`).bind(now, linkId),
      this.db.prepare(`UPDATE calendar_event_link_history SET cleanup_needed = 1 WHERE link_id = ? AND generation = (SELECT generation FROM calendar_event_links WHERE id = ?)`).bind(linkId, linkId),
    ]);
    return this.getLinkById(linkId);
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

    await this.db.batch([
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
            updated_at = ?
          WHERE id = ? AND generation = ? AND desired_state = 'absent'`,
        )
        .bind(newGeneration, now, linkId, expectedGeneration),
      this.db
        .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) SELECT ?, ?, ?, ?, 'not_attempted', 0, 'not_needed', 0, ?, ? WHERE NOT EXISTS (SELECT 1 FROM calendar_event_link_history WHERE link_id = ? AND generation = ?)`)
        .bind(randomUUID(), linkId, newGeneration, deriveGoogleEventId(before.interactionId, newGeneration), now, now, linkId, newGeneration),
    ]);

    const current = await this.getLinkById(linkId);
    if (!current) return null;
    if (current.generation === newGeneration && current.desiredState === "present") return current; // this exact transition won OR was already won (replay) -- reuse it either way
    return null; // no longer matches any real, still-pending cancellation this request was meant to reopen
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

  async listPendingCleanup(): Promise<CalendarLinkHistoryRow[]> {
    const { results } = await this.db.prepare(`SELECT * FROM calendar_event_link_history WHERE cleanup_needed = 1 AND cleanup_status != 'done'`).all<RawRow>();
    return results.map(toHistoryRow);
  }

  async listNeedingReconciliation(): Promise<CalendarLinkRow[]> {
    const { results } = await this.db.prepare(`SELECT * FROM calendar_event_links WHERE sync_status != 'missing_remotely' AND (sync_status != 'synced' OR synced_revision != desired_revision)`).all<RawRow>();
    return results.map(toLinkRow);
  }
}
