"use client";

import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { FIELD_LABELS, recognizeColumns, type ColumnMapping, type ColumnSuggestion, type ImportField, type ImportPreview, type ImportRow } from "../../../lib/import/recognition";
import { decodeCsv, parseCsv, parseXlsx, rowsToRecords } from "../../../lib/import/file-parsers";
import { isJlSolutionsExport, JL_MAPPING } from "../../../lib/import/jl-solutions";
import { isJlDonationExport } from "../../../lib/import/jl-donations";
import { UndoDonationImport } from "./UndoDonationImport";

type Step = "upload" | "recognition" | "preview" | "importing" | "complete" | "failed";
type FailureCategory = "unmatched_jl_codes" | "duplicate_records" | "invalid_dates" | "invalid_amounts" | "missing_required_fields" | "classification_review" | "nonfinancial_entries" | "transaction_database_errors" | "unexpected_exceptions";
type RowFailure = { row: number; category?: FailureCategory; reason: string; values?: ImportRow };
type ValidationSummary = { totalRows: number; passedRows: number; failedRows: number; duplicateRows: number; nonfinancialRows: number; firstErrors: RowFailure[] };
type ResultSummary = { validRows: number; householdsMatched: number; newHouseholds: number; giftsImported: number; giftsUpdated: number; duplicateRowsSkipped: number; rowsRequiringReview: number; rejectedRows: number; unmatchedJlCodes: number; elapsedMs: number };
type ImportFailure = { error: string; fatalError?: string | null; importId?: string; databaseChangesMade: boolean; noChangesMade: boolean; rollbackCauses: FailureCategory[]; validation: ValidationSummary; reviewRows?: RowFailure[]; rejectedRows: RowFailure[]; results: ResultSummary };
type DuplicateImportBlock = { error: string; importId: string; duplicateBlocked: true; canForceReprocess: boolean; priorStatus: string; completedAt: number | null; warning: string };
type ImportReport = {
  importId: string;
  fileName: string;
  completedAt: string;
  updateExisting: boolean;
  imported: { donors: number; gifts: number; interactions: number; reminders: number };
  rejectedRows: RowFailure[];
  reviewRows?: RowFailure[];
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
};
type MergeCandidate = { externalId: string; jlName: string; manualDonorId: string; manualName: string; reasons: string[] };
type MergeDecision = { action: "needs_decision" | "merge" | "keep_separate" | "review_later"; manualDonorId: string };
type JlPreview = { households: number; newRelationships: number; existingRelationships: number; recordsWithUpdates: number; conflicts: Array<{ externalId: string; field: string; currentValue: string; jlValue: string }>; mergeCandidates: MergeCandidate[]; duplicateRows: number; rejectedRows: number };
type OpenPledgePreview = { id: string; activity_date: number | null; committed_cents: number; paid_cents: number; balance_cents: number; description: string | null; source_campaign: string | null };
type PaymentAssignmentPreview = { row: number; fingerprint: string; donorName: string; donorMatched: boolean; paymentDate: number | null; amountCents: number | null; campaign: string; action: "apply_to_pledge" | "new_gift" | "needs_review"; pledgeId: string | null; remembered: boolean; alreadyApplied: boolean; reason: string | null; openPledges: OpenPledgePreview[] };
type PaymentDecisionState = { action: "apply_to_pledge" | "new_gift" | "needs_review"; pledgeId: string | null; overpaymentAction: "split_remainder_new_gift" | null };
type DonationPreview = { rows: number; matchedRows: number; unknownHousehold: number; duplicateSourceRows: number; zeroDollar: number; openPledges: number; needsReview: number; suspiciousDates: number; nonfinancial: number; newActivities: number; proposedUpdates: number; alreadyImported: number; conflicts: number; reviewRows: RowFailure[]; rejectedRows: number; rangeStart: string | null; rangeEnd: string | null; paymentAssignments: PaymentAssignmentPreview[] };

export type RefreshOverview = {
  lastHouseholdRefreshAt: string | null; lastDonationRefreshAt: string | null; lastDonationRangeStart: string | null; lastDonationRangeEnd: string | null;
  suggestedRangeStart: string | null; suggestedRangeEnd: string | null;
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

const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value.length === 10 ? `${value}T12:00:00` : value)) : "Not yet refreshed";
const centsLabel = (value: number | null) => value === null ? "Amount unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
const epochDateLabel = (value: number | null) => value === null ? "Date unavailable" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date(value * 1000));

export function ImportExperience({ refreshOverview }: { refreshOverview: RefreshOverview }) {
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
  const [mergeDecisions, setMergeDecisions] = useState<Record<string, MergeDecision>>({});
  const [duplicateBlock, setDuplicateBlock] = useState<DuplicateImportBlock | null>(null);
  const [forceConfirmation, setForceConfirmation] = useState("");

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
      const detectedDonation = isJlDonationExport(table.columns);
      const detectedJl = isJlSolutionsExport(table.columns);
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
      setMergeDecisions({});
      setDuplicateBlock(null);
      setForceConfirmation("");
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

  async function showPreview() {
    setError("");
    setDuplicateBlock(null);
    setForceConfirmation("");
    setStatusMessage("Checking the preview securely…");
    try {
      const response = await fetch("/api/import/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows, mapping, fileHash }) });
      const payload = await response.json() as { profile?: string; preview?: ImportPreview; jl?: JlPreview; donation?: DonationPreview; error?: string };
      if (!response.ok || (!payload.preview && !payload.donation)) throw new Error(payload.error ?? "The preview could not be prepared.");
      setPreview(payload.preview ?? { donors: [], gifts: [], interactions: [], reminders: [], rejectedRows: [], warnings: [] });
      setJlPreview(payload.jl ?? null);
      setMergeDecisions(Object.fromEntries((payload.jl?.mergeCandidates ?? []).map((candidate) => [candidate.externalId, { action: "needs_decision", manualDonorId: candidate.manualDonorId }])));
      setDonationPreview(payload.donation ?? null);
      setPaymentDecisions(Object.fromEntries((payload.donation?.paymentAssignments ?? []).map((item) => [item.fingerprint, { action: item.action, pledgeId: item.pledgeId, overpaymentAction: null }])));
      setStep("preview");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "The preview could not be prepared.");
    } finally { setStatusMessage(""); }
  }

  async function importData(forceReprocess = false) {
    if (!preview || step === "importing") return;
    setStep("importing");
    setError("");
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName, fileHash, rows, mapping, updateExisting, mode, paymentDecisions: Object.entries(paymentDecisions).map(([fingerprint, decision]) => ({ fingerprint, ...decision })), mergeDecisions: Object.entries(mergeDecisions).map(([externalId, decision]) => ({ externalId, ...decision })), forceReprocess, forceConfirmation: forceReprocess ? forceConfirmation : undefined }),
      });
      const payload = await response.json() as ImportReport | ImportFailure | DuplicateImportBlock | { error?: string };
      if (!response.ok) {
        if (response.status === 409 && "duplicateBlocked" in payload && payload.duplicateBlocked) {
          setDuplicateBlock(payload);
          setError(payload.error);
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
      setStep("complete");
    } catch (importError) {
      setFailureReport(unexpectedFailure(importError instanceof Error ? importError.message : "The import request could not be completed."));
      setStep("failed");
    }
  }

  function unexpectedFailure(reason: string): ImportFailure {
    return {
      error: reason,
      fatalError: reason,
      databaseChangesMade: false,
      noChangesMade: true,
      rollbackCauses: ["unexpected_exceptions"],
      validation: { totalRows: rows.length, passedRows: 0, failedRows: rows.length, duplicateRows: 0, nonfinancialRows: 0, firstErrors: [{ row: 0, category: "unexpected_exceptions", reason }] },
      reviewRows: [],
      rejectedRows: rows.map((_, index) => ({ row: index + 2, category: "unexpected_exceptions", reason: "Row was not written because the import request failed." })),
      results: { validRows: 0, householdsMatched: 0, newHouseholds: 0, giftsImported: 0, giftsUpdated: 0, duplicateRowsSkipped: 0, rowsRequiringReview: rows.length, rejectedRows: rows.length, unmatchedJlCodes: 0, elapsedMs: 0 },
    };
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
    setMergeDecisions({});
    setDuplicateBlock(null);
    setForceConfirmation("");
    setFailureReport(null);
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

  const stepNumber = step === "upload" ? 2 : step === "recognition" ? 3 : step === "preview" ? 4 : 5;
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
  const unresolvedMerges = jlPreview?.mergeCandidates.filter((candidate) => !mergeDecisions[candidate.externalId] || mergeDecisions[candidate.externalId].action === "needs_decision").length ?? 0;
  const proposedNewPayments = donationPreview?.paymentAssignments.filter((item) => !item.alreadyApplied && (paymentDecisions[item.fingerprint]?.action === "new_gift" || (paymentAllocations.get(item.fingerprint)?.remainderCents ?? 0) > 0 && paymentAllocations.get(item.fingerprint)?.resolved)).length ?? 0;
  const proposedPledgeUpdates = new Set(donationPreview?.paymentAssignments.filter((item) => !item.alreadyApplied && paymentAllocations.get(item.fingerprint)?.resolved && paymentDecisions[item.fingerprint]?.pledgeId).map((item) => paymentDecisions[item.fingerprint].pledgeId) ?? []).size;

  return (
    <main className="import-page">
      <header className="import-header">
        <a href="/" className="import-brand"><span>F</span>Fundraising OS</a>
        <a href="/">Exit import</a>
      </header>
      <div className="import-shell">
        <nav className="import-progress" aria-label="Import progress">
          {["Welcome", "Upload", "Recognize", "Preview", "Import"].map((label, index) => (
            <span key={label} className={index + 1 < stepNumber ? "done" : index + 1 === stepNumber ? "active" : ""}>
              <b>{index + 1 < stepNumber ? "✓" : index + 1}</b>{label}
            </span>
          ))}
        </nav>

        {step === "upload" && (
          <section className="import-card import-upload-step">
            <p className="eyebrow">BRING YOUR DATA</p>
            <h1>Start with the spreadsheet you already have.</h1>
            <p className="import-lede">We&apos;ll recognize the useful donor, gift, interaction, and reminder information for you. Nothing is imported yet.</p>
            <section className="jl-refresh-overview" aria-label="JL refresh status">
              <div><p className="eyebrow">INCREMENTAL JL REFRESH</p><h2>Upload only the recent export you need.</h2><p>Overlapping dates are safe. Existing fingerprints are skipped, changed pledge status is updated, and missing rows never delete history.</p></div>
              <dl><div><dt>Households last refreshed</dt><dd>{dateLabel(refreshOverview.lastHouseholdRefreshAt)}</dd></div><div><dt>Donations last refreshed</dt><dd>{dateLabel(refreshOverview.lastDonationRefreshAt)}</dd></div><div><dt>Suggested donation export</dt><dd>{refreshOverview.suggestedRangeStart ? `${dateLabel(refreshOverview.suggestedRangeStart)} – ${dateLabel(refreshOverview.suggestedRangeEnd)}` : `Most recent available range through ${dateLabel(refreshOverview.suggestedRangeEnd)}`}</dd></div></dl>
            </section>
            <div
              className={`import-dropzone ${dragging ? "dragging" : ""}`}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={dropFile}
            >
              <div className="import-file-icon">⇧</div>
              <strong>Drop your spreadsheet here</strong>
              <p>CSV or Excel (.xlsx), up to 10 MB</p>
              <button type="button" onClick={() => inputRef.current?.click()}>Choose a file</button>
              <input ref={inputRef} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={chooseFile} hidden />
            </div>
            <p className="import-privacy">Your file is inspected in this browser. It is never sent to an AI provider.</p>
            <section className="jl-import-history"><div><p className="eyebrow">IMPORT HISTORY</p><h2>Recent JL refreshes</h2></div>{refreshOverview.history.length ? <ol>{refreshOverview.history.map((item) => <li key={item.id}><div><strong>{item.kind} · {item.status === "undone" || item.status === "rolled_back" ? "Undone" : item.status === "failed" ? "Failed" : "Completed"}</strong><span>{item.fileName}</span><span>Batch ID: <code>{item.id}</code></span></div><div><strong>{dateLabel(item.completedAt)}</strong><span>{item.summary}</span>{item.canUndo && item.undoKind && <UndoDonationImport importId={item.id} kind={item.undoKind} />}</div></li>)}</ol> : <p>No completed imports yet.</p>}</section>
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
            {jlDetected && <div className="jl-detected" role="status"><strong>JL Solutions household export detected.</strong><span>The saved household mapping has been applied automatically.</span></div>}
            {donationDetected && <div className="jl-detected" role="status"><strong>JL Solutions donation export detected.</strong><span>Available donation columns were recognized automatically. Missing payment-status fields will be held for review.</span></div>}
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
              <button className="onboarding-primary" type="button" onClick={() => void showPreview()} disabled={Boolean(statusMessage)}>{statusMessage || "Review import preview"}</button>
            </div>
          </section>
        )}

        {step === "preview" && preview && (
          <section className="import-card">
            <p className="eyebrow">READY FOR REVIEW</p>
            <h1>Your workspace preview</h1>
            <p className="import-lede">This is a preview only. Nothing has been written to Fundraising OS.</p>
            {donationDetected && donationPreview ? <>
              <p className="jl-export-range">Detected export range: <strong>{donationPreview.rangeStart && donationPreview.rangeEnd ? `${dateLabel(donationPreview.rangeStart)} – ${dateLabel(donationPreview.rangeEnd)}` : "No valid dated rows"}</strong></p>
              <div className="import-counts"><article><strong>{(donationPreview.paymentAssignments.length ? proposedNewPayments : donationPreview.newActivities).toLocaleString()}</strong><span>new gifts</span></article><article><strong>{(donationPreview.paymentAssignments.length ? proposedPledgeUpdates : donationPreview.proposedUpdates).toLocaleString()}</strong><span>pledge updates</span></article><article><strong>{donationPreview.alreadyImported.toLocaleString()}</strong><span>existing duplicates</span></article><article><strong>{(donationPreview.paymentAssignments.length ? unresolvedPayments : donationPreview.needsReview).toLocaleString()}</strong><span>review rows</span></article><article><strong>{donationPreview.rejectedRows.toLocaleString()}</strong><span>rejected rows</span></article></div>
              <div className="import-preview-grid"><section><h2>Ready</h2><p><span>✓</span>Matched by JL Code<b>{donationPreview.matchedRows}</b></p><p><span>✓</span>Open pledges<b>{donationPreview.openPledges}</b></p><p><span>✓</span>Already imported<b>{donationPreview.alreadyImported}</b></p></section><section><h2>Excluded or review</h2><p><span>•</span>Unknown JL Code<b>{donationPreview.unknownHousehold}</b></p><p><span>•</span>Needs review<b>{donationPreview.paymentAssignments.length ? unresolvedPayments : donationPreview.needsReview}</b></p><p><span>•</span>Suspicious dates<b>{donationPreview.suspiciousDates}</b></p><p><span>•</span>Duplicate source rows<b>{donationPreview.duplicateSourceRows}</b></p><p><span>•</span>Zero-dollar/nonfinancial<b>{donationPreview.nonfinancial}</b></p></section></div>
              {donationPreview.reviewRows.length > 0 && donationPreview.paymentAssignments.length === 0 && <section className="import-failure-section"><h2>Rows requiring review</h2><ol className="import-failure-errors">{donationPreview.reviewRows.slice(0, 8).map((item) => <li key={item.row}><strong>Row {item.row}</strong><span>{item.reason}</span></li>)}</ol><button type="button" onClick={() => downloadRows(donationPreview.reviewRows, fileHash.slice(0, 12), "review")}>Download review report CSV</button></section>}
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
              {jlPreview.conflicts.length > 0 && <section className="jl-conflicts"><h2>Values needing your attention</h2><p>{jlPreview.conflicts.length} user-edited value{jlPreview.conflicts.length === 1 ? "" : "s"} differ from this JL export. They will not be overwritten.</p>{jlPreview.conflicts.slice(0, 8).map((conflict) => <article key={`${conflict.externalId}-${conflict.field}`}><strong>JL {conflict.externalId}</strong><span>{conflict.field.replaceAll("_", " ")}</span><small>Current: {conflict.currentValue || "Blank"} · JL: {conflict.jlValue || "Blank"}</small></article>)}</section>}
              {jlPreview.mergeCandidates.length > 0 && <section className="jl-merge-candidates"><h2>Possible manual donor matches</h2><p>These are suggestions only. Fundraising OS will never merge or add a likely duplicate without your decision.</p>{jlPreview.mergeCandidates.map((candidate) => { const decision = mergeDecisions[candidate.externalId] ?? { action: "needs_decision", manualDonorId: candidate.manualDonorId }; return <article key={candidate.externalId}><div><strong>{candidate.jlName} <small>JL {candidate.externalId}</small></strong><span>Possible match: {candidate.manualName}</span><small>{candidate.reasons.join(" · ")}</small></div><label><span>Resolve Duplicate</span><select required aria-label={`Merge decision for JL ${candidate.externalId}`} value={decision.action} onChange={(event) => setMergeDecisions((current) => ({ ...current, [candidate.externalId]: { action: event.target.value as MergeDecision["action"], manualDonorId: candidate.manualDonorId } }))}><option value="needs_decision" disabled>Choose a decision</option><option value="merge">Resolve duplicate and preserve history</option><option value="keep_separate">Keep as separate donors</option><option value="review_later">Review later — do not import this household</option></select></label></article>; })}<p className="import-privacy">Resolving keeps the manual donor&apos;s internal ID, interactions, reminders, notes, and history. Review later leaves the database unchanged for that JL household. You can change this decision until import confirmation.</p></section>}
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
              {!duplicateBlock && <button className="onboarding-primary" type="button" onClick={() => void importData()} disabled={unresolvedPayments + unresolvedMerges > 0}>{unresolvedPayments > 0 ? `Review ${unresolvedPayments} payment${unresolvedPayments === 1 ? "" : "s"}` : unresolvedMerges > 0 ? `Review ${unresolvedMerges} possible match${unresolvedMerges === 1 ? "" : "es"}` : "Confirm and import"}</button>}
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
            <p className="eyebrow">IMPORT NOT COMPLETED</p>
            <h1 id="import-failed-title">We couldn&apos;t import this file.</h1>
            <p className="import-lede">{failureReport.error}</p>
            <div className="import-rollback-assurance" role="status">
              <strong>No changes were made to the database.</strong>
              <span>The donation transaction was rolled back as one unit, so no partial data was kept.</span>
            </div>
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
            {report.reviewOnly && report.reviewRows?.length ? <section className="import-failure-section"><h2>Why each row requires review</h2><ol className="import-failure-errors">{report.reviewRows.slice(0, 8).map((item) => <li key={item.row}><strong>Row {item.row}</strong><span>{item.reason}</span></li>)}</ol></section> : null}
            {report.refresh && <p className="import-preservation-note">Historical gifts were not deleted. Fundraising OS interactions, reminders, notes, summaries, and institutional memory were preserved.</p>}
            {report.warnings.length > 0 && <ul className="import-complete-warnings">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            {report.results && <div className="import-result-counts import-success-counts">
              <article><strong>{report.results.validRows.toLocaleString()}</strong><span>valid rows</span></article>
              <article><strong>{report.results.householdsMatched.toLocaleString()}</strong><span>households matched</span></article>
              <article><strong>{report.results.newHouseholds.toLocaleString()}</strong><span>new households</span></article>
              <article><strong>{report.results.giftsImported.toLocaleString()}</strong><span>gifts imported</span></article>
              <article><strong>{report.results.giftsUpdated.toLocaleString()}</strong><span>gifts updated</span></article>
              <article><strong>{report.results.duplicateRowsSkipped.toLocaleString()}</strong><span>duplicate rows skipped</span></article>
              <article><strong>{report.results.rowsRequiringReview.toLocaleString()}</strong><span>rows requiring review</span></article>
              <article><strong>{report.results.rejectedRows.toLocaleString()}</strong><span>rejected rows</span></article>
              <article><strong>{report.results.unmatchedJlCodes.toLocaleString()}</strong><span>unmatched JL Codes</span></article>
              <article><strong>{(report.results.elapsedMs / 1000).toFixed(1)}s</strong><span>elapsed import time</span></article>
            </div>}
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
