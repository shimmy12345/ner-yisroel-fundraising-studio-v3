import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { resolvePossibleDuplicateDecisions } from "../lib/import/jl-donation-review.ts";
import { buildRejectedRows } from "../lib/import/jl-donation-rejection-review.ts";
import { resolveDateDecisions, findStillUnresolvedDateFingerprints } from "../lib/import/jl-donation-date-review.ts";
import { countReviewLaterDecisions, isReopenableForFollowUp } from "../lib/import/preview-session.ts";

// Reproduces the exact live incident: a completed, fully-reviewed import
// reported "240 rows requiring review" for rows that were already reviewed
// and explicitly marked Skip. Root cause (proven against the real stuck
// draft during investigation): match.reviewActivities -- every activity
// still classified needs_review after approved rows are swapped out -- was
// reported as one undifferentiated "requiring review" bucket regardless of
// whether the row already had a resolved skip/review_later decision. This
// test builds one small file covering Import, Skip, Review Later, a
// corrected invalid date, an accepted suspicious date, and a hard
// (duplicate-transaction-id) rejection, and proves every final disposition
// is reported accurately and reconciles exactly.

const now = new Date("2026-08-10");
const base = { "Total Due": "100", "Item Num": "GIFT", Desc: "Annual support", Campaign: "ANNUAL", "Balance Due": "0", Company: "" };
const households = [1, 2, 3, 4, 5].map((n) => ({ id: `donor-${n}`, external_id: `JL-${n}` }));
// A fully-paid gift requires Paid === Amount (and Balance Due 0) or
// classifyJlDonation flags "Amount does not equal paid plus balance" and
// forces needs_review -- every row here must classify cleanly on its own
// so the ONLY needs_review reasons in this fixture are the ones the test
// is deliberately exercising (duplicates and date issues).
function paidRow(fields) { return { ...base, ...fields, Paid: fields.Amount }; }

function buildRows() {
  const clean = paidRow({ Code: "JL-1", Name: "Clean Household", "Due Date": "2025-01-10", Amount: "100.00" });
  // One duplicate group of 3 identical rows -- no stable transaction ID, so
  // each occurrence gets its own review decision: import_anyway, skip, and
  // review_later, covering all three "already decided" outcomes from one
  // in-file duplicate group.
  const dupTemplate = paidRow({ Code: "JL-2", Name: "Duplicate Household", "Due Date": "2025-02-01", Amount: "50.00", Campaign: "DUP" });
  const dup1 = { ...dupTemplate };
  const dup2 = { ...dupTemplate };
  const dup3 = { ...dupTemplate };
  const invalidDateRow = paidRow({ Code: "JL-3", Name: "Invalid Date Household", "Due Date": "not-a-date", Amount: "75.00" });
  const suspiciousDateRow = paidRow({ Code: "JL-4", Name: "Suspicious Date Household", "Due Date": "1899-01-01", Amount: "40.00" });
  const hardDupA = paidRow({ Code: "JL-5", Name: "Hard Duplicate Household", "Due Date": "2025-03-01", Amount: "60.00", "Transaction ID": "T-1" });
  const hardDupB = { ...hardDupA };
  return { clean, dup1, dup2, dup3, invalidDateRow, suspiciousDateRow, hardDupA, hardDupB, all: [clean, dup1, dup2, dup3, invalidDateRow, suspiciousDateRow, hardDupA, hardDupB] };
}

// Mirrors app/api/import/route.ts's own disposition computation (see the
// `reviewRows` construction there): a row still classified needs_review
// after every decision-driven path has already blocked commit on any
// genuinely unresolved fingerprint is never "still pending" -- it is either
// an explicit skip/review-later choice, or (no decision UI exists for
// these) a permanently-excluded structural problem.
function disposition(activity, reviewDecisionByFingerprint) {
  if (activity.duplicateStatus !== "possible_duplicate") return "unresolved";
  const action = reviewDecisionByFingerprint.get(activity.fingerprint);
  if (action === "review_later") return "review_later";
  if (action === "skip") return "skipped";
  return "unresolved";
}

async function run() {
  const rows = buildRows();
  const initialPreview = await buildJlDonationPreview(rows.all, now);

  // ---- Every date-issue row must have a decision before commit can
  // proceed; an unresolved one blocks. ----
  const invalidActivity = initialPreview.activities.find((a) => a.sourceName === "Invalid Date Household");
  const suspiciousActivity = initialPreview.activities.find((a) => a.sourceName === "Suspicious Date Household");
  const noDecisionYet = resolveDateDecisions(rows.all, initialPreview.activities, []);
  assert.deepEqual(new Set(noDecisionYet.unresolvedFingerprints), new Set([invalidActivity.fingerprint, suspiciousActivity.fingerprint]), "commit must block while date decisions are unresolved");

  const dateDecisions = [
    { fingerprint: invalidActivity.fingerprint, action: "correct_date", correctedDate: "2025-04-15" },
    { fingerprint: suspiciousActivity.fingerprint, action: "accept_as_is" },
  ];
  const dateResolution = resolveDateDecisions(rows.all, initialPreview.activities, dateDecisions);
  assert.equal(dateResolution.unresolvedFingerprints.length, 0, "commit succeeds only once every required date decision is resolved");
  const finalPreview = await buildJlDonationPreview(dateResolution.rows, now);
  assert.deepEqual(findStillUnresolvedDateFingerprints(dateResolution.appliedRowNumbers, finalPreview.activities), []);

  const match = matchJlDonationActivities(finalPreview, households, []);
  assert.equal(match.unknownActivities.length, 0);
  assert.equal(match.nonfinancialActivities.length, 0);

  const dupActivities = finalPreview.activities.filter((a) => a.duplicateStatus === "possible_duplicate");
  assert.equal(dupActivities.length, 3, "all three occurrences of the in-file duplicate group must be flagged for review");
  const reviewDecisions = [
    { fingerprint: dupActivities[0].fingerprint, action: "import_anyway", groupKey: dupActivities[0].duplicateGroupKey },
    { fingerprint: dupActivities[1].fingerprint, action: "skip", groupKey: dupActivities[1].duplicateGroupKey },
    { fingerprint: dupActivities[2].fingerprint, action: "review_later", groupKey: dupActivities[2].duplicateGroupKey },
  ];
  const noReviewDecisionYet = resolvePossibleDuplicateDecisions(finalPreview.activities, []);
  assert.equal(noReviewDecisionYet.unresolvedFingerprints.length, 3, "commit must block while duplicate-review decisions are unresolved");
  const reviewResolution = resolvePossibleDuplicateDecisions(finalPreview.activities, reviewDecisions);
  assert.equal(reviewResolution.unresolvedFingerprints.length, 0, "commit succeeds only once every required duplicate decision is resolved -- import_anyway, skip, and review_later are all valid resolutions");
  assert.equal(reviewResolution.approvedActivities.length, 1, "only the import_anyway occurrence is approved for import");

  const reviewDecisionByFingerprint = new Map(reviewDecisions.map((d) => [d.fingerprint, d.action]));
  const approvedByFingerprint = new Map(reviewResolution.approvedActivities.map((a) => [a.fingerprint, a]));
  const postDecisionActivities = finalPreview.activities.map((a) => approvedByFingerprint.get(a.fingerprint) ?? a);
  const postDecisionMatch = matchJlDonationActivities({ ...finalPreview, activities: postDecisionActivities }, households, []);

  // ---- This is the exact bug: match.reviewActivities is every row still
  // needs_review after approvals are swapped out -- it must NEVER be
  // reported as a single undifferentiated "requiring review" bucket. ----
  const reviewRows = postDecisionMatch.reviewActivities.map((activity) => ({ row: activity.rowNumber, fingerprint: activity.fingerprint, disposition: disposition(activity, reviewDecisionByFingerprint) }));
  assert.equal(reviewRows.length, 2, "the skip and review_later occurrences remain needs_review after approvals are swapped out");
  assert.equal(reviewRows.filter((r) => r.disposition === "skipped").length, 1);
  assert.equal(reviewRows.filter((r) => r.disposition === "review_later").length, 1);
  assert.equal(reviewRows.filter((r) => r.disposition === "unresolved").length, 0, "\"needs review\" must be 0 in the completion report -- every row here has an explicit, resolved decision, not a genuinely-pending one");

  const rejectedRowDetails = buildRejectedRows(finalPreview.duplicateRows, postDecisionMatch.unknownActivities, postDecisionMatch.nonfinancialActivities);
  assert.equal(rejectedRowDetails.length, 1, "only the second occurrence of the repeated transaction ID is rejected -- the first is a normal imported row");
  assert.equal(rejectedRowDetails[0].category, "duplicate_transaction_id");
  assert.equal(rejectedRowDetails[0].severity, "hard");

  // ---- Final reconciliation: imported + skipped + review later + rejected
  // = every processed row, with nothing unaccounted for. ----
  const importedCount = postDecisionMatch.matched.length;
  const skippedCount = reviewRows.filter((r) => r.disposition === "skipped").length;
  const reviewLaterCount = reviewRows.filter((r) => r.disposition === "review_later").length;
  const rejectedCount = rejectedRowDetails.length;
  assert.equal(importedCount, 5, "clean row, the import_anyway duplicate, the corrected-date row, the accepted-suspicious-date row, and the first occurrence of the hard duplicate pair");
  assert.equal(importedCount + skippedCount + reviewLaterCount + rejectedCount, rows.all.length, "every processed row must reconcile to exactly one final disposition");

  // ---- Review Later rows remain resumable: the decision is preserved
  // verbatim in a committed session's decisions_json, and a committed
  // session (unlike a plain expired one) stays reopenable specifically for
  // this follow-up. ----
  const decisionsJson = JSON.stringify({ reviewDecisions: Object.fromEntries(reviewDecisions.map((d) => [d.fingerprint, { action: d.action }])), rejectionDecisions: {}, dateDecisions: {}, crossImportDecisions: {}, paymentDecisions: {}, pendingGiftDecisions: {} });
  assert.equal(countReviewLaterDecisions(decisionsJson), 1);
  const committedSession = { id: "s1", owner_user_id: "owner-a", file_hash: "a".repeat(64), file_name: "f.csv", mapping_json: "{}", force_type: "donation", row_count: rows.all.length, decisions_json: decisionsJson, status: "committed", progress_resolved: 8, progress_total: 8, created_at: 0, updated_at: 0, expires_at: 1_000_000 };
  assert.equal(isReopenableForFollowUp(committedSession, "owner-a", 0), true, "a committed session with outstanding review-later rows must remain reopenable");
  assert.equal(isReopenableForFollowUp(committedSession, "owner-b", 0), false, "never reopenable by a different owner");
  assert.equal(isReopenableForFollowUp({ ...committedSession, status: "discarded" }, "owner-a", 0), false);
  assert.equal(isReopenableForFollowUp(committedSession, "owner-a", 1_000_001), false, "still expires eventually");

  // ---- Source wiring: terminology, clickable drill-downs, the payment
  // gate, and follow-up resumability are all actually present. ----
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const draftRoute = await readFile(new URL("../app/api/import/draft/route.ts", import.meta.url), "utf8");
  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");

  assert.match(importRoute, /disposition: DonationRowDisposition/);
  assert.match(importRoute, /assignmentPlan\.errors\.length/, "a stale/invalid payment-assignment decision must block commit, not silently fall through as unresolved review");
  assert.match(importRoute, /Review every payment assignment before importing\./);
  assert.match(importRoute, /skippedRows: skippedReviewRows\.length/);
  assert.match(importRoute, /reviewLaterRows: reviewLaterRows\.length/);
  assert.match(importRoute, /isReopenableForFollowUp\(/);

  assert.match(draftRoute, /countReviewLaterDecisions/);
  assert.match(previewRoute, /isReopenableForFollowUp/);
  assert.match(previewRoute, /resumedFollowUp/);

  assert.match(importExperience, /skipped by you/);
  assert.match(importExperience, /saved for later review/);
  assert.match(importExperience, /setRowDrillDown/);
  assert.match(importExperience, /Resolve now/);
  assert.match(importExperience, /resumableReviewLater/);
  assert.doesNotMatch(importExperience, /rows requiring review<\/span/, "the completion screen must never label already-reviewed rows as still requiring review");

  process.stdout.write("Post-import disposition accuracy and Review Later resumability checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
