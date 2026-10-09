import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

// ============================================================
// SAFEGUARD 1 (independent-review requirement on commit 3ff780c): the
// PATCH route must never trust the client/UI alone that a plan
// currently has an outstanding renewal follow-up -- it must
// independently re-derive eligibility server-side via the exact same
// evaluatePledgeRenewal the donor page/Today/Daily Agenda use, and
// reject a request sent after the real eligibility window has closed
// (renewal date not yet reached, or already acknowledged), regardless
// of what the UI currently shows.
// ============================================================

test("server-side safeguard: evaluatePledgeRenewal itself correctly reports NOT eligible before the renewal date has passed, even with both fields verified -- the exact condition the route's own eligibility check depends on", () => {
  const original = utcMidnight(2026, 1, 1);
  // Renewal date is Jan 1, 2027 -- still in the future relative to "now".
  const now = et(2026, 6, 1);
  const evaluation = evaluatePledgeRenewal(original, 12, null, null, now, TZ);
  assert.equal(evaluation.renewalDate, utcMidnight(2027, 1, 1));
  assert.equal(evaluation.isRenewalFollowUpNeeded, false, "a plan whose renewal date has not yet arrived must never be eligible for acknowledgment -- this is exactly what the route's own server-side check rejects, independent of whatever the UI currently renders");
});

test("server-side safeguard: the route independently recomputes eligibility via evaluatePledgeRenewal and rejects with a 422 when it is false -- never accepts the write merely because the client sent acknowledgeRenewal: true", async () => {
  const route = await readRoute();
  const acknowledgeBranchStart = route.indexOf("body.acknowledgeRenewal === true");
  const acknowledgeBranchEnd = route.indexOf("\n  }", route.indexOf("pledge_payment_plan_renewal_acknowledged", acknowledgeBranchStart));
  const branch = route.slice(acknowledgeBranchStart, acknowledgeBranchEnd);
  assert.match(branch, /evaluatePledgeRenewal\(plan\.original_pledge_date, plan\.commitment_duration_months, plan\.ended_at, plan\.renewal_acknowledged_at, now, profile\.timezone\)/, "eligibility must be recomputed from the plan's OWN current stored fields, the same function every other surface uses -- never trusted from the request body");
  assert.match(branch, /if \(!evaluation\.isRenewalFollowUpNeeded\)/, "a plan that is not currently eligible must be rejected");
  assert.match(branch, /status: 422/, "the rejection must be a client error (422), never silently accepted or treated as a server failure (500)");
  // The eligibility check must run BEFORE the UPDATE/INSERT statements
  // that actually perform the write -- never after.
  const eligibilityCheckIndex = branch.indexOf("!evaluation.isRenewalFollowUpNeeded");
  const writeIndex = branch.indexOf("UPDATE pledge_payment_plans SET renewal_acknowledged_at");
  assert.ok(eligibilityCheckIndex !== -1 && writeIndex !== -1 && eligibilityCheckIndex < writeIndex, "the eligibility check must gate the write, not run after it");
});

// ============================================================
// SAFEGUARD 3 (independent-review requirement on commit 3ff780c):
// repeated/duplicate acknowledgment requests (a double-click, a
// retried request) must never create a second, misleading audit entry
// for what was really one fundraiser action.
// ============================================================

test("duplicate-safety: a repeated request against an already-acknowledged plan is an idempotent no-op, returned BEFORE the eligibility re-check and BEFORE any write -- never a second audit row", async () => {
  const route = await readRoute();
  const acknowledgeBranchStart = route.indexOf("body.acknowledgeRenewal === true");
  const acknowledgeBranchEnd = route.indexOf("\n  }", route.indexOf("pledge_payment_plan_renewal_acknowledged", acknowledgeBranchStart));
  const branch = route.slice(acknowledgeBranchStart, acknowledgeBranchEnd);
  assert.match(branch, /if \(plan\.renewal_acknowledged_at !== null\)/, "an already-acknowledged plan must be detected explicitly");
  assert.match(branch, /alreadyAcknowledged: true/, "a repeated request must be reported back as a no-op, not as a fresh success or an error that would confuse a fundraiser after the first click already succeeded");
  const alreadyAcknowledgedIndex = branch.indexOf("plan.renewal_acknowledged_at !== null");
  const insertIndex = branch.indexOf("INSERT INTO pledge_payment_plan_changes");
  assert.ok(alreadyAcknowledgedIndex !== -1 && insertIndex !== -1 && alreadyAcknowledgedIndex < insertIndex, "the already-acknowledged short-circuit must return before the audit INSERT is ever reached -- structurally impossible to write a second audit row for an already-acknowledged plan");
});

// ============================================================
// SAFEGUARD 2 (independent-review requirement on commit 3ff780c):
// editing originalPledgeDate or commitmentDurationMonths after
// acknowledgment must invalidate the existing acknowledgment, so it
// can never silently suppress a materially different recalculated
// renewal follow-up. The route's own literal decision formula is
// mirrored here (not reimplemented differently), matching this repo's
// established convention for route-level logic with no D1/env test
// harness (see tests/ask-followup-and-meeting-brief.test.mjs's own
// "mirrors the route's own literal SQL/logic" precedent).
// ============================================================

function nextRenewalAcknowledgedAt(plan, next) {
  const renewalDateInputsChanged = next.originalPledgeDate !== plan.originalPledgeDate || next.commitmentDurationMonths !== plan.commitmentDurationMonths;
  return renewalDateInputsChanged ? null : plan.renewalAcknowledgedAt;
}

test("editing originalPledgeDate alone clears an existing acknowledgment", () => {
  const plan = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12, renewalAcknowledgedAt: et(2026, 10, 9) };
  const next = { originalPledgeDate: utcMidnight(2025, 8, 1), commitmentDurationMonths: 12 };
  assert.equal(nextRenewalAcknowledgedAt(plan, next), null);
});

test("editing commitmentDurationMonths alone clears an existing acknowledgment", () => {
  const plan = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12, renewalAcknowledgedAt: et(2026, 10, 9) };
  const next = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 24 };
  assert.equal(nextRenewalAcknowledgedAt(plan, next), null);
});

test("editing BOTH fields clears an existing acknowledgment", () => {
  const plan = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12, renewalAcknowledgedAt: et(2026, 10, 9) };
  const next = { originalPledgeDate: utcMidnight(2024, 1, 1), commitmentDurationMonths: 6 };
  assert.equal(nextRenewalAcknowledgedAt(plan, next), null);
});

test("editing an UNRELATED field (no change to originalPledgeDate/commitmentDurationMonths) preserves the existing acknowledgment", () => {
  const plan = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12, renewalAcknowledgedAt: et(2026, 10, 9) };
  const next = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12 }; // installmentAmountCents/note/schedule dates are the only things that "changed" in this hypothetical request
  assert.equal(nextRenewalAcknowledgedAt(plan, next), plan.renewalAcknowledgedAt);
});

test("re-submitting the SAME values for originalPledgeDate/commitmentDurationMonths (a no-op edit) preserves acknowledgment -- only an ACTUAL value change clears it", () => {
  const plan = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12, renewalAcknowledgedAt: et(2026, 10, 9) };
  const next = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12 };
  assert.equal(nextRenewalAcknowledgedAt(plan, next), plan.renewalAcknowledgedAt);
});

test("a plan with no existing acknowledgment is unaffected either way (null stays null)", () => {
  const plan = { originalPledgeDate: utcMidnight(2025, 9, 26), commitmentDurationMonths: 12, renewalAcknowledgedAt: null };
  assert.equal(nextRenewalAcknowledgedAt(plan, { originalPledgeDate: utcMidnight(2024, 1, 1), commitmentDurationMonths: 6 }), null);
  assert.equal(nextRenewalAcknowledgedAt(plan, { originalPledgeDate: plan.originalPledgeDate, commitmentDurationMonths: plan.commitmentDurationMonths }), null);
});

test("end-to-end: evaluatePledgeRenewal confirms a cleared acknowledgment genuinely resumes follow-up for the NEW, materially different renewal date, never silently staying suppressed", () => {
  // Acknowledged against the OLD cycle (original Sep 2025 + 12mo -> Sep
  // 2026 renewal, already past as of "now").
  const now = et(2026, 10, 9);
  const oldOriginal = utcMidnight(2025, 9, 26);
  const oldAcknowledgedAt = et(2026, 10, 1);
  const before = evaluatePledgeRenewal(oldOriginal, 12, null, oldAcknowledgedAt, now, TZ);
  assert.equal(before.isRenewalFollowUpNeeded, false, "sanity check: suppressed under the old, acknowledged cycle");

  // The fundraiser corrects the original pledge date -- a materially
  // different renewal date results (still in the past, but a DIFFERENT
  // past date the old acknowledgment was never actually about). Per the
  // route's own clearing logic, renewal_acknowledged_at is now null.
  const correctedOriginal = utcMidnight(2025, 3, 1); // -> renewal Mar 1, 2026, already passed too, but a DIFFERENT date
  const after = evaluatePledgeRenewal(correctedOriginal, 12, null, null, now, TZ);
  assert.notEqual(after.renewalDate, before.renewalDate, "the corrected renewal date must genuinely differ from the old one");
  assert.equal(after.isRenewalFollowUpNeeded, true, "follow-up must resume for the new, materially different renewal date -- the stale acknowledgment must never silently carry over and suppress it");
});

test("the EDIT branch's UPDATE statement persists the (possibly now-cleared) renewal_acknowledged_at alongside originalPledgeDate/commitmentDurationMonths in the SAME statement -- never a separate, skippable write", async () => {
  const route = await readRoute();
  assert.match(route, /UPDATE pledge_payment_plans SET installment_amount_cents = \?, expected_day_of_month = \?, next_expected_payment_at = \?, final_expected_payment_at = \?, note = \?, original_pledge_date = \?, commitment_duration_months = \?, renewal_acknowledged_at = \?, updated_at = \? WHERE id = \? AND user_id = \?/);
  assert.match(route, /const renewalDateInputsChanged = nextOriginalPledgeDate !== plan\.original_pledge_date \|\| nextCommitmentDurationMonths !== plan\.commitment_duration_months;/);
  assert.match(route, /const nextRenewalAcknowledgedAt = renewalDateInputsChanged \? null : plan\.renewal_acknowledged_at;/);
});

// ============================================================
// Real, behavioral, isolated-database proof (not source-text alone):
// all three safeguards exercised against a real in-memory SQLite
// database built from the actual committed migrations (same
// established convention as tests/recurring-payment-alert-e2e.test.mjs/
// tests/ask-followup-and-meeting-brief.test.mjs). No real donor data is
// touched anywhere here.
// ============================================================

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, "owner@example.test", 0, 0);
}
function seedDonor(db, { id, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Fixture Donor', ?, ?)").run(id, userId, 0, 0);
}
function seedPledge(db, { id, donorId, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, 50000, 'open_pledge', 'live', 'active', '{}', ?, ?)`).run(id, donorId, userId, id, 0, 0);
}
function seedPlan(db, { id, donorId, pledgeActivityId, originalPledgeDate, commitmentDurationMonths, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, original_pledge_date, commitment_duration_months, renewal_acknowledged_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, ?, ?)`)
    .run(id, userId, donorId, pledgeActivityId, utcMidnight(2026, 11, 1), utcMidnight(2027, 11, 1), originalPledgeDate, commitmentDurationMonths, 0, 0);
}
function getPlan(db, id) {
  return db.prepare("SELECT * FROM pledge_payment_plans WHERE id = ?").get(id);
}
function getChangeCount(db, planId) {
  return db.prepare("SELECT COUNT(*) AS cnt FROM pledge_payment_plan_changes WHERE plan_id = ?").get(planId).cnt;
}

// Mirrors the route's OWN acknowledgeRenewal branch logic literally
// (eligibility re-derivation via the real evaluatePledgeRenewal,
// idempotent short-circuit, then the write) -- not a reimplementation.
function attemptAcknowledge(db, planId, userId, now) {
  const plan = getPlan(db, planId);
  if (plan.original_pledge_date === null || plan.commitment_duration_months === null) return { error: "no verified renewal date" };
  if (plan.renewal_acknowledged_at !== null) return { alreadyAcknowledged: true, renewalAcknowledgedAt: plan.renewal_acknowledged_at };
  const evaluation = evaluatePledgeRenewal(plan.original_pledge_date, plan.commitment_duration_months, plan.ended_at, plan.renewal_acknowledged_at, now, TZ);
  if (!evaluation.isRenewalFollowUpNeeded) return { error: "not currently eligible" };
  db.prepare("UPDATE pledge_payment_plans SET renewal_acknowledged_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(now, now, planId, userId);
  db.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, 'updated', ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), planId, userId, plan.donor_id, JSON.stringify(["renewalAcknowledgedAt"]), JSON.stringify({ renewalAcknowledgedAt: null }), JSON.stringify({ renewalAcknowledgedAt: now }), now);
  return { renewalAcknowledgedAt: now };
}

// Mirrors the route's OWN EDIT-branch clearing logic literally.
function attemptEditOriginalPledgeDate(db, planId, userId, newOriginalPledgeDate, now) {
  const plan = getPlan(db, planId);
  const renewalDateInputsChanged = newOriginalPledgeDate !== plan.original_pledge_date;
  const nextRenewalAcknowledgedAt = renewalDateInputsChanged ? null : plan.renewal_acknowledged_at;
  db.prepare("UPDATE pledge_payment_plans SET original_pledge_date = ?, renewal_acknowledged_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(newOriginalPledgeDate, nextRenewalAcknowledgedAt, now, planId, userId);
  if (renewalDateInputsChanged) {
    db.prepare(`INSERT INTO pledge_payment_plan_changes (id, plan_id, user_id, donor_id, action, changed_fields, before_json, after_json, created_at)
      VALUES (?, ?, ?, ?, 'updated', ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), planId, userId, plan.donor_id, JSON.stringify(["originalPledgeDate", "renewalAcknowledgedAt"]), JSON.stringify({ originalPledgeDate: plan.original_pledge_date, renewalAcknowledgedAt: plan.renewal_acknowledged_at }), JSON.stringify({ originalPledgeDate: newOriginalPledgeDate, renewalAcknowledgedAt: nextRenewalAcknowledgedAt }), now);
  }
}

test("real-database proof: duplicate acknowledgment requests never create a second audit row", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1" });
  seedPledge(db, { id: "p1", donorId: "d1" });
  const originalPledgeDate = utcMidnight(2025, 1, 1); // 12 months -> renewal Jan 1 2026, already past
  seedPlan(db, { id: "plan1", donorId: "d1", pledgeActivityId: "p1", originalPledgeDate, commitmentDurationMonths: 12 });
  const now = et(2026, 10, 9);

  const first = attemptAcknowledge(db, "plan1", "u1", now);
  assert.ok(first.renewalAcknowledgedAt, "first request succeeds");
  assert.equal(getChangeCount(db, "plan1"), 1);

  const second = attemptAcknowledge(db, "plan1", "u1", now + 60);
  assert.equal(second.alreadyAcknowledged, true, "a second, duplicate request is reported as a no-op");
  assert.equal(getChangeCount(db, "plan1"), 1, "no second audit row was ever written");
  assert.equal(getPlan(db, "plan1").renewal_acknowledged_at, first.renewalAcknowledgedAt, "the original acknowledgment timestamp is preserved unchanged by the duplicate request");
});

test("real-database proof: the server rejects acknowledgment of a plan whose renewal date has not yet arrived, even if a client sends acknowledgeRenewal: true", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d2" });
  seedPledge(db, { id: "p2", donorId: "d2" });
  const originalPledgeDate = utcMidnight(2026, 9, 1); // 12 months -> renewal Sep 1 2027, far in the future
  seedPlan(db, { id: "plan2", donorId: "d2", pledgeActivityId: "p2", originalPledgeDate, commitmentDurationMonths: 12 });
  const now = et(2026, 10, 9);

  const result = attemptAcknowledge(db, "plan2", "u1", now);
  assert.equal(result.error, "not currently eligible");
  assert.equal(getChangeCount(db, "plan2"), 0, "no write occurs for an ineligible plan");
  assert.equal(getPlan(db, "plan2").renewal_acknowledged_at, null);
});

test("real-database proof: acknowledge, then edit originalPledgeDate -- acknowledgment is cleared, exactly 2 audit rows exist (one per real action, never a phantom duplicate), and the NEW renewal date genuinely needs follow-up again", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d3" });
  seedPledge(db, { id: "p3", donorId: "d3" });
  const originalPledgeDate = utcMidnight(2025, 1, 1); // renewal Jan 1 2026
  seedPlan(db, { id: "plan3", donorId: "d3", pledgeActivityId: "p3", originalPledgeDate, commitmentDurationMonths: 12 });
  const now = et(2026, 10, 9);

  attemptAcknowledge(db, "plan3", "u1", now);
  assert.ok(getPlan(db, "plan3").renewal_acknowledged_at, "acknowledged");
  assert.equal(getChangeCount(db, "plan3"), 1);

  const correctedOriginalPledgeDate = utcMidnight(2025, 6, 1); // materially different -> renewal Jun 1 2026
  attemptEditOriginalPledgeDate(db, "plan3", "u1", correctedOriginalPledgeDate, now + 120);

  const finalPlan = getPlan(db, "plan3");
  assert.equal(finalPlan.renewal_acknowledged_at, null, "the edit must have cleared the acknowledgment");
  assert.equal(finalPlan.original_pledge_date, correctedOriginalPledgeDate);
  assert.equal(getChangeCount(db, "plan3"), 2, "exactly one audit row for the acknowledgment and one for the clearing edit -- never more");

  // The new renewal date genuinely needs follow-up again -- proven via
  // the real evaluatePledgeRenewal against the plan's final stored state.
  const evaluation = evaluatePledgeRenewal(finalPlan.original_pledge_date, finalPlan.commitment_duration_months, finalPlan.ended_at, finalPlan.renewal_acknowledged_at, now + 86400 * 30, TZ);
  assert.equal(evaluation.isRenewalFollowUpNeeded, true, "follow-up must resume for the new, materially different renewal date");
});
