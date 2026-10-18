// Prototype of the request-idempotency contract for Capture's meeting
// creation (Issue 1 of the reviewed design). This is the CONTRACT only --
// pure logic plus an injectable store interface -- never wired into the
// live `POST /api/interactions` route by this change. A real route
// integration (and the matching D1-backed store) is future, explicitly
// out of this round's authorized scope.
//
// Contract:
//  - The client generates one idempotency key per save attempt (kept
//    stable across retries of that SAME save; see MeetingCreateKeySession
//    below), sent alongside the request.
//  - Lookups are always scoped to (ownerUserId, key) -- never key alone --
//    so one owner's retry can never see or return another owner's row,
//    even in the astronomically unlikely event of a raw UUID collision
//    across owners.
//  - Reusing a key with DIFFERENT meeting content (a fingerprint of the
//    meaningful fields) is rejected as a conflict, never silently
//    accepted as if it were a safe retry of the original request.
//  - A genuinely new meeting always gets a fresh key -- MeetingCreateKeySession
//    only rotates its key after a save actually succeeds.
//
// Independent review (2026-10-19) found that the first draft called
// `createInteraction()` BEFORE claiming the idempotency key: two
// concurrent calls with the same (owner, key) both passed the "not found"
// lookup (neither had saved yet), so BOTH created a real interaction row
// before either reached the key-claim step -- the loser's row was
// orphaned even though both responses correctly referenced the same
// "winning" id. Fixed per the review's own suggested direction: the
// interaction's own id is now a DETERMINISTIC function of (ownerUserId,
// key), computed BEFORE calling createInteraction, and createInteraction
// itself must perform an ATOMIC create-or-find (an `INSERT ... ON
// CONFLICT(id) DO NOTHING`-shaped operation, reporting back whether THIS
// call actually created the row). Two concurrent calls now derive the
// IDENTICAL candidate id, so the real duplicate-prevention guarantee is
// the interaction table's own primary-key constraint -- enforced by the
// database engine itself, not by which of two racing application-level
// checks happens to run first. This also makes the sequence crash-safe:
// if the process dies after createInteraction() commits but before the
// key record is saved, a retry (same or a fresh process) recomputes the
// same candidate id, finds the row already created, and converges on it
// -- never a second row.
//
// A SECOND independent review (2026-10-20) found that the create-or-find
// contract above, while duplicate-safe, was NOT content-safe: when
// `createInteraction` finds an id already occupied (created=false), it
// was only asked for `{id, created}` -- never what content actually ended
// up there. Two concurrent DIFFERENT-content requests for the same
// (owner, key) could interleave so that request B's create-or-find found
// request A's already-persisted content, reported success
// ("replayed") for B's OWN request, and then saved the idempotency
// record with B's OWN fingerprint -- leaving the system with A's content
// actually persisted but B's fingerprint recorded against it: a caller
// (B) that received a success response for details that were never
// actually saved anywhere. Fixed by requiring `createInteraction` to
// report back the ACTUAL persisted content (whichever call created it),
// and comparing a freshly-recomputed fingerprint of that real content
// against the caller's OWN requested fingerprint before ever treating the
// outcome as anything but a conflict -- see `createMeetingIdempotently`'s
// own comment below for the exact mechanism.

import { createHash, randomUUID } from "node:crypto";

export type IdempotencyKeyRecord = {
  key: string;
  ownerUserId: string;
  interactionId: string;
  fingerprint: string;
  createdAt: number;
};

export interface IdempotencyKeyStore {
  find(ownerUserId: string, key: string): Promise<IdempotencyKeyRecord | null>;
  // Race-safe insert: must return false (never throw, never silently
  // overwrite) if a record for (ownerUserId, key) already exists --
  // mirrors this codebase's own "UNIQUE constraint is the real
  // guarantee, an app-level pre-check alone is not" convention.
  save(record: IdempotencyKeyRecord): Promise<boolean>;
}

// The meaningful scheduling fields a fingerprint is computed from.
// Deliberately includes `endAt`/`location` (2026-10-20 review: "include
// all meaningful scheduling fields in the fingerprint, including end
// time/duration and location") -- a key reused with the same donor/time
// but a materially different duration or location must still be treated
// as different content, never silently replayed.
export type MeetingFingerprintFields = {
  donorId: string;
  type: string;
  occurredAt: number | null;
  allDay: boolean;
  allDayDate: string | null;
  endAt: number | null;
  location: string | null;
  summary: string;
};

// `createInteraction` is handed the deterministic candidate id this
// module already derived -- it must never invent a different id, and its
// own persistence must be a real atomic create-or-find (never a plain
// unconditional INSERT), reporting `created: true` only for the one call
// that actually wrote the row. It must ALSO report `persistedFields` --
// the ACTUAL content now stored at that id, whether this call just wrote
// it or found it already there from a concurrent winner (2026-10-20
// review, Issue 1: "the create-or-find contract must verify existing
// content, not merely return id/created").
export type CreateMeetingRequest = {
  key: string;
  ownerUserId: string;
  fingerprint: string;
  createInteraction: (candidateId: string) => Promise<{ id: string; created: boolean; persistedFields: MeetingFingerprintFields }>;
};

export type IdempotentCreateResult = { outcome: "created"; interactionId: string } | { outcome: "replayed"; interactionId: string } | { outcome: "conflict" };

// Deterministic, owner-scoped interaction identity -- the real
// duplicate-prevention guarantee (Issue 1 of the 2026-10-19 review).
// Deliberately derived from (ownerUserId, key) ONLY, never the
// fingerprint: this guarantees AT MOST ONE interaction row can ever be
// created for a given (owner, key) pair regardless of what content a
// caller attempts to attach to it -- a key reused with different content
// can still corrupt nothing beyond being correctly rejected as a
// conflict (see below), never by racing a second real row into
// existence.
export function deriveInteractionIdForKey(ownerUserId: string, key: string): string {
  return `cap-${createHash("sha256").update(`${ownerUserId}:${key}`).digest("hex").slice(0, 32)}`;
}

export async function createMeetingIdempotently(store: IdempotencyKeyStore, now: number, request: CreateMeetingRequest): Promise<IdempotentCreateResult> {
  const existing = await store.find(request.ownerUserId, request.key);
  if (existing) {
    if (existing.fingerprint !== request.fingerprint) return { outcome: "conflict" };
    return { outcome: "replayed", interactionId: existing.interactionId };
  }

  const candidateId = deriveInteractionIdForKey(request.ownerUserId, request.key);
  const { id, created, persistedFields } = await request.createInteraction(candidateId);

  // 2026-10-20 review fix: verify the content actually persisted at this
  // id -- whether THIS call wrote it (created=true) or a concurrent
  // winner already had (created=false) -- matches what THIS caller
  // actually asked for, before ever treating the outcome as a success.
  // If a concurrent, DIFFERENT-content request already occupies this
  // (owner, key)'s candidate id, this caller's own content was NEVER
  // actually saved anywhere -- reporting "replayed" here would be a
  // false success. Reporting "conflict" instead, and returning WITHOUT
  // ever calling store.save(), is what prevents the idempotency record
  // from ever being saved with a fingerprint that doesn't match the
  // interaction it points at.
  const persistedFingerprint = computeMeetingFingerprint(persistedFields);
  if (persistedFingerprint !== request.fingerprint) return { outcome: "conflict" };

  const saved = await store.save({ key: request.key, ownerUserId: request.ownerUserId, interactionId: id, fingerprint: request.fingerprint, createdAt: now });
  if (saved) return { outcome: created ? "created" : "replayed", interactionId: id };

  // Lost a race against a concurrent, identical save attempt that won
  // first -- re-read and defer to the winner rather than treating this as
  // an error (both callers wanted the same outcome: exactly one meeting,
  // and since `id` above is derived purely from (owner, key), the winner's
  // interactionId is always identical to `id` anyway). The content-match
  // check above already proved the winner's content equals what THIS
  // caller wanted, so deferring to it is safe.
  const winner = await store.find(request.ownerUserId, request.key);
  if (winner && winner.fingerprint === request.fingerprint) return { outcome: "replayed", interactionId: winner.interactionId };
  return { outcome: "conflict" };
}

// A stable fingerprint of exactly the fields that determine "is this the
// same meeting content," so a key reused with genuinely different
// meeting details is correctly rejected rather than silently replayed.
export function computeMeetingFingerprint(fields: MeetingFingerprintFields): string {
  return createHash("sha256").update(JSON.stringify([fields.donorId, fields.type, fields.occurredAt, fields.allDay, fields.allDayDate, fields.endAt, fields.location, fields.summary])).digest("hex");
}

// Client-side key lifecycle: one idempotency key per in-progress save,
// retained across retries, rotated ONLY after a confirmed success -- so a
// retry of a failed/timed-out save reuses the key (safe, deduped by the
// contract above), while starting a genuinely new meeting always gets a
// fresh one.
export class MeetingCreateKeySession {
  private key: string;
  private readonly generateId: () => string;
  constructor(generateId: () => string = randomUUID) {
    this.generateId = generateId;
    this.key = this.generateId();
  }
  currentKey(): string {
    return this.key;
  }
  onSaveSucceeded(): void {
    this.key = this.generateId();
  }
}
