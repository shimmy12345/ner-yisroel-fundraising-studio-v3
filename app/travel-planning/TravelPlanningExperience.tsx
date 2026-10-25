"use client";

import { useMemo, useState } from "react";
import type { TripListItem } from "../../lib/relationships/trips-data";
import type { TripStatus } from "../../lib/relationships/trip-model";

type RegionOption = { id: string; label: string };

const STATUS_FILTERS: ReadonlyArray<{ id: TripStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "planning", label: "Planning" },
  { id: "active", label: "Active" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
];

const dateLabel = (epoch: number) => new Date(epoch * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const toEpoch = (value: string) => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);

export function TravelPlanningExperience({ trips, regions }: { trips: TripListItem[]; regions: RegionOption[] }) {
  const [filter, setFilter] = useState<TripStatus | "all">("all");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => new Map(STATUS_FILTERS.map((option) => [option.id, option.id === "all" ? trips.length : trips.filter((trip) => trip.status === option.id).length])), [trips]);
  const visible = filter === "all" ? trips : trips.filter((trip) => trip.status === filter);

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
      <fieldset className="travel-planning-new-trip-regions">
        <legend>Destination Travel Region(s)</legend>
        {regions.map((region) => <label key={region.id} className="travel-planning-region-checkbox">
          <input type="checkbox" checked={selectedRegionIds.includes(region.id)} onChange={() => toggleRegion(region.id)} /> {region.label}
        </label>)}
        {selectedRegionIds.length === 0 && <p className="travel-planning-form-hint">No region selected -- manual prospects only, until you add one.</p>}
      </fieldset>
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
          <span className={`travel-planning-status-badge status-${trip.status}`}>{trip.status}</span>
        </div>
        <p className="travel-planning-trip-card-meta">{trip.destinationRegionLabels.length > 0 ? trip.destinationRegionLabels.join(", ") : "No region selected"} &middot; {dateLabel(trip.startDate)} &ndash; {dateLabel(trip.endDate)}</p>
        <p className="travel-planning-trip-card-count">{trip.prospectCount} prospect{trip.prospectCount === 1 ? "" : "s"}</p>
      </a>)}
    </section> : <div className="travel-planning-empty"><strong>No trips {filter === "all" ? "yet" : `in ${filter}`}.</strong><p>Create a trip to start identifying donors worth meeting in a city you&rsquo;re planning to visit.</p></div>}
  </>;
}
