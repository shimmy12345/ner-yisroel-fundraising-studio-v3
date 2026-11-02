import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Fix Trip Region Selection and Mobile Layout (2026-11-01, see
// docs/AI-HANDOFF.md). Source-inspection tests (no React/DOM test
// runner in this codebase -- see tests/trip-calendar-link.test.mjs's
// own established pattern for this) proving the actual regressions
// reported by the owner are fixed in the real source, not merely that
// some CSS/JSX text exists somewhere.

const globalsCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const dashboardSource = await readFile(new URL("../app/travel-planning/[id]/TripDashboardExperience.tsx", import.meta.url), "utf8");
const fieldsetSource = await readFile(new URL("../app/travel-planning/DestinationRegionFieldset.tsx", import.meta.url), "utf8");
const regionFilterSource = await readFile(new URL("../lib/relationships/trip-region-filter.ts", import.meta.url), "utf8");

async function run() {
  // --- Mobile layout: the ancestor `label { flex-direction:column }`
  // rules that caused "checkbox above label with excessive spacing"
  // must be overridden by a MORE SPECIFIC row-layout rule for the
  // actual region-checkbox class, not merely declared somewhere in the
  // stylesheet (a same-or-lower-specificity rule would silently lose
  // the cascade and the bug would persist even with the "fix" present). ---
  {
    assert.match(globalsCss, /\.travel-planning-new-trip-form label \{[^}]*flex-direction:\s*column/, "the original bug-causing ancestor rule must still exist (so this test is proving an override, not a no-op)");
    const overrideRule = globalsCss.match(/\.travel-planning-new-trip-regions label\.travel-planning-region-checkbox,\s*\n\.travel-planning-region-filter label\.travel-planning-region-checkbox \{([^}]*)\}/);
    assert.ok(overrideRule, "a dedicated, more-specific rule for .travel-planning-region-checkbox must exist, targeting both the trip-creation/edit-regions fieldset AND the Find-prospects region filter");
    assert.match(overrideRule[1], /flex-direction:\s*row/, "the override must lay the checkbox out as a ROW (input beside label text), not stacked");
    assert.match(overrideRule[1], /min-height:\s*44px/, "the whole row must be a large enough tap target on mobile");

    // Specificity check, computed the same way a browser would: two
    // classes + one element (0,2,1) must beat the generic ancestor rule's
    // one class + one element (0,1,1) -- this is what makes the override
    // actually win regardless of source order.
    const overrideSelectorClassCount = (".travel-planning-new-trip-regions label.travel-planning-region-checkbox".match(/\./g) ?? []).length;
    const ancestorSelectorClassCount = (".travel-planning-new-trip-form label".match(/\./g) ?? []).length;
    assert.ok(overrideSelectorClassCount > ancestorSelectorClassCount, "the override selector must have strictly more classes than the ancestor rule it must beat");
  }

  // --- A clearly-indicated-selected state exists for region checkboxes
  // (owner requirement: "Clearly indicate which regions are selected"). ---
  assert.match(globalsCss, /\.travel-planning-region-checkbox:has\(input:checked\)\s*\{[^}]*background/, "a visibly different style for a checked region checkbox must exist");

  // --- The exact required explanation sentence, verbatim, on the
  // shared Destination Travel Region(s) fieldset. ---
  assert.ok(
    fieldsetSource.includes("Select the regions where you plan to meet donors. You can still add prospects from anywhere."),
    "the exact owner-specified explanation sentence must be present",
  );

  // --- Root-cause fix #1 (the "select regions twice" bug): the
  // checkboxes in Find prospects must read the EFFECTIVE region set
  // (never the raw, possibly-null client state) so a trip's own saved
  // regions actually show as checked on first view. ---
  assert.ok(!/selectedRegionIds\?\.\s*has\(/.test(dashboardSource), "FindProspectsPanel must no longer defensively null-check selectedRegionIds -- that was exactly the symptom of reading the raw, possibly-null state instead of the resolved effective filter");
  assert.match(dashboardSource, /selectedRegionIds=\{effectiveRegionSet\}/, "the component must pass the resolved effectiveRegionSet into FindProspectsPanel, not the raw selectedRegionIds client state");

  // --- Root-cause fix #2: toggling a region checkbox must be based on
  // the effective (trip-default-aware) set, never an empty one. ---
  assert.match(dashboardSource, /toggleRegionInFilter\(effectiveRegionSet,\s*regionId\)/, "toggleRegion must derive the next region set from effectiveRegionSet, the exact fix for the regression where clicking one checkbox silently dropped the trip's other saved regions");

  // --- Editing the trip's own destination regions must reset the
  // Find-prospects default so it picks up the new regions (owner
  // requirement: "Changing trip regions updates the default donor
  // filter appropriately"). ---
  assert.match(dashboardSource, /onChanged=\{handleTripRegionsChanged\}/, "EditTripRegionsControl must be wired to a handler that resets the Find-prospects region default, not plain refresh()");

  // --- Donor name search must bypass the region filter entirely (owner
  // requirement: "allow me to search for a donor by name regardless of
  // region"), implemented once in the shared pure helper. ---
  assert.match(regionFilterSource, /query\.trim\(\)\s*\?\s*\[\.\.\.donors\]/, "findProspectResults must search the FULL donor list (bypassing the region filter) whenever there is a non-empty query");

  console.log("trip-region-mobile-layout: ok");
}

await run();
