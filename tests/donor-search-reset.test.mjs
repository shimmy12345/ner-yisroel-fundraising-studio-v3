import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { donorDirectorySearchPath } from "../lib/navigation/donor-navigation.ts";
import { searchDonors } from "../lib/relationships/donor-search.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const donors = [
  { id: "2", name: "Mr. Aaron Zimmerman", lastName: "Zimmerman", spouse: null, code: null, email: null, phone: null },
  { id: "1", name: "Ms. Leah Adler", lastName: "Adler", spouse: null, code: null, email: null, phone: null },
  { id: "3", name: "Mr. David Goldstein", lastName: "Goldstein", spouse: null, code: null, email: null, phone: null },
];

test("clearing search restores the complete alphabetized directory without dropping other state", () => {
  assert.deepEqual(searchDonors(donors, "Goldstein", Number.MAX_SAFE_INTEGER).map((donor) => donor.id), ["3"]);
  assert.deepEqual(searchDonors(donors, "", Number.MAX_SAFE_INTEGER).map((donor) => donor.id), ["1", "3", "2"]);
  assert.equal(donorDirectorySearchPath("/donors?sort=last-name&filter=manual&q=Goldstein#directory", ""), "/donors?sort=last-name&filter=manual#directory");
});

test("typing search updates only q and keeps sort, filters, and anchors", () => {
  assert.equal(donorDirectorySearchPath("/donors?sort=last-name&filter=manual#directory", "Adler"), "/donors?sort=last-name&filter=manual&q=Adler#directory");
  assert.equal(donorDirectorySearchPath("/donors?sort=last-name", " "), "/donors?sort=last-name");
});

test("directory Clear and Escape share one focus-preserving reset path", async () => {
  const [autocomplete, directory, experience] = await Promise.all([
    read("app/capture/DonorAutocomplete.tsx"),
    read("app/donors/DonorDirectorySearch.tsx"),
    read("app/donors/DonorDirectoryExperience.tsx"),
  ]);
  assert.match(autocomplete, /aria-label="Clear donor search"/);
  assert.match(autocomplete, /if \(clearable && query\) clearQuery\(\)/);
  assert.match(autocomplete, /inputRef\.current\?\.focus\(\)/);
  assert.match(autocomplete, /event\.nativeEvent\.isComposing/);
  assert.match(directory, /history\.replaceState/);
  assert.doesNotMatch(directory, /location\.reload/);
  assert.match(directory, /aria-live="polite"/);
  assert.match(experience, /searchDonors\(donors, query, Number\.MAX_SAFE_INTEGER\)/);
  assert.match(experience, /relationships\.length/);
});

