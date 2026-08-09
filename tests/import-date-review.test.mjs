import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview, classifyJlDonation } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { resolveDateDecisions, findStillUnresolvedDateFingerprints } from "../lib/import/jl-donation-date-review.ts";

const base = { Code: "JL-900", Name: "Fictional Family", "Total Due": "100", "Item Num": "GIFT", Desc: "Education support", Campaign: "ANNUAL", "Due Date": "2025-06-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };
const now = new Date("2026-08-09");

// Simulates the two-pass flow used in app/api/import/route.ts: classify,
// resolve date decisions, and (only if anything was corrected/accepted)
// rebuild from the annotated rows so every normal rule reruns.
async function resolveAndRebuild(rows, decisions) {
  const initial = await buildJlDonationPreview(rows, now);
  const resolution = resolveDateDecisions(rows, initial.activities, decisions);
  if (resolution.unresolvedFingerprints.length) return { resolution, preview: initial, stillUnresolved: [] };
  const preview = resolution.appliedRowNumbers.size ? await buildJlDonationPreview(resolution.rows, now) : initial;
  const stillUnresolved = findStillUnresolvedDateFingerprints(resolution.appliedRowNumbers, preview.activities);
  return { resolution, preview, stillUnresolved };
}

async function run() {
  // ---- Impossible date is reviewable and correctable. ----
  const impossibleDateRow = { ...base, "Due Date": "2025-02-30" };
  const impossible = classifyJlDonation(impossibleDateRow, now);
  assert.equal(impossible.activityDate, null, "February 30 is not a real calendar date");
  assert.equal(impossible.dateIssue, "invalid");
  assert.equal(impossible.category, "needs_review");

  // ---- Blank required date is reviewable and correctable. ----
  const blankDateRow = { ...base, "Due Date": "" };
  const blank = classifyJlDonation(blankDateRow, now);
  assert.equal(blank.activityDate, null);
  assert.equal(blank.dateIssue, "invalid");

  // ---- Invalid date cannot be accepted as-is. ----
  const invalidPreview = await buildJlDonationPreview([impossibleDateRow], now);
  const invalidActivity = invalidPreview.activities[0];
  const acceptInvalidAttempt = resolveDateDecisions([impossibleDateRow], invalidPreview.activities, [{ fingerprint: invalidActivity.fingerprint, action: "accept_as_is" }]);
  assert.deepEqual(acceptInvalidAttempt.unresolvedFingerprints, [invalidActivity.fingerprint], "accept_as_is must never resolve a structurally invalid date");
  assert.equal(acceptInvalidAttempt.edits.length, 0);

  // Correcting the impossible date to a valid one resolves and re-validates it.
  const correctedInvalid = await resolveAndRebuild([impossibleDateRow], [{ fingerprint: invalidActivity.fingerprint, action: "correct_date", correctedDate: "2025-06-15" }]);
  assert.equal(correctedInvalid.resolution.unresolvedFingerprints.length, 0);
  assert.equal(correctedInvalid.stillUnresolved.length, 0);
  assert.equal(correctedInvalid.preview.activities[0].dateIssue, null);
  assert.equal(correctedInvalid.preview.activities[0].category, "completed_gift", "after correction, normal classification proceeds -- valid amount/payment status makes this a completed gift");

  // ---- Corrected date is revalidated: a bad correction is caught, not
  // silently accepted. ----
  const badCorrection = await resolveAndRebuild([impossibleDateRow], [{ fingerprint: invalidActivity.fingerprint, action: "correct_date", correctedDate: "2025-04-31" }]);
  assert.equal(badCorrection.resolution.unresolvedFingerprints.length, 1, "April 31 does not exist -- the correction attempt itself must be rejected");

  // ---- Historical but valid date can be accepted as-is. ----
  const historicalRow = { ...base, "Due Date": "1975-01-01" };
  const historicalClassified = classifyJlDonation(historicalRow, now);
  assert.notEqual(historicalClassified.activityDate, null, "1975-01-01 is a real calendar date");
  assert.equal(historicalClassified.dateIssue, "suspicious");
  const historicalPreview = await buildJlDonationPreview([historicalRow], now);
  const historicalActivity = historicalPreview.activities[0];
  const acceptedHistorical = await resolveAndRebuild([historicalRow], [{ fingerprint: historicalActivity.fingerprint, action: "accept_as_is" }]);
  assert.equal(acceptedHistorical.resolution.unresolvedFingerprints.length, 0);
  assert.equal(acceptedHistorical.preview.activities[0].dateIssue, null);
  assert.equal(acceptedHistorical.preview.activities[0].activityDate, historicalActivity.activityDate, "accept-as-is never changes the date value itself");
  assert.equal(acceptedHistorical.preview.activities[0].category, "completed_gift");

  // ---- Future but valid date can be accepted as-is. ----
  const futureRow = { ...base, "Due Date": "2099-01-01" };
  const futureClassified = classifyJlDonation(futureRow, now);
  assert.notEqual(futureClassified.activityDate, null);
  assert.equal(futureClassified.dateIssue, "suspicious");
  const futurePreview = await buildJlDonationPreview([futureRow], now);
  const acceptedFuture = await resolveAndRebuild([futureRow], [{ fingerprint: futurePreview.activities[0].fingerprint, action: "accept_as_is" }]);
  assert.equal(acceptedFuture.resolution.unresolvedFingerprints.length, 0);
  assert.equal(acceptedFuture.preview.activities[0].dateIssue, null);

  // ---- A suspicious date can instead be corrected rather than accepted. ----
  const correctedFuture = await resolveAndRebuild([futureRow], [{ fingerprint: futurePreview.activities[0].fingerprint, action: "correct_date", correctedDate: "2025-06-15" }]);
  assert.equal(correctedFuture.resolution.unresolvedFingerprints.length, 0);
  assert.equal(correctedFuture.preview.activities[0].dateIssue, null);
  assert.equal(correctedFuture.preview.activities[0].activityDate, Math.floor(Date.UTC(2025, 5, 15) / 1000));

  // ---- Corrected date remains date-only, with no timezone shift. ----
  assert.equal(correctedFuture.preview.activities[0].activityDate, Date.UTC(2025, 5, 15) / 1000, "a YYYY-MM-DD correction must land on exactly that UTC calendar day, never shifted by a timezone");

  // ---- Original source date remains unchanged in the audit/source
  // snapshot after correction. ----
  const correctedSourceValues = correctedFuture.preview.activities[0].sourceValues;
  assert.equal(correctedSourceValues["Due Date"], "2099-01-01", "the original source value must remain exactly as uploaded");
  assert.equal(correctedSourceValues.fundraisingOsCorrectedDate, "2025-06-15", "the correction is recorded as a separate, explicit annotation");

  // ---- Corrected row still undergoes duplicate detection and other
  // validations: correcting row 2's date onto row 1's exact date/content
  // must make them an in-file possible-duplicate group, not two silently
  // separate gifts. ----
  const duplicateTargetRow = { ...base, "Due Date": "2025-06-15" };
  const rowToCorrectOntoIt = { ...base, "Due Date": "2099-01-01" };
  const dupSetupPreview = await buildJlDonationPreview([duplicateTargetRow, rowToCorrectOntoIt], now);
  const rowTwoActivity = dupSetupPreview.activities[1];
  assert.equal(rowTwoActivity.dateIssue, "suspicious");
  const dupResolved = await resolveAndRebuild([duplicateTargetRow, rowToCorrectOntoIt], [{ fingerprint: rowTwoActivity.fingerprint, action: "correct_date", correctedDate: "2025-06-15" }]);
  assert.equal(dupResolved.resolution.unresolvedFingerprints.length, 0);
  assert.equal(dupResolved.preview.activities.length, 2);
  assert.ok(dupResolved.preview.activities.every((activity) => activity.duplicateStatus === "possible_duplicate"), "after the correction both rows share identical content with no stable ID -- normal in-file duplicate detection must catch this");
  assert.notEqual(dupResolved.preview.activities[0].fingerprint, dupResolved.preview.activities[1].fingerprint, "each occurrence still gets its own fingerprint");
  const dupMatch = matchJlDonationActivities(dupResolved.preview, [{ id: "donor-jl-900", external_id: "JL-900" }], []);
  assert.equal(dupMatch.matched.length, 0, "possible-duplicate rows are held for review, not silently matched/imported");
  assert.equal(dupMatch.needsReview, 2);

  // ---- Review Later writes nothing for that row. ----
  const reviewLaterPreview = await buildJlDonationPreview([impossibleDateRow], now);
  const reviewLaterResolution = resolveDateDecisions([impossibleDateRow], reviewLaterPreview.activities, [{ fingerprint: reviewLaterPreview.activities[0].fingerprint, action: "review_later" }]);
  assert.equal(reviewLaterResolution.unresolvedFingerprints.length, 0, "an explicit review_later choice is resolved, not blocking");
  assert.equal(reviewLaterResolution.appliedRowNumbers.size, 0, "review_later must never annotate/change the row");
  assert.deepEqual(reviewLaterResolution.rows, [impossibleDateRow]);
  const reviewLaterMatch = matchJlDonationActivities(reviewLaterPreview, [{ id: "donor-jl-900", external_id: "JL-900" }], []);
  assert.equal(reviewLaterMatch.matched.length, 0, "review_later must never produce an imported/matched row");
  assert.equal(reviewLaterMatch.needsReview, 1);

  // Skip and no-decision-at-all also behave correctly.
  const skipResolution = resolveDateDecisions([impossibleDateRow], reviewLaterPreview.activities, [{ fingerprint: reviewLaterPreview.activities[0].fingerprint, action: "skip" }]);
  assert.equal(skipResolution.unresolvedFingerprints.length, 0);
  const noDecisionResolution = resolveDateDecisions([impossibleDateRow], reviewLaterPreview.activities, []);
  assert.deepEqual(noDecisionResolution.unresolvedFingerprints, [reviewLaterPreview.activities[0].fingerprint], "a required date decision left unresolved must block that row from import");

  // ---- Payment-shaped rows with a date problem are not silently diverted
  // to a dead-end (Manual Payment Assignment); they stay in the general,
  // actionable review queue. ----
  const paymentRow = { ...base, "Item Num": "PAYMENT", Desc: "Pledge payment", "Due Date": "" };
  const paymentPreview = await buildJlDonationPreview([paymentRow], now);
  assert.equal(paymentPreview.activities[0].dateIssue, "invalid");

  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");

  assert.match(importRoute, /resolveDateDecisions\(/);
  assert.match(importRoute, /findStillUnresolvedDateFingerprints\(/);
  assert.match(importRoute, /Review every flagged date before importing\./);
  assert.match(importRoute, /activity\.dateIssue === null/, "payment-eligible activities must exclude rows with an unresolved date issue");
  assert.match(previewRoute, /activity\.dateIssue === null/);

  assert.match(importExperience, /Invalid \/ missing date/);
  assert.match(importExperience, /Suspicious date/);
  assert.match(importExperience, /Accept date as-is/);
  assert.match(importExperience, /Correct date/);
  assert.match(importExperience, /type="date"/);
  assert.match(importExperience, /item\.dateIssue === "suspicious" && <option value="accept_as_is">/, "accept-as-is must only ever be rendered for a suspicious (structurally valid) date, never an invalid one");

  process.stdout.write("Financial date review workflow checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
