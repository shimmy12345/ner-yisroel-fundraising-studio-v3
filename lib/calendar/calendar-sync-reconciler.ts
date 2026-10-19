// The Google Calendar sync core (Issues 1-3, 5, 7 of the reviewed
// design). Pure with respect to I/O -- every network/DB effect is
// injected via the `GoogleCalendarClient`/`CalendarLinkStore` interfaces
// from calendar-sync-types.ts, so this module is fully testable with an
// in-memory fake store+client (for precise, deliberately-interleaved
// concurrency proofs) and, separately, with a real node:sqlite-backed
// store (for schema-level persistence proof). NOT wired into any live
// route or cron by this change.
//
// Two structurally separate concerns, never conflated:
//   1. recordXxx() functions: durable INTENT writes (what should Google
//      show right now), written atomically with whatever FOS-side event
//      caused them. Never touch the network. Always succeed or fail
//      immediately -- a reschedule/cancel is never blocked by Google's
//      availability ("a Google failure must never lose the saved FOS
//      meeting").
//   2. reconcileXxx() functions: the actual network-touching attempts to
//      make Google match the latest recorded intent. Always re-read the
//      current intent fresh at the moment they build a payload -- never
//      replay an earlier capture.
//
// "Retrying already-enrolled work" vs. "enrolling a previously-unsynced
// meeting" are structurally distinct: reconcileXxx() functions and
// runReconciliationSweep() only ever read FROM calendar_event_links
// (via listNeedingReconciliation/listPendingCleanup) -- they never scan
// `interactions` directly, so a meeting with no link row is simply
// invisible to this entire module. Only enrollMeetingForSync(), called
// explicitly and separately, ever creates a new link row.

import { randomUUID } from "node:crypto";
import { deriveGoogleEventId } from "./calendar-event-id.ts";
import { buildGoogleEventBody, mergeFosFieldsIntoExistingEvent } from "./calendar-event-body.ts";
import type { CalendarLinkRow, CalendarLinkStore, GoogleCalendarClient, MeetingDesiredFields } from "./calendar-sync-types.ts";

const DEFAULT_LEASE_TTL_SECONDS = 120;
const MAX_PRECONDITION_RETRIES = 2;

function sanitizedError(status: number | "error", errorClass?: string): string {
  return errorClass ? `${status}:${errorClass}` : String(status);
}

// --- Durable intent (never touches the network) --------------------------

// Bug 2 (2026-10-20 review): "a crash between link creation and history
// creation leaves an unrecoverable enrollment." The link and generation-0
// history rows are now created together via store.insertLinkWithHistory
// -- one atomic unit, so a NEW crash between the two writes can no longer
// happen at all. For an EXISTING link (this interaction was already
// enrolled, possibly under an older, non-atomic version of this
// function, or any other cause), ensureHistory() self-heals a missing
// history row before returning -- "existing incomplete state must be
// detected and repaired... before any Google creation" is satisfied here
// at the earliest possible point, and independently again (as a
// universal backstop, regardless of entry point) inside
// reconcilePresentAbsent's own present-state path below.
export async function enrollMeetingForSync(store: CalendarLinkStore, now: number, args: { interactionId: string; userId: string; googleCalendarId: string }): Promise<CalendarLinkRow | null> {
  const existing = await store.getLinkByInteraction(args.interactionId);
  if (existing) {
    await store.ensureHistory(existing.id, existing.generation, existing.googleEventId ?? deriveGoogleEventId(existing.interactionId, existing.generation), now);
    return null; // already enrolled -- caller should use recordReschedule/recordCancel instead
  }
  return store.insertLinkWithHistory(
    {
      id: randomUUID(),
      interactionId: args.interactionId,
      userId: args.userId,
      googleCalendarId: args.googleCalendarId,
      generation: 0,
      googleEventId: null,
      googleEtag: null,
      desiredState: "present",
      desiredRevision: 1,
      syncedRevision: 0,
      syncStatus: "pending",
      lastError: null,
      attemptCount: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
    now,
  );
}

// A reschedule must succeed regardless of whether a reconcile attempt
// happens to be holding the lease at that exact moment -- so this (and
// every other recordXxx() function below) goes through the store's
// atomic apply* methods, never the lease-gated store.updateLinkAsLeaseHolder.
//
// Issue 4 (2026-10-19 review): this used to read `link.desiredRevision`
// and pass `link.desiredRevision + 1` to an unconditional writeIntent --
// two genuinely simultaneous calls could both read revision 1 and both
// write revision 2, losing one of the two increments. Fixed by pushing
// the `+ 1` into the store itself (store.applyReschedule), which performs
// it as a single atomic `desired_revision = desired_revision + 1` SQL
// update -- never a read-then-compute-then-write race in this module.
// Bug 3 (2026-10-21 review): this used to ALSO check `link.desiredState
// !== "present"` here, from the SAME earlier read, before awaiting
// applyReschedule -- insufficient, since a cancel landing in that gap
// would leave this check having already (correctly, at the time) passed
// "present", while the store write actually lands after the meeting is
// absent. The precondition is no longer checked here at all: it is
// store.applyReschedule's OWN job, re-verified atomically against the
// live row at the moment it runs, never trusted from this stale read.
export async function recordReschedule(store: CalendarLinkStore, now: number, interactionId: string): Promise<boolean> {
  const link = await store.getLinkByInteraction(interactionId);
  if (!link) return false; // not enrolled -- nothing to reschedule
  const updated = await store.applyReschedule(link.id, now);
  return updated !== null; // null means applyReschedule itself found the meeting no longer 'present' -- reopen() is the right call for that case
}

// Same atomicity fix as recordReschedule, applied to the desired_state
// flip. applyCancel also marks the CURRENT generation's history row
// cleanup_needed=1 as part of the SAME atomic unit -- a concurrent reader
// can never observe desired_state='absent' without cleanup_needed also
// being set, or vice versa (Issue 4's "link/history changes cannot be
// partially committed").
//
// Bug 3 (2026-10-21 review): this used to read `link.generation` here
// and pass it to store.applyCancel as the generation to flag for
// cleanup -- the same stale-read class as reschedule/reopen: if a reopen
// landed between this read and the store call, the CURRENT generation
// moved on, and the OLD (now wrong) generation would be flagged instead,
// leaving the actual current generation's event never cleaned up
// ("cleanup cannot target the wrong generation"). store.applyCancel now
// determines the generation to flag itself, atomically, from the live
// row at the moment it runs -- no generation value is passed in at all.
// The "already cancelled" idempotent short-circuit also moved into
// applyCancel itself, computed fresh, for the same reason.
export async function recordCancel(store: CalendarLinkStore, now: number, interactionId: string): Promise<boolean> {
  const link = await store.getLinkByInteraction(interactionId);
  if (!link) return false;
  const updated = await store.applyCancel(link.id, now);
  return updated !== null;
}

// Bumps generation and derives a brand-new event id -- the OLD
// generation's history row (and its cleanupNeeded/cleanupStatus) is left
// completely untouched, so a pending or uncertain deletion from the
// cancelled generation is never abandoned (Issue 2). The generation bump
// AND the new generation's history row are created atomically together
// by store.applyReopen (Bug 2, 2026-10-20 review: "apply the same fix to
// recordReopen, which currently advances the link before inserting the
// new generation's history") -- there is no longer a separate
// insertHistory call here for a crash to land between.
//
// Bug 3 (2026-10-21 review): "overlapping reopen requests can allocate
// two new generations for a single cancellation." This used to check
// `link.desiredState !== "absent"` here, from an earlier read, before
// awaiting store.applyReopen -- insufficient on its own: two concurrent
// callers can both read 'absent' at generation G, both pass that check,
// and the SECOND one's store call -- if store.applyReopen blindly bumped
// the generation unconditionally -- would wrongly allocate a SECOND new
// generation for the SAME single cancellation, creating a real duplicate
// Google event. The check is no longer trusted from this read at all:
// `link.generation`, captured here, is passed to store.applyReopen only
// as the TRANSITION'S OWN IDENTITY (which specific cancellation this
// request is reopening) -- store.applyReopen itself atomically verifies
// the live row still matches that exact pending transition, reuses an
// already-won one instead of allocating another, and rejects a request
// that no longer matches any real pending cancellation at all (a stale
// reopen must never reopen a later, separately canceled meeting).
export async function recordReopen(store: CalendarLinkStore, now: number, interactionId: string): Promise<boolean> {
  const link = await store.getLinkByInteraction(interactionId);
  if (!link) return false;
  const updated = await store.applyReopen(link.id, link.generation, now);
  return updated !== null;
}

// Marking a meeting completed never touches the calendar event (Issue 5
// of the original review: "retains its calendar history"). This function
// exists only so the no-op is an explicit, named, testable fact rather
// than an absence of a call site someone could accidentally add later.
export async function recordComplete(_store: CalendarLinkStore, _now: number, _interactionId: string): Promise<void> {
  // Deliberately empty.
}

// --- Reconciliation (the only code paths that touch Google) --------------

export type ReconcileOutcome =
  | { kind: "lease_contended" }
  | { kind: "synced"; revision: number }
  | { kind: "missing_remotely" }
  | { kind: "failed"; reason: string }
  | { kind: "deleted" }
  | { kind: "delete_uncertain" }
  | { kind: "no_link" }
  // Bug 2 (2026-10-19 review): desired_state or generation changed out
  // from under this attempt while it was suspended on a network call
  // (e.g. a cancel landed mid-GET). No Google mutation was sent and no
  // bookkeeping was written -- the link's own desired_revision/
  // desired_state already reflect the newer truth, so the next
  // reconcile (this attempt's caller retrying, or the next sweep tick)
  // picks it up naturally.
  | { kind: "superseded" };

// Reconciles the CURRENT generation of one meeting toward its latest
// recorded desired state. Deletion cleanup for a SUPERSEDED generation is
// a separate function (reconcileGenerationCleanup) -- deliberately never
// called from here, so creating a reopened event can never be blocked by,
// or accidentally interfere with, deleting an old one (Issue 2).
export async function reconcilePresentAbsent(
  store: CalendarLinkStore,
  client: GoogleCalendarClient,
  getMeetingFields: (interactionId: string) => Promise<MeetingDesiredFields | null>,
  interactionId: string,
  leaseOwner: string,
  now: number,
  ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS,
): Promise<ReconcileOutcome> {
  const initial = await store.getLinkByInteraction(interactionId);
  if (!initial) return { kind: "no_link" };

  const acquired = await store.acquireLease(initial.id, leaseOwner, now, ttlSeconds);
  if (!acquired) return { kind: "lease_contended" };

  try {
    let attemptsLeft = MAX_PRECONDITION_RETRIES;
    for (;;) {
      // Issue 1: reload the latest FOS desired state on every pass through
      // this loop, including a 412 retry -- never reuse an earlier capture.
      const fresh = await store.getLinkById(initial.id);
      if (!fresh) return { kind: "failed", reason: "link row disappeared mid-reconcile" };
      const revisionBeingSent = fresh.desiredRevision;
      const generationBeingSent = fresh.generation;

      if (fresh.desiredState === "absent") {
        // Bug (2026-10-19 review, "inspect the cancellation helper's
        // async lifetime"): this used to be a bare `return
        // reconcileDeleteCurrentGeneration(...)`, which evaluates the
        // call and returns its (still-pending) promise WITHOUT awaiting
        // it -- the enclosing try/finally's `finally` block (which
        // releases the lease) then runs immediately, BEFORE the delete
        // helper's own lease-gated bookkeeping writes complete, so those
        // writes could silently fail against an already-released lease.
        // `return await ...` forces the function to actually suspend
        // here, so `finally` only runs once the helper (and its
        // lease-protected writes) has fully finished.
        return await reconcileDeleteCurrentGeneration(store, client, fresh, leaseOwner, now);
      }

      const fields = await getMeetingFields(fresh.interactionId);
      if (!fields) return finishFailed(store, fresh, leaseOwner, now, "meeting fields unavailable");

      const eventId = fresh.googleEventId ?? deriveGoogleEventId(fresh.interactionId, generationBeingSent);
      if (!fresh.googleEventId) await store.updateLinkAsLeaseHolder(fresh.id, leaseOwner, { googleEventId: eventId, updatedAt: now });

      // Bug 2 (2026-10-20 review): universal backstop. A history row for
      // this generation might be missing -- not only from the exact
      // enrollment-crash reproduction (already repaired at enrollment-
      // retry time above), but from ANY cause, and regardless of entry
      // point (a sweep can reach this generation via
      // listNeedingReconciliation without ever going through
      // enrollMeetingForSync's own repair branch). "Missing required
      // history must not silently pass as an ordinary no-op": self-heal
      // it HERE, unconditionally, before the first network call this
      // function makes -- so createStatus/cleanupNeeded bookkeeping for
      // this generation is always writable from this point on, never a
      // silent no-op against a row that was never actually created.
      await store.ensureHistory(fresh.id, generationBeingSent, eventId, now);

      const getResult = await client.get(fresh.googleCalendarId, eventId);

      // Issue 1 / Bug 2 (2026-10-19 review, "revalidate desired state,
      // revision, generation, and lease before remote mutations"): a GET
      // can take long enough for this attempt's lease to expire and be
      // taken over by someone else, OR for the meeting to have been
      // cancelled (or reopened into a new generation) while this attempt
      // was suspended. Checking only lease ownership at the final
      // bookkeeping write is not enough on its own -- it still lets a
      // now-stale-or-superseded worker send a real, possibly
      // content-overwriting insert/update call to Google first. Re-
      // confirm lease ownership AND that desired_state/generation still
      // match what this attempt captured, immediately before every
      // mutating call, not only before the local write-back.
      { const revalidated = await revalidateBeforeMutation(store, fresh.id, leaseOwner, "present", generationBeingSent); if (!revalidated.ok) return { kind: revalidated.reason }; }

      if (!getResult.ok && (getResult.status === 404 || getResult.status === 410)) {
        // Whether this generation was EVER previously confirmed created is
        // tracked durably in history.createStatus -- NOT link.syncStatus,
        // which legitimately resets to "pending" on every reschedule (a
        // reschedule of an already-synced meeting must still mean "needs a
        // fresh update push", not "never existed"). Using syncStatus here
        // would wrongly let a rescheduled-then-manually-deleted event fall
        // through to a silent recreate.
        const historyForGeneration = await store.getHistory(fresh.id, generationBeingSent);
        if (historyForGeneration?.createStatus === "succeeded") {
          // Previously confirmed created, now gone -- a manual Google-side
          // deletion (Issue 7). Never recreate automatically.
          await store.updateLinkAsLeaseHolder(fresh.id, leaseOwner, { syncStatus: "missing_remotely", updatedAt: now });
          return { kind: "missing_remotely" };
        }
        // Normal pre-create case (or a never-resolved prior attempt) --
        // proceed to insert. Mark create as in-flight BEFORE the call so a
        // concurrent cleanup attempt (Issue 2) can see this is unresolved.
        await store.updateHistory(fresh.id, generationBeingSent, { createStatus: "in_flight" });
        // Re-check immediately before the actual network call -- the
        // updateHistory write above is itself an await point where a
        // cancel could have landed.
        { const revalidated = await revalidateBeforeMutation(store, fresh.id, leaseOwner, "present", generationBeingSent); if (!revalidated.ok) return { kind: revalidated.reason }; }
        const body = { ...buildGoogleEventBody(fields), id: eventId };
        const insertResult = await client.insert(fresh.googleCalendarId, body);

        if (insertResult.ok) {
          await store.updateHistory(fresh.id, generationBeingSent, { createStatus: "succeeded" });
          return finishSynced(store, fresh, leaseOwner, now, revisionBeingSent, insertResult.etag ?? null);
        }
        if (!insertResult.ok && insertResult.status === 409) {
          // Issue 3: a 409 alone does not prove the latest desired
          // content was synced -- GET, verify, and reconcile content.
          const verify = await client.get(fresh.googleCalendarId, eventId);
          { const revalidated = await revalidateBeforeMutation(store, fresh.id, leaseOwner, "present", generationBeingSent); if (!revalidated.ok) return { kind: revalidated.reason }; }
          if (!verify.ok) return finishFailed(store, fresh, leaseOwner, now, sanitizedError(verify.status));
          await store.updateHistory(fresh.id, generationBeingSent, { createStatus: "succeeded" });
          const merged = mergeFosFieldsIntoExistingEvent(verify.event!, fields);
          const updateResult = await client.update(fresh.googleCalendarId, eventId, merged, verify.etag ?? "");
          if (updateResult.ok) return finishSynced(store, fresh, leaseOwner, now, revisionBeingSent, updateResult.etag ?? null);
          if (!updateResult.ok && updateResult.status === 412) {
            if (--attemptsLeft > 0) continue; // reload and retry from the top
            return finishFailed(store, fresh, leaseOwner, now, "412 retries exhausted");
          }
          return finishFailed(store, fresh, leaseOwner, now, sanitizedError(updateResult.status));
        }
        // Any other outcome (network error/timeout/5xx) is genuinely
        // ambiguous -- createStatus stays "in_flight", never resolved here.
        return finishFailed(store, fresh, leaseOwner, now, !insertResult.ok ? sanitizedError(insertResult.status) : "unknown");
      }

      if (!getResult.ok) return finishFailed(store, fresh, leaseOwner, now, sanitizedError(getResult.status));

      // Event exists on Google -- by construction (we always address it by
      // the deterministic id for this exact interactionId+generation) it
      // IS this meeting's current generation; no further identity check is
      // needed. Always rebuild from the freshest fields and push.
      //
      // Bug 3 (2026-10-19 review, "crash recovery fails to record
      // confirmed creation"): this branch is also the CRASH-RECOVERY
      // path -- e.g. a prior attempt crashed after Google actually
      // created the event but before it recorded createStatus=
      // "succeeded", leaving history stuck at "in_flight" or
      // "not_attempted". Finding the event here (a direct 200, not the
      // insert/409-verify paths above) is itself durable proof it exists
      // -- confirm createStatus here too, or a later manual deletion
      // would be misclassified as "never created" and silently
      // re-inserted instead of reported missing_remotely.
      await store.updateHistory(fresh.id, generationBeingSent, { createStatus: "succeeded" });
      const merged = mergeFosFieldsIntoExistingEvent(getResult.event!, fields);
      const updateResult = await client.update(fresh.googleCalendarId, eventId, merged, getResult.etag ?? "");
      if (updateResult.ok) return finishSynced(store, fresh, leaseOwner, now, revisionBeingSent, updateResult.etag ?? null);
      if (!updateResult.ok && updateResult.status === 412) {
        if (--attemptsLeft > 0) continue;
        return finishFailed(store, fresh, leaseOwner, now, "412 retries exhausted");
      }
      return finishFailed(store, fresh, leaseOwner, now, sanitizedError(updateResult.status));
    }
  } finally {
    await store.releaseLease(initial.id, leaseOwner);
  }
}

type RevalidationResult = { ok: true; row: CalendarLinkRow } | { ok: false; reason: "lease_contended" | "superseded" };

// Re-confirms, immediately before a mutating Google call, that this
// attempt still holds the lease AND that desired_state/generation still
// match what it originally captured (Issue 1 / Bug 2, 2026-10-19 review:
// "revalidate desired state, revision, generation, and lease before
// remote mutations"). A GET/verify call can take long enough for the
// lease to be taken over, or for a cancel/reopen to land, while this
// attempt is suspended -- checking only at the final local write-back is
// not enough: it still lets a now-stale-or-superseded worker send a
// real, possibly content-creating/overwriting request to Google first.
// Distinguishes WHY revalidation failed: "lease_contended" (someone else
// now holds the lease -- the Issue 1 stale-worker case) vs. "superseded"
// (this attempt still holds the lease, but desired_state/generation
// moved on under it -- the Bug 2 cancel-during-create case) -- callers
// that only care "did it fail" can still just check `.ok`.
async function revalidateBeforeMutation(store: CalendarLinkStore, linkId: string, leaseOwner: string, expectedDesiredState: CalendarLinkRow["desiredState"], expectedGeneration: number): Promise<RevalidationResult> {
  const current = await store.getLinkById(linkId);
  if (!current || current.leaseOwner !== leaseOwner) return { ok: false, reason: "lease_contended" };
  if (current.desiredState !== expectedDesiredState || current.generation !== expectedGeneration) return { ok: false, reason: "superseded" };
  return { ok: true, row: current };
}

async function finishSynced(store: CalendarLinkStore, link: CalendarLinkRow, leaseOwner: string, now: number, revisionSent: number, etag: string | null): Promise<ReconcileOutcome> {
  // Issue 1: only this specific lease holder, writing only the revision it
  // actually sent and had confirmed -- never a newer revision that may
  // have appeared while this call was in flight.
  const ok = await store.updateLinkAsLeaseHolder(link.id, leaseOwner, { syncedRevision: revisionSent, syncStatus: "synced", googleEtag: etag, lastError: null, updatedAt: now });
  if (!ok) return { kind: "lease_contended" }; // our lease was stolen/expired mid-call -- the write is correctly rejected
  return { kind: "synced", revision: revisionSent };
}

async function finishFailed(store: CalendarLinkStore, link: CalendarLinkRow, leaseOwner: string, now: number, reason: string): Promise<ReconcileOutcome> {
  await store.updateLinkAsLeaseHolder(link.id, leaseOwner, { syncStatus: "failed", lastError: reason, attemptCount: link.attemptCount + 1, updatedAt: now });
  return { kind: "failed", reason };
}

// Called while `reconcilePresentAbsent` already holds the link's lease
// (see the "absent" branch above) -- goes straight to the LOCKED cleanup
// implementation, never re-acquiring a lease it already has.
async function reconcileDeleteCurrentGeneration(store: CalendarLinkStore, client: GoogleCalendarClient, link: CalendarLinkRow, leaseOwner: string, now: number): Promise<ReconcileOutcome> {
  if (!link.googleEventId) {
    await store.updateLinkAsLeaseHolder(link.id, leaseOwner, { syncStatus: "synced", syncedRevision: link.desiredRevision, updatedAt: now });
    const history = await store.getHistory(link.id, link.generation);
    if (history) await store.updateHistory(link.id, link.generation, { cleanupStatus: "done" });
    return { kind: "deleted" };
  }
  const outcome = await reconcileGenerationCleanupLocked(store, client, link.googleCalendarId, link.id, link.generation, link.googleEventId, now);
  if (outcome.kind === "done") {
    await store.updateLinkAsLeaseHolder(link.id, leaseOwner, { syncStatus: "synced", syncedRevision: link.desiredRevision, updatedAt: now });
    return { kind: "deleted" };
  }
  if (outcome.kind === "uncertain") {
    await store.updateLinkAsLeaseHolder(link.id, leaseOwner, { syncStatus: "failed", lastError: "cleanup uncertain: create outcome not yet resolved", attemptCount: link.attemptCount + 1, updatedAt: now });
    return { kind: "delete_uncertain" };
  }
  await store.updateLinkAsLeaseHolder(link.id, leaseOwner, { syncStatus: "failed", lastError: "delete failed", attemptCount: link.attemptCount + 1, updatedAt: now });
  return { kind: "failed", reason: "delete failed" };
}

export type CleanupOutcome = { kind: "not_needed" } | { kind: "done" } | { kind: "uncertain" } | { kind: "failed" } | { kind: "lease_contended" };

// Bug 2 (2026-10-19 review): "the original worker still owns the lease,
// so it proceeds to INSERT and succeeds [after an independent cleanup
// call already marked cleanupStatus=done based on an earlier 404]." An
// independent cleanup call (the sweep's own standalone loop, or a direct
// caller) previously raced a present-state reconcile attempt for the
// SAME link with no coordination at all. Fixed by making this the
// lease-acquiring PUBLIC entry point: cleanup now contends for the exact
// same per-link lease a present-state reconcile holds, so the two can
// never interleave for the same link. `reconcileDeleteCurrentGeneration`
// above (called from inside an already-lease-holding
// reconcilePresentAbsent) uses the LOCKED implementation directly instead
// of re-acquiring a lease it already holds.
export async function reconcileGenerationCleanup(store: CalendarLinkStore, client: GoogleCalendarClient, calendarId: string, linkId: string, generation: number, googleEventId: string, now: number, leaseOwner: string, ttlSeconds: number = DEFAULT_LEASE_TTL_SECONDS): Promise<CleanupOutcome> {
  const acquired = await store.acquireLease(linkId, leaseOwner, now, ttlSeconds);
  if (!acquired) return { kind: "lease_contended" };
  try {
    return await reconcileGenerationCleanupLocked(store, client, calendarId, linkId, generation, googleEventId, now);
  } finally {
    await store.releaseLease(linkId, leaseOwner);
  }
}

// Attempts to remove ONE generation's Google event, independent of and
// never blocking the current generation's own create/update work (Issue
// 2: "keep deletion retries separate from creating the reopened event").
// Never trusts a 404/410 alone as proof of absence while that
// generation's own create attempt is still "in_flight" (Issue 2: "do not
// claim 404 alone guarantees absence while a create may still be in
// flight") -- this is the exact fix for "a delayed create that succeeds
// AFTER a delete returned 404": the next sweep re-checks once
// createStatus has actually resolved, and only then (if the event truly
// exists) does the delete find and remove it for real.
//
// Only "in_flight" is treated as uncertain -- NOT "not_attempted" -- and
// this is safe specifically BECAUSE this function only ever runs while
// holding the link's own lease (via the public reconcileGenerationCleanup
// wrapper, or because the caller -- reconcileDeleteCurrentGeneration --
// already holds it): no present-state reconcile attempt for the SAME
// link can be concurrently transitioning "not_attempted" to "in_flight"
// while THIS call holds that same lease, so a 404 against a
// "not_attempted" generation is genuinely conclusive. "in_flight" is
// different: it can only be observed here at all if a PRIOR attempt's
// lease expired (TTL) while its actual outbound HTTP call to Google was
// still outstanding -- that call can still land later regardless of the
// lease, which is exactly the ambiguity resolveCreateOutcome() exists to
// eventually settle.
async function reconcileGenerationCleanupLocked(store: CalendarLinkStore, client: GoogleCalendarClient, calendarId: string, linkId: string, generation: number, googleEventId: string, now: number): Promise<CleanupOutcome> {
  let history = await store.getHistory(linkId, generation);
  if (!history) {
    // Bug 2 (2026-10-20 review): "cleanup cannot find history, returns
    // not_needed, and cancellation reports 'delete failed' without
    // sending any Google DELETE." This function is only ever called with
    // a real googleEventId specifically because the caller already
    // determined cleanup for this generation is warranted
    // (reconcileDeleteCurrentGeneration only reaches here when
    // desiredState='absent' and the link's own googleEventId is set; the
    // sweep's own listPendingCleanup loop only returns rows that already
    // have a history row with cleanup_needed=1, so it can never trigger
    // this branch at all). A missing history row here is therefore
    // ALWAYS the Bug 2 integrity gap, never a legitimate "nothing to do"
    // -- self-heal it as cleanup-needed and proceed, rather than
    // silently reporting "not_needed" without ever attempting the real
    // Google DELETE.
    history = await store.ensureHistory(linkId, generation, googleEventId, now, true);
  } else if (!history.cleanupNeeded) {
    return { kind: "not_needed" };
  }
  if (history.cleanupStatus === "done") return { kind: "done" };

  const deleteResult = await client.delete(calendarId, googleEventId);
  const deletedOrAlreadyGone = deleteResult.ok || deleteResult.status === 404 || deleteResult.status === 410;

  const createOutcomeUnresolved = history.createStatus === "in_flight";

  if (deletedOrAlreadyGone) {
    if (createOutcomeUnresolved) {
      await store.updateHistory(linkId, generation, { cleanupStatus: "uncertain", cleanupAttempts: history.cleanupAttempts + 1, updatedAt: now });
      return { kind: "uncertain" };
    }
    await store.updateHistory(linkId, generation, { cleanupStatus: "done", updatedAt: now });
    return { kind: "done" };
  }

  await store.updateHistory(linkId, generation, { cleanupStatus: "pending", cleanupAttempts: history.cleanupAttempts + 1, updatedAt: now });
  return { kind: "failed" };
}

// Called when a create attempt's own outcome finally resolves (success or
// a definitive failure) -- regardless of whether that attempt still holds
// the lease. Recording the true HTTP outcome is never gated by lease
// ownership (it is a fact about what actually happened over the wire, not
// contested bookkeeping); only the link row's syncedRevision/syncStatus
// writes are lease-gated. This is what lets a stale worker's late-
// resolving insert still correctly inform the NEXT cleanup sweep, even
// after that worker's lease has been taken over by someone else.
export async function resolveCreateOutcome(store: CalendarLinkStore, linkId: string, generation: number, outcome: "succeeded" | "failed"): Promise<void> {
  const history = await store.getHistory(linkId, generation);
  if (!history || history.createStatus !== "in_flight") return;
  await store.updateHistory(linkId, generation, { createStatus: outcome });
}

// --- Sweep (drives both concerns from the store's own "needs attention" queries) ---

export type SweepResult = { reconciled: ReconcileOutcome[]; cleaned: CleanupOutcome[] };

export async function runReconciliationSweep(
  store: CalendarLinkStore,
  client: GoogleCalendarClient,
  getMeetingFields: (interactionId: string) => Promise<MeetingDesiredFields | null>,
  leaseOwnerPrefix: string,
  now: number,
): Promise<SweepResult> {
  const reconciled: ReconcileOutcome[] = [];
  const toReconcile = await store.listNeedingReconciliation(now);
  for (const link of toReconcile) {
    reconciled.push(await reconcilePresentAbsent(store, client, getMeetingFields, link.interactionId, `${leaseOwnerPrefix}:${link.id}`, now));
  }

  const cleaned: CleanupOutcome[] = [];
  const toCleanup = await store.listPendingCleanup(now);
  for (const historyRow of toCleanup) {
    cleaned.push(await reconcileGenerationCleanup(store, client, await calendarIdForLink(store, historyRow.linkId), historyRow.linkId, historyRow.generation, historyRow.googleEventId, now, `${leaseOwnerPrefix}:cleanup:${historyRow.linkId}`));
  }

  return { reconciled, cleaned };
}

async function calendarIdForLink(store: CalendarLinkStore, linkId: string): Promise<string> {
  const link = await store.getLinkById(linkId);
  return link?.googleCalendarId ?? "primary";
}
