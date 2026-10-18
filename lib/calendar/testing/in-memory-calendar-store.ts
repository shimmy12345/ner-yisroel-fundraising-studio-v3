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

import type { CalendarLinkHistoryRow, CalendarLinkRow, CalendarLinkStore } from "../calendar-sync-types.ts";

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

  async updateLinkAsLeaseHolder(linkId: string, leaseOwner: string, patch: Partial<CalendarLinkRow>): Promise<boolean> {
    const link = this.links.get(linkId);
    if (!link || link.leaseOwner !== leaseOwner) return false; // the real guard: a stale worker's write is rejected, never clobbers newer bookkeeping
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
  async applyReschedule(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    if (!link) return null;
    link.desiredRevision += 1;
    if (link.syncStatus === "synced") link.syncStatus = "pending";
    link.updatedAt = now;
    return { ...link };
  }

  async applyCancel(linkId: string, generation: number, now: number): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    if (!link) return null;
    link.desiredRevision += 1;
    link.desiredState = "absent";
    link.syncStatus = "pending";
    link.updatedAt = now;
    const history = this.history.get(`${linkId}:${generation}`);
    if (history) history.cleanupNeeded = true; // same synchronous unit as the link-row change above -- never separately observable
    return { ...link };
  }

  async applyReopen(linkId: string, now: number): Promise<CalendarLinkRow | null> {
    const link = this.links.get(linkId);
    if (!link) return null;
    link.generation += 1;
    link.desiredRevision += 1;
    link.desiredState = "present";
    link.googleEventId = null;
    link.googleEtag = null;
    link.syncStatus = "pending";
    link.lastError = null;
    link.attemptCount = 0;
    link.updatedAt = now;
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

  async listPendingCleanup(): Promise<CalendarLinkHistoryRow[]> {
    return [...this.history.values()].filter((row) => row.cleanupNeeded && row.cleanupStatus !== "done").map((row) => ({ ...row }));
  }

  async listNeedingReconciliation(): Promise<CalendarLinkRow[]> {
    return [...this.links.values()].filter((link) => link.syncStatus !== "synced" || link.syncedRevision !== link.desiredRevision).filter((link) => link.syncStatus !== "missing_remotely").map((link) => ({ ...link }));
  }
}
