import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isValidPledgeReviewStatus, summarizePledgeReviewProgress, buildPledgeReviewQueue } from "../lib/relationships/pledge-review.ts";

// Pledge payment-plan cleanup REVIEW persistence (migration 0038,
// pledge_payment_plan_reviews). Schema/constraint/upsert behavior is
// tested behaviorally against a real in-memory SQLite database built
// from every real drizzle/*.sql migration -- the same established
// pattern tests/asks.test.mjs uses. API-route-level concerns with no
// D1/env test harness in this repo (ownership re-verification against
// giving_activities, auth) are verified by reading the real, committed
// route source (app/api/pledge-payment-plan-reviews/[pledgeActivityId]/
// route.ts) -- same convention asks.test.mjs documents and follows.

const NOW = Math.floor(Date.parse("2026-10-07T12:00:00Z") / 1000);

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(fs.readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  return database;
}

function seedFixture(database) {
  database.exec(`INSERT INTO users (id,email,timezone,household_import_review_mode,created_at,updated_at) VALUES ('user-1','owner@example.test','America/New_York','auto_unchanged',${NOW},${NOW})`);
  database.exec(`INSERT INTO users (id,email,timezone,household_import_review_mode,created_at,updated_at) VALUES ('user-2','other@example.test','America/New_York','auto_unchanged',${NOW},${NOW})`);
  database.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('donor-a','user-1','live','Donor A',${NOW},${NOW})`);
  database.exec(`INSERT INTO donors (id,owner_user_id,data_source,display_name,created_at,updated_at) VALUES ('donor-b','user-2','live','Donor B',${NOW},${NOW})`);
  // One open pledge for user-1's donor-a.
  database.exec(`INSERT INTO giving_activities (id,donor_id,owner_user_id,external_source,external_household_id,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,category,record_origin,workspace_status,source_snapshot,created_at,updated_at)
    VALUES ('pledge-1','donor-a','user-1','JL Solutions','hh-1','fp-1',${NOW},10000,0,10000,'open_pledge','live','active','{}',${NOW},${NOW})`);
  // One pledge belonging to a DIFFERENT user (user-2), to prove cross-user rejection.
  database.exec(`INSERT INTO giving_activities (id,donor_id,owner_user_id,external_source,external_household_id,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,category,record_origin,workspace_status,source_snapshot,created_at,updated_at)
    VALUES ('pledge-2','donor-b','user-2','JL Solutions','hh-2','fp-2',${NOW},5000,0,5000,'open_pledge','live','active','{}',${NOW},${NOW})`);
}

// Mirrors the exact upsert statement in the real route
// (app/api/pledge-payment-plan-reviews/[pledgeActivityId]/route.ts) --
// kept in sync by hand since there is no D1/env test harness here (same
// documented limitation as asks.test.mjs).
function saveReview(database, { userId, pledgeActivityId, reviewStatus, now }) {
  database.prepare(`INSERT INTO pledge_payment_plan_reviews (id, user_id, pledge_activity_id, review_status, reviewed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, pledge_activity_id) DO UPDATE SET review_status = excluded.review_status, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at`)
    .run(crypto.randomUUID(), userId, pledgeActivityId, reviewStatus, now, now, now);
}
function clearReview(database, { userId, pledgeActivityId }) {
  database.prepare(`DELETE FROM pledge_payment_plan_reviews WHERE user_id = ? AND pledge_activity_id = ?`).run(userId, pledgeActivityId);
}
function readReview(database, { userId, pledgeActivityId }) {
  return database.prepare(`SELECT review_status FROM pledge_payment_plan_reviews WHERE user_id = ? AND pledge_activity_id = ?`).get(userId, pledgeActivityId) ?? null;
}
// Ownership check exactly mirroring the route's own ownedLivePledge().
function ownedLivePledge(database, { pledgeActivityId, userId }) {
  return database.prepare(`SELECT id FROM giving_activities WHERE id = ? AND owner_user_id = ? AND record_origin = 'live' LIMIT 1`).get(pledgeActivityId, userId) ?? null;
}

async function run() {
  // --- validation ---
  assert.equal(isValidPledgeReviewStatus("needs_payment_plan"), true);
  assert.equal(isValidPledgeReviewStatus("no_payment_plan_needed"), true);
  assert.equal(isValidPledgeReviewStatus("need_to_investigate"), true);
  assert.equal(isValidPledgeReviewStatus("unreviewed"), false, "unreviewed is never a stored value -- it is the absence of a row");
  assert.equal(isValidPledgeReviewStatus("needs_plan"), false, "an old/renamed value must not silently be accepted");
  assert.equal(isValidPledgeReviewStatus(undefined), false);
  assert.equal(isValidPledgeReviewStatus(123), false);
  console.log("Review-status validation checks passed.");

  // --- 1: unreviewed pledge initially has no review record ---
  {
    const database = freshDatabase();
    seedFixture(database);
    assert.equal(readReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" }), null);
  }

  // --- 2/3: save needs_payment_plan, then reload returns it ---
  {
    const database = freshDatabase();
    seedFixture(database);
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "needs_payment_plan", now: NOW });
    const row = readReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" });
    assert.ok(row);
    assert.equal(row.review_status, "needs_payment_plan");
  }

  // --- 4: save no_payment_plan_needed ---
  {
    const database = freshDatabase();
    seedFixture(database);
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "no_payment_plan_needed", now: NOW });
    assert.equal(readReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" }).review_status, "no_payment_plan_needed");
  }

  // --- 5: save need_to_investigate ---
  {
    const database = freshDatabase();
    seedFixture(database);
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "need_to_investigate", now: NOW });
    assert.equal(readReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" }).review_status, "need_to_investigate");
  }

  // --- 6/7: changing decision updates the existing row -- no duplicate rows ---
  {
    const database = freshDatabase();
    seedFixture(database);
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "need_to_investigate", now: NOW });
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "needs_payment_plan", now: NOW + 60 });
    const rows = database.prepare(`SELECT review_status FROM pledge_payment_plan_reviews WHERE user_id = ? AND pledge_activity_id = ?`).all("user-1", "pledge-1");
    assert.equal(rows.length, 1, "changing a decision must update the one existing row, never insert a second");
    assert.equal(rows[0].review_status, "needs_payment_plan");
  }

  // --- 8: the UNIQUE constraint itself prevents a duplicate (proves the
  // "no duplicates" guarantee is structural, not just app-level discipline) ---
  {
    const database = freshDatabase();
    seedFixture(database);
    database.exec(`INSERT INTO pledge_payment_plan_reviews (id,user_id,pledge_activity_id,review_status,reviewed_at,created_at,updated_at) VALUES ('r1','user-1','pledge-1','needs_payment_plan',${NOW},${NOW},${NOW})`);
    assert.throws(
      () => database.exec(`INSERT INTO pledge_payment_plan_reviews (id,user_id,pledge_activity_id,review_status,reviewed_at,created_at,updated_at) VALUES ('r2','user-1','pledge-1','need_to_investigate',${NOW},${NOW},${NOW})`),
      /UNIQUE constraint failed/,
      "a raw second INSERT (bypassing the upsert) for the same (user_id, pledge_activity_id) must be rejected by the schema itself",
    );
  }

  // --- 9: clearing returns to unreviewed ---
  {
    const database = freshDatabase();
    seedFixture(database);
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "needs_payment_plan", now: NOW });
    assert.ok(readReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" }));
    clearReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" });
    assert.equal(readReview(database, { userId: "user-1", pledgeActivityId: "pledge-1" }), null);
  }

  // --- 10: invalid status rejected (the CHECK constraint) ---
  {
    const database = freshDatabase();
    seedFixture(database);
    assert.throws(
      () => database.exec(`INSERT INTO pledge_payment_plan_reviews (id,user_id,pledge_activity_id,review_status,reviewed_at,created_at,updated_at) VALUES ('r1','user-1','pledge-1','not_a_real_status',${NOW},${NOW},${NOW})`),
      /CHECK constraint failed/,
      "a review_status outside the three allowed values must be rejected by the schema itself, not just by the route's own validation",
    );
  }

  // --- 11: a pledge from another user/workspace is rejected by the
  // route's own ownership check (verified by reading the real route
  // source, matching asks.test.mjs's documented convention; this test
  // proves the EXACT query it runs behaves correctly). ---
  {
    const database = freshDatabase();
    seedFixture(database);
    assert.equal(ownedLivePledge(database, { pledgeActivityId: "pledge-2", userId: "user-1" }), null, "user-1 must never be able to resolve user-2's pledge as their own");
    assert.ok(ownedLivePledge(database, { pledgeActivityId: "pledge-2", userId: "user-2" }), "user-2's own pledge resolves correctly for user-2");
    const routeSource = fs.readFileSync(new URL("../app/api/pledge-payment-plan-reviews/[pledgeActivityId]/route.ts", import.meta.url), "utf8");
    assert.match(routeSource, /ownedLivePledge\(pledgeActivityId, userId\)/, "PUT must call the ownership check before saving");
    assert.match(routeSource, /if \(!pledge\) return Response\.json\(\{ error: "Pledge not found" \}, \{ status: 404 \}\);/, "an unowned/nonexistent pledge must be rejected with 404, never silently saved");
  }

  // --- 12: selecting needs_payment_plan creates ZERO payment plans, and
  // giving_activities remains completely unchanged. ---
  {
    const database = freshDatabase();
    seedFixture(database);
    const pledgeBefore = database.prepare("SELECT * FROM giving_activities WHERE id = 'pledge-1'").get();
    const plansBefore = database.prepare("SELECT COUNT(*) AS c FROM pledge_payment_plans").get().c;
    saveReview(database, { userId: "user-1", pledgeActivityId: "pledge-1", reviewStatus: "needs_payment_plan", now: NOW });
    const plansAfter = database.prepare("SELECT COUNT(*) AS c FROM pledge_payment_plans").get().c;
    const pledgeAfter = database.prepare("SELECT * FROM giving_activities WHERE id = 'pledge-1'").get();
    assert.equal(plansAfter, plansBefore, "saving a review decision must never create a pledge_payment_plans row, regardless of which status is chosen");
    assert.equal(plansAfter, 0);
    assert.deepEqual(pledgeAfter, pledgeBefore, "giving_activities must be byte-for-byte unchanged by a review save");
    const routeSource = fs.readFileSync(new URL("../app/api/pledge-payment-plan-reviews/[pledgeActivityId]/route.ts", import.meta.url), "utf8");
    assert.ok(!/(INSERT|UPDATE|DELETE)\s+(INTO\s+)?["`']?pledge_payment_plans["`']?\b/i.test(routeSource), "the review route must never write to pledge_payment_plans -- only to pledge_payment_plan_reviews");
    assert.ok(!/(INSERT|UPDATE)\s+(INTO\s+)?["`']?recommendations["`']?\b/i.test(routeSource), "the review route must never create a reminder/recommendation");
  }

  // --- 13: progress counts derive correctly (pure function, matches
  // PledgeReviewList's own rendering) ---
  {
    const items = [
      { pledgeId: "p1" }, { pledgeId: "p2" }, { pledgeId: "p3" }, { pledgeId: "p4" },
    ];
    const statuses = { p1: "needs_payment_plan", p2: "needs_payment_plan", p3: "no_payment_plan_needed" };
    const progress = summarizePledgeReviewProgress(items, statuses);
    assert.equal(progress.totalCount, 4);
    assert.equal(progress.reviewedCount, 3);
    assert.equal(progress.unreviewedCount, 1);
    assert.deepEqual(progress.counts, { needs_payment_plan: 2, no_payment_plan_needed: 1, need_to_investigate: 0 });
  }

  // --- 14: a nonqualifying reviewed pledge does not reappear merely
  // because a review record exists -- buildPledgeReviewQueue takes no
  // review-table input at all, so a leftover review can structurally
  // never resurrect an excluded pledge. ---
  {
    const row = {
      id: "pledge-1", donor_id: "donor-a", activity_date: NOW - 100 * 86400,
      committed_cents: 10000, paid_cents: 10000, balance_cents: 0, // now fully paid
      description: null, source_campaign: "DIN2025", category: "open_pledge",
      donor_code: "1000", display_name: "Donor A",
    };
    // Even though the surrounding app may still hold a
    // pledge_payment_plan_reviews row for this pledge, buildPledgeReviewQueue
    // never receives or reads that table -- a zero balance alone excludes it.
    const items = buildPledgeReviewQueue([row], [], [], NOW);
    assert.equal(items.length, 0, "a fully-paid pledge must never appear, regardless of any review history");
  }

  console.log("Pledge payment-plan review persistence checks passed.");
}

await run();
