"use client";

import { useState } from "react";
import type { InteractionKind } from "../../../../lib/capture/interaction";
import { buildMeetingNotesSummaryText } from "../../../../lib/meeting-notes/format";
import type { OrganizedMeetingNotes } from "../../../../lib/meeting-notes/organize";
import { followUpFromSuggestion, emptyFollowUp, selectApprovedFollowUps, type FollowUpRow } from "../../../../lib/meeting-notes/follow-ups";

const TYPE_OPTIONS: Array<{ value: InteractionKind; label: string }> = [
  { value: "meeting", label: "Meeting" },
  { value: "call", label: "Call" },
  { value: "visit", label: "Visit" },
  { value: "personal", label: "Personal" },
  { value: "note", label: "Note" },
];

function todayLocalDateValue(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let followUpCounter = 0;
function nextFollowUpId(): string {
  followUpCounter += 1;
  return `followup-${followUpCounter}`;
}

export function MeetingNotesExperience({ donorId, donorName, returnTo }: { donorId: string; donorName: string; returnTo: string; initialNow: string }) {
  const [transcript, setTranscript] = useState("");
  const [meetingDate, setMeetingDate] = useState(() => todayLocalDateValue());
  const [interactionType, setInteractionType] = useState<InteractionKind>("meeting");

  const [summaryText, setSummaryText] = useState("");
  const [donorInterestsText, setDonorInterestsText] = useState("");
  const [fundraisingOpportunitiesText, setFundraisingOpportunitiesText] = useState("");
  const [confirmedCommitmentsText, setConfirmedCommitmentsText] = useState("");
  const [possibleCommitmentsText, setPossibleCommitmentsText] = useState("");
  const [relationshipContextText, setRelationshipContextText] = useState("");
  const [followUps, setFollowUps] = useState<FollowUpRow[]>([]);
  const [aiOrganized, setAiOrganized] = useState(false);

  const [organizeStatus, setOrganizeStatus] = useState<"idle" | "organizing" | "done" | "unavailable" | "error">("idle");
  const [organizeMessage, setOrganizeMessage] = useState("");
  // A minimum gap between Organize Notes attempts, on top of the
  // disable-while-in-flight guard above -- a defense against accidental
  // repeated AI calls (e.g. impatient repeated clicking after a slow
  // response), not a defense against malicious abuse (this is a
  // single-owner, authenticated app).
  const [lastOrganizeAt, setLastOrganizeAt] = useState(0);
  const ORGANIZE_COOLDOWN_MS = 3000;

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");

  // One save key per review session, stable across repeated Save clicks
  // or a retried request -- the server uses it as the interaction's own
  // deterministic id, so a retry can never create a duplicate note or
  // duplicate follow-ups. Never regenerated after mount.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const canOrganize = transcript.trim().length >= 10 && organizeStatus !== "organizing";
  const canSave = saveStatus !== "saving" && (summaryText.trim().length > 0 || transcript.trim().length > 0);

  async function handleOrganize() {
    const now = Date.now();
    if (now - lastOrganizeAt < ORGANIZE_COOLDOWN_MS) {
      setOrganizeMessage("Give it a few seconds before organizing again.");
      return;
    }
    setLastOrganizeAt(now);
    setOrganizeStatus("organizing");
    setOrganizeMessage("");
    try {
      const response = await fetch("/api/meeting-notes/organize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ donorId, transcript }),
      });
      const payload = await response.json() as { available?: boolean; ok?: boolean; error?: string; data?: OrganizedMeetingNotes };
      if (!response.ok) throw new Error(payload.error || "Meeting notes could not be organized.");

      if (!payload.available) {
        setOrganizeStatus("unavailable");
        setOrganizeMessage("AI organization isn't configured yet. You can still write your summary below and save your notes directly.");
        return;
      }
      if (!payload.ok || !payload.data) {
        setOrganizeStatus("error");
        setOrganizeMessage(payload.error || "AI organization failed. You can edit and save manually below.");
        return;
      }

      const data = payload.data;
      setSummaryText(data.summary);
      setDonorInterestsText(data.donorInterests.join("\n"));
      setFundraisingOpportunitiesText(data.fundraisingOpportunities.join("\n"));
      setConfirmedCommitmentsText(data.confirmedCommitments.join("\n"));
      setPossibleCommitmentsText(data.possibleCommitments.join("\n"));
      setRelationshipContextText(data.relationshipContext);
      // AI-proposed follow-ups always start UNAPPROVED -- a suggestion,
      // never a pre-checked default the fundraiser could save by
      // accident. Explicit approval is required for every one, the same
      // as a manually-added row (see addFollowUp below).
      setFollowUps(data.followUpActions.map((action) => followUpFromSuggestion(action, nextFollowUpId())));
      setAiOrganized(true);
      setOrganizeStatus("done");
    } catch (error) {
      setOrganizeStatus("error");
      setOrganizeMessage(error instanceof Error ? error.message : "AI organization failed. You can edit and save manually below.");
    }
  }

  function addFollowUp() {
    // Manually-added rows also start unapproved -- every follow-up, AI-
    // proposed or hand-typed, requires the same explicit Approve step.
    setFollowUps((current) => [...current, emptyFollowUp(nextFollowUpId())]);
  }
  function updateFollowUp(id: string, patch: Partial<FollowUpRow>) {
    setFollowUps((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }
  function removeFollowUp(id: string) {
    setFollowUps((current) => current.filter((row) => row.id !== id));
  }

  async function handleSave() {
    if (!canSave) return;
    setSaveStatus("saving");
    setSaveError("");
    const finalSummary = summaryText.trim().length > 0
      ? buildMeetingNotesSummaryText({
        summary: summaryText,
        donorInterests: donorInterestsText,
        fundraisingOpportunities: fundraisingOpportunitiesText,
        confirmedCommitments: confirmedCommitmentsText,
        possibleCommitments: possibleCommitmentsText,
        relationshipContext: relationshipContextText,
      })
      : transcript.trim();

    try {
      const response = await fetch("/api/meeting-notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          donorId,
          occurredAt: meetingDate,
          type: interactionType,
          summary: finalSummary,
          aiOrganized,
          idempotencyKey,
          followUps: selectApprovedFollowUps(followUps),
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The meeting notes could not be saved.");
      setSaveStatus("saved");
      window.location.assign(returnTo);
    } catch (error) {
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error.message : "The meeting notes could not be saved.");
    }
  }

  const transcriptTooShort = transcript.trim().length > 0 && transcript.trim().length < 10;

  return <div className="meeting-notes-page">
    <div className="donor-breadcrumb"><a href={returnTo}>{donorName}</a><span>/</span><strong>Meeting notes</strong></div>
    <header className="meeting-notes-header">
      <h1>Add meeting notes</h1>
      <p className="capture-lede">Dictate with your phone or computer&apos;s own dictation tool (such as Typeless), or type directly into the field below. Nothing is saved until you review and approve it.</p>
    </header>

    <section className="meeting-notes-card">
      <label className="capture-field-label" htmlFor="meeting-notes-transcript">Meeting notes</label>
      <textarea
        id="meeting-notes-transcript"
        className="meeting-notes-transcript"
        placeholder="Dictate or type what was discussed..."
        value={transcript}
        onChange={(event) => setTranscript(event.target.value)}
        rows={8}
      />
      {transcriptTooShort && <p className="capture-error">A few more words will help AI organize this well.</p>}

      <div className="meeting-notes-meta-row">
        <div>
          <label className="capture-field-label" htmlFor="meeting-notes-date">Meeting date</label>
          <input id="meeting-notes-date" type="date" value={meetingDate} onChange={(event) => setMeetingDate(event.target.value)} />
        </div>
        <div>
          <label className="capture-field-label" htmlFor="meeting-notes-type">Interaction type</label>
          <select id="meeting-notes-type" value={interactionType} onChange={(event) => setInteractionType(event.target.value as InteractionKind)}>
            {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      <button type="button" className="meeting-notes-organize-button" onClick={handleOrganize} disabled={!canOrganize}>
        {organizeStatus === "organizing" ? "Organizing…" : "✦ Organize Notes"}
      </button>
      {organizeMessage && <p className={organizeStatus === "unavailable" ? "meeting-notes-notice" : "capture-error"}>{organizeMessage}</p>}
    </section>

    <section className="meeting-notes-card">
      <h2>Review and edit</h2>
      <p className="meeting-notes-hint">Everything below is yours to edit. Nothing is saved to {donorName}&apos;s history until you click Save.</p>

      <label className="capture-field-label" htmlFor="meeting-notes-summary">Meeting summary</label>
      <textarea id="meeting-notes-summary" value={summaryText} onChange={(event) => setSummaryText(event.target.value)} rows={4} placeholder="A concise account of the conversation" />

      <label className="capture-field-label" htmlFor="meeting-notes-interests">Donor interests</label>
      <textarea id="meeting-notes-interests" value={donorInterestsText} onChange={(event) => setDonorInterestsText(event.target.value)} rows={3} placeholder="Programs, initiatives, or giving interests mentioned (one per line)" />

      <label className="capture-field-label" htmlFor="meeting-notes-opportunities">Fundraising opportunities</label>
      <textarea id="meeting-notes-opportunities" value={fundraisingOpportunitiesText} onChange={(event) => setFundraisingOpportunitiesText(event.target.value)} rows={3} placeholder="Potential opportunities for future engagement or giving (one per line)" />

      <label className="capture-field-label" htmlFor="meeting-notes-confirmed">Confirmed commitments</label>
      <textarea id="meeting-notes-confirmed" value={confirmedCommitmentsText} onChange={(event) => setConfirmedCommitmentsText(event.target.value)} rows={2} placeholder="Only what was explicitly agreed (one per line)" />

      <label className="capture-field-label" htmlFor="meeting-notes-possible">Possible commitments or discussions</label>
      <textarea id="meeting-notes-possible" value={possibleCommitmentsText} onChange={(event) => setPossibleCommitmentsText(event.target.value)} rows={2} placeholder="Mentioned or considered, but not agreed (one per line)" />

      <label className="capture-field-label" htmlFor="meeting-notes-context">Relationship context</label>
      <textarea id="meeting-notes-context" value={relationshipContextText} onChange={(event) => setRelationshipContextText(event.target.value)} rows={2} placeholder="Stewardship details useful for a future conversation" />
    </section>

    <section className="meeting-notes-card">
      <h2>Follow-up actions</h2>
      <p className="meeting-notes-hint">Every follow-up below is only a proposal until you check Approve. Unapproved and removed items are never saved.</p>
      {followUps.length === 0 && <p className="meeting-notes-hint">No follow-up actions yet.</p>}
      <ul className="meeting-notes-followups">
        {followUps.map((row) => <li key={row.id} className={row.approved ? "meeting-notes-followup-row meeting-notes-followup-approved" : "meeting-notes-followup-row meeting-notes-followup-proposed"}>
          <label className="meeting-notes-followup-approve">
            <input type="checkbox" checked={row.approved} onChange={(event) => updateFollowUp(row.id, { approved: event.target.checked })} />
            <span>{row.approved ? "Approved" : "Proposed"}</span>
          </label>
          <input type="text" value={row.description} onChange={(event) => updateFollowUp(row.id, { description: event.target.value })} placeholder="e.g. Call donor after Yom Tov to discuss Kollel sponsorship" />
          <input type="date" value={row.dueAt} onChange={(event) => updateFollowUp(row.id, { dueAt: event.target.value })} />
          <button type="button" onClick={() => removeFollowUp(row.id)} aria-label="Remove this follow-up">✕</button>
        </li>)}
      </ul>
      <button type="button" className="example-button" onClick={addFollowUp}>+ Add follow-up</button>
    </section>

    <div className="meeting-notes-actions">
      <a href={returnTo} className="meeting-notes-cancel">Cancel</a>
      <button type="button" className="capture-save" onClick={handleSave} disabled={!canSave}>
        {saveStatus === "saving" ? "Saving…" : "Save to interaction history"}
      </button>
    </div>
    {saveStatus === "error" && <p className="capture-error">{saveError}</p>}
  </div>;
}
