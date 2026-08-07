import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import {
  findFingerprintCrossImportMatches,
  findStableIdCrossImportMatches,
  resolveCrossImportDecisions,
  toExistingDonationRecord,
} from "../lib/import/jl-donation-cross-import.ts";

const base = { Code: "JL-900", Name: "Fictional Family", "Total Due": "100", "Item Num": "GIFT", Desc: "Education support", Campaign: "ANNUAL", "Due Date": "2025-06-15", Amount: "100.00", Paid: "100.00", "Balance Due": "0", Company: "" };

function existingRowFromActivity(activity, overrides = {}) {
  return {
    id: `existing-${activity.fingerprint.slice(0, 8)}`,
    donor_id: "donor-jl-900",
    activity_date: activity.activityDate,
    committed_cents: activity.committedCents,
    source_campaign: activity.sourceCampaign,
    source_snapshot: JSON.stringify(activity.sourceValues),
    created_at: 1_750_000_000,
    ...overrides,
  };
}

async function run() {
  // ---- Scenario: import a fictional donation, then upload the exact same
  // source row again (no stable transaction ID present). ----
  const firstImport = await buildJlDonationPreview([base], new Date("2026-07-31"));
  const firstActivity = firstImport.activities[0];
  assert.equal(firstActivity.category, "completed_gift");

  // Re-uploading the identical row produces the identical content
  // fingerprint, exactly like a second file containing the same source row.
  const secondImport = await buildJlDonationPreview([base], new Date("2026-08-06"));
  const secondActivity = secondImport.activities[0];
  assert.equal(secondActivity.fingerprint, firstActivity.fingerprint, "the exact same source row must produce the exact same content fingerprint across separate imports");

  const existingRecord = toExistingDonationRecord(existingRowFromActivity(firstActivity));
  const existingByFingerprint = new Map([[firstActivity.fingerprint, existingRecord]]);

  // Preview must detect the existing record: a possible-duplicate match is
  // found for the second import's row.
  const possibleMatches = findFingerprintCrossImportMatches([secondActivity], existingByFingerprint, new Set());
  assert.equal(possibleMatches.length, 1);
  assert.equal(possibleMatches[0].matchType, "possible_duplicate");
  assert.equal(possibleMatches[0].existing.activityId, existingRecord.activityId);

  // Default: no decision at all. Nothing is approved for (re-)insertion, so
  // the default never creates a second gift.
  const activityByFingerprint = new Map([[secondActivity.fingerprint, secondActivity]]);
  const defaultResolution = await resolveCrossImportDecisions(activityByFingerprint, possibleMatches, [], "import-default");
  assert.equal(defaultResolution.approvedAdditions.length, 0, "the default action for a possible duplicate must never create a second gift");
  assert.equal(defaultResolution.outcomes[0].action, "skipped");

  // Choosing Skip explicitly: totals unchanged, same as the default.
  const skipResolution = await resolveCrossImportDecisions(activityByFingerprint, possibleMatches, [{ fingerprint: secondActivity.fingerprint, action: "skip" }], "import-skip");
  assert.equal(skipResolution.approvedAdditions.length, 0);
  assert.equal(skipResolution.outcomes[0].action, "skipped");

  // Review later: also leaves totals unchanged (writes nothing).
  const reviewLaterResolution = await resolveCrossImportDecisions(activityByFingerprint, possibleMatches, [{ fingerprint: secondActivity.fingerprint, action: "review_later" }], "import-review-later");
  assert.equal(reviewLaterResolution.approvedAdditions.length, 0);

  // Choosing Import anyway: creates the second gift intentionally, with a
  // fingerprint distinct from the existing record's (so the insert cannot
  // collide with it), and records the override for audit.
  const importAnywayResolution = await resolveCrossImportDecisions(activityByFingerprint, possibleMatches, [{ fingerprint: secondActivity.fingerprint, action: "import_anyway" }], "import-anyway-batch");
  assert.equal(importAnywayResolution.approvedAdditions.length, 1);
  const addedActivity = importAnywayResolution.approvedAdditions[0].activity;
  assert.notEqual(addedActivity.fingerprint, secondActivity.fingerprint, "an intentional second gift must not reuse the existing fingerprint, or the database would silently merge it into the existing row instead of creating a second one");
  const auditNote = JSON.parse(importAnywayResolution.approvedAdditions[0].auditPreviousJson);
  assert.equal(auditNote.crossImportOverride, true);
  assert.equal(auditNote.matchType, "possible_duplicate");
  assert.equal(auditNote.existingActivityId, existingRecord.activityId);
  assert.equal(importAnywayResolution.outcomes[0].action, "imported");

  // A different amount/date does not match at all -- amount is never used
  // alone, and this also proves equal-amount rows on different dates stay
  // completely unrelated to cross-import duplicate detection.
  const unrelatedRow = { ...base, "Due Date": "2025-01-01" };
  const unrelatedPreview = await buildJlDonationPreview([unrelatedRow], new Date("2026-08-06"));
  const unrelatedMatches = findFingerprintCrossImportMatches(unrelatedPreview.activities, existingByFingerprint, new Set());
  assert.equal(unrelatedMatches.length, 0);

  // ---- Scenario: a stable transaction ID proves two differently-worded
  // rows are the same transaction, even when the content fingerprint would
  // otherwise differ (e.g. a corrected description on re-export). ----
  const withStableId = { ...base, "Transaction ID": "T-500" };
  const stableFirstImport = await buildJlDonationPreview([withStableId], new Date("2026-07-31"));
  const stableFirstActivity = stableFirstImport.activities[0];
  const correctedRow = { ...withStableId, Desc: "Education support (corrected)" };
  const stableSecondImport = await buildJlDonationPreview([correctedRow], new Date("2026-08-06"));
  const stableSecondActivity = stableSecondImport.activities[0];
  assert.notEqual(stableSecondActivity.fingerprint, stableFirstActivity.fingerprint, "a cosmetic content change must produce a different content fingerprint");

  const stableExistingRecord = toExistingDonationRecord(existingRowFromActivity(stableFirstActivity));
  const stableIdMatches = findStableIdCrossImportMatches([stableSecondActivity], [stableExistingRecord]);
  assert.equal(stableIdMatches.length, 1, "a stable transaction ID must be recognized as a confirmed duplicate even though the content fingerprint differs");
  assert.equal(stableIdMatches[0].matchType, "confirmed_duplicate");

  const stableActivityByFingerprint = new Map([[stableSecondActivity.fingerprint, stableSecondActivity]]);
  const stableDefault = await resolveCrossImportDecisions(stableActivityByFingerprint, stableIdMatches, [], "stable-default");
  assert.deepEqual(stableDefault.excludeFingerprints, [stableSecondActivity.fingerprint], "a confirmed duplicate must be excluded from insertion by default");
  const stableApproved = await resolveCrossImportDecisions(stableActivityByFingerprint, stableIdMatches, [{ fingerprint: stableSecondActivity.fingerprint, action: "import_anyway" }], "stable-approved");
  assert.equal(stableApproved.excludeFingerprints.length, 0);
  assert.equal(stableApproved.outcomes[0].action, "imported");
  assert.equal(JSON.parse(stableApproved.outcomes[0].auditPreviousJson).matchType, "confirmed_duplicate");

  // A row already confirmed by a stable ID must never also be reported as a
  // (weaker) possible duplicate.
  const confirmedFingerprints = new Set(stableIdMatches.map((match) => match.fingerprint));
  const doubleCounted = findFingerprintCrossImportMatches([stableSecondActivity], new Map([[stableSecondActivity.fingerprint, stableExistingRecord]]), confirmedFingerprints);
  assert.equal(doubleCounted.length, 0);

  // ---- Preserve in-file duplicate logic: with no existing D1 records at
  // all, two identical rows in the same file are still an in-file possible
  // duplicate, entirely independent of cross-import matching. ----
  const inFilePreview = await buildJlDonationPreview([base, { ...base }], new Date("2026-07-31"));
  assert.equal(inFilePreview.activities[0].duplicateStatus, "possible_duplicate");
  const noCrossImportMatches = findFingerprintCrossImportMatches(inFilePreview.activities, new Map(), new Set());
  assert.equal(noCrossImportMatches.length, 0, "in-file duplicate detection must not be affected by (or confused with) cross-import matching");

  const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
  const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
  const importExperience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
  const crossImportLib = await readFile(new URL("../lib/import/jl-donation-cross-import.ts", import.meta.url), "utf8");

  // Preview never mutates or resolves decisions -- it only detects matches.
  assert.match(previewRoute, /findStableIdCrossImportMatches/);
  assert.match(previewRoute, /findFingerprintCrossImportMatches/);
  assert.doesNotMatch(previewRoute, /resolveCrossImportDecisions/, "the preview route must never resolve/apply cross-import decisions -- only the commit route may write");
  assert.doesNotMatch(previewRoute, /INSERT INTO|UPDATE giving_activities|DELETE FROM/i);

  // Commit route wires the resolution in before building the insertable set
  // and audits the override.
  assert.match(importRoute, /resolveCrossImportDecisions\(/);
  assert.match(importRoute, /crossImportExcludeSet/);
  assert.match(importRoute, /crossImportAuditByFingerprint/);
  assert.match(crossImportLib, /crossImportOverride/);

  // The UI visually distinguishes an in-file duplicate from a cross-import
  // duplicate.
  assert.match(importExperience, /Duplicate within this file/);
  assert.match(importExperience, /Already exists in Fundraising OS/);
  assert.match(importExperience, /Confirmed duplicate/);
  assert.match(importExperience, /crossImportDecisions/);

  process.stdout.write("Cross-import donation duplicate protection checks passed.\n");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
