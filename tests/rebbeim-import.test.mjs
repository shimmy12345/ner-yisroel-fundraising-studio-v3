import assert from "node:assert/strict";
import {
  flattenRebbeimImportRows,
  buildRebbeimImportPreview,
  summarizeRebbeimImportPreview,
} from "../lib/relationships/rebbeim.ts";

const BERKOWITZ = { id: "rebbi-berkowitz", displayName: "Harav Berkowitz", normalizedName: "berkowitz" };
const FRAND = { id: "rebbi-frand", displayName: "Harav Frand", normalizedName: "frand" };
const CANONICAL = [BERKOWITZ, FRAND];

const DONOR_LOOKUP = new Map([
  ["48637", [{ donorId: "donor-1", donorName: "Mr. & Mrs. Eitan Pfeiffer" }]],
  ["99999", [{ donorId: "donor-dup-a", donorName: "A" }, { donorId: "donor-dup-b", donorName: "B" }]], // ambiguous
]);

function row(donorCode, rebbeim) {
  return { "Donor Code": donorCode, "Rebbeim": rebbeim };
}

// --- flattenRebbeimImportRows ---

{
  // Known donor + one Rebbi.
  const flat = flattenRebbeimImportRows([row("48637", "Harav Berkowitz")]);
  assert.deepEqual(flat, [{ rowNumber: 2, donorCodeRaw: "48637", rebbiNameRaw: "Harav Berkowitz" }]);
}
{
  // Known donor + multiple semicolon-separated Rebbeim.
  const flat = flattenRebbeimImportRows([row("48637", "Harav Berkowitz; Harav Frand")]);
  assert.deepEqual(flat.map((f) => f.rebbiNameRaw), ["Harav Berkowitz", "Harav Frand"]);
}
{
  // Duplicate Rebbi names within the same row are deduped (case/whitespace/
  // honorific-insensitive) before classification ever sees them.
  const flat = flattenRebbeimImportRows([row("48637", "Harav Berkowitz; Rav Berkowitz; HARAV BERKOWITZ")]);
  assert.equal(flat.length, 1, "exact-duplicate Rebbi names within one row must collapse to a single flattened row");
}
{
  // Blank Rebbeim field is a no-op -- produces zero flattened rows.
  const flat = flattenRebbeimImportRows([row("67890", "")]);
  assert.deepEqual(flat, []);
}
{
  // Duplicate rows across the file (same donor code + Rebbi repeated as
  // two separate CSV rows, the "Rebbi" singular-column format) also
  // collapse to one.
  const flat = flattenRebbeimImportRows([{ "Donor Code": "48637", "Rebbi": "Harav Berkowitz" }, { "Donor Code": "48637", "Rebbi": "Harav Berkowitz" }]);
  assert.equal(flat.length, 1, "an exact duplicate row across the file must collapse to a single flattened row");
}
{
  // The singular "Rebbi" column format, one name per row.
  const flat = flattenRebbeimImportRows([{ "Donor Code": "48637", "Rebbi": "Harav Berkowitz" }, { "Donor Code": "48637", "Rebbi": "Harav Frand" }]);
  assert.equal(flat.length, 2);
}

// --- classification / preview ---

{
  // Known donor + known Rebbi, no existing relationship -> ready_to_add.
  const preview = buildRebbeimImportPreview([row("48637", "Harav Berkowitz")], DONOR_LOOKUP, CANONICAL, new Set());
  assert.equal(preview.length, 1);
  assert.equal(preview[0].status, "ready_to_add");
  assert.equal(preview[0].canCommit, true);
  assert.equal(preview[0].matchedDonorId, "donor-1");
  assert.equal(preview[0].matchedRebbiId, "rebbi-berkowitz");
}
{
  // Existing relationship -> already_exists, safe no-op, never re-added.
  const existing = new Set(["donor-1\u001frebbi-berkowitz"]);
  const preview = buildRebbeimImportPreview([row("48637", "Harav Berkowitz")], DONOR_LOOKUP, CANONICAL, existing);
  assert.equal(preview[0].status, "already_exists");
  assert.equal(preview[0].canCommit, false);
}
{
  // Unknown donor code -> blocked/review, never guessed.
  const preview = buildRebbeimImportPreview([row("00000", "Harav Berkowitz")], DONOR_LOOKUP, CANONICAL, new Set());
  assert.equal(preview[0].status, "unmatched_donor");
  assert.equal(preview[0].canCommit, false);
  assert.equal(preview[0].matchedDonorId, null);
}
{
  // Ambiguous donor code (matches more than one live donor) -> blocked/review.
  const preview = buildRebbeimImportPreview([row("99999", "Harav Berkowitz")], DONOR_LOOKUP, CANONICAL, new Set());
  assert.equal(preview[0].status, "ambiguous_donor");
  assert.equal(preview[0].canCommit, false);
}
{
  // Unknown Rebbi -> blocked/review, never auto-created.
  const preview = buildRebbeimImportPreview([row("48637", "Harav Someone Unknown")], DONOR_LOOKUP, CANONICAL, new Set());
  assert.equal(preview[0].status, "unrecognized_rebbi");
  assert.equal(preview[0].canCommit, false);
  assert.equal(preview[0].matchedRebbiId, null);
}
{
  // Blank Rebbeim field -> no preview row at all (true no-op, not an error).
  const preview = buildRebbeimImportPreview([row("48637", "")], DONOR_LOOKUP, CANONICAL, new Set());
  assert.equal(preview.length, 0);
}

// --- summary ---

{
  const preview = buildRebbeimImportPreview(
    [row("48637", "Harav Berkowitz; Harav Frand"), row("00000", "Harav Berkowitz"), row("99999", "Harav Berkowitz"), row("48637", "Harav Unknown")],
    DONOR_LOOKUP,
    CANONICAL,
    new Set(["donor-1\u001frebbi-frand"]),
  );
  const summary = summarizeRebbeimImportPreview(preview);
  assert.equal(summary.ready_to_add, 1); // 48637 + Berkowitz
  assert.equal(summary.already_exists, 1); // 48637 + Frand
  assert.equal(summary.unmatched_donor, 1); // 00000
  assert.equal(summary.ambiguous_donor, 1); // 99999
  assert.equal(summary.unrecognized_rebbi, 1); // 48637 + Unknown
}

// --- Preview/commit semantic parity ---
// The preview route and the commit route both call buildRebbeimImportPreview
// with the SAME inputs shape -- re-running it a second time (simulating a
// re-import of an already-committed file, where existingPairs now include
// everything the first commit wrote) must show every previously-added row
// as already_exists, never re-added -- the exact idempotency the commit
// route's guarded INSERT also guarantees independently.
{
  const firstPass = buildRebbeimImportPreview([row("48637", "Harav Berkowitz")], DONOR_LOOKUP, CANONICAL, new Set());
  assert.equal(firstPass[0].status, "ready_to_add");
  const afterCommitPairs = new Set([`${firstPass[0].matchedDonorId}\u001f${firstPass[0].matchedRebbiId}`]);
  const secondPass = buildRebbeimImportPreview([row("48637", "Harav Berkowitz")], DONOR_LOOKUP, CANONICAL, afterCommitPairs);
  assert.equal(secondPass[0].status, "already_exists", "re-importing the same approved file must be idempotent");
}

process.stdout.write("Rebbeim bulk-import checks passed.\n");
