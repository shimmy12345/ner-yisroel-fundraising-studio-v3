"use client";

import { useMemo, useState } from "react";
import {
  extractInteraction,
  inferInteractionKind,
  interactionKindLabel,
  type InteractionKind,
  type ReminderChoice,
} from "../../lib/capture/interaction";
import { isFutureScheduledDate, parseScheduledDate, schedulingLabel, toLocalDateTimeValue } from "../../lib/capture/scheduling";
import type { DonorSearchRecord } from "../../lib/relationships/donor-search";
import { DonorAutocomplete } from "./DonorAutocomplete";
import { RecipientPicker } from "./RecipientPicker";
import { donorInitials, numericDonorCode } from "../../lib/relationships/donor-identity";

const kinds: Array<{ value: InteractionKind; icon: string }> = [
  { value: "call", icon: "☎" },
  { value: "email", icon: "✉" },
  { value: "meeting", icon: "○" },
  { value: "visit", icon: "⌂" },
  { value: "note", icon: "✎" },
  { value: "personal", icon: "♡" },
  { value: "text", icon: "💬" },
];

// Not every interaction type has an obvious default role -- these are
// starting points the fundraiser can still override explicitly (the role
// picker is always shown, never hidden), not a hidden classification.
// meeting/call/visit/personal imply real back-and-forth (participant);
// email/note/text default to broadcast-style outreach (recipient) -- a
// shared text is far more often a one-way blast (e.g. a building-progress
// photo update) than a two-way conversation, same reasoning as email.
const ROLE_DEFAULT_BY_KIND: Record<InteractionKind, "participant" | "recipient"> = {
  meeting: "participant",
  call: "participant",
  visit: "participant",
  personal: "participant",
  email: "recipient",
  note: "recipient",
  text: "recipient",
};

// A UX-risk threshold, not the backend's own limit (see MAX_SHARED_RECIPIENTS
// below, which mirrors the real server-side cap in
// app/api/interactions/shared/route.ts) -- large outreach is never blocked,
// just confirmed once before saving.
const LARGE_SELECTION_CONFIRM_THRESHOLD = 15;
// Mirrors MAX_RECIPIENTS in app/api/interactions/shared/route.ts.
const MAX_SHARED_RECIPIENTS = 200;

type SharedSaveResult = { sharedActivityId: string; interactionIds: string[]; recipientCount: number; occurredAt: string };

type SaveResult = {
  interactionId: string;
  occurredAt: string;
  scheduled: boolean;
  reminderAt: string | null;
  relationshipUpdated: boolean;
  extracted: ReturnType<typeof extractInteraction>;
};

type InitialActivity = { id: string; donorId: string; kind: InteractionKind; subject: string; note: string; occurredAt: string; reminderDate: string | null };

export function CaptureExperience({ donors, initialDonorId, initialKind = null, returnTo = null, initialActivity = null, initialNow }: { donors: DonorSearchRecord[]; initialDonorId: string; initialKind?: InteractionKind | null; returnTo?: string | null; initialActivity?: InitialActivity | null; initialNow: string }) {
  const editing = Boolean(initialActivity);
  const [note, setNote] = useState(initialActivity?.note ?? "");
  const [subject, setSubject] = useState(initialActivity?.subject ?? "");
  const [selectedKind, setSelectedKind] = useState<InteractionKind | null>(initialActivity?.kind ?? initialKind);
  const [reminder, setReminder] = useState<ReminderChoice>(initialActivity?.reminderDate ? "custom" : "none");
  const [customDate, setCustomDate] = useState(initialActivity?.reminderDate ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [result, setResult] = useState<SaveResult | null>(null);
  const [donorId, setDonorId] = useState(initialActivity?.donorId ?? initialDonorId);
  const [occurredAt, setOccurredAt] = useState(() => initialActivity ? toLocalDateTimeValue(new Date(initialActivity.occurredAt)) : toLocalDateTimeValue(new Date(initialNow)));
  const [errorMessage, setErrorMessage] = useState("");
  const [acceptRelationshipSnapshot, setAcceptRelationshipSnapshot] = useState(false);
  const activeDonor = donors.find((item) => item.id === donorId);

  // Multi-donor mode -- entirely additive. When entryMode is "single" every
  // piece of state and behavior above is untouched, so single-donor capture
  // (including editing an existing interaction, which never shows the mode
  // toggle at all) keeps working exactly as it did before this existed.
  const [entryMode, setEntryMode] = useState<"single" | "multiple">("single");
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [roleOverride, setRoleOverride] = useState<"participant" | "recipient" | null>(null);
  const [sharedSummary, setSharedSummary] = useState("");
  const [sharedOccurredAt, setSharedOccurredAt] = useState(() => toLocalDateTimeValue(new Date(initialNow)));
  const [showLargeConfirm, setShowLargeConfirm] = useState(false);
  const [sharedStatus, setSharedStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [sharedResult, setSharedResult] = useState<SharedSaveResult | null>(null);
  const [sharedErrorMessage, setSharedErrorMessage] = useState("");
  const sharedKind = selectedKind ?? "meeting";
  const role = roleOverride ?? ROLE_DEFAULT_BY_KIND[sharedKind];
  const sharedValidDate = Boolean(parseScheduledDate(sharedOccurredAt));
  const sharedReady = recipientIds.length >= 2 && sharedSummary.trim().length >= 4 && sharedValidDate;

  async function saveSharedActivity(confirmedLarge = false) {
    if (!sharedReady || sharedStatus === "saving") return;
    if (recipientIds.length >= LARGE_SELECTION_CONFIRM_THRESHOLD && !confirmedLarge) {
      setShowLargeConfirm(true);
      return;
    }
    setShowLargeConfirm(false);
    setSharedStatus("saving");
    setSharedErrorMessage("");
    try {
      const response = await fetch("/api/interactions/shared", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          donorIds: recipientIds,
          type: sharedKind,
          role,
          summary: sharedSummary,
          occurredAt: parseScheduledDate(sharedOccurredAt)?.toISOString(),
        }),
      });
      const payload = await response.json() as SharedSaveResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "The shared activity could not be saved.");
      setSharedResult(payload);
      setSharedStatus("saved");
    } catch (error) {
      setSharedErrorMessage(error instanceof Error ? error.message : "The shared activity could not be saved.");
      setSharedStatus("error");
    }
  }

  function resetShared() {
    setRecipientIds([]);
    setRoleOverride(null);
    setSharedSummary("");
    setSharedOccurredAt(toLocalDateTimeValue(new Date()));
    setShowLargeConfirm(false);
    setSharedStatus("idle");
    setSharedResult(null);
    setSharedErrorMessage("");
  }

  const inferredKind = useMemo(() => inferInteractionKind(note), [note]);
  const activeKind = selectedKind ?? inferredKind;
  const preview = useMemo(
    () => extractInteraction(note, activeKind, subject),
    [activeKind, note, subject],
  );
  const validDate = Boolean(parseScheduledDate(occurredAt));
  const future = isFutureScheduledDate(occurredAt);
  const ready = Boolean(donorId) && note.trim().length >= 4 && validDate && (reminder !== "custom" || Boolean(customDate));
  const dateLabel = schedulingLabel(occurredAt);
  const nowLabel = dateLabel;

  async function saveInteraction() {
    if (!ready || status === "saving") return;
    setStatus("saving");
    setErrorMessage("");
    try {
      const response = await fetch(initialActivity ? `/api/interactions/${encodeURIComponent(initialActivity.id)}` : "/api/interactions", {
        method: initialActivity ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          donorId,
          note,
          type: activeKind,
          subject: subject.trim(),
          reminder,
          customDate: reminder === "custom" ? customDate : undefined,
          occurredAt: parseScheduledDate(occurredAt)?.toISOString(),
          // Gated on the CURRENT preview, not just the checkbox's own state
          // -- if the note was edited down to nothing meaningful after the
          // box was checked (or the box was never shown at all because
          // there was never anything meaningful), this must never send
          // true. preview is computed from these exact same note/activeKind/
          // subject values in this same render, so it's always in sync.
          acceptRelationshipSnapshot: acceptRelationshipSnapshot && preview.relationshipSummary !== null,
        }),
      });
      const payload = await response.json() as SaveResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "The interaction could not be saved.");
      setResult(payload);
      setStatus("saved");
      if (returnTo) window.location.assign(returnTo);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The interaction could not be saved.");
      setStatus("error");
    }
  }

  function reset() {
    setNote(initialActivity?.note ?? "");
    setSubject(initialActivity?.subject ?? "");
    setSelectedKind(initialActivity?.kind ?? initialKind);
    setReminder(initialActivity?.reminderDate ? "custom" : "none");
    setCustomDate(initialActivity?.reminderDate ?? "");
    setOccurredAt(initialActivity ? toLocalDateTimeValue(new Date(initialActivity.occurredAt)) : toLocalDateTimeValue(new Date()));
    setErrorMessage("");
    setAcceptRelationshipSnapshot(false);
    setResult(null);
    setStatus("idle");
  }

  if (sharedStatus === "saved" && sharedResult) {
    return (
      <main className="capture-page capture-success">
        <div className="success-mark">✓</div>
        <p className="eyebrow">SHARED ACTIVITY LOGGED</p>
        <h1>{role === "recipient" ? `Sent to ${sharedResult.recipientCount} donors` : `Logged with ${sharedResult.recipientCount} participants`}</h1>
        <p className="capture-lede">
          {interactionKindLabel(sharedKind)} on{" "}
          {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(sharedResult.occurredAt))}.
        </p>
        <section className="update-receipt" aria-label="Updated relationship surfaces">
          <article><span>↗</span><div><strong>{sharedResult.recipientCount} donor timelines updated</strong><p>Each linked donor's Last Contact was updated. {role === "recipient" ? "This does not, by itself, count as a substantive-contact touch -- reconnect suggestions are unaffected." : "This counts as a substantive contact, the same as any other logged interaction."}</p></div><b>Done</b></article>
          <article><span>✓</span><div><strong>No reminders were created</strong><p>Bulk outreach never auto-creates a follow-up. Add one from an individual donor's page if needed.</p></div><b>Done</b></article>
        </section>
        <div className="success-actions">
          <button onClick={resetShared}>Log another</button>
        </div>
      </main>
    );
  }

  if (status === "saved" && result) {
    return (
      <main className="capture-page capture-success">
        <div className="success-mark">✓</div>
        <p className="eyebrow">{editing ? "ACTIVITY UPDATED" : "INTERACTION CAPTURED"}</p>
        <h1>{result.extracted.subject || "Interaction Note"}</h1>
        <p className="capture-lede">
          {result.scheduled ? "Scheduled" : "Logged"} as {interactionKindLabel(result.extracted.type).toLowerCase()} on{" "}
          {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(result.occurredAt))}.
        </p>
        <section className="update-receipt" aria-label="Updated relationship surfaces">
          <article><span>↗</span><div><strong>{result.scheduled ? "Schedule updated" : "Timeline updated"}</strong><p>{result.scheduled ? "This activity is visible on Today and the donor timeline as scheduled work." : "The completed interaction and original note were added to the relationship history."}</p></div><b>Done</b></article>
          {!result.scheduled && result.relationshipUpdated && <article><span>◇</span><div><strong>Institutional memory updated</strong><p>{result.extracted.memory}</p></div><b>Done</b></article>}
          {!result.scheduled && result.relationshipUpdated && <article><span>✦</span><div><strong>Relationship snapshot refreshed</strong><p>{result.extracted.relationshipSummary}</p></div><b>Done</b></article>}
          {!result.scheduled && !result.relationshipUpdated && <article><span>✓</span><div><strong>Relationship snapshot unchanged</strong><p>The generated draft was not accepted, so it was not saved.</p></div><b>Done</b></article>}
          {result.reminderAt && (
            <article><span>◷</span><div><strong>Reminder created</strong><p>{result.extracted.nextAction}</p></div><b>Done</b></article>
          )}
        </section>
        <div className="success-actions">
          <a className="capture-primary" href={`/donors/${encodeURIComponent(donorId)}`}>View updated relationship <span>→</span></a>
          <button onClick={reset}>{editing ? "Edit again" : "Log another"}</button>
        </div>
      </main>
    );
  }

  return (
    <main className="capture-page">
      <header className="capture-header">
        <div>
          <p className="eyebrow">{editing ? "EDIT ACTIVITY" : "LOG INTERACTION"}</p>
          <h1>{editing ? "Correct the activity" : "What happened or is planned?"}</h1>
          <p className="capture-lede">A few natural words and the right date are enough. Everything else is inferred.</p>
        </div>
        <a href={donorId ? `/donors/${encodeURIComponent(donorId)}` : "/donors"} aria-label="Close interaction capture">×</a>
      </header>

      {!editing && (
        <div className="capture-mode-toggle" role="group" aria-label="Number of donors">
          <button type="button" className={entryMode === "single" ? "active" : ""} aria-pressed={entryMode === "single"} onClick={() => setEntryMode("single")}>Single donor</button>
          <button type="button" className={entryMode === "multiple" ? "active" : ""} aria-pressed={entryMode === "multiple"} onClick={() => setEntryMode("multiple")}>Multiple donors</button>
        </div>
      )}

      <div className="capture-layout">
      {entryMode === "single" ? <>
        <section className="capture-composer-card">
          <div className="capture-context">
            <div className="mini-avatar" style={{ background: "#d9e8df" }}>{activeDonor ? donorInitials({ displayName: activeDonor.name, primaryFirstName: activeDonor.primaryFirstName, lastName: activeDonor.lastName }) : "?"}</div>
            <div><strong>{activeDonor?.name || "Choose a donor"}</strong>{activeDonor && numericDonorCode({ donorCode: activeDonor.code }) && <span className="donor-code">{numericDonorCode({ donorCode: activeDonor.code })}</span>}<span>{nowLabel} · defaults to now</span></div>
            <DonorAutocomplete donors={donors} selectedId={donorId} onSelect={setDonorId} />
          </div>

          <div className="interaction-kind-picker" aria-label="Interaction type">
            {kinds.map((kind) => (
              <button
                className={activeKind === kind.value ? "active" : ""}
                key={kind.value}
                onClick={() => setSelectedKind(kind.value)}
                aria-pressed={activeKind === kind.value}
              >
                <span>{kind.icon}</span>{interactionKindLabel(kind.value)}
              </button>
            ))}
          </div>

          <label className="capture-field-label" htmlFor="interaction-note">Interaction note</label>
          <textarea
            id="interaction-note"
            autoFocus
            value={note}
            onChange={(event) => { setNote(event.target.value); setStatus("idle"); }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveInteraction();
            }}
            aria-describedby="capture-note-help"
          />
          <p className="field-help" id="capture-note-help">Names, dates, commitments, and relationship context are extracted automatically.</p>

          <div className="subject-row">
            <label htmlFor="interaction-subject">Subject <span>optional</span></label>
            <input id="interaction-subject" value={subject} placeholder={note.trim().length >= 4 ? preview.suggestedSubject : undefined} onChange={(event) => setSubject(event.target.value)} />
            {!subject && note.trim().length >= 4 && <small className="subject-suggestion">Suggested subject: {preview.suggestedSubject} <button type="button" onClick={() => setSubject(preview.suggestedSubject)}>Use suggestion</button></small>}
          </div>

          <div className="interaction-date-row">
            <label htmlFor="interaction-occurred-at">Date &amp; time</label>
            <input id="interaction-occurred-at" type="datetime-local" value={occurredAt} onChange={(event) => { setOccurredAt(event.target.value); setStatus("idle"); }} />
            <button type="button" onClick={() => setOccurredAt(toLocalDateTimeValue(new Date()))}>Now</button>
            {future && <small>Future activities remain scheduled until you log their outcome.</small>}
          </div>

          <fieldset className="reminder-picker">
            <legend>Reminder <span>optional</span></legend>
            <div>
              {([
                ["none", "None"],
                ["tomorrow", "Tomorrow"],
                ["next-week", "Next week"],
                ["custom", "Custom"],
              ] as Array<[ReminderChoice, string]>).map(([value, label]) => (
                <button
                  type="button"
                  className={reminder === value ? "active" : ""}
                  key={value}
                  onClick={() => setReminder(value)}
                  aria-pressed={reminder === value}
                >
                  {label}
                </button>
              ))}
            </div>
            {reminder === "custom" && (
              <input
                aria-label="Custom reminder date"
                type="date"
                min={initialNow.slice(0, 10)}
                value={customDate}
                onChange={(event) => setCustomDate(event.target.value)}
              />
            )}
          </fieldset>

          {note.trim().length >= 4 && (
            <div className="extraction-preview" aria-live="polite">
              <div className="extraction-heading"><span>✦</span><strong>Ready to save</strong><small>No other fields required</small></div>
              <div className="extraction-chips">
                <span>{interactionKindLabel(preview.type)}</span><span>{dateLabel}</span>
                {preview.commitments.length > 0 && <span>{preview.commitments.length} commitment{preview.commitments.length > 1 ? "s" : ""}</span>}
              </div>
              {/* Only ever offers a real fact to opt into -- never a generic
                  category label or boilerplate the user would have to
                  manually reject. See actionableRelationshipSnapshot's doc
                  comment: null here means nothing specific and
                  donor-relevant was actually found in this note. */}
              {!future && (preview.relationshipSummary
                ? <div className="relationship-snapshot-preview"><label><input type="checkbox" checked={acceptRelationshipSnapshot} onChange={(event) => setAcceptRelationshipSnapshot(event.target.checked)} /><span><strong>Use this relationship snapshot</strong><small>Nothing generated is saved unless you check this box.</small></span></label><p>{preview.relationshipSummary}</p></div>
                : <p className="relationship-snapshot-preview relationship-snapshot-empty">No meaningful relationship details detected.</p>)}
            </div>
          )}

          {status === "error" && <p className="capture-error">{errorMessage} Your note is still here—try again.</p>}
          <button className="capture-save" disabled={!ready || status === "saving"} onClick={saveInteraction}>
            {status === "saving" ? "Updating relationship…" : <>{editing ? "Save changes" : "Save interaction"} <span>⌘ ↵</span></>}
          </button>
          <p className="capture-assurance">{future ? "One save adds this to Today and the donor timeline as scheduled work." : "One save updates the timeline, relationship summary, memory, and follow-up."}</p>
        </section>

        <aside className="automation-panel">
          <p className="eyebrow">AUTOMATIC AFTER SAVE</p><h2>{future ? "Scheduled once. Ready everywhere." : "Captured once. Reused everywhere."}</h2>
          <p>{future ? "The activity stays scheduled until you record what actually happened." : "The original note remains the source of truth while Fundraising OS updates the relationship around it."}</p>
          <div className="automation-flow">
            {future ? <>
              <article><span>1</span><div><strong>Today or Upcoming</strong><p>Shown on the correct date for the signed-in fundraiser</p></div></article>
              <article><span>2</span><div><strong>Donor timeline</strong><p>Clearly labeled as scheduled, not completed</p></div></article>
              <article><span>3</span><div><strong>Outcome capture</strong><p>Ready to log the completed interaction afterward</p></div></article>
              <article><span>4</span><div><strong>Optional reminder</strong><p>Created only when you request one</p></div></article>
            </> : <>
              <article><span>1</span><div><strong>Timeline</strong><p>Interaction, type, subject, and selected date and time</p></div></article>
              <article><span>2</span><div><strong>Institutional memory</strong><p>Durable personal and relationship context</p></div></article>
              <article><span>3</span><div><strong>Relationship snapshot</strong><p>Discussion topics, commitments, relationship changes, and the next useful action</p></div></article>
              <article><span>4</span><div><strong>Reminder or next action</strong><p>Only when requested or a commitment is detected</p></div></article>
            </>}
          </div>
          <div className="trust-note"><span>✓</span><p><strong>No duplicate entry.</strong> {future ? "The planned activity remains separate from the completed outcome you log later." : "Fundraising OS keeps the original note and records every inferred update."}</p></div>
        </aside>
      </> : (
        <section className="capture-composer-card capture-shared-composer">
          <p className="eyebrow">SHARED ACTIVITY</p>
          <h2>One activity, multiple donors</h2>
          <p className="field-help">Log this once. Every selected donor gets their own timeline entry and Last Contact update, but the note and date are stored once.</p>

          <div className="interaction-kind-picker" aria-label="Interaction type">
            {kinds.map((kind) => (
              <button
                className={sharedKind === kind.value ? "active" : ""}
                key={kind.value}
                onClick={() => setSelectedKind(kind.value)}
                aria-pressed={sharedKind === kind.value}
              >
                <span>{kind.icon}</span>{interactionKindLabel(kind.value)}
              </button>
            ))}
          </div>

          <fieldset className="role-picker">
            <legend>Role for every selected donor</legend>
            <div className="role-picker-options">
              <button type="button" className={role === "recipient" ? "active" : ""} aria-pressed={role === "recipient"} onClick={() => setRoleOverride("recipient")}>
                Recipients<small>Sent a text, email, or update. Updates Last Contact; does not suppress "needs outreach" suggestions.</small>
              </button>
              <button type="button" className={role === "participant" ? "active" : ""} aria-pressed={role === "participant"} onClick={() => setRoleOverride("participant")}>
                Participants<small>Actively took part in a meeting or call. Counts as substantive contact, same as any other interaction.</small>
              </button>
            </div>
          </fieldset>

          <RecipientPicker donors={donors} selectedIds={recipientIds} onChange={setRecipientIds} maxRecipients={MAX_SHARED_RECIPIENTS} />

          <label className="capture-field-label" htmlFor="shared-summary">Summary / notes</label>
          <textarea
            id="shared-summary"
            value={sharedSummary}
            onChange={(event) => { setSharedSummary(event.target.value); setSharedStatus("idle"); }}
          />
          <p className="field-help">This exact text is shown on every selected donor's timeline. Editing it later updates all of them at once.</p>

          <div className="interaction-date-row">
            <label htmlFor="shared-occurred-at">Date &amp; time</label>
            <input id="shared-occurred-at" type="datetime-local" value={sharedOccurredAt} onChange={(event) => { setSharedOccurredAt(event.target.value); setSharedStatus("idle"); }} />
            <button type="button" onClick={() => setSharedOccurredAt(toLocalDateTimeValue(new Date()))}>Now</button>
          </div>

          {sharedStatus === "error" && <p className="capture-error">{sharedErrorMessage} Your note is still here—try again.</p>}

          {showLargeConfirm && (
            <div className="large-selection-confirm">
              <p>You're about to log this touchpoint for {recipientIds.length} donors. Continue?</p>
              <div>
                <button type="button" onClick={() => setShowLargeConfirm(false)}>Cancel</button>
                <button type="button" className="danger-button" onClick={() => saveSharedActivity(true)}>Log for {recipientIds.length} donors</button>
              </div>
            </div>
          )}

          <button className="capture-save" disabled={!sharedReady || sharedStatus === "saving"} onClick={() => saveSharedActivity(false)}>
            {sharedStatus === "saving" ? "Saving…" : "Save once"}
          </button>
          <p className="capture-assurance">No reminder is created automatically for any recipient -- add one from an individual donor's page afterward if needed.</p>
        </section>
      )}
      </div>
    </main>
  );
}
