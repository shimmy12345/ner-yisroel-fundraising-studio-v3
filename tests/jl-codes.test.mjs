import assert from "node:assert/strict";
import { extractUniqueJlCodes, sortJlCodes, jlCodesToCsv, jlCodesToClipboardText } from "../lib/import/jl-codes.ts";

// JL Codes convenience export (docs/AI-HANDOFF.md). extractUniqueJlCodes is
// the sole logic behind /api/import/jl-codes -- the route itself only does
// auth + a single-column SQL SELECT scoped to owner_user_id/data_source=
// 'live'/archived_at IS NULL, then hands the raw donor_code column values
// here. These tests exercise that raw-column shape directly, including
// exactly what a real SQLite SELECT would produce (nulls for blank cells).

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

console.log("JL Codes export checks passed.");
