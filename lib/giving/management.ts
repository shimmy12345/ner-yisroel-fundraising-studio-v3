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
// Deliberately NARROWER than `pending_gift`'s own treatment: this
// category exists ONLY as a classification + manual-entry point
// (app/api/giving/pending-pledge/route.ts). It is NOT wired into the
// import route's pending-match/auto-confirm reconciliation
// (pendingGiftMatches/CONFIRM_PENDING_GIFT_SQL below) the way
// pending_gift is -- that reconciliation runs against every live JL
// import and is explicitly treated elsewhere in this codebase as
// sensitive, incident-prone logic (see docs/AI-HANDOFF.md's import
// history); extending it to pledges is a materially bigger, separately
// reviewable change than this feature needs. A pending_pledge row simply
// stays `pending_pledge` until the fundraiser manually attributes the
// REAL imported pledge to the same trip via "Associate an existing
// pledge" (lib/relationships/trip-financial-attribution.ts) -- never
// auto-merged, never silently superseded.
export const COUNTED_GIVING_SQL = "workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift','pending_pledge')";
export const CONFIRM_PENDING_GIFT_SQL = "UPDATE giving_activities SET workspace_status='merged',confirmed_by_activity_id=?,updated_at=? WHERE id=? AND owner_user_id=? AND donor_id=? AND category='pending_gift' AND workspace_status='active' AND confirmed_by_activity_id IS NULL";

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
