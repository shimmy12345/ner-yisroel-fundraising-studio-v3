// Geographic Filtering for Travel Planning -- Phase 2 (2026-10-14, see
// docs/AI-HANDOFF.md's "Geographic Audit for Travel Planning" entries).
// The 15 regions and their exact city/state memberships below are
// EXACTLY the groupings the owner reviewed and approved from the Phase 1
// read-only audit -- no city was added, removed, or re-scoped beyond
// what that audit proposed. This module only ever READS a donor's
// existing `city`/`state` columns; it never writes to `donors` and has
// no D1 access of its own (pure, framework-free, directly unit-testable).
//
// A donor can belong to more than one region by design: `regionsForCityState`
// returns every region whose membership list matches, not just the first
// one found, so a future edit that lists the same city under two regions
// (e.g. a broad "North Jersey" region added alongside the narrower
// Central NJ region) is already supported without any further code
// change. No two of the 15 approved regions currently share a city, but
// nothing here assumes that stays true.

export type TravelRegionId =
  | "baltimore-maryland-suburbs"
  | "chicago-suburbs"
  | "north-central-nj-teaneck-bergenfield"
  | "monsey-spring-valley-rockland-ny"
  | "queens-western-long-island-ny"
  | "los-angeles-san-fernando-valley"
  | "south-florida-miami"
  | "nyc-boroughs"
  | "st-louis-suburbs"
  | "five-towns-far-rockaway"
  | "lakewood-ocean-county-nj"
  | "central-nj"
  | "san-diego"
  | "detroit-area-mi"
  | "israel";

export type TravelRegionCity = { city: string; state: string | null };

export type TravelRegion = {
  id: TravelRegionId;
  label: string;
  cities: readonly TravelRegionCity[];
};

// Case/whitespace-tolerant normalization -- matches the exact convention
// already used across this codebase for text comparison (e.g. lib/
// relationships/donor-search.ts's own `normalized()`). State is
// deliberately nullable (Israel addresses have no US-style state at
// all, per the audit) and normalizes null/undefined/blank identically,
// so a city recorded with either an empty string or a true SQL NULL
// state matches the same region entry.
function normalizedPart(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

export function cityStateKey(city: string | null | undefined, state: string | null | undefined): string {
  return `${normalizedPart(city)}::${normalizedPart(state)}`;
}

// The 15 approved regions, in the exact order and with the exact city/
// state membership from the October 14 Phase 1 audit's "Proposed
// geographic groupings" table (docs/AI-HANDOFF.md). Labels are the
// audit's own region names, verbatim.
export const TRAVEL_REGIONS: readonly TravelRegion[] = [
  // Baltimore ONLY -- corrected 2026-10-14 during independent review.
  // The Phase 1 audit's own proposal already flagged Silver Spring as
  // doubtful ("~40 mi away toward DC, not a Baltimore suburb") but
  // included it anyway with that caveat; the owner's actual approval
  // excluded it. Silver Spring is NOT removed from the donor directory
  // -- a donor there still appears under "All Regions" and remains
  // individually selectable via the City filter (see
  // lib/relationships/donor-geo-filter.ts's cityOptionsForRegion(),
  // which lists every city actually present regardless of region
  // membership) -- it simply no longer matches this region.
  { id: "baltimore-maryland-suburbs", label: "Baltimore & Maryland suburbs", cities: [
    { city: "Baltimore", state: "MD" },
  ] },
  { id: "chicago-suburbs", label: "Chicago & suburbs", cities: [
    { city: "Chicago", state: "IL" },
    { city: "Lincolnwood", state: "IL" },
  ] },
  { id: "north-central-nj-teaneck-bergenfield", label: "North/Central NJ -- Teaneck/Bergenfield area", cities: [
    { city: "Teaneck", state: "NJ" },
    { city: "Bergenfield", state: "NJ" },
    { city: "Englewood", state: "NJ" },
    { city: "Fair Lawn", state: "NJ" },
    { city: "Passaic", state: "NJ" },
  ] },
  { id: "monsey-spring-valley-rockland-ny", label: "Monsey/Spring Valley & Rockland County, NY", cities: [
    { city: "Monsey", state: "NY" },
    { city: "Spring Valley", state: "NY" },
    { city: "Suffern", state: "NY" },
    { city: "New City", state: "NY" },
    { city: "Chestnut Ridge", state: "NY" },
    { city: "Nanuet", state: "NY" },
    { city: "Wesley Hills", state: "NY" },
  ] },
  { id: "queens-western-long-island-ny", label: "Queens & western Long Island, NY", cities: [
    { city: "Flushing", state: "NY" },
    { city: "Oceanside", state: "NY" },
    { city: "Great Neck", state: "NY" },
    { city: "East Setauket", state: "NY" },
  ] },
  { id: "los-angeles-san-fernando-valley", label: "Los Angeles & San Fernando Valley, CA", cities: [
    { city: "Los Angeles", state: "CA" },
    { city: "Sherman Oaks", state: "CA" },
    { city: "Valley Village", state: "CA" },
  ] },
  { id: "south-florida-miami", label: "South Florida / Miami area", cities: [
    { city: "Boca Raton", state: "FL" },
    { city: "Hollywood", state: "FL" },
    { city: "Aventura", state: "FL" },
    { city: "Surfside", state: "FL" },
  ] },
  { id: "nyc-boroughs", label: "NYC boroughs", cities: [
    { city: "Brooklyn", state: "NY" },
    { city: "Bronx", state: "NY" },
    { city: "Staten Island", state: "NY" },
    { city: "New York", state: "NY" },
  ] },
  { id: "st-louis-suburbs", label: "St. Louis & suburbs", cities: [
    { city: "Saint Louis", state: "MO" },
    { city: "Chesterfield", state: "MO" },
  ] },
  { id: "five-towns-far-rockaway", label: "Five Towns / Far Rockaway, NY", cities: [
    { city: "Far Rockaway", state: "NY" },
    { city: "Lawrence", state: "NY" },
  ] },
  { id: "lakewood-ocean-county-nj", label: "Lakewood & Ocean County, NJ", cities: [
    { city: "Lakewood", state: "NJ" },
    { city: "Jackson", state: "NJ" },
    { city: "Toms River", state: "NJ" },
  ] },
  { id: "central-nj", label: "Central NJ (Edison/Elizabeth)", cities: [
    { city: "Edison", state: "NJ" },
    { city: "Elizabeth", state: "NJ" },
  ] },
  { id: "san-diego", label: "San Diego, CA", cities: [
    { city: "La Jolla", state: "CA" },
  ] },
  { id: "detroit-area-mi", label: "Detroit area, MI", cities: [
    { city: "Oak Park", state: "MI" },
    { city: "Southfield", state: "MI" },
  ] },
  // Not a domestic travel region -- carried over from the audit exactly
  // as approved, specifically so these three donors are tagged and never
  // get swept into a US region by mistake (e.g. a future, broader
  // "all my NY-area donors" grouping must not accidentally match a
  // donor whose `state` happens to be null for an unrelated reason).
  { id: "israel", label: "Israel", cities: [
    { city: "Betar Illit", state: null },
    { city: "Jerusalem", state: null },
    { city: "Ramat Beit Shemesh", state: null },
  ] },
];

// Precomputed once at module load: normalized (city, state) key -> every
// region id whose membership list contains that key. A Map of arrays,
// never a Map of a single id, so future overlapping membership (see this
// file's own header comment) is supported without changing this
// function's shape.
const REGIONS_BY_CITY_STATE_KEY: ReadonlyMap<string, readonly TravelRegionId[]> = (() => {
  const map = new Map<string, TravelRegionId[]>();
  for (const region of TRAVEL_REGIONS) {
    for (const { city, state } of region.cities) {
      const key = cityStateKey(city, state);
      const existing = map.get(key);
      if (existing) existing.push(region.id);
      else map.set(key, [region.id]);
    }
  }
  return map;
})();

export function regionsForCityState(city: string | null | undefined, state: string | null | undefined): readonly TravelRegionId[] {
  return REGIONS_BY_CITY_STATE_KEY.get(cityStateKey(city, state)) ?? [];
}

export function travelRegionById(id: string | null | undefined): TravelRegion | null {
  return TRAVEL_REGIONS.find((region) => region.id === id) ?? null;
}

// Display label for a (city, state) pair -- used by every UI surface
// that lists cities (the directory's City filter, region membership
// summaries) so there is exactly one place that decides whether to
// render ", <state>" or omit it (Israel's null-state cities never show
// a trailing ", null" or ", "). Always built from the CALLER-supplied
// city/state text (e.g. a real donor row), never from this module's own
// region-definition spelling, so a donor's own recorded text is always
// what's displayed, never a normalized or region-table copy.
export function formatCityState(city: string | null | undefined, state: string | null | undefined): string {
  const trimmedCity = (city ?? "").trim();
  const trimmedState = (state ?? "").trim();
  return trimmedState ? `${trimmedCity}, ${trimmedState}` : trimmedCity;
}
