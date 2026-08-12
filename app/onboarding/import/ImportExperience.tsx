"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { FIELD_LABELS, recognizeColumns, type ColumnMapping, type ColumnSuggestion, type ImportField, type ImportPreview, type ImportRow } from "../../../lib/import/recognition";
import { decodeCsv, parseCsv, parseXlsx, rowsToRecords } from "../../../lib/import/file-parsers";
import { JL_MAPPING } from "../../../lib/import/jl-solutions";
import { classifyJlImportType, countStrongDonationIndicators } from "../../../lib/import/jl-export-type";
import { UndoDonationImport } from "./UndoDonationImport";
import { financialDateLabel, parseFinancialDate } from "../../../lib/financial-date";
import { isDateDecisionComplete } from "../../../lib/import/jl-donation-date-review";

type Step = "upload" | "recognition" | "preview" | "importing" | "complete" | "failed";
type FailureCategory = "unmatched_jl_codes" | "duplicate_records" | "invalid_dates" | "invalid_amounts" | "missing_required_fields" | "classification_review" | "nonfinancial_entries" | "transaction_database_errors" | "unexpected_exceptions";
type DonationRowDisposition = "skipped" | "review_later" | "unresolved";
type RowFailure = { row: number; category?: FailureCategory; reason: string; values?: ImportRow; fingerprint?: string | null; disposition?: DonationRowDisposition; donor?: string | null; jlCode?: string | null; campaign?: string | null; date?: number | null; amountCents?: number | null };
type ValidationSummary = { totalRows: number; passedRows: number; failedRows: number; duplicateRows: number; nonfinancialRows: number; firstErrors: RowFailure[] };
// rowsRequiringReview is a row genuinely blocking, unresolvable-in-app
// disposition -- it must always be 0 for a completed import (every
// decision-driven review path blocks commit while unresolved). skippedRows
// and reviewLaterRows are already-resolved outcomes, tracked separately so
// the completion screen never calls reviewed rows "requiring review".
type ResultSummary = { validRows: number; householdsMatched: number; newHouseholds: number; giftsImported: number; giftsUpdated: number; duplicateRowsSkipped: number; rowsRequiringReview: number; skippedRows?: number; reviewLaterRows?: number; rejectedRows: number; unmatchedJlCodes: number; elapsedMs: number };
type ImportFailure = { error: string; fatalError?: string | null; importId?: string; databaseChangesMade: boolean; noChangesMade: boolean; outcomeStatus?: "not_committed" | "processing" | "unknown"; rollbackCauses: FailureCategory[]; validation: ValidationSummary; reviewRows?: RowFailure[]; rejectedRows: RowFailure[]; results: ResultSummary };
type DuplicateImportBlock = { error: string; importId: string; duplicateBlocked: true; canForceReprocess: boolean; priorStatus: string; completedAt: number | null; warning: string };
type UnresolvedDecisionsFailure = { error: string; sessionExpired?: boolean; attemptStatus?: string; invalidDateDecisions?: Array<{ fingerprint: string | null; reason: string }>; unresolvedDateFingerprints?: string[]; unresolvedReviewFingerprints?: string[]; unresolvedRejectionFingerprints?: string[] };
type ImportReport = {
  importId: string;
  fileName: string;
  completedAt: string;
  updateExisting: boolean;
  imported: { donors: number; gifts: number; interactions: number; reminders: number };
  rejectedRows: RowFailure[];
  reviewRows?: RowFailure[];
  rejectedRowDetails?: Array<RejectedRowItem & { outcome: "hard_excluded" | "imported" | "skipped" }>;
  warnings: string[];
  firstRelationshipId?: string | null;
  profile?: string;
  donation?: { newActivities: number; updatedPledges: number; unchanged: number; unknownHousehold: number; needsReview: number; nonfinancialExcluded: number; duplicateSourceRows: number };
  validation?: ValidationSummary;
  results?: ResultSummary;
  databaseChangesMade?: boolean;
  fatalError?: string | null;
  noChangesMade?: boolean;
  reviewOnly?: boolean;
  message?: string;
  refresh?: { kind: "household" | "donation"; rangeStart?: string | null; rangeEnd?: string | null; historicalRecordsDeleted: number; workspaceRecordsPreserved: boolean };
  household?: { created: number; updated: number; merged: number; reviewLater: number; previousRefreshAt: number | null; reviewMode?: ReviewMode; decisions?: Array<{ externalId: string; action: string; fields: Record<string, string> }>; duplicateDecisions?: Array<{ externalId: string; action: string; manualDonorId: string }> };
};
type MergeCandidate = { externalId: string; jlName: string; manualDonorId: string; manualName: string; reasons: string[]; exactCodeMatch: boolean };
type MergeDecision = { action: "needs_decision" | "merge" | "keep_separate" | "review_later"; manualDonorId: string };
type FieldDecision = "needs_decision" | "keep_local" | "use_jl";
type ReviewMode = "review_every" | "changes_only" | "auto_unchanged";
type ExistingDecisionAction = "needs_decision" | "accept_all" | "keep_current" | "field_by_field";
type ExistingDecisionState = { action: ExistingDecisionAction; signature: string };
type JlFieldChange = { externalId: string; field: string; currentValue: string; jlValue: string; requiresDecision: boolean; changed?: boolean };
type ExistingDonorReview = { externalId: string; donorName: string; changed: boolean; localOverrideCount: number; signature: string; comparisons: JlFieldChange[] };
type JlPreview = { households: number; newRelationships: number; existingRelationships: number; recordsWithUpdates: number; reviewMode: ReviewMode; existingDonorReviews: ExistingDonorReview[]; changes: JlFieldChange[]; conflicts: JlFieldChange[]; codeCollisions: Array<{ externalId: string; donorIds: string[] }>; mergeCandidates: MergeCandidate[]; duplicateRows: number; rejectedRows: number };
type OpenPledgePreview = { id: string; activity_date: number | null; committed_cents: number; paid_cents: number; balance_cents: number; description: string | null; source_campaign: string | null };
type PaymentAssignmentPreview = { row: number; fingerprint: string; donorName: string; donorMatched: boolean; paymentDate: number | null; amountCents: number | null; campaign: string; action: "apply_to_pledge" | "new_gift" | "needs_review"; pledgeId: string | null; remembered: boolean; alreadyApplied: boolean; reason: string | null; openPledges: OpenPledgePreview[] };
type PaymentDecisionState = { action: "apply_to_pledge" | "new_gift" | "needs_review"; pledgeId: string | null; overpaymentAction: "split_remainder_new_gift" | null };
type PendingGiftMatch = { id: string; activityDate: number; amountCents: number; designation: string | null; note: string | null };
type PendingGiftMatchPreview = { fingerprint: string; candidates: PendingGiftMatch[] };
type PendingGiftDecisionState = { action: "needs_decision" | "merge" | "keep_separate"; pendingGiftId: string | null };
type ReviewRowItem = { row: number; fingerprint: string; reason: string; donor: string | null; jlCode: string | null; transactionType: string | null; campaign: string | null; date: number | null; originalDateValue: string | null; amountCents: number | null; duplicateGroupKey: string | null; duplicateGroupSize: number; dateIssue: "invalid" | "suspicious" | null; resolvable: boolean };
type ReviewDecisionAction = "needs_decision" | "import_anyway" | "skip" | "review_later";
type ReviewDecisionState = { action: ReviewDecisionAction };
type DateReviewAction = "needs_decision" | "correct_date" | "accept_as_is" | "skip" | "review_later";
type DateDecisionState = { action: DateReviewAction; correctedDate?: string };
type CrossImportRow = { fingerprint: string; matchType: "confirmed_duplicate" | "possible_duplicate"; reason: string; row: number | null; donor: string | null; jlCode: string | null; campaign: string | null; date: number | null; amountCents: number | null; existingActivityDate: number | null; existingAmountCents: number | null; existingCampaign: string | null; existingImportedAt: number };
type RejectedRowCategory = "duplicate_transaction_id" | "unmatched_jl_code" | "nonfinancial_entry";
type RejectedRowItem = { fingerprint: string; row: number; category: RejectedRowCategory; severity: "hard" | "reviewable"; reason: string; donor: string | null; jlCode: string | null; campaign: string | null; date: number | null; amountCents: number | null; existingMatchRow: number | null };
type RejectionDecisionAction = "needs_decision" | "import_anyway" | "match_donor" | "skip" | "review_later";
type RejectionDecisionState = { action: RejectionDecisionAction; correctedJlCode?: string };
type DonationPreview = { rows: number; matchedRows: number; unknownHousehold: number; duplicateSourceRows: number; zeroDollar: number; openPledges: number; needsReview: number; suspiciousDates: number; nonfinancial: number; newActivities: number; proposedUpdates: number; alreadyImported: number; conflicts: number; reviewRows: ReviewRowItem[]; crossImportRows: CrossImportRow[]; rejectedRows: number; rejectedRowDetails: RejectedRowItem[]; rangeStart: string | null; rangeEnd: string | null; paymentAssignments: PaymentAssignmentPreview[]; pendingGiftMatches?: PendingGiftMatchPreview[] };
const REJECTED_ROW_CATEGORY_LABELS: Record<RejectedRowCategory, string> = { duplicate_transaction_id: "Duplicate transaction ID", unmatched_jl_code: "Unmatched JL Code", nonfinancial_entry: "Zero-dollar / nonfinancial entry" };
type ResumableDraft = { id: string; file_name: string; file_hash: string; row_count: number; progress_resolved: number; progress_total: number; created_at: number; updated_at: number; expires_at: number };
type ResumableReviewLater = ResumableDraft & { reviewLaterCount: number };
type DecisionMaps = { reviewDecisions: Record<string, ReviewDecisionState>; crossImportDecisions: Record<string, ReviewDecisionState>; rejectionDecisions: Record<string, RejectionDecisionState>; dateDecisions: Record<string, DateDecisionState> };

export type RefreshOverview = {
  lastHouseholdRefreshAt: string | null; lastDonationRefreshAt: string | null; lastDonationRangeStart: string | null; lastDonationRangeEnd: string | null;
  suggestedRangeStart: string | null; suggestedRangeEnd: string | null;
  pendingReviews: number;
  undoAvailable: number;
  history: Array<{ id: string; fileName: string; completedAt: string | null; kind: string; summary: string; status: string; canUndo: boolean; undoKind: "donation" | "household" | null }>;
};

const DONATION_LABELS: Record<string, string> = { Code: "JL household code", Name: "Source household name", "Total Due": "Validation context only", "Item Num": "Item type", Desc: "Description", Campaign: "Supporting source context", "Due Date": "Activity date", Amount: "Committed amount", Paid: "Paid amount", "Balance Due": "Outstanding balance", Company: "Validation context only" };
const FAILURE_LABELS: Record<FailureCategory, string> = {
  unmatched_jl_codes: "Unmatched JL Codes",
  duplicate_records: "Duplicate records",
  invalid_dates: "Invalid dates",
  invalid_amounts: "Invalid amounts",
  missing_required_fields: "Missing required fields",
  classification_review: "Classification requires review",
  nonfinancial_entries: "Zero-dollar or nonfinancial entries",
  transaction_database_errors: "Transaction or database error",
  unexpected_exceptions: "Unexpected exception",
};

const fields = Object.entries(FIELD_LABELS) as Array<[ImportField, string]>;

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvValue(value: string | number) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const dateLabel = (value: string | null) => {
  if (!value) return "Not yet refreshed";
  if (value.length === 10) {
    const financialDate = parseFinancialDate(value);
    return financialDate === null ? "Date unavailable" : financialDateLabel(financialDate);
  }
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value));
};
const centsLabel = (value: number | null) => value === null ? "Amount unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const epochDateLabel = (value: number | null) => value === null ? "Date unavailable" : financialDateLabel(value);
const REVIEW_MODE_COPY: Record<ReviewMode, { label: string; description: string }> = {
  review_every: { label: "Review every existing donor", description: "Every JL Code match waits for your confirmation, even when nothing changed." },
  changes_only: { label: "Review only donors with changes", description: "Unchanged matches continue automatically; changed donors wait for review." },
  auto_unchanged: { label: "Auto-continue unchanged donors", description: "Fastest mode: unchanged matches continue automatically, while every changed donor still waits for review." },
};

export function ImportExperience({ refreshOverview, initialReviewMode }: { refreshOverview: RefreshOverview; initialReviewMode: ReviewMode }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileHash, setFileHash] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [suggestions, setSuggestions] = useState<ColumnSuggestion[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [editingColumn, setEditingColumn] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [failureReport, setFailureReport] = useState<ImportFailure | null>(null);
  const [jlDetected, setJlDetected] = useState(false);
  const [jlPreview, setJlPreview] = useState<JlPreview | null>(null);
  const [mode, setMode] = useState<"first" | "refresh">(refreshOverview.lastHouseholdRefreshAt ? "refresh" : "first");
  const [donationDetected, setDonationDetected] = useState(false);
  const [donationPreview, setDonationPreview] = useState<DonationPreview | null>(null);
  const [paymentDecisions, setPaymentDecisions] = useState<Record<string, PaymentDecisionState>>({});
  const [pendingGiftDecisions, setPendingGiftDecisions] = useState<Record<string, PendingGiftDecisionState>>({});
  const [mergeDecisions, setMergeDecisions] = useState<Record<string, MergeDecision>>({});
  const [fieldDecisions, setFieldDecisions] = useState<Record<string, FieldDecision>>({});
  const [reviewMode, setReviewMode] = useState<ReviewMode>(initialReviewMode);
  const [existingDonorDecisions, setExistingDonorDecisions] = useState<Record<string, ExistingDecisionState>>({});
  const [reviewDecisions, setReviewDecisions] = useState<Record<string, ReviewDecisionState>>({});
  const [crossImportDecisions, setCrossImportDecisions] = useState<Record<string, ReviewDecisionState>>({});
  const [rejectionDecisions, setRejectionDecisions] = useState<Record<string, RejectionDecisionState>>({});
  const [dateDecisions, setDateDecisions] = useState<Record<string, DateDecisionState>>({});
  const [rejectedRowFilter, setRejectedRowFilter] = useState<RejectedRowCategory | "all">("all");
  const [ambiguousType, setAmbiguousType] = useState<{ donationIndicatorCount: number; message: string } | null>(null);
  const [confirmedType, setConfirmedType] = useState<"household" | "donation" | undefined>(undefined);
  const [duplicateBlock, setDuplicateBlock] = useState<DuplicateImportBlock | null>(null);
  const [forceConfirmation, setForceConfirmation] = useState("");
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [resumableDrafts, setResumableDrafts] = useState<ResumableDraft[]>([]);
  const [resumableReviewLater, setResumableReviewLater] = useState<ResumableReviewLater[]>([]);
  const [followUpReview, setFollowUpReview] = useState(false);
  const [rowDrillDown, setRowDrillDown] = useState<{ title: string; description: string; rows: RowFailure[] } | null>(null);
  const [changedRowsNotice, setChangedRowsNotice] = useState<number>(0);
  const saveDraftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function inspectFile(file: File) {
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setError("Choose a CSV or Excel (.xlsx) file.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose a file smaller than 10 MB.");
      return;
    }

    setError("");
    setStatusMessage("Reading your file locally…");
    try {
      const buffer = await file.arrayBuffer();
      const parsedRows = /\.csv$/i.test(file.name)
        ? parseCsv(decodeCsv(buffer))
        : parseXlsx(buffer);
      const table = rowsToRecords(parsedRows);
      // The same classifier used by the preview and commit routes decides
      // the type here too, so the upload-time banner and mapping choice can
      // never disagree with what preview/commit will do with this file.
      const importType = classifyJlImportType(table.columns, table.rows);
      const detectedDonation = importType === "donation";
      const detectedJl = importType === "household";
      const recognized = detectedDonation ? [] : detectedJl
        ? table.columns.map((column) => ({ column, field: JL_MAPPING[column] ?? "ignore" as const, confidence: 0.99, requiresReview: false }))
        : recognizeColumns(table.columns);
      setFileName(file.name);
      setFileHash(await sha256(buffer));
      setRows(table.rows);
      setSuggestions(recognized);
      setMapping(Object.fromEntries(recognized.map((item) => [item.column, item.field])));
      setStep("recognition");
      setJlDetected(detectedJl);
      setDonationDetected(detectedDonation);
      setPaymentDecisions({});
      setPendingGiftDecisions({});
      setMergeDecisions({});
      setFieldDecisions({});
      setExistingDonorDecisions({});
      setReviewDecisions({});
      setCrossImportDecisions({});
      setRejectionDecisions({});
      setDateDecisions({});
      setRejectedRowFilter("all");
      setConfirmedType(undefined);
      setAmbiguousType(importType === "ambiguous" ? {
        donationIndicatorCount: countStrongDonationIndicators(table.columns, table.rows),
        message: "This file has some donation-shaped columns but is not clearly one type. Choose whether this is a Household export or a Donation export before continuing.",
      } : null);
      setDuplicateBlock(null);
      setForceConfirmation("");
      setPreviewSessionId(null);
      setFollowUpReview(false);
      setAttemptId(null);
      setChangedRowsNotice(0);
      setMode((detectedJl && refreshOverview.lastHouseholdRefreshAt) || (detectedDonation && refreshOverview.lastDonationRefreshAt) ? "refresh" : "first");
      setStatusMessage("");
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : "The file could not be read.");
      setStatusMessage("");
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void inspectFile(file);
  }

  function dropFile(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void inspectFile(file);
  }

  async function showPreview(forceType?: "household" | "donation", resumeSessionId?: string) {
    setError("");
    setDuplicateBlock(null);
    setForceConfirmation("");
    setAmbiguousType(null);
    setStatusMessage(resumeSessionId ? "Resuming your review…" : "Checking the preview securely…");
    try {
      const body = resumeSessionId ? { previewSessionId: resumeSessionId, forceType } : { rows, mapping, fileHash, fileName, forceType };
      const response = await fetch("/api/import/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { profile?: string; preview?: ImportPreview; jl?: JlPreview; donation?: DonationPreview; previewSessionId?: string; restoredDecisions?: Record<string, Record<string, unknown>>; resumedFollowUp?: boolean; fileName?: string; fileHash?: string; ambiguous?: { donationIndicatorCount: number; message: string }; error?: string; draftUnavailable?: boolean };
      if (payload.profile === "ambiguous" && payload.ambiguous) {
        setAmbiguousType(payload.ambiguous);
        return;
      }
      if (response.status === 410 && payload.draftUnavailable) {
        setError(payload.error ?? "This draft is no longer available.");
        void fetchResumableDrafts();
        return;
      }
      if (!response.ok || (!payload.preview && !payload.donation)) throw new Error(payload.error ?? "The preview could not be prepared.");
      if (resumeSessionId) {
        setFileName(payload.fileName ?? "");
        setFileHash(payload.fileHash ?? "");
      }
      setPreview(payload.preview ?? { donors: [], gifts: [], interactions: [], reminders: [], rejectedRows: [], warnings: [] });
      setJlPreview(payload.jl ?? null);
      if (payload.jl) setReviewMode(payload.jl.reviewMode);
      setMergeDecisions(Object.fromEntries((payload.jl?.mergeCandidates ?? []).map((candidate) => [candidate.externalId, { action: "needs_decision", manualDonorId: candidate.manualDonorId }])));
      setExistingDonorDecisions(Object.fromEntries((payload.jl?.existingDonorReviews ?? []).map((donor) => [donor.externalId, { action: "needs_decision", signature: donor.signature }])));
      setFieldDecisions(Object.fromEntries((payload.jl?.changes ?? []).map((change) => [`${change.externalId}:${change.field}`, "needs_decision"] as const)));
      setDonationPreview(payload.donation ?? null);
      setDonationDetected(payload.profile === "jl-donations");
      setJlDetected(payload.profile === "jl-solutions");
      // Restoring saved decisions never guesses: a saved decision is kept
      // only when its fingerprint still appears among this preview's own
      // reviewable rows. Anything dropped means that specific row's content
      // changed since it was reviewed -- it will show up needing a fresh
      // decision instead of silently keeping a stale one.
      const restoreDecisions = (saved: Record<string, unknown> | undefined, currentFingerprints: string[]) => {
        const currentSet = new Set(currentFingerprints);
        let dropped = 0;
        const restored: Record<string, unknown> = {};
        for (const [fingerprint, value] of Object.entries(saved ?? {})) {
          if (currentSet.has(fingerprint)) restored[fingerprint] = value; else dropped += 1;
        }
        return { restored, dropped };
      };
      const restored = payload.restoredDecisions ?? {};
      const paymentInit = Object.fromEntries((payload.donation?.paymentAssignments ?? []).map((item) => [item.fingerprint, { action: item.action, pledgeId: item.pledgeId, overpaymentAction: null }]));
      const paymentRestore = restoreDecisions(restored.paymentDecisions, (payload.donation?.paymentAssignments ?? []).map((item) => item.fingerprint));
      setPaymentDecisions({ ...paymentInit, ...paymentRestore.restored } as Record<string, PaymentDecisionState>);
      const pendingInit = Object.fromEntries((payload.donation?.pendingGiftMatches ?? []).map((item) => [item.fingerprint, { action: "needs_decision", pendingGiftId: null }]));
      const pendingRestore = restoreDecisions(restored.pendingGiftDecisions, (payload.donation?.pendingGiftMatches ?? []).map((item) => item.fingerprint));
      setPendingGiftDecisions({ ...pendingInit, ...pendingRestore.restored } as Record<string, PendingGiftDecisionState>);
      const reviewFingerprints = (payload.donation?.reviewRows ?? []).filter((item) => item.resolvable && item.dateIssue === null).map((item) => item.fingerprint);
      const reviewRestore = restoreDecisions(restored.reviewDecisions, reviewFingerprints);
      setReviewDecisions({ ...Object.fromEntries(reviewFingerprints.map((fingerprint) => [fingerprint, { action: "needs_decision" as const }])), ...reviewRestore.restored } as Record<string, ReviewDecisionState>);
      const crossImportFingerprints = (payload.donation?.crossImportRows ?? []).map((item) => item.fingerprint);
      const crossImportRestore = restoreDecisions(restored.crossImportDecisions, crossImportFingerprints);
      setCrossImportDecisions({ ...Object.fromEntries(crossImportFingerprints.map((fingerprint) => [fingerprint, { action: "needs_decision" as const }])), ...crossImportRestore.restored } as Record<string, ReviewDecisionState>);
      const rejectionFingerprints = (payload.donation?.rejectedRowDetails ?? []).filter((item) => item.severity === "reviewable").map((item) => item.fingerprint);
      const rejectionRestore = restoreDecisions(restored.rejectionDecisions, rejectionFingerprints);
      setRejectionDecisions({ ...Object.fromEntries(rejectionFingerprints.map((fingerprint) => [fingerprint, { action: "needs_decision" as const }])), ...rejectionRestore.restored } as Record<string, RejectionDecisionState>);
      const dateFingerprints = (payload.donation?.reviewRows ?? []).filter((item) => item.dateIssue !== null).map((item) => item.fingerprint);
      const dateRestore = restoreDecisions(restored.dateDecisions, dateFingerprints);
      setDateDecisions({ ...Object.fromEntries(dateFingerprints.map((fingerprint) => [fingerprint, { action: "needs_decision" as const }])), ...dateRestore.restored } as Record<string, DateDecisionState>);
      setChangedRowsNotice(paymentRestore.dropped + pendingRestore.dropped + reviewRestore.dropped + crossImportRestore.dropped + rejectionRestore.dropped + dateRestore.dropped);
      setRejectedRowFilter("all");
      setConfirmedType(forceType);
      // A server-stored draft for this reviewed file, and a fresh
      // idempotency id for whatever commit attempt follows this preview --
      // reused across any lost-response recovery for that same attempt.
      setPreviewSessionId(payload.previewSessionId ?? null);
      setFollowUpReview(Boolean(payload.resumedFollowUp));
      setAttemptId(crypto.randomUUID());
      setStep("preview");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "The preview could not be prepared.");
    } finally { setStatusMessage(""); }
  }

  async function fetchResumableDrafts() {
    try {
      const response = await fetch("/api/import/draft");
      if (!response.ok) return;
      const payload = await response.json() as { drafts?: ResumableDraft[]; reviewLater?: ResumableReviewLater[] };
      setResumableDrafts(payload.drafts ?? []);
      setResumableReviewLater(payload.reviewLater ?? []);
    } catch { /* the resumable-drafts list is a convenience; a failed fetch just leaves it empty */ }
  }

  function resumeDraft(draft: ResumableDraft) {
    void showPreview(undefined, draft.id);
  }

  async function discardDraft(id: string) {
    try {
      await fetch(`/api/import/draft?previewSessionId=${encodeURIComponent(id)}`, { method: "DELETE" });
    } finally {
      void fetchResumableDrafts();
    }
  }

  useEffect(() => {
    if (step === "upload") void fetchResumableDrafts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function importData(forceReprocess = false) {
    if (!preview || step === "importing") return;
    setStep("importing");
    setError("");

    // Session preflight: a lightweight authenticated call before committing.
    // Hundreds of reviewed rows can take a long time to work through, long
    // enough for the session to have lapsed since the preview was loaded.
    // This never discards paymentDecisions/reviewDecisions/etc. -- only a
    // fresh commit or a new file upload resets those.
    try {
      const sessionCheck = await fetch("/api/profile");
      if (sessionCheck.status === 401) { setFailureReport(sessionExpiredFailure()); setStep("failed"); return; }
    } catch { /* the preflight itself is inconclusive on a network error; fall through to the real attempt */ }

    const currentAttemptId = attemptId ?? crypto.randomUUID();
    if (!attemptId) setAttemptId(currentAttemptId);
    try {
      const body = JSON.stringify({
        fileName, fileHash, mapping, updateExisting, mode, reviewMode, forceType: confirmedType,
        previewSessionId, attemptId: currentAttemptId,
        // The full parsed file is only sent when there is no server-stored
        // preview session for it (e.g. the household/general import paths).
        rows: previewSessionId ? undefined : rows,
        paymentDecisions: Object.entries(paymentDecisions).map(([fingerprint, decision]) => ({ fingerprint, ...decision })), pendingGiftDecisions: Object.entries(pendingGiftDecisions).map(([fingerprint, decision]) => ({ fingerprint, ...decision })).filter((decision) => decision.action !== "needs_decision"), reviewDecisions: Object.entries(reviewDecisions).map(([fingerprint, decision]) => ({ fingerprint, action: decision.action, groupKey: donationPreview?.reviewRows.find((item) => item.fingerprint === fingerprint)?.duplicateGroupKey ?? null })).filter((decision) => decision.action !== "needs_decision"), crossImportDecisions: Object.entries(crossImportDecisions).map(([fingerprint, decision]) => ({ fingerprint, action: decision.action })).filter((decision) => decision.action !== "needs_decision"), rejectionDecisions: Object.entries(rejectionDecisions).map(([fingerprint, decision]) => ({ fingerprint, action: decision.action, correctedJlCode: decision.action === "match_donor" ? decision.correctedJlCode : undefined })).filter((decision) => decision.action !== "needs_decision"), dateDecisions: Object.entries(dateDecisions).map(([fingerprint, decision]) => ({ fingerprint, action: decision.action, correctedDate: decision.action === "correct_date" ? decision.correctedDate : undefined })).filter((decision) => decision.action !== "needs_decision"), mergeDecisions: Object.entries(mergeDecisions).map(([externalId, decision]) => ({ externalId, ...decision })), existingDonorDecisions: Object.entries(existingDonorDecisions).map(([externalId, decision]) => ({ externalId, ...decision })).filter((decision) => decision.action !== "needs_decision"), fieldDecisions: (jlPreview?.changes ?? []).map((change) => ({ externalId: change.externalId, field: change.field, action: fieldDecisions[`${change.externalId}:${change.field}`] })).filter((decision) => decision.action !== "needs_decision"), forceReprocess, forceConfirmation: forceReprocess ? forceConfirmation : undefined,
      });
      const response = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body });
      const payload = await response.json() as ImportReport | ImportFailure | DuplicateImportBlock | UnresolvedDecisionsFailure;
      if (!response.ok) {
        if (response.status === 409 && "duplicateBlocked" in payload && payload.duplicateBlocked) {
          setDuplicateBlock(payload);
          setError(payload.error);
          setStep("preview");
          return;
        }
        if (response.status === 410 && "sessionExpired" in payload && payload.sessionExpired) {
          setError("Your review session has expired. Refresh the preview and try again.");
          setStep("preview");
          return;
        }
        if (response.status === 409 && "attemptStatus" in payload && payload.attemptStatus === "processing") {
          await reconcileLostCommitResponse();
          return;
        }
        // Defense in depth: the client-side gates above (unresolvedDateRows
        // etc.) should already keep a bad decision set from ever reaching
        // here, but if the server still rejects specific rows -- e.g. a
        // decision saved before this fix, or a row the rebuilt preview
        // reclassified -- never drop the whole review into the generic
        // "failed" step. Nothing was written (this 422 happens before any
        // D1 write), so send the user straight back to the exact rows that
        // need attention with everything else untouched.
        const unresolved = payload as UnresolvedDecisionsFailure;
        const staleFingerprints = [
          ...(unresolved.invalidDateDecisions ?? []).map((entry) => entry.fingerprint).filter((fp): fp is string => Boolean(fp)),
          ...(unresolved.unresolvedDateFingerprints ?? []),
          ...(unresolved.unresolvedReviewFingerprints ?? []),
          ...(unresolved.unresolvedRejectionFingerprints ?? []),
        ];
        if (staleFingerprints.length) {
          const staleSet = new Set(staleFingerprints);
          setDateDecisions((current) => {
            const next = { ...current };
            for (const fingerprint of staleSet) if (next[fingerprint]) next[fingerprint] = { action: "correct_date", correctedDate: undefined };
            return next;
          });
          setReviewDecisions((current) => {
            const next = { ...current };
            for (const fingerprint of staleSet) delete next[fingerprint];
            return next;
          });
          setRejectionDecisions((current) => {
            const next = { ...current };
            for (const fingerprint of staleSet) delete next[fingerprint];
            return next;
          });
          const affectedRows = [...staleSet]
            .map((fingerprint) => donationPreview?.reviewRows.find((item) => item.fingerprint === fingerprint)?.row ?? donationPreview?.rejectedRowDetails.find((item) => item.fingerprint === fingerprint)?.row)
            .filter((row): row is number => row !== undefined)
            .sort((a, b) => a - b);
          const rowLabel = affectedRows.length ? `Row${affectedRows.length === 1 ? "" : "s"} ${affectedRows.join(", ")}` : `${staleFingerprints.length} row${staleFingerprints.length === 1 ? "" : "s"}`;
          setError(`${unresolved.error} ${rowLabel} need${affectedRows.length === 1 ? "s" : ""} attention below. Every other decision you already made is unchanged. No changes were made to the database.`);
          setStep("preview");
          return;
        }
        if ("validation" in payload && "rollbackCauses" in payload) {
          setFailureReport(payload as ImportFailure);
          setStep("failed");
          return;
        }
        const message = "error" in payload && payload.error ? payload.error : "The import request could not be completed.";
        setFailureReport(unexpectedFailure(message));
        setStep("failed");
        return;
      }
      setReport(payload as ImportReport);
      setRowDrillDown(null);
      setStep("complete");
    } catch {
      // fetch() itself rejected (e.g. "Failed to fetch") -- this never means
      // the write didn't happen, only that this response never arrived.
      await reconcileLostCommitResponse();
    }
  }

  function unexpectedFailure(reason: string, outcomeStatus: "not_committed" | "processing" | "unknown" = "not_committed"): ImportFailure {
    // "not_committed" is a confirmed outcome (a validated server error, or a
    // status check that positively found nothing was written) -- safe to
    // say plainly nothing changed. "processing"/"unknown" must never make
    // that claim: the write may already have happened even though this
    // response was lost.
    const confirmedNotWritten = outcomeStatus === "not_committed";
    return {
      error: reason,
      fatalError: reason,
      databaseChangesMade: false,
      noChangesMade: confirmedNotWritten,
      outcomeStatus,
      rollbackCauses: ["unexpected_exceptions"],
      validation: { totalRows: rows.length, passedRows: 0, failedRows: rows.length, duplicateRows: 0, nonfinancialRows: 0, firstErrors: [{ row: 0, category: "unexpected_exceptions", reason }] },
      reviewRows: [],
      rejectedRows: confirmedNotWritten ? rows.map((_, index) => ({ row: index + 2, category: "unexpected_exceptions", reason: "Row was not written because the import request failed." })) : [],
      results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: 0, rowsRequiringReview: rows.length, rejectedRows: confirmedNotWritten ? rows.length : 0, unmatchedJlCodes: 0, elapsedMs: 0 },
    };
  }

  function sessionExpiredFailure(): ImportFailure {
    return unexpectedFailure("Your session expired. Sign in again before importing.", "not_committed");
  }

  // Reconciles a commit whose response was lost (fetch() itself threw, most
  // often surfaced to the browser as "Failed to fetch") by asking the
  // status endpoint what actually happened, instead of assuming failure.
  async function reconcileLostCommitResponse() {
    if (!attemptId) { setFailureReport(unexpectedFailure("The import request could not be completed and its outcome could not be confirmed. Check your recent imports before trying again.", "unknown")); setStep("failed"); return; }
    try {
      const statusResponse = await fetch(`/api/import/status?attemptId=${encodeURIComponent(attemptId)}`);
      if (statusResponse.status === 401) { setFailureReport(sessionExpiredFailure()); setStep("failed"); return; }
      const statusPayload = await statusResponse.json() as { status?: "committed" | "not_committed" | "processing" | "unknown"; report?: ImportReport | null };
      if (statusPayload.status === "committed" && statusPayload.report) { setReport(statusPayload.report); setStep("complete"); return; }
      if (statusPayload.status === "not_committed") {
        setFailureReport(unexpectedFailure("The connection was lost before this import completed. No changes were made to the database — it is safe to try again.", "not_committed"));
        setStep("failed");
        return;
      }
      if (statusPayload.status === "processing") {
        setFailureReport(unexpectedFailure("This import is still processing on the server. Wait a moment and check again before retrying — do not resubmit yet.", "processing"));
        setStep("failed");
        return;
      }
      setFailureReport(unexpectedFailure("The connection was lost and we could not confirm whether this import completed. Do not retry blindly — check your recent imports before trying again.", "unknown"));
      setStep("failed");
    } catch {
      setFailureReport(unexpectedFailure("The connection was lost and we could not confirm whether this import completed. Do not retry blindly — check your recent imports before trying again.", "unknown"));
      setStep("failed");
    }
  }

  function cancelImport() {
    setStep("upload");
    setFileName("");
    setFileHash("");
    setRows([]);
    setSuggestions([]);
    setMapping({});
    setPreview(null);
    setJlDetected(false);
    setJlPreview(null);
    setDonationDetected(false);
    setDonationPreview(null);
    setPaymentDecisions({});
    setPendingGiftDecisions({});
    setMergeDecisions({});
    setFieldDecisions({});
    setExistingDonorDecisions({});
    setReviewDecisions({});
    setCrossImportDecisions({});
    setRejectionDecisions({});
    setDateDecisions({});
    setRejectedRowFilter("all");
    setAmbiguousType(null);
    setDuplicateBlock(null);
    setForceConfirmation("");
    setPreviewSessionId(null);
    setFollowUpReview(false);
    setAttemptId(null);
    setChangedRowsNotice(0);
    setFailureReport(null);
    setRowDrillDown(null);
    setReport(null);
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function sourceValues(item: RowFailure) {
    return item.values ?? rows[item.row - 2] ?? {};
  }

  function downloadRows(items: RowFailure[], suffix: string, kind: "rejected" | "review") {
    const sourceColumns = Object.keys(rows[0] ?? {});
    const header = ["row", "category", "reason", ...sourceColumns].map(csvValue).join(",");
    const lines = items.map((item) => {
      const values = sourceValues(item);
      return [item.row, item.category ?? "validation", item.reason, ...sourceColumns.map((column) => values[column] ?? "")].map(csvValue).join(",");
    });
    download(`fundraising-os-${kind}-rows-${suffix}.csv`, [header, ...lines].join("\n"), "text/csv");
  }

  const stepNumber = step === "upload" ? 1 : step === "recognition" ? 2 : step === "preview" ? 3 : 4;
  const paymentAllocations = new Map<string, { priorAllocatedCents: number; appliedCents: number; remainderCents: number; resolved: boolean }>();
  const allocatedByPledge = new Map<string, number>();
  for (const item of donationPreview?.paymentAssignments ?? []) {
    if (item.alreadyApplied) continue;
    const decision = paymentDecisions[item.fingerprint];
    if (decision?.action !== "apply_to_pledge" || !decision.pledgeId) continue;
    const pledge = item.openPledges.find((option) => option.id === decision.pledgeId);
    if (!pledge) continue;
    const priorAllocation = allocatedByPledge.get(pledge.id) ?? 0;
    const availableCents = Math.max(0, pledge.balance_cents - priorAllocation);
    const appliedCents = Math.min(item.amountCents ?? 0, availableCents);
    const remainderCents = Math.max(0, (item.amountCents ?? 0) - appliedCents);
    const resolved = appliedCents > 0 && (remainderCents === 0 || decision.overpaymentAction === "split_remainder_new_gift");
    paymentAllocations.set(item.fingerprint, { priorAllocatedCents: priorAllocation, appliedCents, remainderCents, resolved });
    if (resolved) allocatedByPledge.set(pledge.id, priorAllocation + appliedCents);
  }
  const unresolvedPayments = donationPreview?.paymentAssignments.filter((item) => {
    if (item.alreadyApplied) return false;
    const decision = paymentDecisions[item.fingerprint];
    if (!decision || decision.action === "needs_review") return true;
    if (decision.action !== "apply_to_pledge") return false;
    const pledge = item.openPledges.find((option) => option.id === decision.pledgeId);
    return !pledge || !paymentAllocations.get(item.fingerprint)?.resolved;
  }).length ?? 0;
  const relevantPendingMatches = (donationPreview?.pendingGiftMatches ?? []).filter((match) => {
    if (!donationPreview?.paymentAssignments.length) return true;
    const paymentFingerprints = new Set(donationPreview.paymentAssignments.map((item) => item.fingerprint));
    return !paymentFingerprints.has(match.fingerprint) || paymentDecisions[match.fingerprint]?.action === "new_gift";
  });
  const unresolvedPendingGifts = relevantPendingMatches.filter((match) => {
    const decision = pendingGiftDecisions[match.fingerprint];
    return !decision || decision.action === "needs_decision" || (decision.action === "merge" && !match.candidates.some((candidate) => candidate.id === decision.pendingGiftId));
  }).length;
  const resolvableReviewRows = donationPreview?.reviewRows.filter((item) => item.resolvable && item.dateIssue === null) ?? [];
  const unresolvedReviewRows = resolvableReviewRows.filter((item) => (reviewDecisions[item.fingerprint]?.action ?? "needs_decision") === "needs_decision").length;
  const dateReviewRows = donationPreview?.reviewRows.filter((item) => item.dateIssue !== null) ?? [];
  const unresolvedDateRows = dateReviewRows.filter((item) => {
    const decision = dateDecisions[item.fingerprint];
    if (!decision || decision.action === "needs_decision") return true;
    // A native <input type="date"> can emit a malformed intermediate value
    // while a user is mid-edit (e.g. a 5-digit year) -- a truthy-only check
    // on correctedDate would wrongly treat that as resolved and let it
    // reach the server, which validates format strictly and rejects the
    // whole commit batch. isDateDecisionComplete applies that same rule
    // here so the row stays flagged until it is genuinely a valid date.
    return !isDateDecisionComplete(decision);
  }).length;
  const reviewableRejectedRows = donationPreview?.rejectedRowDetails.filter((item) => item.severity === "reviewable") ?? [];
  const hardRejectedRows = donationPreview?.rejectedRowDetails.filter((item) => item.severity === "hard") ?? [];
  const resolvedRejectedRows = reviewableRejectedRows.filter((item) => (rejectionDecisions[item.fingerprint]?.action ?? "needs_decision") !== "needs_decision").length;
  const unresolvedRejectedRows = reviewableRejectedRows.length - resolvedRejectedRows;
  const visibleRejectedRows = rejectedRowFilter === "all" ? (donationPreview?.rejectedRowDetails ?? []) : (donationPreview?.rejectedRowDetails ?? []).filter((item) => item.category === rejectedRowFilter);
  const unresolvedMerges = jlPreview?.mergeCandidates.filter((candidate) => !mergeDecisions[candidate.externalId] || mergeDecisions[candidate.externalId].action === "needs_decision").length ?? 0;
  const unresolvedExisting = jlPreview?.existingDonorReviews.filter((donor) => {
    if (mergeDecisions[donor.externalId]?.action === "review_later") return false;
    const decision = existingDonorDecisions[donor.externalId];
    if (!decision || decision.action === "needs_decision") return true;
    if (!["accept_all", "keep_current", "field_by_field"].includes(decision.action)) return true;
    return decision.action === "field_by_field" && donor.comparisons.filter((item) => item.changed).some((change) => (fieldDecisions[`${donor.externalId}:${change.field}`] ?? "needs_decision") === "needs_decision");
  }).length ?? 0;
  const codeCollisions = jlPreview?.codeCollisions.length ?? 0;
  const proposedNewPayments = donationPreview?.paymentAssignments.filter((item) => !item.alreadyApplied && (paymentDecisions[item.fingerprint]?.action === "new_gift" || (paymentAllocations.get(item.fingerprint)?.remainderCents ?? 0) > 0 && paymentAllocations.get(item.fingerprint)?.resolved)).length ?? 0;
  const proposedPledgeUpdates = new Set(donationPreview?.paymentAssignments.filter((item) => !item.alreadyApplied && paymentAllocations.get(item.fingerprint)?.resolved && paymentDecisions[item.fingerprint]?.pledgeId).map((item) => paymentDecisions[item.fingerprint].pledgeId) ?? []).size;
  const crossImportResolvedCount = (donationPreview?.crossImportRows ?? []).filter((item) => (crossImportDecisions[item.fingerprint]?.action ?? "needs_decision") !== "needs_decision").length;
  const draftProgressTotal = resolvableReviewRows.length + dateReviewRows.length + (donationPreview?.crossImportRows.length ?? 0) + reviewableRejectedRows.length;
  const draftProgressResolved = (resolvableReviewRows.length - unresolvedReviewRows) + (dateReviewRows.length - unresolvedDateRows) + crossImportResolvedCount + resolvedRejectedRows;

  // Saves review progress incrementally as the user works, debounced so
  // rapid decision changes do not each fire their own request. Every save
  // also extends the draft's inactivity expiration server-side -- this is
  // what makes an actively reviewed import outlive any fixed TTL.
  useEffect(() => {
    if (step !== "preview" || !previewSessionId || !donationDetected) return;
    if (saveDraftTimeoutRef.current) clearTimeout(saveDraftTimeoutRef.current);
    saveDraftTimeoutRef.current = setTimeout(() => {
      void fetch("/api/import/draft", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previewSessionId,
          decisions: { reviewDecisions, crossImportDecisions, rejectionDecisions, dateDecisions, paymentDecisions, pendingGiftDecisions },
          progressResolved: draftProgressResolved,
          progressTotal: draftProgressTotal,
        }),
      });
    }, 1200);
    return () => { if (saveDraftTimeoutRef.current) clearTimeout(saveDraftTimeoutRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, previewSessionId, donationDetected, reviewDecisions, crossImportDecisions, rejectionDecisions, dateDecisions, paymentDecisions, pendingGiftDecisions]);

  return (
    <main className="import-page">
      <header className="import-header">
        <a href="/" className="import-brand"><span>F</span>Fundraising OS</a>
        <a href="/">Exit import</a>
      </header>
      <div className="import-shell">
        <nav className="import-progress" aria-label="Import progress">
          {["Upload", "Review", "Preview", "Import"].map((label, index) => (
            <span key={label} className={index + 1 < stepNumber ? "done" : index + 1 === stepNumber ? "active" : ""}>
              <b>{index + 1 < stepNumber ? "✓" : index + 1}</b>{label}
            </span>
          ))}
        </nav>

        {step === "upload" && (
          <section className="import-card import-upload-step">
            <p className="eyebrow">IMPORT CENTER</p>
            <h1>Import a JL export.</h1>
            <p className="import-lede">Upload a household or donation export. Fundraising OS identifies the file and takes you directly to the review that matters. Nothing is imported yet.</p>
            <div className="import-center-status" aria-label="Import center status">
              <article><span>Households</span><strong>{dateLabel(refreshOverview.lastHouseholdRefreshAt)}</strong><small>Last refresh</small></article>
              <article><span>Donations</span><strong>{dateLabel(refreshOverview.lastDonationRefreshAt)}</strong><small>Last refresh</small></article>
              <article className={refreshOverview.pendingReviews ? "attention" : ""}><span>Pending reviews</span><strong>{refreshOverview.pendingReviews.toLocaleString()}</strong><small>{refreshOverview.pendingReviews ? "Rows needing a decision" : "Nothing waiting"}</small></article>
              <article><span>Undo available</span><strong>{refreshOverview.undoAvailable.toLocaleString()}</strong><small>{refreshOverview.undoAvailable === 1 ? "Recent import" : "Recent imports"}</small></article>
            </div>
            <section className="import-other-sources" aria-label="Other import sources">
              <div><p className="eyebrow">ALSO AVAILABLE</p><h2>Monday.com Historical Context</h2><p>Bring uncertain historical contact and future planned actions in from a Monday.com pipeline export. Parsed, classified, and committed separately -- nothing here touches JL gifts or pledges.</p></div>
              <a className="onboarding-primary" href="/onboarding/import/monday">Open Monday.com import →</a>
            </section>
            <section className="jl-refresh-overview" aria-label="JL refresh status">
              <div><p className="eyebrow">NEXT REFRESH</p><h2>Use the most recent export you have.</h2><p>Fundraising OS checks overlapping rows, keeps your relationship history, and shows every proposed change before writing.</p></div>
              <dl><div><dt>Households last refreshed</dt><dd>{dateLabel(refreshOverview.lastHouseholdRefreshAt)}</dd></div><div><dt>Donations last refreshed</dt><dd>{dateLabel(refreshOverview.lastDonationRefreshAt)}</dd></div><div><dt>Suggested donation export</dt><dd>{refreshOverview.suggestedRangeStart ? `${dateLabel(refreshOverview.suggestedRangeStart)} – ${dateLabel(refreshOverview.suggestedRangeEnd)}` : `Most recent available range through ${dateLabel(refreshOverview.suggestedRangeEnd)}`}</dd></div></dl>
            </section>
            {resumableDrafts.length > 0 && <section className="resumable-drafts-section" aria-labelledby="resumable-drafts-title">
              <p className="eyebrow">UNFINISHED REVIEW</p>
              <h2 id="resumable-drafts-title">Pick up where you left off</h2>
              <ol className="resumable-drafts-list">{resumableDrafts.map((draft) => (
                <li key={draft.id} className="resumable-draft-row">
                  <div className="resumable-draft-details">
                    <strong>{draft.file_name}</strong>
                    <span>{draft.row_count.toLocaleString()} rows · last worked on {dateLabel(new Date(draft.updated_at * 1000).toISOString())}</span>
                    <span>{draft.progress_total > 0 ? `${draft.progress_resolved.toLocaleString()}/${draft.progress_total.toLocaleString()} rows resolved` : "Review not yet started"}</span>
                  </div>
                  <div className="resumable-draft-actions">
                    <button type="button" className="onboarding-primary" onClick={() => resumeDraft(draft)}>Resume review</button>
                    <button type="button" onClick={() => void discardDraft(draft.id)}>Discard draft</button>
                  </div>
                </li>
              ))}</ol>
            </section>}
            {resumableReviewLater.length > 0 && <section className="resumable-drafts-section review-later-section" aria-labelledby="review-later-title">
              <p className="eyebrow">SAVED FOR LATER REVIEW</p>
              <h2 id="review-later-title">Finish the rows you deferred</h2>
              <p>These imports already completed. Everything else was decided; only the rows below still need a decision.</p>
              <ol className="resumable-drafts-list">{resumableReviewLater.map((session) => (
                <li key={session.id} className="resumable-draft-row">
                  <div className="resumable-draft-details">
                    <strong>{session.file_name}</strong>
                    <span>{session.reviewLaterCount.toLocaleString()} saved for later review · last worked on {dateLabel(new Date(session.updated_at * 1000).toISOString())}</span>
                  </div>
                  <div className="resumable-draft-actions">
                    <button type="button" className="onboarding-primary" onClick={() => resumeDraft(session)}>Resolve now</button>
                    <button type="button" onClick={() => void discardDraft(session.id)}>Dismiss</button>
                  </div>
                </li>
              ))}</ol>
            </section>}
            <div
              className={`import-dropzone ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={dropFile}
            >
              <div className="import-file-icon">⇧</div>
              <strong>Drop either JL export here</strong>
              <p>Household or donation · CSV or Excel (.xlsx), up to 10 MB</p>
              <button type="button" onClick={() => inputRef.current?.click()}>Choose a file</button>
              <input ref={inputRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseFile} hidden />
            </div>
            <p className="import-privacy">Your file is inspected in this browser. It is never sent to an AI provider.</p>
            <section className="jl-import-history"><div><p className="eyebrow">RECENT IMPORTS</p><h2>What changed most recently</h2></div>{refreshOverview.history.length ? <ol>{refreshOverview.history.map((item) => <li key={item.id}><div><strong>{item.kind} · {item.status === "undone" || item.status === "rolled_back" ? "Undone" : item.status === "failed" ? "Needs attention" : "Completed"}</strong><span>{item.fileName}</span><details><summary>Import details</summary><span>Batch ID: <code>{item.id}</code></span></details></div><div><strong>{dateLabel(item.completedAt)}</strong><span>{item.summary}</span>{item.canUndo && item.undoKind && <UndoDonationImport importId={item.id} kind={item.undoKind} />}</div></li>)}</ol> : <p>No imports yet.</p>}</section>
            {statusMessage && <p className="import-status" role="status">{statusMessage}</p>}
            {duplicateBlock && <section className="force-reprocess-warning" role="alert" aria-labelledby="force-reprocess-title">
              <p className="eyebrow">ADMIN FALLBACK</p>
              <h2 id="force-reprocess-title">This identical file is still active.</h2>
              <p>{duplicateBlock.error}</p>
              <p><strong>Force reprocess will rerun every row-level donor, date, amount, fingerprint, and payment-assignment check.</strong> It will not bypass transaction-level duplicate protection or write a duplicate payment.</p>
              {duplicateBlock.canForceReprocess ? <>
                <label>Type <strong>FORCE REPROCESS</strong> to continue<input value={forceConfirmation} onChange={(event) => setForceConfirmation(event.target.value)} autoComplete="off" /></label>
                <button type="button" className="danger" disabled={forceConfirmation !== "FORCE REPROCESS"} onClick={() => void importData(true)}>Force reprocess</button>
              </> : <p>This option is available only to the authenticated workspace import administrator.</p>}
            </section>}
            {error && <p className="onboarding-error" role="alert">{error}</p>}
          </section>
        )}

        {step === "recognition" && (
          <section className="import-card">
            <div className="import-section-heading">
              <div><p className="eyebrow">COLUMN RECOGNITION</p><h1>Here&apos;s what we found.</h1></div>
              <span>{fileName} · {rows.length.toLocaleString()} rows</span>
            </div>
            {jlDetected && !ambiguousType && <div className="jl-detected" role="status"><strong>JL Solutions household export detected.</strong><span>The saved household mapping has been applied automatically.</span></div>}
            {donationDetected && !ambiguousType && <div className="jl-detected" role="status"><strong>JL Solutions donation export detected.</strong><span>Available donation columns were recognized automatically. Missing payment-status fields will be held for review.</span></div>}
            {ambiguousType && <section className="import-fatal-error" role="alert"><strong>This file's type is not clear.</strong><span>{ambiguousType.message}</span></section>}
            <p className="import-lede">High-confidence columns are ready. Review only the ones marked for attention.</p>
            <div className="recognition-list">
              {donationDetected && Object.keys(rows[0] ?? {}).map((column) => <article key={column}><div className="recognition-icon">✓</div><div><strong>{column}</strong><span>99% confidence</span></div><div className="recognized-field"><span>{DONATION_LABELS[column] ?? "Source context"}</span></div></article>)}
              {suggestions.map((suggestion) => {
                const selected = mapping[suggestion.column] ?? "ignore";
                const editing = suggestion.requiresReview || editingColumn === suggestion.column;
                return (
                  <article key={suggestion.column}>
                    <div className={suggestion.requiresReview ? "recognition-icon warning" : "recognition-icon"}>{suggestion.requiresReview ? "!" : "✓"}</div>
                    <div><strong>{suggestion.column}</strong><span>{Math.round(suggestion.confidence * 100)}% confidence</span></div>
                    {editing ? (
                      <select
                        aria-label={`Map ${suggestion.column}`}
                        value={selected}
                        onChange={(event) => setMapping((current) => ({ ...current, [suggestion.column]: event.target.value as ImportField | "ignore" }))}
                      >
                        <option value="ignore">Do not import</option>
                        {fields.map(([field, label]) => <option key={field} value={field}>{label}</option>)}
                      </select>
                    ) : (
                      <div className="recognized-field"><span>{selected === "ignore" ? "Not imported" : FIELD_LABELS[selected]}</span><button type="button" onClick={() => setEditingColumn(suggestion.column)}>Change</button></div>
                    )}
                  </article>
                );
              })}
            </div>
            <div className="import-footer-actions">
              <button type="button" onClick={cancelImport}>Choose another file</button>
              {ambiguousType ? <div className="import-mode" role="group" aria-label="Choose the file type">
                <button type="button" onClick={() => void showPreview("household")} disabled={Boolean(statusMessage)}><strong>It&apos;s a household export</strong><span>Donor contact and household records</span></button>
                <button type="button" onClick={() => void showPreview("donation")} disabled={Boolean(statusMessage)}><strong>It&apos;s a donation export</strong><span>Gifts, pledges, and payments</span></button>
              </div> : <button className="onboarding-primary" type="button" onClick={() => void showPreview()} disabled={Boolean(statusMessage)}>{statusMessage || "Review import preview"}</button>}
            </div>
          </section>
        )}

        {step === "preview" && preview && (
          <section className="import-card">
            <p className="eyebrow">READY FOR REVIEW</p>
            <h1>Your workspace preview</h1>
            <p className="import-lede">This is a preview only. Nothing has been written to Fundraising OS.</p>
            {changedRowsNotice > 0 && <div className="import-rollback-assurance" role="status"><strong>{changedRowsNotice} row{changedRowsNotice === 1 ? "" : "s"} changed since you last reviewed this file.</strong><span>Every other saved decision was restored. The changed rows below need a fresh decision.</span></div>}
            {followUpReview && <div className="import-rollback-assurance" role="status"><strong>This file already imported successfully.</strong><span>Every prior decision is unchanged. Only the rows you saved for later review are shown below needing a decision.</span></div>}
            {donationDetected && donationPreview ? <>
              <p className="jl-export-range">Detected export range: <strong>{donationPreview.rangeStart && donationPreview.rangeEnd ? `${dateLabel(donationPreview.rangeStart)} – ${dateLabel(donationPreview.rangeEnd)}` : "No valid dated rows"}</strong></p>
              <div className="import-counts"><article><strong>{(donationPreview.newActivities + proposedNewPayments).toLocaleString()}</strong><span>new gifts</span></article><article><strong>{(donationPreview.proposedUpdates + proposedPledgeUpdates).toLocaleString()}</strong><span>pledge updates</span></article><article><strong>{donationPreview.alreadyImported.toLocaleString()}</strong><span>existing duplicates</span></article>{donationPreview.reviewRows.length > 0 ? <button type="button" className="import-count-card" onClick={() => document.getElementById("review-queue")?.scrollIntoView({ behavior: "smooth", block: "start" })}><strong>{(donationPreview.needsReview + unresolvedPayments).toLocaleString()}</strong><span>review rows — click to review</span></button> : <article><strong>{(donationPreview.needsReview + unresolvedPayments).toLocaleString()}</strong><span>review rows</span></article>}{donationPreview.rejectedRows > 0 ? <button type="button" className="import-count-card" onClick={() => document.getElementById("rejected-rows-queue")?.scrollIntoView({ behavior: "smooth", block: "start" })}><strong>{donationPreview.rejectedRows.toLocaleString()}</strong><span>rejected rows — click to review</span></button> : <article><strong>{donationPreview.rejectedRows.toLocaleString()}</strong><span>rejected rows</span></article>}</div>
              <div className="import-preview-grid"><section><h2>Ready</h2><p><span>✓</span>Matched by JL Code<b>{donationPreview.matchedRows}</b></p><p><span>✓</span>Open pledges<b>{donationPreview.openPledges}</b></p><p><span>✓</span>Already imported<b>{donationPreview.alreadyImported}</b></p></section><section><h2>Excluded or review</h2><p><span>•</span>Unknown JL Code<b>{donationPreview.unknownHousehold}</b></p><p><span>•</span>Needs review<b>{donationPreview.needsReview + unresolvedPayments}</b></p><p><span>•</span>Suspicious dates<b>{donationPreview.suspiciousDates}</b></p><p><span>•</span>Duplicate source rows<b>{donationPreview.duplicateSourceRows}</b></p><p><span>•</span>Zero-dollar/nonfinancial<b>{donationPreview.nonfinancial}</b></p></section></div>
              {donationPreview.reviewRows.length > 0 && <section className="import-failure-section review-queue-section" id="review-queue" aria-labelledby="review-queue-title">
                <h2 id="review-queue-title">Rows requiring review</h2>
                <p>{unresolvedReviewRows + unresolvedDateRows > 0 ? `${unresolvedReviewRows + unresolvedDateRows} row${unresolvedReviewRows + unresolvedDateRows === 1 ? "" : "s"} still need a decision before you can import.` : "Every reviewable row has a decision."}</p>
                <ol className="review-queue-list">{donationPreview.reviewRows.map((item) => {
                  const decision = reviewDecisions[item.fingerprint] ?? { action: "needs_decision" as const };
                  const dateDecision = dateDecisions[item.fingerprint] ?? { action: "needs_decision" as const };
                  const groupMembers = item.duplicateGroupKey ? donationPreview.reviewRows.filter((other) => other.duplicateGroupKey === item.duplicateGroupKey) : [];
                  return (
                    <li key={item.fingerprint} className="review-queue-row">
                      <div className="review-queue-row-details">
                        <strong>Row {item.row}</strong>
                        <span>{item.donor ?? "Unknown donor"}{item.jlCode ? ` · JL ${item.jlCode}` : ""}{item.transactionType ? ` · ${item.transactionType}` : ""}{item.campaign ? ` · ${item.campaign}` : ""}</span>
                        <span>{epochDateLabel(item.date)} · {centsLabel(item.amountCents)}</span>
                        <span className="review-queue-reason">{item.reason}</span>
                        {item.dateIssue !== null && item.originalDateValue && <span className="review-queue-match">Original source date: &quot;{item.originalDateValue}&quot;</span>}
                        {item.duplicateGroupSize > 1 && <span className="review-queue-match"><em className="review-queue-badge">Duplicate within this file</em> Appears {item.duplicateGroupSize} times in this file with a matching donor, date, campaign, and amount.</span>}
                      </div>
                      {item.dateIssue !== null ? (
                        <div className="review-queue-actions date-review-actions">
                          <em className="review-queue-badge date-issue-badge">{item.dateIssue === "invalid" ? "Invalid / missing date" : "Suspicious date"}</em>
                          <select aria-label={`Date decision for row ${item.row}`} value={dateDecision.action} onChange={(event) => setDateDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value as DateReviewAction, correctedDate: current[item.fingerprint]?.correctedDate } }))}>
                            <option value="needs_decision" disabled>Choose an action</option>
                            {item.dateIssue === "suspicious" && <option value="accept_as_is">Accept date as-is</option>}
                            <option value="correct_date">Correct date</option>
                            <option value="skip">Skip</option>
                            <option value="review_later">Review later</option>
                          </select>
                          {dateDecision.action === "correct_date" && <input type="date" aria-label={`Corrected date for row ${item.row}`} value={dateDecision.correctedDate ?? ""} onChange={(event) => setDateDecisions((current) => ({ ...current, [item.fingerprint]: { action: "correct_date", correctedDate: event.target.value } }))} />}
                        </div>
                      ) : item.resolvable ? <div className="review-queue-actions">
                        <select aria-label={`Review decision for row ${item.row}`} value={decision.action} onChange={(event) => setReviewDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value as ReviewDecisionAction } }))}>
                          <option value="needs_decision" disabled>Choose an action</option>
                          <option value="import_anyway">Import anyway</option>
                          <option value="skip">Skip</option>
                          <option value="review_later">Review later</option>
                        </select>
                        {groupMembers.length > 1 && decision.action !== "needs_decision" && <button type="button" onClick={() => setReviewDecisions((current) => ({ ...current, ...Object.fromEntries(groupMembers.map((member) => [member.fingerprint, { action: decision.action }])) }))}>Apply to all {groupMembers.length} rows in this group</button>}
                      </div> : <p className="payment-review-note">This row cannot be imported until the underlying issue is corrected in the source file.</p>}
                    </li>
                  );
                })}</ol>
                <button type="button" onClick={() => downloadRows(donationPreview.reviewRows, fileHash.slice(0, 12), "review")}>Download review report CSV</button>
              </section>}
              {donationPreview.crossImportRows.length > 0 && <section className="import-failure-section review-queue-section cross-import-section" id="cross-import-queue" aria-labelledby="cross-import-queue-title">
                <h2 id="cross-import-queue-title">Already exists in Fundraising OS</h2>
                <p>These rows are not repeated within this file — each one matches a gift already imported in a previous upload. By default, none of them will be imported again.</p>
                <ol className="review-queue-list">{donationPreview.crossImportRows.map((item) => {
                  const decision = crossImportDecisions[item.fingerprint] ?? { action: "needs_decision" as const };
                  return (
                    <li key={item.fingerprint} className="review-queue-row">
                      <div className="review-queue-row-details">
                        <em className="review-queue-badge cross-import-badge">{item.matchType === "confirmed_duplicate" ? "Confirmed duplicate" : "Possible duplicate"}</em>
                        <strong>{item.row ? `Row ${item.row}` : "This row"}</strong>
                        <span>{item.donor ?? "Unknown donor"}{item.jlCode ? ` · JL ${item.jlCode}` : ""}{item.campaign ? ` · ${item.campaign}` : ""}</span>
                        <span>{epochDateLabel(item.date)} · {centsLabel(item.amountCents)}</span>
                        <span className="review-queue-reason">{item.reason}</span>
                        <span className="review-queue-match">Existing gift: {epochDateLabel(item.existingActivityDate)} · {centsLabel(item.existingAmountCents)}{item.existingCampaign ? ` · ${item.existingCampaign}` : ""} · imported {dateLabel(new Date(item.existingImportedAt * 1000).toISOString())}</span>
                      </div>
                      <div className="review-queue-actions">
                        <select aria-label="Cross-import duplicate decision" value={decision.action} onChange={(event) => setCrossImportDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value as ReviewDecisionAction } }))}>
                          <option value="needs_decision">Skip (default)</option>
                          <option value="import_anyway">Import anyway</option>
                          <option value="skip">Skip</option>
                          <option value="review_later">Review later</option>
                        </select>
                      </div>
                    </li>
                  );
                })}</ol>
              </section>}
              {donationPreview.rejectedRowDetails.length > 0 && <section className="import-failure-section review-queue-section rejected-rows-section" id="rejected-rows-queue" aria-labelledby="rejected-rows-queue-title">
                <h2 id="rejected-rows-queue-title">Rejected rows</h2>
                <div className="rejected-rows-counts">
                  <span>Hard rejected <b>{hardRejectedRows.length}</b></span>
                  <span>Reviewable <b>{reviewableRejectedRows.length}</b></span>
                  <span>Resolved <b>{resolvedRejectedRows}</b></span>
                  <span>Unresolved <b>{unresolvedRejectedRows}</b></span>
                </div>
                <p>{unresolvedRejectedRows > 0 ? `${unresolvedRejectedRows} rejected row${unresolvedRejectedRows === 1 ? "" : "s"} still need a decision before you can import.` : "Every reviewable rejected row has a decision."}</p>
                <label className="rejected-rows-filter"><span>Filter by reason</span>
                  <select value={rejectedRowFilter} onChange={(event) => setRejectedRowFilter(event.target.value as RejectedRowCategory | "all")}>
                    <option value="all">All reasons</option>
                    {(Object.entries(REJECTED_ROW_CATEGORY_LABELS) as Array<[RejectedRowCategory, string]>).map(([category, label]) => <option key={category} value={category}>{label}</option>)}
                  </select>
                </label>
                <div className="rejected-rows-bulk-actions">{(["unmatched_jl_code", "nonfinancial_entry"] as const).filter((category) => (rejectedRowFilter === "all" || rejectedRowFilter === category) && donationPreview.rejectedRowDetails.some((item) => item.category === category)).map((category) => {
                  const rowsInCategory = donationPreview.rejectedRowDetails.filter((item) => item.category === category);
                  return (
                    <div key={category} className="rejected-rows-bulk-group">
                      <span>{REJECTED_ROW_CATEGORY_LABELS[category]} ({rowsInCategory.length})</span>
                      <button type="button" onClick={() => setRejectionDecisions((current) => ({ ...current, ...Object.fromEntries(rowsInCategory.map((row) => [row.fingerprint, { action: "skip" as const }])) }))}>Skip all</button>
                      <button type="button" onClick={() => setRejectionDecisions((current) => ({ ...current, ...Object.fromEntries(rowsInCategory.map((row) => [row.fingerprint, { action: "review_later" as const }])) }))}>Review later, all</button>
                      {category === "nonfinancial_entry" && <button type="button" onClick={() => setRejectionDecisions((current) => ({ ...current, ...Object.fromEntries(rowsInCategory.map((row) => [row.fingerprint, { action: "import_anyway" as const }])) }))}>Import anyway, all</button>}
                    </div>
                  );
                })}</div>
                <ol className="review-queue-list">{visibleRejectedRows.map((item) => {
                  const decision = rejectionDecisions[item.fingerprint] ?? { action: "needs_decision" as const };
                  return (
                    <li key={item.fingerprint} className="review-queue-row">
                      <div className="review-queue-row-details">
                        <em className={item.severity === "hard" ? "review-queue-badge" : "review-queue-badge cross-import-badge"}>{item.severity === "hard" ? "Hard rejection" : "Reviewable"}</em>
                        <strong>Row {item.row}</strong>
                        <span>{item.donor ?? "Unknown donor"}{item.jlCode ? ` · JL ${item.jlCode}` : ""}{item.campaign ? ` · ${item.campaign}` : ""}</span>
                        <span>{epochDateLabel(item.date)} · {centsLabel(item.amountCents)}</span>
                        <span className="review-queue-reason">{item.reason}</span>
                        {item.existingMatchRow !== null && <span className="review-queue-match">Matches row {item.existingMatchRow} earlier in this same file.</span>}
                      </div>
                      {item.severity === "hard" ? <p className="payment-review-note">This row cannot be imported until the underlying issue is corrected in the source file.</p> : item.category === "unmatched_jl_code" ? (
                        <div className="review-queue-actions rejected-row-correction">
                          <input type="text" placeholder="Correct JL Code" aria-label={`Corrected JL Code for row ${item.row}`} value={decision.correctedJlCode ?? ""} onChange={(event) => setRejectionDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value.trim() ? "match_donor" : "needs_decision", correctedJlCode: event.target.value } }))} />
                          <select aria-label={`Rejected row decision for row ${item.row}`} value={decision.action} onChange={(event) => setRejectionDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value as RejectionDecisionAction, correctedJlCode: current[item.fingerprint]?.correctedJlCode } }))}>
                            <option value="needs_decision" disabled>Choose an action</option>
                            <option value="match_donor">Match donor with corrected code</option>
                            <option value="skip">Skip</option>
                            <option value="review_later">Review later</option>
                          </select>
                        </div>
                      ) : (
                        <div className="review-queue-actions">
                          <select aria-label={`Rejected row decision for row ${item.row}`} value={decision.action} onChange={(event) => setRejectionDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value as RejectionDecisionAction } }))}>
                            <option value="needs_decision" disabled>Choose an action</option>
                            <option value="import_anyway">Import anyway</option>
                            <option value="skip">Skip</option>
                            <option value="review_later">Review later</option>
                          </select>
                        </div>
                      )}
                    </li>
                  );
                })}</ol>
              </section>}
              {donationPreview.paymentAssignments.length > 0 && <section className="payment-assignment-section" aria-labelledby="payment-assignment-title">
                <div><p className="eyebrow">MANUAL PAYMENT ASSIGNMENT</p><h2 id="payment-assignment-title">Decide how each payment should be recorded.</h2><p>Nothing is assigned automatically. Review every proposed change before importing.</p></div>
                <div className="payment-assignment-list">{donationPreview.paymentAssignments.map((item) => {
                  const decision = paymentDecisions[item.fingerprint] ?? { action: item.action, pledgeId: item.pledgeId, overpaymentAction: null };
                  const invalid = Boolean(item.reason && !item.reason.startsWith("Choose whether") && !item.alreadyApplied);
                  const selectedPledge = item.openPledges.find((pledge) => pledge.id === decision.pledgeId);
                  const allocation = paymentAllocations.get(item.fingerprint);
                  return <article className="payment-assignment-card" key={item.fingerprint}>
                    <header><div><strong>{item.donorName}</strong><span>Row {item.row} · {epochDateLabel(item.paymentDate)} · {item.campaign || "No campaign"}</span></div><b>{centsLabel(item.amountCents)}</b></header>
                    {item.alreadyApplied ? <p className="payment-remembered">Already processed: {item.action === "apply_to_pledge" ? "applied to the saved pledge" : "recorded as a new gift"}. It will not be counted again.</p> : <>
                      <label><span>Classify payment</span><select aria-label={`Classify payment for row ${item.row}`} value={decision.action} disabled={invalid} onChange={(event) => setPaymentDecisions((current) => ({ ...current, [item.fingerprint]: { action: event.target.value as "apply_to_pledge" | "new_gift" | "needs_review", pledgeId: null, overpaymentAction: null } }))}><option value="needs_review">Needs review</option><option value="apply_to_pledge" disabled={!item.openPledges.length}>Apply to open pledge</option><option value="new_gift">New gift/payment</option></select></label>
                      {invalid && <p className="onboarding-error">{item.reason}</p>}
                      {decision.action === "apply_to_pledge" && item.openPledges.length > 0 && <fieldset className="open-pledge-options" aria-required="true"><legend>Select any open pledge for this donor <span>Required</span></legend><p>Campaign, description, date, item number, amount, and automatic-match confidence do not hide pledge choices.</p>{item.openPledges.map((pledge) => <label key={pledge.id} className={decision.pledgeId === pledge.id ? "selected" : ""}><input type="radio" name={`pledge-${item.fingerprint}`} required checked={decision.pledgeId === pledge.id} onChange={() => setPaymentDecisions((current) => ({ ...current, [item.fingerprint]: { action: "apply_to_pledge", pledgeId: pledge.id, overpaymentAction: null } }))}/><span><strong>{epochDateLabel(pledge.activity_date)} · {pledge.description || "Open pledge"}</strong><small>Original {centsLabel(pledge.committed_cents)} · Paid {centsLabel(pledge.paid_cents)} · Remaining balance {centsLabel(pledge.balance_cents)} · Campaign {pledge.source_campaign || "Not recorded"}</small></span></label>)}</fieldset>}
                      {decision.action === "apply_to_pledge" && !item.openPledges.length && <p className="payment-review-note">This donor has no open pledges available.</p>}
                      {decision.action === "new_gift" && <p className="payment-proposal">Proposed change: create one separate paid gift for {centsLabel(item.amountCents)}.</p>}
                      {decision.action === "apply_to_pledge" && selectedPledge && allocation && allocation.remainderCents > 0 && <fieldset className="overpayment-options"><legend>Payment exceeds the available pledge balance by {centsLabel(allocation.remainderCents)}. Choose what to do.</legend><button type="button" className={decision.overpaymentAction === "split_remainder_new_gift" ? "selected" : ""} onClick={() => setPaymentDecisions((current) => ({ ...current, [item.fingerprint]: { ...decision, overpaymentAction: "split_remainder_new_gift" } }))}>Apply {centsLabel(allocation.appliedCents)} to pledge and treat {centsLabel(allocation.remainderCents)} as a new gift</button><button type="button" onClick={() => setPaymentDecisions((current) => ({ ...current, [item.fingerprint]: { action: "apply_to_pledge", pledgeId: null, overpaymentAction: null } }))}>Choose another pledge</button><button type="button" onClick={() => setPaymentDecisions((current) => ({ ...current, [item.fingerprint]: { action: "needs_review", pledgeId: null, overpaymentAction: null } }))}>Return to review</button></fieldset>}
                      {decision.action === "apply_to_pledge" && selectedPledge && allocation?.resolved && <p className="payment-proposal">Proposed change: apply {centsLabel(allocation.appliedCents)} to this pledge. Paid amount: {centsLabel(selectedPledge.paid_cents + allocation.priorAllocatedCents + allocation.appliedCents)}. New balance: {centsLabel(selectedPledge.balance_cents - allocation.priorAllocatedCents - allocation.appliedCents)}. Resulting status: {allocation.priorAllocatedCents + allocation.appliedCents === selectedPledge.balance_cents ? "Fulfilled" : "Partially paid"}.{allocation.remainderCents > 0 ? ` Create one separate gift for the ${centsLabel(allocation.remainderCents)} remainder.` : " No duplicate gift will be created."}</p>}
                      {decision.action === "needs_review" && !invalid && <p className="payment-review-note">{item.reason}</p>}
                    </>}
                  </article>;
                })}</div>
              </section>}
              {relevantPendingMatches.length > 0 && <section className="payment-assignment-section pending-gift-match-section" aria-labelledby="pending-gift-match-title">
                <div><p className="eyebrow">PENDING GIFT MATCHES</p><h2 id="pending-gift-match-title">Confirm whether these JL gifts replace pending entries.</h2><p>A possible match is never merged automatically. Choose the pending entry to confirm, or keep both records separate.</p></div>
                <div className="payment-assignment-list">{relevantPendingMatches.map((match) => {
                  const decision = pendingGiftDecisions[match.fingerprint] ?? { action: "needs_decision" as const, pendingGiftId: null };
                  return <article className="payment-assignment-card" key={match.fingerprint}>
                    <label><span>Pending gift decision</span><select required aria-label="Pending gift match decision" value={decision.action === "merge" ? decision.pendingGiftId ?? "needs_decision" : decision.action} onChange={(event) => {
                      const value = event.target.value;
                      setPendingGiftDecisions((current) => ({ ...current, [match.fingerprint]: value === "keep_separate" ? { action: "keep_separate", pendingGiftId: null } : value === "needs_decision" ? { action: "needs_decision", pendingGiftId: null } : { action: "merge", pendingGiftId: value } }));
                    }}><option value="needs_decision" disabled>Choose what to do</option>{match.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>Confirm pending gift from {epochDateLabel(candidate.activityDate)} · {centsLabel(candidate.amountCents)}{candidate.designation ? ` · ${candidate.designation}` : ""}</option>)}<option value="keep_separate">Keep as separate gifts</option></select></label>
                    {decision.action === "merge" && <p className="payment-proposal">The selected pending entry will be marked confirmed and excluded from totals; the imported JL record becomes the counted gift. No amount is double-counted.</p>}
                    {decision.action === "keep_separate" && <p className="payment-review-note">Both records will remain. The pending entry stays unconfirmed and excluded from totals.</p>}
                  </article>;
                })}</div>
              </section>}
              <p className="import-privacy">Paid totals use Paid. Commitments use Amount. Open balances use Balance Due. Nothing has been written yet.</p>
            </> : <div className="import-counts">
              <article><strong>{preview.donors.length.toLocaleString()}</strong><span>{jlDetected ? "households" : "donors"}</span></article>
              <article><strong>{preview.gifts.length.toLocaleString()}</strong><span>gifts</span></article>
              <article><strong>{preview.interactions.length.toLocaleString()}</strong><span>interactions</span></article>
              <article><strong>{preview.reminders.length.toLocaleString()}</strong><span>reminders</span></article>
            </div>}
            {jlDetected && jlPreview && <>
              <div className="import-mode" role="group" aria-label="JL import mode">
                <button type="button" className={mode === "first" ? "active" : ""} onClick={() => setMode("first")}><strong>First Import</strong><span>Add new households only</span></button>
                <button type="button" className={mode === "refresh" ? "active" : ""} onClick={() => setMode("refresh")}><strong>Refresh From JL Solutions</strong><span>Add new and safely update contact details</span></button>
              </div>
              <div className="jl-preview-counts">
                <p><strong>{jlPreview.newRelationships}</strong> new relationships</p>
                <p><strong>{jlPreview.existingRelationships}</strong> matched by JL Code</p>
                <p><strong>{jlPreview.recordsWithUpdates}</strong> with contact updates</p>
                <p><strong>{jlPreview.duplicateRows}</strong> duplicates</p>
                <p><strong>{jlPreview.conflicts.length}</strong> conflicts</p>
                <p><strong>{jlPreview.rejectedRows}</strong> rejected rows</p>
              </div>
              <section className="existing-donor-review" aria-labelledby="existing-review-title"><header><div><p className="eyebrow">ACTIVE IMPORT REVIEW MODE</p><h2 id="existing-review-title">{REVIEW_MODE_COPY[reviewMode].label}</h2><p>{REVIEW_MODE_COPY[reviewMode].description}</p></div><a href="/settings">Change in Settings</a></header>{jlPreview.existingDonorReviews.length === 0 ? <p className="import-preservation-note">No existing donors require review in this file.</p> : jlPreview.existingDonorReviews.map((donor) => { const decision = existingDonorDecisions[donor.externalId] ?? { action: "needs_decision" as const, signature: donor.signature }; const changedFields = donor.comparisons.filter((item) => item.changed); const deferred = mergeDecisions[donor.externalId]?.action === "review_later"; return <article key={donor.externalId} className="existing-review-card"><div className="existing-review-heading"><div><strong>{donor.donorName}</strong><small>JL {donor.externalId}</small></div><span className={donor.changed ? "changed" : "unchanged"}>{donor.changed ? `${changedFields.length} change${changedFields.length === 1 ? "" : "s"}` : "No changes detected"}</span></div>{deferred ? <p>This household is marked Review later, so nothing for it will be written.</p> : <><label className="existing-review-action"><span>{donor.changed ? "How should these values be handled?" : "Confirm this existing donor"}</span><select required aria-label={`Review action for JL ${donor.externalId}`} value={decision.action} onChange={(event) => setExistingDonorDecisions((current) => ({ ...current, [donor.externalId]: { action: event.target.value as ExistingDecisionAction, signature: donor.signature } }))}><option value="needs_decision" disabled>Choose an action</option><option value="accept_all">Accept JL values</option><option value="keep_current">Keep current values</option><option value="field_by_field">Review field-by-field</option></select></label>{donor.changed && <div className="existing-review-fields">{changedFields.map((change) => { const key = `${donor.externalId}:${change.field}`; return <div key={key}><span>{change.field.replaceAll("_", " ")}{change.requiresDecision && <em>Local override</em>}</span><small><b>Current</b> {change.currentValue || "Blank"}</small><small><b>JL</b> {change.jlValue || "Blank"}</small>{decision.action === "field_by_field" && <select required aria-label={`Field decision for ${change.field} on JL ${donor.externalId}`} value={fieldDecisions[key] ?? "needs_decision"} onChange={(event) => setFieldDecisions((current) => ({ ...current, [key]: event.target.value as FieldDecision }))}><option value="needs_decision" disabled>Choose a value</option><option value="keep_local">Keep current</option><option value="use_jl">Use JL</option></select>}</div>; })}</div>}</>}<details><summary>Compare all current and incoming values</summary><div className="existing-review-fields">{donor.comparisons.map((item) => <div key={item.field}><span>{item.field.replaceAll("_", " ")}</span><small><b>Current</b> {item.currentValue || "Blank"}</small><small><b>JL</b> {item.jlValue || "Blank"}</small></div>)}</div></details></article>; })}<p className="import-privacy">Your choices are rechecked against the current donor record at confirmation and saved in the import audit.</p></section>
              {jlPreview.codeCollisions.length > 0 && <section className="import-fatal-error" role="alert"><strong>Duplicate JL Code must be resolved first</strong><span>{jlPreview.codeCollisions.map((collision) => `JL ${collision.externalId} is attached to ${collision.donorIds.length} active donors`).join("; ")}. No households will be written until these records are resolved.</span></section>}
              {jlPreview.mergeCandidates.length > 0 && <section className="jl-merge-candidates"><h2>Possible manual donor matches</h2><p>These are suggestions only. Fundraising OS will never merge or add a likely duplicate without your decision.</p>{jlPreview.mergeCandidates.map((candidate) => { const decision = mergeDecisions[candidate.externalId] ?? { action: "needs_decision", manualDonorId: candidate.manualDonorId }; return <article key={candidate.externalId}><div><strong>{candidate.jlName} <small>JL {candidate.externalId}</small></strong><span>Possible match: {candidate.manualName}</span><small>{candidate.reasons.join(" · ")}</small>{candidate.exactCodeMatch && <small>This JL Code already belongs to the possible match, so it cannot remain separate.</small>}</div><label><span>Resolve Duplicate</span><select required aria-label={`Merge decision for JL ${candidate.externalId}`} value={decision.action} onChange={(event) => setMergeDecisions((current) => ({ ...current, [candidate.externalId]: { action: event.target.value as MergeDecision["action"], manualDonorId: candidate.manualDonorId } }))}><option value="needs_decision" disabled>Choose a decision</option><option value="merge">Resolve duplicate and preserve history</option><option value="keep_separate" disabled={candidate.exactCodeMatch}>Keep as separate donors</option><option value="review_later">Review later — do not import this household</option></select></label></article>; })}<p className="import-privacy">Resolving keeps the manual donor&apos;s internal ID, interactions, reminders, notes, and history. Review later leaves the database unchanged for that JL household. You can change this decision until import confirmation.</p></section>}
              <section className="import-preview-grid" aria-label="Proposed household changes"><h2>Before you confirm</h2><p><span>✓</span>Households to update<b>{jlPreview.recordsWithUpdates}</b></p><p><span>✓</span>Duplicates to merge<b>{Object.values(mergeDecisions).filter((decision) => decision.action === "merge").length}</b></p><p><span>•</span>Kept separate<b>{Object.values(mergeDecisions).filter((decision) => decision.action === "keep_separate").length}</b></p><p><span>•</span>Review later (not written)<b>{Object.values(mergeDecisions).filter((decision) => decision.action === "review_later").length}</b></p></section>
            </>}
            {!donationDetected && <div className="import-preview-grid">
              <section><h2>Detected</h2>{[
                ["Donors", preview.donors.length], ["Gifts", preview.gifts.length], ["Interactions", preview.interactions.length], ["Reminders", preview.reminders.length],
              ].map(([label, count]) => <p key={String(label)}><span>✓</span>{label}<b>{count}</b></p>)}</section>
              <section><h2>Warnings</h2>{preview.warnings.length ? preview.warnings.map((warning) => <p key={warning}><span>•</span>{warning}</p>) : <p><span>✓</span>No blocking issues found</p>}</section>
            </div>}
            {!jlDetected && !donationDetected && <label className="update-existing-option">
              <input type="checkbox" checked={updateExisting} onChange={(event) => setUpdateExisting(event.target.checked)} />
              <span><strong>Update Existing Records</strong><small>Off by default. Existing donor contact information will otherwise remain unchanged.</small></span>
            </label>}
            <div className="import-backup-note"><span>↓</span><div><strong>Want a safety copy first?</strong><p>Download the current D1 workspace before your first import.</p></div><a href="/api/import/backup">Download backup</a></div>
            {error && <p className="onboarding-error" role="alert">{error}</p>}
            <div className="import-footer-actions">
              <button type="button" onClick={cancelImport}>Cancel import</button>
              <button type="button" onClick={() => setStep("recognition")}>Review column setup</button>
              {!duplicateBlock && <button className="onboarding-primary" type="button" onClick={() => void importData()} disabled={unresolvedPayments + unresolvedPendingGifts + unresolvedReviewRows + unresolvedRejectedRows + unresolvedDateRows + unresolvedMerges + unresolvedExisting + codeCollisions > 0}>{codeCollisions > 0 ? "Resolve duplicate JL Codes" : unresolvedExisting > 0 ? `Review ${unresolvedExisting} existing donor${unresolvedExisting === 1 ? "" : "s"}` : unresolvedPayments > 0 ? `Review ${unresolvedPayments} payment${unresolvedPayments === 1 ? "" : "s"}` : unresolvedPendingGifts > 0 ? `Review ${unresolvedPendingGifts} pending gift match${unresolvedPendingGifts === 1 ? "" : "es"}` : unresolvedDateRows > 0 ? `Review ${unresolvedDateRows} flagged date${unresolvedDateRows === 1 ? "" : "s"}` : unresolvedReviewRows > 0 ? `Review ${unresolvedReviewRows} possible duplicate row${unresolvedReviewRows === 1 ? "" : "s"}` : unresolvedRejectedRows > 0 ? `Review ${unresolvedRejectedRows} rejected row${unresolvedRejectedRows === 1 ? "" : "s"}` : unresolvedMerges > 0 ? `Review ${unresolvedMerges} possible match${unresolvedMerges === 1 ? "" : "es"}` : "Confirm and import"}</button>}
            </div>
          </section>
        )}

        {step === "importing" && (
          <section className="import-card import-processing" aria-live="polite">
            <span className="assistant-result-spinner" />
            <h1>Preparing your workspace…</h1>
            <p>Your validated records are being imported together. If anything fails, no records will be kept.</p>
          </section>
        )}

        {step === "failed" && failureReport && (
          <section className="import-card import-failed" aria-labelledby="import-failed-title">
            <div className="import-failure-mark" aria-hidden="true">!</div>
            <p className="eyebrow">{failureReport.outcomeStatus === "processing" ? "IMPORT STILL PROCESSING" : failureReport.outcomeStatus === "unknown" ? "OUTCOME UNKNOWN" : "IMPORT NOT COMPLETED"}</p>
            <h1 id="import-failed-title">{failureReport.outcomeStatus === "processing" ? "This import hasn't finished yet." : failureReport.outcomeStatus === "unknown" ? "We couldn't confirm what happened." : "We couldn't import this file."}</h1>
            <p className="import-lede">{failureReport.error}</p>
            {failureReport.outcomeStatus === "processing" ? (
              <div className="import-rollback-assurance" role="status">
                <strong>This import may still be running on the server.</strong>
                <span>Wait a moment, then check your recent imports before trying again. Resubmitting now could start a second attempt while this one is still working.</span>
              </div>
            ) : failureReport.outcomeStatus === "unknown" ? (
              <div className="import-fatal-error" role="alert">
                <strong>We could not confirm whether this import wrote anything.</strong>
                <span>Do not retry blindly. Check your recent imports (or ask an administrator to check Worker logs) before importing this file again.</span>
              </div>
            ) : (
              <div className="import-rollback-assurance" role="status">
                <strong>No changes were made to the database.</strong>
                <span>The donation transaction was rolled back as one unit, so no partial data was kept.</span>
              </div>
            )}
            <div className="import-result-counts">
              <article><strong>{failureReport.results.validRows.toLocaleString()}</strong><span>valid rows</span></article>
              <article><strong>{failureReport.results.giftsImported.toLocaleString()}</strong><span>imported rows</span></article>
              <article><strong>{failureReport.results.giftsUpdated.toLocaleString()}</strong><span>updated rows</span></article>
              <article><strong>{failureReport.results.duplicateRowsSkipped.toLocaleString()}</strong><span>duplicates skipped</span></article>
              <article><strong>{failureReport.results.rowsRequiringReview.toLocaleString()}</strong><span>review rows</span></article>
              <article><strong>{failureReport.results.rejectedRows.toLocaleString()}</strong><span>rejected rows</span></article>
              <article><strong>{failureReport.results.unmatchedJlCodes.toLocaleString()}</strong><span>unmatched JL Codes</span></article>
            </div>
            {failureReport.fatalError && <div className="import-fatal-error" role="alert"><strong>Fatal error</strong><span>{failureReport.fatalError}</span></div>}
            <section className="import-failure-section">
              <h2>Why the import stopped</h2>
              <ul className="import-failure-causes">
                {failureReport.rollbackCauses.map((cause) => <li key={cause}>{FAILURE_LABELS[cause]}</li>)}
              </ul>
            </section>
            <section className="import-failure-section">
              <h2>First errors</h2>
              <ol className="import-failure-errors">
                {failureReport.validation.firstErrors.slice(0, 8).map((item, index) => (
                  <li key={`${item.row}-${item.category}-${index}`}><strong>{item.row > 0 ? `Row ${item.row}` : "Import"}</strong><span>{item.reason}</span></li>
                ))}
              </ol>
            </section>
            <div className="import-report-actions">
              <button type="button" onClick={() => downloadRows(failureReport.reviewRows ?? [], failureReport.importId ?? "validation", "review")} disabled={!failureReport.reviewRows?.length}>Download review report CSV</button>
              <button type="button" onClick={() => downloadRows(failureReport.rejectedRows, failureReport.importId ?? "validation", "rejected")} disabled={!failureReport.rejectedRows.length}>Download rejected rows CSV</button>
              <button type="button" onClick={() => download(`fundraising-os-validation-${failureReport.importId ?? "report"}.json`, JSON.stringify({ fileName, generatedAt: new Date().toISOString(), ...failureReport }, null, 2))}>Download validation report</button>
            </div>
            <div className="import-footer-actions">
              <button type="button" onClick={cancelImport}>Choose another file</button>
              <button className="onboarding-primary" type="button" onClick={() => { setFailureReport(null); setStep("preview"); }}>Back to preview</button>
            </div>
          </section>
        )}

        {step === "complete" && report && (
          <section className="import-card import-complete">
            <div className={report.reviewOnly ? "import-failure-mark" : "import-success-mark"}>{report.reviewOnly ? "!" : "✓"}</div>
            <p className="eyebrow">{report.reviewOnly ? "REVIEW NEEDED" : "IMPORT COMPLETE"}</p>
            <h1>{report.reviewOnly ? "No rows were imported." : "Your workspace is ready."}</h1>
            {report.reviewOnly ? <div className="import-rollback-assurance" role="status"><strong>{report.message}</strong><span>No changes were made to the database. Correct the column setup or source classifications, then retry.</span></div> : report.noChangesMade && <div className="import-rollback-assurance"><strong>Your workspace was already current.</strong><span>No gifts or households were duplicated.</span></div>}
            {!report.reviewOnly && <p className="import-lede">{report.profile === "JL Solutions Donations" ? `${report.donation?.newActivities ?? 0} new giving activities and ${report.donation?.updatedPledges ?? 0} pledge updates were processed.` : `${report.imported.donors} donors, ${report.imported.gifts} gifts, ${report.imported.interactions} interactions, and ${report.imported.reminders} reminders were processed.`}</p>}
            {report.household && <div className="import-result-counts import-success-counts"><article><strong>{report.household.updated}</strong><span>households updated</span></article><article><strong>{report.household.merged}</strong><span>duplicates merged</span></article><article><strong>{report.household.created}</strong><span>new households</span></article><article><strong>{report.household.reviewLater}</strong><span>left for later review</span></article></div>}
            {report.reviewOnly && report.reviewRows?.length ? <section className="import-failure-section"><h2>Why each row requires review</h2><ol className="import-failure-errors">{report.reviewRows.slice(0, 8).map((item) => <li key={item.row}><strong>Row {item.row}</strong><span>{item.reason}</span></li>)}</ol></section> : null}
            {report.refresh && <p className="import-preservation-note">Historical gifts were not deleted. Fundraising OS interactions, reminders, notes, summaries, and institutional memory were preserved.</p>}
            {report.warnings.length > 0 && <ul className="import-complete-warnings">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            {!report.reviewOnly && (report.results?.rowsRequiringReview ?? 0) > 0 && <div className="import-rollback-assurance" role="alert"><strong>{report.results!.rowsRequiringReview.toLocaleString()} row{report.results!.rowsRequiringReview === 1 ? "" : "s"} could not be resolved at all.</strong><span>These rows have no decision to make in this workflow (e.g. a missing JL Code or an unreadable amount) -- they require a corrected source file, not further review here.</span></div>}
            {report.results && (() => {
              const skippedRows = (report.reviewRows ?? []).filter((row) => row.disposition === "skipped");
              const reviewLaterRows = (report.reviewRows ?? []).filter((row) => row.disposition === "review_later");
              const unresolvedRows = (report.reviewRows ?? []).filter((row) => row.disposition === "unresolved");
              const rejectedRowDetails: RowFailure[] = (report.rejectedRowDetails ?? []).map((item) => ({ row: item.row, fingerprint: item.fingerprint, reason: item.reason, donor: item.donor, jlCode: item.jlCode, campaign: item.campaign, date: item.date, amountCents: item.amountCents }));
              const countCard = (count: number, label: string, description: string, rows: RowFailure[]) => (
                count > 0
                  ? <button type="button" className="import-count-card" onClick={() => setRowDrillDown({ title: label, description, rows })}><strong>{count.toLocaleString()}</strong><span>{label} — click to view</span></button>
                  : <article><strong>0</strong><span>{label}</span></article>
              );
              return <>
                <div className="import-result-counts import-success-counts">
                  <article><strong>{report.results.giftsImported.toLocaleString()}</strong><span>gifts imported</span></article>
                  <article><strong>{report.results.giftsUpdated.toLocaleString()}</strong><span>gifts updated</span></article>
                  <article><strong>{report.results.householdsMatched.toLocaleString()}</strong><span>households matched</span></article>
                  {countCard(skippedRows.length, "skipped by you", "You chose not to import these rows.", skippedRows)}
                  {countCard(reviewLaterRows.length, "saved for later review", "You chose to decide these later. They remain resumable from the Import Center.", reviewLaterRows)}
                  {countCard(rejectedRowDetails.length, "rejected", "Unmatched JL Codes, nonfinancial entries, and in-file duplicate transaction IDs.", rejectedRowDetails)}
                  {countCard(unresolvedRows.length, "unresolved", "No decision exists for these in this workflow -- they need a corrected source file.", unresolvedRows)}
                </div>
                {rowDrillDown && <section className="import-failure-section row-drilldown-section" role="region" aria-label={rowDrillDown.title}>
                  <div className="row-drilldown-header"><h2>{rowDrillDown.rows.length.toLocaleString()} {rowDrillDown.title}</h2><button type="button" onClick={() => setRowDrillDown(null)}>Close</button></div>
                  <p>{rowDrillDown.description}</p>
                  <ol className="import-failure-errors row-drilldown-list">{rowDrillDown.rows.map((item) => (
                    <li key={`${item.row}-${item.fingerprint ?? ""}`}>
                      <strong>Row {item.row}</strong>
                      <span>{item.donor ?? "Unknown donor"}{item.jlCode ? ` · JL ${item.jlCode}` : ""}{item.campaign ? ` · ${item.campaign}` : ""}</span>
                      {(item.date != null || item.amountCents != null) && <span>{item.date != null ? epochDateLabel(item.date) : ""}{item.date != null && item.amountCents != null ? " · " : ""}{item.amountCents != null ? centsLabel(item.amountCents) : ""}</span>}
                      <span className="review-queue-reason">{item.reason}</span>
                    </li>
                  ))}</ol>
                  <button type="button" onClick={() => downloadRows(rowDrillDown.rows, report.importId, "review")}>Download these rows as CSV</button>
                </section>}
                <details className="import-result-counts-detail"><summary>All counts</summary><div className="import-result-counts import-success-counts">
                  <article><strong>{report.results.validRows.toLocaleString()}</strong><span>valid rows</span></article>
                  <article><strong>{report.results.newHouseholds.toLocaleString()}</strong><span>new households</span></article>
                  <article><strong>{report.results.duplicateRowsSkipped.toLocaleString()}</strong><span>duplicate rows skipped</span></article>
                  <article><strong>{report.results.unmatchedJlCodes.toLocaleString()}</strong><span>unmatched JL Codes</span></article>
                  <article><strong>{(report.results.elapsedMs / 1000).toFixed(1)}s</strong><span>elapsed import time</span></article>
                </div></details>
              </>;
            })()}
            <div className="import-report-actions">
              <button type="button" onClick={() => download(`fundraising-os-import-${report.importId}.json`, JSON.stringify(report, null, 2))}>Download import report</button>
              <button type="button" onClick={() => downloadRows(report.reviewRows ?? [], report.importId, "review")} disabled={!report.reviewRows?.length}>Download review report{report.reviewRows?.length ? ` (${report.reviewRows.length})` : ""}</button>
              <button type="button" onClick={() => downloadRows(report.rejectedRows, report.importId, "rejected")} disabled={!report.rejectedRows.length}>Download rejected rows{report.rejectedRows.length ? ` (${report.rejectedRows.length})` : ""}</button>
            </div>
            {report.reviewOnly && <div className="import-footer-actions"><button type="button" onClick={() => { setReport(null); setStep("recognition"); }}>Review column setup</button><button className="onboarding-primary" type="button" onClick={cancelImport}>Choose a corrected file</button></div>}
            {report.firstRelationshipId && <a className="onboarding-secondary" href={`/donors/${encodeURIComponent(report.firstRelationshipId)}`}>Open first imported relationship</a>}
            {!report.reviewOnly && <a className="onboarding-primary" href={`/donors?updated=${encodeURIComponent(report.importId)}`}>View all imported relationships</a>}
          </section>
        )}
      </div>
    </main>
  );
}
