"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { parseDobWorkbook } from "../../../../lib/import/dob-workbook.ts";
import type { DobWorkbookRow } from "../../../../lib/import/dob-workbook.ts";
import type { DobPreviewRow, DobPreviewSummary } from "../../../../lib/import/dob-pipeline.ts";

type Step = "upload" | "preview" | "committing" | "complete";

const dobLabel = (row: DobPreviewRow) => row.month && row.day && row.year ? `${row.month}/${row.day}/${row.year}` : "—";
const existingLabel = (row: DobPreviewRow) => row.existingBirthday ? `${row.existingBirthday.personName ?? "—"} · ${row.existingBirthday.month}/${row.existingBirthday.day}${row.existingBirthday.year ? `/${row.existingBirthday.year}` : " (no year)"}${row.existingBirthday.relationship ? ` · ${row.existingBirthday.relationship}` : ""}` : "—";

async function fetchPreview(rows: DobWorkbookRow[], confirmations: Array<{ rowNumber: number; existingId: string }>): Promise<{ rows: DobPreviewRow[]; summary: DobPreviewSummary }> {
  const response = await fetch("/api/import/dob/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rows, confirmations }) });
  const payload = await response.json() as { rows?: DobPreviewRow[]; summary?: DobPreviewSummary; error?: string };
  if (!response.ok || !payload.rows || !payload.summary) throw new Error(payload.error ?? "The preview could not be prepared.");
  return { rows: payload.rows, summary: payload.summary };
}

export function DobImportExperience() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [rawRows, setRawRows] = useState<DobWorkbookRow[]>([]);
  const [rows, setRows] = useState<DobPreviewRow[]>([]);
  const [summary, setSummary] = useState<DobPreviewSummary | null>(null);
  // rowNumber -> existingBirthday.id the fundraiser explicitly confirmed
  // is the donor's own, via "Confirm this is the donor's birthday". Never
  // inferred -- only ever set by that one explicit click, and re-
  // validated server-side on every preview/commit call.
  const [confirmations, setConfirmations] = useState<Map<number, string>>(new Map());
  const [confirming, setConfirming] = useState<number | null>(null);
  const [result, setResult] = useState<{ createdCount: number; enrichedCount: number; rejected: Array<{ rowNumber: number; status: string; reason: string }> } | null>(null);

  async function inspectFile(file: File) {
    if (!/\.xlsx$/i.test(file.name)) { setError("Choose an Excel (.xlsx) file."); return; }
    if (file.size > 20 * 1024 * 1024) { setError("Choose a file smaller than 20 MB."); return; }
    setError("");
    setStatusMessage("Reading your file locally…");
    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseDobWorkbook(new Uint8Array(buffer));
      if (parsed.length === 0) throw new Error("No rows were found in that file.");
      setFileName(file.name);
      setStatusMessage("Matching donors and checking for existing Birthday records…");
      const preview = await fetchPreview(parsed, []);
      setRawRows(parsed);
      setRows(preview.rows);
      setSummary(preview.summary);
      setConfirmations(new Map());
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

  async function confirmDonorOwn(row: DobPreviewRow) {
    if (!row.existingBirthday || confirming !== null) return;
    setConfirming(row.rowNumber);
    setError("");
    try {
      const nextConfirmations = new Map(confirmations).set(row.rowNumber, row.existingBirthday.id);
      const preview = await fetchPreview(rawRows, [...nextConfirmations].map(([rowNumber, existingId]) => ({ rowNumber, existingId })));
      // An exact month/day/year match resolves to already_recorded, which
      // the bulk commit route never writes for (by design, there is
      // nothing to enrich or create). Without a separate persisted write,
      // this confirmation would be forgotten the moment the preview is
      // rebuilt from scratch -- so for exactly this sub-case, persist the
      // donor-own identity fact (relationship="Donor" only, nothing else)
      // through the dedicated confirm endpoint, which independently
      // re-derives and re-validates every precondition server-side rather
      // than trusting this client's re-preview result. A row that instead
      // resolves to enrich_missing_year needs no separate persistence here
      // -- "Commit all clean rows" already writes both year and relationship
      // for that case in one atomic step.
      const confirmedRow = preview.rows.find((r) => r.rowNumber === row.rowNumber);
      if (confirmedRow?.status === "already_recorded") {
        const response = await fetch("/api/import/dob/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ donorCode: row.donorCode, month: row.month, day: row.day, year: row.year, existingId: row.existingBirthday.id }) });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "That confirmation could not be saved.");
      }
      setConfirmations(nextConfirmations);
      setRows(preview.rows);
      setSummary(preview.summary);
    } catch (confirmError) {
      setError(confirmError instanceof Error ? confirmError.message : "That confirmation could not be checked.");
    } finally {
      setConfirming(null);
    }
  }

  const readyRows = rows.filter((row) => row.status === "ready_to_add");
  const enrichRows = rows.filter((row) => row.status === "enrich_missing_year");
  const alreadyRecordedRows = rows.filter((row) => row.status === "already_recorded");
  const needsReviewRows = rows.filter((row) => row.status === "needs_review");
  const conflictRows = rows.filter((row) => row.status === "conflict");
  const unmatchedRows = rows.filter((row) => row.status === "unmatched" || row.status === "ambiguous");
  const invalidRows = rows.filter((row) => row.status === "invalid");
  // Clean = ready_to_add + enrich_missing_year only, exactly as designed.
  // already_recorded is never submitted -- there is nothing to write.
  const cleanRows = [...readyRows, ...enrichRows];

  async function commit() {
    if (cleanRows.length === 0 || step === "committing") return;
    setStep("committing");
    setError("");
    try {
      const cleanRowNumbers = new Set(cleanRows.map((row) => row.rowNumber));
      const body = {
        rows: rawRows.filter((row) => cleanRowNumbers.has(row.rowNumber)).map((row) => {
          const confirmedExistingId = confirmations.get(row.rowNumber);
          return confirmedExistingId ? { ...row, confirmedExistingId } : row;
        }),
      };
      const response = await fetch("/api/import/dob/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { createdCount?: number; enrichedCount?: number; rejected?: Array<{ rowNumber: number; status: string; reason: string }>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The import could not be saved.");
      setResult({ createdCount: payload.createdCount ?? 0, enrichedCount: payload.enrichedCount ?? 0, rejected: payload.rejected ?? [] });
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
    setSummary(null);
    setConfirmations(new Map());
    setResult(null);
    setError("");
    setStatusMessage("");
    if (inputRef.current) inputRef.current.value = "";
  }

  return <div className="monday-import">
    {step === "upload" && <section className="support-card">
      <h2>Upload a Date of Birth workbook</h2>
      <p>Choose the .xlsx file (columns: DOB, Code). It is parsed in your browser -- nothing is uploaded until you review the preview below and commit. Each row updates one donor's Birthday Important Date, matched strictly by donor code.</p>
      <input ref={inputRef} type="file" accept=".xlsx" onChange={chooseFile} />
      {statusMessage && <p className="capture-assurance" role="status">{statusMessage}</p>}
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step !== "upload" && summary && <section className="support-card monday-import-summary">
      <div className="settings-import"><div><h2>{fileName}</h2><p>{rows.length} row{rows.length === 1 ? "" : "s"} loaded. Nothing is written until you commit.</p></div><button type="button" onClick={startOver}>Start over</button></div>
      <dl className="import-counts">
        <div><dt>Ready to add</dt><dd>{summary.ready_to_add}</dd></div>
        <div><dt>Already recorded</dt><dd>{summary.already_recorded}</dd></div>
        <div><dt>Will enrich missing year</dt><dd>{summary.enrich_missing_year}</dd></div>
        <div><dt>Needs review</dt><dd>{summary.needs_review}</dd></div>
        <div><dt>Conflicts</dt><dd>{summary.conflict}</dd></div>
        <div><dt>Unmatched codes</dt><dd>{summary.unmatched + summary.ambiguous}</dd></div>
        <div><dt>Invalid rows</dt><dd>{summary.invalid}</dd></div>
      </dl>
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step === "preview" && <>
      {/* Clean rows: count-only, no per-row review friction. */}
      {cleanRows.length > 0 && <section className="support-card">
        <h3>Ready to commit ({cleanRows.length})</h3>
        <p>{readyRows.length} new Birthday record{readyRows.length === 1 ? "" : "s"} will be added; {enrichRows.length} existing record{enrichRows.length === 1 ? "" : "s"} will have its birth year filled in. Nothing else about those existing records changes.</p>
      </section>}

      {alreadyRecordedRows.length > 0 && <section className="support-card yahrtzeit-already-imported">
        <h3>Already recorded ({alreadyRecordedRows.length})</h3>
        <p>These donors already have a Birthday record that exactly matches the spreadsheet. Nothing will be written for them.</p>
      </section>}

      {needsReviewRows.length > 0 && <section className="support-card yahrtzeit-needs-review">
        <h3>Needs review ({needsReviewRows.length})</h3>
        <p>Matched to a donor, but not automatically identifiable as the donor's own birthday -- nothing is written for these until resolved.</p>
        {needsReviewRows.map((row) => <article key={row.rowNumber} className="yahrtzeit-review-row">
          <div className="yahrtzeit-review-row-main">
            <strong>{row.matchedDonorName ?? "—"}</strong> <span className="monday-import-code">{row.donorCode}</span>
            <p>Spreadsheet DOB: {dobLabel(row)}</p>
            <p>Existing Birthday record: {existingLabel(row)}</p>
            <p>{row.issues[0]}</p>
            {row.existingBirthday && <div className="yahrtzeit-review-reason-actions">
              <button type="button" disabled={confirming === row.rowNumber} onClick={() => void confirmDonorOwn(row)}>{confirming === row.rowNumber ? "Checking…" : "Confirm this is the donor's birthday"}</button>
            </div>}
          </div>
        </article>)}
      </section>}

      {conflictRows.length > 0 && <section className="support-card yahrtzeit-needs-review">
        <h3>Conflicts ({conflictRows.length})</h3>
        <p>The donor's existing Birthday record disagrees with the spreadsheet. Nothing is written automatically -- resolve directly on the donor's profile if the spreadsheet is correct.</p>
        {conflictRows.map((row) => <article key={row.rowNumber} className="yahrtzeit-review-row">
          <div className="yahrtzeit-review-row-main">
            <strong>{row.matchedDonorName ?? "—"}</strong> <span className="monday-import-code">{row.donorCode}</span>
            <p>Spreadsheet DOB: {dobLabel(row)}</p>
            <p>Existing Birthday record: {existingLabel(row)}</p>
            <p>{row.issues[0]}</p>
          </div>
        </article>)}
      </section>}

      {unmatchedRows.length > 0 && <section className="support-card">
        <h3>Unmatched codes ({unmatchedRows.length})</h3>
        <p>No single live donor match for this code -- these rows cannot be written to any record and are left for you to resolve manually. Never matched by name.</p>
        {unmatchedRows.map((row) => <article key={row.rowNumber} className="monday-import-row"><div className="monday-import-row-main"><span className="monday-import-code">{row.donorCode ?? "no code"}</span><p>{row.issues[0]}</p></div></article>)}
      </section>}

      {invalidRows.length > 0 && <section className="support-card">
        <h3>Invalid rows ({invalidRows.length})</h3>
        {invalidRows.map((row) => <article key={row.rowNumber} className="monday-import-row"><div className="monday-import-row-main"><span className="monday-import-code">{row.donorCode ?? "no code"}</span><p>{row.issues[0]}</p></div></article>)}
      </section>}

      <section className="support-card monday-import-commit-bar">
        <p>{cleanRows.length} row{cleanRows.length === 1 ? "" : "s"} ready to commit.</p>
        <button type="button" className="onboarding-primary" disabled={cleanRows.length === 0} onClick={() => void commit()}>Commit all clean rows</button>
      </section>
    </>}

    {step === "committing" && <section className="support-card"><p className="capture-assurance" role="status">Saving…</p></section>}

    {step === "complete" && result && <section className="support-card">
      <h2>Import complete</h2>
      <dl className="import-counts">
        <div><dt>Added</dt><dd>{result.createdCount}</dd></div>
        <div><dt>Enriched</dt><dd>{result.enrichedCount}</dd></div>
      </dl>
      {result.rejected.length > 0 && <><p>{result.rejected.length} row{result.rejected.length === 1 ? "" : "s"} could not be saved:</p><ul>{result.rejected.map((item) => <li key={item.rowNumber}>Row {item.rowNumber}: {item.reason}</li>)}</ul></>}
      <button type="button" onClick={startOver}>Import another file</button>
    </section>}
  </div>;
}
