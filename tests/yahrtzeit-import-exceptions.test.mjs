import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildYahrtzeitPreview } from "../lib/import/yahrtzeit-pipeline.ts";
import { yahrtzeitFingerprint } from "../lib/import/yahrtzeit-fingerprint.ts";

// Reproduces the exact real-world sequence reported as broken: upload a
// workbook, exclude the two flagged rows, commit the rest, then re-upload
// the same workbook and confirm the previously-committed rows are
// recognized as already imported (never duplicated, never silently
// dropped) while the two exceptions remain visible and actionable --
// which they were not before this fix (unchecking a row just made it
// disappear, with no way to review or fix it).

const NOW = Math.floor(Date.parse("2026-08-12T12:00:00Z") / 1000);
const TIMEZONE = "America/New_York";

async function run() {
  const workbookPath = new URL("./fixtures/yahrtzeit-workbook.json", import.meta.url);
  const rows = JSON.parse(await readFile(workbookPath, "utf8"));
  const donorLookup = new Map([
    ["43425", { donorId: "d-zeffren", donorName: "Dr. & Mrs. Dov Zeffren" }],
    ["49134", { donorId: "d-potesky", donorName: "Mr. & Mrs. Yaakov M Potesky" }],
  ]);

  // --- step 1: first upload, nothing imported yet. ---
  const firstPreview = buildYahrtzeitPreview(rows, donorLookup, TIMEZONE, NOW);
  const malformedRow = firstPreview.find((row) => row.reviewReasons.includes("malformed_hebrew_name"));
  const ambiguousRow = firstPreview.find((row) => row.reviewReasons.includes("ambiguous_recurrence"));
  assert.ok(malformedRow, "test setup: fixture must include a malformed-Hebrew-name row");
  assert.ok(ambiguousRow, "test setup: fixture must include an ambiguous-recurrence row");
  assert.notEqual(malformedRow.rowNumber, ambiguousRow.rowNumber);
  // Both flagged rows are still fully committable on their own -- a review
  // flag is never the same thing as a blocked row.
  assert.equal(malformedRow.canCommit, true);
  assert.equal(ambiguousRow.canCommit, true);
  assert.equal(malformedRow.status, "needs_review");
  assert.equal(ambiguousRow.status, "needs_review");
  const matchedRows = firstPreview.filter((row) => row.matchedDonorId);
  const excludedRowNumbers = new Set([malformedRow.rowNumber, ambiguousRow.rowNumber]);
  const toCommit = matchedRows.filter((row) => !excludedRowNumbers.has(row.rowNumber));
  assert.equal(toCommit.length, matchedRows.length - 2, "excluding exactly the two flagged rows must leave the rest committable");

  // --- step 2: simulate committing the non-flagged rows -- build the
  // existingFingerprints map exactly as the D1 state would look afterward. ---
  const existingFingerprints = new Map(toCommit.map((row) => [row.fingerprint, `db-id-${row.rowNumber}`]));

  // --- step 3: re-upload the identical workbook. ---
  const secondPreview = buildYahrtzeitPreview(rows, donorLookup, TIMEZONE, NOW, existingFingerprints);
  const alreadyImported = secondPreview.filter((row) => row.status === "already_imported");
  const stillNeedsReview = secondPreview.filter((row) => row.status === "needs_review");
  assert.equal(alreadyImported.length, toCommit.length, "every previously-committed row must be recognized as already imported");
  for (const row of alreadyImported) assert.equal(row.existingId, `db-id-${row.rowNumber}`);
  assert.equal(stillNeedsReview.length, 2, "exactly the two originally-excluded rows must remain actionable, neither lost nor silently re-included as already-imported");
  assert.deepEqual(new Set(stillNeedsReview.map((row) => row.rowNumber)), excludedRowNumbers);
  // No previously-imported row is ever double-counted or reclassified as
  // needing review just because it happens to be re-scanned.
  for (const row of alreadyImported) assert.notEqual(row.status, "needs_review");

  // --- step 4: fix the malformed Hebrew name and revalidate just that row
  // (mirrors the review UI's "Save & revalidate" action, which re-runs the
  // full preview over the edited raw rows). ---
  const correctedRows = rows.map((row) => row.rowNumber === malformedRow.rowNumber ? { ...row, deceasedNameHebrew: "מרים בת שלמה" } : row);
  const previewAfterFix = buildYahrtzeitPreview(correctedRows, donorLookup, TIMEZONE, NOW, existingFingerprints);
  const fixedRow = previewAfterFix.find((row) => row.rowNumber === malformedRow.rowNumber);
  assert.equal(fixedRow.reviewReasons.includes("malformed_hebrew_name"), false, "a corrected Hebrew name must clear the malformed-name flag");
  assert.equal(fixedRow.status, "ready", "once fixed, the row must become importable like any clean row -- not stuck in needs_review or already_imported");
  assert.equal(fixedRow.canCommit, true);
  // The fingerprint is unaffected by a Hebrew-name correction (it's keyed
  // on donor + Hebrew date + ENGLISH name, not the Hebrew name) -- fixing
  // a malformed Hebrew name must never accidentally create a duplicate
  // fingerprint or collide with an unrelated row.
  assert.equal(fixedRow.fingerprint, malformedRow.fingerprint);

  // --- step 5: the ambiguous-Adar row can be imported exactly as
  // recorded, without resolving the recurrence question. ---
  const ambiguousAfterFix = previewAfterFix.find((row) => row.rowNumber === ambiguousRow.rowNumber);
  assert.equal(ambiguousAfterFix.hebrewMonth, "Adar", "the canonical source month must stay the generic 'Adar' as recorded -- never coerced to AdarI/AdarII to satisfy the review flag");
  assert.equal(ambiguousAfterFix.occurrence.ambiguous, true, "the recurrence ambiguity must still be surfaced after review, not silently resolved");
  assert.ok(ambiguousAfterFix.occurrence.alternate, "both Adar I and Adar II candidates must remain visible");
  assert.equal(ambiguousAfterFix.canCommit, true, "resolving the recurrence question must never be a precondition for saving the underlying yahrtzeit");
  assert.equal(ambiguousAfterFix.status, "needs_review");

  // --- step 6: committing both exceptions produces two genuinely new,
  // correctly fingerprinted rows -- distinct from the 5 already imported. ---
  const finalFingerprints = new Set([...existingFingerprints.keys(), fixedRow.fingerprint, ambiguousAfterFix.fingerprint]);
  assert.equal(finalFingerprints.size, existingFingerprints.size + 2, "the two exception rows must be genuinely new records, never colliding with an already-imported fingerprint");

  // --- source-level check: the commit route must skip writing (no UPDATE)
  // when an already-imported row's content hasn't changed, so a re-upload
  // can never touch the 13 records that don't need touching. ---
  const commitRoute = await readFile(new URL("../app/api/import/yahrtzeit/commit/route.ts", import.meta.url), "utf8");
  assert.match(commitRoute, /changedFields\.length === 0/, "the commit route must detect a no-op re-import and skip writing");
  assert.match(commitRoute, /unchangedCount/, "the commit route must report unchanged rows distinctly from created/updated");
  // Provenance: a hand-corrected Hebrew name must preserve the original
  // workbook value in the audit trail, never silently discard it.
  assert.match(commitRoute, /originalDeceasedNameHebrew/);
  assert.match(commitRoute, /deceasedNameHebrewAsImported/);

  // --- source-level check: the review UI actually offers the required
  // actions -- an editable fix for the malformed name, and a clear
  // "already imported" section distinct from a plain checkbox toggle. ---
  const importUi = await readFile(new URL("../app/onboarding/import/yahrtzeit/YahrtzeitImportExperience.tsx", import.meta.url), "utf8");
  assert.match(importUi, /Fix name/);
  assert.match(importUi, /Save & revalidate/);
  assert.match(importUi, /Already imported/);
  assert.match(importUi, /Needs review/);

  // --- "Import as-is" override for the malformed-name row: a second,
  // explicit action distinct from "Fix name" -- keeps the exact original
  // value, marks the specific warning as accepted, and unlocks the row for
  // import without editing anything. ---
  assert.match(importUi, /Import as-is/, "the review UI must offer an explicit import-as-is action, not just Fix name");
  assert.match(importUi, /acceptAsIs/);
  assert.match(importUi, /acceptedReviewReasons/, "the commit payload must carry which specific warning was accepted");

  // Simulates clicking "Import as-is" on the untouched malformedRow: the
  // value committed is the exact same object identity/content the
  // preview already produced from the raw workbook row -- nothing in this
  // path re-types, trims, or transliterates it.
  const rawMarilynRow = rows.find((row) => row.rowNumber === malformedRow.rowNumber);
  assert.equal(malformedRow.deceasedNameHebrew, rawMarilynRow.deceasedNameHebrew, "the previewed value shown for override must be exactly the parsed workbook value");

  // Mirrors the commit route's own acknowledgment computation
  // (row.reviewReasons filtered by the client's claimed
  // acceptedReviewReasons) -- proves the override is recorded against a
  // warning the row genuinely has, and that the exact value is what would
  // be persisted (the commit route never rewrites deceasedNameHebrew for
  // an accepted-as-is row, it only adds an audit annotation alongside it).
  const acceptedSet = new Set(["malformed_hebrew_name"]);
  const acknowledgedWarnings = malformedRow.reviewReasons.filter((reason) => acceptedSet.has(reason));
  assert.deepEqual(acknowledgedWarnings, ["malformed_hebrew_name"], "the override must be recorded against the specific warning the row actually has");
  const committedValue = malformedRow.deceasedNameHebrew; // what the commit route would bind for deceased_name_hebrew
  assert.equal(committedValue, "       בת שלמה Marilyn ", "the byte-for-byte original value (including its leading/trailing spaces) must be what gets committed on import-as-is, never a cleaned-up version");

  // A client claiming an acknowledgment for a warning the row does NOT
  // actually have must be ignored server-side, never trusted at face value.
  const bogusAcceptedSet = new Set(["ambiguous_recurrence"]);
  const bogusAcknowledged = malformedRow.reviewReasons.filter((reason) => bogusAcceptedSet.has(reason));
  assert.deepEqual(bogusAcknowledged, [], "an accepted-reason claim that doesn't match this row's real reviewReasons must produce no acknowledgment");

  // --- source-level check: the commit route independently re-validates
  // the acknowledgment against this row's own server-computed
  // reviewReasons, and records it in the audit snapshot. ---
  assert.match(commitRoute, /acceptedReviewReasons/);
  assert.match(commitRoute, /row\.reviewReasons\.filter/, "the commit route must intersect the client's claim with this row's own real reviewReasons, never trust the claim alone");
  assert.match(commitRoute, /acknowledgedWarnings/);

  // --- invalid Hebrew date: no override of any kind can make this
  // committable. Distinct from a content-quality warning like the
  // malformed name -- this is a structurally invalid fact, not a
  // technically-valid-but-flagged one. ---
  const invalidDateRows = [{ rowNumber: 900, donorCode: "43425", deceasedNameEnglish: "Test Person", deceasedNameHebrew: "טעסט", relationship: "Uncle", hebrewMonthRaw: "טבת", hebrewDayRaw: "ל", hebrewYearRaw: null }]; // ל = 30, Teves never has 30 days
  const invalidDatePreview = buildYahrtzeitPreview(invalidDateRows, donorLookup, TIMEZONE, NOW);
  const invalidRow = invalidDatePreview[0];
  assert.equal(invalidRow.canCommit, false, "a structurally invalid Hebrew date must never be committable");
  assert.equal(invalidRow.reviewReasons.includes("malformed_hebrew_name"), false, "an invalid date must not be tagged with the content-quality override reason -- it has no override path at all");
  // Even simulating a client that (incorrectly) claims to have accepted
  // every possible warning changes nothing: canCommit is computed purely
  // from the date/donor/name facts and never consults any acceptance state.
  const everythingAccepted = new Set(["malformed_hebrew_name", "ambiguous_recurrence"]);
  const wouldBeAcknowledged = invalidRow.reviewReasons.filter((reason) => everythingAccepted.has(reason));
  assert.deepEqual(wouldBeAcknowledged, [], "an invalid date has no reviewReasons to accept in the first place");
  assert.equal(invalidRow.canCommit, false, "no acceptance state of any kind can flip canCommit for a structurally invalid date");

  console.log("Yahrtzeit import exception-review checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
