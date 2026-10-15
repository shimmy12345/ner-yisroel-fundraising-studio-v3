"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { DonorAutocomplete } from "../../capture/DonorAutocomplete";
import { donorNavigationHref, meetingBriefNavigationHref } from "../../../lib/navigation/donor-navigation";
import type { DonorSearchRecord } from "../../../lib/relationships/donor-search";
import type { TripRecord, TripProspectRecord } from "../../../lib/relationships/trips-data";
import { TRIP_PROSPECT_STATUSES, timezoneForState, type TripProspectStatus, type RegionCandidateDonor } from "../../../lib/relationships/trip-model";

const STATUS_LABELS: Record<TripProspectStatus, string> = {
  not_contacted: "Not Contacted", contacted: "Contacted", meeting_requested: "Meeting Requested",
  meeting_scheduled: "Meeting Scheduled", meeting_completed: "Meeting Completed", declined: "Declined", unable_to_schedule: "Unable to Schedule",
};
const SUMMARY_STATUSES: readonly TripProspectStatus[] = ["not_contacted", "contacted", "meeting_requested", "meeting_scheduled", "meeting_completed", "declined", "unable_to_schedule"];
const NEEDING_ATTENTION: ReadonlySet<TripProspectStatus> = new Set(["not_contacted", "meeting_requested"]);

// Trip start/end are plain calendar dates (no meaningful time-of-day or
// destination timezone -- see the trips schema's own header comment),
// so these two stay UTC-anchored exactly as before.
const dateLabel = (epoch: number) => new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Independent-review correction (2026-10-15): a specific meeting time IS
// a real instant, and MUST be displayed/edited in the donor's own
// destination timezone (timezoneForState(), resolved per-prospect from
// the donor's own state) -- never the browser's ambient zone, which is
// what `new Date(...).toLocaleString()`/`.getHours()` etc. would silently
// use instead. `Intl.DateTimeFormat`'s own explicit `timeZone` option is
// what makes this correct, matching the exact pattern lib/workspace/
// scheduled-activity.ts's own `localDay()` already uses elsewhere in
// this codebase.
function dateTimeLabelInZone(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(epoch * 1000));
}
// Builds a `<input type="datetime-local">` value (`YYYY-MM-DDTHH:mm`)
// representing `epoch` as WALL-CLOCK TIME IN `timezone`, via
// Intl.DateTimeFormat's own part extraction -- never a Date object's
// own local getters, which read the browser's zone instead.
function toDateTimeInputValueInZone(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(epoch * 1000));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = part("hour") === "24" ? "00" : part("hour");
  return `${part("year")}-${part("month")}-${part("day")}T${hour}:${part("minute")}`;
}

async function patchProspect(tripId: string, prospectId: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospectId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "That change could not be saved.");
}

export function TripDashboardExperience({ trip, prospects, newlyMatchingDonors, allDonors, fundraiserTimezone }: {
  trip: TripRecord; prospects: TripProspectRecord[]; newlyMatchingDonors: RegionCandidateDonor[]; allDonors: DonorSearchRecord[]; fundraiserTimezone: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [addQuery, setAddQuery] = useState("");
  const [busyProspectId, setBusyProspectId] = useState<string | null>(null);

  const counts = useMemo(() => {
    const byStatus = new Map<TripProspectStatus, number>();
    for (const status of SUMMARY_STATUSES) byStatus.set(status, 0);
    for (const prospect of prospects) byStatus.set(prospect.status, (byStatus.get(prospect.status) ?? 0) + 1);
    return byStatus;
  }, [prospects]);
  const needingAttention = prospects.filter((prospect) => NEEDING_ATTENTION.has(prospect.status)).length;

  function refresh() { router.refresh(); }

  async function withBusy(prospectId: string, action: () => Promise<void>) {
    setBusyProspectId(prospectId);
    setError(null);
    try { await action(); refresh(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "That change could not be saved."); }
    finally { setBusyProspectId(null); }
  }

  async function addDonor(donorId: string) {
    setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(trip.id)}/prospects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ donorId }) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "This donor could not be added.");
      setAddQuery("");
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This donor could not be added.");
    }
  }

  async function removeDonor(prospectId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this trip? Their donor record is never affected.`)) return;
    await withBusy(prospectId, async () => {
      const response = await fetch(`/api/trips/${encodeURIComponent(trip.id)}/prospects/${encodeURIComponent(prospectId)}`, { method: "DELETE" });
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as { error?: string }; throw new Error(payload.error ?? "Could not remove this prospect."); }
    });
  }

  return <>
    <header className="page-header travel-planning-header">
      <div>
        <p className="eyebrow">{trip.destinationRegionLabel ?? "No region selected"} &middot; <span className={`travel-planning-status-badge status-${trip.status}`}>{trip.status}</span></p>
        <h1>{trip.name}</h1>
        <p className="subhead">{dateLabel(trip.startDate)} &ndash; {dateLabel(trip.endDate)}{trip.goalCents != null ? ` · Goal: ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(trip.goalCents / 100)}` : ""}</p>
        {trip.notes && <p className="travel-planning-trip-notes">{trip.notes}</p>}
      </div>
      <TripStatusControl tripId={trip.id} currentStatus={trip.status} onChanged={refresh} />
    </header>

    {error && <p className="travel-planning-error" role="alert">{error}</p>}

    <section className="travel-planning-dashboard" aria-label="Trip dashboard">
      <div className="travel-planning-dashboard-grid">
        <article><strong>{prospects.length}</strong><span>Total prospects</span></article>
        {SUMMARY_STATUSES.map((status) => <article key={status}><strong>{counts.get(status) ?? 0}</strong><span>{STATUS_LABELS[status]}</span></article>)}
        <article className="travel-planning-attention"><strong>{needingAttention}</strong><span>Needing outreach</span></article>
      </div>
      <p className="travel-planning-financial-note">Financial figures below are kept separate by design -- historical giving, open pledges, outstanding asks, and projected opportunities are never added together into one total.</p>
    </section>

    {newlyMatchingDonors.length > 0 && <section className="travel-planning-new-prospects" aria-label="New prospects available">
      <h2>New prospects available</h2>
      <p>These donors now match {trip.destinationRegionLabel} but were not on this trip when it was created. Add them if you&rsquo;d like -- they are never inserted automatically.</p>
      <ul>
        {newlyMatchingDonors.map((donor) => <li key={donor.id}>
          <span>{donor.displayName} &mdash; {[donor.city, donor.state].filter(Boolean).join(", ")}</span>
          <button type="button" onClick={() => addDonor(donor.id)}>Add to trip</button>
        </li>)}
      </ul>
    </section>}

    <section className="travel-planning-add-prospect" aria-label="Add a donor manually">
      <h2>Add a donor manually</h2>
      <DonorAutocomplete donors={allDonors} selectedId="" onSelect={(id) => { if (id) addDonor(id); }} initialQuery={addQuery} onQueryChange={setAddQuery} clearable inputId="trip-add-donor" label="Search any donor in the CRM" placeholder="Search last name, household, spouse, JL code, email, or phone" />
    </section>

    <section className="travel-planning-prospects" aria-label="Trip prospects">
      <h2>Prospects ({prospects.length})</h2>
      {prospects.length === 0 && <p className="travel-planning-empty-inline">No prospects yet. {trip.destinationRegionId ? "" : "This trip has no destination region, so add donors manually above."}</p>}
      {prospects.map((prospect) => <ProspectRow key={prospect.id} tripId={trip.id} prospect={prospect} busy={busyProspectId === prospect.id} fundraiserTimezone={fundraiserTimezone} onBusyAction={(action) => withBusy(prospect.id, action)} onRemove={() => removeDonor(prospect.id, prospect.donorDisplayName)} />)}
    </section>
  </>;
}

function TripStatusControl({ tripId, currentStatus, onChanged }: { tripId: string; currentStatus: string; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  async function change(status: string) {
    setSaving(true);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
      if (response.ok) onChanged();
    } finally { setSaving(false); }
  }
  return <select className="travel-planning-trip-status-select" value={currentStatus} disabled={saving} onChange={(event) => change(event.target.value)} aria-label="Trip status">
    <option value="planning">Planning</option>
    <option value="active">Active</option>
    <option value="completed">Completed</option>
    <option value="cancelled">Cancelled</option>
  </select>;
}

function ProspectRow({ tripId, prospect, busy, fundraiserTimezone, onBusyAction, onRemove }: {
  tripId: string; prospect: TripProspectRecord; busy: boolean; fundraiserTimezone: string; onBusyAction: (action: () => Promise<void>) => void; onRemove: () => void;
}) {
  // The donor's OWN destination timezone (independent-review correction,
  // 2026-10-15) -- never the browser's. Falls back to the fundraiser's
  // own home timezone only when this donor has no state on file.
  const timezone = timezoneForState(prospect.donorState, fundraiserTimezone);
  const [notesDraft, setNotesDraft] = useState(prospect.trip_notes ?? "");
  const [nextActionDraft, setNextActionDraft] = useState(prospect.nextAction ?? "");
  const [scheduling, setScheduling] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [meetingAtDraft, setMeetingAtDraft] = useState(prospect.meetingAt ? toDateTimeInputValueInZone(prospect.meetingAt, timezone) : "");
  const [locationDraft, setLocationDraft] = useState(prospect.meetingLocation ?? "");
  const [completionNotesDraft, setCompletionNotesDraft] = useState("");
  const returnTo = typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}${window.location.hash}` : `/travel-planning/${tripId}`;

  function changeStatus(status: TripProspectStatus) {
    if (status === "meeting_scheduled") { setScheduling(true); setCompleting(false); return; }
    if (status === "meeting_completed") { setCompleting(true); setScheduling(false); return; }
    onBusyAction(() => patchProspect(tripId, prospect.id, { status }));
  }

  // Sends the RAW `datetime-local` text as `meetingAtLocal` -- the
  // server resolves it to a real UTC epoch using this exact donor's
  // destination timezone (trips-data.ts's resolveMeetingEpoch()), never
  // a client-side Date() parse in the browser's own zone.
  function confirmScheduling() {
    if (!meetingAtDraft) return;
    onBusyAction(async () => { await patchProspect(tripId, prospect.id, { status: "meeting_scheduled", meetingAtLocal: meetingAtDraft, meetingLocation: locationDraft || null, confirmScheduling: true }); setScheduling(false); });
  }

  // Requires an explicit, non-empty date -- never silently defaults to
  // "right now" on the fundraiser's behalf. The input is pre-filled from
  // an existing scheduled meeting (if any) via the `meetingAtDraft`
  // state initializer above; a prospect jumping straight to "Meeting
  // Completed" with no prior scheduled meeting sees a genuinely empty
  // field and must enter the real date themselves, matching "must
  // require ... an actual meeting date" literally rather than guessing
  // one when the field is left blank.
  function confirmCompletion() {
    if (!meetingAtDraft || completionNotesDraft.trim().length < 2) return;
    onBusyAction(async () => { await patchProspect(tripId, prospect.id, { status: "meeting_completed", meetingAtLocal: meetingAtDraft, completionNotes: completionNotesDraft, confirmCompletion: true }); setCompleting(false); });
  }

  function saveFields() {
    onBusyAction(() => patchProspect(tripId, prospect.id, { tripNotes: notesDraft || null, nextAction: nextActionDraft || null }));
  }

  return <article className={`travel-planning-prospect-row${busy ? " busy" : ""}`}>
    <div className="travel-planning-prospect-heading">
      <a href={donorNavigationHref(prospect.donorId, returnTo, "travel-planning")}><strong>{prospect.donorDisplayName}</strong></a>
      <span className={`travel-planning-added-method ${prospect.addedMethod}`}>{prospect.addedMethod === "auto_region" ? "Auto-suggested" : "Manually added"}</span>
      <select value={prospect.status} disabled={busy} onChange={(event) => changeStatus(event.target.value as TripProspectStatus)}>
        {TRIP_PROSPECT_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
      </select>
      <a className="travel-planning-prepare-link" href={meetingBriefNavigationHref(prospect.donorId, returnTo, "travel-planning")}>Prepare for Meeting →</a>
      <button type="button" className="travel-planning-remove" disabled={busy} onClick={onRemove}>Remove</button>
    </div>

    {prospect.crossTripConflicts.length > 0 && <p className="travel-planning-conflict-caution">⚠ Also {prospect.crossTripConflicts[0].status === "meeting_scheduled" ? "has a meeting scheduled" : "has a meeting requested"} on &ldquo;{prospect.crossTripConflicts[0].tripName}&rdquo;{prospect.crossTripConflicts[0].meetingAt ? ` (${dateTimeLabelInZone(prospect.crossTripConflicts[0].meetingAt, timezone)})` : ""}. This does not block adding them here.</p>}

    <p className="travel-planning-suggested-reason">
      {prospect.suggestedReason ?? "No specific evidence on file."}
      {prospect.suggestedGeneratedAt && <small> — suggested {dateLabel(prospect.suggestedGeneratedAt)}{prospect.suggestedScore != null ? `, evidence score ${prospect.suggestedScore.toFixed(2)}` : ""}. Current CRM status may have changed since -- see Prepare for Meeting for up-to-date detail.</small>}
    </p>

    {prospect.meetingAt && !scheduling && !completing && <p className="travel-planning-meeting-time">{prospect.status === "meeting_completed" ? "Met" : "Meeting"} {dateTimeLabelInZone(prospect.meetingAt, timezone)} ({timezone}){prospect.meetingLocation ? ` at ${prospect.meetingLocation}` : ""}.</p>}

    {scheduling && <div className="travel-planning-confirm-panel">
      <label>Meeting date &amp; time -- local time at destination ({timezone})<input type="datetime-local" value={meetingAtDraft} onChange={(event) => setMeetingAtDraft(event.target.value)} /></label>
      <label>Location (optional)<input type="text" value={locationDraft} onChange={(event) => setLocationDraft(event.target.value)} maxLength={300} /></label>
      <p className="travel-planning-confirm-hint">This creates a real scheduled interaction on this donor&rsquo;s timeline.</p>
      <div className="travel-planning-confirm-actions"><button type="button" onClick={confirmScheduling} disabled={!meetingAtDraft}>Confirm scheduled meeting</button><button type="button" onClick={() => setScheduling(false)}>Cancel</button></div>
    </div>}

    {completing && <div className="travel-planning-confirm-panel">
      <label>Actual meeting date &amp; time -- local time at destination ({timezone})<input type="datetime-local" value={meetingAtDraft || (prospect.meetingAt ? toDateTimeInputValueInZone(prospect.meetingAt, timezone) : "")} onChange={(event) => setMeetingAtDraft(event.target.value)} /></label>
      <label>Meeting notes (required)<textarea value={completionNotesDraft} onChange={(event) => setCompletionNotesDraft(event.target.value)} maxLength={5000} placeholder="What happened, decisions made, any commitments" /></label>
      <p className="travel-planning-confirm-hint">This records a real completed interaction on this donor&rsquo;s timeline -- the same place every other logged meeting lives.</p>
      <div className="travel-planning-confirm-actions"><button type="button" onClick={confirmCompletion} disabled={!meetingAtDraft || completionNotesDraft.trim().length < 2}>Confirm meeting completed</button><button type="button" onClick={() => setCompleting(false)}>Cancel</button></div>
    </div>}

    <div className="travel-planning-prospect-fields">
      <label>Trip notes<textarea value={notesDraft} onChange={(event) => setNotesDraft(event.target.value)} onBlur={saveFields} maxLength={5000} placeholder="Notes specific to this trip" /></label>
      <label>Next action<input type="text" value={nextActionDraft} onChange={(event) => setNextActionDraft(event.target.value)} onBlur={saveFields} maxLength={500} placeholder="e.g. Call to confirm Tuesday" /></label>
    </div>
  </article>;
}
