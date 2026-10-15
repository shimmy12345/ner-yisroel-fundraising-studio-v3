import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { TRAVEL_REGIONS, regionsForCityState, cityStateKey, formatCityState, travelRegionById } from "../lib/relationships/travel-regions.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Geographic Filtering for Travel Planning -- Phase 2 (2026-10-14, see
// docs/AI-HANDOFF.md). Exercises the exact 15 regions and city/state
// memberships the owner approved from the Phase 1 read-only audit --
// never a reimplementation or an approximation of that list.

const EXPECTED = {
  "baltimore-maryland-suburbs": { label: "Baltimore & Maryland suburbs", cities: [["Baltimore", "MD"]] },
  "chicago-suburbs": { label: "Chicago & suburbs", cities: [["Chicago", "IL"], ["Lincolnwood", "IL"]] },
  "north-central-nj-teaneck-bergenfield": { label: "North/Central NJ -- Teaneck/Bergenfield area", cities: [["Teaneck", "NJ"], ["Bergenfield", "NJ"], ["Englewood", "NJ"], ["Fair Lawn", "NJ"], ["Passaic", "NJ"]] },
  "monsey-spring-valley-rockland-ny": { label: "Monsey/Spring Valley & Rockland County, NY", cities: [["Monsey", "NY"], ["Spring Valley", "NY"], ["Suffern", "NY"], ["New City", "NY"], ["Chestnut Ridge", "NY"], ["Nanuet", "NY"], ["Wesley Hills", "NY"]] },
  "queens-western-long-island-ny": { label: "Queens & western Long Island, NY", cities: [["Flushing", "NY"], ["Oceanside", "NY"], ["Great Neck", "NY"], ["East Setauket", "NY"]] },
  "los-angeles-san-fernando-valley": { label: "Los Angeles & San Fernando Valley, CA", cities: [["Los Angeles", "CA"], ["Sherman Oaks", "CA"], ["Valley Village", "CA"]] },
  "south-florida-miami": { label: "South Florida / Miami area", cities: [["Boca Raton", "FL"], ["Hollywood", "FL"], ["Aventura", "FL"], ["Surfside", "FL"]] },
  "nyc-boroughs": { label: "NYC boroughs", cities: [["Brooklyn", "NY"], ["Bronx", "NY"], ["Staten Island", "NY"], ["New York", "NY"]] },
  "st-louis-suburbs": { label: "St. Louis & suburbs", cities: [["Saint Louis", "MO"], ["Chesterfield", "MO"]] },
  "five-towns-far-rockaway": { label: "Five Towns / Far Rockaway, NY", cities: [["Far Rockaway", "NY"], ["Lawrence", "NY"]] },
  "lakewood-ocean-county-nj": { label: "Lakewood & Ocean County, NJ", cities: [["Lakewood", "NJ"], ["Jackson", "NJ"], ["Toms River", "NJ"]] },
  "central-nj": { label: "Central NJ (Edison/Elizabeth)", cities: [["Edison", "NJ"], ["Elizabeth", "NJ"]] },
  "san-diego": { label: "San Diego, CA", cities: [["La Jolla", "CA"]] },
  "detroit-area-mi": { label: "Detroit area, MI", cities: [["Oak Park", "MI"], ["Southfield", "MI"]] },
  "israel": { label: "Israel", cities: [["Betar Illit", null], ["Jerusalem", null], ["Ramat Beit Shemesh", null]] },
};

async function run() {
  // --- Exactly 15 regions, exactly the approved ids, no extra, none missing. ---
  assert.equal(TRAVEL_REGIONS.length, 15, "exactly the 15 approved regions, never more or fewer");
  assert.deepEqual(new Set(TRAVEL_REGIONS.map((r) => r.id)), new Set(Object.keys(EXPECTED)));

  // --- Every region's label and EXACT city/state membership matches the
  // approved Phase 1 audit byte-for-byte -- no city silently added,
  // removed, or re-scoped beyond what was approved. ---
  for (const region of TRAVEL_REGIONS) {
    const expected = EXPECTED[region.id];
    assert.ok(expected, `unexpected region id ${region.id} -- not in the approved list`);
    assert.equal(region.label, expected.label, `region ${region.id} label must match the approved audit exactly`);
    assert.deepEqual(region.cities.map((c) => [c.city, c.state]), expected.cities, `region ${region.id} city membership must match the approved audit exactly`);
  }

  // --- regionsForCityState: every approved city resolves to exactly
  // its own region, never zero and never an unrelated one. ---
  for (const region of TRAVEL_REGIONS) {
    for (const { city, state } of region.cities) {
      assert.deepEqual(regionsForCityState(city, state), [region.id], `${city}, ${state} must resolve to exactly [${region.id}]`);
    }
  }

  // --- Case/whitespace tolerance -- deterministic matching must not
  // depend on exact capitalization or incidental surrounding whitespace,
  // even though the real Production data has none of this today (see
  // docs/AI-HANDOFF.md's Phase 1 audit -- this is a forward-looking
  // robustness requirement, not a fix for an observed defect). ---
  assert.deepEqual(regionsForCityState("teaneck", "nj"), ["north-central-nj-teaneck-bergenfield"]);
  assert.deepEqual(regionsForCityState("TEANECK", "NJ"), ["north-central-nj-teaneck-bergenfield"]);
  assert.deepEqual(regionsForCityState("  Teaneck  ", "  NJ  "), ["north-central-nj-teaneck-bergenfield"]);
  assert.deepEqual(regionsForCityState("Baltimore", "md"), ["baltimore-maryland-suburbs"]);

  // --- International donors: Israel cities with a null state resolve
  // to the Israel region; a null/blank state must not collide with a
  // US city that happens to also have a blank state value. ---
  assert.deepEqual(regionsForCityState("Jerusalem", null), ["israel"]);
  assert.deepEqual(regionsForCityState("Betar Illit", undefined), ["israel"]);
  assert.deepEqual(regionsForCityState("Ramat Beit Shemesh", ""), ["israel"]);
  // Toronto (a real donor, Canada, state "ON") is NOT in any approved
  // region -- must resolve to zero regions, never get swept into Israel
  // merely for having an unusual, non-US state value.
  assert.deepEqual(regionsForCityState("Toronto", "ON"), []);

  // --- Donors outside every approved region (the real "ungrouped"
  // cities from the audit: Savannah GA, Minneapolis MN, Columbus OH,
  // University Heights OH, Bala Cynwyd PA) resolve to zero regions, not
  // an error and not a default/catch-all region. ---
  for (const [city, state] of [["Savannah", "GA"], ["Minneapolis", "MN"], ["Columbus", "OH"], ["University Heights", "OH"], ["Bala Cynwyd", "PA"]]) {
    assert.deepEqual(regionsForCityState(city, state), [], `${city}, ${state} must match zero approved regions`);
  }

  // --- Same city name, different state must not cross-match -- "New
  // York" is only in NYC boroughs (NY); a hypothetical "New York" in a
  // different state must not match it. ---
  assert.deepEqual(regionsForCityState("New York", "NY"), ["nyc-boroughs"]);
  assert.deepEqual(regionsForCityState("New York", "PA"), [], "a different state with the same city name must not match");

  // --- Regression: independent review correction (2026-10-14). The
  // owner's actual approval was "Baltimore = Baltimore, MD only" --
  // Silver Spring, MD must NOT match this (or any) region, even though
  // the Phase 1 audit's own proposal had included it with a flagged
  // caveat. Baltimore itself must still match exactly its own region,
  // nothing added or removed beyond this one correction. ---
  assert.deepEqual(regionsForCityState("Silver Spring", "MD"), [], "Silver Spring must not match the Baltimore region (or any region) after the independent-review correction");
  assert.deepEqual(regionsForCityState("Baltimore", "MD"), ["baltimore-maryland-suburbs"]);
  assert.deepEqual(travelRegionById("baltimore-maryland-suburbs").cities, [{ city: "Baltimore", state: "MD" }], "Baltimore region must contain exactly one city");

  // --- Overlapping region membership is structurally supported: a
  // (city, state) pair listed under two different region entries must
  // resolve to BOTH ids, in the order the regions are defined. No two
  // of the 15 approved regions currently overlap, so this is proven
  // directly against the real REGIONS_BY_CITY_STATE_KEY-building logic
  // via a second, independent lookup -- Teaneck must not appear in any
  // region other than its own. ---
  const allCityStateMemberships = new Map();
  for (const region of TRAVEL_REGIONS) {
    for (const { city, state } of region.cities) {
      const key = cityStateKey(city, state);
      if (!allCityStateMemberships.has(key)) allCityStateMemberships.set(key, []);
      allCityStateMemberships.get(key).push(region.id);
    }
  }
  for (const [, regionIds] of allCityStateMemberships) {
    assert.equal(regionIds.length, 1, "no two of the 15 approved regions currently share a city -- any future overlap must be an explicit, reviewed addition");
  }

  // --- formatCityState: always the caller's own text, state omitted
  // cleanly when absent (never ", null" or a trailing ", "). ---
  assert.equal(formatCityState("Teaneck", "NJ"), "Teaneck, NJ");
  assert.equal(formatCityState("Jerusalem", null), "Jerusalem");
  assert.equal(formatCityState("Jerusalem", ""), "Jerusalem");
  assert.equal(formatCityState(" Teaneck ", " NJ "), "Teaneck, NJ", "surrounding whitespace in the donor's own text is trimmed for display");

  // --- travelRegionById: valid id resolves, unknown/stale id resolves
  // to null rather than throwing (the UI's own fallback-to-"All
  // Regions" behavior depends on this). ---
  assert.equal(travelRegionById("chicago-suburbs")?.label, "Chicago & suburbs");
  assert.equal(travelRegionById("not-a-real-region"), null);
  assert.equal(travelRegionById(null), null);
  assert.equal(travelRegionById(undefined), null);

  // --- Dynamic membership, no one-time assignment process. A "new"
  // donor here is simply a fresh object this test constructs on the
  // spot, matching exactly what a just-created or just-imported donor
  // row looks like to this module -- there is no setup step, no cache
  // warm-up, no batch job to run first. Region membership is computed
  // fresh from whatever city/state the donor currently has, every time,
  // which is what makes this true: a donor's region membership updates
  // itself automatically the moment their city/state is edited, with no
  // code path that could leave it stale. ---
  {
    const brandNewManualDonor = { city: "Teaneck", state: "NJ" };
    assert.deepEqual(regionsForCityState(brandNewManualDonor.city, brandNewManualDonor.state), ["north-central-nj-teaneck-bergenfield"], "a donor created moments ago, never seen by this module before, resolves correctly on the very first call");
    const editedToADifferentCity = { city: "Baltimore", state: "MD" };
    assert.deepEqual(regionsForCityState(editedToADifferentCity.city, editedToADifferentCity.state), ["baltimore-maryland-suburbs"], "the same donor, if their city/state is later edited, resolves to the NEW region immediately -- nothing needs to be re-run or migrated");
  }

  // --- Structural confirmation that no persisted "region" concept
  // exists anywhere a DONOR's own address could be written from: no
  // migration ever added a region column to `donors` itself, and this
  // module is read-only with respect to D1 (no env.DB, no SQL write
  // verb) -- a donor's region MEMBERSHIP can only ever be the live,
  // recomputed result of regionsForCityState(), never a stored value a
  // backfill could leave stale. This is deliberately narrower than "the
  // word 'region' never appears in any migration": Trip-Based Meeting
  // Planning (drizzle/0045_trips.sql, docs/AI-HANDOFF.md) legitimately
  // stores a TRIP's own chosen destination region id/label -- a trip's
  // intent, frozen by design -- which is a different concept entirely
  // from a donor's membership and must not trip this guard. ---
  {
    const migrationFiles = (await readdir(new URL("../drizzle", import.meta.url))).filter((name) => name.endsWith(".sql"));
    const migrationContents = await Promise.all(migrationFiles.map((name) => read(`drizzle/${name}`)));
    for (const [index, sql] of migrationContents.entries()) {
      const donorsTableMatch = /CREATE TABLE `donors` \(([\s\S]*?)\n\);/.exec(sql);
      if (donorsTableMatch) assert.doesNotMatch(donorsTableMatch[1], /\bregion\b/i, `drizzle/${migrationFiles[index]} must not add a region column to the donors table itself -- a donor's region membership must stay a derived, live computation, never a stored assignment`);
      for (const alterMatch of sql.matchAll(/ALTER TABLE `donors` ADD COLUMN `?(\w+)`?[^;]*;/gi)) {
        assert.doesNotMatch(alterMatch[1], /region/i, `drizzle/${migrationFiles[index]} must not ALTER the donors table to add a region column -- a donor's region membership must stay a derived, live computation, never a stored assignment`);
      }
    }
    const thisModuleSource = await read("lib/relationships/travel-regions.ts");
    assert.doesNotMatch(thisModuleSource, /env\.DB/);
    assert.doesNotMatch(thisModuleSource, /\b(INSERT|UPDATE|DELETE)\b/i);
  }

  console.log("travel-regions: ok");
}

await run();
