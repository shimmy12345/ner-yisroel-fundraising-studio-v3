"use client";

import { useMemo, useState } from "react";
import type { TripListItem } from "../../lib/relationships/trips-data";
import type { TripStatus } from "../../lib/relationships/trip-model";
import { DestinationRegionFieldset } from "./DestinationRegionFieldset";

type RegionOption = { id: string; label: string };

// Archive Trip (2026-11-02, see docs/AI-HANDOFF.md's "Add Archive and
// Delete Options to Trip Planner" entry) -- "Archived" is a UI-level
// filter here, not a real TripStatus: an archived trip keeps whatever
// real status it already had (see trips-data.ts's updateTrip). "All"
// and every status tab below show only NON-archived trips, matching
// the owner's own "remove the trip from the default active trip list"
// requirement; archived trips are visible only via this dedicated tab.
type TripFilter = TripStatus | "all" | "archived";
const STATUS_FILTERS: ReadonlyArray<{ id: TripFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "planning", label: "Planning" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "archived", label: "Archived" },
];

const dateLabel = (epoch: number) => new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const toEpoch = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);

export function TravelPlanningExperience({ trips, regions }: { trips: TripListItem[]; regions: RegionOption[] }) {
  const [filter, setFilter] = useState<TripFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeTrips = useMemo(() => trips.filter((trip) => trip.archivedAt === null), [trips]);
  const archivedTrips = useMemo(() => trips.filter((trip) => trip.archivedAt !== null), [trips]);
  const counts = useMemo(() => new Map(STATUS_FILTERS.map((option) => [
    option.id,
    option.id === "all" ? activeTrips.length : option.id === "archived" ? archivedTrips.length : activeTrips.filter((trip) => trip.status === option.id).length,
  ])), [activeTrips, archivedTrips]);
  const visible = filter === "all" ? activeTrips : filter === "archived" ? archivedTrips : activeTrips.filter((trip) => trip.status === filter);

  // Multi-Region Trip Destination (2026-10-26, see docs/AI-HANDOFF.md) --
  // "Destination Travel Region" accepts any combination of regions, not
  // just one. Plain React state (not FormData) for this one field,
  // since a group of checkboxes has no single native form value the
  // way a <select> does.
  const [selectedRegionIds, setSelectedRegionIds] = useState<string[]>([]);
  function toggleRegion(regionId: string) {
    setSelectedRegionIds((current) => current.includes(regionId) ? current.filter((id) => id !== regionId) : [...current, regionId]);
  }

  async function createTrip(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const startDateValue = String(form.get("startDate") ?? "");
    const endDateValue = String(form.get("endDate") ?? "");
    const goalDollars = String(form.get("goalDollars") ?? "").trim();
    const notes = String(form.get("notes") ?? "").trim();
    if (!name || !startDateValue || !endDateValue) { setError("Trip name, start date, and end date are required."); return; }

    setSubmitting(true);
    try {
      const response = await fetch("/api/trips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          destinationRegionIds: selectedRegionIds,
          startDate: toEpoch(startDateValue),
          endDate: toEpoch(endDateValue),
          goalCents: goalDollars ? Math.round(Number(goalDollars) * 100) : null,
          notes: notes || null,
        }),
      });
      const payload = await response.json() as { tripId?: string; error?: string };
      if (!response.ok || !payload.tripId) { setError(payload.error ?? "The trip could not be created."); return; }
      window.location.href = `/travel-planning/${encodeURIComponent(payload.tripId)}`;
    } catch {
      setError("The trip could not be created. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return <>
    <div className="travel-planning-toolbar">
      <nav className="portfolio-focus-filters" aria-label="Filter trips by status">
        {STATUS_FILTERS.map((option) => <button key={option.id} type="button" className={filter === option.id ? "active" : ""} aria-pressed={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}<span>{counts.get(option.id) ?? 0}</span></button>)}
      </nav>
      <button type="button" className="travel-planning-new-trip" onClick={() => setShowForm((current) => !current)}>{showForm ? "Cancel" : "+ New Trip"}</button>
    </div>

    {showForm && <form className="travel-planning-new-trip-form" onSubmit={createTrip}>
      <label>Trip name<input name="name" placeholder="Chicago -- November 2026" required maxLength={200} /></label>
      <DestinationRegionFieldset
        regions={regions} selectedRegionIds={selectedRegionIds} onToggle={toggleRegion}
        emptyHint="No region selected -- manual prospects only, until you add one."
      />
      <label>Start date<input name="startDate" type="date" required /></label>
      <label>End date<input name="endDate" type="date" required /></label>
      <label>Fundraising goal (optional)<input name="goalDollars" type="number" min="1" step="1" placeholder="25000" /></label>
      <label className="travel-planning-notes-field">Notes / objectives<textarea name="notes" maxLength={5000} placeholder="What do you want to accomplish on this trip?" /></label>
      {error && <p className="travel-planning-form-error">{error}</p>}
      <div className="travel-planning-form-actions">
        <button type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create Trip"}</button>
        <p className="travel-planning-form-hint">If a region is chosen, you&rsquo;ll be able to find donors there in &ldquo;Find prospects&rdquo; once the trip is created -- nothing is added automatically. You choose who to add, from this region or any other.</p>
      </div>
    </form>}

    {visible.length ? <section className="travel-planning-list" aria-label="Trips">
      {visible.map((trip) => <a className="travel-planning-trip-card" href={`/travel-planning/${encodeURIComponent(trip.id)}`} key={trip.id}>
        <div className="travel-planning-trip-card-heading">
          <strong>{trip.name}</strong>
          <span className="travel-planning-trip-card-badge-group">
            {trip.archivedAt !== null && <span className="travel-planning-archived-badge">Archived</span>}
            <span className={`travel-planning-status-badge status-${trip.status}`}>{trip.status}</span>
          </span>
        </div>
        <p className="travel-planning-trip-card-meta">{trip.destinationRegionLabels.length > 0 ? trip.destinationRegionLabels.join(", ") : "No region selected"} &middot; {dateLabel(trip.startDate)} &ndash; {dateLabel(trip.endDate)}</p>
        <p className="travel-planning-trip-card-count">{trip.prospectCount} prospect{trip.prospectCount === 1 ? "" : "s"}</p>
      </a>)}
    </section> : <div className="travel-planning-empty"><strong>No trips {filter === "all" ? "yet" : filter === "archived" ? "archived" : `in ${filter}`}.</strong><p>{filter === "archived" ? "Archived trips stay here, fully preserved, until you restore or delete them." : "Create a trip to start identifying donors worth meeting in a city you’re planning to visit."}</p></div>}
  </>;
}
