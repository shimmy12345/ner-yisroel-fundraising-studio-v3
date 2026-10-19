// A fully in-process, async implementation of CalendarLinkStore, for
// tests that need to deliberately interleave two or more concurrent
// reconcile attempts with precise control (via deferred promises on the
// paired fake GoogleCalendarClient) -- faster and more surgically
// controllable than a real database for proving the lease/revision
// race-safety properties. The lease/CAS semantics implemented here are
// intentionally the SAME invariants the sqlite-backed store (and a real
// D1 adapter, later) must also uphold -- see
// tests/calendar-sync-sqlite-store.test.mjs for the persistence-level
// proof that a real SQL schema enforces the same guarantees.

import { randomUUID } from "node:crypto";
import type { CalendarLinkHistoryRow, CalendarLinkRow, CalendarLinkStore } from "../calendar-sync-types.ts";
import { deriveGoogleEventId } from "../calendar-event-id.ts";

export class InMemoryCalendarStore implements CalendarLinkStore {
  private links = new Map<string, CalendarLinkRow>();
  private history = new Map<string, CalendarLinkHistoryRow>(); // key: `${linkId}:${generation}`

  async getLinkByInteraction(interactionId: string): Promise<CalendarLinkRow | null> {
    for (const link of this.links.values()) if (link.interactionId === interactionId) return { ...link };
    return null;
  }

  async getLinkById(linkId: string): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    return link ? { ...link } : null;
  }

  async insertLink(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null> {
    for (const existing of this.links.values()) if (existing.interactionId === row.interactionId) return null;
    const full: CalendarLinkRow = { ...row, createdAt: now, updatedAt: now };
    this.links.set(full.id, full);
    return { ...full };
  }

  // Bug 2 (2026-10-20 review): both writes happen synchronously, with no
  // `await` between them -- the same atomicity a real single SQL
  // transaction provides, not an accident of JS's single thread. If the
  // link insert is rejected (interaction already enrolled), the history
  // insert never happens at all; there is no way to observe one without
  // the other.
  async insertLinkWithHistory(row: Omit<CalendarLinkRow, "createdAt" | "updatedAt">, now: number): Promise<CalendarLinkRow | null> {
    const link = await this.insertLink(row, now);
    if (!link) return null;
    await this.insertHistory({ id: randomUUID(), linkId: link.id, generation: 0, googleEventId: deriveGoogleEventId(link.interactionId, 0), createStatus: "not_attempted", cleanupNeeded: false, cleanupStatus: "not_needed", cleanupAttempts: 0 }, now);
    return link;
  }

  async ensureHistory(linkId: string, generation: number, googleEventId: string, now: number, cleanupNeeded = false): Promise<CalendarLinkHistoryRow> {
    const existing = this.history.get(`${linkId}:${generation}`);
    if (existing) return { ...existing };
    const created: CalendarLinkHistoryRow = { id: randomUUID(), linkId, generation, googleEventId, createStatus: "not_attempted", cleanupNeeded, cleanupStatus: "not_needed", cleanupAttempts: 0, createdAt: now, updatedAt: now };
    this.history.set(`${linkId}:${generation}`, created);
    return { ...created };
  }

  async acquireLease(linkId: string, leaseOwner: string, now: number, ttlSeconds: number): Promise<boolean> {
    const link = this.links.get(linkId);
    if (!link) return false;
    if (link.leaseOwner && link.leaseExpiresAt !== null && link.leaseExpiresAt > now) return false;
    link.leaseOwner = leaseOwner;
    link.leaseExpiresAt = now + ttlSeconds;
    return true;
  }

  async releaseLease(linkId: string, leaseOwner: string): Promise<boolean> {
    const link = this.links.get(linkId);
    if (!link || link.leaseOwner !== leaseOwner) return false; // a stale/superseded worker must never clear someone else's lease
    link.leaseOwner = null;
    link.leaseExpiresAt = null;
    return true;
  }

  // 2026-10-19 review, issue 3: ALSO checks `leaseExpiresAt > now` --
  // the ORIGINAL version checked `leaseOwner` string equality alone,
  // which let an EXPIRED worker's write still land as long as no one
  // else had yet acquired the lease (expiry alone does not clear
  // `leaseOwner`; only a NEW acquireLease call, or an explicit release,
  // does). `now` is checked atomically in this same synchronous unit as
  // the write, never trusted from an earlier, possibly-stale caller-side
  // check.
  async updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, now: number, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const link = this.links.get(linkId);
    if (!link || link.leaseOwner !== leaseOwner) return false; // the real guard: a stale worker's write is rejected, never clobbers newer bookkeeping
    if (link.leaseExpiresAt === null || link.leaseExpiresAt <= now) return false; // an EXPIRED lease holder must never write bookkeeping, even if no one else has acquired it yet
    Object.assign(link, patch);
    return true;
  }

  async writeIntent(linkId: string, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const link = this.links.get(linkId);
    if (!link) return false;
    Object.assign(link, patch); // unconditional -- never lease-gated, by design
    return true;
  }

  // Issue 4: every field touched here is mutated synchronously, with no
  // `await` between reading `link.desiredRevision`/`link.generation` and
  // writing the incremented value -- the same atomicity guarantee a real
  // single SQL UPDATE statement provides, not an accident of there being
  // only one JS thread. (An implementation that `await`ed partway through
  // would NOT correctly model a real database's guarantee and would
  // reintroduce exactly the lost-update race this method exists to rule
  // out structurally.)
  // Bug 3 (2026-10-21 review): re-checks desiredState === 'present'
  // atomically here -- in the SAME synchronous unit as the mutation,
  // never trusting a caller's own earlier read -- and rejects (null) if
  // the meeting is no longer present (cancelled out from under a racing
  // caller). This is what makes the precondition genuinely atomic rather
  // than aspirational: a caller checking "present" on a stale read, then
  // awaiting before calling this method, can no longer slip a reschedule
  // through after a cancel has landed in that gap.
  // 2026-10-19 review, issue 2: resets OUT OF any terminal failure state
  // (not just "synced") back to "pending" -- corrected meeting details
  // (or an explicit retry that reaches this same entry point) must be
  // able to resume a link that was previously "failed"/"invalid"/
  // "auth_required", none of which are retried automatically anymore.
  // "missing_remotely" is deliberately excluded -- a manually-deleted
  // event is a different concern (Issue 7) and must stay excluded from
  // automatic reconciliation even after a reschedule; only an explicit
  // reopen resumes that case.
  async applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    if (!link || link.desiredState !== "present") return null;
    link.desiredRevision += 1;
    if (link.syncStatus === "synced" || link.syncStatus === "failed" || link.syncStatus === "invalid" || link.syncStatus === "auth_required") {
      link.syncStatus = "pending";
      link.nextRetryAt = null;
    }
    link.updatedAt = now;
    return { ...link };
  }

  // Bug 3 (2026-10-21 review): the generation to flag for cleanup is now
  // read FRESH from the live link row, in this same synchronous unit --
  // never a `generation` argument supplied by a caller from an earlier
  // read, which could go stale if a reopen landed in the gap between
  // that read and this call (flagging the wrong, already-superseded
  // generation while the real current one is never flagged). Idempotent:
  // if already absent (checked fresh, never from a stale caller-side
  // read), returns the current row unchanged.
  async applyCancel(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    if (!link) return null;
    if (link.desiredState === "absent") return { ...link }; // already cancelled -- idempotent no-op, no new work generated
    const currentGeneration = link.generation;
    link.desiredRevision += 1;
    link.desiredState = "absent";
    link.syncStatus = "pending";
    link.nextRetryAt = null;
    link.updatedAt = now;
    const history = this.history.get(`${linkId}:${currentGeneration}`);
    if (history) history.cleanupNeeded = true; // same synchronous unit as the link-row change above -- never separately observable
    return { ...link };
  }

  // Bug 2 (2026-10-20 review): the generation bump AND the new
  // generation's history insert happen in the same synchronous unit --
  // never observable with the link advanced but the history missing.
  //
  // Bug 3 (2026-10-21 review): `expectedGeneration` is the specific
  // canceled generation this reopen is reopening -- its own transition
  // identity -- verified atomically against the LIVE row, in this same
  // synchronous unit, rather than trusted from a caller's earlier read.
  // Three outcomes:
  //  - live state is exactly (generation == expectedGeneration, absent):
  //    the real transition -- perform it, allocating exactly one new
  //    generation atomically with its history row.
  //  - live state is exactly (generation == expectedGeneration + 1,
  //    present): this exact transition already won, by a concurrent
  //    caller that reached this method first -- REUSE it; return the
  //    current row unchanged, never allocate a second generation for the
  //    same cancellation ("overlapping reopen requests can allocate two
  //    new generations for a single cancellation").
  //  - anything else: this request no longer matches any real, still-
  //    pending cancellation (it was already reopened and separately
  //    re-cancelled since this caller last read fresh) -- reject (null),
  //    so a stale reopen can never reopen a later, different
  //    cancellation it was never asked to reopen.
  async applyReopen(linkId: string, expectedGeneration: number, now: number): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    if (!link) return null;
    if (link.generation === expectedGeneration + 1 && link.desiredState === "present") {
      return { ...link }; // replay of the already-won transition -- reuse it, allocate nothing further
    }
    if (link.generation !== expectedGeneration || link.desiredState !== "absent") {
      return null; // stale -- no longer the same pending cancellation this request was meant to reopen
    }
    link.generation += 1;
    link.desiredRevision += 1;
    link.desiredState = "present";
    link.googleEventId = null;
    link.googleEtag = null;
    link.syncStatus = "pending";
    link.lastError = null;
    link.attemptCount = 0;
    link.nextRetryAt = null;
    link.updatedAt = now;
    this.history.set(`${linkId}:${link.generation}`, { id: randomUUID(), linkId, generation: link.generation, googleEventId: deriveGoogleEventId(link.interactionId, link.generation), createStatus: "not_attempted", cleanupNeeded: false, cleanupStatus: "not_needed", cleanupAttempts: 0, createdAt: now, updatedAt: now });
    return { ...link };
  }

  async getHistory(linkId: string, generation: number): Promise<CalendarLinkHistoryRow | null> {
    const row = this.history.get(`${linkId}:${generation}`);
    return row ? { ...row } : null;
  }

  async insertHistory(row: Omit<CalendarLinkHistoryRow, "createdAt" | "updatedAt">, now: number): Promise<void> {
    this.history.set(`${row.linkId}:${row.generation}`, { ...row, createdAt: now, updatedAt: now });
  }

  async updateHistory(linkId: string, generation: number, patch: Partial<CalendarLinkHistoryRow>): Promise<void> {
    const row = this.history.get(`${linkId}:${generation}`);
    if (!row) return;
    Object.assign(row, patch);
  }

  // 2026-10-19 review (follow-up): `userId`, when provided, restricts
  // this to generations whose OWN link belongs to that one owner -- see
  // this method's own interface doc comment (calendar-sync-types.ts).
  async listPendingCleanup(_now: number, userId?: string): Promise<CalendarLinkHistoryRow[]> {
    return [...this.history.values()]
      .filter((row) => row.cleanupNeeded && row.cleanupStatus !== "done")
      .filter((row) => !userId || this.links.get(row.linkId)?.userId === userId)
      .map((row) => ({ ...row }));
  }

  // 2026-10-19 review, issue 2: EXCLUDES "invalid"/"auth_required" links
  // entirely -- both are permanent-until-explicitly-corrected states that
  // must never be retried on the normal sweep schedule ("stop automatic
  // retries for permanent invalid requests") -- and defers a "failed"
  // link whose `nextRetryAt` is still in the future, implementing the
  // bounded backoff `now` is passed in for.
  // 2026-10-19 review (follow-up): `userId`, when provided, restricts
  // this to that one owner's own links only.
  async listNeedingReconciliation(now: number, userId?: string): Promise<CalendarLinkRow[]> {
    return [...this.links.values()]
      .filter((link) => link.syncStatus !== "synced" || link.syncedRevision !== link.desiredRevision)
      .filter((link) => link.syncStatus !== "missing_remotely" && link.syncStatus !== "invalid" && link.syncStatus !== "auth_required")
      .filter((link) => link.nextRetryAt === null || link.nextRetryAt <= now)
      .filter((link) => !userId || link.userId === userId)
      .map((link) => ({ ...link }));
  }
}
