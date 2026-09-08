import assert from "node:assert/strict";
import { validatePaymentDecisionShape, planPaymentAssignments, buildPaymentCandidates } from "../lib/import/jl-payment-assignment.ts";
import { buildJlDonationPreview } from "../lib/import/jl-donations.ts";

// Giving Import Reconciliation -- commit-time validation failure
// (docs/AI-HANDOFF.md). This regression covers the ACTUAL incident: the
// UI let the user make valid-looking decisions (Skip -- already recorded,
// multi-pledge allocation, leave remainder unresolved), but a SEPARATE,
// earlier hand-inlined shape gate in app/api/import/route.ts had never
// been updated to accept the three values/fields added for those
// features -- so every real decision using any of them failed validation
// and the whole batch rolled back with a generic error, even though
// nothing was actually wrong with the decisions themselves.
//
// Simulates the EXACT browser round-trip: ImportExperience.tsx builds
// `paymentDecisions` as `{ fingerprint, ...decisionState }` from its own
// React state, then JSON.stringify()s the whole request body (dropping
// `undefined` fields, as JSON.stringify always does) before it crosses the
// network -- so a decision that looks valid in an in-memory unit test
// could still fail once real serialization drops or reshapes a field. All
// fixtures below go through an explicit JSON.stringify/JSON.parse round
// trip before validation, exactly like the real request.

const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

// Mirrors ImportExperience.tsx's exact request-body construction for one
// entry of its `paymentDecisions` state map.
function serializedDecision(fingerprint, decisionState) {
  const wireShape = { fingerprint, ...decisionState };
  return JSON.parse(JSON.stringify(wireShape));
}

function assertValid(fingerprint, decisionState, label) {
  const wire = serializedDecision(fingerprint, decisionState);
  const error = validatePaymentDecisionShape(wire);
  assert.equal(error, null, `${label}: expected valid, got ${JSON.stringify(error)}`);
}

function assertInvalid(fingerprint, decisionState, label) {
  const wire = serializedDecision(fingerprint, decisionState);
  const error = validatePaymentDecisionShape(wire);
  assert.notEqual(error, null, `${label}: expected invalid, got null (accepted)`);
  return error;
}

// ==== Section 2/8: every UI-representable decision shape must validate ====

// "Needs review" -- the ImportExperience.tsx classify-select default.
assertValid(FINGERPRINT_A, { action: "needs_review", pledgeId: null, allocations: undefined, overpaymentAction: null }, "Needs review");

// "Skip -- already recorded" -- the Schwartz-case action (Section 4/H).
// This exact shape is what broke: the OLD inline gate's action allowlist
// was ["apply_to_pledge","new_gift","needs_review"] and never included
// "skip_duplicate".
assertValid(FINGERPRINT_A, { action: "skip_duplicate", pledgeId: null, allocations: undefined, overpaymentAction: null }, "Skip -- already recorded (H: Schwartz regression)");

// Apply to one open pledge (single-pledge convenience path, unchanged).
assertValid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: "pledge-1", allocations: undefined, overpaymentAction: null }, "Apply to one open pledge (B)");

// Apply to multiple open pledges via the new `allocations` array. This
// exact shape (pledgeId: null alongside a populated allocations array) is
// the other half of what broke: the OLD gate required
// `typeof decision.pledgeId === "string"` whenever action ===
// "apply_to_pledge", with no exception for the allocations path, so
// `pledgeId: null` alone failed it regardless of allocations.
assertValid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 60000 }, { pledgeId: "pledge-2", amountCents: 30000 }], overpaymentAction: null }, "Apply to multiple open pledges (C/D)");

// Remainder to another pledge is just a longer `allocations` array --
// covered by the case above and the 3-pledge case below (D).
assertValid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 50000 }, { pledgeId: "pledge-2", amountCents: 70000 }, { pledgeId: "pledge-3", amountCents: 30000 }], overpaymentAction: null }, "Payment across 3 pledges (D)");

// Remainder as new gift/payment.
assertValid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 60000 }], overpaymentAction: "split_remainder_new_gift" }, "Multi-pledge + remainder new gift (E)");

// Leave remainder unresolved -- the other new value the OLD gate never
// accepted (its overpaymentAction allowlist was only
// [undefined, null, "split_remainder_new_gift"]).
assertValid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 60000 }], overpaymentAction: "leave_unresolved" }, "Multi-pledge + leave unresolved (F)");

// Single-pledge decision with a remainder handled via overpaymentAction
// (no explicit allocations array at all -- the "choose a different
// pledge" / original overpayment path).
assertValid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: "pledge-1", allocations: undefined, overpaymentAction: "leave_unresolved" }, "Single pledge + leave unresolved");

// "New gift/payment".
assertValid(FINGERPRINT_A, { action: "new_gift", pledgeId: null, allocations: undefined, overpaymentAction: null }, "New gift/payment");

// ==== Section 3: allocations[] edge cases ====

// Empty allocations array must be treated the same as "no allocations
// provided" (falls back to requiring pledgeId), matching
// planPaymentAssignments's own `allocations && allocations.length > 0`
// check -- an empty array must never itself satisfy the "has allocations"
// branch and skip the pledgeId requirement.
{
  const error = assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [], overpaymentAction: null }, "apply_to_pledge with empty allocations and no pledgeId");
  assert.match(error.reason, /Select an open pledge/);
}

// G: invalid over-allocation shape-level checks (planPaymentAssignments
// itself catches the arithmetic; the shape gate catches malformed
// individual entries before that).
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 0 }], overpaymentAction: null }, "zero-cent allocation (G)");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: -100 }], overpaymentAction: null }, "negative-cent allocation (G)");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 100.5 }], overpaymentAction: null }, "non-integer-cent allocation (G)");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 100 }, { pledgeId: "pledge-1", amountCents: 200 }], overpaymentAction: null }, "duplicate pledge ID within one decision (J)");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "", amountCents: 100 }], overpaymentAction: null }, "empty pledge ID in allocation");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ amountCents: 100 }], overpaymentAction: null }, "missing pledgeId field entirely");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1" }], overpaymentAction: null }, "missing amountCents field entirely (undefined vanishes over JSON)");
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: ["not-an-object"], overpaymentAction: null }, "non-object allocation entry");

// Unrecognized remainder action must never be silently accepted.
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: "pledge-1", allocations: undefined, overpaymentAction: "some_future_value" }, "unrecognized overpaymentAction");
assertInvalid(FINGERPRINT_A, { action: "not_a_real_action", pledgeId: null, allocations: undefined, overpaymentAction: null }, "unrecognized action");

// apply_to_pledge with neither pledgeId nor allocations.
assertInvalid(FINGERPRINT_A, { action: "apply_to_pledge", pledgeId: null, allocations: undefined, overpaymentAction: null }, "apply_to_pledge with nothing selected");

// Malformed fingerprint must never validate regardless of an otherwise-fine decision.
assert.notEqual(validatePaymentDecisionShape({ fingerprint: "not-a-hash", action: "skip_duplicate" }), null, "malformed fingerprint must be rejected");
assert.notEqual(validatePaymentDecisionShape(null), null, "null decision must be rejected");
assert.notEqual(validatePaymentDecisionShape("a string"), null, "non-object decision must be rejected");

// ==== I: browser JSON round-trip -- undefined fields vanish but the
// decision must remain valid, exactly as ImportExperience.tsx sends it ====
{
  const decision = { action: "skip_duplicate", pledgeId: null, allocations: undefined, overpaymentAction: null };
  const wire = JSON.parse(JSON.stringify({ fingerprint: FINGERPRINT_A, ...decision }));
  assert.ok(!("allocations" in wire), "JSON.stringify must have dropped the undefined allocations key -- this is the real wire shape");
  assert.equal(validatePaymentDecisionShape(wire), null, "a decision valid before serialization must remain valid after the real JSON round-trip");
}

// ==== J: preview-session save/reopen round-trip (lib/import/preview-session.ts's parseDraftDecisions) ====
{
  const decisionsMap = {
    [FINGERPRINT_A]: { action: "skip_duplicate", pledgeId: null, allocations: undefined, overpaymentAction: null },
    [FINGERPRINT_B]: { action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 60000 }, { pledgeId: "pledge-2", amountCents: 30000 }], overpaymentAction: "leave_unresolved" },
  };
  // Exactly what a debounced draft-save writes to import_preview_sessions.decisions_json.
  const savedJson = JSON.stringify(decisionsMap);
  const restored = JSON.parse(savedJson);
  for (const [fingerprint, decision] of Object.entries(restored)) {
    const wire = { fingerprint, ...decision };
    assert.equal(validatePaymentDecisionShape(wire), null, `restored decision for ${fingerprint} must remain valid after a preview-session save/reopen round-trip`);
  }
}

// ==== End-to-end: the shape gate accepting a decision must mean
// planPaymentAssignments can actually process it (no second, silent gap
// between "shape valid" and "semantically usable"). ====
{
  const rows = [{ Code: "JL-1", "First Name": "Example", "Last Name": "Donor", Date: "2026-09-07", Campaign: "CT2026", Amount: "900.00" }];
  const preview = await buildJlDonationPreview(rows, new Date("2026-09-08"));
  const households = [{ id: "donor-1", external_id: "JL-1", display_name: "Example Donor" }];
  const openPledges = [
    { id: "pledge-1", donor_id: "donor-1", source_fingerprint: "fp-1", activity_date: 1, committed_cents: 60000, paid_cents: 0, balance_cents: 60000, description: null, source_campaign: "A", category: "open_pledge", source_snapshot: "{}" },
    { id: "pledge-2", donor_id: "donor-1", source_fingerprint: "fp-2", activity_date: 1, committed_cents: 30000, paid_cents: 0, balance_cents: 30000, description: null, source_campaign: "B", category: "open_pledge", source_snapshot: "{}" },
  ];
  const candidates = buildPaymentCandidates(preview.activities, households, openPledges, []);
  const fingerprint = candidates[0].fingerprint;
  const wireDecision = JSON.parse(JSON.stringify({ fingerprint, action: "apply_to_pledge", pledgeId: null, allocations: [{ pledgeId: "pledge-1", amountCents: 60000 }, { pledgeId: "pledge-2", amountCents: 30000 }], overpaymentAction: null }));
  assert.equal(validatePaymentDecisionShape(wireDecision), null, "the multi-pledge decision must pass the shape gate");
  const plan = planPaymentAssignments(candidates, [wireDecision]);
  assert.equal(plan.errors.length, 0, "a shape-valid multi-pledge decision must also be accepted by planPaymentAssignments");
  assert.equal(plan.pledgeUpdates.length, 2);
}

// ==== H: stale pledge reference -- rejected with a specific reason, not a generic one ====
{
  const rows = [{ Code: "JL-1", "First Name": "Example", "Last Name": "Donor", Date: "2026-09-07", Campaign: "CT2026", Amount: "900.00" }];
  const preview = await buildJlDonationPreview(rows, new Date("2026-09-08"));
  const households = [{ id: "donor-1", external_id: "JL-1", display_name: "Example Donor" }];
  // Commit-time candidates reflect a pledge that no longer exists (e.g.
  // fully allocated or archived since the preview was loaded).
  const candidates = buildPaymentCandidates(preview.activities, households, [], []);
  const fingerprint = candidates[0].fingerprint;
  const staleDecision = { fingerprint, action: "apply_to_pledge", pledgeId: "pledge-that-no-longer-exists", allocations: undefined, overpaymentAction: null };
  assert.equal(validatePaymentDecisionShape(staleDecision), null, "the shape gate alone cannot know a pledge reference is stale -- that is planPaymentAssignments's job");
  const plan = planPaymentAssignments(candidates, [staleDecision]);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0].reason, /Select an open pledge belonging to this donor/, "a stale pledge reference must produce a specific, actionable reason, not the generic validation-failed message");
}

process.stdout.write("Payment decision shape checks passed.\n");
