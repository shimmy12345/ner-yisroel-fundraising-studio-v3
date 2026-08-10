import type { GivingActivity } from "./jl-donations.ts";
import { parseFinancialDate } from "../financial-date.ts";
import type { ImportRow } from "./recognition.ts";

export type DateReviewAction = "correct_date" | "accept_as_is" | "skip" | "review_later";
export type DateDecision = { fingerprint: string; action: DateReviewAction; correctedDate?: string };

export type DateEdit = { fingerprint: string; row: number; field: string; originalValue: string; correctedValue: string };

export type DateReviewResolution = {
  // Same order/length as the input rows, with a correction annotation
  // applied to the specific rows that were validly corrected or accepted.
  // The original date column is never touched -- see
  // lib/import/jl-donations.ts's fundraisingOsCorrectedDate/
  // fundraisingOsAcceptSuspiciousDate handling.
  rows: ImportRow[];
  unresolvedFingerprints: string[];
  edits: DateEdit[];
  // Rows that received a correction/acceptance annotation, keyed by row
  // number (stable across re-classification) to the fingerprint the client
  // still knows this row by. The caller re-runs buildJlDonationPreview on
  // `rows` and must check each of these still resolves to a clean date --
  // rerunning validation can still find the "corrected" value suspicious
  // or, if the format check below is ever loosened, invalid.
  appliedRowNumbers: Map<number, string>;
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ALLOWED_DATE_ACTIONS: DateReviewAction[] = ["correct_date", "accept_as_is", "skip", "review_later"];

// A corrected date is only ever "complete" if it is both shaped like a date
// and an actual calendar date (parseFinancialDate rejects e.g. 2021-02-30).
// This is the exact rule resolveDateDecisions already enforces for
// correct_date below -- exported so callers never need a second, looser
// copy of it (a native <input type="date"> can emit a malformed
// intermediate value while a user is mid-edit, e.g. a 5-digit year, and a
// truthy-only check would wrongly treat that as resolved).
export function isValidCorrectedDate(value: unknown): value is string {
  return typeof value === "string" && DATE_ONLY_PATTERN.test(value.trim()) && parseFinancialDate(value.trim()) !== null;
}

// Whether a single decision (the client's per-row shape, without its own
// fingerprint key) is complete enough to submit. Used both to gate the
// "Confirm and import" button client-side and, in the same shape, to decide
// what is safe to keep in a saved draft.
export function isDateDecisionComplete(decision: { action?: unknown; correctedDate?: unknown } | undefined): boolean {
  if (!decision || !ALLOWED_DATE_ACTIONS.includes(decision.action as DateReviewAction)) return false;
  if (decision.action !== "correct_date") return true;
  return isValidCorrectedDate(decision.correctedDate);
}

// The exact structural rule the commit route enforces on the wire (array)
// shape, shared so the server's 422 and the client's pre-submit check can
// never drift apart. Returns every invalid entry with a human reason
// instead of a single blanket boolean, so a rejection can point at the
// specific row instead of failing the whole batch opaquely.
export function findInvalidDateDecisions(dateDecisions: unknown): Array<{ fingerprint: string | null; reason: string }> {
  if (!Array.isArray(dateDecisions)) return [{ fingerprint: null, reason: "dateDecisions must be an array" }];
  const invalid: Array<{ fingerprint: string | null; reason: string }> = [];
  for (const raw of dateDecisions) {
    const decision = raw as { fingerprint?: unknown; action?: unknown; correctedDate?: unknown } | null;
    const fingerprint = typeof decision?.fingerprint === "string" ? decision.fingerprint : null;
    if (!fingerprint || !FINGERPRINT_PATTERN.test(fingerprint)) { invalid.push({ fingerprint, reason: "missing or malformed fingerprint" }); continue; }
    if (!ALLOWED_DATE_ACTIONS.includes(decision?.action as DateReviewAction)) { invalid.push({ fingerprint, reason: `unrecognized action "${String(decision?.action)}"` }); continue; }
    if (decision?.correctedDate !== undefined && !isValidCorrectedDate(decision.correctedDate)) {
      invalid.push({ fingerprint, reason: `corrected date "${String(decision.correctedDate)}" is not a valid calendar date` });
    }
  }
  return invalid;
}

// Sanitizes the client's fingerprint-keyed draft shape (distinct from the
// array shape above, used only at final commit) before it is durably
// persisted. A decision with an unrecognized action is dropped entirely
// (equivalent to "no decision yet"); a correct_date decision with an
// invalid corrected date keeps the user's chosen action but drops the bad
// value, so it is stored as still-incomplete rather than silently looking
// resolved days later when the draft is resumed.
export function sanitizeDraftDateDecisions(value: unknown): Record<string, { action: DateReviewAction; correctedDate?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sanitized: Record<string, { action: DateReviewAction; correctedDate?: string }> = {};
  for (const [fingerprint, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!FINGERPRINT_PATTERN.test(fingerprint)) continue;
    const decision = raw as { action?: unknown; correctedDate?: unknown } | null;
    if (!decision || !ALLOWED_DATE_ACTIONS.includes(decision.action as DateReviewAction)) continue;
    const action = decision.action as DateReviewAction;
    sanitized[fingerprint] = isValidCorrectedDate(decision.correctedDate) ? { action, correctedDate: (decision.correctedDate as string).trim() } : { action };
  }
  return sanitized;
}

// Pure and structural only -- it decides whether a decision is usable for
// the issue it targets and annotates the affected raw rows accordingly. It
// deliberately does not re-run classification itself: the caller re-runs
// buildJlDonationPreview on the returned rows so every normal rule
// (duplicate detection, household matching, amount checks, ...) applies to
// a corrected row exactly as it would to any other row.
export function resolveDateDecisions(rows: ImportRow[], activities: GivingActivity[], decisions: DateDecision[]): DateReviewResolution {
  const decisionByFingerprint = new Map(decisions.map((decision) => [decision.fingerprint, decision]));
  const unresolvedFingerprints: string[] = [];
  const edits: DateEdit[] = [];
  const appliedRowNumbers = new Map<number, string>();
  const nextRows = [...rows];

  for (const activity of activities) {
    if (activity.dateIssue === null) continue;
    const decision = decisionByFingerprint.get(activity.fingerprint);
    if (!decision) { unresolvedFingerprints.push(activity.fingerprint); continue; }
    if (decision.action === "skip" || decision.action === "review_later") continue;
    const rowIndex = activity.rowNumber - 2;
    const originalRow = rows[rowIndex];
    if (!originalRow) { unresolvedFingerprints.push(activity.fingerprint); continue; }

    if (decision.action === "accept_as_is") {
      // A structurally invalid date can never be "accepted" -- there is no
      // safe financial date to accept.
      if (activity.dateIssue !== "suspicious") { unresolvedFingerprints.push(activity.fingerprint); continue; }
      nextRows[rowIndex] = { ...originalRow, fundraisingOsAcceptSuspiciousDate: "true" };
      appliedRowNumbers.set(activity.rowNumber, activity.fingerprint);
      continue;
    }

    if (decision.action === "correct_date") {
      if (!isValidCorrectedDate(decision.correctedDate)) { unresolvedFingerprints.push(activity.fingerprint); continue; }
      const correctedDate = decision.correctedDate!.trim();
      const originalDateField = Object.hasOwn(originalRow, "Due Date") ? "Due Date" : "Date";
      const originalDateValue = (originalRow[originalDateField] ?? "").trim();
      nextRows[rowIndex] = { ...originalRow, fundraisingOsCorrectedDate: correctedDate };
      edits.push({ fingerprint: activity.fingerprint, row: activity.rowNumber, field: originalDateField, originalValue: originalDateValue, correctedValue: correctedDate });
      appliedRowNumbers.set(activity.rowNumber, activity.fingerprint);
      continue;
    }

    unresolvedFingerprints.push(activity.fingerprint);
  }

  return { rows: nextRows, unresolvedFingerprints, edits, appliedRowNumbers };
}

// After the caller re-runs buildJlDonationPreview on the annotated rows,
// this confirms every corrected/accepted row actually came out clean.
// Anything that didn't (e.g. a "corrected" date that is itself suspicious)
// is reported the same way an unresolved decision would be -- the row is
// not approved for import, and the client still knows it by its original
// fingerprint.
export function findStillUnresolvedDateFingerprints(appliedRowNumbers: Map<number, string>, revalidatedActivities: GivingActivity[]): string[] {
  const activityByRowNumber = new Map(revalidatedActivities.map((activity) => [activity.rowNumber, activity]));
  const stillUnresolved: string[] = [];
  for (const [rowNumber, originalFingerprint] of appliedRowNumbers) {
    const activity = activityByRowNumber.get(rowNumber);
    if (activity && activity.dateIssue !== null) stillUnresolved.push(originalFingerprint);
  }
  return stillUnresolved;
}
