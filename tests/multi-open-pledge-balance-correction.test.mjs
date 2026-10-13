import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateBalanceCorrection } from "../lib/relationships/pledge-balance-correction.ts";
import { aggregatePortfolioFocusInputs } from "../lib/portfolio-focus/aggregate.ts";
import { buildPortfolioContext } from "../lib/portfolio-focus/context.ts";
import { scorePortfolioFocusDonor } from "../lib/portfolio-focus/score.ts";
import { detectSituations } from "../lib/fundraising-intelligence/situations.ts";
import { evaluateOpenPledgePlanStatus, isOpenPledgeActionable } from "../lib/relationships/pledge-payment-plan.ts";

// Multi-Open-Pledge Independent Evaluation -- Manual Pledge Balance
// Correction interaction (2026-10-13, see docs/AI-HANDOFF.md). No real
// donor data is touched anywhere in this file -- every row below is a
// synthetic fixture inserted into a fresh, isolated, in-memory SQLite
// database (node:sqlite's DatabaseSync, built from the actual committed
// migrations -- the SAME established convention as
// tests/pledge-balance-correction-e2e.test.mjs and
// tests/recurring-payment-alert-e2e.test.mjs). The giving query below
// mirrors lib/portfolio-focus/data.ts's own literal SQL VERBATIM
// (including its COALESCE(pbc.corrected_balance_cents, ga.balance_cents)
// effective-balance join), never reimplemented differently -- and every
// evaluation call (aggregatePortfolioFocusInputs, detectSituations,
// evaluateOpenPledgePlanStatus, isOpenPledgeActionable,
// scorePortfolioFocusDonor) is the REAL, actually-imported production
// function. This is deliberately NOT a second, competing evaluation
// algorithm -- it proves the real one behaves correctly once a real
// correction has already changed what the real SQL hands it.

const root = path.resolve(import.meta.dirname, "..");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const TZ = "America/New_York";
const NOW = Math.floor(Date.parse("2026-10-13T14:00:00Z") / 1000);
const utcMidnight = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
const dollars = (d) => d * 100;

function seedUser(db, userId = "u1") {
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(userId, `${userId}@example.test`, NOW, NOW);
}
function seedDonor(db, { id, displayName, donorCode, userId = "u1" }) {
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, donor_code, created_at, updated_at) VALUES (?, ?, 'live', ?, ?, ?, ?)")
    .run(id, userId, displayName, donorCode, NOW, NOW);
}
function seedPledge(db, { id, donorId, committedCents, paidCents, balanceCents, activityDate, category = "partially_paid_pledge", sourceCampaign = null, userId = "u1" }) {
  db.prepare(`INSERT INTO giving_activities (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, category, source_campaign, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, 'jl', 'hh-1', ?, ?, ?, ?, ?, ?, ?, 'live', 'active', '{}', ?, ?)`)
    .run(id, donorId, userId, id, activityDate, committedCents, paidCents, balanceCents, category, sourceCampaign, NOW, NOW);
}
function seedPlan(db, { id, donorId, pledgeActivityId, installmentAmountCents, nextExpectedPaymentAt, finalExpectedPaymentAt, userId = "u1" }) {
  db.prepare(`INSERT INTO pledge_payment_plans (id, user_id, donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 23, ?, ?, ?, ?)`)
    .run(id, userId, donorId, pledgeActivityId, installmentAmountCents, nextExpectedPaymentAt, finalExpectedPaymentAt, NOW, NOW);
}
function seedPayment(db, { pledgeActivityId, donorId, paymentDate, appliedCents, userId = "u1" }) {
  const importId = crypto.randomUUID();
  db.prepare(`INSERT INTO data_imports (id, user_id, file_name, file_hash, status, report_json, created_at) VALUES (?, ?, 'jl-export.csv', ?, 'completed', '{}', ?)`)
    .run(importId, userId, crypto.randomUUID(), NOW);
  db.prepare(`INSERT INTO jl_payment_assignment_audits (id, user_id, import_id, payment_fingerprint, donor_id, pledge_activity_id, decision_type, payment_cents, applied_cents, new_gift_cents, payment_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'apply_to_pledge', ?, ?, 0, ?, ?)`)
    .run(crypto.randomUUID(), userId, importId, crypto.randomUUID(), donorId, pledgeActivityId, appliedCents, appliedCents, paymentDate, NOW);
}

// Mirrors the real POST /api/pledge-balance-corrections route's own
// control flow -- the SAME helper tests/pledge-balance-correction-e2e.test.mjs
// already established, reused here rather than a hand-rolled INSERT.
function attemptCorrect(db, { pledgeActivityId, userId = "u1", correctedBalanceCents, reason, now = NOW }) {
  const validation = validateBalanceCorrection(correctedBalanceCents, reason);
  if (!validation.ok) throw new Error(`Fixture setup: invalid correction -- ${validation.reason}`);
  const pledge = db.prepare("SELECT id, donor_id, balance_cents FROM giving_activities WHERE id = ? AND owner_user_id = ?").get(pledgeActivityId, userId);
  if (!pledge) throw new Error("Fixture setup: pledge not found");
  const correctionId = crypto.randomUUID();
  db.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at, reversed_at, reversal_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
    .run(correctionId, userId, pledge.donor_id, pledgeActivityId, pledge.balance_cents ?? 0, validation.correctedBalanceCents, validation.reason, now);
  return correctionId;
}

// Mirrors lib/portfolio-focus/data.ts's own giving query VERBATIM,
// including its effective-balance COALESCE -- the real query cannot be
// imported directly outside a Workers env (same documented constraint
// every other *-e2e.test.mjs file in this suite works around the same
// way).
function queryGiving(db, userId = "u1") {
  return db.prepare(`SELECT ga.id, ga.donor_id, ga.paid_cents, COALESCE(pbc.corrected_balance_cents, ga.balance_cents) AS balance_cents, ga.activity_date, ga.category, ga.item_type, ga.description, ga.source_campaign
    FROM giving_activities ga
    LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL
    WHERE ga.owner_user_id = ? AND ga.record_origin = 'live' AND ga.workspace_status = 'active' AND ga.category NOT IN ('needs_review','nonfinancial_entry','pending_gift')`).all(userId);
}
function queryDonors(db, userId = "u1") {
  return db.prepare(`SELECT id, display_name, donor_code, relationship_summary, institutional_memory FROM donors WHERE owner_user_id = ? AND data_source = 'live' AND archived_at IS NULL`).all(userId);
}
function queryPaymentPlans(db, userId = "u1") {
  return db.prepare(`SELECT donor_id, pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at FROM pledge_payment_plans WHERE user_id = ? AND ended_at IS NULL`).all(userId);
}
function queryPledgePayments(db, userId = "u1") {
  return db.prepare(`SELECT pledge_activity_id, payment_date, applied_cents FROM jl_payment_assignment_audits WHERE user_id = ? AND decision_type = 'apply_to_pledge' AND applied_cents > 0 AND payment_date IS NOT NULL`).all(userId);
}

// Runs the REAL aggregation -> scoring -> Fundraising Intelligence
// pipeline for one user, exactly as lib/fundraising-intelligence/
// compute.ts wires it together (never reimplemented).
function runPipeline(db, userId = "u1") {
  const raw = {
    donors: queryDonors(db, userId), giving: queryGiving(db, userId), asks: [], interactions: [], reminders: [],
    yahrtzeits: [], importantDates: [], pledgePayments: queryPledgePayments(db, userId), paymentPlans: queryPaymentPlans(db, userId),
    relationshipFacts: [], acknowledgments: [], historicalContext: [],
  };
  const { donorInputs, financialEventAmounts } = aggregatePortfolioFocusInputs(raw, NOW, TZ);
  const ctx = buildPortfolioContext(donorInputs, financialEventAmounts);
  const signalsByDonor = new Map();
  donorInputs.forEach((donor, i) => {
    const result = { ...scorePortfolioFocusDonor(donor, ctx), rank: i + 1 };
    signalsByDonor.set(donor.donorId, detectSituations(donor, result, [], [], NOW));
  });
  return { donorInputs, signalsByDonor };
}

// Reproduces app/donors/[id]/page.tsx's own single-actionable-pledge
// SELECTION logic directly against the real shared primitives -- same
// convention as tests/multi-open-pledge.test.mjs's cross-surface
// consistency section.
function selectMostActionablePledge(db, userId, candidates) {
  let chosen = candidates[0];
  for (const candidate of candidates) {
    const linkedDates = db.prepare("SELECT payment_date FROM jl_payment_assignment_audits WHERE pledge_activity_id = ? AND user_id = ? AND decision_type='apply_to_pledge' AND applied_cents > 0").all(candidate.id, userId).map((r) => r.payment_date);
    const linkedAmounts = db.prepare("SELECT applied_cents FROM jl_payment_assignment_audits WHERE pledge_activity_id = ? AND user_id = ? AND decision_type='apply_to_pledge' AND applied_cents > 0").all(candidate.id, userId).map((r) => r.applied_cents);
    const plan = db.prepare("SELECT installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at FROM pledge_payment_plans WHERE pledge_activity_id = ? AND user_id = ? AND ended_at IS NULL").get(candidate.id, userId);
    const { hasPlan, isOnTrack } = evaluateOpenPledgePlanStatus(plan, linkedDates, linkedAmounts, candidate.balance_cents, NOW, TZ);
    const ageDays = candidate.activity_date !== null ? Math.floor((NOW - candidate.activity_date) / 86400) : null;
    if (isOpenPledgeActionable(hasPlan, isOnTrack, ageDays)) { chosen = candidate; break; }
  }
  return chosen;
}

// ================================================================
// 1-2. Two open pledges: one with an active, on-track monthly plan; one
// with a manually corrected outstanding balance. The correction must be
// what determines whether the SECOND pledge needs follow-up -- not the
// raw imported balance.
// ================================================================

test("1-2. a manually corrected balance (not the raw imported one) determines whether the second, plan-less pledge needs follow-up, independently of the first pledge's own on-track plan", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d1", displayName: "Mr. & Mrs. Correction Fixture", donorCode: "90101" });

  // Pledge A: active, genuinely on-track monthly plan (real linked payment).
  seedPledge(db, { id: "pA", donorId: "d1", committedCents: dollars(12000), paidCents: dollars(1000), balanceCents: dollars(11000), activityDate: utcMidnight(2026, 8, 11), category: "partially_paid_pledge", sourceCampaign: "KOLX-FIXTURE" });
  seedPlan(db, { id: "planA", donorId: "d1", pledgeActivityId: "pA", installmentAmountCents: dollars(1000), nextExpectedPaymentAt: utcMidnight(2026, 10, 23), finalExpectedPaymentAt: utcMidnight(2027, 8, 23) });
  seedPayment(db, { pledgeActivityId: "pA", donorId: "d1", paymentDate: utcMidnight(2026, 9, 23), appliedCents: dollars(1000) });

  // Pledge B: no plan, imported balance ($100 of $1,000 = 10% remaining)
  // would be "near-complete" and NOT follow-up eligible on its own --
  // old enough (300 days) to otherwise qualify as stale once it IS
  // eligible by remaining ratio.
  seedPledge(db, { id: "pB", donorId: "d1", committedCents: dollars(1000), paidCents: dollars(900), balanceCents: dollars(100), activityDate: NOW - 300 * 86400, category: "partially_paid_pledge", sourceCampaign: "CORRECTED-FIXTURE" });

  // Before any correction: pledge B's raw imported balance (10% of total)
  // is near-complete -- must NOT generate a follow-up yet.
  {
    const { signalsByDonor } = runPipeline(db);
    const signal = signalsByDonor.get("d1").find((s) => s.situationType === "pledge_follow_up") ?? null;
    assert.equal(signal, null, "pledge B's raw imported balance (10% remaining) is near-complete -- must not yet be follow-up eligible");
  }

  // A correction RAISES pledge B's effective balance to $600 of $1,000
  // (60% remaining) -- a real donor-facing reason a fundraiser would
  // apply a correction (e.g. a JL import under-reported what's still
  // owed). This must now make pledge B follow-up eligible, using the
  // CORRECTED value, never the original $100.
  attemptCorrect(db, { pledgeActivityId: "pB", correctedBalanceCents: dollars(600), reason: "JL export under-reported the true outstanding balance" });

  const { donorInputs, signalsByDonor } = runPipeline(db);
  const donorInput = donorInputs.find((d) => d.donorId === "d1");
  const pledgeBEvidence = donorInput.openPledges.find((p) => p.campaign === "CORRECTED-FIXTURE");
  assert.equal(pledgeBEvidence.balanceCents, dollars(600), "the aggregation layer must use the CORRECTED effective balance, never the raw imported $100");

  const signals = signalsByDonor.get("d1");
  const pledgeSignals = signals.filter((s) => s.situationType === "pledge_follow_up");
  assert.equal(pledgeSignals.length, 1, "exactly one pledge_follow_up signal -- no duplicate, no contradiction (requirement 6)");
  assert.match(pledgeSignals[0].headline, /CORRECTED-FIXTURE has gone stale/, "the corrected pledge must now be correctly flagged, specifically named");
  assert.match(pledgeSignals[0].explanation, /KOLX-FIXTURE payment plan is on track/, "pledge A's own on-track plan must be preserved in the explanation, never affected by pledge B's correction (requirement 4)");
});

// ================================================================
// 3. A correction reducing a pledge's effective balance to ZERO must
// prevent that pledge from generating any open-pledge recommendation
// at all -- even though it would otherwise be old enough to qualify.
// ================================================================

test("3. correcting a pledge's balance to $0 removes it from follow-up consideration entirely, even though it would otherwise be old and stale", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d2", displayName: "Mr. & Mrs. Zeroed Correction", donorCode: "90102" });
  seedPledge(db, { id: "pC", donorId: "d2", committedCents: dollars(500), paidCents: dollars(0), balanceCents: dollars(500), activityDate: NOW - 400 * 86400, category: "open_pledge", sourceCampaign: "ZEROED-FIXTURE" });

  // Before correction: genuinely old, no plan -- must be flagged stale.
  {
    const { signalsByDonor } = runPipeline(db);
    const signal = signalsByDonor.get("d2").find((s) => s.situationType === "pledge_follow_up") ?? null;
    assert.ok(signal, "before any correction, this old plan-less pledge must be flagged stale");
    assert.match(signal.headline, /ZEROED-FIXTURE/);
  }

  attemptCorrect(db, { pledgeActivityId: "pC", correctedBalanceCents: 0, reason: "Payment was recorded under a different household and is now reconciled" });

  const { donorInputs, signalsByDonor } = runPipeline(db);
  const donorInput = donorInputs.find((d) => d.donorId === "d2");
  assert.equal(donorInput.openPledges.length, 0, "a pledge corrected to $0 must not even appear in openPledges -- it is no longer an open pledge at all");
  const signal = signalsByDonor.get("d2").find((s) => s.situationType === "pledge_follow_up") ?? null;
  assert.equal(signal, null, "a pledge corrected to $0 must never generate an open-pledge recommendation, however old its raw imported balance was");
});

// ================================================================
// 4. A corrected pledge must never incorrectly affect a DIFFERENT
// pledge belonging to the SAME donor (explicit, dedicated proof --
// case 1-2 above already demonstrates this implicitly via the
// preserved on-track explanation; this proves it from the other
// direction: correcting the STALE pledge must never make the ON-TRACK
// pledge's own plan evaluation change).
// ================================================================

test("4. correcting one pledge's balance never changes a sibling pledge's own independent plan evaluation", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d3", displayName: "Mr. & Mrs. Sibling Isolation", donorCode: "90103" });
  seedPledge(db, { id: "pD", donorId: "d3", committedCents: dollars(12000), paidCents: dollars(1000), balanceCents: dollars(11000), activityDate: utcMidnight(2026, 8, 11), category: "partially_paid_pledge", sourceCampaign: "SIBLING-PLAN" });
  seedPlan(db, { id: "planD", donorId: "d3", pledgeActivityId: "pD", installmentAmountCents: dollars(1000), nextExpectedPaymentAt: utcMidnight(2026, 10, 23), finalExpectedPaymentAt: utcMidnight(2027, 8, 23) });
  seedPayment(db, { pledgeActivityId: "pD", donorId: "d3", paymentDate: utcMidnight(2026, 9, 23), appliedCents: dollars(1000) });
  seedPledge(db, { id: "pE", donorId: "d3", committedCents: dollars(800), paidCents: dollars(0), balanceCents: dollars(800), activityDate: NOW - 300 * 86400, category: "open_pledge", sourceCampaign: "SIBLING-STALE" });

  const before = runPipeline(db).donorInputs.find((d) => d.donorId === "d3").openPledges.find((p) => p.campaign === "SIBLING-PLAN");

  attemptCorrect(db, { pledgeActivityId: "pE", correctedBalanceCents: dollars(1), reason: "Nearly fully paid, awaiting final cents reconciliation" });

  const after = runPipeline(db).donorInputs.find((d) => d.donorId === "d3").openPledges.find((p) => p.campaign === "SIBLING-PLAN");
  assert.deepEqual(after, before, "pledge D's own evidence (balance, plan status, age) must be byte-identical before and after a correction applied to the unrelated sibling pledge E");
});

// ================================================================
// 5. Donor page / Fundraising Intelligence Brief / Workspace
// recommendations consistency, with a corrected balance in the mix.
// ================================================================

test("5. the donor-page-style single-pledge selection and Fundraising Intelligence Brief agree about which pledge matters, even with a corrected balance", () => {
  const db = freshDatabase();
  seedUser(db);
  seedDonor(db, { id: "d4", displayName: "Mr. & Mrs. Consistency Fixture", donorCode: "90104" });
  seedPledge(db, { id: "pF", donorId: "d4", committedCents: dollars(12000), paidCents: dollars(1000), balanceCents: dollars(11000), activityDate: utcMidnight(2026, 8, 11), category: "partially_paid_pledge", sourceCampaign: "CONSISTENT-PLAN" });
  seedPlan(db, { id: "planF", donorId: "d4", pledgeActivityId: "pF", installmentAmountCents: dollars(1000), nextExpectedPaymentAt: utcMidnight(2026, 10, 23), finalExpectedPaymentAt: utcMidnight(2027, 8, 23) });
  seedPayment(db, { pledgeActivityId: "pF", donorId: "d4", paymentDate: utcMidnight(2026, 9, 23), appliedCents: dollars(1000) });
  seedPledge(db, { id: "pG", donorId: "d4", committedCents: dollars(1000), paidCents: dollars(950), balanceCents: dollars(50), activityDate: NOW - 300 * 86400, category: "partially_paid_pledge", sourceCampaign: "CONSISTENT-CORRECTED" });
  attemptCorrect(db, { pledgeActivityId: "pG", correctedBalanceCents: dollars(400), reason: "Outstanding balance was understated in the last JL export" });

  const { signalsByDonor } = runPipeline(db);
  const briefSignal = signalsByDonor.get("d4").find((s) => s.situationType === "pledge_follow_up") ?? null;
  assert.match(briefSignal.headline, /CONSISTENT-CORRECTED/, "Fundraising Intelligence Brief names the corrected, genuinely-actionable pledge");

  const candidates = queryGiving(db).filter((g) => g.donor_id === "d4" && g.balance_cents > 0);
  const selected = selectMostActionablePledge(db, "u1", candidates);
  assert.equal(selected.source_campaign, "CONSISTENT-CORRECTED", "the donor-page/SUGGESTED-section selection logic picks the SAME corrected, actionable pledge Fundraising Intelligence Brief named -- no cross-surface disagreement");
});
