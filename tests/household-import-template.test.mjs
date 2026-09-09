import assert from "node:assert/strict";
import { HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS, HOUSEHOLD_IMPORT_TEMPLATE_FILENAME, buildHouseholdImportTemplateCsv } from "../lib/import/household-import-template.ts";
import { JL_COLUMNS, JL_MAPPING } from "../lib/import/jl-solutions.ts";

// New Household Import Template (docs/AI-HANDOFF.md). This is the drift
// guard: the org's approved template contract is frozen here as a literal,
// independent of lib/import/household-import-template.ts's own derivation
// logic, so a future header rename/reorder in either place is caught
// instead of silently shipping a template the importer no longer matches.
const APPROVED_TEMPLATE_HEADERS = [
  "Code", "Name", "Address", "City", "State", "Zip Code", "Last Name", "Home", "Cell", "Country",
  "Fathers E-mail", "Fathers Cell", "Husband First Name", "Wife First Name", "Husband Title",
];

{
  assert.equal(APPROVED_TEMPLATE_HEADERS.length, 15, "the approved template has exactly 15 columns");
  assert.deepEqual([...HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS], APPROVED_TEMPLATE_HEADERS, "exact header names and order must match the approved template");
}

{
  const unique = new Set(HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS);
  assert.equal(unique.size, HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS.length, "no duplicate columns in the template");
}

{
  // Importer parity: every approved template column must still be a header
  // the real JL importer understands (JL_MAPPING is keyed by exactly the
  // headers lib/import/jl-solutions.ts's buildJlPreview()/JL_COLUMNS
  // recognize). This is what would catch the importer going stale relative
  // to the template, or vice versa.
  for (const column of APPROVED_TEMPLATE_HEADERS) {
    assert.ok(Object.hasOwn(JL_MAPPING, column), `importer no longer accepts approved template column "${column}"`);
    assert.ok(JL_COLUMNS.includes(column), `JL_COLUMNS no longer lists approved template column "${column}"`);
  }
}

{
  // "Wife Title" is a real, importer-accepted column intentionally left off
  // the distributed template -- confirmed still true, not silently removed
  // from the importer's own accepted set (which would make this exclusion
  // moot) and not silently re-added to the template.
  assert.ok(JL_COLUMNS.includes("Wife Title"), "Wife Title must still be a real importer-accepted column for this exclusion to be meaningful");
  assert.ok(!HOUSEHOLD_IMPORT_TEMPLATE_COLUMNS.includes("Wife Title"), "Wife Title must stay excluded from the distributed template");
}

{
  assert.equal(HOUSEHOLD_IMPORT_TEMPLATE_FILENAME, "fundraising-os-household-import-template.csv", "exact approved download filename");
}

{
  const csv = buildHouseholdImportTemplateCsv();
  assert.equal(csv, APPROVED_TEMPLATE_HEADERS.join(",") + "\n", "CSV is exactly the header row, comma-joined, with a single trailing newline");
  assert.equal(csv.split("\n").filter(Boolean).length, 1, "CSV has no data rows -- header only");
  assert.equal(csv, "Code,Name,Address,City,State,Zip Code,Last Name,Home,Cell,Country,Fathers E-mail,Fathers Cell,Husband First Name,Wife First Name,Husband Title\n", "exact literal CSV contents");
}

console.log("Household import template checks passed.");
