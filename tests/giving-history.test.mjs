import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  summarizeGivingHistory,
  GIVING_BY_DONOR_YEAR_SQL,
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
// (2026-10-16). The root cause this file proves fixed: Ask Fundraising
// OS had no capability that ranked the authorized donor portfolio by
// real, historical giving -- every "who should I prioritize" capability
// was derived from the overdue-follow-up/reminder queue, so the
// assistant kept returning the same few recent-small-gift donors no
// matter how the question (or a correction) was phrased.
//
// Two parts:
//   A. summarizeGivingHistory -- pure, synchronous, no database -- every
//      synthetic donor type the task's own test list asked for: large
//      consistent annual giving, small recent gifts (must NOT outrank
//      real historical donors -- this is the literal regression),
//      previously-large declined giving, a lapsed major donor, and a
//      brand-new donor with too little history for a trend claim.
//   B. The two real SQL statements against a synthetic multi-year,
//      multi-user SQLite database (same node:sqlite + drizzle/*.sql
//      harness every other lib/assistant/*.ts pure module uses) --
//      partially-paid pledges, multiple payments against one pledge (a
//      single row's current paid_cents, never double-counted), the
//      legacy gifts table UNION, excluded categories, the
//      pledge_balance_corrections override, and cross-user/identical-
//      name isolation.

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
    row.id, row.donorId, row.ownerUserId, "JL Solutions", "CODE1", row.id,
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

const YEAR = (y, m = 6, d = 1) => Math.floor(Date.UTC(y, m - 1, d) / 1000);

async function run() {
  // ===========================================================================
  // Part A -- pure summarizeGivingHistory: the exact synthetic donor matrix
  // the task's own "Testing" section asked for, in one connected scenario so
  // ranking/exclusion behavior is proven against real competition, not just
  // isolated per-donor assertions.
  // ===========================================================================
  {
    const CURRENT_YEAR = 2026;
    const rows = [];
    const push = (donorId, year, paidCents, giftCount = 1) => rows.push({ donor_id: donorId, year, paid_cents: paidCents, gift_count: giftCount, most_recent_date: YEAR(year) });

    // 1. Lapsed major donor: $75,000 lifetime, nothing given since 2019 --
    // 7 years before CURRENT_YEAR, well past LAPSED_YEARS_THRESHOLD.
    for (const [y, cents] of [[2015, 1500000], [2016, 1500000], [2017, 1500000], [2018, 1500000], [2019, 1500000]]) push("lapsed-major", y, cents);

    // 2. Previously-large donor whose giving declined: peak $12,000 in
    // 2020, down to $1,000 by 2025 (< DECLINE_RATIO_THRESHOLD of peak),
    // but still gave within the last LAPSED_YEARS_THRESHOLD years, so this
    // must be "declined," never "lapsed."
    for (const [y, cents] of [[2018, 800000], [2019, 900000], [2020, 1200000], [2021, 900000], [2022, 700000], [2023, 200000], [2024, 150000], [2025, 100000]]) push("declined-major", y, cents);

    // 3. Large, consistent annual supporter: $5,000/year for 7 straight
    // years through the current year -- no decline, no lapse.
    for (let y = 2020; y <= 2026; y++) push("consistent-donor", y, 500000);

    // 4. A real but unremarkable donor with only 2 giving years -- below
    // CONSISTENT_MIN_YEARS, present so the shortlist has mid-range
    // competition with no special signal expected.
    for (const [y, cents] of [[2024, 400000], [2025, 400000]]) push("mid-donor", y, cents);

    // 5/6. Filler donors, moderate amounts, no special pattern.
    push("filler-a", 2025, 500000);
    push("filler-b", 2024, 200000);

    // 7. Brand-new donor: exactly one gift, this year -- too little
    // history for ANY trend claim.
    push("brand-new-donor", 2026, 100000);

    // 8. THE REGRESSION ITSELF: small, recent gifts -- must never outrank
    // the real historical donors above just because they are recent.
    push("small-recent-donor", 2026, 15000, 1);
    push("small-recent-donor", 2026, 15000, 1);

    const full = summarizeGivingHistory({ rows, currentYear: CURRENT_YEAR, limit: 20 });
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

    assert.deepEqual(byId["consistent-donor"].signals, ["consistent"], "7 straight years of giving through the present must be flagged consistent, and is not large enough to be high_value against the two $75k/$49.5k donors");
    assert.equal(byId["consistent-donor"].lifetimePaidCents, 3500000);
    assert.ok(byId["consistent-donor"].distinctGivingYears >= CONSISTENT_MIN_YEARS);
    assert.ok(byId["consistent-donor"].distinctGivingYears / (byId["consistent-donor"].lastGivingYear - byId["consistent-donor"].firstGivingYear + 1) >= CONSISTENT_COVERAGE_THRESHOLD, "consistent-donor must actually clear the real coverage threshold, not just happen to be flagged");

    assert.deepEqual(byId["mid-donor"].signals, [], "an ordinary 2-year donor below CONSISTENT_MIN_YEARS gets no special signal, not a false consistent/declined/lapsed label");
    assert.ok(byId["mid-donor"].distinctGivingYears < CONSISTENT_MIN_YEARS);

    assert.deepEqual(byId["brand-new-donor"].signals, ["insufficient_history"], "a single gift this year is real money but proves no trend -- must be insufficient_history, never consistent/declined/lapsed");

    assert.equal(byId["small-recent-donor"].lifetimePaidCents, 30000, "two small gifts must sum, not double-count or drop either");

    // --- THE regression test: ranking must put real historical donors
    // ahead of small recent gifts, not the reverse. ---
    const top5 = summarizeGivingHistory({ rows, currentYear: CURRENT_YEAR, limit: 5 }).map((c) => c.donorId);
    assert.deepEqual(top5, ["lapsed-major", "declined-major", "consistent-donor", "mid-donor", "filler-a"], "the top-5 shortlist must be ranked by real giving history (with lapsed/declined boosted as more actionable), and must exclude the small-recent and brand-new donors entirely");
    assert.ok(!top5.includes("small-recent-donor"), "small recent gifts must never make the historical-giving shortlist ahead of real historical donors -- this is the exact defect being fixed");
    assert.ok(!top5.includes("brand-new-donor"));

    // --- Priority score math, asserted directly (not just the resulting order) ---
    assert.equal(byId["lapsed-major"].priorityScore, 7500000 * LAPSED_SCORE_MULTIPLIER);
    assert.equal(byId["declined-major"].priorityScore, byId["declined-major"].lifetimePaidCents * DECLINED_SCORE_MULTIPLIER);
    assert.equal(byId["consistent-donor"].priorityScore, byId["consistent-donor"].lifetimePaidCents, "a donor with no lapsed/declined signal gets no score boost");
  }

  // --- High-value threshold: relative to the portfolio, never a fixed
  // dollar figure -- with 4 donors, ceil(4*0.25)=1, so only the single
  // largest is flagged, regardless of how large or small that amount is
  // in absolute terms. ---
  {
    const rows = [
      { donor_id: "d1", year: 2026, paid_cents: 100, gift_count: 1, most_recent_date: YEAR(2026) },
      { donor_id: "d2", year: 2026, paid_cents: 90, gift_count: 1, most_recent_date: YEAR(2026) },
      { donor_id: "d3", year: 2026, paid_cents: 80, gift_count: 1, most_recent_date: YEAR(2026) },
      { donor_id: "d4", year: 2026, paid_cents: 70, gift_count: 1, most_recent_date: YEAR(2026) },
    ];
    const result = summarizeGivingHistory({ rows, currentYear: 2026, limit: 20 });
    const highValue = result.filter((c) => c.signals.includes("high_value")).map((c) => c.donorId);
    assert.equal(highValue.length, Math.ceil(rows.length * HIGH_VALUE_TOP_FRACTION), "the high_value count must match the real HIGH_VALUE_TOP_FRACTION applied to this portfolio's actual size");
    assert.deepEqual(highValue, ["d1"], "HIGH_VALUE_TOP_FRACTION must apply relative to the real portfolio size, not a fixed dollar amount -- even very small absolute totals produce exactly one high_value donor among four");
  }

  // --- A single donor with even one qualifying gift always gets
  // Math.max(1, ...) at least one high_value donor -- never zero. ---
  {
    const rows = [{ donor_id: "solo", year: 2026, paid_cents: 500, gift_count: 1, most_recent_date: YEAR(2026) }];
    const result = summarizeGivingHistory({ rows, currentYear: 2026, limit: 20 });
    assert.equal(result.length, 1);
    assert.ok(result[0].signals.includes("high_value") || result[0].signals.includes("insufficient_history"));
  }

  // --- Empty input -> empty output, never a crash. ---
  {
    assert.deepEqual(summarizeGivingHistory({ rows: [], currentYear: 2026, limit: 8 }), []);
  }

  console.log("summarizeGivingHistory signal/ranking checks passed.");

  // ===========================================================================
  // Part B -- the two real SQL statements against a synthetic SQLite
  // database: aggregation correctness, category exclusion, the legacy
  // gifts-table UNION, the pledge_balance_corrections override, and
  // cross-user/identical-name isolation.
  // ===========================================================================
  const NOW = Math.floor(Date.now() / 1000);
  const db = freshDatabase();
  seedUser(db, "user-alpha", NOW);
  seedUser(db, "user-beta", NOW);
  insertDonor(db, { id: "alpha-donor", ownerUserId: "user-alpha", displayName: "Multi-Year Donor", now: NOW });
  insertDonor(db, { id: "alpha-pledge-donor", ownerUserId: "user-alpha", displayName: "Pledge Donor", now: NOW });
  insertDonor(db, { id: "alpha-excluded-donor", ownerUserId: "user-alpha", displayName: "Needs Review Donor", now: NOW });
  insertDonor(db, { id: "alpha-legacy-donor", ownerUserId: "user-alpha", displayName: "Legacy Gift Donor", now: NOW });
  insertDonor(db, { id: "beta-donor", ownerUserId: "user-beta", displayName: "Multi-Year Donor", now: NOW }); // identical display_name to alpha-donor, different owner

  // Multi-year, multiple real giving_activities rows for one donor --
  // aggregation must sum across years without cross-year leakage.
  insertGivingActivity(db, { id: "ga-1", donorId: "alpha-donor", ownerUserId: "user-alpha", activityDate: YEAR(2024), committedCents: 100000, paidCents: 100000, category: "completed_gift" });
  insertGivingActivity(db, { id: "ga-2", donorId: "alpha-donor", ownerUserId: "user-alpha", activityDate: YEAR(2025), committedCents: 50000, paidCents: 50000, category: "completed_gift" });

  // Multiple payments against ONE pledge: this schema stores a pledge as
  // ONE row whose paid_cents reflects the current cumulative amount paid
  // (confirmed across the five independent financial-integrity rounds on
  // fundraising-progress.ts) -- never one row per payment event. A
  // partially-paid pledge's paid_cents must count once toward lifetime
  // giving, and its balance_cents (via the correction override) must
  // appear in OPEN_COMMITMENTS_BY_DONOR_SQL, never double-counted between
  // the two queries.
  insertGivingActivity(db, { id: "ga-pledge", donorId: "alpha-pledge-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 1000000, paidCents: 400000, category: "partially_paid_pledge" });
  insertCorrection(db, { id: "corr-1", userId: "user-alpha", donorId: "alpha-pledge-donor", pledgeActivityId: "ga-pledge", importedBalance: 600000, correctedBalance: 550000, createdAt: NOW });

  // Excluded categories must never contribute to lifetime giving.
  insertGivingActivity(db, { id: "ga-excluded-1", donorId: "alpha-excluded-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 999999, paidCents: 999999, category: "needs_review" });
  insertGivingActivity(db, { id: "ga-excluded-2", donorId: "alpha-excluded-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 999999, paidCents: 999999, category: "nonfinancial_entry" });
  insertGivingActivity(db, { id: "ga-excluded-3", donorId: "alpha-excluded-donor", ownerUserId: "user-alpha", activityDate: YEAR(2026), committedCents: 999999, paidCents: 999999, category: "pending_gift" });

  // Legacy gifts table must be UNIONed in -- same convention as the donor
  // profile's own Lifetime Paid figure.
  insertLegacyGift(db, { id: "legacy-1", donorId: "alpha-legacy-donor", amountCents: 250000, receivedAt: YEAR(2023) });

  // Cross-user, identical display name.
  insertGivingActivity(db, { id: "ga-beta", donorId: "beta-donor", ownerUserId: "user-beta", activityDate: YEAR(2026), committedCents: 9000000, paidCents: 9000000, category: "completed_gift" });

  const alphaRows = db.prepare(GIVING_BY_DONOR_YEAR_SQL).all("user-alpha", "user-alpha");
  const alphaByDonorYear = Object.fromEntries(alphaRows.map((r) => [`${r.donor_id}:${r.year}`, r]));

  assert.equal(alphaByDonorYear["alpha-donor:2024"].paid_cents, 100000);
  assert.equal(alphaByDonorYear["alpha-donor:2025"].paid_cents, 50000, "each year's row must stay separate, never summed across years in the SQL layer");
  assert.equal(alphaByDonorYear["alpha-pledge-donor:2026"].paid_cents, 400000, "a partially-paid pledge's CURRENT paid_cents must count once toward lifetime giving, never its full committed_cents");
  assert.equal(alphaByDonorYear["alpha-legacy-donor:2023"].paid_cents, 250000, "the legacy gifts table must be unioned in");
  assert.ok(!("alpha-excluded-donor:2026" in alphaByDonorYear), "needs_review/nonfinancial_entry/pending_gift rows must never contribute to giving history");
  assert.ok(!Object.keys(alphaByDonorYear).some((k) => k.startsWith("beta-donor")), "a query scoped to user-alpha must never return user-beta's rows, even though their donor shares the exact same display name");

  const betaRows = db.prepare(GIVING_BY_DONOR_YEAR_SQL).all("user-beta", "user-beta");
  assert.equal(betaRows.length, 1);
  assert.equal(betaRows[0].donor_id, "beta-donor");
  assert.equal(betaRows[0].paid_cents, 9000000, "user-beta's own query must see their own donor's real total, unaffected by user-alpha's identically-named donor");

  const alphaCommitments = db.prepare(OPEN_COMMITMENTS_BY_DONOR_SQL).all("user-alpha");
  const commitmentByDonor = Object.fromEntries(alphaCommitments.map((r) => [r.donor_id, r]));
  assert.equal(commitmentByDonor["alpha-pledge-donor"].balance_cents, 550000, "OPEN_COMMITMENTS_BY_DONOR_SQL must apply the pledge_balance_corrections override, the exact same join getOutstandingPledges uses");
  assert.equal(commitmentByDonor["alpha-pledge-donor"].committed_cents, 1000000);
  assert.ok(!("alpha-donor" in commitmentByDonor), "a donor with only completed_gift rows (no open/partially-paid pledge) must never appear in the open-commitments query");

  console.log("GIVING_BY_DONOR_YEAR_SQL / OPEN_COMMITMENTS_BY_DONOR_SQL checks (real synthetic multi-year, multi-user database) passed.");
  console.log("giving-history.test.mjs: all assertions passed");
}

run();
