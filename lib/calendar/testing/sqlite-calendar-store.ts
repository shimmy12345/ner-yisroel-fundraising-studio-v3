// A real SQL-backed CalendarLinkStore, built against migration
// 0048_google_calendar_sync.sql on an isolated node:sqlite database --
// proof that the lease/CAS/uniqueness invariants the reconciler depends
// on are actually enforced by the schema itself, not merely by the
// in-memory fake's own bookkeeping. Every write that must behave as a
// compare-and-swap is expressed as a real SQL UPDATE ... WHERE clause
// (not a "SELECT then check in JS then UPDATE" pattern, which would not
// actually be atomic). Wrapped in trivial `async` to match the interface
// D1 itself requires -- node:sqlite's DatabaseSync is synchronous, which
// is exactly what makes it useful for isolating "does the SQL itself
// enforce this" from any async-scheduling nondeterminism.

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CalendarLinkHistoryRow, CalendarLinkRow, CalendarLinkStore, CreateStatus, CleanupStatus, DesiredState, SyncStatus } from "../calendar-sync-types.ts";
import { deriveGoogleEventId } from "../calendar-event-id.ts";

// node:sqlite's DatabaseSync.prepare().get()/.all() return a loosely-typed
// row (Record<string, SQLOutputValue>); these narrow it to exactly the
// columns migration 0048 defines, without resorting to `any`.
type RawRow = Record<string, string | number | bigint | Uint8Array | null>;

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

export class SqliteCalendarStore implements CalendarLinkStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async getLinkByInteraction(interactionId: string): Promise<CalendarLinkRow | null> {
    const row = this.db.prepare("SELECT * FROM calendar_event_links WHERE interaction_id = ?").get(interactionId);
    return row ? toLinkRow(row) : null;
  }

  async getLinkById(linkId: string): Promise<CalendarLinkRow | null> {
    const row = this.db.prepare("SELECT * FROM calendar_event_links WHERE id = ?").get(linkId);
    return row ? toLinkRow(row) : null;
  }

  async insertLink(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null> {
    try {
      this.db
        .prepare(
          `INSERT INTO calendar_event_links
          (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.interactionId, row.userId, row.googleCalendarId, row.generation, row.googleEventId, row.googleEtag, row.desiredState, row.desiredRevision, row.syncedRevision, row.syncStatus, row.lastError, row.attemptCount, row.leaseOwner, row.leaseExpiresAt, now, now);
    } catch {
      return null; // UNIQUE(interaction_id) collision -- the real duplicate-prevention backstop
    }
    return this.getLinkById(row.id);
  }

  // Bug 2 (2026-10-20 review): the link INSERT and generation-0 history
  // INSERT happen inside one real SQL transaction -- if the history
  // insert fails for any reason, the link insert is rolled back too, so
  // no partial ("link exists, history doesn't") state can ever be
  // committed.
  async insertLinkWithHistory(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO calendar_event_links
          (id, interaction_id, user_id, google_calendar_id, generation, google_event_id, google_etag, desired_state, desired_revision, synced_revision, sync_status, last_error, attempt_count, lease_owner, lease_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.interactionId, row.userId, row.googleCalendarId, row.generation, row.googleEventId, row.googleEtag, row.desiredState, row.desiredRevision, row.syncedRevision, row.syncStatus, row.lastError, row.attemptCount, row.leaseOwner, row.leaseExpiresAt, now, now);
      this.db
        .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, 0, ?, 'not_attempted', 0, 'not_needed', 0, ?, ?)`)
        .run(randomUUID(), row.id, deriveGoogleEventId(row.interactionId, 0), now, now);
      this.db.exec("COMMIT");
    } catch {
      this.db.exec("ROLLBACK");
      return null; // UNIQUE(interaction_id) collision (or any other failure) -- nothing partially committed
    }
    return this.getLinkById(row.id);
  }

  // Bug 2 (2026-10-20 review): idempotent self-heal. `INSERT ... ON
  // CONFLICT DO NOTHING` means a history row that already exists is
  // never touched/overwritten -- only a genuinely missing one is created.
  async ensureHistory(linkId: string, generation: number, googleEventId: string, now: number, cleanupNeeded = false): Promise<CalendarLinkHistoryRow> {
    this.db
      .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'not_attempted', ?, 'not_needed', 0, ?, ?) ON CONFLICT(link_id, generation) DO NOTHING`)
      .run(randomUUID(), linkId, generation, googleEventId, cleanupNeeded ? 1 : 0, now, now);
    const row = this.db.prepare("SELECT * FROM calendar_event_link_history WHERE link_id = ? AND generation = ?").get(linkId, generation);
    return toHistoryRow(row as RawRow);
  }

  async acquireLease(linkId: string, leaseOwner: string, now: number, ttlSeconds: number): Promise<boolean> {
    const result = this.db.prepare(`UPDATE calendar_event_links SET lease_owner = ?, lease_expires_at = ? WHERE id = ? AND (lease_expires_at IS NULL OR lease_expires_at < ?)`).run(leaseOwner, now + ttlSeconds, linkId, now);
    return Number(result.changes) === 1;
  }

  async releaseLease(linkId: string, leaseOwner: string): Promise<boolean> {
    const result = this.db.prepare(`UPDATE calendar_event_links SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?`).run(linkId, leaseOwner);
    return Number(result.changes) === 1;
  }

  async updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([key]) => key in LINK_PATCH_COLUMNS);
    if (entries.length === 0) return true;
    const setClause = entries.map(([key]) => `${LINK_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number | null> = entries.map(([, value]) => (value as string | number | null));
    const result = this.db.prepare(`UPDATE calendar_event_links SET ${setClause} WHERE id = ? AND lease_owner = ?`).run(...values, linkId, leaseOwner);
    return Number(result.changes) === 1;
  }

  async writeIntent(linkId: string, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const entries = Object.entries(patch).filter(([key]) => key in LINK_PATCH_COLUMNS);
    if (entries.length === 0) return true;
    const setClause = entries.map(([key]) => `${LINK_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number | null> = entries.map(([, value]) => (value as string | number | null));
    const result = this.db.prepare(`UPDATE calendar_event_links SET ${setClause} WHERE id = ?`).run(...values, linkId);
    return Number(result.changes) === 1;
  }

  // Issue 4: the `+ 1` happens INSIDE the SQL statement itself
  // (`desired_revision = desired_revision + 1`), never computed in
  // application code from a value read moments earlier -- this is what
  // makes two genuinely concurrent callers safe: SQLite serializes the
  // two UPDATE statements against each other regardless of how their
  // surrounding async JS happens to interleave, so one necessarily reads
  // (and increments) the OTHER's already-written value, never the same
  // stale value twice.
  //
  // Bug 3 (2026-10-21 review): the `WHERE ... AND desired_state =
  // 'present'` guard re-checks the precondition atomically, as part of
  // THIS SAME statement, rather than trusting a caller's own earlier
  // read -- a cancel that landed after that read but before this call
  // now correctly makes this UPDATE affect zero rows, reported as null,
  // instead of silently bumping the revision of an absent meeting.
  async applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const result = this.db.prepare(`UPDATE calendar_event_links SET desired_revision = desired_revision + 1, sync_status = CASE WHEN sync_status = 'synced' THEN 'pending' ELSE sync_status END, updated_at = ? WHERE id = ? AND desired_state = 'present'`).run(now, linkId);
    if (Number(result.changes) === 0) return null; // link doesn't exist, or is no longer 'present' -- reopen() is the right call for that case
    return this.getLinkById(linkId);
  }

  // Same atomic-increment guarantee, plus the desired_state flip and the
  // CURRENT generation's history row cleanup_needed flag applied
  // together as one SQL transaction -- a concurrent reader can never
  // observe one change without the other.
  //
  // Bug 3 (2026-10-21 review): the generation to flag is read FRESH,
  // inside this SAME transaction, immediately before the UPDATE -- never
  // a `generation` argument supplied by the caller from an earlier read,
  // which could go stale if a reopen landed in the gap between that read
  // and this call (flagging the wrong, already-superseded generation
  // while the real current one is silently never flagged -- "cleanup
  // cannot target the wrong generation"). Idempotent: if the live row is
  // already 'absent' (checked fresh here, never from a stale caller-side
  // read), this is a no-op returning the current row unchanged.
  async applyCancel(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM calendar_event_links WHERE id = ?").get(linkId) as RawRow | undefined;
      if (!current) {
        this.db.exec("COMMIT");
        return null;
      }
      if ((current.desired_state as DesiredState) === "absent") {
        this.db.exec("COMMIT");
        return toLinkRow(current); // already cancelled -- idempotent no-op, no new work generated
      }
      const currentGeneration = current.generation as number;
      this.db.prepare(`UPDATE calendar_event_links SET desired_revision = desired_revision + 1, desired_state = 'absent', sync_status = 'pending', updated_at = ? WHERE id = ?`).run(now, linkId);
      this.db.prepare(`UPDATE calendar_event_link_history SET cleanup_needed = 1 WHERE link_id = ? AND generation = ?`).run(linkId, currentGeneration);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getLinkById(linkId);
  }

  // Same atomic-increment guarantee for BOTH desired_revision and
  // generation together, plus the fresh-generation field reset AND the
  // new generation's own history row insert -- all inside one real SQL
  // transaction (Bug 2, 2026-10-20 review: "apply the same fix to
  // recordReopen, which currently advances the link before inserting the
  // new generation's history"). A reader can never observe the link's
  // generation already bumped without that generation's history row
  // existing.
  //
  // Bug 3 (2026-10-21 review): "overlapping reopen requests can allocate
  // two new generations for a single cancellation." `expectedGeneration`
  // is the specific canceled generation this reopen is reopening -- its
  // own transition identity -- verified atomically against the LIVE row,
  // read fresh inside this SAME transaction, rather than trusted from a
  // caller's earlier read:
  //  - live state is exactly (generation == expectedGeneration, absent):
  //    the real transition -- perform it, allocating exactly one new
  //    generation atomically with its history row.
  //  - live state is exactly (generation == expectedGeneration + 1,
  //    present): this exact transition already won, by a concurrent
  //    caller that reached this method first -- REUSE it; return the
  //    current row unchanged, never allocate a second generation for the
  //    same cancellation.
  //  - anything else: this request no longer matches any real, still-
  //    pending cancellation -- reject (null), so a stale reopen can
  //    never reopen a later, different cancellation it was never asked
  //    to reopen.
  async applyReopen(linkId: string, expectedGeneration: number, now: number): Promise<CalendarLinkRow | null> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT * FROM calendar_event_links WHERE id = ?").get(linkId) as RawRow | undefined;
      if (!current) {
        this.db.exec("COMMIT");
        return null;
      }
      const currentGeneration = current.generation as number;
      const currentDesiredState = current.desired_state as DesiredState;

      if (currentGeneration === expectedGeneration + 1 && currentDesiredState === "present") {
        this.db.exec("COMMIT");
        return toLinkRow(current); // replay of the already-won transition -- reuse it, allocate nothing further
      }
      if (currentGeneration !== expectedGeneration || currentDesiredState !== "absent") {
        this.db.exec("COMMIT");
        return null; // stale -- no longer the same pending cancellation this request was meant to reopen
      }

      const interactionId = current.interaction_id as string;
      const newGeneration = currentGeneration + 1;
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
        .run(newGeneration, now, linkId, expectedGeneration);
      this.db
        .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'not_attempted', 0, 'not_needed', 0, ?, ?)`)
        .run(randomUUID(), linkId, newGeneration, deriveGoogleEventId(interactionId, newGeneration), now, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getLinkById(linkId);
  }

  async getHistory(linkId: string, generation: number): Promise<CalendarLinkHistoryRow | null> {
    const row = this.db.prepare("SELECT * FROM calendar_event_link_history WHERE link_id = ? AND generation = ?").get(linkId, generation);
    return row ? toHistoryRow(row) : null;
  }

  async insertHistory(row: Omit<CalendarLinkHistoryRow, "createdAt" | "updatedAt">, now: number): Promise<void> {
    this.db
      .prepare(`INSERT INTO calendar_event_link_history (id, link_id, generation, google_event_id, create_status, cleanup_needed, cleanup_status, cleanup_attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.linkId, row.generation, row.googleEventId, row.createStatus, row.cleanupNeeded ? 1 : 0, row.cleanupStatus, row.cleanupAttempts, now, now);
  }

  async updateHistory(linkId: string, generation: number, patch: Partial<CalendarLinkHistoryRow>): Promise<void> {
    const entries = Object.entries(patch).filter(([key]) => key in HISTORY_PATCH_COLUMNS);
    if (entries.length === 0) return;
    const setClause = entries.map(([key]) => `${HISTORY_PATCH_COLUMNS[key]} = ?`).join(", ");
    const values: Array<string | number> = entries.map(([key, value]) => (key === "cleanupNeeded" ? (value ? 1 : 0) : (value as string | number)));
    this.db.prepare(`UPDATE calendar_event_link_history SET ${setClause} WHERE link_id = ? AND generation = ?`).run(...values, linkId, generation);
  }

  async listPendingCleanup(): Promise<CalendarLinkHistoryRow[]> {
    const rows = this.db.prepare(`SELECT * FROM calendar_event_link_history WHERE cleanup_needed = 1 AND cleanup_status != 'done'`).all();
    return rows.map(toHistoryRow);
  }

  async listNeedingReconciliation(): Promise<CalendarLinkRow[]> {
    const rows = this.db.prepare(`SELECT * FROM calendar_event_links WHERE sync_status != 'missing_remotely' AND (sync_status != 'synced' OR synced_revision != desired_revision)`).all();
    return rows.map(toLinkRow);
  }
}
