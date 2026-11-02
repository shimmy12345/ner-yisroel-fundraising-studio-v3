import assert from "node:assert/strict";
import { effectiveRegionFilter, toggleRegionInFilter, findProspectResults } from "../lib/relationships/trip-region-filter.ts";
import { ALL_REGIONS } from "../lib/relationships/donor-geo-filter.ts";

// Fix Trip Region Selection and Mobile Layout (2026-11-01, see
// docs/AI-HANDOFF.md). Root-cause regression coverage for "I have to
// select my trip's regions again in Find prospects": the raw
// `selectedRegionIds` client state is `null` until the fundraiser's
// own click (or a `?regions=` URL param) sets it, and BOTH the
// checkbox display AND the toggle-from-default behavior must treat
// that `null` as "defer to the trip's own saved destination regions,"
// never as an empty set -- otherwise the first checkbox clicked
// silently drops every other region the trip was already scoped to.

function donor(id, city, state, extra = {}) {
  return { id, name: id, lastName: null, spouse: null, code: null, email: null, phone: null, city, state, ...extra };
}

async function run() {
  // --- effectiveRegionFilter: the "default donor filter" itself. ---
  {
    // Untouched (null) + trip has saved regions -> exactly those regions.
    const result = effectiveRegionFilter(null, ["chicago-suburbs", "st-louis-suburbs"]);
    assert.ok(result instanceof Set);
    assert.deepEqual([...result].sort(), ["chicago-suburbs", "st-louis-suburbs"]);

    // Untouched (null) + trip has ONE saved region -> exactly that region.
    const single = effectiveRegionFilter(null, ["nyc-boroughs"]);
    assert.deepEqual([...single], ["nyc-boroughs"]);

    // Untouched (null) + trip has NO saved regions -> fall back to every
    // region, never a filter that hides every donor.
    assert.equal(effectiveRegionFilter(null, []), ALL_REGIONS);

    // Explicit "All regions" always wins, regardless of the trip's own regions.
    assert.equal(effectiveRegionFilter(ALL_REGIONS, ["chicago-suburbs"]), ALL_REGIONS);

    // An explicit, non-null Set the fundraiser already chose is returned
    // as-is -- it is never silently overridden by the trip's own regions.
    const explicit = new Set(["israel"]);
    assert.equal(effectiveRegionFilter(explicit, ["chicago-suburbs"]), explicit);
  }

  // --- toggleRegionInFilter: the actual root-cause fix. Toggling must
  // start from what the trip is ALREADY scoped to, not from empty. ---
  {
    // The exact regression scenario: a trip saved with two regions,
    // nothing touched yet (so the effective filter is both of them),
    // and the fundraiser clicks ONE region checkbox. The other region
    // must survive the click, not disappear -- this is "select regions
    // twice" from the fundraiser's point of view.
    const tripDefault = effectiveRegionFilter(null, ["chicago-suburbs", "st-louis-suburbs"]);
    const afterClickingChicago = toggleRegionInFilter(tripDefault, "chicago-suburbs");
    assert.deepEqual([...afterClickingChicago].sort(), ["st-louis-suburbs"], "unchecking one of the trip's two default regions must leave the other region checked, not clear everything");

    // Clicking a region NOT already in the default set adds it, keeping
    // the trip's own defaults intact (the "search/add from other
    // regions whenever needed" requirement).
    const afterAddingIsrael = toggleRegionInFilter(tripDefault, "israel");
    assert.deepEqual([...afterAddingIsrael].sort(), ["chicago-suburbs", "israel", "st-louis-suburbs"]);

    // Toggling from "All regions" starts a fresh, single-region set --
    // never attempts to "remove" a region from the conceptual universe.
    const fromAll = toggleRegionInFilter(ALL_REGIONS, "israel");
    assert.deepEqual([...fromAll], ["israel"]);

    // Toggling an already-selected region off a real Set removes it.
    const removed = toggleRegionInFilter(new Set(["israel", "chicago-suburbs"]), "israel");
    assert.deepEqual([...removed], ["chicago-suburbs"]);
  }

  // --- findProspectResults: region browsing vs. name search. ---
  {
    const donors = [
      donor("chicago-1", "Chicago", "IL"),
      donor("stl-1", "St. Louis", "MO"),
      donor("miami-1", "Miami", "FL", { name: "Miami Cohen", lastName: "Cohen" }),
    ];

    // Browsing (empty query) respects the region filter.
    const browseChicago = findProspectResults(donors, new Set(["chicago-suburbs"]), "");
    assert.deepEqual(browseChicago.map((d) => d.id), ["chicago-1"]);

    // "All regions" browsing returns everyone.
    const browseAll = findProspectResults(donors, ALL_REGIONS, "");
    assert.deepEqual(browseAll.map((d) => d.id).sort(), ["chicago-1", "miami-1", "stl-1"]);

    // A name search finds a donor OUTSIDE the currently-checked region(s)
    // -- the explicit "allow me to search for a donor by name regardless
    // of region" requirement. Region filter here is narrowed to Chicago
    // only, yet searching "Cohen" (a Miami donor) still finds him.
    const searchOutsideRegion = findProspectResults(donors, new Set(["chicago-suburbs"]), "cohen");
    assert.deepEqual(searchOutsideRegion.map((d) => d.id), ["miami-1"], "a name search must find a donor even when their region is not checked");

    // An empty/whitespace-only query falls back to pure region browsing.
    const whitespaceQuery = findProspectResults(donors, new Set(["chicago-suburbs"]), "   ");
    assert.deepEqual(whitespaceQuery.map((d) => d.id), ["chicago-1"]);

    // Results are resolved back to the FULL caller record (extra fields
    // like a custom `extra` property survive the search roundtrip).
    const resolved = findProspectResults(donors, ALL_REGIONS, "cohen");
    assert.equal(resolved[0].lastName, "Cohen");
  }

  console.log("trip-region-filter: ok");
}

await run();
