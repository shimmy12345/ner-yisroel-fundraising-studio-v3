import type { ImportRow } from "./recognition.ts";

// This table doubles as the durable review draft: the same row that caches
// a donation import's parsed rows for the final commit also accumulates the
// user's review decisions as they work through them, so a long review
// session is never at the mercy of a short, fixed-lifetime cache. The TTL
// below is an INACTIVITY window, re-applied every time the row is touched
// (a new decision saved, or the preview re-viewed) -- not a fixed deadline
// from creation. Only a draft nobody has touched in two weeks expires.
export const DRAFT_TTL_SECONDS = 60 * 60 * 24 * 14;
// Kept as an alias: existing call sites reference this name, and the value
// is identical -- there is exactly one TTL concept for this table now.
export const PREVIEW_SESSION_TTL_SECONDS = DRAFT_TTL_SECONDS;

export type DraftStatus = "draft" | "committed" | "discarded";

export type PreviewSessionRow = {
  id: string;
  owner_user_id: string;
  file_hash: string;
  file_name: string;
  mapping_json: string;
  force_type: string | null;
  row_count: number;
  decisions_json: string;
  status: DraftStatus;
  // Client-reported progress, saved alongside decisions_json purely for
  // display on the resumable-drafts list -- never recomputed server-side,
  // since that would mean reclassifying the whole file just to list it.
  progress_resolved: number;
  progress_total: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
};

// A session/draft is usable only for the exact owner that created it, only
// while it is still an open draft (not already committed or discarded),
// and only before it expires. Never trust a client-supplied owner id -- the
// caller must pass the authenticated user's id.
export function isPreviewSessionUsable(session: PreviewSessionRow | null | undefined, authenticatedOwnerUserId: string, now: number): session is PreviewSessionRow {
  if (!session) return false;
  if (session.owner_user_id !== authenticatedOwnerUserId) return false;
  if (session.status !== "draft") return false;
  if (session.expires_at <= now) return false;
  return true;
}

// A committed session's decisions_json is never cleared (only its status
// changes) -- specifically so rows the user marked "review later" stay
// resolvable afterward. This reopens that exact session for a follow-up
// review pass, not the ordinary in-progress-draft resume above: only the
// rows still saved as "review_later" need attention, and re-submitting
// already-imported rows is always safe (the commit route's existing
// cross-import/fingerprint duplicate protection treats them as already
// imported and never double-writes them).
export function isReopenableForFollowUp(session: PreviewSessionRow | null | undefined, authenticatedOwnerUserId: string, now: number): session is PreviewSessionRow {
  if (!session) return false;
  if (session.owner_user_id !== authenticatedOwnerUserId) return false;
  if (session.status !== "draft" && session.status !== "committed") return false;
  if (session.expires_at <= now) return false;
  return true;
}

// Counts "review later" decisions saved across every decision map this
// session tracks -- used to decide whether a committed session still has
// outstanding follow-up work worth surfacing, without reclassifying the
// file just to find out.
export function countReviewLaterDecisions(decisionsJson: string): number {
  const decisions = parseDraftDecisions(decisionsJson);
  let count = 0;
  for (const map of Object.values(decisions)) {
    if (!map || typeof map !== "object") continue;
    for (const decision of Object.values(map)) {
      if (decision && typeof decision === "object" && (decision as { action?: unknown }).action === "review_later") count += 1;
    }
  }
  return count;
}

// Counts genuinely-unresolved payment/pledge-assignment decisions saved on
// this session -- "needs_review" is the sentinel PaymentDecisionState uses
// for "not yet decided" (see ImportExperience.tsx). Deliberately scoped to
// only the paymentDecisions map: a possible-duplicate row explicitly marked
// skip or review_later is a resolved decision in a different map entirely
// and must never be counted here. Callers must only sum this over active
// (status='draft', unexpired) sessions -- a committed import can never
// contribute, since the commit route now rejects any unresolved payment
// assignment before writing anything (see app/api/import/route.ts).
export function countPendingPaymentDecisions(decisionsJson: string): number {
  const decisions = parseDraftDecisions(decisionsJson);
  const paymentDecisions = decisions.paymentDecisions;
  if (!paymentDecisions || typeof paymentDecisions !== "object") return 0;
  let count = 0;
  for (const decision of Object.values(paymentDecisions)) {
    if (decision && typeof decision === "object" && (decision as { action?: unknown }).action === "needs_review") count += 1;
  }
  return count;
}

// Whether a draft is old/inactive enough to no longer offer for resume,
// even though the row itself may still physically exist in D1 (cleanup is
// lazy/opportunistic, not the source of truth for usability).
export function isDraftResumable(session: Pick<PreviewSessionRow, "status" | "expires_at">, now: number): boolean {
  return session.status === "draft" && session.expires_at > now;
}

// Recomputed on every touch (creation, a saved decision, or a resumed
// preview) -- this is what makes active review extend the draft's life
// instead of it expiring on a fixed schedule from creation.
export function previewSessionExpiresAt(now: number): number {
  return now + DRAFT_TTL_SECONDS;
}

export function reconstructRowsFromChunks(chunks: string[]): ImportRow[] {
  return chunks.flatMap((chunk) => JSON.parse(chunk) as ImportRow[]);
}

export function parseDraftDecisions(decisionsJson: string): Record<string, Record<string, unknown>> {
  try {
    const parsed = JSON.parse(decisionsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Record<string, unknown>>) : {};
  } catch {
    return {};
  }
}

// Restores a saved fingerprint-keyed decision map, keeping only entries
// whose fingerprint still appears among the currently reviewable rows.
// An entry whose fingerprint no longer exists is dropped rather than
// guessed at -- that row's own current listing will show it needing a
// fresh decision (see ImportExperience.tsx's restore step), instead of a
// stale decision silently carrying over onto a row it may no longer match.
export function restoreDecisionsForCurrentFingerprints(saved: Record<string, unknown> | undefined | null, currentFingerprints: Set<string>): Record<string, unknown> {
  if (!saved || typeof saved !== "object") return {};
  return Object.fromEntries(Object.entries(saved).filter(([fingerprint]) => currentFingerprints.has(fingerprint)));
}
