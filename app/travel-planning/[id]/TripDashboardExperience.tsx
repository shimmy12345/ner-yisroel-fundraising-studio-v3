"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { donorNavigationHref, meetingBriefNavigationHref } from "../../../lib/navigation/donor-navigation";
import { searchDonors } from "../../../lib/relationships/donor-search";
import { ALL_REGIONS, ALL_CITIES, filterByGeo } from "../../../lib/relationships/donor-geo-filter";
import { numericDonorCode } from "../../../lib/relationships/donor-identity";
import type { TripRecord, TripProspectRecord, TripFinancialAttributionRow, EligibleGivingActivity, FindProspectDonor } from "../../../lib/relationships/trips-data";
import type { TripFinancialSummary } from "../../../lib/relationships/trip-financial-attribution";
import { DEFAULT_MEETING_DURATION_MINUTES, TRIP_PROSPECT_STATUSES, timezoneForState, type TripProspectStatus } from "../../../lib/relationships/trip-model";
import { FinancialSummaryCard, FinancialSummaryGrid } from "../../components/FinancialSummaryCard";
import { ProgressBar } from "../../components/ProgressBar";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const CATEGORY_LABELS: Record<string, string> = {
  open_pledge: "Pledge", partially_paid_pledge: "Pledge (partially paid)", completed_gift: "Donation",
  pending_gift: "Pending donation", pending_pledge: "Pending pledge",
};

// "Planned outreach" (Section 2) reuses the existing `not_contacted`
// status with a clearer display label -- it means "added, intended to
// contact, not yet contacted," never a separate schema value.
const STATUS_LABELS: Record<TripProspectStatus, string> = {
  not_contacted: "Planned outreach", contacted: "Contacted", meeting_requested: "Meeting Requested",
  meeting_scheduled: "Meeting Scheduled", meeting_completed: "Meeting Completed", declined: "Declined", unable_to_schedule: "Unable to Schedule",
};
const SUMMARY_STATUSES: readonly TripProspectStatus[] = ["not_contacted", "contacted", "meeting_requested", "meeting_scheduled", "meeting_completed", "declined", "unable_to_schedule"];
const NEEDING_ATTENTION: ReadonlySet<TripProspectStatus> = new Set(["not_contacted", "meeting_requested"]);
const VALID_STATUS_FILTERS = new Set<string>(TRIP_PROSPECT_STATUSES);

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

// Deliberate Prospect Selection (2026-10-18) -- tab/search/filter state
// round-trips through the URL (never just React state), so it survives
// both a routine `router.refresh()` (which it would anyway, since this
// component's own local state is preserved across a refresh the same
// way `addQuery` always was) AND a full navigation away to a donor
// profile and back, via the SAME `from=` mechanism
// app/donors/page.tsx's own region/city filters already rely on --
// `donorNavigationHref` captures `window.location` (pathname + search +
// hash) at the moment a donor link is clicked, so whatever this
// function has already written into the URL comes back automatically.
function syncUrl(updates: Record<string, string>) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function matchesProspectQuery(prospect: TripProspectRecord, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return prospect.donorDisplayName.toLocaleLowerCase().includes(needle) || (prospect.donorCode ?? "").toLocaleLowerCase().includes(needle);
}

export function TripDashboardExperience({
  trip, prospects, findProspectDonors, fundraiserTimezone, financialAttributions, financialSummary,
  initialTab, initialProspectQuery, initialStatusFilter, initialFindQuery, initialAllRegions,
}: {
  trip: TripRecord; prospects: TripProspectRecord[]; findProspectDonors: FindProspectDonor[]; fundraiserTimezone: string;
  financialAttributions: TripFinancialAttributionRow[]; financialSummary: TripFinancialSummary;
  initialTab: "mine" | "find"; initialProspectQuery: string; initialStatusFilter: string; initialFindQuery: string; initialAllRegions: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busyProspectId, setBusyProspectId] = useState<string | null>(null);
  const [busyDonorId, setBusyDonorId] = useState<string | null>(null);

  const [tab, setTab] = useState<"mine" | "find">(initialTab);
  const [prospectQuery, setProspectQuery] = useState(initialProspectQuery);
  const [statusFilter, setStatusFilter] = useState<TripProspectStatus | "all">(VALID_STATUS_FILTERS.has(initialStatusFilter) ? (initialStatusFilter as TripProspectStatus) : "all");
  const [findQuery, setFindQuery] = useState(initialFindQuery);
  const [allRegions, setAllRegions] = useState(initialAllRegions);

  function changeTab(next: "mine" | "find") { setTab(next); syncUrl({ tab: next === "find" ? "find" : "" }); }
  function changeProspectQuery(next: string) { setProspectQuery(next); syncUrl({ q: next }); }
  function changeStatusFilter(next: TripProspectStatus | "all") { setStatusFilter(next); syncUrl({ status: next === "all" ? "" : next }); }
  function changeFindQuery(next: string) { setFindQuery(next); syncUrl({ findQ: next }); }
  function changeAllRegions(next: boolean) { setAllRegions(next); syncUrl({ allRegions: next ? "1" : "" }); }

  // Full-trip counts (Section 3): always over EVERY selected prospect,
  // never the filtered subset -- these drive the summary grid and must
  // never shift just because the owner typed into the search box.
  const counts = useMemo(() => {
    const byStatus = new Map<TripProspectStatus, number>();
    for (const status of SUMMARY_STATUSES) byStatus.set(status, 0);
    for (const prospect of prospects) byStatus.set(prospect.status, (byStatus.get(prospect.status) ?? 0) + 1);
    return byStatus;
  }, [prospects]);
  const needingAttention = prospects.filter((prospect) => NEEDING_ATTENTION.has(prospect.status)).length;

  const filteredProspects = useMemo(
    () => prospects.filter((prospect) => (statusFilter === "all" || prospect.status === statusFilter) && matchesProspectQuery(prospect, prospectQuery)),
    [prospects, statusFilter, prospectQuery],
  );
  const prospectsFiltering = statusFilter !== "all" || prospectQuery.trim().length > 0;

  // Find prospects (Section 4): region + text search composed over the
  // SAME full donor list, via the exact same filterByGeo()/searchDonors()
  // the donor directory uses -- never truncated, never a second search
  // implementation.
  const effectiveRegion = allRegions || !trip.destinationRegionId ? ALL_REGIONS : trip.destinationRegionId;
  // searchDonors() (lib/relationships/donor-search.ts) is typed over the
  // plain DonorSearchRecord shape, so its result loses the extra
  // alreadySelected/existingProspectId/city/state fields at the type
  // level even though they still exist at runtime -- resolved back to
  // the full FindProspectDonor by id, exactly like
  // DonorDirectoryExperience.tsx's own `relationshipById.get(...)`
  // pattern, rather than widening the shared search utility's signature.
  const findProspectDonorById = useMemo(() => new Map(findProspectDonors.map((donor) => [donor.id, donor])), [findProspectDonors]);
  const regionFiltered = useMemo(() => filterByGeo(findProspectDonors, effectiveRegion, ALL_CITIES), [findProspectDonors, effectiveRegion]);
  const findResults = useMemo(
    () => searchDonors(regionFiltered, findQuery, Number.MAX_SAFE_INTEGER).map((donor) => findProspectDonorById.get(donor.id)!),
    [regionFiltered, findQuery, findProspectDonorById],
  );
  const findScopeLabel = trip.destinationRegionId && !allRegions ? (trip.destinationRegionLabel ?? "the destination region") : "all regions";

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
    setBusyDonorId(donorId);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(trip.id)}/prospects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ donorId }) });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "This donor could not be added.");
      refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This donor could not be added.");
    } finally {
      setBusyDonorId(null);
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
        <article><strong>{prospects.length}</strong><span>Selected prospects</span></article>
        {SUMMARY_STATUSES.map((status) => <article key={status}><strong>{counts.get(status) ?? 0}</strong><span>{STATUS_LABELS[status]}</span></article>)}
        <article className="travel-planning-attention"><strong>{needingAttention}</strong><span>Needing outreach</span></article>
      </div>
      <p className="travel-planning-financial-note">Financial figures below are kept separate by design -- historical giving, open pledges, outstanding asks, and projected opportunities are never added together into one total.</p>
    </section>

    <TripFinancialResultsSection summary={financialSummary} attributions={financialAttributions} />

    <nav className="portfolio-focus-filters travel-planning-tabs" aria-label="Trip prospect views">
      <button type="button" className={tab === "mine" ? "active" : ""} aria-pressed={tab === "mine"} onClick={() => changeTab("mine")}>My trip prospects<span>{prospects.length}</span></button>
      <button type="button" className={tab === "find" ? "active" : ""} aria-pressed={tab === "find"} onClick={() => changeTab("find")}>Find prospects</button>
    </nav>

    {tab === "mine" ? <MyTripProspectsPanel
      trip={trip} prospects={prospects} filteredProspects={filteredProspects} filtering={prospectsFiltering}
      prospectQuery={prospectQuery} onProspectQueryChange={changeProspectQuery}
      statusFilter={statusFilter} onStatusFilterChange={changeStatusFilter}
      busyProspectId={busyProspectId} fundraiserTimezone={fundraiserTimezone}
      onBusyAction={withBusy} onRemove={removeDonor} financialAttributions={financialAttributions} onRefresh={refresh}
      onFindProspects={() => changeTab("find")}
    /> : <FindProspectsPanel
      trip={trip} results={findResults} resultCount={findResults.length} totalCount={findProspectDonors.length}
      findQuery={findQuery} onFindQueryChange={changeFindQuery} allRegions={allRegions} onAllRegionsChange={changeAllRegions}
      findScopeLabel={findScopeLabel} busyDonorId={busyDonorId} onAdd={addDonor}
    />}
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

// "My trip prospects" (Section 3) -- only deliberately selected
// prospects (already filtered server-side), with its own name/code
// search and status filter layered on client-side. Full-trip counts
// (the summary grid above, and `prospects.length` here) are always
// computed over the unfiltered array; only the LIST itself narrows.
function MyTripProspectsPanel({
  trip, prospects, filteredProspects, filtering, prospectQuery, onProspectQueryChange, statusFilter, onStatusFilterChange,
  busyProspectId, fundraiserTimezone, onBusyAction, onRemove, financialAttributions, onRefresh, onFindProspects,
}: {
  trip: TripRecord; prospects: TripProspectRecord[]; filteredProspects: TripProspectRecord[]; filtering: boolean;
  prospectQuery: string; onProspectQueryChange: (value: string) => void;
  statusFilter: TripProspectStatus | "all"; onStatusFilterChange: (value: TripProspectStatus | "all") => void;
  busyProspectId: string | null; fundraiserTimezone: string;
  onBusyAction: (prospectId: string, action: () => Promise<void>) => void; onRemove: (prospectId: string, name: string) => void;
  financialAttributions: TripFinancialAttributionRow[]; onRefresh: () => void; onFindProspects: () => void;
}) {
  return <section className="travel-planning-prospects" aria-label="My trip prospects">
    <div className="travel-planning-prospect-filters">
      <label>Search<input type="text" value={prospectQuery} onChange={(event) => onProspectQueryChange(event.target.value)} placeholder="Search name or JL code" /></label>
      <label>Status<select value={statusFilter} onChange={(event) => onStatusFilterChange(event.target.value as TripProspectStatus | "all")}>
        <option value="all">All statuses</option>
        {TRIP_PROSPECT_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
      </select></label>
    </div>

    <p className="travel-planning-filtered-count">
      {filtering ? `Showing ${filteredProspects.length} of ${prospects.length} prospect${prospects.length === 1 ? "" : "s"}.` : `${prospects.length} prospect${prospects.length === 1 ? "" : "s"}.`}
    </p>

    {prospects.length === 0 && <div className="travel-planning-empty-inline">
      <p>No one is selected for this trip yet.</p>
      <button type="button" onClick={onFindProspects}>Find prospects to add</button>
    </div>}
    {prospects.length > 0 && filteredProspects.length === 0 && <p className="travel-planning-empty-inline">No selected prospects match this search or filter.</p>}

    {filteredProspects.map((prospect) => <ProspectRow key={prospect.id} tripId={trip.id} prospect={prospect} busy={busyProspectId === prospect.id} fundraiserTimezone={fundraiserTimezone} onBusyAction={(action) => onBusyAction(prospect.id, action)} onRemove={() => onRemove(prospect.id, prospect.donorDisplayName)} attributions={financialAttributions.filter((a) => a.donorId === prospect.donorId)} onRefresh={onRefresh} />)}
  </section>;
}

// "Find prospects" (Sections 1 & 4) -- regional candidates (default) or
// every donor (explicit "Search all regions" exception), searched with
// the exact same matching donor search already uses everywhere else.
// Never auto-selected -- only the explicit "Add to trip" button writes
// anything.
function FindProspectsPanel({
  trip, results, resultCount, totalCount, findQuery, onFindQueryChange, allRegions, onAllRegionsChange, findScopeLabel, busyDonorId, onAdd,
}: {
  trip: TripRecord; results: FindProspectDonor[]; resultCount: number; totalCount: number;
  findQuery: string; onFindQueryChange: (value: string) => void; allRegions: boolean; onAllRegionsChange: (value: boolean) => void;
  findScopeLabel: string; busyDonorId: string | null; onAdd: (donorId: string) => void;
}) {
  return <section className="travel-planning-find-prospects" aria-label="Find prospects">
    <p className="travel-planning-find-intro">Search {trip.destinationRegionId ? "donors in this trip's region" : "any donor"} and add the ones you actually plan to reach out to. Nothing here is added until you choose it.</p>
    <div className="directory-filters travel-planning-find-filters" role="group" aria-label="Find prospects filters">
      <label className="directory-filter travel-planning-find-search">
        <span>Search</span>
        <input type="text" value={findQuery} onChange={(event) => onFindQueryChange(event.target.value)} placeholder="Search name, household, spouse, JL code, email, or phone" />
      </label>
      {trip.destinationRegionId && <label className="directory-filter travel-planning-all-regions-toggle">
        <span>Region</span>
        <span className="travel-planning-all-regions-checkbox"><input type="checkbox" checked={allRegions} onChange={(event) => onAllRegionsChange(event.target.checked)} /> Search all regions</span>
      </label>}
    </div>
    <p className="travel-planning-find-scope">Showing {resultCount} of {totalCount} donors in {findScopeLabel}{findQuery.trim() ? ` matching “${findQuery.trim()}”` : ""}.</p>

    {resultCount === 0 && <p className="travel-planning-empty-inline">No donors match. {findQuery.trim() ? "Clear the search to see candidates again." : "This trip's region has no matching donors yet."}</p>}

    <ul className="travel-planning-candidate-list">
      {results.map((donor) => <li key={donor.id} className={donor.alreadySelected ? "already-selected" : ""}>
        <span className="travel-planning-candidate-identity">
          <strong>{donor.name}</strong>{numericDonorCode({ donorCode: donor.code }) && <span className="donor-code">{numericDonorCode({ donorCode: donor.code })}</span>}
          <small>{[[donor.city, donor.state].filter(Boolean).join(", "), donor.spouse].filter(Boolean).join(" · ")}</small>
        </span>
        {donor.alreadySelected
          ? <span className="travel-planning-already-added">Already in My trip prospects</span>
          : <button type="button" disabled={busyDonorId === donor.id} onClick={() => onAdd(donor.id)}>Add to trip</button>}
      </li>)}
    </ul>
  </section>;
}

function ProspectRow({ tripId, prospect, busy, fundraiserTimezone, onBusyAction, onRemove, attributions, onRefresh }: {
  tripId: string; prospect: TripProspectRecord; busy: boolean; fundraiserTimezone: string; onBusyAction: (action: () => Promise<void>) => void; onRemove: () => void;
  attributions: TripFinancialAttributionRow[]; onRefresh: () => void;
}) {
  // The donor's OWN destination timezone (independent-review correction,
  // 2026-10-15) -- never the browser's. Falls back to the fundraiser's
  // own home timezone only when this donor has no state on file.
  const timezone = timezoneForState(prospect.donorState, fundraiserTimezone);
  const [notesDraft, setNotesDraft] = useState(prospect.trip_notes ?? "");
  const [nextActionDraft, setNextActionDraft] = useState(prospect.nextAction ?? "");
  const [scheduling, setScheduling] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [meetingAtDraft, setMeetingAtDraft] = useState(prospect.meetingAt ? toDateTimeInputValueInZone(prospect.meetingAt, timezone) : "");
  const [locationDraft, setLocationDraft] = useState(prospect.meetingLocation ?? "");
  const [durationDraft, setDurationDraft] = useState(String(DEFAULT_MEETING_DURATION_MINUTES));
  const [completionNotesDraft, setCompletionNotesDraft] = useState("");
  const [retryingCalendarSync, setRetryingCalendarSync] = useState(false);
  const returnTo = typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}${window.location.hash}` : `/travel-planning/${tripId}`;
  // Compact by default (Section 3): notes, next action, meeting
  // scheduling, and the financial panel only render once expanded, or
  // automatically while actively scheduling/completing a meeting so the
  // confirmation panel is never hidden.
  const showDetails = expanded || scheduling || completing;

  function changeStatus(status: TripProspectStatus) {
    if (status === "meeting_scheduled") { setScheduling(true); setCompleting(false); setExpanded(true); return; }
    if (status === "meeting_completed") { setCompleting(true); setScheduling(false); setExpanded(true); return; }
    onBusyAction(() => patchProspect(tripId, prospect.id, { status }));
  }

  // Sends the RAW `datetime-local` text as `meetingAtLocal` -- the
  // server resolves it to a real UTC epoch using this exact donor's
  // destination timezone (trips-data.ts's resolveMeetingEpoch()), never
  // a client-side Date() parse in the browser's own zone.
  function confirmScheduling() {
    if (!meetingAtDraft) return;
    const durationMinutes = Number(durationDraft);
    onBusyAction(async () => { await patchProspect(tripId, prospect.id, { status: "meeting_scheduled", meetingAtLocal: meetingAtDraft, meetingLocation: locationDraft || null, meetingDurationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : undefined, confirmScheduling: true }); setScheduling(false); });
  }

  // "Safe Retry" -- only re-attempts reconciling the already-recorded
  // calendar intent for this meeting; never changes the meeting itself.
  async function retryCalendarSync() {
    setRetryingCalendarSync(true);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospect.id)}/calendar-retry`, { method: "POST" });
      if (response.ok) onRefresh();
    } finally {
      setRetryingCalendarSync(false);
    }
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
      <span className={`travel-planning-added-method ${prospect.addedMethod}`}>{prospect.addedMethod === "auto_region" ? "Regional match" : "Added manually"}</span>
      <select value={prospect.status} disabled={busy} onChange={(event) => changeStatus(event.target.value as TripProspectStatus)}>
        {TRIP_PROSPECT_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}
      </select>
      <a className="travel-planning-prepare-link" href={meetingBriefNavigationHref(prospect.donorId, returnTo, "travel-planning")}>Prepare for Meeting →</a>
      <button type="button" className="travel-planning-details-toggle" aria-expanded={showDetails} onClick={() => setExpanded((current) => !current)}>{showDetails ? "Hide details" : "Details"}</button>
      <button type="button" className="travel-planning-remove" disabled={busy} onClick={onRemove}>Remove</button>
    </div>

    {prospect.crossTripConflicts.length > 0 && <p className="travel-planning-conflict-caution">⚠ Also {prospect.crossTripConflicts[0].status === "meeting_scheduled" ? "has a meeting scheduled" : "has a meeting requested"} on &ldquo;{prospect.crossTripConflicts[0].tripName}&rdquo;{prospect.crossTripConflicts[0].meetingAt ? ` (${dateTimeLabelInZone(prospect.crossTripConflicts[0].meetingAt, timezone)})` : ""}. This does not block adding them here.</p>}

    <p className="travel-planning-suggested-reason">
      {prospect.suggestedReason ?? "No specific evidence on file."}
      {prospect.suggestedGeneratedAt && <small> — suggested {dateLabel(prospect.suggestedGeneratedAt)}{prospect.suggestedScore != null ? `, evidence score ${prospect.suggestedScore.toFixed(2)}` : ""}. Current CRM status may have changed since -- see Prepare for Meeting for up-to-date detail.</small>}
    </p>

    {prospect.meetingAt && !scheduling && !completing && <p className="travel-planning-meeting-time">
      {prospect.status === "meeting_completed" ? "Met" : "Meeting"} {dateTimeLabelInZone(prospect.meetingAt, timezone)} ({timezone}){prospect.meetingLocation ? ` at ${prospect.meetingLocation}` : ""}.
      {prospect.calendarSync && <CalendarSyncBadge calendarSync={prospect.calendarSync} busy={retryingCalendarSync} onRetry={retryCalendarSync} />}
    </p>}

    {showDetails && <>
      {scheduling && <div className="travel-planning-confirm-panel">
        <label>Meeting date &amp; time -- local time at destination ({timezone})<input type="datetime-local" value={meetingAtDraft} onChange={(event) => setMeetingAtDraft(event.target.value)} /></label>
        <label>Location (optional)<input type="text" value={locationDraft} onChange={(event) => setLocationDraft(event.target.value)} maxLength={300} /></label>
        <label>Duration (minutes)<input type="number" min={1} max={1440} step={1} value={durationDraft} onChange={(event) => setDurationDraft(event.target.value)} /></label>
        <p className="travel-planning-confirm-hint">This creates a real scheduled interaction on this donor&rsquo;s timeline and, if Google Calendar sync is enabled in Settings, a matching one-way calendar event.</p>
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

      <ProspectFinancialPanel tripId={tripId} prospectId={prospect.id} attributions={attributions} onRefresh={onRefresh} />
    </>}
  </article>;
}

// Minimal controls (2026-10-19, see docs/AI-HANDOFF.md): "Pending,
// Synced, or actionable failure, safe Retry, and View on Google Calendar
// when available." The collapsed three-state badge mirrors
// TripMeetingCalendarSummary's own collapsing of the full SyncStatus
// union -- a prospect with no calendarSync at all (never scheduled, or a
// status that creates nothing) renders nothing here.
function CalendarSyncBadge({ calendarSync, busy, onRetry }: { calendarSync: NonNullable<TripProspectRecord["calendarSync"]>; busy: boolean; onRetry: () => void }) {
  if (calendarSync.status === "synced") {
    return <span className="travel-planning-calendar-sync synced"> &middot; Synced to Google Calendar{calendarSync.viewUrl && <> (<a href={calendarSync.viewUrl} target="_blank" rel="noreferrer">View on Google Calendar</a>)</>}</span>;
  }
  if (calendarSync.status === "pending") {
    return <span className="travel-planning-calendar-sync pending"> &middot; Calendar sync pending</span>;
  }
  return <span className="travel-planning-calendar-sync failed"> &middot; Calendar sync failed <button type="button" className="travel-planning-calendar-retry" disabled={busy} onClick={onRetry}>{busy ? "Retrying…" : "Retry"}</button></span>;
}

// Trip Fundraising Results Dashboard (2026-10-16, see docs/AI-HANDOFF.md).
// Shows every record currently attributed to this prospect (figures read
// live from the server -- this component never computes a financial
// total itself) and the three actions the task calls for: record a new
// donation/pledge (via the existing pending-gift/pending-pledge CRM
// workflow, then attributed), or associate an already-real donation or
// pledge. Removing an attribution never touches the underlying financial
// record -- only this link.
function ProspectFinancialPanel({ tripId, prospectId, attributions, onRefresh }: {
  tripId: string; prospectId: string; attributions: TripFinancialAttributionRow[]; onRefresh: () => void;
}) {
  const [mode, setMode] = useState<"closed" | "record_donation" | "record_pledge" | "associate_existing">("closed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [designation, setDesignation] = useState("");
  const [note, setNote] = useState("");
  const [eligible, setEligible] = useState<EligibleGivingActivity[] | null>(null);
  const [selectedGivingActivityId, setSelectedGivingActivityId] = useState("");

  function openPanel(next: "record_donation" | "record_pledge" | "associate_existing") {
    setMode(next); setError(null); setAmount(""); setDate(""); setDesignation(""); setNote(""); setSelectedGivingActivityId("");
    if (next === "associate_existing") {
      setEligible(null);
      fetch(`/api/trips/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospectId)}/attributions`)
        .then((response) => response.json())
        .then((payload: { eligible?: EligibleGivingActivity[] }) => setEligible(payload.eligible ?? []))
        .catch(() => setEligible([]));
    }
  }

  async function submitRecord(action: "record_donation" | "record_pledge") {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospectId)}/attributions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, amount, date, designation: designation || undefined, note: note || undefined }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; ok?: boolean };
      if (!response.ok && response.status !== 207) throw new Error(payload.error ?? "That could not be recorded.");
      if (response.status === 207) { setError(payload.error ?? "Recorded, but not automatically linked."); }
      setMode("closed");
      onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAssociate() {
    if (!selectedGivingActivityId) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospectId)}/attributions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "associate_existing", givingActivityId: selectedGivingActivityId, note: note || undefined }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "That could not be associated.");
      setMode("closed");
      onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be associated.");
    } finally {
      setBusy(false);
    }
  }

  async function removeAttribution(attributionId: string) {
    if (!window.confirm("Remove this attribution? The underlying donation or pledge record is never changed -- only its link to this trip.")) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/trips/${encodeURIComponent(tripId)}/prospects/${encodeURIComponent(prospectId)}/attributions/${encodeURIComponent(attributionId)}`, { method: "DELETE" });
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as { error?: string }; throw new Error(payload.error ?? "Could not remove this attribution."); }
      onRefresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove this attribution.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="trip-financial-section">
    <p className="payment-plan-eyebrow">Fundraising for this donor on this trip</p>
    {error && <p className="travel-planning-error" role="alert">{error}</p>}
    {attributions.length > 0 && <div className="trip-financial-attributed-list">
      {attributions.map((item) => <div key={item.attributionId} className="trip-financial-attributed-row">
        <span>{CATEGORY_LABELS[item.category] ?? item.category} &middot; {money(item.committedCents ?? 0)}{(item.paidCents ?? 0) > 0 ? ` (${money(item.paidCents ?? 0)} paid)` : ""}{item.resolvedViaImportMatch ? <span className="trip-financial-confirmed-badge" title="This was recorded as a pending gift, then matched to a confirmed donation during a JL import -- these figures are the confirmed donation's own."> &middot; Confirmed via import</span> : null}</span>
        <button type="button" disabled={busy} onClick={() => removeAttribution(item.attributionId)}>Remove</button>
      </div>)}
    </div>}
    {mode === "closed" && <div className="trip-financial-attribution-actions">
      <button type="button" disabled={busy} onClick={() => openPanel("record_donation")}>Record a new donation</button>
      <button type="button" disabled={busy} onClick={() => openPanel("record_pledge")}>Record a new pledge</button>
      <button type="button" disabled={busy} onClick={() => openPanel("associate_existing")}>Associate an existing donation or pledge</button>
    </div>}
    {(mode === "record_donation" || mode === "record_pledge") && <div className="travel-planning-confirm-panel">
      <label>Amount<input type="text" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="$0" /></label>
      <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
      <label>Designation (optional)<input type="text" value={designation} onChange={(event) => setDesignation(event.target.value)} maxLength={160} /></label>
      <label>Note (optional)<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} /></label>
      <p className="travel-planning-confirm-hint">Recorded as an unconfirmed {mode === "record_donation" ? "gift" : "pledge"} using the same workflow as the rest of the CRM -- it will not count toward any total until confirmed.</p>
      <div className="travel-planning-confirm-actions">
        <button type="button" onClick={() => submitRecord(mode)} disabled={busy || !amount || !date}>Save</button>
        <button type="button" onClick={() => setMode("closed")}>Cancel</button>
      </div>
    </div>}
    {mode === "associate_existing" && <div className="travel-planning-confirm-panel">
      {eligible === null && <p>Loading this donor&rsquo;s eligible donations and pledges&hellip;</p>}
      {eligible !== null && eligible.length === 0 && <p>No eligible, unattributed donation or pledge was found for this donor.</p>}
      {eligible !== null && eligible.length > 0 && <label>Choose a donation or pledge
        <select value={selectedGivingActivityId} onChange={(event) => setSelectedGivingActivityId(event.target.value)}>
          <option value="">Select one&hellip;</option>
          {eligible.map((item) => <option key={item.id} value={item.id}>{CATEGORY_LABELS[item.category] ?? item.category} &middot; {money(item.committedCents ?? 0)}{item.description ? ` -- ${item.description}` : ""}</option>)}
        </select>
      </label>}
      <label>Note (optional)<textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} /></label>
      <div className="travel-planning-confirm-actions">
        <button type="button" onClick={submitAssociate} disabled={busy || !selectedGivingActivityId}>Associate</button>
        <button type="button" onClick={() => setMode("closed")}>Cancel</button>
      </div>
    </div>}
  </div>;
}

// Trip-level financial summary -- goal progress and confirmed/pending
// figures. Every figure here comes directly from `summary`
// (lib/relationships/trip-financial-attribution.ts's summarizeTripFinancials),
// a pure derivation of the trip's OWN attributed records; this component
// only renders it.
function TripFinancialResultsSection({ summary, attributions }: { summary: TripFinancialSummary; attributions: TripFinancialAttributionRow[] }) {
  const pending = attributions.filter((item) => item.category === "pending_gift" || item.category === "pending_pledge");
  return <section className="story-card" aria-label="Trip fundraising results">
    <div className="card-heading"><div><p className="eyebrow">FUNDRAISING RESULTS</p><h2>Results against this trip&rsquo;s goal</h2></div></div>
    {summary.goalCents !== null ? (
      <ProgressBar
        label={`${money(summary.totalNewCommitmentsCents)} raised of ${money(summary.goalCents)} goal`}
        percent={summary.percentOfGoal ?? 0}
        caption={summary.amountRemainingToGoalCents !== null && summary.amountRemainingToGoalCents > 0 ? `${money(summary.amountRemainingToGoalCents)} remaining to goal` : "Goal reached"}
      />
    ) : <p className="payment-plan-note-inline">This trip has no fundraising goal set.</p>}
    <FinancialSummaryGrid>
      <FinancialSummaryCard label="New pledges secured" value={money(summary.newPledgesSecuredCents)} sublabel={`${summary.pledgeCount} pledge${summary.pledgeCount === 1 ? "" : "s"}`} />
      <FinancialSummaryCard label="New donations secured" value={money(summary.newDonationsSecuredCents)} sublabel={`${summary.donationCount} donation${summary.donationCount === 1 ? "" : "s"}`} />
      <FinancialSummaryCard label="Cash collected" value={money(summary.cashCollectedCents)} />
      <FinancialSummaryCard label="Outstanding pledge balance" value={money(summary.outstandingCommittedBalanceCents)} tone="muted" />
    </FinancialSummaryGrid>
    {pending.length > 0 && <div className="trip-financial-pending-list" aria-label="Pending opportunities">
      <p className="payment-plan-eyebrow">Pending opportunities (not yet confirmed -- never counted above)</p>
      {pending.map((item) => <div key={item.attributionId} className="trip-financial-pending-row">
        <span>{item.donorDisplayName}</span>
        <span>{CATEGORY_LABELS[item.category] ?? item.category} &middot; {money(item.committedCents ?? 0)}
          {item.category === "pending_pledge" ? <span className="trip-financial-manual-note" title="A pending pledge never auto-confirms from a JL import -- once the real pledge is imported, use Associate an existing pledge above to link it here."> &middot; confirms manually once imported</span> : null}
        </span>
      </div>)}
    </div>}
  </section>;
}
