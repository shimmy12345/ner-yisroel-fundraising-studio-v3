// Trip Region Selection / Find-Prospects default filter (2026-11-01,
// see docs/AI-HANDOFF.md's "Fix Trip Region Selection and Mobile
// Layout" entry). Pure, directly unit-testable -- no D1, no React.
//
// Root cause this fixes: "Find prospects"' region checkboxes read the
// raw `selectedRegionIds` client state for both display and as the
// base set when toggling. That state is `null` until the fundraiser's
// own click (or a `?regions=` URL param) sets it, which the donor
// FILTER already correctly treated as "fall back to this trip's own
// saved destination regions" -- but the checkboxes never reflected
// that fallback (every box, including "All regions," rendered
// unchecked), and the first checkbox click started from an EMPTY set
// instead of that trip default, silently discarding every other
// region the trip was already scoped to. That combination is what
// made it look like regions had to be chosen twice.
//
// `effectiveRegionFilter` is the one place this fallback is computed;
// both the checkbox `checked` props and the actual donor filtering
// must read it, never the raw `null`-until-touched state directly.

import { ALL_CITIES, ALL_REGIONS, filterByGeoRegions, type GeoTaggable, type RegionSetFilterValue } from "./donor-geo-filter.ts";
import { searchDonors, type DonorSearchRecord } from "./donor-search.ts";
import type { TravelRegionId } from "./travel-regions.ts";

// `null` means "not yet touched this session" -- defer to the trip's
// own saved destination regions, or every region if the trip has none
// saved (never a filter that silently hides all donors).
export function effectiveRegionFilter(
  selectedRegionIds: ReadonlySet<TravelRegionId> | typeof ALL_REGIONS | null,
  tripDestinationRegionIds: readonly TravelRegionId[],
): RegionSetFilterValue {
  if (selectedRegionIds === ALL_REGIONS) return ALL_REGIONS;
  if (selectedRegionIds !== null) return selectedRegionIds;
  return tripDestinationRegionIds.length > 0 ? new Set(tripDestinationRegionIds) : ALL_REGIONS;
}

// Toggling one region checkbox must start from what is ACTUALLY in
// effect right now (effectiveRegionFilter's own result), never from an
// empty set -- otherwise the first click after opening "Find
// prospects" drops every other region the trip was already scoped to.
export function toggleRegionInFilter(effectiveRegionSet: RegionSetFilterValue, regionId: TravelRegionId): ReadonlySet<TravelRegionId> {
  const next = effectiveRegionSet === ALL_REGIONS ? new Set<TravelRegionId>() : new Set(effectiveRegionSet);
  if (next.has(regionId)) next.delete(regionId); else next.add(regionId);
  return next;
}

// Donor name search intentionally BYPASSES the region filter entirely
// (owner requirement, 2026-11-01: "allow me to search for a donor by
// name regardless of region") -- the whole point of typing a name is
// usually that the donor is NOT in one of the regions currently shown.
// The region checkboxes still govern the browse-by-region list the
// moment the search box is empty. `searchDonors()` is typed over the
// plain DonorSearchRecord shape and loses extra fields at the type
// level, so results are resolved back to the caller's full record type
// by id, exactly like the donor directory's own `relationshipById`
// pattern.
export function findProspectResults<T extends DonorSearchRecord & GeoTaggable & { id: string }>(
  donors: readonly T[],
  effectiveRegionSet: RegionSetFilterValue,
  query: string,
): T[] {
  const byId = new Map(donors.map((donor) => [donor.id, donor]));
  const base = query.trim() ? [...donors] : filterByGeoRegions(donors, effectiveRegionSet, ALL_CITIES);
  return searchDonors(base, query, Number.MAX_SAFE_INTEGER).map((donor) => byId.get(donor.id)!);
}
