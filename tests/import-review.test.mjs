import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { classifyJlImportType, countStrongDonationIndicators } from "../lib/import/jl-export-type.ts";
import { resolvePossibleDuplicateDecisions } from "../lib/import/jl-donation-review.ts";

const base = { Code: "JL-900", Name: "Fictional Family", "Total Due": "100", "Item Num": "GIFT", Desc: "Education support", Campaign: "ANNUAL", "Due Date": "2025-06-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };

async function run() {
  // 1. A donation export must be detected only as a donation, even when it
  // also carries the household-shape "Code"/"Name" columns that would
  // otherwise trigger the (much looser) household check.
  const fullDonationColumns = Object.keys(base);
  assert.equal(classifyJlImportType(fullDonationColumns, [base]), "donation");
  const partialDonation = { Code: "JL-2", Name: "Partial Export", Campaign: "ANNUAL", "Due Date": "2025-01-01", Amount: "50.00", Paid: "50.00", "Balance Due": "0" };
  assert.equal(countStrongDonationIndicators(Object.keys(partialDonation), [partialDonation]), 5);
  assert.equal(classifyJlImportType(Object.keys(partialDonation), [partialDonation]), "donation", "a file missing one canonical donation column but carrying several strong donation indicators must never fall through to household detection");
  const donationByCompany = { Code: "JL-4", Name: "Company Marked", Amount: "25.00", Company: "Donation" };
  assert.equal(countStrongDonationIndicators(Object.keys(donationByCompany), [donationByCompany]), 2, "a literal Company=Donation value counts as a second strong indicator alongside Amount");
  assert.equal(classifyJlImportType(Object.keys(donationByCompany), [donationByCompany]), "donation");

  // 2. A genuinely ambiguous file (household-shaped columns plus exactly one
  // weak donation indicator) must stop and require an explicit choice
  // instead of being guessed.
  const ambiguous = { Code: "JL-3", Name: "Ambiguous Row", Amount: "50.00" };
  assert.equal(countStrongDonationIndicators(Object.keys(ambiguous), [ambiguous]), 1);
  assert.equal(classifyJlImportType(Object.keys(ambiguous), [ambiguous]), "ambiguous");
  const clearHousehold = { Code: "JL-5", Name: "Household Only", Email: "a@example.org", Phone: "555-0100" };
  assert.equal(classifyJlImportType(Object.keys(clearHousehold), [clearHousehold]), "household");

  // 3. Two rows with the same amount but different dates are never treated
  // as duplicates of each other; the fingerprint must depend on the date.
  const sameAmountDifferentDates = await buildJlDonationPreview([{ ...base, "Due Date": "2025-01-01" }, { ...base, "Due Date": "2025-06-15" }], new Date("2026-07-31"));
  assert.equal(sameAmountDifferentDates.duplicateRows.length, 0);
  assert.ok(sameAmountDifferentDates.activities.every((activity) => activity.duplicateStatus === null), "rows that only share an amount, on different dates, must never be flagged as possible duplicates");
  assert.notEqual(sameAmountDifferentDates.activities[0].fingerprint, sameAmountDifferentDates.activities[1].fingerprint);

  // 4. Repeated identical rows with no stable transaction ID become
  // reviewable "possible duplicate" activities rather than being silently
  // dropped or silently kept.
  const repeatedNoStableId = await buildJlDonationPreview([base, { ...base }, { ...base }], new Date("2026-07-31"));
  assert.equal(repeatedNoStableId.duplicateRows.length, 0, "content repetition without a stable ID must never be a hard rejection");
  assert.equal(repeatedNoStableId.activities.length, 3);
  assert.ok(repeatedNoStableId.activities.every((activity) => activity.duplicateStatus === "possible_duplicate" && activity.category === "needs_review"));
  assert.ok(repeatedNoStableId.activities.every((activity) => activity.underlyingCategory === "completed_gift"));
  assert.equal(new Set(repeatedNoStableId.activities.map((activity) => activity.fingerprint)).size, 3, "every occurrence needs its own unique fingerprint to be individually insertable");
  assert.ok(repeatedNoStableId.activities.every((activity) => /appears 3 times/i.test(activity.reviewReason ?? "")));

  // 5. Rows that share a stable transaction/payment ID remain true,
  // hard-rejected duplicates: a stable ID is proof, unlike bare content.
  const withStableId = { ...base, "Transaction ID": "T-4471" };
  const stableIdDuplicate = await buildJlDonationPreview([withStableId, { ...withStableId }], new Date("2026-07-31"));
  assert.equal(stableIdDuplicate.activities.length, 1);
  assert.equal(stableIdDuplicate.duplicateRows.length, 1);
  assert.equal(stableIdDuplicate.activities[0].duplicateStatus, null, "a stable-ID-proven duplicate is a hard rejection, not a reviewable possible duplicate");
  const stableIdDifferentTransactions = await buildJlDonationPreview([{ ...base, "Transaction ID": "T-1" }, { ...base, "Transaction ID": "T-2" }], new Date("2026-07-31"));
  assert.equal(stableIdDifferentTransactions.duplicateRows.length, 0, "two different stable transaction IDs are never duplicates of each other, even with identical content");
  assert.equal(stableIdDifferentTransactions.activities.length, 2);

  // 6. "Import anyway" resolves a possible-duplicate row back to its true
  // category and produces an activity that will be written and audited
  // through the same insert/change-log path as any other new activity.
  const possibleDuplicates = await buildJlDonationPreview([base, { ...base }], new Date("2026-07-31"));
  const importAnywayDecisions = possibleDuplicates.activities.map((activity) => ({ fingerprint: activity.fingerprint, action: "import_anyway" }));
  const importAnywayResolution = resolvePossibleDuplicateDecisions(possibleDuplicates.activities, importAnywayDecisions);
  assert.equal(importAnywayResolution.unresolvedFingerprints.length, 0);
  assert.equal(importAnywayResolution.approvedActivities.length, 2);
  assert.ok(importAnywayResolution.approvedActivities.every((activity) => activity.category === "completed_gift" && activity.duplicateStatus === null && activity.reviewReason === null));
  const unresolvedDecisions = resolvePossibleDuplicateDecisions(possibleDuplicates.activities, []);
  assert.equal(unresolvedDecisions.unresolvedFingerprints.length, 2, "a possible-duplicate row with no decision at all must block commit rather than being silently guessed");
  assert.equal(unresolvedDecisions.approvedActivities.length, 0);

  // 8. "Review Later" (and "Skip") must never produce a row that gets
  // written; only "Import anyway" does.
  const reviewLaterDecisions = [
    { fingerprint: possibleDuplicates.activities[0].fingerprint, action: "review_later" },
    { fingerprint: possibleDuplicates.activities[1].fingerprint, action: "skip" },
  ];
  const reviewLaterResolution = resolvePossibleDuplicateDecisions(possibleDuplicates.activities, reviewLaterDecisions);
  assert.equal(reviewLaterResolution.approvedActivities.length, 0, "review_later and skip must never write a row");
  assert.equal(reviewLaterResolution.unresolvedFingerprints.length, 0, "an explicit review_later choice is resolved, not unresolved");

  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");

  // 1/2. The preview and commit routes both classify with the same
  // mutually-exclusive function and both stop at "ambiguous" instead of
  // guessing.
  assert.match(previewRoute, /classifyJlImportType\(columns, rows\)/);
  assert.match(previewRoute, /profile: "ambiguous"/);
  assert.match(importRoute, /classifyJlImportType\(Object\.keys\(rows\[0\] \?\? \{\}\), rows\)/);
  assert.match(importRoute, /importType === "ambiguous"/);
  assert.match(importRoute, /ambiguousType: true/);

  // 6. The commit route wires possible-duplicate decisions in before
  // matching/insertion and blocks when one is missing.
  assert.match(importRoute, /resolvePossibleDuplicateDecisions\(donationPreview\.activities, reviewDecisions\)/);
  assert.match(importRoute, /Review every possible-duplicate row before importing\./);
  assert.match(importRoute, /unresolvedReviewFingerprints/);

  // 7. Pending Review is clickable and opens a dedicated, actionable queue.
  assert.match(previewRoute, /resolvable: activity\.duplicateStatus === "possible_duplicate"/);
  assert.match(importExperience, /id="review-queue"/);
  assert.match(importExperience, /scrollIntoView/);
  assert.match(importExperience, /import_anyway/);
  assert.match(importExperience, /rows in this group/);
  assert.match(importExperience, /reviewDecisions: Object\.entries\(reviewDecisions\)/);

  process.stdout.write("Import review workflow checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
