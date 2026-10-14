import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Searchable City selector -- owner feedback on the Phase 2 geographic
// filtering deployment (2026-10-14). This codebase has no React
// component-rendering test harness anywhere (every existing test is a
// plain function or a source-level check -- see tests/donor-navigation.
// test.mjs's own "reads the actual source" convention), and this round
// was explicitly told not to add a dependency to build one. These tests
// exercise the PURE matching/sorting logic directly (tests/donor-geo-
// filter.test.mjs) and verify the component's keyboard/ARIA wiring the
// same way donor-navigation.test.mjs already verifies other React
// component wiring: by reading the actual source and asserting the
// real handlers are present, not a reimplementation of them.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CityComboBox: accessible combobox semantics are wired", async () => {
  const source = await read("app/donors/CityComboBox.tsx");
  assert.match(source, /role="combobox"/);
  assert.match(source, /aria-autocomplete="list"/);
  assert.match(source, /aria-expanded=\{open\}/);
  assert.match(source, /aria-controls=\{listId\}/);
  assert.match(source, /aria-activedescendant=/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /role="option"/);
  assert.match(source, /aria-selected=/);
});

test("CityComboBox: keyboard navigation (ArrowDown/ArrowUp/Enter/Escape) is wired", async () => {
  const source = await read("app/donors/CityComboBox.tsx");
  assert.match(source, /"ArrowDown"/);
  assert.match(source, /"ArrowUp"/);
  assert.match(source, /"Enter"/);
  assert.match(source, /"Escape"/);
  // Escape reverts (closes/discards the in-progress typed text) rather
  // than clearing the committed selection -- Escape and the explicit
  // clear button are deliberately two different actions.
  assert.match(source, /event\.key === "Escape"[\s\S]{0,200}revert\(\)/);
  // The same IME-composition guard every other Escape handler in this
  // codebase already uses (see app/capture/DonorAutocomplete.tsx),
  // reused here rather than reinvented.
  assert.match(source, /isComposing/);
});

test("CityComboBox: All Cities and an explicit clear action are both present", async () => {
  const source = await read("app/donors/CityComboBox.tsx");
  assert.match(source, /All Cities/);
  assert.match(source, /ALL_CITIES/);
  assert.match(source, /city-combobox-clear/);
  assert.match(source, /Clear city filter/);
});

test("CityComboBox: mousedown on an option is prevented so blur never cancels a click (mobile and desktop)", async () => {
  const source = await read("app/donors/CityComboBox.tsx");
  // The exact race DonorAutocomplete's own onMouseDown comment documents
  // -- without this, a tap/click on an option fires blur (closing the
  // list) before the click handler runs.
  const mousedownGuards = source.match(/onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/g) ?? [];
  assert.ok(mousedownGuards.length >= 2, "both the clear button and each option button must guard against blur-before-click");
});

test("CityComboBox: never a second donor-search engine -- built only from the shared geo-filter module, no new dependency", async () => {
  const source = await read("app/donors/CityComboBox.tsx");
  assert.match(source, /from "\.\.\/\.\.\/lib\/relationships\/donor-geo-filter"/);
  assert.match(source, /searchCityOptions/);
  // Only React and the one local module are imported -- no external
  // package (no react-select, downshift, combobox library, etc.).
  const importLines = source.split("\n").filter((line) => line.trim().startsWith("import "));
  for (const line of importLines) {
    assert.ok(/^import .* from "(react|\.\.\/)/.test(line.trim()), `unexpected import: ${line}`);
  }
  assert.doesNotMatch(source, /searchDonors/, "must never reimplement or call into the donor text-search engine");
});

test("Geographic Filtering: the directory experience wires CityComboBox in place of the old <select>", async () => {
  const [experience] = await Promise.all([read("app/donors/DonorDirectoryExperience.tsx")]);
  assert.match(experience, /import \{ CityComboBox \} from "\.\/CityComboBox"/);
  assert.match(experience, /<CityComboBox\b/);
  assert.match(experience, /options=\{cityOptions\}/);
  assert.match(experience, /value=\{cityKey\}/);
  assert.match(experience, /onChange=\{handleCityChange\}/);
  // The Travel Region filter is unchanged -- still a plain <select>,
  // confirming this round touched City only, per its own explicit scope.
  assert.match(experience, /<select value=\{regionId\}/);
});
