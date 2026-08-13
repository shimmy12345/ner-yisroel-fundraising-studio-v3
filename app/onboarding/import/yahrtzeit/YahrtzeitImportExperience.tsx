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
  const formatted = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
  return row.occurrence.ambiguous ? `${formatted} (needs review)` : formatted;
}

export function YahrtzeitImportExperience() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [rawRows, setRawRows] = useState<YahrtzeitWorkbookRow[]>([]);
  const [rows, setRows] = useState<YahrtzeitPreviewRow[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ createdCount: number; updatedCount: number; rejected: Array<{ rowNumber: number; reason: string }> } | null>(null);

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
      setStatusMessage("Matching donors against your live workspace…");
      const response = await fetch("/api/import/yahrtzeit/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: parsed }) });
      const payload = await response.json() as { rows?: YahrtzeitPreviewRow[]; error?: string };
      if (!response.ok || !payload.rows) throw new Error(payload.error ?? "The preview could not be prepared.");
      setRawRows(parsed);
      setRows(payload.rows);
      setExcluded(new Set(payload.rows.filter((row) => !row.canCommit).map(rowKey)));
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

  const includedRows = rows.filter((row) => row.canCommit && !excluded.has(rowKey(row)));

  async function commit() {
    if (includedRows.length === 0 || step === "committing") return;
    setStep("committing");
    setError("");
    try {
      const includedRowNumbers = new Set(includedRows.map((row) => row.rowNumber));
      const body = { rows: rawRows.filter((row) => includedRowNumbers.has(row.rowNumber)) };
      const response = await fetch("/api/import/yahrtzeit/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { createdCount?: number; updatedCount?: number; rejected?: Array<{ rowNumber: number; reason: string }>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The import could not be saved.");
      setResult({ createdCount: payload.createdCount ?? 0, updatedCount: payload.updatedCount ?? 0, rejected: payload.rejected ?? [] });
      setStep("complete");
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "The import could not be saved.");
      setStep("preview");
    }
  }

  function startOver() {
    setStep("upload");
    setFileName("");
    setRawRows([]);
    setRows([]);
    setExcluded(new Set());
    setResult(null);
    setError("");
    setStatusMessage("");
    if (inputRef.current) inputRef.current.value = "";
  }

  const matchedRows = rows.filter((row) => row.matchedDonorId);
  const unmatchedRows = rows.filter((row) => !row.matchedDonorId);
  const needsReviewRows = matchedRows.filter((row) => row.issues.length > 0 || row.occurrence?.ambiguous);

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
        <div><dt>Matched donor codes</dt><dd>{matchedRows.length}</dd></div>
        <div><dt>Unmatched donor codes</dt><dd>{unmatchedRows.length}</dd></div>
        <div><dt>Flagged for review</dt><dd>{needsReviewRows.length}</dd></div>
      </dl>
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step === "preview" && <>
      <section className="support-card">
        <h3>Matched rows</h3>
        <p>Every row below is matched to a donor by exact Code. Uncheck any row you don't want imported. Rows flagged for review are still shown with the best calculated date, but the flag means a person should confirm it -- not an automated ruling.</p>
        <table className="yahrtzeit-import-table">
          <thead><tr><th></th><th>Donor</th><th>Deceased</th><th>Relationship</th><th>Hebrew date</th><th>Next occurrence</th><th>Notes</th></tr></thead>
          <tbody>
            {matchedRows.map((row) => {
              const key = rowKey(row);
              const included = row.canCommit && !excluded.has(key);
              return <tr key={key} className={row.issues.length > 0 ? "yahrtzeit-import-row-flagged" : ""}>
                <td><input type="checkbox" checked={included} disabled={!row.canCommit} onChange={() => toggleExcluded(key)} /></td>
                <td>{row.matchedDonorName} <span className="monday-import-code">{row.donorCode}</span></td>
                <td>{row.deceasedNameEnglish ?? "—"}{row.deceasedNameHebrew ? ` (${row.deceasedNameHebrew})` : ""}</td>
                <td>{row.relationship ?? "—"}</td>
                <td>{row.hebrewDay ?? "?"} {row.hebrewMonth ?? "?"}{row.hebrewYear ? ` ${row.hebrewYear}` : ""}</td>
                <td>{occurrenceLabel(row)}</td>
                <td>{row.issues.length > 0 ? <span className="capture-error">{row.issues.join(" ")}</span> : ""}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>

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
