import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DIRECTORY_ALPHABET,
  DIRECTORY_OTHER_LETTER,
  donorDirectoryLetter,
  donorDirectoryNonEmptyLetters,
  filterDonorDirectory,
  compareDonorsByLastName,
} from "../lib/relationships/donor-search.ts";

// Log Interaction -> Multiple donors browseable directory (docs/AI-HANDOFF.md).
// Pure logic lives in lib/relationships/donor-search.ts (reused from the
// existing single-donor search/autocomplete, not a second donor-loading
// path); this file covers that logic plus, per this codebase's established
// convention for its UI layer (see tests/shared-activity-ux.test.mjs), the
// exact source patterns that prove RecipientPicker.tsx wires it up safely.

function donor(overrides = {}) {
  return { id: "d1", name: "Household", primaryFirstName: null, lastName: null, spouse: null, code: null, email: null, phone: null, ...overrides };
}

// ---- Canonical last-name letter grouping ----

{
  // Title prefixes must never affect grouping -- the canonical lastName
  // field wins, not the display text.
  const ramras = donor({ id: "r1", name: "Rabbi & Mrs. Shimmy Ramras", lastName: "Ramras" });
  assert.equal(donorDirectoryLetter(ramras), "R", "a title prefix in the display name must not shift the letter group");
}

{
  // A missing last name still lets effectiveDonorLastName() extract a real
  // word from the display name (its own existing, intentional fallback) --
  // this donor groups under "F" for "Fund", not "#", which is correct: a
  // usable name word was found.
  const namedFund = donor({ id: "f1", name: "Anonymous Fund", lastName: null });
  assert.equal(donorDirectoryLetter(namedFund), "F");
}

{
  // Only when no usable name can be extracted at all does grouping fall
  // back to the "#" bucket, never a fabricated letter.
  const genuinelyUnnamed = donor({ id: "n1", name: "", lastName: null });
  assert.equal(donorDirectoryLetter(genuinelyUnnamed), DIRECTORY_OTHER_LETTER);
}

{
  // effectiveDonorLastName()'s own honorific-only fallback: if lastName
  // itself were stored as a bare honorific, grouping still falls back to a
  // real name word, not "R" for "Rabbi".
  const bareHonorific = donor({ id: "h1", name: "Rabbi Yosef Klein", lastName: "Rabbi" });
  assert.equal(donorDirectoryLetter(bareHonorific), "K");
}

// ---- filterDonorDirectory(): All / letter / search interaction ----

const directory = [
  donor({ id: "a1", name: "Mr. & Mrs. Aryeh Adler", lastName: "Adler" }),
  donor({ id: "a2", name: "Rabbi & Mrs. Shimmy Ramras", lastName: "Ramras" }),
  donor({ id: "a3", name: "Mr. & Mrs. Baruch Berman", lastName: "Berman" }),
  donor({ id: "a4", name: "Dr. & Mrs. Yaakov Schwartz", lastName: "Schwartz" }),
  donor({ id: "a5", name: "Mrs. Chana Schneider", lastName: "Schneider" }),
  donor({ id: "a6", name: "", lastName: null }),
];

{
  // All shows the full donor list.
  const all = filterDonorDirectory(directory, "all", "");
  assert.equal(all.length, directory.length, "All + blank search must show every donor");
}

{
  // A letter filter shows only that letter's last names.
  const onlyA = filterDonorDirectory(directory, "A", "");
  assert.deepEqual(onlyA.map((d) => d.id), ["a1"], "the A filter must show only A last names");
}

{
  const onlyS = filterDonorDirectory(directory, "S", "");
  assert.deepEqual(new Set(onlyS.map((d) => d.id)), new Set(["a4", "a5"]), "the S filter must show only S last names");
}

{
  // Sorting: canonical last name ascending, then display name ascending.
  const all = filterDonorDirectory(directory, "all", "");
  const sorted = [...directory].sort(compareDonorsByLastName);
  assert.deepEqual(all.map((d) => d.id), sorted.map((d) => d.id), "results must be sorted by canonical last name, then display name");
  const order = all.map((d) => d.id);
  assert.ok(order.indexOf("a1") < order.indexOf("a2"), "Adler must sort before Ramras (canonical last name, not display text)");
}

{
  // Missing last name goes to the fallback bucket, not "All" only.
  const other = filterDonorDirectory(directory, DIRECTORY_OTHER_LETTER, "");
  assert.deepEqual(other.map((d) => d.id), ["a6"]);
}

{
  // Search + letter interaction: "S" + "sch" matches only S donors
  // containing "sch" (both Schwartz and Schneider qualify); "All" +
  // "schwartz" matches Schwartz regardless of letter -- the documented,
  // chosen behavior (search narrows WITHIN the active letter).
  const sSch = filterDonorDirectory(directory, "S", "sch");
  assert.deepEqual(new Set(sSch.map((d) => d.id)), new Set(["a4", "a5"]));
  const allSchwartz = filterDonorDirectory(directory, "all", "schwartz");
  assert.deepEqual(allSchwartz.map((d) => d.id), ["a4"]);
  // Searching "schwartz" while the letter filter is pinned to a DIFFERENT
  // letter finds nothing -- search never escapes the active letter.
  const bSchwartz = filterDonorDirectory(directory, "B", "schwartz");
  assert.deepEqual(bSchwartz, []);
}

{
  // Clearing search back to blank restores the full letter-filtered set.
  const sBlank = filterDonorDirectory(directory, "S", "");
  assert.equal(sBlank.length, 2);
}

// ---- Empty-letter detection (used to disable buttons) ----

{
  const nonEmpty = donorDirectoryNonEmptyLetters(directory);
  assert.ok(nonEmpty.has("A") && nonEmpty.has("S") && nonEmpty.has("B") && nonEmpty.has(DIRECTORY_OTHER_LETTER));
  assert.ok(!nonEmpty.has("Z"), "a letter with zero donors must not appear in the non-empty set, so the UI can disable it");
  assert.equal(DIRECTORY_ALPHABET.length, 26, "the alphabet strip covers exactly A-Z");
}

// ---- RecipientPicker.tsx: selection persistence + safety, via source inspection ----
// (This codebase's UI layer has no component-rendering test harness --
// see tests/shared-activity-ux.test.mjs's own header comment -- so, as
// there, behavior is verified by reading the real, committed source.)

const recipientPicker = await readFile(new URL("../app/capture/RecipientPicker.tsx", import.meta.url), "utf8");
const captureExperience = await readFile(new URL("../app/capture/CaptureExperience.tsx", import.meta.url), "utf8");

{
  // Filtering state (query, letter) is separate React state from selection
  // (selectedIds, owned by the parent and never reset by this component) --
  // structurally, a letter/search change can only ever change `results`,
  // never call onChange to drop a selection.
  assert.match(recipientPicker, /const \[query, setQuery\] = useState\(""\);/);
  assert.match(recipientPicker, /const \[letter, setLetter\] = useState<string \| null>\(null\);/);
  assert.match(recipientPicker, /const results = useMemo\(\(\) => filterDonorDirectory\(donors, activeLetter, query\), \[donors, activeLetter, query\]\);/, "filtering must be derived, not stored as or copied into selection state");
  assert.doesNotMatch(recipientPicker, /setQuery\([\s\S]{0,20}\);\s*onChange\(/, "changing the search query must never also call onChange (which would touch selection)");
  assert.doesNotMatch(recipientPicker, /setLetter\([\s\S]{0,20}\);\s*onChange\(/, "changing the letter filter must never also call onChange (which would touch selection)");
}

{
  // Default filter is All (docs/AI-HANDOFF.md): browsing starts unfiltered,
  // no typing required.
  assert.match(recipientPicker, /const activeLetter = letter \?\? "all";/);
}

{
  // Clear selection is an explicit, visible action -- never automatic.
  assert.match(recipientPicker, /Clear selection/);
  assert.match(recipientPicker, /onClick=\{\(\) => onChange\(\[\]\)\}/);
}

{
  // The running selected count is shown.
  assert.match(recipientPicker, /\$\{selectedIds\.length\} selected/);
}

{
  // Duplicate-proof selection (Set-backed toggle) -- unchanged by this
  // redesign, and re-asserted here in case this file is ever the only one
  // exercising RecipientPicker.tsx.
  assert.match(recipientPicker, /const selectedSet = useMemo\(\(\) => new Set\(selectedIds\)/);
  assert.match(recipientPicker, /if \(selectedSet\.has\(donorId\)\) \{\s*onChange\(selectedIds\.filter/);
  assert.match(recipientPicker, /disabled=\{!checked && atCap\}/);
}

{
  // Accessible, semantic controls: real checkboxes wrapped in a label (so
  // clicking the row toggles it natively), and real buttons for the
  // alphabet strip with an explicit pressed state (never color alone).
  assert.match(recipientPicker, /<input type="checkbox" className="recipient-picker-check" checked=\{checked\}/);
  assert.match(recipientPicker, /aria-pressed=\{activeLetter === option\}/);
  assert.match(recipientPicker, /aria-pressed=\{activeLetter === "all"\}/);
  assert.match(recipientPicker, /disabled=\{!nonEmptyLetters\.has\(option\)\}/, "an empty letter must be disabled, not hidden");
}

{
  // Single-donor mode's save payload must never include the multi-donor
  // selection -- switching back to Single donor cannot silently submit a
  // hidden multi-selection, because the single-donor request body never
  // references recipientIds/donorIds in the first place.
  const saveInteractionStart = captureExperience.indexOf("async function saveInteraction()");
  const saveInteractionEnd = captureExperience.indexOf("\n  }", captureExperience.indexOf("setStatus(\"error\");", saveInteractionStart));
  const saveInteractionBody = captureExperience.slice(saveInteractionStart, saveInteractionEnd);
  assert.doesNotMatch(saveInteractionBody, /recipientIds/, "the single-donor save request must never reference the multi-donor selection");
  assert.match(saveInteractionBody, /donorId,/, "the single-donor save request must still send the single donorId");
}

{
  // The shared-activity submission payload (the one field that DOES carry
  // recipientIds) is unchanged by this redesign.
  assert.match(captureExperience, /donorIds: recipientIds,/);
}

console.log("Donor directory picker checks passed.");
