"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { decodeCsv, parseCsv, rowsToRecords } from "../../../../lib/import/file-parsers.ts";
import type { ImportRow } from "../../../../lib/import/recognition.ts";
import type { RebbeimImportPreviewRow, RebbeimImportSummary } from "../../../../lib/relationships/rebbeim.ts";

type Step = "upload" | "preview" | "committing" | "complete";
type CommitResult = { addedCount: number; alreadyExistsCount: number; rejected: Array<{ rowNumber: number; status: string; reason: string }> };

const STATUS_LABEL: Record<RebbeimImportPreviewRow["status"], string> = {
  ready_to_add: "Ready to add",
  already_exists: "Already connected",
  unmatched_donor: "Unknown donor code",
  ambiguous_donor: "Duplicate donor code",
  unrecognized_rebbi: "Unrecognized Rebbi",
};

async function fetchPreview(rows: ImportRow[]): Promise<{ rows: RebbeimImportPreviewRow[]; summary: RebbeimImportSummary }> {
  const response = await fetch("/api/import/rebbeim/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows }) });
  const payload = await response.json() as { rows?: RebbeimImportPreviewRow[]; summary?: RebbeimImportSummary; error?: string };
  if (!response.ok || !payload.rows || !payload.summary) throw new Error(payload.error ?? "The preview could not be prepared.");
  return { rows: payload.rows, summary: payload.summary };
}

export function RebbeimImportExperience() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [rawRows, setRawRows] = useState<ImportRow[]>([]);
  const [rows, setRows] = useState<RebbeimImportPreviewRow[]>([]);
  const [summary, setSummary] = useState<RebbeimImportSummary | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  async function inspectFile(file: File) {
    if (!/\.csv$/i.test(file.name)) { setError("Choose a CSV file."); return; }
    if (file.size > 10 * 1024 * 1024) { setError("Choose a file smaller than 10 MB."); return; }
    setError("");
    setStatusMessage("Reading your file locally…");
    try {
      const buffer = await file.arrayBuffer();
      const text = decodeCsv(buffer);
      const { rows: parsedRows } = rowsToRecords(parseCsv(text));
      if (parsedRows.length === 0) throw new Error("No rows were found in that file.");
      setFileName(file.name);
      setStatusMessage("Matching donor codes and Rebbeim…");
      const preview = await fetchPreview(parsedRows);
      setRawRows(parsedRows);
      setRows(preview.rows);
      setSummary(preview.summary);
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

  async function commit() {
    setStep("committing"); setError("");
    try {
      const response = await fetch("/api/import/rebbeim/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows: rawRows }) });
      const payload = await response.json() as CommitResult & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The import could not be saved.");
      setResult(payload);
      setStep("complete");
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "The import could not be saved.");
      setStep("preview");
    }
  }

  function reset() {
    setStep("upload"); setFileName(""); setError(""); setStatusMessage("");
    setRawRows([]); setRows([]); setSummary(null); setResult(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (step === "upload") {
    return <section className="support-card">
      <p>Format: a CSV with a <strong>Donor Code</strong> column and either a <strong>Rebbeim</strong> column (semicolon-separated, e.g. <code>Harav Berkowitz; Harav Frand</code>) or a <strong>Rebbi</strong> column (one name per row, repeated donor codes).</p>
      <input ref={inputRef} type="file" accept=".csv,text/csv" onChange={chooseFile} hidden />
      <button type="button" className="onboarding-primary" onClick={() => inputRef.current?.click()}>Choose a file</button>
      {statusMessage && <p>{statusMessage}</p>}
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>;
  }

  if (step === "committing") return <section className="support-card"><p>Saving…</p></section>;

  if (step === "complete" && result) {
    return <section className="support-card">
      <h2>Import complete</h2>
      <p>{result.addedCount} relationship{result.addedCount === 1 ? "" : "s"} added, {result.alreadyExistsCount} already connected (no-op).</p>
      {result.rejected.length > 0 && <>
        <p>{result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} not applied:</p>
        <ul>{result.rejected.map((row) => <li key={row.rowNumber}>Row {row.rowNumber} ({STATUS_LABEL[row.status as keyof typeof STATUS_LABEL] ?? row.status}): {row.reason}</li>)}</ul>
      </>}
      <button type="button" className="onboarding-primary" onClick={reset}>Import another file</button>
    </section>;
  }

  const canCommitCount = summary?.ready_to_add ?? 0;

  return <section className="support-card">
    <h2>{fileName}</h2>
    {summary && <ul>
      <li>{summary.ready_to_add} ready to add</li>
      <li>{summary.already_exists} already connected (no-op)</li>
      <li>{summary.unmatched_donor} unknown donor code</li>
      <li>{summary.ambiguous_donor} duplicate donor code</li>
      <li>{summary.unrecognized_rebbi} unrecognized Rebbi</li>
    </ul>}
    <div className="rebbeim-import-rows">
      {rows.map((row) => <article key={`${row.rowNumber}-${row.rebbiNameRaw}`} className="rebbeim-import-row">
        <p><strong>Row {row.rowNumber}</strong> · Code {row.donorCodeRaw || "(blank)"} {row.matchedDonorName ? `· ${row.matchedDonorName}` : ""} → {row.rebbiNameRaw}</p>
        <p>{STATUS_LABEL[row.status]}{row.issue ? ` — ${row.issue}` : ""}</p>
        {row.likelyMatches.length > 0 && <p>Did you mean: {row.likelyMatches.map((match) => match.displayName).join(", ")}?</p>}
      </article>)}
    </div>
    {error && <p className="capture-error" role="alert">{error}</p>}
    <div className="yahrtzeit-form-actions">
      <button type="button" className="onboarding-primary" disabled={canCommitCount === 0} onClick={() => void commit()}>Add {canCommitCount} relationship{canCommitCount === 1 ? "" : "s"}</button>
      <button type="button" onClick={reset}>Choose a different file</button>
    </div>
  </section>;
}
