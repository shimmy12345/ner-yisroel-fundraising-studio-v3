import assert from "node:assert/strict";
import { extractUniqueJlCodes, sortJlCodes, jlCodesToCsv, jlCodesToClipboardText, extractUniqueJlCodeIdentities, jlCodeIdentitiesToCsv } from "../lib/import/jl-codes.ts";

// JL Codes convenience export (docs/AI-HANDOFF.md). extractUniqueJlCodes/
// extractUniqueJlCodeIdentities are the sole logic behind
// /api/import/jl-codes -- the route itself only does auth + a 3-column SQL
// SELECT (donor_code, primary_first_name, last_name) scoped to
// owner_user_id/data_source='live'/archived_at IS NULL, then hands the raw
// column values here. These tests exercise that raw-column shape directly,
// including exactly what a real SQLite SELECT would produce (nulls for
// blank cells). The plain-codes path (extractUniqueJlCodes/
// jlCodesToClipboardText/jlCodesToCsv) still backs the separate "Copy JL
// Codes" clipboard feature and the JSON {codes,count} response -- both
// unchanged by the name columns added to the CSV download.

{
  const result = extractUniqueJlCodes(["12345", "12345", "67890"]);
  assert.deepEqual(result, ["12345", "67890"], "duplicate codes must be returned once");
}

{
  const result = extractUniqueJlCodes(["12345", null, "", "   ", undefined, "67890"]);
  assert.deepEqual(result, ["12345", "67890"], "blank/null codes must be excluded");
}

{
  const result = extractUniqueJlCodes(["500", "12", "3", "70"]);
  assert.deepEqual(result, ["3", "12", "70", "500"], "purely-numeric codes sort numerically, not lexically");
}

{
  const result = extractUniqueJlCodes(["B12", "A5", "A100"]);
  assert.deepEqual(result, ["A100", "A5", "B12"], "non-numeric codes sort lexically");
}

{
  const result = extractUniqueJlCodes(["00042", "42"]);
  assert.deepEqual(result, ["00042", "42"], "leading zeros are preserved as distinct string values, never parsed to a number");
  assert.ok(result.includes("00042"), "the zero-padded form must survive unchanged");
}

{
  const result = extractUniqueJlCodes([]);
  assert.deepEqual(result, [], "zero codes returns an empty list, not an error");
}

{
  const result = sortJlCodes(["10", "2", "1"]);
  assert.deepEqual(result, ["1", "2", "10"], "sortJlCodes alone sorts numeric-only input numerically");
}

{
  const text = jlCodesToClipboardText(["12345", "67890"]);
  assert.equal(text, "12345\n67890", "clipboard text is exactly one code per line, no header, no trailing newline");
}

{
  const text = jlCodesToClipboardText([]);
  assert.equal(text, "", "empty clipboard text for zero codes");
}

{
  const csv = jlCodesToCsv(["12345", "67890"]);
  assert.equal(csv, "JL Code\n12345\n67890\n", "CSV has a header row, one code per line, trailing newline");
}

{
  const csv = jlCodesToCsv([]);
  assert.equal(csv, "JL Code\n", "CSV with zero codes is still just the header");
}

{
  // A code containing a comma is vanishingly unlikely for a real JL Code,
  // but the CSV writer must not silently corrupt the column if one exists.
  const csv = jlCodesToCsv(['1,234']);
  assert.equal(csv, 'JL Code\n"1,234"\n', "a code containing a comma is quoted, not corrupted");
}

// ============================================================
// extractUniqueJlCodeIdentities / jlCodeIdentitiesToCsv -- the First
// Name/Last Name addition to the existing CSV export.
// ============================================================

{
  // Exact 3-column header, in the required order.
  const csv = jlCodeIdentitiesToCsv([{ code: "12345", firstName: "David", lastName: "Cohen" }]);
  assert.equal(csv.split("\n")[0], "JL Code,First Name,Last Name", "the export must have exactly these three columns, in this order");
}

{
  // Correct code/name association -- not merely parallel arrays that
  // happen to line up, but each identity's own name travels with its
  // own code through dedup and sorting.
  const rows = [
    { donor_code: "500", primary_first_name: "Shira", last_name: "Levine" },
    { donor_code: "12", primary_first_name: "Avi", last_name: "Stein" },
  ];
  const identities = extractUniqueJlCodeIdentities(rows);
  assert.deepEqual(identities, [
    { code: "12", firstName: "Avi", lastName: "Stein" },
    { code: "500", firstName: "Shira", lastName: "Levine" },
  ], "codes still sort numerically; each code's own name must follow it, not the other donor's");
  const csv = jlCodeIdentitiesToCsv(identities);
  assert.equal(csv, "JL Code,First Name,Last Name\n12,Avi,Stein\n500,Shira,Levine\n");
}

{
  // Leading-zero preservation -- identical guarantee to extractUniqueJlCodes.
  const identities = extractUniqueJlCodeIdentities([
    { donor_code: "00042", primary_first_name: "Mordechai", last_name: "Katz" },
    { donor_code: "42", primary_first_name: "Someone", last_name: "Else" },
  ]);
  assert.ok(identities.some((i) => i.code === "00042"), "the zero-padded code must survive unchanged, never parsed as a number");
  assert.deepEqual(identities.map((i) => i.code), ["00042", "42"], "distinct string forms are distinct codes, same as extractUniqueJlCodes");
}

{
  // Blank-name handling: a legitimately blank first or last name (null,
  // empty string, or whitespace-only) must render as an EMPTY cell --
  // never invented, never a placeholder like "Unknown" or "N/A".
  const identities = extractUniqueJlCodeIdentities([
    { donor_code: "1", primary_first_name: null, last_name: "Goldstein" },
    { donor_code: "2", primary_first_name: "Rivka", last_name: null },
    { donor_code: "3", primary_first_name: "", last_name: "   " },
  ]);
  assert.deepEqual(identities, [
    { code: "1", firstName: null, lastName: "Goldstein" },
    { code: "2", firstName: "Rivka", lastName: null },
    { code: "3", firstName: null, lastName: null },
  ]);
  const csv = jlCodeIdentitiesToCsv(identities);
  assert.equal(csv, "JL Code,First Name,Last Name\n1,,Goldstein\n2,Rivka,\n3,,\n", "a blank name must be an empty CSV cell, with the comma still separating columns correctly");
}

{
  // A name containing a comma must be quoted, not corrupt the column count.
  const csv = jlCodeIdentitiesToCsv([{ code: "9", firstName: "Chaim", lastName: "Smith, Jr." }]);
  assert.equal(csv, 'JL Code,First Name,Last Name\n9,Chaim,"Smith, Jr."\n');
}

{
  // Zero donors -- still just the header, matching jlCodesToCsv's own
  // zero-rows behavior.
  assert.equal(jlCodeIdentitiesToCsv([]), "JL Code,First Name,Last Name\n");
}

{
  // EXISTING POPULATION/ORDERING UNCHANGED: for the same raw rows, the
  // code list (and its order) produced by the new name-aware function
  // must be byte-for-byte identical to what the original, name-less
  // extractUniqueJlCodes already produces -- this is a narrow addition
  // to the existing export, never a redefinition of which donors are
  // exported or in what order.
  const rawRows = [
    { donor_code: "500", primary_first_name: "A", last_name: "B" },
    { donor_code: null, primary_first_name: "C", last_name: "D" }, // excluded, same as before
    { donor_code: "  ", primary_first_name: "E", last_name: "F" }, // excluded, same as before
    { donor_code: "12", primary_first_name: null, last_name: null },
    { donor_code: "12", primary_first_name: "Duplicate", last_name: "Row" }, // same code seen twice
    { donor_code: "B12", primary_first_name: "G", last_name: "H" },
  ];
  const oldCodes = extractUniqueJlCodes(rawRows.map((r) => r.donor_code));
  const newCodes = extractUniqueJlCodeIdentities(rawRows).map((i) => i.code);
  assert.deepEqual(newCodes, oldCodes, "the exported donor population and ordering must be byte-for-byte unchanged by adding names");
}

console.log("JL Codes export checks passed.");
