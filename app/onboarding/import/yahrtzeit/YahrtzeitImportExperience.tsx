"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { parseYahrtzeitWorkbook } from "../../../../lib/import/yahrtzeit-workbook.ts";
import type { YahrtzeitWorkbookRow } from "../../../../lib/import/yahrtzeit-workbook.ts";
import type { YahrtzeitPreviewRow } from "../../../../lib/import/yahrtzeit-pipeline.ts";

type Step = "upload" | "preview" | "committing" | "complete";

function rowKey(row: YahrtzeitPreviewRow) {
  return `${row.rowNumber}`;
}

function occurrenceLabel(row: YahrtzeitPreviewRow) {
  if (!row.occurrence) return "—";
  const date = new Date(row.occurrence.primary.gregorianEpoch * 1000);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

async function fetchPreview(rows: YahrtzeitWorkbookRow[]): Promise<YahrtzeitPreviewRow[]> {
  const response = await fetch("/api/import/yahrtzeit/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
  const payload = await response.json() as { rows?: YahrtzeitPreviewRow[]; error?: string };
  if (!response.ok || !payload.rows) throw new Error(payload.error ?? "The preview could not be prepared.");
  return payload.rows;
}

export function YahrtzeitImportExperience() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  // originalRawRows is frozen at parse time -- the source of truth for
  // "what did the workbook actually say" (provenance). rawRows is the
  // working copy the review UI edits in place (e.g. a corrected Hebrew
  // name) and what gets re-sent for revalidation/commit.
  const [originalRawRows, setOriginalRawRows] = useState<YahrtzeitWorkbookRow[]>([]);
  const [rawRows, setRawRows] = useState<YahrtzeitWorkbookRow[]>([]);
  const [rows, setRows] = useState<YahrtzeitPreviewRow[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [revalidating, setRevalidating] = useState(false);
  const [result, setResult] = useState<{ createdCount: number; updatedCount: number; unchangedCount: number; rejected: Array<{ rowNumber: number; reason: string }> } | null>(null);

  async function inspectFile(file: File) {
    if (!/\.xlsx$/i.test(file.name)) { setError("Choose an Excel (.xlsx) file."); return; }
    if (file.size > 20 * 1024 * 1024) { setError("Choose a file smaller than 20 MB."); return; }
    setError("");
    setStatusMessage("Reading your file locally…");
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseYahrtzeitWorkbook(new Uint8Array(buffer));
      if (parsed.length === 0) throw new Error("No rows were found in that file.");
      setFileName(file.name);
      setStatusMessage("Matching donors and checking for already-imported records…");
      const preview = await fetchPreview(parsed);
      setOriginalRawRows(parsed);
      setRawRows(parsed);
      setRows(preview);
      // Ready rows are included by default. Rows needing review are
      // included by default too UNLESS the issue is a malformed Hebrew
      // name -- garbled data shouldn't go in silently; every other review
      // reason (an ambiguous future recurrence, most notably) describes a
      // completely valid source fact, so there's no reason to withhold it.
      setExcluded(new Set(preview.filter((row) => row.status === "needs_review" && row.reviewReasons.includes("malformed_hebrew_name")).map(rowKey)));
      setEditingRow(null);
      setResult(null);
      setStep("preview");
      setStatusMessage("");
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : "That file could not be read.");
      setStatusMessage("");
    }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void inspectFile(file);
  }

  function toggleExcluded(key: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function startEditing(row: YahrtzeitPreviewRow) {
    setEditingRow(row.rowNumber);
    setEditValue(row.deceasedNameHebrew ?? "");
  }

  async function saveCorrection(rowNumber: number) {
    setRevalidating(true);
    setError("");
    try {
      const nextRawRows = rawRows.map((row) => row.rowNumber === rowNumber ? { ...row, deceasedNameHebrew: editValue } : row);
      const preview = await fetchPreview(nextRawRows);
      setRawRows(nextRawRows);
      setRows(preview);
      // If the correction resolved the malformed-name issue, the row is
      // no longer excluded by default -- surface it as ready to import
      // without an extra click.
      const corrected = preview.find((row) => row.rowNumber === rowNumber);
      if (corrected && !corrected.reviewReasons.includes("malformed_hebrew_name")) {
        setExcluded((current) => { const next = new Set(current); next.delete(`${rowNumber}`); return next; });
      }
      setEditingRow(null);
    } catch (revalidateError) {
      setError(revalidateError instanceof Error ? revalidateError.message : "The correction could not be checked.");
    } finally {
      setRevalidating(false);
    }
  }

  const readyRows = rows.filter((row) => row.status === "ready");
  const needsReviewRows = rows.filter((row) => row.status === "needs_review");
  const alreadyImportedRows = rows.filter((row) => row.status === "already_imported");
  const unmatchedRows = rows.filter((row) => row.status === "unmatched");
  const actionableRows = [...readyRows, ...needsReviewRows];
  const includedRows = actionableRows.filter((row) => !excluded.has(rowKey(row)));

  async function commit() {
    if (includedRows.length === 0 || step === "committing") return;
    setStep("committing");
    setError("");
    try {
      const originalByRow = new Map(originalRawRows.map((row) => [row.rowNumber, row]));
      const includedRowNumbers = new Set(includedRows.map((row) => row.rowNumber));
      const body = {
        rows: rawRows.filter((row) => includedRowNumbers.has(row.rowNumber)).map((row) => {
          const original = originalByRow.get(row.rowNumber);
          return original && original.deceasedNameHebrew !== row.deceasedNameHebrew
            ? { ...row, originalDeceasedNameHebrew: original.deceasedNameHebrew }
            : row;
        }),
      };
      const response = await fetch("/api/import/yahrtzeit/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { createdCount?: number; updatedCount?: number; unchangedCount?: number; rejected?: Array<{ rowNumber: number; reason: string }>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The import could not be saved.");
      setResult({ createdCount: payload.createdCount ?? 0, updatedCount: payload.updatedCount ?? 0, unchangedCount: payload.unchangedCount ?? 0, rejected: payload.rejected ?? [] });
      setStep("complete");
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "The import could not be saved.");
      setStep("preview");
    }
  }

  function startOver() {
    setStep("upload");
    setFileName("");
    setOriginalRawRows([]);
    setRawRows([]);
    setRows([]);
    setExcluded(new Set());
    setEditingRow(null);
    setResult(null);
    setError("");
    setStatusMessage("");
    if (inputRef.current) inputRef.current.value = "";
  }

  return <div className="monday-import">
    {step === "upload" && <section className="support-card">
      <h2>Upload a yahrtzeit workbook</h2>
      <p>Choose the .xlsx file. It is parsed in your browser -- nothing is uploaded until you review the preview below and commit.</p>
      <input ref={inputRef} type="file" accept=".xlsx" onChange={chooseFile} />
      {statusMessage && <p className="capture-assurance" role="status">{statusMessage}</p>}
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step !== "upload" && <section className="support-card monday-import-summary">
      <div className="settings-import"><div><h2>{fileName}</h2><p>{rows.length} row{rows.length === 1 ? "" : "s"} loaded. Nothing is written until you commit.</p></div><button type="button" onClick={startOver}>Start over</button></div>
      <dl className="import-counts">
        <div><dt>Already imported</dt><dd>{alreadyImportedRows.length}</dd></div>
        <div><dt>Ready to import</dt><dd>{readyRows.length}</dd></div>
        <div><dt>Needs review</dt><dd>{needsReviewRows.length}</dd></div>
        <div><dt>Unmatched donor codes</dt><dd>{unmatchedRows.length}</dd></div>
      </dl>
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step === "preview" && <>
      {needsReviewRows.length > 0 && <section className="support-card yahrtzeit-needs-review">
        <h3>Needs review ({needsReviewRows.length})</h3>
        <p>These rows are matched to a donor and can still be imported -- a flag here means a person should look once, not that the row is invalid.</p>
        {needsReviewRows.map((row) => {
          const key = rowKey(row);
          const included = !excluded.has(key);
          const malformedName = row.reviewReasons.includes("malformed_hebrew_name");
          const ambiguousRecurrence = row.reviewReasons.includes("ambiguous_recurrence");
          const isEditing = editingRow === row.rowNumber;
          return <article key={key} className="yahrtzeit-review-row">
            <div className="yahrtzeit-review-row-main">
              <strong>{row.matchedDonorName}</strong> <span className="monday-import-code">{row.donorCode}</span>
              <p>{row.deceasedNameEnglish ?? "—"} · {row.relationship ?? "—"} · {row.hebrewDay ?? "?"} {row.hebrewMonth ?? "?"}{row.hebrewYear ? ` ${row.hebrewYear}` : ""} · Next occurrence {occurrenceLabel(row)}</p>

              {malformedName && !isEditing && <div className="yahrtzeit-review-reason">
                <p><strong>Hebrew name needs review.</strong> The workbook's Hebrew-name field appears to contain English text: “{row.deceasedNameHebrew}”.</p>
                <button type="button" onClick={() => startEditing(row)}>Fix name</button>
              </div>}
              {malformedName && isEditing && <div className="yahrtzeit-review-reason">
                <label>Corrected Hebrew name
                  <input type="text" value={editValue} onChange={(event) => setEditValue(event.target.value)} dir="rtl" />
                </label>
                <div className="yahrtzeit-review-reason-actions">
                  <button type="button" className="onboarding-primary" disabled={revalidating} onClick={() => void saveCorrection(row.rowNumber)}>{revalidating ? "Checking…" : "Save & revalidate"}</button>
                  <button type="button" disabled={revalidating} onClick={() => setEditingRow(null)}>Cancel</button>
                </div>
                <small>Original workbook value is kept as provenance once imported, even after this correction.</small>
              </div>}

              {ambiguousRecurrence && <div className="yahrtzeit-review-reason">
                <p><strong>Future recurrence needs review -- the source date itself is valid.</strong> {row.hebrewDay} {row.hebrewMonth} is a real, unambiguous Hebrew date as recorded. The only open question is which future occurrence: a leap Hebrew year has two Adars (Adar I and Adar II), and this yahrtzeit's own leap-year placement hasn't been confirmed. Importing keeps {row.hebrewDay} {row.hebrewMonth} as the canonical fact -- Fundraising OS will keep flagging the specific leap-year occurrence for review rather than silently picking Adar I or Adar II.</p>
              </div>}
            </div>
            {!isEditing && <div className="yahrtzeit-review-row-actions">
              <label><input type="checkbox" checked={included} disabled={malformedName} onChange={() => toggleExcluded(key)} /> {malformedName ? "Fix the name to enable import" : "Include in this import"}</label>
            </div>}
          </article>;
        })}
      </section>}

      {readyRows.length > 0 && <section className="support-card">
        <h3>Ready to import ({readyRows.length})</h3>
        <table className="yahrtzeit-import-table">
          <thead><tr><th></th><th>Donor</th><th>Deceased</th><th>Relationship</th><th>Hebrew date</th><th>Next occurrence</th></tr></thead>
          <tbody>
            {readyRows.map((row) => {
              const key = rowKey(row);
              const included = !excluded.has(key);
              return <tr key={key}>
                <td><input type="checkbox" checked={included} onChange={() => toggleExcluded(key)} /></td>
                <td>{row.matchedDonorName} <span className="monday-import-code">{row.donorCode}</span></td>
                <td>{row.deceasedNameEnglish ?? "—"}{row.deceasedNameHebrew ? ` (${row.deceasedNameHebrew})` : ""}</td>
                <td>{row.relationship ?? "—"}</td>
                <td>{row.hebrewDay ?? "?"} {row.hebrewMonth ?? "?"}{row.hebrewYear ? ` ${row.hebrewYear}` : ""}</td>
                <td>{occurrenceLabel(row)}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>}

      {alreadyImportedRows.length > 0 && <section className="support-card yahrtzeit-already-imported">
        <h3>Already imported ({alreadyImportedRows.length})</h3>
        <p>These rows match a yahrtzeit already saved for this donor (matched by donor, Hebrew date, and deceased name) -- shown for confirmation only. Re-committing this file will not change or duplicate them.</p>
        <table className="yahrtzeit-import-table">
          <thead><tr><th>Donor</th><th>Deceased</th><th>Hebrew date</th></tr></thead>
          <tbody>
            {alreadyImportedRows.map((row) => <tr key={rowKey(row)}>
              <td>{row.matchedDonorName} <span className="monday-import-code">{row.donorCode}</span></td>
              <td>{row.deceasedNameEnglish ?? "—"}</td>
              <td>{row.hebrewDay ?? "?"} {row.hebrewMonth ?? "?"}{row.hebrewYear ? ` ${row.hebrewYear}` : ""}</td>
            </tr>)}
          </tbody>
        </table>
      </section>}

      {unmatchedRows.length > 0 && <section className="support-card">
        <h3>Unresolved donors</h3>
        <p>No donor code match in your live workspace -- these rows cannot be written to any record and are left for you to resolve manually. Never matched by name.</p>
        {unmatchedRows.map((row) => <article key={rowKey(row)} className="monday-import-row"><div className="monday-import-row-main"><span className="monday-import-code">{row.donorCode ?? "no code"}</span><p>{row.deceasedNameEnglish ?? "(no name)"}</p></div></article>)}
      </section>}

      <section className="support-card monday-import-commit-bar">
        <p>{includedRows.length} row{includedRows.length === 1 ? "" : "s"} ready to commit.</p>
        <button type="button" className="onboarding-primary" disabled={includedRows.length === 0} onClick={() => void commit()}>Commit {includedRows.length} row{includedRows.length === 1 ? "" : "s"}</button>
      </section>
    </>}

    {step === "committing" && <section className="support-card"><p className="capture-assurance" role="status">Saving…</p></section>}

    {step === "complete" && result && <section className="support-card">
      <h2>Import complete</h2>
      <dl className="import-counts">
        <div><dt>Created</dt><dd>{result.createdCount}</dd></div>
        <div><dt>Updated</dt><dd>{result.updatedCount}</dd></div>
      </dl>
      {result.rejected.length > 0 && <><p>{result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} could not be saved:</p><ul>{result.rejected.map((item) => <li key={item.rowNumber}>Row {item.rowNumber}: {item.reason}</li>)}</ul></>}
      <button type="button" onClick={startOver}>Import another file</button>
    </section>}
  </div>;
}
