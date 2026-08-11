"use client";

import { useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { parseMondayWorkbook } from "../../../lib/import/monday-workbook";
import type { MondayDonorBlock } from "../../../lib/import/monday-workbook";
import type { MondayPreviewRow } from "../../../lib/import/monday-pipeline";
import type { MondayDisposition } from "../../../lib/import/monday-classify";

// Deliberately narrow: there is no draft-saving, no resumable session, no
// bulk "confirm contact" action anywhere in this file. Every row that can
// affect contact recency requires an individual, explicit click plus an
// explicit date. Rows this tool can never write to (donation notes,
// ambiguous text, unmatched/no-code donors) only ever get a local,
// non-persisted "reviewed" toggle -- dismissing them here has no server
// effect, since the commit route has no action that accepts their
// disposition.

type Step = "upload" | "preview" | "committing" | "complete";
type RowKey = string;
type RowDecision =
  | { kind: "undecided" }
  | { kind: "confirm_contact"; actualContactDate: string }
  | { kind: "accept_future_planned"; dueDate: string }
  | { kind: "create_followup"; dueDate: string };

const DISPOSITION_LABEL: Record<MondayDisposition, string> = {
  confirm_contact_candidate: "Possible historical contact",
  future_planned: "Future planned action",
  historical_planned: "Historical / undated planned action",
  donation_note: "Donation or payment note",
  ambiguous: "Ambiguous",
};

function rowKey(row: MondayPreviewRow): RowKey {
  return `${row.code}:${row.subitemIndex}`;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function MondayImportExperience() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [rows, setRows] = useState<MondayPreviewRow[]>([]);
  const [decisions, setDecisions] = useState<Record<RowKey, RowDecision>>({});
  const [reviewedKeys, setReviewedKeys] = useState<Set<RowKey>>(new Set());
  const [dismissedGroups, setDismissedGroups] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ confirmedContactCount: number; recommendationCount: number; rejected: Array<{ text: string | undefined; reason: string }> } | null>(null);

  async function inspectFile(file: File) {
    if (!/\.xlsx$/i.test(file.name)) { setError("Choose an Excel (.xlsx) file exported from Monday.com."); return; }
    if (file.size > 20 * 1024 * 1024) { setError("Choose a file smaller than 20 MB."); return; }
    setError("");
    setStatusMessage("Reading your file locally…");
    try {
      const buffer = await file.arrayBuffer();
      const donorBlocks: MondayDonorBlock[] = parseMondayWorkbook(new Uint8Array(buffer));
      if (donorBlocks.length === 0) throw new Error("No donor rows were found in that file.");
      setFileName(file.name);
      setStatusMessage("Matching donors against your live workspace…");
      const response = await fetch("/api/import/monday/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ donorBlocks }) });
      const payload = await response.json() as { rows?: MondayPreviewRow[]; error?: string };
      if (!response.ok || !payload.rows) throw new Error(payload.error ?? "The preview could not be prepared.");
      setRows(payload.rows);
      setDecisions({});
      setReviewedKeys(new Set());
      setDismissedGroups(new Set());
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

  function setDecision(key: RowKey, decision: RowDecision) {
    setDecisions((current) => ({ ...current, [key]: decision }));
  }

  function toggleReviewed(key: RowKey) {
    setReviewedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const actionable = Object.entries(decisions).filter((entry): entry is [RowKey, Exclude<RowDecision, { kind: "undecided" }>] => entry[1].kind !== "undecided");

  async function commit() {
    if (actionable.length === 0 || step === "committing") return;
    setStep("committing");
    setError("");
    try {
      const byKey = new Map(rows.map((row) => [rowKey(row), row]));
      const body = {
        decisions: actionable.map(([key, decision]) => {
          const row = byKey.get(key)!;
          const base = { code: row.code, subitemIndex: row.subitemIndex, text: row.text, dueDateRaw: row.dueDateRaw };
          if (decision.kind === "confirm_contact") return { ...base, action: "confirm_contact", actualContactDate: decision.actualContactDate };
          if (decision.kind === "accept_future_planned") return { ...base, action: "accept_future_planned", dueDate: decision.dueDate };
          return { ...base, action: "create_followup", dueDate: decision.dueDate };
        }),
      };
      const response = await fetch("/api/import/monday/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json() as { confirmedContactCount?: number; recommendationCount?: number; rejected?: Array<{ text: string | undefined; reason: string }>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The import could not be saved.");
      setResult({ confirmedContactCount: payload.confirmedContactCount ?? 0, recommendationCount: payload.recommendationCount ?? 0, rejected: payload.rejected ?? [] });
      setStep("complete");
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "The import could not be saved.");
      setStep("preview");
    }
  }

  function startOver() {
    setStep("upload");
    setFileName("");
    setRows([]);
    setDecisions({});
    setReviewedKeys(new Set());
    setDismissedGroups(new Set());
    setResult(null);
    setError("");
    setStatusMessage("");
    if (inputRef.current) inputRef.current.value = "";
  }

  const matchedRows = rows.filter((row) => row.match.status === "matched");
  const unmatchedCodeRows = rows.filter((row) => row.match.status === "unmatched_code");
  const noCodeRows = rows.filter((row) => row.match.status === "no_code");
  const confirmCandidates = matchedRows.filter((row) => row.disposition === "confirm_contact_candidate");
  const futurePlanned = matchedRows.filter((row) => row.disposition === "future_planned");
  const historicalPlanned = matchedRows.filter((row) => row.disposition === "historical_planned");
  const donationNotes = matchedRows.filter((row) => row.disposition === "donation_note");
  const ambiguousRows = matchedRows.filter((row) => row.disposition === "ambiguous");

  const donationGroups = new Map<string, MondayPreviewRow[]>();
  for (const row of donationNotes) {
    const key = row.text.trim().toLowerCase().replace(/\s+/g, " ");
    if (!donationGroups.has(key)) donationGroups.set(key, []);
    donationGroups.get(key)!.push(row);
  }

  return <div className="monday-import">
    {step === "upload" && <section className="support-card">
      <h2>Upload a Monday.com pipeline export</h2>
      <p>Choose the .xlsx export. It is parsed in your browser -- nothing is uploaded until you review and approve specific rows below.</p>
      <input ref={inputRef} type="file" accept=".xlsx" onChange={chooseFile} />
      {statusMessage && <p className="capture-assurance" role="status">{statusMessage}</p>}
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step !== "upload" && <section className="support-card monday-import-summary">
      <div className="settings-import"><div><h2>{fileName}</h2><p>{rows.length} row{rows.length === 1 ? "" : "s"} loaded. Nothing is written until you approve specific rows and commit.</p></div><button type="button" onClick={startOver}>Start over</button></div>
      <dl className="import-counts">
        <div><dt>Possible historical contact</dt><dd>{confirmCandidates.length}</dd></div>
        <div><dt>Future planned actions</dt><dd>{futurePlanned.length}</dd></div>
        <div><dt>Historical / undated actions</dt><dd>{historicalPlanned.length}</dd></div>
        <div><dt>Donation / payment notes</dt><dd>{donationNotes.length}</dd></div>
        <div><dt>Ambiguous</dt><dd>{ambiguousRows.length}</dd></div>
        <div><dt>Rows from unmatched-code donors</dt><dd>{unmatchedCodeRows.length}</dd></div>
        <div><dt>Rows from no-code donors</dt><dd>{noCodeRows.length}</dd></div>
      </dl>
      {error && <p className="capture-error" role="alert">{error}</p>}
    </section>}

    {step === "preview" && <>
      {confirmCandidates.length > 0 && <section className="support-card">
        <h3>Possible historical contact</h3>
        <p>Confirm only if you can verify this contact actually happened. Monday's due date is shown as source context only -- it is never assumed to be the actual contact date.</p>
        {confirmCandidates.map((row) => {
          const key = rowKey(row);
          const decision = decisions[key];
          const confirmed = decision?.kind === "confirm_contact";
          return <article key={key} className="monday-import-row">
            <div className="monday-import-row-main">
              <strong>{row.mondayDonorName}</strong> <span className="monday-import-code">{row.code}</span>
              {row.match.status === "matched" && row.match.nameConflict && <span className="capture-error">Name does not obviously match {row.match.fosDisplayName} -- verify before confirming.</span>}
              <p>{row.text}</p>
              <small>Monday due date: {row.dueDateIso ?? "not recorded"}</small>
            </div>
            <div className="monday-import-row-actions">
              <label>Actual contact date<input type="date" value={confirmed ? decision.actualContactDate : (row.dueDateIso ?? "")} onChange={(event) => setDecision(key, { kind: "confirm_contact", actualContactDate: event.target.value })} /></label>
              <button type="button" className={confirmed ? "onboarding-primary" : ""} onClick={() => setDecision(key, { kind: "confirm_contact", actualContactDate: decision?.kind === "confirm_contact" ? decision.actualContactDate : (row.dueDateIso ?? "") })}>{confirmed ? "Confirmed" : "Confirm contact"}</button>
              {confirmed && <button type="button" onClick={() => setDecision(key, { kind: "undecided" })}>Undo</button>}
            </div>
          </article>;
        })}
      </section>}

      {futurePlanned.length > 0 && <section className="support-card">
        <h3>Future planned actions</h3>
        <p>These are genuinely future-dated in the source file. Review the due date before accepting -- it is editable.</p>
        {futurePlanned.map((row) => {
          const key = rowKey(row);
          const decision = decisions[key];
          const accepted = decision?.kind === "accept_future_planned";
          return <article key={key} className="monday-import-row">
            <div className="monday-import-row-main"><strong>{row.mondayDonorName}</strong> <span className="monday-import-code">{row.code}</span><p>{row.text}</p></div>
            <div className="monday-import-row-actions">
              <label>Due date<input type="date" value={accepted ? decision.dueDate : (row.dueDateIso ?? "")} onChange={(event) => setDecision(key, { kind: "accept_future_planned", dueDate: event.target.value })} /></label>
              <button type="button" className={accepted ? "onboarding-primary" : ""} onClick={() => setDecision(key, { kind: "accept_future_planned", dueDate: decision?.kind === "accept_future_planned" ? decision.dueDate : (row.dueDateIso ?? "") })}>{accepted ? "Accepted" : "Accept as reminder"}</button>
              {accepted && <button type="button" onClick={() => setDecision(key, { kind: "undecided" })}>Undo</button>}
            </div>
          </article>;
        })}
      </section>}

      {historicalPlanned.length > 0 && <section className="support-card">
        <h3>Historical / undated planned actions</h3>
        <p>These default to Ignore -- Monday's old date is never restored automatically. Choose "Create follow-up now" only if this is still worth doing, and pick a new date.</p>
        {historicalPlanned.map((row) => {
          const key = rowKey(row);
          const decision = decisions[key];
          const followUp = decision?.kind === "create_followup";
          const reviewed = reviewedKeys.has(key);
          return <article key={key} className="monday-import-row">
            <div className="monday-import-row-main"><strong>{row.mondayDonorName}</strong> <span className="monday-import-code">{row.code}</span><p>{row.text}</p><small>Original Monday due date: {row.dueDateIso ?? "not recorded"}</small></div>
            <div className="monday-import-row-actions">
              {followUp ? <>
                <label>New due date<input type="date" min={todayIsoDate()} value={decision.dueDate} onChange={(event) => setDecision(key, { kind: "create_followup", dueDate: event.target.value })} /></label>
                <button type="button" onClick={() => setDecision(key, { kind: "undecided" })}>Undo</button>
              </> : <>
                <button type="button" onClick={() => setDecision(key, { kind: "create_followup", dueDate: "" })}>Create follow-up now</button>
                <button type="button" className={reviewed ? "onboarding-primary" : ""} onClick={() => toggleReviewed(key)}>{reviewed ? "Reviewed" : "Review later"}</button>
              </>}
            </div>
          </article>;
        })}
      </section>}

      {donationNotes.length > 0 && <section className="support-card">
        <h3>Donation / payment notes</h3>
        <p>Never imported as financial records -- JL remains the source of truth for gifts. Grouped by identical text so repeated patterns can be dismissed together.</p>
        {[...donationGroups.entries()].map(([groupKey, groupRows]) => {
          const dismissed = dismissedGroups.has(groupKey);
          if (dismissed) return null;
          return <article key={groupKey} className="monday-import-row">
            <div className="monday-import-row-main"><strong>{groupRows.length} row{groupRows.length === 1 ? "" : "s"}</strong><p>{groupRows[0].text}</p><small>{groupRows.map((row) => `${row.mondayDonorName} (${row.code})`).join(", ")}</small></div>
            <div className="monday-import-row-actions"><button type="button" onClick={() => setDismissedGroups((current) => new Set(current).add(groupKey))}>Dismiss {groupRows.length > 1 ? "all" : ""}</button></div>
          </article>;
        })}
      </section>}

      {ambiguousRows.length > 0 && <section className="support-card">
        <h3>Ambiguous</h3>
        <p>Not clearly a contact, a plan, or a donation note. Default Ignore -- nothing here can be written.</p>
        {ambiguousRows.map((row) => {
          const key = rowKey(row);
          const reviewed = reviewedKeys.has(key);
          if (reviewed) return null;
          return <article key={key} className="monday-import-row">
            <div className="monday-import-row-main"><strong>{row.mondayDonorName}</strong> <span className="monday-import-code">{row.code}</span><p>{row.text}</p></div>
            <div className="monday-import-row-actions"><button type="button" onClick={() => toggleReviewed(key)}>Reviewed</button></div>
          </article>;
        })}
      </section>}

      {(unmatchedCodeRows.length > 0 || noCodeRows.length > 0) && <section className="support-card">
        <h3>Unresolved donors</h3>
        <p>No donor code match in your live workspace -- these rows cannot be written to any record and are left for you to resolve manually.</p>
        {[...unmatchedCodeRows, ...noCodeRows].map((row) => <article key={rowKey(row)} className="monday-import-row"><div className="monday-import-row-main"><strong>{row.mondayDonorName}</strong> <span className="monday-import-code">{row.code ?? "no code"}</span><p>{row.text}</p></div></article>)}
      </section>}

      <section className="support-card monday-import-commit-bar">
        <p>{actionable.length} decision{actionable.length === 1 ? "" : "s"} ready to commit.</p>
        <button type="button" className="onboarding-primary" disabled={actionable.length === 0} onClick={() => void commit()}>Commit {actionable.length} decision{actionable.length === 1 ? "" : "s"}</button>
      </section>
    </>}

    {step === "committing" && <section className="support-card"><p className="capture-assurance" role="status">Saving your reviewed decisions…</p></section>}

    {step === "complete" && result && <section className="support-card">
      <h2>Import complete</h2>
      <dl className="import-counts">
        <div><dt>Contacts confirmed</dt><dd>{result.confirmedContactCount}</dd></div>
        <div><dt>Follow-ups created</dt><dd>{result.recommendationCount}</dd></div>
      </dl>
      {result.rejected.length > 0 && <><p>{result.rejected.length} decision{result.rejected.length === 1 ? "" : "s"} could not be saved:</p><ul>{result.rejected.map((item, index) => <li key={index}>{item.text ?? "(unknown row)"}: {item.reason}</li>)}</ul></>}
      <button type="button" onClick={startOver}>Import another file</button>
    </section>}
  </div>;
}
