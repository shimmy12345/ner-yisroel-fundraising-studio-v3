import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { evaluatePledgeRenewal, evaluatePaymentPlan } from "../lib/relationships/pledge-payment-plan.ts";
import { buildPledgeRenewalReminderEvents, partitionRelationshipDateEventsByToday } from "../lib/workspace/relationship-date-events.ts";

// Mark Renewal Addressed (2026-10-09, see docs/AI-HANDOFF.md). Covers
// the full flow this round's requirements name explicitly: Today/Daily
// Agenda suppression, multiple-plans-per-donor independence, payment-
// plan continuity, and the write route's reuse of existing auth/
// ownership/validation. evaluatePledgeRenewal's own per-field
// acknowledgment semantics (unacknowledged/acknowledged/ended+acknowledged/
// renewal-date-unchanged) are covered in
// tests/pledge-payment-plan-renewal.test.mjs, alongside every other
// evaluatePledgeRenewal test -- not duplicated here.

const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
const et = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);
const TZ = "America/New_York";

// ============================================================
// Today / Daily Agenda suppression -- both surfaces read the SAME
// buildPledgeRenewalReminderEvents output (see lib/workspace/live-data.ts
// and lib/agenda/agenda-model.ts, which renders WorkspaceRelationshipDateEvent
// generically with no event-type-specific branching), so one test here
// covers both consumers at once -- there is no second, divergent code
// path either surface could read instead.
// ============================================================

test("Today/Daily Agenda: an unacknowledged, lapsed renewal still produces the standing follow-up event", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Mr. & Mrs. Jonathan Spetner", initials: "JS", donorCode: "2689" }]]);
  const now = et(2026, 10, 9);
  const original = utcMidnight(2025, 9, 26);
  const evaluation = evaluatePledgeRenewal(original, 12, null, null, now, TZ);
  assert.equal(evaluation.isRenewalFollowUpNeeded, true, "sanity check against the real Spetner dates");
  const rows = [{ donorId: "donor-1", planId: "plan-spetner", pledgeActivityId: "pledge-spetner", originalPledgeDate: original, commitmentDurationMonths: 12, originalPledgeAmountCents: 1200000, balanceCents: 100000, campaign: "CT2025", renewalDate: evaluation.renewalDate, fiveDayReminderDate: evaluation.fiveDayReminderDate, isRenewalFollowUpNeeded: evaluation.isRenewalFollowUpNeeded }];
  const events = buildPledgeRenewalReminderEvents(rows, identityByDonor, TZ, now);
  assert.equal(events.filter((e) => e.id.endsWith(":follow_up")).length, 1);
});

test("Today/Daily Agenda: acknowledging the SAME plan removes the follow-up event entirely -- nothing else changes", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Mr. & Mrs. Jonathan Spetner", initials: "JS", donorCode: "2689" }]]);
  const now = et(2026, 10, 9);
  const original = utcMidnight(2025, 9, 26);
  const acknowledgedAt = et(2026, 10, 8); // acknowledged yesterday
  const evaluation = evaluatePledgeRenewal(original, 12, null, acknowledgedAt, now, TZ);
  assert.equal(evaluation.isRenewalFollowUpNeeded, false);
  const rows = [{ donorId: "donor-1", planId: "plan-spetner", pledgeActivityId: "pledge-spetner", originalPledgeDate: original, commitmentDurationMonths: 12, originalPledgeAmountCents: 1200000, balanceCents: 100000, campaign: "CT2025", renewalDate: evaluation.renewalDate, fiveDayReminderDate: evaluation.fiveDayReminderDate, isRenewalFollowUpNeeded: evaluation.isRenewalFollowUpNeeded }];
  const events = buildPledgeRenewalReminderEvents(rows, identityByDonor, TZ, now);
  assert.equal(events.length, 0, "no event of any kind (approaching/renewal/follow_up) should remain -- the renewal date itself is long past and the follow-up is now acknowledged");
  const { today, upcoming } = partitionRelationshipDateEventsByToday(events, now, TZ);
  assert.equal(today.length, 0);
  assert.equal(upcoming.length, 0);
});

test("multiple plans for one donor: acknowledging one plan's renewal never suppresses a different plan's own follow-up", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Multi Plan Donor", initials: "MP", donorCode: "777" }]]);
  const now = et(2026, 10, 9);
  const originalA = utcMidnight(2025, 9, 1); // plan A: acknowledged
  const originalB = utcMidnight(2025, 9, 1); // plan B: same donor, same dates, NOT acknowledged
  const evalA = evaluatePledgeRenewal(originalA, 12, null, et(2026, 10, 1), now, TZ); // acknowledged
  const evalB = evaluatePledgeRenewal(originalB, 12, null, null, now, TZ); // not acknowledged
  assert.equal(evalA.isRenewalFollowUpNeeded, false, "plan A is acknowledged");
  assert.equal(evalB.isRenewalFollowUpNeeded, true, "plan B, an entirely separate plan for the SAME donor, must still need follow-up");
  const rows = [
    { donorId: "donor-1", planId: "plan-a", pledgeActivityId: "pledge-a", originalPledgeDate: originalA, commitmentDurationMonths: 12, originalPledgeAmountCents: 500000, balanceCents: 0, campaign: "A2025", renewalDate: evalA.renewalDate, fiveDayReminderDate: evalA.fiveDayReminderDate, isRenewalFollowUpNeeded: evalA.isRenewalFollowUpNeeded },
    { donorId: "donor-1", planId: "plan-b", pledgeActivityId: "pledge-b", originalPledgeDate: originalB, commitmentDurationMonths: 12, originalPledgeAmountCents: 500000, balanceCents: 0, campaign: "B2025", renewalDate: evalB.renewalDate, fiveDayReminderDate: evalB.fiveDayReminderDate, isRenewalFollowUpNeeded: evalB.isRenewalFollowUpNeeded },
  ];
  const events = buildPledgeRenewalReminderEvents(rows, identityByDonor, TZ, now);
  const followUpIds = events.filter((e) => e.id.endsWith(":follow_up")).map((e) => e.id);
  assert.deepEqual(followUpIds, ["pledge-renewal:plan-b:follow_up"], "only plan B's follow-up should remain -- plan A's acknowledgment must not leak onto plan B");
});

// ============================================================
// Payment-plan continuity after acknowledgment -- requirement: preserve
// the existing payment plan and all outstanding installments.
// evaluatePaymentPlan has no renewalAcknowledgedAt parameter at all, so
// this is true structurally, not merely by testing one example -- this
// test fixes that structural guarantee so it cannot silently regress if
// someone later tries to thread acknowledgment through the wrong
// function.
// ============================================================

test("evaluatePaymentPlan is completely unaware of renewal acknowledgment -- installment tracking is identical whether or not a renewal was acknowledged", () => {
  const plan = { nextExpectedPaymentAt: utcMidnight(2026, 10, 17), expectedDayOfMonth: 17, finalExpectedPaymentAt: utcMidnight(2026, 10, 17), endedAt: null };
  assert.equal(evaluatePaymentPlan.length, 5, "evaluatePaymentPlan must take exactly its original 5 parameters -- never a 6th for acknowledgment");
  const result = evaluatePaymentPlan(plan, [utcMidnight(2025, 8, 12)], 100000, et(2026, 10, 9), TZ);
  assert.equal(result.isOnTrack, true);
  assert.equal(result.balanceRemainingCents, 100000, "the outstanding balance/installment tracking is untouched by anything related to renewal acknowledgment");
});

// ============================================================
// Write route: reuses existing auth/ownership/validation patterns --
// this repo has no D1/env test harness for API routes (see
// tests/pledge-payment-plan.test.mjs's own "no D1/env test harness
// exists in this repo for routes" precedent), so route behavior is
// verified the same way every other route test in this codebase
// verifies it: reading the real route source and asserting its actual
// control flow, not a mock.
// ============================================================

const readRoute = () => readFile(new URL("../app/api/pledge-payment-plans/[id]/route.ts", import.meta.url), "utf8");

test("unauthorized write attempts: acknowledgeRenewal is handled AFTER the same getChatGPTUser() 401 check every other write in this route already uses -- no separate, weaker auth path", async () => {
  const route = await readRoute();
  const authCheckIndex = route.indexOf('if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });');
  const acknowledgeBranchIndex = route.indexOf("body.acknowledgeRenewal === true");
  assert.ok(authCheckIndex !== -1, "the route's 401 check must exist");
  assert.ok(acknowledgeBranchIndex !== -1, "the acknowledgeRenewal branch must exist");
  assert.ok(authCheckIndex < acknowledgeBranchIndex, "the 401 auth check must run strictly before the acknowledgeRenewal branch can ever execute");
});

test("unauthorized write attempts: acknowledgment is scoped by the SAME ownedActivePlan(id, userId) lookup every other action uses -- a plan belonging to another user can never be found or written to", async () => {
  const route = await readRoute();
  // ownedActivePlan's own query is WHERE p.id = ? AND p.user_id = ? --
  // read once, re-verified here against this round's new columns, and
  // the acknowledgeRenewal UPDATE statement itself must carry the same
  // WHERE id = ? AND user_id = ? scoping, never id alone.
  assert.match(route, /WHERE p\.id = \? AND p\.user_id = \? LIMIT 1/);
  assert.match(route, /renewal_acknowledged_at/);
  assert.match(route, /UPDATE pledge_payment_plans SET renewal_acknowledged_at = \?, updated_at = \? WHERE id = \? AND user_id = \?/, "the acknowledge write must be scoped by both plan id AND the authenticated user's own id, exactly like every other write in this route");
});

test("unauthorized write attempts: a plan already ended is rejected before the acknowledgeRenewal branch is ever reached (same 409 guard every other action already goes through)", async () => {
  const route = await readRoute();
  const endedGuardIndex = route.indexOf('if (plan.ended_at !== null) return Response.json({ error: "This payment plan has already ended" }, { status: 409 });');
  const acknowledgeBranchIndex = route.indexOf("body.acknowledgeRenewal === true");
  assert.ok(endedGuardIndex !== -1 && endedGuardIndex < acknowledgeBranchIndex, "the ended-plan 409 guard must run before acknowledgeRenewal can ever execute");
});

test("acknowledgeRenewal never sets ended_at, and ending a plan never sets renewal_acknowledged_at -- the two writes are fully independent statements", async () => {
  const route = await readRoute();
  // The acknowledge branch's own UPDATE statement text must not mention
  // ended_at at all; the end branch's own UPDATE statement must not
  // mention renewal_acknowledged_at.
  const acknowledgeUpdateMatch = route.match(/UPDATE pledge_payment_plans SET renewal_acknowledged_at = \?, updated_at = \? WHERE id = \? AND user_id = \?/);
  const endUpdateMatch = route.match(/UPDATE pledge_payment_plans SET ended_at = \?, note = COALESCE\(\?, note\), updated_at = \? WHERE id = \? AND user_id = \?/);
  assert.ok(acknowledgeUpdateMatch, "the acknowledge UPDATE statement must exist and must not touch ended_at");
  assert.ok(endUpdateMatch, "the end UPDATE statement must exist and must not touch renewal_acknowledged_at");
});

test("acknowledging a plan with no verified renewal date (missing original_pledge_date or commitment_duration_months) is rejected with a clear error", async () => {
  const route = await readRoute();
  assert.match(route, /This plan has no verified renewal date to acknowledge\./);
  assert.match(route, /plan\.original_pledge_date === null \|\| plan\.commitment_duration_months === null/);
});

test("the donor-page confirmation copy never claims the donor renewed, paid, or made a new commitment", async () => {
  const component = await readFile(new URL("../app/donors/[id]/PledgePaymentPlanManagement.tsx", import.meta.url), "utf8");
  assert.match(component, /Mark renewal addressed/);
  assert.match(component, /this does not mean the donor has renewed or made a new commitment/i);
  // The button is only rendered inside the isRenewalFollowUpNeeded guard
  // -- requirement: display the button only when an active plan has a
  // standing renewal follow-up.
  assert.match(component, /\{plan\.isRenewalFollowUpNeeded && <button type="button" className="payment-plan-acknowledge-renewal"/);
});
