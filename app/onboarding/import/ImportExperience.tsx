"use client";

import { useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { FIELD_LABELS, recognizeColumns, type ColumnMapping, type ColumnSuggestion, type ImportField, type ImportPreview, type ImportRow } from "../../../lib/import/recognition";
import { decodeCsv, parseCsv, parseXlsx, rowsToRecords } from "../../../lib/import/file-parsers";
import { isJlSolutionsExport, JL_MAPPING } from "../../../lib/import/jl-solutions";
import { isJlDonationExport, JL_DONATION_COLUMNS } from "../../../lib/import/jl-donations";

type Step = "upload" | "recognition" | "preview" | "importing" | "complete";
type ImportReport = {
  importId: string;
  fileName: string;
  completedAt: string;
  updateExisting: boolean;
  imported: { donors: number; gifts: number; interactions: number; reminders: number };
  rejectedRows: ImportPreview["rejectedRows"];
  warnings: string[];
  firstRelationshipId?: string | null;
  profile?: string;
  donation?: { newActivities: number; updatedPledges: number; unchanged: number; unknownHousehold: number; needsReview: number; nonfinancialExcluded: number; duplicateSourceRows: number };
};
type JlPreview = { households: number; newRelationships: number; existingRelationships: number; recordsWithUpdates: number; conflicts: Array<{ externalId: string; field: string; currentValue: string; jlValue: string }> };
type DonationPreview = { rows: number; matchedRows: number; unknownHousehold: number; duplicateSourceRows: number; zeroDollar: number; openPledges: number; needsReview: number; suspiciousDates: number; nonfinancial: number; newActivities: number; proposedUpdates: number; alreadyImported: number };

const DONATION_LABELS: Record<string, string> = { Code: "JL household code", Name: "Source household name", "Total Due": "Validation context only", "Item Num": "Item type", Desc: "Description", Campaign: "Supporting source context", "Due Date": "Activity date", Amount: "Committed amount", Paid: "Paid amount", "Balance Due": "Outstanding balance", Company: "Validation context only" };

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

export function ImportExperience() {
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
  const [jlDetected, setJlDetected] = useState(false);
  const [jlPreview, setJlPreview] = useState<JlPreview | null>(null);
  const [mode, setMode] = useState<"first" | "refresh">("first");
  const [donationDetected, setDonationDetected] = useState(false);
  const [donationPreview, setDonationPreview] = useState<DonationPreview | null>(null);

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
      setMode("first");
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
    setStatusMessage("Checking the preview securely…");
    try {
      const response = await fetch("/api/import/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows, mapping, fileHash }) });
      const payload = await response.json() as { profile?: string; preview?: ImportPreview; jl?: JlPreview; donation?: DonationPreview; error?: string };
      if (!response.ok || (!payload.preview && !payload.donation)) throw new Error(payload.error ?? "The preview could not be prepared.");
      setPreview(payload.preview ?? { donors: [], gifts: [], interactions: [], reminders: [], rejectedRows: [], warnings: [] });
      setJlPreview(payload.jl ?? null);
      setDonationPreview(payload.donation ?? null);
      setStep("preview");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "The preview could not be prepared.");
    } finally { setStatusMessage(""); }
  }

  async function importData() {
    if (!preview || step === "importing") return;
    setStep("importing");
    setError("");
    try {
      const response = await fetch("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName, fileHash, rows, mapping, updateExisting, mode }),
      });
      const payload = await response.json() as ImportReport | { error?: string };
      if (!response.ok) throw new Error("error" in payload ? payload.error : "Import failed");
      setReport(payload as ImportReport);
      setStep("complete");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Nothing was imported. Try again.");
      setStep("preview");
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
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  function downloadErrorReport() {
    if (!report) return;
    const header = "row,reason,values";
    const lines = report.rejectedRows.map((item) => [item.row, item.reason, JSON.stringify(item.values)].map(csvValue).join(","));
    download(`fundraising-os-errors-${report.importId}.csv`, [header, ...lines].join("\n"), "text/csv");
  }

  const stepNumber = step === "upload" ? 2 : step === "recognition" ? 3 : step === "preview" ? 4 : 5;

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
            {statusMessage && <p className="import-status" role="status">{statusMessage}</p>}
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
            {donationDetected && <div className="jl-detected" role="status"><strong>JL Solutions donation export detected.</strong><span>Paid, committed, balance, and source-context fields were recognized automatically.</span></div>}
            <p className="import-lede">High-confidence columns are ready. Review only the ones marked for attention.</p>
            <div className="recognition-list">
              {donationDetected && JL_DONATION_COLUMNS.map((column) => <article key={column}><div className="recognition-icon">✓</div><div><strong>{column}</strong><span>99% confidence</span></div><div className="recognized-field"><span>{DONATION_LABELS[column]}</span></div></article>)}
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
              <div className="import-counts"><article><strong>{donationPreview.rows.toLocaleString()}</strong><span>source rows</span></article><article><strong>{donationPreview.matchedRows.toLocaleString()}</strong><span>matched giving activities</span></article><article><strong>{donationPreview.newActivities.toLocaleString()}</strong><span>new activities</span></article><article><strong>{donationPreview.proposedUpdates.toLocaleString()}</strong><span>pledge updates</span></article></div>
              <div className="import-preview-grid"><section><h2>Ready</h2><p><span>✓</span>Matched by JL Code<b>{donationPreview.matchedRows}</b></p><p><span>✓</span>Open pledges<b>{donationPreview.openPledges}</b></p><p><span>✓</span>Already imported<b>{donationPreview.alreadyImported}</b></p></section><section><h2>Excluded or review</h2><p><span>•</span>Unknown JL Code<b>{donationPreview.unknownHousehold}</b></p><p><span>•</span>Needs review<b>{donationPreview.needsReview}</b></p><p><span>•</span>Suspicious dates<b>{donationPreview.suspiciousDates}</b></p><p><span>•</span>Duplicate source rows<b>{donationPreview.duplicateSourceRows}</b></p><p><span>•</span>Zero-dollar/nonfinancial<b>{donationPreview.nonfinancial}</b></p></section></div>
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
                <p><strong>{preview.rejectedRows.length}</strong> rejected rows</p>
              </div>
              {jlPreview.conflicts.length > 0 && <section className="jl-conflicts"><h2>Values needing your attention</h2><p>{jlPreview.conflicts.length} user-edited value{jlPreview.conflicts.length === 1 ? "" : "s"} differ from this JL export. They will not be overwritten.</p>{jlPreview.conflicts.slice(0, 8).map((conflict) => <article key={`${conflict.externalId}-${conflict.field}`}><strong>JL {conflict.externalId}</strong><span>{conflict.field.replaceAll("_", " ")}</span><small>Current: {conflict.currentValue || "Blank"} · JL: {conflict.jlValue || "Blank"}</small></article>)}</section>}
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
              <button className="onboarding-primary" type="button" onClick={() => void importData()}>Confirm and import</button>
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

        {step === "complete" && report && (
          <section className="import-card import-complete">
            <div className="import-success-mark">✓</div>
            <p className="eyebrow">IMPORT COMPLETE</p>
            <h1>Your workspace is ready.</h1>
            <p className="import-lede">{report.profile === "JL Solutions Donations" ? `${report.donation?.newActivities ?? 0} new giving activities and ${report.donation?.updatedPledges ?? 0} pledge updates were processed.` : `${report.imported.donors} donors, ${report.imported.gifts} gifts, ${report.imported.interactions} interactions, and ${report.imported.reminders} reminders were processed.`}</p>
            <div className="import-report-actions">
              <button type="button" onClick={() => download(`fundraising-os-import-${report.importId}.json`, JSON.stringify(report, null, 2))}>Download import report</button>
              <button type="button" onClick={downloadErrorReport} disabled={!report.rejectedRows.length}>Download error report{report.rejectedRows.length ? ` (${report.rejectedRows.length})` : ""}</button>
            </div>
            {report.firstRelationshipId && <a className="onboarding-secondary" href={`/donors/${encodeURIComponent(report.firstRelationshipId)}`}>Open first imported relationship</a>}
            <a className="onboarding-primary" href="/donors">View all imported relationships</a>
          </section>
        )}
      </div>
    </main>
  );
}
