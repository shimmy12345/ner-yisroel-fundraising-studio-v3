import assert from "node:assert/strict";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { matchJlDonationActivities } from "../lib/import/jl-donation-match.ts";
import { buildRejectedRows, resolveRejectionDecisions } from "../lib/import/jl-donation-rejection-review.ts";
import { buildPaymentCandidates, planPaymentAssignments } from "../lib/import/jl-payment-assignment.ts";
import { buildKnownAttributionsByCode } from "../lib/import/donor-source-attribution.ts";

// Giving Import -- Third-Party Source Attribution. Fixtures use the real
// case's own real identifiers (JL 22297 "Price Waterhouse Foundation" as
// the source, Eitan Pfeiffer JL 48637 as the suggested attribution) as
// REGRESSION CONTROLS ONLY -- the production code
// (lib/import/donor-source-attribution.ts, jl-donation-rejection-review.ts,
// jl-payment-assignment.ts) never references either name; the mapping is
// entirely data-driven through `donor_source_attributions` /
// `knownAttributionsByCode`.

const PFEIFFER_ID = "donor-pfeiffer";
const attribution = {
  sourceExternalId: "22297",
  sourceName: "Price Waterhouse Foundation",
  suggestedDonorId: PFEIFFER_ID,
  suggestedDonorCode: "48637",
  suggestedDonorName: "Mr. & Mrs. Eitan Pfeiffer",
  note: null,
};
const knownAttributionsByCode = buildKnownAttributionsByCode([{
  source_external_id: "22297", source_name: "Price Waterhouse Foundation",
  suggested_donor_id: PFEIFFER_ID, suggested_donor_code: "48637", suggested_donor_name: "Mr. & Mrs. Eitan Pfeiffer", note: null,
}]);

const base = { Code: "22297", Name: "Price Waterhouse Foundation", "Total Due": "5000", "Item Num": "GIFT", Desc: "Corporate match", Campaign: "ANNUAL", "Due Date": "2026-08-15", Amount: "5000.00", Paid: "5000.00", "Balance Due": "0", Company: "" };

async function run() {
  // ---------------- 1/2. JL 22297 is recognized as a known third-party source; Eitan Pfeiffer 48637 is offered as the suggested attribution ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const match = matchJlDonationActivities(preview, [], []); // no household for 22297 -- Price Waterhouse Foundation was never itself imported as a donor
    assert.equal(match.unknownActivities.length, 1);
    const rejectedRows = buildRejectedRows([], match.unknownActivities, [], knownAttributionsByCode);
    assert.equal(rejectedRows.length, 1);
    assert.deepEqual(rejectedRows[0].knownAttribution, attribution, "the row must carry the exact known-attribution suggestion, including the suggested donor's own code and name");
  }

  // ---------------- 3. The transaction is NOT automatically attributed without confirmation ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const match = matchJlDonationActivities(preview, [], []);
    const resolution = resolveRejectionDecisions(match.unknownActivities, [], [], new Map());
    assert.equal(resolution.approvedActivities.length, 0, "no decision at all must never resolve to an attribution");
    assert.equal(resolution.unresolvedFingerprints.length, 1, "an unresolved known-attribution row must still block commit, exactly like any other unmatched row");
  }

  // ---------------- 4. User confirms Pfeiffer attribution: gift belongs to Pfeiffer; original JL provenance is preserved ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const match = matchJlDonationActivities(preview, [], []);
    const fingerprint = match.unknownActivities[0].fingerprint;
    const resolution = resolveRejectionDecisions(match.unknownActivities, [], [{ fingerprint, action: "match_donor", donorId: PFEIFFER_ID }], new Map());
    assert.equal(resolution.approvedActivities.length, 1);
    const activity = resolution.approvedActivities[0];
    assert.equal(activity.donorId, PFEIFFER_ID, "the resulting gift must belong to Eitan Pfeiffer");
    assert.equal(activity.externalHouseholdId, "22297", "the original JL source code must remain exactly as recorded -- never rewritten to Pfeiffer's own code");
    assert.equal(activity.sourceValues.Code, "22297");
    assert.equal(activity.sourceValues.Name, "Price Waterhouse Foundation", "the original source name must remain in the source snapshot, untouched");
    assert.equal(activity.fingerprint, match.unknownActivities[0].fingerprint, "the transaction fingerprint must be unchanged by attribution");
  }

  // ---------------- 5. User chooses another donor: normal donor workflow still works, no Pfeiffer attribution occurs ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const match = matchJlDonationActivities(preview, [], []);
    const fingerprint = match.unknownActivities[0].fingerprint;
    const resolution = resolveRejectionDecisions(match.unknownActivities, [], [{ fingerprint, action: "match_donor", donorId: "donor-someone-else" }], new Map());
    assert.equal(resolution.approvedActivities[0].donorId, "donor-someone-else");
    assert.notEqual(resolution.approvedActivities[0].donorId, PFEIFFER_ID, "choosing a different donor must never result in Pfeiffer attribution");
  }

  // ---------------- 6. User skips: no gift/payment is created; existing skip semantics remain correct ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const match = matchJlDonationActivities(preview, [], []);
    const fingerprint = match.unknownActivities[0].fingerprint;
    const resolution = resolveRejectionDecisions(match.unknownActivities, [], [{ fingerprint, action: "skip" }], new Map());
    assert.equal(resolution.approvedActivities.length, 0, "a skipped row must never create a gift");
    assert.equal(resolution.unresolvedFingerprints.length, 0, "an explicit skip is a resolved decision, not a blocking one");
  }

  // ---------------- 7. Duplicate protection is independent of donor attribution ----------------
  {
    // The SAME source row, previewed twice independently (simulating two
    // separate import attempts), must produce the IDENTICAL fingerprint --
    // this is the exact mechanism that makes the database's own
    // ON CONFLICT(owner_user_id, external_source, source_fingerprint)
    // upsert recognize a re-imported Price Waterhouse transaction as
    // already recorded, regardless of which donor it was attributed to on
    // the first import (see app/api/import/route.ts's activityStatements).
    const firstPreview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const secondPreview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    assert.equal(firstPreview.activities[0].fingerprint, secondPreview.activities[0].fingerprint, "the same source row must always produce the same fingerprint, independent of import timing");
    // Resolving via attribution never changes the fingerprint the row
    // carries into the commit -- the field the database keys duplicate
    // detection on.
    const match = matchJlDonationActivities(firstPreview, [], []);
    const fingerprint = match.unknownActivities[0].fingerprint;
    const resolution = resolveRejectionDecisions(match.unknownActivities, [], [{ fingerprint, action: "match_donor", donorId: PFEIFFER_ID }], new Map());
    assert.equal(resolution.approvedActivities[0].fingerprint, fingerprint, "attribution must never mint a new fingerprint -- doing so would defeat re-import duplicate protection");
  }

  // ---------------- 8. Price Waterhouse payment attributed to Pfeiffer and allocated to one Pfeiffer pledge ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const activity = preview.activities[0];
    const households = [{ id: PFEIFFER_ID, external_id: "48637", display_name: "Mr. & Mrs. Eitan Pfeiffer" }]; // Pfeiffer's OWN code -- never 22297
    const openPledges = [{ id: "pledge-1", donor_id: PFEIFFER_ID, source_fingerprint: "pf-1", activity_date: 1750000000, committed_cents: 500000, paid_cents: 0, balance_cents: 500000, description: "Annual pledge", source_campaign: "ANNUAL", category: "open_pledge", source_snapshot: "{}" }];
    const attributedDonors = new Map([[activity.fingerprint, PFEIFFER_ID]]);
    const candidates = buildPaymentCandidates([activity], households, openPledges, [], [], knownAttributionsByCode, attributedDonors);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].donorId, PFEIFFER_ID, "the confirmed attribution must resolve the donor identity");
    assert.equal(candidates[0].attributedDonorId, PFEIFFER_ID);
    assert.equal(candidates[0].blocked, false, "once attributed, the row must hand off to the ordinary payment-assignment workflow");
    assert.equal(candidates[0].openPledges.length, 1, "the attributed donor's own open pledges must be visible, exactly as for a directly-coded donor");
    const plan = planPaymentAssignments(candidates, [{ fingerprint: activity.fingerprint, action: "apply_to_pledge", pledgeId: "pledge-1" }]);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.pledgeUpdates.length, 1);
    assert.equal(plan.pledgeUpdates[0].donor_id, PFEIFFER_ID);
    assert.equal(plan.pledgeUpdates[0].nextPaidCents, 500000);
  }

  // ---------------- 9. Price Waterhouse payment attributed to Pfeiffer and split using existing multi-pledge allocation ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const activity = preview.activities[0];
    const households = [{ id: PFEIFFER_ID, external_id: "48637", display_name: "Mr. & Mrs. Eitan Pfeiffer" }];
    const openPledges = [
      { id: "pledge-a", donor_id: PFEIFFER_ID, source_fingerprint: "pf-a", activity_date: 1750000000, committed_cents: 300000, paid_cents: 0, balance_cents: 300000, description: "Pledge A", source_campaign: "ANNUAL", category: "open_pledge", source_snapshot: "{}" },
      { id: "pledge-b", donor_id: PFEIFFER_ID, source_fingerprint: "pf-b", activity_date: 1750000000, committed_cents: 200000, paid_cents: 0, balance_cents: 200000, description: "Pledge B", source_campaign: "ANNUAL", category: "open_pledge", source_snapshot: "{}" },
    ];
    const attributedDonors = new Map([[activity.fingerprint, PFEIFFER_ID]]);
    const candidates = buildPaymentCandidates([activity], households, openPledges, [], [], knownAttributionsByCode, attributedDonors);
    const plan = planPaymentAssignments(candidates, [{ fingerprint: activity.fingerprint, action: "apply_to_pledge", allocations: [{ pledgeId: "pledge-a", amountCents: 300000 }, { pledgeId: "pledge-b", amountCents: 200000 }] }]);
    assert.equal(plan.errors.length, 0);
    assert.equal(plan.pledgeUpdates.length, 2, "the multi-pledge allocation workflow must apply unchanged once the donor is attributed");
    assert.ok(plan.pledgeUpdates.every((update) => update.donor_id === PFEIFFER_ID));
  }

  // ---------------- 10. Invalid/missing attributed donor: commit fails safely, zero financial writes ----------------
  {
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const activity = preview.activities[0];
    const households = [{ id: PFEIFFER_ID, external_id: "48637", display_name: "Mr. & Mrs. Eitan Pfeiffer" }];
    // No attributedDonors entry at all -- exactly what app/api/import/route.ts
    // produces when the client's attributedDonorId fails server-side
    // verification against the real known-attribution suggestion.
    const candidates = buildPaymentCandidates([activity], households, [], [], [], knownAttributionsByCode, new Map());
    assert.equal(candidates[0].donorId, null);
    assert.equal(candidates[0].blocked, true, "an unverified/missing attribution must leave the row blocked");
    const plan = planPaymentAssignments(candidates, [{ fingerprint: activity.fingerprint, action: "apply_to_pledge", pledgeId: "pledge-1" }]);
    assert.equal(plan.errors.length, 1, "a blocked candidate must always fail, regardless of any decision submitted for it");
    assert.equal(plan.pledgeUpdates.length, 0);
    assert.equal(plan.newGifts.length, 0);
    assert.equal(plan.assignments.length, 0, "zero financial writes must result from an unresolved attribution");
  }

  // ---------------- 11. Unknown third-party JL account: existing importer behavior remains unchanged ----------------
  {
    const unknownCodeRow = { ...base, Code: "99999", Name: "Some Other Company" };
    const preview = await buildJlDonationPreview([unknownCodeRow], new Date("2026-09-01"));
    const match = matchJlDonationActivities(preview, [], []);
    const rejectedRows = buildRejectedRows([], match.unknownActivities, [], knownAttributionsByCode);
    assert.equal(rejectedRows[0].knownAttribution, null, "a code with no known mapping must show no suggestion at all -- ordinary unmatched-code behavior");
    const activity = preview.activities[0];
    const candidates = buildPaymentCandidates([activity], [], [], [], [], knownAttributionsByCode, new Map());
    assert.equal(candidates[0].knownAttribution, null);
    assert.equal(candidates[0].blocked, true);
  }

  // ---------------- 12. Normal direct Pfeiffer JL 48637 donation: existing behavior remains unchanged ----------------
  {
    const pfeifferRow = { ...base, Code: "48637", Name: "Mr. & Mrs. Eitan Pfeiffer" };
    const preview = await buildJlDonationPreview([pfeifferRow], new Date("2026-09-01"));
    const households = [{ id: PFEIFFER_ID, external_id: "48637" }];
    const match = matchJlDonationActivities(preview, households, []);
    assert.equal(match.matched.length, 1, "Pfeiffer's own coded donation must match normally, with no attribution involved");
    assert.equal(match.unknownActivities.length, 0);
    const activity = preview.activities[0];
    const paymentHouseholds = [{ id: PFEIFFER_ID, external_id: "48637", display_name: "Mr. & Mrs. Eitan Pfeiffer" }];
    const candidates = buildPaymentCandidates([activity], paymentHouseholds, [], [], [], knownAttributionsByCode, new Map());
    assert.equal(candidates[0].donorId, PFEIFFER_ID, "resolved via the ordinary code match");
    assert.equal(candidates[0].knownAttribution, null, "a directly-coded match must never also carry a known-attribution suggestion");
    assert.equal(candidates[0].attributedDonorId, null, "donorId came from the code match, not from an attribution decision");
  }

  // ---------------- Identity boundary: attribution is a suggestion, never identity equivalence ----------------
  {
    // If Price Waterhouse Foundation were ever itself imported as a real
    // household under 22297, ordinary code matching takes over completely
    // and the suggestion no longer applies -- proving 22297 and Pfeiffer's
    // 48637 are never treated as interchangeable identities.
    const priceWaterhouseAsDonor = { id: "donor-price-waterhouse", external_id: "22297", display_name: "Price Waterhouse Foundation" };
    const preview = await buildJlDonationPreview([base], new Date("2026-09-01"));
    const activity = preview.activities[0];
    const candidates = buildPaymentCandidates([activity], [priceWaterhouseAsDonor], [], [], [], knownAttributionsByCode, new Map());
    assert.equal(candidates[0].donorId, "donor-price-waterhouse", "a real household match always wins over a mere suggestion");
    assert.equal(candidates[0].knownAttribution, null, "no suggestion is shown once the code is a real, matched household");
    assert.notEqual(candidates[0].donorId, PFEIFFER_ID);
  }

  // ---------------- 13. Existing imports unrelated to third-party attribution are unaffected (defaults are backward compatible) ----------------
  {
    const ordinaryRow = { ...base, Code: "JL-1", Name: "Ordinary Family" };
    const preview = await buildJlDonationPreview([ordinaryRow], new Date("2026-09-01"));
    const households = [{ id: "donor-ordinary", external_id: "JL-1", display_name: "Ordinary Family" }];
    const match = matchJlDonationActivities(preview, households, []);
    assert.equal(match.matched.length, 1);
    const activity = preview.activities[0];
    // Called with none of the new parameters at all -- must behave exactly
    // as before this feature existed.
    const candidates = buildPaymentCandidates([activity], households, [], []);
    assert.equal(candidates[0].donorId, "donor-ordinary");
    assert.equal(candidates[0].knownAttribution, null);
    assert.equal(candidates[0].attributedDonorId, null);
    const rejectedRows = buildRejectedRows([], [], []);
    assert.deepEqual(rejectedRows, []);
  }

  console.log("giving-import-source-attribution.test.mjs: all assertions passed");
}

run();
