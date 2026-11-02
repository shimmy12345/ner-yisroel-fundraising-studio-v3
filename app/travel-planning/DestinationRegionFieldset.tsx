"use client";

import { useState } from "react";

export type RegionOption = { id: string; label: string };

// Shared Destination Travel Region picker (2026-11-01, see
// docs/AI-HANDOFF.md's "Fix Trip Region Selection and Mobile Layout"
// entry) -- used by both trip creation (TravelPlanningExperience) and
// "Edit destination regions" (TripDashboardExperience), the two
// places that set a trip's OWN saved destination regions, so they
// share one mobile-friendly row-per-checkbox layout and one optional
// filter box instead of drifting into two different mobile layouts.
// Deliberately NOT used by "Find prospects"' region FILTER -- that one
// has different semantics (an "All regions" option, a Set rather than
// an array) and is its own component in TripDashboardExperience.tsx,
// though it reuses the same `.travel-planning-region-checkbox` CSS
// class so the mobile layout fix applies there too.
export function DestinationRegionFieldset({
  regions, selectedRegionIds, onToggle, legend = "Destination Travel Region(s)", emptyHint,
}: {
  regions: readonly RegionOption[];
  selectedRegionIds: readonly string[];
  onToggle: (regionId: string) => void;
  legend?: string;
  emptyHint?: string;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLocaleLowerCase();
  const visibleRegions = needle ? regions.filter((region) => region.label.toLocaleLowerCase().includes(needle)) : regions;

  return <fieldset className="travel-planning-new-trip-regions">
    <legend>{legend}</legend>
    <p className="travel-planning-region-hint">Select the regions where you plan to meet donors. You can still add prospects from anywhere.</p>
    {regions.length > 8 && <input
      type="text" className="travel-planning-region-search" placeholder="Filter regions…"
      value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter regions"
    />}
    <div className="travel-planning-region-list">
      {visibleRegions.map((region) => <label key={region.id} className="travel-planning-region-checkbox">
        <input type="checkbox" checked={selectedRegionIds.includes(region.id)} onChange={() => onToggle(region.id)} /> {region.label}
      </label>)}
      {visibleRegions.length === 0 && <p className="travel-planning-form-hint">No regions match &ldquo;{filter.trim()}&rdquo;.</p>}
    </div>
    {emptyHint && selectedRegionIds.length === 0 && <p className="travel-planning-form-hint">{emptyHint}</p>}
  </fieldset>;
}
