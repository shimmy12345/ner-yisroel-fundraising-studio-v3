import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { buildPaymentCandidates, planPaymentAssignments } from "../lib/import/jl-payment-assignment.ts";

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

const route = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
const rollbackRoute = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
const experience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0008_manual_pledge_payment_assignment.sql", import.meta.url), "utf8");
assert.match(route, /planPaymentAssignments/);
assert.match(route, /UPDATE giving_activities SET paid_cents = \?, balance_cents = \?, category = \?/);
assert.match(route, /await env\.DB\.batch\(statements\)/);
assert.match(route, /INSERT INTO jl_payment_assignments/);
assert.match(route, /CASE WHEN EXISTS \(SELECT 1 FROM giving_activities/);
assert.match(previewRoute, /balance_cents > 0/);
assert.match(previewRoute, /owner_user_id = \?/);
assert.match(rollbackRoute, /DELETE FROM jl_payment_assignments WHERE user_id = \? AND applied_import_id = \?/);
assert.match(experience, /Apply to open pledge/);
assert.match(experience, /New gift\/payment/);
assert.match(experience, /No duplicate gift will be created/);
assert.match(migration, /PRIMARY KEY \(`user_id`, `payment_fingerprint`\)/);

process.stdout.write("Manual pledge payment assignment checks passed.\n");
