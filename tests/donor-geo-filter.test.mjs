import assert from "node:assert/strict";
import { filterByGeo, cityOptionsForRegion, matchesRegionFilter, matchesCityFilter, searchCityOptions, ALL_REGIONS, ALL_CITIES } from "../lib/relationships/donor-geo-filter.ts";
import { cityStateKey } from "../lib/relationships/travel-regions.ts";

// Geographic Filtering for Travel Planning -- Phase 2 (2026-10-14, see
// docs/AI-HANDOFF.md). Donor-shape-agnostic on purpose (see this
// module's own header comment) -- these fixtures use the minimal
// `{ city, state }` shape directly, proving the module needs nothing
// donor-directory-specific, which is what makes it reusable from
// Portfolio Focus or a future Travel Planning view unmodified.

function donor(id, city, state) {
  return { id, city, state };
}

async function run() {
  const roster = [
    donor("teaneck-1", "Teaneck", "NJ"),
    donor("teaneck-2", "Teaneck", "NJ"),
    donor("bergenfield-1", "Bergenfield", "NJ"),
    donor("chicago-1", "Chicago", "IL"),
    donor("baltimore-1", "Baltimore", "MD"),
    donor("silver-spring-1", "Silver Spring", "MD"), // independent-review correction: NOT part of Baltimore
    donor("savannah-1", "Savannah", "GA"), // ungrouped -- real audit case
    donor("jerusalem-1", "Jerusalem", null), // international -- real audit case
    donor("unknown-1", null, null), // no address on file at all
  ];

  // --- Correct donor counts for a region: exactly the donors whose
  // (city, state) is a member of that region, never more, never fewer. ---
  {
    const teaneckRegion = filterByGeo(roster, "north-central-nj-teaneck-bergenfield", ALL_CITIES);
    assert.deepEqual(teaneckRegion.map((d) => d.id).sort(), ["bergenfield-1", "teaneck-1", "teaneck-2"]);
  }

  // --- Regression: independent review correction (2026-10-14). The
  // Baltimore region must contain ONLY the real Baltimore donor -- the
  // Silver Spring donor must be excluded from it, while remaining fully
  // visible under "All Regions" and individually filterable by city. ---
  {
    const baltimoreRegion = filterByGeo(roster, "baltimore-maryland-suburbs", ALL_CITIES);
    assert.deepEqual(baltimoreRegion.map((d) => d.id), ["baltimore-1"], "the Baltimore region must contain exactly one donor -- Silver Spring must not be included");
    const silverSpringUnderAllRegions = filterByGeo(roster, ALL_REGIONS, ALL_CITIES);
    assert.ok(silverSpringUnderAllRegions.some((d) => d.id === "silver-spring-1"), "Silver Spring must remain visible under All Regions");
    const silverSpringByCity = filterByGeo(roster, ALL_REGIONS, cityStateKey("Silver Spring", "MD"));
    assert.deepEqual(silverSpringByCity.map((d) => d.id), ["silver-spring-1"], "Silver Spring must remain individually selectable via the City filter");
    // Confirms the exclusion is real, not an artifact of this test's
    // own roster -- Silver Spring must not match the Baltimore region
    // even when explicitly filtered by it.
    const silverSpringUnderBaltimore = filterByGeo(roster, "baltimore-maryland-suburbs", cityStateKey("Silver Spring", "MD"));
    assert.deepEqual(silverSpringUnderBaltimore, [], "Silver Spring must not appear even when the Baltimore region AND its own city are both selected together");
  }

  // --- Individual-city filtering: narrows to exactly one (city, state),
  // independent of any region selection. ---
  {
    const teaneckOnly = filterByGeo(roster, ALL_REGIONS, cityStateKey("Teaneck", "NJ"));
    assert.deepEqual(teaneckOnly.map((d) => d.id).sort(), ["teaneck-1", "teaneck-2"]);
    // Region + city together: city narrows further within the region
    // (Bergenfield donor excluded even though it's in the same region).
    const teaneckWithinRegion = filterByGeo(roster, "north-central-nj-teaneck-bergenfield", cityStateKey("Teaneck", "NJ"));
    assert.deepEqual(teaneckWithinRegion.map((d) => d.id).sort(), ["teaneck-1", "teaneck-2"]);
  }

  // --- Donors outside all approved regions (All Regions) and
  // international donors must remain visible, never excluded. ---
  {
    const all = filterByGeo(roster, ALL_REGIONS, ALL_CITIES);
    assert.equal(all.length, roster.length, "All Regions + All Cities must show every donor, including ungrouped and international ones");
    assert.ok(all.some((d) => d.id === "savannah-1"), "an ungrouped donor must remain visible under All Regions");
    assert.ok(all.some((d) => d.id === "jerusalem-1"), "an international donor must remain visible under All Regions");
    assert.ok(all.some((d) => d.id === "unknown-1"), "a donor with no address at all must remain visible under All Regions");
  }

  // --- An ungrouped or international donor can still be found through
  // individual-city filtering, even though they match zero regions. ---
  {
    const savannahOnly = filterByGeo(roster, ALL_REGIONS, cityStateKey("Savannah", "GA"));
    assert.deepEqual(savannahOnly.map((d) => d.id), ["savannah-1"]);
    const jerusalemOnly = filterByGeo(roster, ALL_REGIONS, cityStateKey("Jerusalem", null));
    assert.deepEqual(jerusalemOnly.map((d) => d.id), ["jerusalem-1"]);
  }

  // --- A real region selected together with a city that is NOT a
  // member of that region returns nothing -- never a silent fallback to
  // "ignore the city" or a crash. ---
  {
    const impossible = filterByGeo(roster, "chicago-suburbs", cityStateKey("Teaneck", "NJ"));
    assert.deepEqual(impossible, []);
  }

  // --- Case/whitespace differences in the DONOR's own stored text
  // still match correctly (forward-looking robustness; real Production
  // data has none of this today per the Phase 1 audit). ---
  {
    const messy = [donor("messy-1", "  TEANECK  ", "nj")];
    assert.equal(matchesRegionFilter(messy[0], "north-central-nj-teaneck-bergenfield"), true);
    assert.equal(matchesCityFilter(messy[0], cityStateKey("Teaneck", "NJ")), true);
  }

  // --- cityOptionsForRegion: "All Regions" lists every distinct city
  // actually present (not a static list), with accurate per-city
  // counts; a real donor with no city at all does not silently create a
  // phantom "blank" option that would be indistinguishable from a real,
  // rare blank-city donor -- it is still represented by its own key,
  // just never collides with a real city. ---
  {
    const allCityOptions = cityOptionsForRegion(roster, ALL_REGIONS);
    const teaneckOption = allCityOptions.find((o) => o.key === cityStateKey("Teaneck", "NJ"));
    assert.equal(teaneckOption.count, 2, "the city option's count must reflect exactly how many donors are in that city");
    assert.equal(teaneckOption.label, "Teaneck, NJ");
    assert.ok(allCityOptions.some((o) => o.label === "Jerusalem"), "an international city with no state must still appear, without a stray ', null'");
    assert.ok(allCityOptions.some((o) => o.city === "Savannah"), "an ungrouped city must still appear in the All-Regions city list");
    assert.ok(allCityOptions.some((o) => o.label === "Silver Spring, MD"), "Silver Spring must still appear in the All-Regions city list after the independent-review correction");
  }

  // --- Regression: the Baltimore region's own city dropdown must
  // offer only Baltimore -- Silver Spring must not appear there, even
  // though it still appears under "All Regions" (checked above). ---
  {
    const baltimoreOptions = cityOptionsForRegion(roster, "baltimore-maryland-suburbs");
    assert.deepEqual(baltimoreOptions.map((o) => o.city), ["Baltimore"]);
  }

  // --- "When a travel region is selected, the City filter should offer
  // only cities within that region": cityOptionsForRegion scoped to one
  // region must include only that region's cities (that have at least
  // one current donor), and must exclude every other city, including
  // ungrouped and international ones. ---
  {
    const njOptions = cityOptionsForRegion(roster, "north-central-nj-teaneck-bergenfield");
    assert.deepEqual(njOptions.map((o) => o.city).sort(), ["Bergenfield", "Teaneck"]);
    assert.equal(njOptions.find((o) => o.city === "Chicago"), undefined);
    assert.equal(njOptions.find((o) => o.city === "Savannah"), undefined);
  }

  // --- A region with zero current donors offers an empty city list,
  // never an error. ---
  {
    const emptyRegionOptions = cityOptionsForRegion(roster, "san-diego");
    assert.deepEqual(emptyRegionOptions, []);
  }

  // --- Regression: owner feedback (2026-10-14) -- sorted alphabetically
  // A-Z by CITY name first, never by state first. Alphabetical by city:
  // Baltimore, Bergenfield, Chicago, Jerusalem, Savannah, Silver Spring,
  // Teaneck -- spanning MD/NJ/IL/(none)/GA/MD/NJ in that order, proving
  // state plays no role except as a tiebreaker. ---
  {
    const sorted = cityOptionsForRegion(roster, ALL_REGIONS);
    const order = sorted.map((o) => o.label);
    const indexOf = (label) => order.indexOf(label);
    assert.ok(indexOf("Baltimore, MD") >= 0, "a known option must be present");
    assert.ok(indexOf("Baltimore, MD") < indexOf("Bergenfield, NJ"), "Baltimore sorts before Bergenfield (city order, not state order)");
    assert.ok(indexOf("Bergenfield, NJ") < indexOf("Chicago, IL"), "Bergenfield sorts before Chicago");
    assert.ok(indexOf("Chicago, IL") < indexOf("Jerusalem"), "Chicago sorts before Jerusalem, even though Jerusalem has no state at all");
    assert.ok(indexOf("Jerusalem") < indexOf("Savannah, GA"), "Jerusalem sorts before Savannah");
    assert.ok(indexOf("Savannah, GA") < indexOf("Silver Spring, MD"), "Savannah sorts before Silver Spring");
    assert.ok(indexOf("Silver Spring, MD") < indexOf("Teaneck, NJ"), "Silver Spring sorts before Teaneck, even though both Baltimore and Silver Spring share MD with a NJ city sorting between them -- state never groups cities together");
  }

  // --- Regression: state is used ONLY as a tiebreaker when two cities
  // share the exact same name. A synthetic same-named-city roster proves
  // this directly (no such real pair exists in actual Production data
  // today, per the Phase 1 audit). ---
  {
    const sameNameRoster = [donor("spring-pa", "Springfield", "PA"), donor("spring-il", "Springfield", "IL"), donor("spring-ma", "Springfield", "MA")];
    const sortedSameName = cityOptionsForRegion(sameNameRoster, ALL_REGIONS).map((o) => o.label);
    assert.deepEqual(sortedSameName, ["Springfield, IL", "Springfield, MA", "Springfield, PA"], "identical city names fall back to state order");
  }

  // --- searchCityOptions: the Searchable City selector's own matching
  // logic (owner feedback, 2026-10-14), tested independently of any
  // React component. Partial, case-insensitive matching against the
  // city name; an empty/whitespace query returns every option
  // unfiltered, the same "no query means show everything" convention
  // `searchDonors()` already uses. ---
  {
    const allOptions = cityOptionsForRegion(roster, ALL_REGIONS);
    const teaneckMatches = searchCityOptions(allOptions, "tean");
    assert.deepEqual(teaneckMatches.map((o) => o.city), ["Teaneck"], "a partial, lowercase substring of the city name must match");
    const caseInsensitive = searchCityOptions(allOptions, "TEAN");
    assert.deepEqual(caseInsensitive.map((o) => o.city), ["Teaneck"], "matching must be case-insensitive");
    const mixedCase = searchCityOptions(allOptions, "ChIc");
    assert.deepEqual(mixedCase.map((o) => o.city), ["Chicago"], "mixed-case partial query must still match");
    assert.deepEqual(searchCityOptions(allOptions, ""), allOptions, "an empty query returns every option, unfiltered");
    assert.deepEqual(searchCityOptions(allOptions, "   "), allOptions, "a whitespace-only query returns every option, unfiltered");
    assert.deepEqual(searchCityOptions(allOptions, "zzz-not-a-real-city"), [], "a query matching nothing returns an empty list, not an error");
    // A query matching more than one city returns all of them, still in
    // the caller's own already-sorted order (this function reorders
    // nothing -- see cityOptionsForRegion's own sort).
    const sillyRoster = [...roster, { id: "silver-spring-dup", city: "Silverton", state: "OR" }];
    const silverMatches = searchCityOptions(cityOptionsForRegion(sillyRoster, ALL_REGIONS), "silver");
    assert.deepEqual(silverMatches.map((o) => o.city), ["Silver Spring", "Silverton"], "multiple matching cities are all returned, in alphabetical order");
    // State also matches (a reasonable, documented superset of "partial
    // city names") -- typing a state abbreviation narrows to that state's
    // cities too.
    const stateMatches = searchCityOptions(allOptions, "md");
    assert.deepEqual(stateMatches.map((o) => o.city).sort(), ["Baltimore", "Silver Spring"], "a state abbreviation also narrows the options");
  }

  console.log("donor-geo-filter: ok");
}

await run();
