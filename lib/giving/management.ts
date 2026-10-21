import { parseFinancialDate } from "../financial-date.ts";

export const GIVING_WORKSPACE_STATUSES = ["active", "hidden", "duplicate", "needs_review", "invalid", "merged"] as const;
export type GivingWorkspaceStatus = typeof GIVING_WORKSPACE_STATUSES[number];

// `pending_pledge` (2026-10-16, Trip Fundraising Results Dashboard, see
// docs/AI-HANDOFF.md) -- the pledge-side counterpart to `pending_gift`:
// an unconfirmed pledge a fundraiser has recorded (e.g. secured on a
// trip) that has not yet been JL-imported as a real pledge. Excluded
// from totals for the exact same reason `pending_gift` is: it is not yet
// a JL-confirmed fact.
//
// Pending-Pledge Import Reconciliation (2026-10-21, see docs/AI-HANDOFF.md):
// `pending_pledge` is now ALSO wired into the import route's pending-
// match/explicit-review reconciliation (pendingPledgeMatches/
// CONFIRM_PENDING_PLEDGE_SQL below) -- the same JL-import review
// workflow pending_gift already uses, extended to pledges. This closes a
// real reconciliation gap: a pledge recorded on a trip before JL import
// (category `pending_pledge`) could sit labeled "Awaiting JL" forever
// after its real JL pledge imported, even though nothing further about
// it was actually unresolved. Matching is on `committed_cents` (the
// pledge's own stable total commitment), never `paid_cents`/
// `balance_cents` -- those drift as partial payments are applied, but
// the committed amount does not, so a partially-paid real pledge still
// matches its own pending entry correctly. Exactly like pending_gift,
// this NEVER auto-merges solely because donor and amount match: every
// suggested match still requires an explicit fundraiser decision through
// the same review screen before the import commits (see
// app/api/import/route.ts).
//
// A pledge whose real JL record already imported BEFORE this feature
// existed (or before the fundraiser got to review it) is not stuck,
// either: "Associate an existing donation or pledge" on the trip itself
// (lib/relationships/trip-financial-attribution.ts's
// attributeGivingActivityToTrip, already generic across both
// categories) reconciles it directly, with no re-upload required -- this
// was already true before this round, and is exercised end to end by
// tests/trip-reconciliation-concurrency.test.mjs.
export const COUNTED_GIVING_SQL = "workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift','pending_pledge')";
export const CONFIRM_PENDING_GIFT_SQL = "UPDATE giving_activities SET workspace_status='merged',confirmed_by_activity_id=?,updated_at=? WHERE id=? AND owner_user_id=? AND donor_id=? AND category='pending_gift' AND workspace_status='active' AND confirmed_by_activity_id IS NULL";
// Pending-Pledge Import Reconciliation (2026-10-21, see docs/AI-HANDOFF.md):
// the pledge-side counterpart to CONFIRM_PENDING_GIFT_SQL above -- same
// guard shape (category/workspace_status/confirmed_by_activity_id), only
// the category differs. Extends the SAME JL-import review workflow
// (app/api/import/route.ts's pendingMergeStatements) to pending_pledge,
// closing the gap this module's own earlier comment on
// pendingGiftMatches described as deliberately deferred.
export const CONFIRM_PENDING_PLEDGE_SQL = "UPDATE giving_activities SET workspace_status='merged',confirmed_by_activity_id=?,updated_at=? WHERE id=? AND owner_user_id=? AND donor_id=? AND category='pending_pledge' AND workspace_status='active' AND confirmed_by_activity_id IS NULL";

export function countsInGivingTotals(record: { workspace_status?: string; workspaceStatus?: string; category: string }) {
  return (record.workspace_status ?? record.workspaceStatus ?? "active") === "active"
    && !["needs_review", "nonfinancial_entry", "pending_gift", "pending_pledge"].includes(record.category);
}

export function appearsInGivingTimeline(record: { workspace_status?: string; workspaceStatus?: string }) {
  return (record.workspace_status ?? record.workspaceStatus ?? "active") !== "merged";
}

export type PendingGiftMatchRow = {
  id: string;
  donor_id: string;
  activity_date: number | null;
  committed_cents: number | null;
  description: string | null;
  private_note: string | null;
  workspace_status: string;
  category: string;
  confirmed_by_activity_id: string | null;
};

export type ImportGiftCandidate = { fingerprint: string; donorId: string; activityDate: number | null; committedCents: number | null };

export function pendingGiftMatches(imported: ImportGiftCandidate[], pending: PendingGiftMatchRow[], windowDays = 7) {
  const windowSeconds = windowDays * 86400;
  return imported.map((activity) => ({
    fingerprint: activity.fingerprint,
    candidates: pending.filter((candidate) => candidate.donor_id === activity.donorId
      && candidate.category === "pending_gift"
      && candidate.workspace_status === "active"
      && !candidate.confirmed_by_activity_id
      && candidate.committed_cents === activity.committedCents
      && candidate.activity_date !== null
      && activity.activityDate !== null
      && Math.abs(candidate.activity_date - activity.activityDate) <= windowSeconds)
      .sort((a, b) => Math.abs((a.activity_date ?? 0) - (activity.activityDate ?? 0)) - Math.abs((b.activity_date ?? 0) - (activity.activityDate ?? 0))),
  })).filter((match) => match.candidates.length > 0);
}

// Pending-Pledge Import Reconciliation (2026-10-21, see docs/AI-HANDOFF.md).
// `category` is required here (unlike ImportGiftCandidate) specifically
// so this function can restrict matching to a NEWLY IMPORTED real pledge
// (open_pledge, or partially_paid_pledge when the JL export already
// shows an initial payment at the moment it is first imported) -- never
// a brand-new completed_gift, which is a different kind of commitment
// and must never silently resolve a pending PLEDGE. Matches on
// `committed_cents` only, deliberately never `paid_cents`/
// `balance_cents`: a pledge's own committed total is stable across its
// whole lifetime, while paid/balance drift with every partial payment,
// so this stays correct regardless of how much (if anything) has been
// paid toward the real pledge by the time it is matched. Exactly like
// pendingGiftMatches, never auto-merges by itself -- it only surfaces
// candidates that still require an explicit decision through the same
// review screen (app/api/import/route.ts).
export type ImportPledgeCandidate = { fingerprint: string; donorId: string; activityDate: number | null; committedCents: number | null; category: string };
const PLEDGE_IMPORT_CATEGORIES = new Set(["open_pledge", "partially_paid_pledge"]);

export function pendingPledgeMatches(imported: ImportPledgeCandidate[], pending: PendingGiftMatchRow[], windowDays = 7) {
  const windowSeconds = windowDays * 86400;
  return imported
    .filter((activity) => PLEDGE_IMPORT_CATEGORIES.has(activity.category))
    .map((activity) => ({
      fingerprint: activity.fingerprint,
      candidates: pending.filter((candidate) => candidate.donor_id === activity.donorId
        && candidate.category === "pending_pledge"
        && candidate.workspace_status === "active"
        && !candidate.confirmed_by_activity_id
        && candidate.committed_cents === activity.committedCents
        && candidate.activity_date !== null
        && activity.activityDate !== null
        && Math.abs(candidate.activity_date - activity.activityDate) <= windowSeconds)
        .sort((a, b) => Math.abs((a.activity_date ?? 0) - (activity.activityDate ?? 0)) - Math.abs((b.activity_date ?? 0) - (activity.activityDate ?? 0))),
    })).filter((match) => match.candidates.length > 0);
}

export function pendingGiftInput(value: unknown) {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const donorId = typeof body.donorId === "string" ? body.donorId.trim() : "";
  const designation = typeof body.designation === "string" ? body.designation.trim().slice(0, 160) : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(String(body.amount ?? "").replace(/[$,\s]/g, ""));
  const date = typeof body.date === "string" ? parseFinancialDate(body.date) : null;
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  const activityDate = date;
  const errors: string[] = [];
  if (!donorId) errors.push("Choose a donor.");
  if (amountCents <= 0 || amountCents > 100_000_000_00) errors.push("Enter a positive gift amount below $100 million.");
  if (!activityDate) errors.push("Choose a valid date.");
  return { donorId, designation, note, amountCents, activityDate, errors };
}

// Mirrors pendingGiftInput exactly -- same validation shape, same error
// wording style -- for the pending_pledge counterpart
// (app/api/giving/pending-pledge/route.ts).
export function pendingPledgeInput(value: unknown) {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const donorId = typeof body.donorId === "string" ? body.donorId.trim() : "";
  const designation = typeof body.designation === "string" ? body.designation.trim().slice(0, 160) : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 2000) : "";
  const amount = typeof body.amount === "number" ? body.amount : Number(String(body.amount ?? "").replace(/[$,\s]/g, ""));
  const date = typeof body.date === "string" ? parseFinancialDate(body.date) : null;
  const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  const activityDate = date;
  const errors: string[] = [];
  if (!donorId) errors.push("Choose a donor.");
  if (amountCents <= 0 || amountCents > 100_000_000_00) errors.push("Enter a positive pledge amount below $100 million.");
  if (!activityDate) errors.push("Choose a valid date.");
  return { donorId, designation, note, amountCents, activityDate, errors };
}
