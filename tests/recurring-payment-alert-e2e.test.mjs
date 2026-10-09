import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { evaluatePaymentPlan, evaluateRecurringPaymentAlert } from "../lib/relationships/pledge-payment-plan.ts";
import { buildRecurringPaymentAlertEvents, partitionRelationshipDateEventsByToday } from "../lib/workspace/relationship-date-events.ts";
import { buildAgenda } from "../lib/agenda/agenda-model.ts";
import { donorInitials, numericDonorCode } from "../lib/relationships/donor-identity.ts";

// Recurring Payments Behind Schedule -- CONTROLLED END-TO-END
// VERIFICATION (2026-10-09, see docs/AI-HANDOFF.md). No real donor data
// is touched anywhere in this file -- every row below is a synthetic
// fixture inserted into a fresh, isolated, in-memory SQLite database
// (node:sqlite's DatabaseSync, built from the actual committed
// migrations, including this round's 0041 -- same established
// convention as tests/ask-followup-and-meeting-brief.test.mjs and
// tests/relationship-facts-schema.test.mjs). The two new queries this
// feature added to lib/workspace/live-data.ts are mirrored here
// VERBATIM (not reimplemented), so a real SQL bug would be caught here,
// not just assumed correct from a pure-function test. The evaluation
// functions (evaluatePaymentPlan, evaluateRecurringPaymentAlert,
// buildRecurringPaymentAlertEvents) and the Daily Agenda renderer
// (buildAgenda) are the REAL, actually-imported functions -- never
// reimplemented or mocked -- so this proves the full flow: real SQL ->
// real evaluation -> real event -> real Today bucketing -> real Agenda
// rendering, exactly as lib/workspace/live-data.ts/lib/agenda/
// agenda-model.ts wire it together (those two files themselves cannot
// be imported directly in a plain Node test -- both ultimately depend
// on `cloudflare:workers`' `env` for their D1 access -- so this is the
// closest a Node unit test can get to the real production code path;
// see the "repo convention" note in tests/ask-followup-and-meeting-brief.test.mjs
// for the same constraint on every other route/page test in this suite).

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const TZ = "America/New_York";
const BASE_URL = "https://fundraising-os-staging.sgoldstein.workers.dev";
const NOW = Math.floor(Date.parse("2026-10-09T14:00:00Z") / 1000); // 10am EDT, Friday Oct 9 2026
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, "owner@example.test", NOW, NOW);
}
function seedDonor(db, { id, displayName, donorCode, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, donor_code, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?)")
    .run(id, userId, displayName, donorCode, NOW, NOW);
}
function seedPledge(db, { id, donorId, balanceCents, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, 'open_pledge', 'live', 'active', '{}', ?, ?)`)
    .run(id, donorId, userId, id, balanceCents, NOW, NOW);
}
function seedPlan(db, { id, donorId, pledgeActivityId, nextExpectedPaymentAt, expectedDayOfMonth, finalExpectedPaymentAt, installmentAmountCents = 100000, endedAt = null, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, ended_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, donorId, pledgeActivityId, installmentAmountCents, expectedDayOfMonth, nextExpectedPaymentAt, finalExpectedPaymentAt, endedAt, NOW, NOW);
}
function seedRefreshState(db, { lastDonationRefreshAt, userId = "u1" }) {
  db.prepare("INSERT INTO jl_refresh_state (user_id, last_donation_refresh_at, updated_at) VALUES (?, ?, ?)").run(userId, lastDonationRefreshAt, NOW);
}
function seedPayment(db, { pledgeActivityId, donorId, paymentDate, appliedCents, userId = "u1" }) {
  const importId = crypto.randomUUID();
  db.prepare(`INSERT INTO data_imports (id, user_id, file_name, file_hash, status, report_json, created_at) VALUES (?, ?, 'jl-export.csv', ?, 'completed', '{}', ?)`)
    .run(importId, userId, crypto.randomUUID(), NOW);
  db.prepare(`INSERT INTO jl_payment_assignment_audits (id, user_id, import_id, payment_fingerprint, donor_id, pledge_activity_id, decision_type, payment_cents, applied_cents, new_gift_cents, payment_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'apply_to_pledge', ?, ?, 0, ?, ?)`)
    .run(crypto.randomUUID(), userId, importId, crypto.randomUUID(), donorId, pledgeActivityId, appliedCents, appliedCents, paymentDate, NOW);
}

// Mirrors lib/workspace/live-data.ts's OWN literal queries verbatim.
function queryActivePlans(db, userId) {
  return db.prepare(`SELECT id, donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at FROM pledge_payment_plans WHERE user_id = ? AND ended_at IS NULL`).all(userId);
}
function queryLastDonationRefreshAt(db, userId) {
  const row = db.prepare(`SELECT last_donation_refresh_at FROM jl_refresh_state WHERE user_id = ?`).get(userId);
  return row?.last_donation_refresh_at ?? null;
}
function queryGivingById(db, userId) {
  const rows = db.prepare(`SELECT ga.id, ga.donor_id, d.display_name, d.primary_first_name, d.last_name, d.donor_code, d.external_id, ga.balance_cents
    FROM giving_activities ga JOIN donors d ON d.id = ga.donor_id
    WHERE ga.owner_user_id = ? AND ga.record_origin = 'live' AND d.owner_user_id = ? AND d.data_source = 'live' AND d.archived_at IS NULL AND ga.workspace_status = 'active' AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')`).all(userId, userId);
  return new Map(rows.map((r) => [r.id, r]));
}
function queryPaymentDatesByPledge(db, userId) {
  const rows = db.prepare(`SELECT pledge_activity_id, payment_date FROM jl_payment_assignment_audits WHERE user_id = ? AND decision_type = 'apply_to_pledge' AND applied_cents > 0 AND payment_date IS NOT NULL`).all(userId);
  const map = new Map();
  for (const r of rows) {
    const list = map.get(r.pledge_activity_id);
    if (list) list.push(r.payment_date); else map.set(r.pledge_activity_id, [r.payment_date]);
  }
  return map;
}
function identityMapFromDb(db, userId) {
  const donors = db.prepare(`SELECT id, display_name, primary_first_name, last_name, donor_code, external_id FROM donors WHERE owner_user_id = ?`).all(userId);
  return new Map(donors.map((d) => [d.id, {
    donorName: d.display_name,
    initials: donorInitials({ displayName: d.display_name, primaryFirstName: d.primary_first_name, lastName: d.last_name }),
    donorCode: numericDonorCode({ donorCode: d.donor_code, externalId: d.external_id }),
  }]));
}

// The real evaluation pipeline, step for step identical to the loop
// lib/workspace/live-data.ts runs (payment-plan evaluation -> import-
// freshness evaluation -> alert-row assembly), over REAL query results.
function evaluateAlertsFromDb(db, userId, now) {
  const plans = queryActivePlans(db, userId);
  const givingById = queryGivingById(db, userId);
  const lastDonationRefreshAt = queryLastDonationRefreshAt(db, userId);
  const paymentDatesByPledge = queryPaymentDatesByPledge(db, userId);
  const rows = [];
  for (const plan of plans) {
    const pledge = givingById.get(plan.pledge_activity_id);
    if (!pledge) continue;
    const linkedPaymentDates = paymentDatesByPledge.get(plan.pledge_activity_id) ?? [];
    const evaluation = evaluatePaymentPlan(
      { nextExpectedPaymentAt: plan.next_expected_payment_at, expectedDayOfMonth: plan.expected_day_of_month, finalExpectedPaymentAt: plan.final_expected_payment_at, endedAt: null },
      linkedPaymentDates,
      pledge.balance_cents ?? 0,
      now,
      TZ,
    );
    const alert = evaluateRecurringPaymentAlert(evaluation, lastDonationRefreshAt);
    if (alert.status === null) continue;
    rows.push({ donorId: plan.donor_id, planId: plan.id, status: alert.status, expectedPaymentAt: alert.expectedPaymentAt, expectedAmountCents: plan.installment_amount_cents, daysBehind: alert.daysBehind });
  }
  return rows;
}

function emptyBrief(overrides) {
  return {
    overview: "", recommendation: "", priorities: [], priorityCount: 0,
    relationshipQueue: { overdue: [], today: [], thisWeek: [], upcoming: [] },
    morningBrief: { meetingsToday: 0, overdueFollowUps: 0, recentGifts: 0, upcomingReminders: 0, suggestedPriority: null },
    recentlyViewed: [], recentlyUpdated: [], todaySchedule: [], upcomingActivities: [], meetings: [], gifts: [],
    todayRelationshipDates: [], upcomingRelationshipDates: [], generatedAt: NOW,
    ...overrides,
  };
}

// ================================================================
// A. "Verify latest payment import" -- real SQL, real evaluation, real
// Today bucketing, real Daily Agenda rendering, all against an
// isolated in-memory database.
// ================================================================

test("A. stale import: a genuinely unsatisfied installment whose due date predates the last JL refresh renders as a non-definitive 'Verify latest payment import' alert end to end", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d-stale", displayName: "Mr. & Mrs. Stale Import Donor", donorCode: "90001" });
  seedPledge(db, { id: "p-stale", donorId: "d-stale", balanceCents: 100000 });
  seedPlan(db, { id: "plan-stale", donorId: "d-stale", pledgeActivityId: "p-stale", nextExpectedPaymentAt: utcMidnight(2026, 9, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2027, 9, 1) });
  seedRefreshState(db, { lastDonationRefreshAt: utcMidnight(2026, 8, 15) }); // BEFORE the installment's due date

  const rows = evaluateAlertsFromDb(db, "u1", NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "verify_import");
  assert.equal(rows[0].expectedPaymentAt, utcMidnight(2026, 9, 1));
  assert.equal(rows[0].expectedAmountCents, 100000);
  assert.ok(rows[0].daysBehind > 0);

  const identityByDonor = identityMapFromDb(db, "u1");
  const events = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, NOW);
  assert.equal(events.length, 1);
  const [event] = events;
  // Required fields (requirement 4): donor name/code, real expected
  // payment date, expected amount, days behind, action label.
  assert.equal(event.donorName, "Mr. & Mrs. Stale Import Donor");
  assert.equal(event.donorCode, "90001");
  assert.equal(event.dateLabel, "Sep 1, 2026");
  assert.match(event.secondaryDateLabel, /\$1,000\.00 expected/);
  assert.match(event.secondaryDateLabel, /\d+ days? behind/);
  assert.equal(event.relationshipPhrase, "Verify latest payment import");

  // Requirement 5: an outdated import must never produce a DEFINITIVE
  // delinquency claim -- the phrase itself is a prompt to verify data,
  // never an assertion that the donor missed a payment.
  assert.doesNotMatch(event.relationshipPhrase, /overdue|missed|delinquent|declined/i);

  // Today rendering: lands in the today bucket.
  const { today, upcoming } = partitionRelationshipDateEventsByToday(events, NOW, TZ);
  assert.equal(today.length, 1);
  assert.equal(upcoming.length, 0);

  // Daily Agenda rendering: the REAL buildAgenda(), fed this real event.
  const agenda = buildAgenda(emptyBrief({ todayRelationshipDates: today }), { now: NOW, baseUrl: BASE_URL });
  const item = agenda.importantDates.find((i) => i.donorName === "Mr. & Mrs. Stale Import Donor");
  assert.ok(item, "the alert must actually render as an Agenda item, not just exist as a data-model event");
  assert.match(item.headline, /Verify latest payment import/);
  assert.equal(item.donorCode, "90001");
  assert.equal(item.href, `${BASE_URL}/donors/d-stale`, "requirement: link to donor profile");
});

// ================================================================
// B. "Payment follow-up needed" + multiple plans per donor + duplicate
// prevention + completed/ended exclusion, all in one shared database
// (one global jl_refresh_state row, exactly as production has --
// deliberately demonstrating the real-world limitation documented
// below: freshness is evaluated per-installment-due-date against ONE
// global refresh timestamp, not confirmed per plan).
// ================================================================

test("B. confirmed overdue (import ran after the due date) renders 'Payment follow-up needed' end to end, while other plans for the SAME donor are evaluated independently", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d-multi", displayName: "Mr. & Mrs. Multi Plan Donor", donorCode: "90002" });
  seedRefreshState(db, { lastDonationRefreshAt: utcMidnight(2026, 10, 5) }); // AFTER the behind plan's due date

  // Plan 1: genuinely behind, current data.
  seedPledge(db, { id: "p-behind", donorId: "d-multi", balanceCents: 100000 });
  seedPlan(db, { id: "plan-behind", donorId: "d-multi", pledgeActivityId: "p-behind", nextExpectedPaymentAt: utcMidnight(2026, 9, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2027, 9, 1) });

  // Plan 2: same donor, not yet due -- must produce NO alert.
  seedPledge(db, { id: "p-notdue", donorId: "d-multi", balanceCents: 50000 });
  seedPlan(db, { id: "plan-notdue", donorId: "d-multi", pledgeActivityId: "p-notdue", nextExpectedPaymentAt: utcMidnight(2026, 11, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2027, 11, 1) });

  // Plan 3: same donor, financially completed -- must produce NO alert
  // regardless of how stale its own schedule looks (requirement 7).
  seedPledge(db, { id: "p-completed", donorId: "d-multi", balanceCents: 0 });
  seedPlan(db, { id: "plan-completed", donorId: "d-multi", pledgeActivityId: "p-completed", nextExpectedPaymentAt: utcMidnight(2026, 1, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2026, 6, 1) });

  // Plan 4: same donor, formally ENDED -- excluded at the SQL level
  // itself (WHERE ended_at IS NULL), never even reaches evaluation
  // (requirement 7).
  seedPledge(db, { id: "p-ended", donorId: "d-multi", balanceCents: 75000 });
  seedPlan(db, { id: "plan-ended", donorId: "d-multi", pledgeActivityId: "p-ended", nextExpectedPaymentAt: utcMidnight(2026, 1, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2026, 6, 1), endedAt: utcMidnight(2026, 7, 1) });

  const plansFromDb = queryActivePlans(db, "u1");
  assert.equal(plansFromDb.length, 3, "requirement 7 at the SQL level: the ended plan must never even be returned by the active-plans query");
  assert.ok(!plansFromDb.some((p) => p.id === "plan-ended"));

  const rows = evaluateAlertsFromDb(db, "u1", NOW);
  assert.equal(rows.length, 1, "requirement 8: only the genuinely-behind plan produces an alert -- the not-yet-due and completed plans are independently evaluated and correctly produce none");
  assert.equal(rows[0].planId, "plan-behind");
  assert.equal(rows[0].status, "follow_up_needed");

  const identityByDonor = identityMapFromDb(db, "u1");
  const events = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].relationshipPhrase, "Payment follow-up needed");
  assert.equal(events[0].id, "recurring-payment:plan-behind");

  // Requirement 9: no duplicate -- re-running the exact same query/
  // evaluation again produces the identical single row, never two.
  const rowsAgain = evaluateAlertsFromDb(db, "u1", NOW);
  assert.equal(rowsAgain.length, 1);
  assert.equal(buildRecurringPaymentAlertEvents(rowsAgain, identityByDonor, TZ, NOW).length, 1);

  // Requirement 11: no decline language anywhere in real output.
  assert.doesNotMatch(events[0].relationshipPhrase, /declined/i);
  assert.doesNotMatch(events[0].secondaryDateLabel, /declined/i);

  // Today vs. Daily Agenda consistency (requirement 10): both surfaces
  // consume the exact same `events` array -- demonstrated directly,
  // not merely asserted.
  const { today } = partitionRelationshipDateEventsByToday(events, NOW, TZ);
  const agenda = buildAgenda(emptyBrief({ todayRelationshipDates: today }), { now: NOW, baseUrl: BASE_URL });
  const item = agenda.importantDates.find((i) => i.donorName === "Mr. & Mrs. Multi Plan Donor");
  assert.ok(item);
  assert.match(item.headline, /Payment follow-up needed/);
  assert.equal(item.href, `${BASE_URL}/donors/d-multi`);
});

// ================================================================
// C. A payment recorded after the alert causes it to disappear
// automatically (requirement 6) -- re-derived fresh from the database,
// nothing persisted anywhere to manually clear.
// ================================================================

test("C. recording the missing payment makes the alert disappear on the very next evaluation, with no manual dismissal step", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d-recovers", displayName: "Mr. & Mrs. Recovers Donor", donorCode: "90003" });
  seedPledge(db, { id: "p-recovers", donorId: "d-recovers", balanceCents: 100000 });
  seedPlan(db, { id: "plan-recovers", donorId: "d-recovers", pledgeActivityId: "p-recovers", nextExpectedPaymentAt: utcMidnight(2026, 9, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2027, 9, 1) });
  seedRefreshState(db, { lastDonationRefreshAt: utcMidnight(2026, 10, 5) });

  const before = evaluateAlertsFromDb(db, "u1", NOW);
  assert.equal(before.length, 1, "the alert exists before the payment is recorded");
  assert.equal(before[0].status, "follow_up_needed");

  // Record the real payment, satisfying the Sep 1 cycle, and update the
  // pledge's own balance to reflect it -- exactly what a real JL import
  // does.
  seedPayment(db, { pledgeActivityId: "p-recovers", donorId: "d-recovers", paymentDate: utcMidnight(2026, 9, 2), appliedCents: 100000 });
  db.prepare("UPDATE giving_activities SET balance_cents = 0 WHERE id = ?").run("p-recovers");

  const after = evaluateAlertsFromDb(db, "u1", NOW);
  assert.equal(after.length, 0, "the alert must disappear automatically the moment the payment is recorded -- no dismissal action was taken");
});

// ================================================================
// Review of last_donation_refresh_at's reliability (requirement 12).
// ================================================================

test("documented limitation: last_donation_refresh_at is one GLOBAL per-user timestamp, not a per-installment confirmation -- two plans with very different real data completeness share the same freshness verdict", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d-global", displayName: "Mr. & Mrs. Global Refresh Donor", donorCode: "90004" });
  // A single refresh timestamp covers the whole user -- there is no
  // per-pledge or per-import-row freshness signal in this schema.
  seedRefreshState(db, { lastDonationRefreshAt: utcMidnight(2026, 10, 5) });
  seedPledge(db, { id: "p-g1", donorId: "d-global", balanceCents: 100000 });
  seedPlan(db, { id: "plan-g1", donorId: "d-global", pledgeActivityId: "p-g1", nextExpectedPaymentAt: utcMidnight(2026, 9, 1), expectedDayOfMonth: 1, finalExpectedPaymentAt: utcMidnight(2027, 9, 1) });
  seedPledge(db, { id: "p-g2", donorId: "d-global", balanceCents: 100000 });
  seedPlan(db, { id: "plan-g2", donorId: "d-global", pledgeActivityId: "p-g2", nextExpectedPaymentAt: utcMidnight(2026, 9, 20), expectedDayOfMonth: 20, finalExpectedPaymentAt: utcMidnight(2027, 9, 20) });

  const rows = evaluateAlertsFromDb(db, "u1", NOW);
  // Both plans are judged "fresh enough" purely because the ONE global
  // refresh ran after both their due dates -- even though the refresh
  // timestamp alone cannot actually confirm either specific pledge's
  // row was present/complete in that particular JL export. This is the
  // real limitation: a successful global refresh is necessary but not
  // sufficient evidence that any one installment's data is complete.
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === "follow_up_needed"));
  // The wording itself stays appropriately hedged given this limitation
  // -- "follow-up needed" prompts a check, it never asserts a confirmed
  // missed payment or a credit-card failure.
  const identityByDonor = identityMapFromDb(db, "u1");
  const events = buildRecurringPaymentAlertEvents(rows, identityByDonor, TZ, NOW);
  for (const event of events) {
    assert.doesNotMatch(event.relationshipPhrase, /confirmed|guaranteed|certainly|definitely/i);
  }
});
