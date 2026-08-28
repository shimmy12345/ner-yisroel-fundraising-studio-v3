import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Portfolio Focus Phase 2B -- dedicated route/page wiring, structural,
// and accessibility checks (source-text assertions, same convention as
// tests/today.test.mjs). Adapter logic itself is covered by
// tests/portfolio-focus-dedicated-view.test.mjs.

const page = await readFile(new URL("../app/portfolio-focus/page.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../app/portfolio-focus/PortfolioFocusExperience.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("../app/components/AppShell.tsx", import.meta.url), "utf8");
const today = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const donorNav = await readFile(new URL("../lib/navigation/donor-navigation.ts", import.meta.url), "utf8");

// ---- Route exists, real page, correct nav section ----
assert.match(page, /export default async function PortfolioFocusPage/);
assert.match(page, /<AppShell active="today">/, "Portfolio Focus is reached exclusively from Today for now (no persistent nav item -- see below), so it belongs under the Today nav section like every other Today-adjacent sub-page in this app");
assert.match(page, /title: "Portfolio Focus"/);

// ---- Single engine call per render, no recompute per filter/expand ----
assert.equal((page.match(/computePortfolioFocus\(/g) ?? []).length, 1, "the dedicated route must call the engine exactly once per render");
assert.doesNotMatch(experience, /computePortfolioFocus/, "the client-side filtering/expansion component must never call the engine itself -- it only slices/filters the already-computed rows passed down as props");
assert.doesNotMatch(experience, /cloudflare:workers|env\.DB/, "the client component must have no D1 access of any kind");

// ---- Live-mode gating + fail-soft behavior (never breaks the shell, never fakes data) ----
assert.match(page, /mode === "live"/);
assert.match(page, /try \{[\s\S]*?computePortfolioFocus\(profile\.id, profile\.timezone, now\)[\s\S]*?\} catch \(error\) \{[\s\S]*?logger\.error\("portfolio_focus_dedicated_load_failed", error, \{ userId: profile\.id \}\);/);
assert.match(page, /failed\s*\?/, "a computation failure must render a distinct, restrained error state");
assert.match(page, /rows\.length === 0/, "zero ranked donors must render a distinct, restrained empty state, never an empty table or fabricated rows");
assert.doesNotMatch(page, /throw /, "the page must never rethrow -- a failure degrades to the restrained error state");
assert.match(page, /Try reloading the page/, "the error state must offer a normal reload path");

// ---- No raw score/internal terminology outside the technical-detail disclosure ----
const beforeTechToggle = experience.split('<details className="tech-toggle">')[0];
for (const rawField of ["compositeScore", "baseComposite", "coverageFloor", "momentumLabel", "pledgeStaleClass", "financialConfidence", "relationshipConfidence"]) {
  assert.doesNotMatch(beforeTechToggle, new RegExp(rawField), `${rawField} must never render outside the "Show technical detail" disclosure`);
}
assert.match(experience, new RegExp(`tech-toggle[\\s\\S]*compositeScore`), "technical detail, once opened, must still show the real composite score");
assert.match(experience, /Show technical detail/);
assert.match(experience, /determined this donor's composite score/, "the technical disclosure must explicitly say when the Coverage floor determined the composite, per item 24");

// ---- Filters: semantic buttons, ARIA state, grouped by display label ----
assert.match(experience, /aria-pressed=\{filter === option\.id\}/);
assert.match(experience, /<nav className="portfolio-focus-filters"/);
assert.doesNotMatch(experience, /<input type="range"/, "no score/dollar sliders");
assert.match(experience, /Suggested Action available only/);
assert.match(experience, /<input type="checkbox"/);

// ---- Per-donor expand/collapse: native <details>, no clickable divs ----
assert.match(experience, /<details className="pf-row">/);
assert.match(experience, /<summary className="pf-row-summary">/);
assert.doesNotMatch(experience, /<div[^>]*onClick/, "expand/collapse must use native <details>/<summary>, never a clickable div");
// The donor link must live in the expanded body, never inside <summary>,
// so clicking the link can never also fire the row's own open/close toggle.
const summaryBlock = experience.split("</summary>")[0];
assert.doesNotMatch(summaryBlock, /<a /, "no link may sit inside the row's <summary> -- a nested link there would create a conflicting click target with the disclosure toggle itself");
assert.match(experience, /Open donor →/);
assert.match(experience, /donorNavigationHref\(row\.donorId, "\/portfolio-focus", "portfolio-focus"\)/);

// ---- "Show full portfolio" expands the SAME already-loaded result, never a second computation ----
assert.match(experience, /Show full portfolio/);
assert.match(experience, /setVisibleCount\(visible\.length\)/);
assert.doesNotMatch(experience, /fetch\(/, "expansion/filtering must never issue a network request -- everything is already in memory");

// ---- Filtering must never renumber (rank stays intact under a filter) ----
assert.doesNotMatch(experience, /\.map\(\(row, index\)/, "rows must never be re-indexed/renumbered when rendered -- rank always comes from row.rank, set once server-side");
assert.match(experience, /\{row\.rank\}/);

// ---- Today: quiet "See full portfolio" link added, nothing else about the Phase 2A card redesigned ----
assert.match(today, /<a className="view-all-link command-view-all" href="\/portfolio-focus">See full portfolio →<\/a>/);
assert.ok(today.indexOf("today-command-grid") < today.indexOf("portfolio-focus-section"), "Phase 2A placement must remain unchanged");
assert.match(today, /Five relationships worth keeping in mind this month/, "the Phase 2A intro copy must be unchanged");

// ---- Navigation decision: deliberately NO persistent primary nav item (Option B) ----
assert.doesNotMatch(appShell, /"portfolio-focus"/, "Portfolio Focus is reachable via Today's own link, not a persistent sidebar item -- see docs/AI-HANDOFF.md Phase 2B for the reasoning; this pins the decision so it isn't silently added later without a documented reconsideration");

// ---- Donor navigation: a real, distinct return path/label exists ----
assert.match(donorNav, /"portfolio-focus"/);
assert.match(donorNav, /Back to Portfolio Focus/);

// ---- Responsive: mobile card transform, no fixed multi-column table, filter chips may scroll ----
assert.doesNotMatch(experience, /<table/i, "the dedicated view must never render a literal desktop table");
assert.match(styles, /@media \(max-width:820px\) \{\s*\.pf-row-summary \{ flex-direction:column/, "the row summary must become a stacked vertical card below the mobile breakpoint");
assert.match(styles, /@media \(max-width:700px\) \{\s*\.portfolio-focus-filters \{ flex-wrap:nowrap[\s\S]*overflow-x:auto/, "filter chips may scroll horizontally on narrow viewports rather than wrapping into a dense block");

process.stdout.write("Portfolio Focus dedicated route checks passed.\n");
