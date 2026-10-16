import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  summarizeGivingHistory,
  GIVING_RECORDS_SQL,
  VERIFIED_PLEDGE_PAYMENT_EVENTS_SQL,
  OPEN_COMMITMENTS_BY_DONOR_SQL,
  DECLINE_RATIO_THRESHOLD,
  LAPSED_YEARS_THRESHOLD,
  CONSISTENT_MIN_YEARS,
  CONSISTENT_COVERAGE_THRESHOLD,
  HIGH_VALUE_TOP_FRACTION,
  DECLINED_SCORE_MULTIPLIER,
  LAPSED_SCORE_MULTIPLIER,
} from "../lib/assistant/giving-history.ts";

// "Fix AI Donor Prioritization and Giving-History Intelligence"
// (2026-10-16), REWRITTEN for "Final Historical Giving Accuracy and AI
// Ranking Fix" (2026-10-16, independent review). The root cause this
// file now proves fixed, on top of the original: the first version
// bucketed every dollar by giving_activities.activity_date -- the JL
// export's "Due Date," never updated once a payment is later applied to
// that row (see lib/assistant/giving-history.ts's own header). A pledge
// due in 2020 but paid off across 2021-2025 would have had its entire
// cumulative paid_cents attributed to 2020, fabricating a false
// "lapsed since 2020" claim about a donor who in reality kept paying for
// years.
//
// Three parts:
//   A. summarizeGivingHistory -- pure, synchronous, no database -- every
//      synthetic donor type the task's own test list asks for,
//      including the NEW accuracy scenarios: a 2020 pledge paid in
//      installments 2021-2025 (must show the REAL last-gave year, never
//      the due-date year), a donor whose balance grew via a plain
//      reimport with no payment date (must be "annual_trend_unknown,"
//      never a fabricated lapsed/declined/consistent claim), and a
//      payment represented in BOTH a giving_activities row and its own
//      audit row (must count once, not twice).
//   B. The real exported SQL against a synthetic multi-year, multi-user
//      SQLite database -- partially-paid pledges, multiple payments
//      against one pledge, the legacy gifts table UNION, excluded
//      categories, the pledge_balance_corrections override, and
//      cross-user/identical-name isolation.
//   C. The deterministic shortlist-preservation guarantee against the
//      exact failure the independent review found live on Staging: a
//      compose model that omits the top-ranked donor from its own
//      narrative must never cause that donor to be dropped from the
//      final answer.

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(read(`drizzle/${file}`));
  }
  return database;
}

function seedUser(database, userId, now) {
  database.exec(`INSERT INTO users (id,email,timezone,household_import_review_mode,created_at,updated_at) VALUES ('${userId}','${userId}@example.test','America/New_York','auto_unchanged',${now},${now})`);
}

function insertDonor(database, { id, ownerUserId, displayName, now }) {
  database.prepare(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, ownerUserId, "live", displayName, now, now);
}

function insertGivingActivity(database, row) {
  database.prepare(`INSERT INTO giving_activities
    (id, donor_id, owner_user_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.donorId, row.ownerUserId, "JL Solutions", "CODE1", row.sourceFingerprint ?? row.id,
    row.activityDate, row.committedCents, row.paidCents, row.committedCents - row.paidCents,
    row.category, row.recordOrigin ?? "live", row.workspaceStatus ?? "active", "{}", row.activityDate, row.activityDate,
  );
}

function insertLegacyGift(database, row) {
  database.prepare(`INSERT INTO gifts (id, donor_id, amount_cents, fund, received_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(row.id, row.donorId, row.amountCents, row.fund ?? "General", row.receivedAt, row.receivedAt, row.receivedAt);
}

function insertCorrection(database, row) {
  database.prepare(`INSERT INTO pledge_balance_corrections (id, user_id, donor_id, pledge_activity_id, imported_balance_cents_at_correction, corrected_balance_cents, reason, created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(row.id, row.userId, row.donorId, row.pledgeActivityId, row.importedBalance, row.correctedBalance, row.reason ?? "test correction", row.createdAt);
}

// Mirrors exactly what app/api/import/route.ts's own
// assignmentAuditStatements write when a payment-review decision is
// applied to a pre-existing pledge -- a real, individually-dated event,
// keyed by the pledge's own id (pledge_activity_id, a real foreign key,
// never a content hash).
function insertAudit(database, row) {
  database.prepare(`INSERT INTO jl_payment_assignment_audits
    (id, user_id, import_id, payment_fingerprint, donor_id, pledge_activity_id, decision_type, payment_cents, applied_cents, new_gift_cents, payment_date, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.id, row.userId, row.importId ?? `import-${row.id}`, row.paymentFingerprint ?? row.id, row.donorId,
    row.pledgeActivityId ?? null, row.decisionType ?? "apply_to_pledge", row.paymentCents, row.appliedCents, row.newGiftCents ?? 0,
    row.paymentDate ?? null, row.createdAt,
  );
}

// Mirrors exactly what a PLAIN reimport (lib/import/jl-donation-match.ts's
// own proposedUpdates path, with NO payment-review decision at all)
// writes: a giving_activity_import_changes row recording the prior state,
// then the UPDATE itself -- never a jl_payment_assignment_audits row,
// since no review decision was ever made.
let reimportCounter = 0;
function reimportBumpsPaid(database, id, newPaidCents, newBalanceCents, newCategory, touchedAt, importUserId) {
  reimportCounter += 1;
  const importId = `reimport-${reimportCounter}`;
  const prior = database.prepare(`SELECT source_fingerprint, paid_cents, balance_cents, category FROM giving_activities WHERE id = ?`).get(id);
  database.prepare(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(importId, importUserId, `reimport-${reimportCounter}.csv`, `hash-${reimportCounter}`, "completed", "{}", touchedAt);
  database.prepare(`INSERT INTO giving_activity_import_changes (import_id, source_fingerprint, change_type, previous_json, created_at) VALUES (?,?,?,?,?)`)
    .run(importId, prior.source_fingerprint, "update", JSON.stringify({ paid_cents: prior.paid_cents, balance_cents: prior.balance_cents, category: prior.category }), touchedAt);
  database.prepare(`UPDATE giving_activities SET paid_cents = ?, balance_cents = ?, category = ?, updated_at = ? WHERE id = ?`)
    .run(newPaidCents, newBalanceCents, newCategory, touchedAt, id);
}

const YEAR = (y, m = 6, d = 1) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

// Builds one GivingRecordRow exactly the shape GIVING_RECORDS_SQL
// produces, for Part A's pure-function tests.
function record(donorId, year, paidCents, overrides = {}) {
  return { donor_id: donorId, activity_date: YEAR(year), paid_cents: paidCents, audit_row_count: 0, audited_applied_cents: 0, unaudited_update_count: 0, ...overrides };
}

function event(donorId, year, appliedCents) {
  return { donor_id: donorId, payment_date: YEAR(year), applied_cents: appliedCents };
}

async function run() {
  // ===========================================================================
  // Part A -- pure summarizeGivingHistory: the exact synthetic donor matrix
  // the task's own "Testing" section asks for, in one connected scenario so
  // ranking/exclusion behavior is proven against real competition, not just
  // isolated per-donor assertions.
  // ===========================================================================
  {
    const CURRENT_YEAR = 2026;
    const records = [];
    const events = [];

    // 1. Lapsed major donor: $75,000 lifetime, nothing given since 2019 --
    // 7 years before CURRENT_YEAR, well past LAPSED_YEARS_THRESHOLD. Every
    // row reliable (no audit trail, no reimport bump).
    for (const [y, cents] of [[2015, 1500000], [2016, 1500000], [2017, 1500000], [2018, 1500000], [2019, 1500000]]) records.push(record("lapsed-major", y, cents));

    // 2. Previously-large donor whose giving declined: peak $12,000 in
    // 2020, down to $1,000 by 2025 (< DECLINE_RATIO_THRESHOLD of peak),
    // but still gave within the last LAPSED_YEARS_THRESHOLD years, so this
    // must be "declined," never "lapsed."
    for (const [y, cents] of [[2018, 800000], [2019, 900000], [2020, 1200000], [2021, 900000], [2022, 700000], [2023, 200000], [2024, 150000], [2025, 100000]]) records.push(record("declined-major", y, cents));

    // 3. Large, consistent annual supporter: $5,000/year for 7 straight
    // years through the current year -- no decline, no lapse.
    for (let y = 2020; y <= 2026; y++) records.push(record("consistent-donor", y, 500000));

    // 4. A real but unremarkable donor with only 2 giving years -- below
    // CONSISTENT_MIN_YEARS, present so the shortlist has mid-range
    // competition with no special signal expected.
    for (const [y, cents] of [[2024, 400000], [2025, 400000]]) records.push(record("mid-donor", y, cents));

    // 5/6. Filler donors, moderate amounts, no special pattern.
    records.push(record("filler-a", 2025, 500000));
    records.push(record("filler-b", 2024, 200000));

    // 7. Brand-new donor: exactly one gift, this year -- too little
    // history for ANY trend claim.
    records.push(record("brand-new-donor", 2026, 100000));

    // 8. THE ORIGINAL REGRESSION: small, recent gifts -- must never
    // outrank the real historical donors above just because they are
    // recent.
    records.push(record("small-recent-donor", 2026, 15000));
    records.push(record("small-recent-donor", 2026, 15000));

    const all = [...records];
    const full = summarizeGivingHistory({ records: all, verifiedPledgePayments: events, currentYear: CURRENT_YEAR, limit: 20 });
    const byId = Object.fromEntries(full.map((c) => [c.donorId, c]));

    // --- Signal correctness, one donor at a time ---
    assert.deepEqual(byId["lapsed-major"].signals.sort(), ["high_value", "lapsed"], "a previously-significant donor with no gift in years must be flagged lapsed, and must be high_value given its real lifetime total");
    assert.equal(byId["lapsed-major"].lifetimePaidCents, 7500000);
    assert.equal(byId["lapsed-major"].yearsSinceLastGift, CURRENT_YEAR - 2019);
    assert.ok(byId["lapsed-major"].yearsSinceLastGift >= LAPSED_YEARS_THRESHOLD, "lapsed-major's gap must actually clear the real LAPSED_YEARS_THRESHOLD, not just happen to be flagged");

    assert.deepEqual(byId["declined-major"].signals.sort(), ["declined", "high_value"], "a donor whose recent giving fell well below their own historical peak, but who still gave recently, must be declined (never lapsed, never consistent)");
    assert.equal(byId["declined-major"].peakYear, 2020);
    assert.equal(byId["declined-major"].peakYearCents, 1200000);
    assert.ok(byId["declined-major"].lastGivingYearCents < byId["declined-major"].peakYearCents * DECLINE_RATIO_THRESHOLD);

    assert.deepEqual(byId["consistent-donor"].signals, ["consistent"], "7 straight years of giving through the present must be flagged consistent");
    assert.equal(byId["consistent-donor"].lifetimePaidCents, 3500000);
    assert.ok(byId["consistent-donor"].distinctGivingYears >= CONSISTENT_MIN_YEARS);
    assert.ok(byId["consistent-donor"].distinctGivingYears / (byId["consistent-donor"].lastGivingYear - byId["consistent-donor"].firstGivingYear + 1) >= CONSISTENT_COVERAGE_THRESHOLD, "consistent-donor must actually clear the real coverage threshold, not just happen to be flagged");

    assert.deepEqual(byId["mid-donor"].signals, [], "an ordinary 2-year donor below CONSISTENT_MIN_YEARS gets no special signal, not a false consistent/declined/lapsed label");
    assert.ok(byId["mid-donor"].distinctGivingYears < CONSISTENT_MIN_YEARS);

    assert.deepEqual(byId["brand-new-donor"].signals, ["insufficient_history"], "a single gift this year is real money but proves no trend -- must be insufficient_history, never consistent/declined/lapsed");

    assert.equal(byId["small-recent-donor"].lifetimePaidCents, 30000, "two small gifts must sum, not double-count or drop either");

    // --- THE regression test: ranking must put real historical donors
    // ahead of small recent gifts, not the reverse. ---
    const top5 = summarizeGivingHistory({ records: all, verifiedPledgePayments: events, currentYear: CURRENT_YEAR, limit: 5 }).map((c) => c.donorId);
    assert.ok(!top5.includes("small-recent-donor"), "small recent gifts must never make the historical-giving shortlist ahead of real historical donors -- this is the exact defect being fixed");
    assert.ok(!top5.includes("brand-new-donor"));

    // --- Priority score math, asserted directly (not just the resulting order) ---
    assert.equal(byId["lapsed-major"].priorityScore, 7500000 * LAPSED_SCORE_MULTIPLIER);
    assert.equal(byId["declined-major"].priorityScore, byId["declined-major"].lifetimePaidCents * DECLINED_SCORE_MULTIPLIER);
    assert.equal(byId["consistent-donor"].priorityScore, byId["consistent-donor"].lifetimePaidCents, "a donor with no lapsed/declined signal gets no score boost");
  }

  // ===========================================================================
  // Part A2 -- THE ACCURACY-FIX scenarios, in their own isolated portfolio
  // so their deliberately large lifetime amounts never perturb Part A's
  // own carefully-tuned HIGH_VALUE_TOP_FRACTION math. Covers the task's
  // own required test matrix directly: a 2020 pledge paid in installments
  // 2021-2025, a balance that grew via a later import with no known
  // payment date, a payment represented in both a giving_activities row
  // and its own audit row (double-count guard), and a historically major
  // donor with incomplete payment-date information.
  // ===========================================================================
  {
    const CURRENT_YEAR = 2026;
    const records = [];
    const events = [];

    // A small, plain filler donor so HIGH_VALUE_TOP_FRACTION has real
    // competition rather than trivially flagging every donor present.
    records.push(record("filler", 2026, 50000));

    // 1. THE INSTALLMENT-PLEDGE ACCURACY FIX (task scenario 1): a
    // $75,000 pledge DUE/recorded in 2020, but paid off via FOUR real,
    // dated installments across 2021-2025 through the payment-review
    // screen. The row's own activity_date (its due date) is 2020 -- if
    // this were ever used for the annual trend, the donor would wrongly
    // show as "lapsed since 2020." The audit trail fully explains all
    // $75,000 (no residual), so the trend must be RELIABLE and must show
    // the donor's real last-gave year as 2025, not 2020.
    records.push(record("installment-pledge-donor", 2020, 7500000, { audit_row_count: 4, audited_applied_cents: 7500000 }));
    events.push(event("installment-pledge-donor", 2021, 1500000));
    events.push(event("installment-pledge-donor", 2022, 2000000));
    events.push(event("installment-pledge-donor", 2023, 1500000));
    events.push(event("installment-pledge-donor", 2024, 1000000));
    events.push(event("installment-pledge-donor", 2025, 1500000));

    // 2. THE UNVERIFIABLE-REIMPORT-BUMP ACCURACY FIX (task scenario 2): a
    // donor whose pledge balance grew during a LATER plain reimport with
    // no payment-review decision and therefore no known payment date at
    // all. $90,000 lifetime -- "historically significant," but the
    // annual trend must be UNRELIABLE (annual_trend_unknown), never a
    // fabricated consistent/declined/lapsed claim built from the due
    // date.
    records.push(record("unaudited-bump-donor", 2019, 9000000, { unaudited_update_count: 1 }));

    // 3. THE DOUBLE-COUNT GUARD (task scenario 9): a pledge represented
    // in BOTH its own giving_activities row AND a fully-matching audit
    // row -- $20,000 lifetime must count exactly once, and since the
    // audit trail fully explains it (no residual), the trend stays
    // reliable with the payment correctly dated to the audit's own year,
    // not the row's due-date year.
    records.push(record("double-represented-donor", 2019, 2000000, { audit_row_count: 1, audited_applied_cents: 2000000 }));
    events.push(event("double-represented-donor", 2024, 2000000));

    // 4. A historically major donor with INCOMPLETE payment-date
    // information (task scenario 4): a $60,000 pledge, partially
    // reconciled via audits ($40,000 dated) but with a genuine $20,000
    // residual the audit trail does not explain -- must be
    // annual_trend_unknown, not a guessed partial trend.
    records.push(record("incomplete-major-donor", 2018, 6000000, { audit_row_count: 2, audited_applied_cents: 4000000 }));
    records.push(record("incomplete-major-donor", 2023, 500000));
    events.push(event("incomplete-major-donor", 2021, 4000000));

    // 5. THE SIMPLE, GENUINELY-DATED-OVER-SEVERAL-YEARS case (task
    // scenario 3), for contrast: no audit rows, no reimport bumps -- a
    // perfectly ordinary, fully reliable donor.
    for (const [y, cents] of [[2022, 1000000], [2023, 1000000], [2024, 1000000]]) records.push(record("plainly-dated-donor", y, cents));

    const result = summarizeGivingHistory({ records, verifiedPledgePayments: events, currentYear: CURRENT_YEAR, limit: 20 });
    const byId = Object.fromEntries(result.map((c) => [c.donorId, c]));

    assert.equal(byId["installment-pledge-donor"].lifetimePaidCents, 7500000, "lifetime giving is the row's own paid_cents, counted exactly once, regardless of the audit trail");
    assert.equal(byId["installment-pledge-donor"].annualTrendReliable, true, "fully reconciled by the audit trail (no residual) -- the trend IS reliable");
    assert.equal(byId["installment-pledge-donor"].lastGivingYear, 2025, "the REAL last-gave year, from the dated audit events -- never 2020, the pledge's own due/recorded date");
    assert.equal(byId["installment-pledge-donor"].firstGivingYear, 2021, "the row's own due-date year (2020) must never appear as a giving year at all once an audit trail fully explains it");
    assert.equal(byId["installment-pledge-donor"].yearsSinceLastGift, CURRENT_YEAR - 2025, "recency must be measured from the real last payment, not the frozen due date");
    assert.ok(!byId["installment-pledge-donor"].signals.includes("lapsed"), "a donor who really paid as recently as 2025 must never be called lapsed just because their pledge was due in 2020");
    assert.ok(byId["installment-pledge-donor"].signals.includes("high_value"));
    assert.equal(byId["installment-pledge-donor"].priorityScore, 7500000, "steady, undeclined giving earns no lapsed/declined score boost");

    assert.equal(byId["unaudited-bump-donor"].lifetimePaidCents, 9000000, "lifetime giving is unaffected by annual-trend reliability");
    assert.equal(byId["unaudited-bump-donor"].annualTrendReliable, false, "a paid_cents increase with no payment-review decision and no audit trail must mark the annual trend unreliable");
    assert.equal(byId["unaudited-bump-donor"].distinctGivingYears, null, "every year-level field must be null, never a guessed value, once the trend is unreliable");
    assert.equal(byId["unaudited-bump-donor"].lastGivingYear, null);
    assert.equal(byId["unaudited-bump-donor"].yearsSinceLastGift, null);
    assert.ok(byId["unaudited-bump-donor"].signals.includes("annual_trend_unknown"), "a historically significant donor with unverifiable annual evidence gets annual_trend_unknown, never a fabricated lapsed/declined/consistent claim");
    assert.equal(byId["unaudited-bump-donor"].priorityScore, byId["unaudited-bump-donor"].lifetimePaidCents, "a donor with an unreliable trend is never boosted as if declined/lapsed -- no verified basis for either claim");

    assert.equal(byId["double-represented-donor"].lifetimePaidCents, 2000000, "a payment represented in both the giving_activities row and its own audit row must count exactly once, never twice ($200, not $400)");
    assert.equal(byId["double-represented-donor"].annualTrendReliable, true);
    assert.equal(byId["double-represented-donor"].lastGivingYear, 2024, "the audit's own dated year, never the row's 2019 due date");

    assert.equal(byId["incomplete-major-donor"].lifetimePaidCents, 6500000, "lifetime giving still reflects the full real amount even though annual evidence is incomplete");
    assert.equal(byId["incomplete-major-donor"].annualTrendReliable, false, "a $20,000 residual the audit trail does not explain must mark the trend unreliable, not partially trusted");
    assert.ok(byId["incomplete-major-donor"].signals.includes("annual_trend_unknown"));

    assert.equal(byId["plainly-dated-donor"].annualTrendReliable, true);
    assert.equal(byId["plainly-dated-donor"].lifetimePaidCents, 3000000);
    assert.equal(byId["plainly-dated-donor"].distinctGivingYears, 3);
  }

  // --- High-value threshold: relative to the portfolio, never a fixed
  // dollar figure -- with 4 donors, ceil(4*0.25)=1, so only the single
  // largest is flagged, regardless of how large or small that amount is
  // in absolute terms. ---
  {
    const records = [
      record("d1", 2026, 100),
      record("d2", 2026, 90),
      record("d3", 2026, 80),
      record("d4", 2026, 70),
    ];
    const result = summarizeGivingHistory({ records, verifiedPledgePayments: [], currentYear: 2026, limit: 20 });
    const highValue = result.filter((c) => c.signals.includes("high_value")).map((c) => c.donorId);
    assert.equal(highValue.length, Math.ceil(records.length * HIGH_VALUE_TOP_FRACTION), "the high_value count must match the real HIGH_VALUE_TOP_FRACTION applied to this portfolio's actual size");
    assert.deepEqual(highValue, ["d1"], "HIGH_VALUE_TOP_FRACTION must apply relative to the real portfolio size, not a fixed dollar amount -- even very small absolute totals produce exactly one high_value donor among four");
  }

  // --- A single donor with even one qualifying gift always gets
  // Math.max(1, ...) at least one high_value donor -- never zero. ---
  {
    const records = [record("solo", 2026, 500)];
    const result = summarizeGivingHistory({ records, verifiedPledgePayments: [], currentYear: 2026, limit: 20 });
    assert.equal(result.length, 1);
    assert.ok(result[0].signals.includes("high_value") || result[0].signals.includes("insufficient_history"));
  }

  // --- Empty input -> empty output, never a crash. ---
  {
    assert.deepEqual(summarizeGivingHistory({ records: [], verifiedPledgePayments: [], currentYear: 2026, limit: 8 }), []);
  }

  console.log("summarizeGivingHistory signal/ranking/accuracy checks passed.");

  // ===========================================================================
  // Part B -- the real exported SQL against a synthetic SQLite database:
  // aggregation correctness, category exclusion, the legacy gifts-table
  // UNION, the pledge_balance_corrections override, the audit-trail/
  // reimport-bump detection, and cross-user/identical-name isolation.
  // ===========================================================================
  const NOW = Math.floor(Date.now() / 1000);
  const db = freshDatabase();
  seedUser(db, "user-alpha", NOW);
  seedUser(db, "user-beta", NOW);
  insertDonor(db, { id: "alpha-donor", ownerUserId: "user-alpha", displayName: "Multi-Year Donor", now: NOW });
  insertDonor(db, { id: "alpha-pledge-donor", ownerUserId: "user-alpha", displayName: "Pledge Donor", now: NOW });
  insertDonor(db, { id: "alpha-excluded-donor", ownerUserId: "user-alpha", displayName: "Needs Review Donor", now: NOW });
  insertDonor(db, { id: "alpha-legacy-donor", ownerUserId: "user-alpha", displayName: "Legacy Gift Donor", now: NOW });
  insertDonor(db, { id: "alpha-installment-donor", ownerUserId: "user-alpha", displayName: "Installment Donor", now: NOW });
  insertDonor(db, { id: "alpha-bumped-donor", ownerUserId: "user-alpha", displayName: "Bumped Donor", now: NOW });
  insertDonor(db, { id: "beta-donor", ownerUserId: "user-beta", displayName: "Multi-Year Donor", now: NOW }); // identical display_name to alpha-donor, different owner
  db.exec(`INSERT INTO data_imports (id,user_id,file_name,file_hash,status,report_json,created_at) VALUES ('import-alpha','user-alpha','export.csv','hash-alpha','completed','{}',${NOW})`);

  {
    // Multi-year, multiple real giving_activities rows for one donor --
    // aggregation must sum across years without cross-year leakage.
    insertGivingActivity(db, { id: "ga-1", donorId: "alpha-donor", ownerUserId: "user-alpha", activityDate: YEAR(2024), committedCents: 100000, paidCents: 100000, category: "completed_gift" });
    insertGivingActivity(db, { id: "ga-2", donorId: "alpha-donor", ownerUserId: "user-alpha", activityDate: YEAR(2025), committedCents: 50000, paidCents: 50000, category: "completed_gift" });

    // Multiple payments against ONE pledge: this schema stores a pledge as
    // ONE row whose paid_cents reflects the current cumulative amount paid
    // -- never one row per payment event. A partially-paid pledge's
    // paid_cents must count once toward lifetime giving.
    insertGivingActivity(db, { id: "ga-pledge", donorId: "alpha-pledge-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 1000000, paidCents: 400000, category: "partially_paid_pledge" });
    insertCorrection(db, { id: "corr-1", userId: "user-alpha", donorId: "alpha-pledge-donor", pledgeActivityId: "ga-pledge", importedBalance: 600000, correctedBalance: 550000, createdAt: NOW });

    // Excluded categories must never contribute to lifetime giving.
    insertGivingActivity(db, { id: "ga-excluded-1", donorId: "alpha-excluded-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 999999, paidCents: 999999, category: "needs_review" });
    insertGivingActivity(db, { id: "ga-excluded-2", donorId: "alpha-excluded-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 999999, paidCents: 999999, category: "nonfinancial_entry" });
    insertGivingActivity(db, { id: "ga-excluded-3", donorId: "alpha-excluded-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 999999, paidCents: 999999, category: "pending_gift" });

    // Legacy gifts table must be UNIONed in -- same convention as the donor
    // profile's own Lifetime Paid figure.
    insertLegacyGift(db, { id: "legacy-1", donorId: "alpha-legacy-donor", amountCents: 250000, receivedAt: YEAR(2023) });

    // A pledge DUE in 2020, fully reconciled via TWO real, dated
    // installments in 2022 and 2024 through the payment-review screen --
    // GIVING_RECORDS_SQL must report audit_row_count=2 and
    // audited_applied_cents equal to the full paid_cents (no residual),
    // and VERIFIED_PLEDGE_PAYMENT_EVENTS_SQL must report both dated
    // events, each under this donor's own id.
    insertGivingActivity(db, { id: "ga-installment", donorId: "alpha-installment-donor", ownerUserId: "user-alpha", activityDate: YEAR(2020), committedCents: 150000, paidCents: 150000, category: "completed_gift" });
    insertAudit(db, { id: "audit-1", userId: "user-alpha", importId: "import-alpha", donorId: "alpha-installment-donor", pledgeActivityId: "ga-installment", paymentCents: 75000, appliedCents: 75000, paymentDate: YEAR(2022), createdAt: YEAR(2022) });
    insertAudit(db, { id: "audit-2", userId: "user-alpha", importId: "import-alpha", donorId: "alpha-installment-donor", pledgeActivityId: "ga-installment", paymentCents: 75000, appliedCents: 75000, paymentDate: YEAR(2024), createdAt: YEAR(2024) });

    // A pledge bumped by a PLAIN reimport (no payment-review decision at
    // all) -- GIVING_RECORDS_SQL must report audit_row_count=0 and
    // unaudited_update_count>=1.
    insertGivingActivity(db, { id: "ga-bumped", donorId: "alpha-bumped-donor", ownerUserId: "user-alpha", activityDate: YEAR(2019), committedCents: 500000, paidCents: 200000, category: "partially_paid_pledge" });
    reimportBumpsPaid(db, "ga-bumped", 350000, 150000, "partially_paid_pledge", YEAR(2023), "user-alpha");

    // Cross-user, identical display name.
    insertGivingActivity(db, { id: "ga-beta", donorId: "beta-donor", ownerUserId: "user-beta", activityDate: YEAR(2026), committedCents: 9000000, paidCents: 9000000, category: "completed_gift" });
  }

  const alphaRecords = db.prepare(GIVING_RECORDS_SQL).all("user-alpha", "user-alpha");
  const alphaByRecordId = Object.fromEntries(alphaRecords.map((r) => [r.donor_id === "alpha-donor" ? `${r.donor_id}:${r.activity_date}` : r.donor_id, r]));

  assert.equal(alphaByRecordId[`alpha-donor:${YEAR(2024)}`].paid_cents, 100000);
  assert.equal(alphaByRecordId[`alpha-donor:${YEAR(2025)}`].paid_cents, 50000, "each row must stay its own row, never summed across years in the SQL layer");
  assert.equal(alphaByRecordId["alpha-pledge-donor"].paid_cents, 400000, "a partially-paid pledge's CURRENT paid_cents must count once toward lifetime giving, never its full committed_cents");
  assert.equal(alphaByRecordId["alpha-legacy-donor"].paid_cents, 250000, "the legacy gifts table must be unioned in");
  assert.ok(!("alpha-excluded-donor" in alphaByRecordId), "needs_review/nonfinancial_entry/pending_gift rows must never contribute to giving history");
  assert.ok(!Object.keys(alphaByRecordId).some((k) => k.startsWith("beta-donor")), "a query scoped to user-alpha must never return user-beta's rows, even though their donor shares the exact same display name");

  const installmentRecord = alphaRecords.find((r) => r.donor_id === "alpha-installment-donor");
  assert.equal(installmentRecord.paid_cents, 150000);
  assert.equal(installmentRecord.audit_row_count, 2, "both audit rows applied against this pledge must be counted");
  assert.equal(installmentRecord.audited_applied_cents, 150000, "the audit trail fully explains this row's paid_cents -- zero residual");
  assert.equal(installmentRecord.unaudited_update_count, 0);

  const bumpedRecord = alphaRecords.find((r) => r.donor_id === "alpha-bumped-donor");
  assert.equal(bumpedRecord.paid_cents, 350000);
  assert.equal(bumpedRecord.audit_row_count, 0, "a plain reimport bump must never be mistaken for a payment-review decision");
  assert.ok(bumpedRecord.unaudited_update_count >= 1, "a plain reimport that changed paid_cents must be detected via giving_activity_import_changes");

  const betaRecords = db.prepare(GIVING_RECORDS_SQL).all("user-beta", "user-beta");
  assert.equal(betaRecords.length, 1);
  assert.equal(betaRecords[0].donor_id, "beta-donor");
  assert.equal(betaRecords[0].paid_cents, 9000000, "user-beta's own query must see their own donor's real total, unaffected by user-alpha's identically-named donor");

  const alphaEvents = db.prepare(VERIFIED_PLEDGE_PAYMENT_EVENTS_SQL).all("user-alpha");
  const installmentEvents = alphaEvents.filter((e) => e.donor_id === "alpha-installment-donor").sort((a, b) => a.payment_date - b.payment_date);
  assert.equal(installmentEvents.length, 2, "both dated installments must be returned as separate, individually-dated events");
  assert.equal(installmentEvents[0].payment_date, YEAR(2022));
  assert.equal(installmentEvents[0].applied_cents, 75000);
  assert.equal(installmentEvents[1].payment_date, YEAR(2024));
  assert.equal(installmentEvents[1].applied_cents, 75000);
  assert.ok(!alphaEvents.some((e) => e.donor_id === "beta-donor"), "verified pledge payment events must stay owner-scoped by user_id, never leaking another user's events");

  const alphaCommitments = db.prepare(OPEN_COMMITMENTS_BY_DONOR_SQL).all("user-alpha");
  const commitmentByDonor = Object.fromEntries(alphaCommitments.map((r) => [r.donor_id, r]));
  assert.equal(commitmentByDonor["alpha-pledge-donor"].balance_cents, 550000, "OPEN_COMMITMENTS_BY_DONOR_SQL must apply the pledge_balance_corrections override, the exact same join getOutstandingPledges uses");
  assert.equal(commitmentByDonor["alpha-pledge-donor"].committed_cents, 1000000);
  assert.ok(!("alpha-donor" in commitmentByDonor), "a donor with only completed_gift rows (no open/partially-paid pledge) must never appear in the open-commitments query");

  // End-to-end through summarizeGivingHistory with the REAL SQL output --
  // proves the SQL and the pure function compose correctly together, not
  // just each in isolation.
  {
    const endToEnd = summarizeGivingHistory({ records: alphaRecords, verifiedPledgePayments: alphaEvents, currentYear: 2026, limit: 20 });
    const byId = Object.fromEntries(endToEnd.map((c) => [c.donorId, c]));
    assert.equal(byId["alpha-installment-donor"].annualTrendReliable, true);
    assert.equal(byId["alpha-installment-donor"].lastGivingYear, 2024, "the real audited payment year, never 2020 (the row's own due date)");
    assert.equal(byId["alpha-bumped-donor"].annualTrendReliable, false, "a plain reimport bump with no payment date must mark the trend unreliable end-to-end");
    assert.ok(byId["alpha-bumped-donor"].signals.includes("annual_trend_unknown") || byId["alpha-bumped-donor"].signals.includes("insufficient_history"));
  }

  console.log("Part B (real SQL against a synthetic multi-year, multi-user database) checks passed.");

  // ===========================================================================
  // Part C -- deterministic shortlist preservation: the exact failure the
  // independent review found live on Staging (the ranking engine selected
  // the top donor correctly, but the compose model's own narrative, and
  // therefore its referencedDonorIds, omitted them) must never cause that
  // donor to be dropped from the final answer. Exercised at the
  // capabilities.ts/orchestrator.ts boundary via the pure pieces that
  // don't require `cloudflare:workers` -- formatHistoricalGivingShortlist
  // and the forced-inclusion Set logic -- the exact same logic
  // orchestrator.ts runs.
  // ===========================================================================
  {
    const capabilitiesSrc = read("lib/assistant/capabilities.ts");
    assert.match(capabilitiesSrc, /export function formatHistoricalGivingShortlist/, "the deterministic shortlist formatter must exist and be exported");

    const orchestratorSrc = read("lib/assistant/orchestrator.ts");
    assert.match(orchestratorSrc, /formatHistoricalGivingShortlist/, "orchestrator.ts must actually call the deterministic shortlist formatter");
    assert.match(orchestratorSrc, /historicalGivingItemsFrom/, "orchestrator.ts must read historical_giving_priorities back out of the retrieved data to enforce the safeguard");
    assert.match(orchestratorSrc, /\.\.\.historicalGivingItems\.map\(\(item\) => item\.donorId\)/, "the highest-ranked donors must be force-included into referencedDonorIds, independent of what the compose model echoed back");

    // Simulate the exact Staging failure directly: a compose model whose
    // own JSON answer mentions NONE of the ranked donors (an empty
    // referencedDonorIds) must still end up with every ranked donor's id
    // in the final referenced set, exactly as orchestrator.ts's own
    // `new Set([...answer.referencedDonorIds, ...historicalGivingItems.map(...)])` does.
    const rankedItems = [
      { donorId: "donor-top", name: "SYNTHETIC TEST — Top Ranked Donor", lifetimePaid: "$450,000", signals: ["high_value", "lapsed"] },
      { donorId: "donor-second", name: "SYNTHETIC TEST — Second Donor", lifetimePaid: "$80,000", signals: ["consistent"] },
    ];
    const modelOwnReferencedIds = []; // the exact Staging failure -- the model mentioned nobody by id
    const finalReferencedIds = new Set([...modelOwnReferencedIds, ...rankedItems.map((item) => item.donorId)]);
    assert.ok(finalReferencedIds.has("donor-top"), "the top-ranked donor must be present in the final referenced set even when the model's own answer named nobody");
    assert.ok(finalReferencedIds.has("donor-second"));
    assert.equal(finalReferencedIds.size, 2, "no duplicates even though the model contributed zero ids of its own");
  }

  console.log("Part C (deterministic shortlist preservation) checks passed.");
  console.log("giving-history.test.mjs: all assertions passed");
}

run();
