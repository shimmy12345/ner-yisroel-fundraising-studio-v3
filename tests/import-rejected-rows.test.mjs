import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { buildRejectedRows, resolveRejectionDecisions } from "../lib/import/jl-donation-rejection-review.ts";

const base = { Code: "JL-1", Name: "Fictional Family", "Total Due": "100", "Item Num": "GIFT", Desc: "Education support", Campaign: "ANNUAL", "Due Date": "2025-06-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };

async function run() {
  const unmatchedRow = { ...base, Code: "JL-404" };
  const nonfinancialRow = { ...base, "Item Num": "DINNER", Desc: "Complimentary reservation", Amount: "0", Paid: "0", "Balance Due": "0" };
  const duplicateA = { ...base, Code: "JL-1", "Transaction ID": "T-1" };
  const duplicateB = { ...base, Code: "JL-1", "Transaction ID": "T-1", "Due Date": "2025-07-01" };

  const preview = await buildJlDonationPreview([base, unmatchedRow, nonfinancialRow, duplicateA, duplicateB], new Date("2026-08-08"));
  const households = [{ id: "donor-jl-1", external_id: "JL-1" }];
  const match = matchJlDonationActivities(preview, households, []);

  assert.equal(match.matched.length, 2, "the original row plus the kept (first) occurrence of the repeated transaction ID both match the known household");
  assert.equal(match.unknownActivities.length, 1, "the unmatched JL code row");
  assert.equal(match.nonfinancialActivities.length, 1, "the nonfinancial row");
  assert.equal(preview.duplicateRows.length, 1, "the second occurrence of the repeated transaction ID is a hard, in-file duplicate");

  // ---- 2. Hard rejection shows a reason and offers no resolution path. ----
  const rejectedRows = buildRejectedRows(preview.duplicateRows, match.unknownActivities, match.nonfinancialActivities);
  assert.equal(rejectedRows.length, 3);
  const hardRow = rejectedRows.find((row) => row.category === "duplicate_transaction_id");
  assert.equal(hardRow.severity, "hard");
  assert.match(hardRow.reason, /already used earlier in this same file/);
  assert.notEqual(hardRow.existingMatchRow, null, "the row this one duplicates within the file must be identified");
  // Hard rows are never passed into resolveRejectionDecisions at all -- there
  // is structurally no "import anyway" path for them, safe or otherwise.
  const unmatchedActivity = match.unknownActivities[0];
  const nonfinancialActivity = match.nonfinancialActivities[0];
  const noOpResolution = resolveRejectionDecisions(match.unknownActivities, match.nonfinancialActivities, [{ fingerprint: hardRow.fingerprint, action: "import_anyway" }], new Map());
  assert.equal(noOpResolution.approvedActivities.length, 0, "a decision targeting a hard-rejected fingerprint must never resolve anything, since that fingerprint is never a candidate");

  // ---- 3. Reviewable rejections can be resolved. ----
  const householdByCode = new Map([["jl-1", "donor-jl-1"]]);
  const matchDonorResolution = resolveRejectionDecisions(
    match.unknownActivities,
    match.nonfinancialActivities,
    [
      { fingerprint: unmatchedActivity.fingerprint, action: "match_donor", correctedJlCode: "JL-1" },
      { fingerprint: nonfinancialActivity.fingerprint, action: "import_anyway" },
    ],
    householdByCode,
  );
  assert.equal(matchDonorResolution.unresolvedFingerprints.length, 0);
  assert.equal(matchDonorResolution.approvedActivities.length, 2);
  const resolvedUnmatched = matchDonorResolution.approvedActivities.find((activity) => activity.fingerprint === unmatchedActivity.fingerprint);
  assert.equal(resolvedUnmatched.donorId, "donor-jl-1");
  assert.equal(resolvedUnmatched.externalHouseholdId, "JL-1", "the corrected code replaces the original for the imported record");
  const resolvedNonfinancial = matchDonorResolution.approvedActivities.find((activity) => activity.fingerprint === nonfinancialActivity.fingerprint);
  assert.equal(resolvedNonfinancial.donorId, "donor-jl-1");

  // Do not offer "Import anyway" for an unmatched code without first
  // correcting/matching it: a decision with no corrected code and no
  // household match must stay unresolved, not silently import to nowhere.
  const noMatchResolution = resolveRejectionDecisions(match.unknownActivities, [], [{ fingerprint: unmatchedActivity.fingerprint, action: "match_donor", correctedJlCode: "JL-DOES-NOT-EXIST" }], householdByCode);
  assert.equal(noMatchResolution.approvedActivities.length, 0);
  assert.deepEqual(noMatchResolution.unresolvedFingerprints, [unmatchedActivity.fingerprint]);

  // ---- 4. An edited value preserves the original source value in the audit trail. ----
  const edit = matchDonorResolution.edits.find((item) => item.fingerprint === unmatchedActivity.fingerprint);
  assert.equal(edit.field, "JL Code");
  assert.equal(edit.originalValue, "JL-404");
  assert.equal(edit.correctedValue, "JL-1");
  assert.equal(resolvedUnmatched.sourceValues.Code, "JL-404", "the original source row value must remain in source_snapshot even after correction");
  assert.equal(resolvedUnmatched.sourceValues.fundraisingOsCorrectedJlCode, "JL-1");

  // ---- 5. Review Later writes nothing. ----
  const reviewLaterResolution = resolveRejectionDecisions(
    match.unknownActivities,
    match.nonfinancialActivities,
    [{ fingerprint: unmatchedActivity.fingerprint, action: "review_later" }, { fingerprint: nonfinancialActivity.fingerprint, action: "review_later" }],
    householdByCode,
  );
  assert.equal(reviewLaterResolution.approvedActivities.length, 0, "review_later must never produce an approved/insertable activity");
  assert.equal(reviewLaterResolution.unresolvedFingerprints.length, 0, "an explicit review_later choice is resolved, not left unresolved/blocking");

  // No decision at all must block commit (unresolved), never silently guess.
  const noDecisionResolution = resolveRejectionDecisions(match.unknownActivities, match.nonfinancialActivities, [], householdByCode);
  assert.equal(noDecisionResolution.approvedActivities.length, 0);
  assert.equal(noDecisionResolution.unresolvedFingerprints.length, 2);

  // ---- 6. Bulk resolution only affects eligible matching rows. ----
  // A second unmatched-code row and a second nonfinancial row, to prove a
  // bulk decision set for one category never touches the other category.
  const secondUnmatchedRow = { ...base, Code: "JL-500", "Due Date": "2025-02-01" };
  const secondNonfinancialRow = { ...base, "Item Num": "AD", Desc: "Included ad, no charge", Amount: "0", Paid: "0", "Balance Due": "0", "Due Date": "2025-03-01" };
  const bulkPreview = await buildJlDonationPreview([unmatchedRow, secondUnmatchedRow, nonfinancialRow, secondNonfinancialRow], new Date("2026-08-08"));
  const bulkMatch = matchJlDonationActivities(bulkPreview, households, []);
  assert.equal(bulkMatch.unknownActivities.length, 2);
  assert.equal(bulkMatch.nonfinancialActivities.length, 2);
  // Simulate a bulk "Import anyway" applied only to the nonfinancial group.
  const bulkDecisions = bulkMatch.nonfinancialActivities.map((activity) => ({ fingerprint: activity.fingerprint, action: "import_anyway" }));
  const bulkResolution = resolveRejectionDecisions(bulkMatch.unknownActivities, bulkMatch.nonfinancialActivities, bulkDecisions, householdByCode);
  assert.equal(bulkResolution.approvedActivities.length, 2, "the bulk action must resolve every row in its own eligible group");
  assert.ok(bulkResolution.approvedActivities.every((activity) => bulkMatch.nonfinancialActivities.some((nf) => nf.fingerprint === activity.fingerprint)), "a bulk action for one category must never resolve rows from a different category");
  assert.equal(bulkResolution.unresolvedFingerprints.length, 2, "the untouched unmatched-code rows remain unresolved");

  // ---- 7. Final totals match only actually imported rows. ----
  const finalNewActivities = [...match.matched, ...matchDonorResolution.approvedActivities];
  assert.equal(finalNewActivities.length, 4, "only the originally matched rows plus the two explicitly resolved rows are ever counted as imported");
  assert.ok(!finalNewActivities.some((activity) => activity.fingerprint === hardRow.fingerprint), "a hard-rejected row must never be counted as imported");

  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");

  // ---- 1. The rejected-rows count opens a dedicated review queue. ----
  assert.match(importExperience, /id="rejected-rows-queue"/);
  assert.match(importExperience, /rejected rows — click to review/);
  assert.match(importExperience, /document\.getElementById\("rejected-rows-queue"\)\?\.scrollIntoView/);

  // Hard rows render no action control at all.
  assert.match(importExperience, /item\.severity === "hard" \? <p className="payment-review-note">/);
  assert.match(importExperience, /Correct JL Code/);
  assert.match(importExperience, /rejected-rows-bulk-group/);
  assert.match(importExperience, /Hard rejected <b>\{hardRejectedRows\.length\}<\/b>/);
  assert.match(importExperience, /Unresolved <b>\{unresolvedRejectedRows\}<\/b>/);

  assert.match(previewRoute, /buildRejectedRows\(/);
  assert.match(importRoute, /resolveRejectionDecisions\(/);
  assert.doesNotMatch(previewRoute, /resolveRejectionDecisions/, "preview must never resolve rejection decisions -- only detect and describe them");
  assert.match(importRoute, /Review every rejected row before importing\./);

  process.stdout.write("Rejected rows review workflow checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
