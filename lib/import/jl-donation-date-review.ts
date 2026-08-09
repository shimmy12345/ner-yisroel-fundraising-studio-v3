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
      const correctedDate = decision.correctedDate?.trim() ?? "";
      if (!DATE_ONLY_PATTERN.test(correctedDate) || parseFinancialDate(correctedDate) === null) { unresolvedFingerprints.push(activity.fingerprint); continue; }
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
