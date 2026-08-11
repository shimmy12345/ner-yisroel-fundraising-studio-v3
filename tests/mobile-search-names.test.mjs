import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { searchDonors } from "../lib/relationships/donor-search.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// Representative long household names from live-use reports that were
// being cut down to e.g. "Mr. & Mrs. David B. Rose..." on mobile,
// destroying the surname that distinguishes similar households.
const LONG_HOUSEHOLD_NAMES = [
  "Mr. & Mrs. David B. Rosenbaum",
  "Rabbi & Mrs. Avraham Rosenbaum",
  "Rabbi & Mrs. Moshe Aharon Rosenbaum",
];

async function run() {
  const directoryExperience = await read("app/donors/DonorDirectoryExperience.tsx");
  const styles = await read("app/globals.css");

  // ---- Matching logic, donor data, and D1 are untouched: the directory
  // still calls the same searchDonors() over the same DirectoryRelationship
  // shape it always did -- only the result row's presentation changed. ----
  assert.match(directoryExperience, /searchDonors\(donors, query, Number\.MAX_SAFE_INTEGER\)/);
  assert.match(directoryExperience, /searchDonors\(relationships\.map/);
  assert.doesNotMatch(directoryExperience, /env\.DB|fetch\(/, "the directory experience does not query D1 or the network directly -- it only re-renders already-fetched relationships");
  for (const name of LONG_HOUSEHOLD_NAMES) {
    // Distinguishing "Rabbi & Mrs. Avraham Rosenbaum" from "Rabbi & Mrs.
    // Moshe Aharon Rosenbaum" depends on searchDonors ranking/returning
    // both intact -- confirms the search layer itself never shortens or
    // drops a household name (only the CSS presentation was at fault).
    const donors = [{ id: "1", name, lastName: "Rosenbaum", spouse: null, code: "40021", email: "family@example.org", phone: null }];
    assert.deepEqual(searchDonors(donors, "Rosenbaum", Number.MAX_SAFE_INTEGER).map((donor) => donor.name), [name]);
  }

  // ---- Household name renders once, full-length, in normal (non-React-
  // truncated) markup -- there is no character slicing or "..." literal
  // ever applied to relationship.display_name. ----
  assert.match(directoryExperience, /<strong>\{relationship\.display_name\}<\/strong>/);
  assert.doesNotMatch(directoryExperience, /display_name\.slice|display_name\.substring|display_name\)\.concat\(.*…/);

  // ---- JL code renders in exactly two places in markup -- inline next to
  // the name (desktop) and folded into the secondary metadata line
  // (mobile) -- with CSS, not JS, deciding which one is visible per
  // viewport. A hidden (display:none) copy is removed from the
  // accessibility tree, so it is never announced twice. ----
  assert.match(directoryExperience, /className="donor-code directory-code-inline"/);
  assert.match(directoryExperience, /className="donor-code directory-code-secondary"/);
  assert.match(styles, /\.directory-code-secondary \{ display:none; \}/, "the secondary-line code copy is inert on desktop, where the inline copy already shows it");
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.directory-code-inline \{ display:none; \}/, "the inline code copy is hidden on mobile so it never competes with the name for line width");
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.directory-code-secondary \{ display:inline-block; \}/, "the secondary-line code copy becomes visible on mobile instead");

  // ---- Desktop stays a single, compact, ellipsis-truncated line (a
  // clean, dense directory list is still the goal there). ----
  assert.match(styles, /\.directory-identity-name strong \{ min-width:0; overflow:hidden; color:var\(--ink\); font-size:16px; text-overflow:ellipsis; white-space:nowrap; \}/, "desktop keeps the compact single-line name");

  // ---- Mobile allows the name to wrap onto a second line instead of
  // truncating -- this is the actual fix for the bug report. ----
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.directory-identity-name strong \{ font-size:15px; overflow:visible; text-overflow:unset; white-space:normal; word-break:break-word; \}/, "mobile lets the household name wrap instead of ellipsizing the surname");

  // ---- Secondary info (last name / household members / location) still
  // truncates before the primary name ever would -- and email/phone may
  // still truncate too, per the "secondary can truncate, name cannot"
  // hierarchy. ----
  assert.match(styles, /\.directory-identity-meta-text \{ min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; \}/);
  assert.match(styles, /\.directory-contact \{ min-width:0; overflow:hidden; color:#58675f; font-size:13px; text-overflow:ellipsis; white-space:nowrap; \}/);

  // ---- Avatar/initials stay a fixed, aligned column regardless of how
  // many lines the name wraps to. ----
  assert.match(styles, /\.directory-avatar \{ flex:none; width:44px; height:44px; display:grid; place-items:center;/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.directory-row \{ grid-template-columns:44px 1fr 18px; align-items:flex-start; padding:14px; \}/, "avatar aligns to the top of a possibly multi-line name instead of the row's full height");

  process.stdout.write("Mobile search name checks passed.\n");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
