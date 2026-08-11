import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildUnifiedTimeline } from "../lib/relationships/unified-timeline.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function run() {
  // ---- Homepage hierarchy: Morning Brief and Quick Actions must be
  // visible near the top, ahead of the detailed agenda grid (this is
  // additionally verified by ordering assertions in tests/today.test.mjs). ----
  const today = await read("app/page.tsx");
  const briefIndex = today.indexOf("today-brief-section");
  const actionsIndex = today.indexOf("today-actions-section");
  const gridIndex = today.indexOf("today-command-grid");
  assert.ok(briefIndex >= 0 && actionsIndex >= 0 && gridIndex >= 0, "all three homepage sections must be present");
  assert.ok(briefIndex < actionsIndex && actionsIndex < gridIndex, "Morning Brief and Quick Actions render before the agenda grid in source order");

  // ---- Mobile navigation: the sidebar collapses to a bottom tab bar with
  // 4 real destinations (Today/Donors/Import/Assistant) that previously
  // wrapped a 4th item into an unreachable second row inside a fixed
  // 72px-tall bar, and separately hid Help/Settings entirely. A 5th "More"
  // tab now reaches them instead of cramming them into the primary row. ----
  const appShell = await read("app/components/AppShell.tsx");
  const mobileMoreMenu = await read("app/components/MobileMoreMenu.tsx");
  const styles = await read("app/globals.css");
  assert.match(appShell, /MobileMoreMenu/);
  assert.match(appShell, /<MobileMoreMenu active=\{active\} profile=/);
  assert.match(mobileMoreMenu, /href="\/help"/);
  assert.match(mobileMoreMenu, /href="\/settings"/);
  assert.match(mobileMoreMenu, /"use client"/);
  assert.match(mobileMoreMenu, /Escape/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.nav \{ grid-template-columns: repeat\(5, 1fr\); \}/, "the mobile tab bar must have exactly as many columns as visible tabs (4 primary + More)");
  assert.match(styles, /\.nav-more \{ display:none; \}|\.nav-more, \.nav-more-backdrop, \.nav-more-panel \{ display: none; \}/, "the More trigger and panel must be inert on desktop, where Help/Settings remain reachable via .sidebar-bottom");

  // ---- Donor giving/relationship history: the combined timeline (the
  // only surface that displays giving records -- see the deliberate
  // "no separate Giving History heading" rule in
  // tests/unified-relationship-timeline.test.mjs) shows the 10 most
  // recent records by default with an explicit expand/collapse control,
  // and a payment's "linked pledge" link never points at an element that
  // isn't actually rendered. ----
  const timelineComponent = await read("app/donors/[id]/UnifiedRelationshipTimeline.tsx");
  assert.match(timelineComponent, /const RECENT_LIMIT = 10;/);
  assert.match(timelineComponent, /const visibleSlice = showAll \? visible : visible\.slice\(0, RECENT_LIMIT\);/, "truncation slices the already newest-first-sorted list rather than re-sorting it");
  assert.match(timelineComponent, /Show all \{visible\.length\}/);
  assert.match(timelineComponent, /Show recent \{RECENT_LIMIT\}/);
  assert.match(timelineComponent, /const linkedPledgeVisible = item\.linkedPledgeExists && visibleGivingIds\.has/);
  assert.match(timelineComponent, /setShowAll\(true\)/);
  assert.match(timelineComponent, /setFilter\(next\);\s*setShowAll\(false\);/, "switching filters resets to the recent-10 view instead of inheriting an expanded state from a different filter");
  assert.match(timelineComponent, /href={`#pledge-/, "a visible linked pledge still renders as a real, working anchor");
  assert.match(timelineComponent, /Linked pledge is unavailable/, "a genuinely orphaned pledge link is still reported honestly, unchanged from before");

  // Pure-logic sanity check: for a donor with far more than 10 giving
  // records, the same slicing formula used by the component keeps the
  // newest 10 (buildUnifiedTimeline already sorts newest-first; this is
  // covered directly in tests/unified-relationship-timeline.test.mjs).
  // Spaced a day apart (normalizeFinancialDate floors to the calendar day)
  // so each gift lands on a distinct, strictly increasing date.
  const manyGifts = Array.from({ length: 25 }, (_, index) => ({
    id: `gift-${index}`, donor_id: "fictional-donor", external_source: "JL Solutions",
    activity_date: 1_000_000_000 + index * 100_000, committed_cents: 5_000, paid_cents: 5_000, balance_cents: 0,
    item_type: "Gift", description: `Gift ${index}`, source_campaign: null, category: "completed_gift",
    workspace_status: "active", private_note: null, updated_at: 1_000_000_000 + index * 100_000,
  }));
  const timeline = buildUnifiedTimeline({ giving: manyGifts, legacyGifts: [], payments: [], interactions: [], reminders: [], now: 2_000_000_000 });
  assert.equal(timeline.length, 25);
  assert.equal(timeline[0].key, "giving:gift-24", "newest gift sorts first");
  const recentTen = timeline.slice(0, 10);
  assert.deepEqual(recentTen.map((item) => item.key), Array.from({ length: 10 }, (_, index) => `giving:gift-${24 - index}`), "the visible 10 are the 10 most recent, still newest-first");

  // ---- Donor directory result-row layout: fixed avatar column, JL code
  // rendered inline with the household name instead of stacked as its own
  // block line, and single-line truncation so long names/emails cannot
  // distort the row or its neighbors. ----
  const directoryExperience = await read("app/donors/DonorDirectoryExperience.tsx");
  assert.match(directoryExperience, /directory-identity-name/);
  assert.match(styles, /\.directory-row \{ display:grid; grid-template-columns:44px minmax\(0,1\.3fr\) minmax\(0,1fr\) auto 20px;/, "the avatar column must be exactly the avatar's own width (44px), not a mismatched value");
  assert.match(styles, /\.directory-identity-name strong \{ min-width:0; overflow:hidden;.*text-overflow:ellipsis; white-space:nowrap;/, "long household names truncate instead of wrapping and growing the row");
  assert.match(styles, /\.directory-contact \{ min-width:0; overflow:hidden;.*text-overflow:ellipsis; white-space:nowrap;/, "long emails truncate instead of wrapping and growing the row");
  assert.match(styles, /\.directory-identity \.donor-code \{ flex:none; margin:0; display:inline-block; \}/, "JL code sits inline next to the name in this context instead of stacking as its own line");

  // ---- Duplicate search surfaces: the donor directory search input no
  // longer renders its own dropdown result list -- DonorAutocomplete's
  // dropdown is opt-in via showResults, and the directory search passes
  // false so only the live-filtered .directory-list below shows matches. ----
  const autocomplete = await read("app/capture/DonorAutocomplete.tsx");
  const directorySearch = await read("app/donors/DonorDirectorySearch.tsx");
  assert.match(autocomplete, /showResults\?:/, "showResults must be optional so existing single-donor pickers (capture, giving management) are unaffected");
  assert.match(autocomplete, /const showDropdown = showResults && open;/);
  assert.match(autocomplete, /\{showDropdown && <div className="donor-autocomplete-results"/);
  assert.match(directorySearch, /showResults=\{false\}/);
  assert.doesNotMatch(directorySearch, /window\.location\.assign/, "selection navigation now happens exclusively through the results list below, not this input");
  // The capture donor picker and the giving-record "correct donor match"
  // picker are single-field selectors, not a full-page results list --
  // they keep the default dropdown behavior (showResults defaults to true).
  const capture = await read("app/capture/CaptureExperience.tsx");
  const givingManagement = await read("app/donors/[id]/GivingManagement.tsx");
  assert.doesNotMatch(capture, /showResults=\{false\}/);
  assert.doesNotMatch(givingManagement, /showResults=\{false\}/);

  process.stdout.write("Usability pass checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
