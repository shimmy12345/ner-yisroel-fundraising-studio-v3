// Geographic Filtering for Travel Planning -- Phase 2 (2026-10-14, see
// docs/AI-HANDOFF.md). Donor-directory-shape-agnostic on purpose: every
// function here takes a plain `{ city, state }` pair (or an array of
// records that have one), never a donor directory's own specific row
// type -- so this same logic is reusable, unmodified, from Portfolio
// Focus or a future dedicated Travel Planning view (per the owner's own
// "prepare for future travel planning" instruction), not only from
// `app/donors`. Pure, no D1 access, no React -- directly unit-testable.

import { cityStateKey, formatCityState, regionsForCityState, type TravelRegionId } from "./travel-regions.ts";

export type GeoTaggable = { city: string | null; state: string | null };

export const ALL_REGIONS = "all" as const;
export const ALL_CITIES = "all" as const;
export type RegionFilterValue = TravelRegionId | typeof ALL_REGIONS;
export type CityFilterValue = string; // "all", or a cityStateKey()

export function matchesRegionFilter(record: GeoTaggable, regionId: RegionFilterValue): boolean {
  if (regionId === ALL_REGIONS) return true;
  return regionsForCityState(record.city, record.state).includes(regionId);
}

export function matchesCityFilter(record: GeoTaggable, cityKey: CityFilterValue): boolean {
  if (cityKey === ALL_CITIES) return true;
  return cityStateKey(record.city, record.state) === cityKey;
}

// The combined geo filter -- region AND city, both independently
// optional ("all"). Never mutates or reorders `records`; a caller that
// also applies text search/alphabet filters composes this the same way
// (plain array `.filter()`), in whichever order it prefers -- the result
// is identical either way since every filter here is a pure predicate.
export function filterByGeo<T extends GeoTaggable>(records: readonly T[], regionId: RegionFilterValue, cityKey: CityFilterValue): T[] {
  return records.filter((record) => matchesRegionFilter(record, regionId) && matchesCityFilter(record, cityKey));
}

export type CityOption = { key: string; city: string; state: string | null; label: string; count: number };

// Every distinct city actually present in `records` (never a static
// list -- stays correct as donors are added, archived, or edited),
// optionally narrowed to one region first. This is what makes "the City
// filter should offer only cities within that region" true: call this
// with the currently-selected region, and the dropdown it builds can
// only ever offer cities that are BOTH in that region's approved
// membership AND actually present in the current donor data (so a
// region never offers a city with zero current donors).
//
// Sorted alphabetically A-Z by CITY name first (owner feedback,
// 2026-10-14: the original state-first sort made the dropdown hard to
// scan -- a long flat list is far easier to use sorted the way a person
// actually looks for a city, by its own name), with state used ONLY as
// a tiebreaker when two cities share the exact same name (e.g. a
// hypothetical "Springfield, IL" and "Springfield, MA"). Comparison is
// case-insensitive; the displayed text is always each city's own
// first-seen raw spelling, never a normalized/lowercased copy --
// consistent with `formatCityState`'s own "always the caller's real
// text" rule.
export function cityOptionsForRegion<T extends GeoTaggable>(records: readonly T[], regionId: RegionFilterValue): CityOption[] {
  const inRegion = regionId === ALL_REGIONS ? records : records.filter((record) => matchesRegionFilter(record, regionId));
  const byKey = new Map<string, CityOption>();
  for (const record of inRegion) {
    // A donor with no city text at all has nothing meaningful to offer
    // as a city option -- skipped rather than surfaced as a blank
    // dropdown entry. Real Production data has zero such donors (every
    // live donor has a city on file, per the Phase 1 audit); this only
    // guards against a future donor missing one entirely.
    if (!(record.city ?? "").trim()) continue;
    const key = cityStateKey(record.city, record.state);
    const existing = byKey.get(key);
    if (existing) { existing.count += 1; continue; }
    byKey.set(key, { key, city: (record.city ?? "").trim(), state: record.state, label: formatCityState(record.city, record.state), count: 1 });
  }
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  return [...byKey.values()].sort((a, b) => collator.compare(a.city, b.city) || collator.compare(a.state ?? "", b.state ?? ""));
}

// Searchable City selector support (owner feedback, 2026-10-14): a
// pure, case-insensitive partial match against an already-built
// `CityOption` list, directly unit-testable without React or a DOM.
// Matches the city name OR the state (so typing "md" narrows to
// Maryland cities too) -- never the combined ", "-joined label, which
// would also match on the literal comma. An empty/whitespace-only
// query returns every option unfiltered, exactly like `searchDonors()`
// (lib/relationships/donor-search.ts) does for a blank donor search --
// the same "no query means show everything" convention, not a second,
// differently-shaped search engine.
export function searchCityOptions(options: readonly CityOption[], query: string): CityOption[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => option.city.toLocaleLowerCase().includes(needle) || (option.state ?? "").toLocaleLowerCase().includes(needle));
}
