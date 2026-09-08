import assert from "node:assert/strict";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";
import { buildPaymentCandidates, planPaymentAssignments } from "../lib/import/jl-payment-assignment.ts";
import { buildDonationRollbackPreview } from "../lib/import/donation-rollback.ts";

// Giving Import Reconciliation -- Problem A: duplicate-payment Skip
// semantics, including the mandatory Mordechai Schwartz regression case
// (docs/AI-HANDOFF.md).

const households = [{ id: "donor-schwartz", external_id: "JL-SCHWARTZ", display_name: "Mr. & Mrs. Mordechai Schwartz" }];
const SEP_7_2026 = Math.floor(Date.UTC(2026, 8, 7) / 1000);

function existingCompletedGift(overrides = {}) {
  return {
    id: "existing-gift-1",
    donor_id: "donor-schwartz",
    activity_date: SEP_7_2026,
    committed_cents: 967000,
    source_campaign: "CT2026",
    description: "Annual gift",
    source_snapshot: "{}",
    created_at: 1000,
    ...overrides,
  };
}

async function schwartzCandidate(existingGifts) {
  const rows = [{ Code: "JL-SCHWARTZ", "First Name": "Mordechai", "Last Name": "Schwartz", Date: "2026-09-07", Campaign: "CT2026", Amount: "9670.00" }];
  const preview = await buildJlDonationPreview(rows, new Date("2026-09-08"));
  return buildPaymentCandidates(preview.activities, households, [], [], existingGifts);
}

// ---- H. Mandatory regression: the Schwartz $9,670 CT2026 Sep 7 payment must surface the existing completed gift as a strong duplicate candidate ----
{
  const candidates = await schwartzCandidate([existingCompletedGift()]);
  assert.equal(candidates.length, 1);
  const [schwartz] = candidates;
  assert.ok(schwartz.duplicateMatch, "the existing completed gift must be surfaced, not silently invisible");
  assert.equal(schwartz.duplicateMatch.confidence, "likely");
  assert.equal(schwartz.duplicateMatch.existingActivityId, "existing-gift-1");
  assert.equal(schwartz.duplicateMatch.existingAmountCents, 967000);
  assert.equal(schwartz.duplicateMatch.existingCampaign, "CT2026");
  // The review UI must never present this as though there were no
  // existing matching record: the default action must not be a bare
  // "needs_review" masquerading as "nothing to see here."
  assert.equal(schwartz.action, "skip_duplicate", "a likely duplicate must default toward Skip -- already recorded, never toward New gift/payment");
  assert.notEqual(schwartz.action, "new_gift");

  // The user must be able to resolve it with Skip -- already recorded,
  // without mutating the existing completed gift in any way.
  const plan = planPaymentAssignments(candidates, [{ fingerprint: schwartz.fingerprint, action: "skip_duplicate" }]);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.newGifts.length, 0, "Skip must create no new gift");
  assert.equal(plan.pledgeUpdates.length, 0, "Skip must apply nothing to any pledge");
  assert.equal(plan.skippedDuplicates.length, 1);
  assert.equal(plan.skippedDuplicates[0].matchedActivityId, "existing-gift-1");
  assert.equal(plan.skippedDuplicates[0].matchConfidence, "likely");
}

// ---- F. Manual Skip -- already recorded creates no giving mutation, even with zero automatic duplicate evidence ----
{
  const candidates = await schwartzCandidate([]); // no existing gifts at all
  const [schwartz] = candidates;
  assert.equal(schwartz.duplicateMatch, null);
  assert.notEqual(schwartz.action, "skip_duplicate", "with zero evidence, Skip must never be preselected automatically");
  // Section 4: the control must still be available regardless of automatic matching.
  const plan = planPaymentAssignments(candidates, [{ fingerprint: schwartz.fingerprint, action: "skip_duplicate" }]);
  assert.equal(plan.errors.length, 0, "a manual Skip must be accepted even without any detected duplicate");
  assert.equal(plan.newGifts.length, 0);
  assert.equal(plan.pledgeUpdates.length, 0);
  assert.equal(plan.skippedDuplicates[0].matchedActivityId, null);
  assert.equal(plan.skippedDuplicates[0].matchConfidence, null);
}

// ---- C. User can override a duplicate suggestion (same donor/date/amount twice legitimately) ----
{
  const candidates = await schwartzCandidate([existingCompletedGift()]);
  const [schwartz] = candidates;
  // The user knows this is a genuinely separate second gift and overrides
  // the suggested Skip with New gift/payment.
  const plan = planPaymentAssignments(candidates, [{ fingerprint: schwartz.fingerprint, action: "new_gift" }]);
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.newGifts.length, 1);
  assert.equal(plan.newGifts[0].amountCents, 967000);
  assert.equal(plan.skippedDuplicates.length, 0);
}

// ---- G. Repeated submit of Skip is idempotent (zero mutation both times) ----
{
  const candidates = await schwartzCandidate([existingCompletedGift()]);
  const [schwartz] = candidates;
  const first = planPaymentAssignments(candidates, [{ fingerprint: schwartz.fingerprint, action: "skip_duplicate" }]);
  const second = planPaymentAssignments(candidates, [{ fingerprint: schwartz.fingerprint, action: "skip_duplicate" }]);
  for (const plan of [first, second]) {
    assert.equal(plan.newGifts.length, 0);
    assert.equal(plan.pledgeUpdates.length, 0);
    assert.equal(plan.errors.length, 0);
  }
}

// ---- A batch containing a skipped-duplicate change row must remain rollback-eligible for its OTHER real changes ----
{
  const changes = [
    { source_fingerprint: "insert-fp", change_type: "insert", previous_json: null },
    { source_fingerprint: "skip-fp", change_type: "skipped_duplicate", previous_json: JSON.stringify({ matchedActivityId: "existing-gift-1", matchConfidence: "likely" }) },
  ];
  const current = [{ source_fingerprint: "insert-fp", donor_id: "donor-schwartz", donor_name: "Schwartz", activity_date: SEP_7_2026, amount_cents: 100, paid_cents: 100, balance_cents: 0, category: "completed_gift", description: null, source_snapshot: null }];
  const preview = buildDonationRollbackPreview(changes, current);
  assert.equal(preview.safe, true, "a skipped-duplicate row must never block rollback of the rest of the batch");
  assert.equal(preview.blockers.length, 0);
  assert.equal(preview.newGifts.length, 1, "the real insert must still be recognized for rollback");
}

process.stdout.write("Payment skip-duplicate checks passed.\n");
