import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluatePaymentPlan, evaluateRecurringPaymentAlert } from "../lib/relationships/pledge-payment-plan.ts";
import { buildRecurringPaymentAlertEvents, partitionRelationshipDateEventsByToday } from "../lib/workspace/relationship-date-events.ts";

// Recurring Payments Behind Schedule (2026-10-09, see docs/AI-HANDOFF.md).
// evaluateRecurringPaymentAlert is a pure derivation over
// evaluatePaymentPlan's OWN output (never a second overdue calculation)
// plus one new axis: JL donation-import freshness.

const DAY = 86400;
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
const et = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d, 16, 0, 0) / 1000);
const TZ = "America/New_York";

function plan({ nextExpectedPaymentAt, finalExpectedPaymentAt, expectedDayOfMonth = 15, endedAt = null }) {
  return { nextExpectedPaymentAt, expectedDayOfMonth, finalExpectedPaymentAt, endedAt };
}

test("stale import: a genuinely unsatisfied installment is reported as 'verify_import' when the last refresh predates its due date", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const now = et(2026, 10, 9);
  const evaluation = evaluatePaymentPlan(p, [], 50000, now, TZ);
  assert.equal(evaluation.isLate, true, "sanity check: this installment really is late per the existing evaluator");
  const lastRefresh = utcMidnight(2026, 9, 1); // refreshed BEFORE the due date
  const alert = evaluateRecurringPaymentAlert(evaluation, lastRefresh);
  assert.equal(alert.status, "verify_import");
  assert.equal(alert.expectedPaymentAt, due);
});

test("no refresh ever recorded (null) is treated the same as stale, never as confirmed-current", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const evaluation = evaluatePaymentPlan(p, [], 50000, et(2026, 10, 9), TZ);
  const alert = evaluateRecurringPaymentAlert(evaluation, null);
  assert.equal(alert.status, "verify_import");
});

test("genuinely overdue installment: 'follow_up_needed' once the import ran on or after the due date and the installment is still unsatisfied", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const now = et(2026, 10, 9);
  const evaluation = evaluatePaymentPlan(p, [], 50000, now, TZ);
  const lastRefresh = utcMidnight(2026, 10, 1); // refreshed AFTER the due date
  const alert = evaluateRecurringPaymentAlert(evaluation, lastRefresh);
  assert.equal(alert.status, "follow_up_needed");
  assert.equal(alert.daysBehind, evaluation.daysLate);
  assert.ok(alert.daysBehind > 0);
});

test("a refresh exactly ON the due date counts as covering it (>=, not >)", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const evaluation = evaluatePaymentPlan(p, [], 50000, et(2026, 10, 9), TZ);
  const alert = evaluateRecurringPaymentAlert(evaluation, due);
  assert.equal(alert.status, "follow_up_needed");
});

test("payments that become current: once the actual payment is recorded, there is no alert at all -- re-derived fresh, nothing persisted", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const now = et(2026, 10, 9);
  const stillOwing = evaluatePaymentPlan(p, [], 50000, now, TZ);
  assert.notEqual(evaluateRecurringPaymentAlert(stillOwing, due).status, null);
  const nowPaid = evaluatePaymentPlan(p, [due], 0, now, TZ);
  assert.equal(evaluateRecurringPaymentAlert(nowPaid, due).status, null, "once the balance is 0 and/or the cycle is satisfied, the alert must disappear entirely");
});

test("completed plans are excluded -- isCompleted (balance <= 0) forces isLate false, so no alert", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const evaluation = evaluatePaymentPlan(p, [], 0, et(2026, 10, 9), TZ);
  assert.equal(evaluation.isLate, false);
  assert.equal(evaluateRecurringPaymentAlert(evaluation, utcMidnight(2026, 10, 1)).status, null);
});

test("ended plans are excluded -- endedAt forces isLate false, so no alert regardless of balance or import freshness", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15), endedAt: utcMidnight(2026, 9, 1) });
  const evaluation = evaluatePaymentPlan(p, [], 50000, et(2026, 10, 9), TZ);
  assert.equal(evaluation.isLate, false);
  assert.equal(evaluateRecurringPaymentAlert(evaluation, utcMidnight(2026, 10, 1)).status, null);
});

test("a plan whose final expected date has already passed is excluded too, even with an open balance (isPlanEndedWithBalance territory, not this alert)", () => {
  const p = plan({ nextExpectedPaymentAt: utcMidnight(2025, 9, 15), finalExpectedPaymentAt: utcMidnight(2025, 12, 15) });
  const evaluation = evaluatePaymentPlan(p, [], 50000, et(2026, 10, 9), TZ);
  assert.equal(evaluation.finalDatePassed, true);
  assert.equal(evaluation.isLate, false, "lateness is never evaluated once finalDatePassed -- isPlanEndedWithBalance covers that state instead");
  assert.equal(evaluateRecurringPaymentAlert(evaluation, utcMidnight(2026, 10, 1)).status, null);
});

test("never infers a declined payment from an overdue installment alone -- 'declined' is not a reachable status", () => {
  const due = utcMidnight(2026, 9, 15);
  const p = plan({ nextExpectedPaymentAt: due, finalExpectedPaymentAt: utcMidnight(2027, 9, 15) });
  const evaluation = evaluatePaymentPlan(p, [], 50000, et(2026, 10, 9), TZ);
  for (const refresh of [null, utcMidnight(2026, 9, 1), utcMidnight(2026, 10, 1), utcMidnight(2030, 1, 1)]) {
    const alert = evaluateRecurringPaymentAlert(evaluation, refresh);
    assert.notEqual(alert.status, "declined");
    assert.ok(alert.status === null || alert.status === "verify_import" || alert.status === "follow_up_needed");
  }
});

// ============================================================
// buildRecurringPaymentAlertEvents -- Today/Daily Agenda surfacing.
// ============================================================

test("builds a 'Verify latest payment import' event, pinned to today, carrying the real due date/amount/days-behind", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Mr. & Mrs. Test Donor", initials: "TD", donorCode: "12345" }]]);
  const now = et(2026, 10, 9);
  const todayEpoch = utcMidnight(2026, 10, 9);
  const rows = [{ donorId: "donor-1", planId: "plan-a", status: "verify_import", expectedPaymentAt: utcMidnight(2026, 9, 15), expectedAmountCents: 10000, daysBehind: 17 }];
  const events = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, now);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.id, "recurring-payment:plan-a");
  assert.equal(event.type, "recurring_payment_behind");
  assert.equal(event.relationshipPhrase, "Verify latest payment import");
  assert.equal(event.dateEpoch, todayEpoch, "pinned to today so it always lands in the Today bucket, never Coming Up");
  assert.equal(event.dateLabel, "Sep 15, 2026", "dateLabel still shows the plan's own real expected payment date");
  assert.match(event.secondaryDateLabel, /\$100\.00 expected/);
  assert.match(event.secondaryDateLabel, /17 days behind/);
});

test("builds a 'Payment follow-up needed' event with the correct singular/plural days-behind wording", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Donor One", initials: "DO", donorCode: null }]]);
  const now = et(2026, 10, 9);
  const rows = [{ donorId: "donor-1", planId: "plan-b", status: "follow_up_needed", expectedPaymentAt: utcMidnight(2026, 10, 1), expectedAmountCents: null, daysBehind: 1 }];
  const [event] = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, now);
  assert.equal(event.relationshipPhrase, "Payment follow-up needed");
  assert.match(event.secondaryDateLabel, /Amount not set/);
  assert.match(event.secondaryDateLabel, /1 day behind/, "singular 'day', not 'days', for exactly 1");
});

test("always lands in Today, never Coming Up, no matter how long it has been behind", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Donor One", initials: "DO", donorCode: "999" }]]);
  const now = et(2026, 10, 9);
  const rows = [{ donorId: "donor-1", planId: "plan-c", status: "follow_up_needed", expectedPaymentAt: utcMidnight(2026, 1, 1), expectedAmountCents: 5000, daysBehind: 280 }];
  const events = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, now);
  const { today, upcoming } = partitionRelationshipDateEventsByToday(events, now, TZ);
  assert.equal(today.length, 1);
  assert.equal(upcoming.length, 0);
});

test("duplicate prevention: id is keyed on planId alone, so the caller's one-evaluation-per-plan loop can never produce two different alerts for the same plan", () => {
  // live-data.ts's own loop calls evaluateRecurringPaymentAlert exactly
  // once per active pledge_payment_plans row (ended_at IS NULL is
  // already an application-level invariant: at most one such row per
  // pledge), so it structurally cannot emit two rows sharing a planId.
  // This test fixes the id's shape so that guarantee cannot silently
  // regress (e.g. by someone keying the id on donorId instead).
  const identityByDonor = new Map([["donor-1", { donorName: "Donor One", initials: "DO", donorCode: "999" }]]);
  const now = et(2026, 10, 9);
  const rows = [{ donorId: "donor-1", planId: "plan-d", status: "follow_up_needed", expectedPaymentAt: utcMidnight(2026, 10, 1), expectedAmountCents: 5000, daysBehind: 8 }];
  const [event] = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, now);
  assert.equal(event.id, `recurring-payment:${rows[0].planId}`);
});

test("multiple payment plans for one donor: each plan's alert is independent, never collapsed into one", () => {
  const identityByDonor = new Map([["donor-1", { donorName: "Multi Plan Donor", initials: "MP", donorCode: "777" }]]);
  const now = et(2026, 10, 9);
  const rows = [
    { donorId: "donor-1", planId: "plan-e", status: "verify_import", expectedPaymentAt: utcMidnight(2026, 9, 1), expectedAmountCents: 10000, daysBehind: 30 },
    { donorId: "donor-1", planId: "plan-f", status: "follow_up_needed", expectedPaymentAt: utcMidnight(2026, 10, 1), expectedAmountCents: 20000, daysBehind: 1 },
  ];
  const events = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, now);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
  const byId = new Map(events.map((e) => [e.id, e]));
  assert.equal(byId.get("recurring-payment:plan-e").relationshipPhrase, "Verify latest payment import");
  assert.equal(byId.get("recurring-payment:plan-f").relationshipPhrase, "Payment follow-up needed");
});

test("a donor missing from identityByDonor is silently skipped, matching every other event builder in this file", () => {
  const now = et(2026, 10, 9);
  const rows = [{ donorId: "ghost-donor", planId: "plan-g", status: "follow_up_needed", expectedPaymentAt: utcMidnight(2026, 10, 1), expectedAmountCents: 1000, daysBehind: 8 }];
  assert.equal(buildRecurringPaymentAlertEvents(rows, new Map(), TZ, now).length, 0);
});
