import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview, JL_COMPACT_DONATION_COLUMNS, JL_DONATION_COLUMNS, paymentActivitiesForAssignment } from "../lib/import/jl-donations.ts";
import { buildPaymentCandidates, OPEN_PLEDGES_FOR_DONORS_SQL, planPaymentAssignments } from "../lib/import/jl-payment-assignment.ts";

const rows = [
  { Code: "JL-100", "First Name": "Example", "Last Name": "One", Date: "2026-08-03", Campaign: "ANNUAL", Amount: "25.00" },
  { Code: "JL-100", "First Name": "Example", "Last Name": "One", Date: "2026-08-04", Campaign: "ANNUAL", Amount: "75.00" },
  { Code: "JL-200", "First Name": "Example", "Last Name": "Two", Date: "2026-08-03", Campaign: "SPECIAL", Amount: "40.00" },
];
const preview = await buildJlDonationPreview(rows, new Date("2026-08-03"));
const sameCorePledge = await buildJlDonationPreview([{ Code: "JL-100", Name: "Example One", "Total Due": "25", "Item Num": "", Desc: "", Campaign: "ANNUAL", "Due Date": "2026-08-03", Amount: "25.00", Paid: "0", "Balance Due": "25.00", Company: "" }], new Date("2026-08-03"));
assert.notEqual(preview.activities[0].fingerprint, sameCorePledge.activities[0].fingerprint, "a compact payment fingerprint cannot collide with the pledge it may satisfy");
const households = [
  { id: "donor-100", external_id: "JL-100", display_name: "Example One" },
  { id: "donor-200", external_id: "JL-200", display_name: "Example Two" },
];
const openPledges = [{
  id: "pledge-100",
  donor_id: "donor-100",
  source_fingerprint: "pledge-fingerprint",
  activity_date: 1751328000,
  committed_cents: 10000,
  paid_cents: 0,
  balance_cents: 10000,
  description: "Annual pledge",
  source_campaign: "ANNUAL",
  category: "open_pledge",
  source_snapshot: "{}",
}];

const candidates = buildPaymentCandidates(preview.activities, households, openPledges, []);
assert.equal(candidates.length, 3);
assert.ok(candidates.every((candidate) => candidate.action === "needs_review"), "ambiguous payments must never be assigned automatically");
assert.equal(candidates[0].openPledges.length, 1);

const fullRows = [
  { Code: "JL-100", Name: "Example One", "Total Due": "25", "Item Num": "PAYMENT", Desc: "Pledge payment", Campaign: "UNRELATED", "Due Date": "2026-08-03", Amount: "25.00", Paid: "25.00", "Balance Due": "0", Company: "" },
  { Code: "JL-100", Name: "Example One", "Total Due": "100", "Item Num": "PLEDGE", Desc: "Annual commitment", Campaign: "ANNUAL", "Due Date": "2026-08-03", Amount: "100.00", Paid: "0", "Balance Due": "100.00", Company: "" },
  { Code: "JL-200", Name: "Example Two", "Total Due": "40", "Item Num": "GIFT", Desc: "Annual gift", Campaign: "payment assistance fund", "Due Date": "2026-08-03", Amount: "40.00", Paid: "40.00", "Balance Due": "0", Company: "" },
];
const fullPreview = await buildJlDonationPreview(fullRows, new Date("2026-08-03"));
const fullPayments = paymentActivitiesForAssignment(fullPreview.activities, [...JL_DONATION_COLUMNS]);
assert.equal(fullPayments.length, 1, "only explicit full-export payment transactions enter manual assignment");
assert.equal(fullPayments[0].itemType, "PAYMENT");
assert.equal(fullPayments[0].committedCents, 2500, "full-export assignment uses Paid as the payment amount");
assert.equal(paymentActivitiesForAssignment(preview.activities, [...JL_COMPACT_DONATION_COLUMNS]).length, 3, "every compact-export row remains eligible");
const fullCandidates = buildPaymentCandidates(fullPayments, households, openPledges, []);
assert.equal(fullCandidates[0].openPledges.length, 1, "full-export payments see the same live open pledges as the workspace");
assert.equal(fullCandidates[0].action, "needs_review", "full-export payments are never silently assigned");
assert.equal(buildPaymentCandidates([fullPayments[0]], [{ id: "donor-100", external_id: "JL-100" }], [], [])[0].openPledges.length, 0, "donors without open pledges remain eligible for standalone gifts");

const legacyCategoryPledge = {
  ...openPledges[0],
  id: "pledge-legacy-category",
  source_fingerprint: "legacy-category-fingerprint",
  description: "Building pledge",
  source_campaign: "CAPITAL",
  category: "completed_gift",
  committed_cents: 8000,
  paid_cents: 2000,
  balance_cents: 6000,
};
const allOpenPledgeCandidates = buildPaymentCandidates(preview.activities.slice(0, 1), households, [...openPledges, legacyCategoryPledge], []);
assert.equal(allOpenPledgeCandidates[0].openPledges.length, 2, "every positive-balance pledge remains manually selectable regardless of category or campaign");
const explicitlySelectedPlan = planPaymentAssignments(allOpenPledgeCandidates, [
  { fingerprint: allOpenPledgeCandidates[0].fingerprint, action: "apply_to_pledge", pledgeId: "pledge-legacy-category" },
]);
assert.equal(explicitlySelectedPlan.errors.length, 0);
assert.equal(explicitlySelectedPlan.pledgeUpdates.length, 1);
assert.equal(explicitlySelectedPlan.pledgeUpdates[0].id, "pledge-legacy-category", "only the exact pledge selected by the user is updated");
assert.equal(explicitlySelectedPlan.newGifts.length, 0, "an applied payment must not also create a gift");

const partialPlan = planPaymentAssignments(candidates, [
  { fingerprint: candidates[0].fingerprint, action: "apply_to_pledge", pledgeId: "pledge-100" },
  { fingerprint: candidates[2].fingerprint, action: "new_gift" },
]);
assert.equal(partialPlan.pledgeUpdates.length, 1);
assert.equal(partialPlan.pledgeUpdates[0].nextPaidCents, 2500);
assert.equal(partialPlan.pledgeUpdates[0].nextBalanceCents, 7500);
assert.equal(partialPlan.pledgeUpdates[0].nextCategory, "partially_paid_pledge");
assert.deepEqual(partialPlan.newGiftFingerprints, [candidates[2].fingerprint]);
assert.equal(partialPlan.errors.length, 1, "the undecided final payment remains in review");

const finalPlan = planPaymentAssignments(candidates, [
  { fingerprint: candidates[0].fingerprint, action: "apply_to_pledge", pledgeId: "pledge-100" },
  { fingerprint: candidates[1].fingerprint, action: "apply_to_pledge", pledgeId: "pledge-100" },
  { fingerprint: candidates[2].fingerprint, action: "new_gift" },
]);
assert.equal(finalPlan.errors.length, 0);
assert.equal(finalPlan.pledgeUpdates.length, 1, "multiple payments update one pledge record rather than creating duplicates");
assert.equal(finalPlan.pledgeUpdates[0].paymentCents, 10000);
assert.equal(finalPlan.pledgeUpdates[0].nextPaidCents, 10000);
assert.equal(finalPlan.pledgeUpdates[0].nextBalanceCents, 0);
assert.equal(finalPlan.pledgeUpdates[0].nextCategory, "completed_gift");
assert.equal(finalPlan.newGiftFingerprints.length, 1);
assert.equal(finalPlan.pledgeUpdates[0].nextPaidCents + 4000, 14000, "the pledge payment and separate gift are counted once each");

const rememberedCandidates = buildPaymentCandidates(preview.activities, households, openPledges, [{ payment_fingerprint: candidates[0].fingerprint, decision_type: "apply_to_pledge", pledge_activity_id: "pledge-100", applied_import_id: "prior-import" }]);
const rememberedPlan = planPaymentAssignments(rememberedCandidates, []);
assert.deepEqual(rememberedPlan.alreadyApplied, [candidates[0].fingerprint]);
assert.equal(rememberedPlan.pledgeUpdates.length, 0, "an identical remembered payment must not be applied twice");

const overpaymentRows = [{ Code: "JL-100", "First Name": "Example", "Last Name": "One", Date: "2026-08-05", Campaign: "DIFFERENT-CAMPAIGN", Amount: "125.00" }];
const overpaymentPreview = await buildJlDonationPreview(overpaymentRows, new Date("2026-08-03"));
const overpaymentCandidate = buildPaymentCandidates(overpaymentPreview.activities, households, openPledges, [])[0];
assert.equal(overpaymentCandidate.openPledges.length, 1, "campaign mismatch must not hide a donor's open pledge");
const unresolvedOverpayment = planPaymentAssignments([overpaymentCandidate], [{ fingerprint: overpaymentCandidate.fingerprint, action: "apply_to_pledge", pledgeId: "pledge-100" }]);
assert.equal(unresolvedOverpayment.errors.length, 1, "overpayment requires an explicit remainder decision");
const splitOverpayment = planPaymentAssignments([overpaymentCandidate], [{ fingerprint: overpaymentCandidate.fingerprint, action: "apply_to_pledge", pledgeId: "pledge-100", overpaymentAction: "split_remainder_new_gift" }]);
assert.equal(splitOverpayment.errors.length, 0);
assert.equal(splitOverpayment.pledgeUpdates[0].paymentCents, 10000);
assert.equal(splitOverpayment.pledgeUpdates[0].nextBalanceCents, 0);
assert.equal(splitOverpayment.pledgeUpdates[0].nextCategory, "completed_gift");
assert.equal(splitOverpayment.newGifts[0].amountCents, 2500);
assert.equal(splitOverpayment.newGifts[0].kind, "overpayment_remainder");
assert.equal(splitOverpayment.assignments[0].appliedCents + splitOverpayment.assignments[0].newGiftCents, 12500, "the source payment must be counted exactly once across pledge and remainder gift");

const twoPaymentsPreview = await buildJlDonationPreview([
  { Code: "JL-100", Date: "2026-08-06", Campaign: "ONE", Amount: "75.00" },
  { Code: "JL-100", Date: "2026-08-07", Campaign: "TWO", Amount: "75.00" },
], new Date("2026-08-03"));
const twoCandidates = buildPaymentCandidates(twoPaymentsPreview.activities, households, openPledges, []);
const combinedPlan = planPaymentAssignments(twoCandidates, twoCandidates.map((candidate) => ({ fingerprint: candidate.fingerprint, action: "apply_to_pledge", pledgeId: "pledge-100", overpaymentAction: "split_remainder_new_gift" })));
assert.equal(combinedPlan.pledgeUpdates[0].paymentCents, 10000, "combined allocations cannot exceed the pledge balance");
assert.equal(combinedPlan.newGifts.reduce((sum, gift) => sum + gift.amountCents, 0), 5000);
assert.equal(combinedPlan.assignments.reduce((sum, assignment) => sum + assignment.appliedCents + assignment.newGiftCents, 0), 15000, "combined payments remain counted exactly once");

const route = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
const rollbackRoute = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
const experience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0008_manual_pledge_payment_assignment.sql", import.meta.url), "utf8");
const auditMigration = await readFile(new URL("../drizzle/0010_manual_pledge_assignment_audit.sql", import.meta.url), "utf8");
assert.match(route, /planPaymentAssignments/);
assert.match(route, /paymentActivitiesForAssignment/);
assert.doesNotMatch(route, /compactPaymentExport\s*\?\s*buildPaymentCandidates/, "full exports must not bypass manual assignment");
assert.match(route, /UPDATE giving_activities SET paid_cents = \?, balance_cents = \?, category = \?/);
assert.match(route, /await env\.DB\.batch\(statements\)/);
assert.match(route, /INSERT INTO jl_payment_assignments/);
assert.match(route, /INSERT INTO jl_payment_assignment_audits/);
assert.match(route, /CASE WHEN EXISTS \(SELECT 1 FROM giving_activities/);
assert.match(previewRoute, /OPEN_PLEDGES_FOR_DONORS_SQL/);
assert.match(previewRoute, /paymentActivitiesForAssignment/);
assert.doesNotMatch(previewRoute, /compactPaymentExport\s*&&\s*donorIds/, "preview must query the workspace's open pledges for both export shapes");
assert.match(route, /OPEN_PLEDGES_FOR_DONORS_SQL/);
assert.match(OPEN_PLEDGES_FOR_DONORS_SQL, /owner_user_id = \?/);
assert.match(OPEN_PLEDGES_FOR_DONORS_SQL, /record_origin = 'live'/);
assert.match(OPEN_PLEDGES_FOR_DONORS_SQL, /balance_cents > 0/);
assert.doesNotMatch(OPEN_PLEDGES_FOR_DONORS_SQL, /category\s+IN/i, "open-pledge selection must not depend on a category allowlist");
assert.match(rollbackRoute, /DELETE FROM jl_payment_assignments WHERE user_id = \? AND applied_import_id = \?/);
assert.match(experience, /Apply to open pledge/);
assert.match(experience, /New gift\/payment/);
assert.match(experience, /No duplicate gift will be created/);
assert.match(experience, /automatic-match confidence do not hide pledge choices/);
assert.match(experience, /aria-required="true"/);
assert.match(experience, /Remaining balance/);
assert.match(experience, /Resulting status/);
assert.match(experience, /split_remainder_new_gift/);
assert.doesNotMatch(experience, /disabled=\{exceedsBalance\}/);
assert.match(migration, /PRIMARY KEY \(`user_id`, `payment_fingerprint`\)/);
assert.match(auditMigration, /CREATE TABLE `jl_payment_assignment_audits`/);
assert.match(auditMigration, /`applied_cents` integer NOT NULL/);
assert.match(auditMigration, /`new_gift_cents` integer NOT NULL/);

process.stdout.write("Manual pledge payment assignment checks passed.\n");
