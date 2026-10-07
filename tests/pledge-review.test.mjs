import assert from "node:assert/strict";
import { pledgeReviewCutoffEpoch, buildPledgeReviewQueue } from "../lib/relationships/pledge-review.ts";

const DAY = 86400;
const NOW = Math.floor(Date.UTC(2026, 9, 7) / 1000); // 2026-10-07

// --- cutoff ---
assert.equal(pledgeReviewCutoffEpoch(NOW), Math.floor(Date.UTC(2024, 9, 7) / 1000), "cutoff must be exactly 2 years before now, UTC date-only");

function row(overrides) {
  return {
    id: "pledge-1", donor_id: "donor-1", activity_date: NOW - 100 * DAY,
    committed_cents: 10000, paid_cents: 0, balance_cents: 10000,
    description: null, source_campaign: "DIN2025", category: "open_pledge",
    donor_code: "1000", display_name: "Test Donor",
    ...overrides,
  };
}

// --- excludes: zero/negative balance ---
{
  const items = buildPledgeReviewQueue([row({ balance_cents: 0 })], [], [], NOW);
  assert.equal(items.length, 0, "zero balance must be excluded");
}

// --- excludes: older than cutoff ---
{
  const items = buildPledgeReviewQueue([row({ activity_date: NOW - 800 * DAY })], [], [], NOW);
  assert.equal(items.length, 0, "a pledge older than the 2-year cutoff must be excluded");
}

// --- excludes: missing activity_date ---
{
  const items = buildPledgeReviewQueue([row({ activity_date: null })], [], [], NOW);
  assert.equal(items.length, 0, "a pledge with no activity_date must be excluded, never defaulted");
}

// --- excludes: has an ACTIVE plan (ended_at IS NULL) ---
{
  const items = buildPledgeReviewQueue(
    [row({ id: "p1" })],
    [{ pledge_activity_id: "p1", ended_at: null }],
    [],
    NOW,
  );
  assert.equal(items.length, 0, "a pledge with an active plan must never appear in the review queue");
}

// --- includes: an ENDED (inactive) plan still counts as "no current plan" ---
{
  const items = buildPledgeReviewQueue(
    [row({ id: "p1" })],
    [{ pledge_activity_id: "p1", ended_at: NOW - 10 * DAY }],
    [],
    NOW,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].planStatus, "old_inactive_plan");
}

// --- planStatus: no plan row at all ---
{
  const items = buildPledgeReviewQueue([row({ id: "p1" })], [], [], NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].planStatus, "none");
}

// --- paidStatus: unpaid vs partially_paid ---
{
  const items = buildPledgeReviewQueue(
    [row({ id: "p1", paid_cents: 0 }), row({ id: "p2", donor_id: "donor-2", paid_cents: 500, balance_cents: 9500 })],
    [], [], NOW,
  );
  const byId = Object.fromEntries(items.map((i) => [i.pledgeId, i]));
  assert.equal(byId.p1.paidStatus, "unpaid");
  assert.equal(byId.p2.paidStatus, "partially_paid");
}

// --- future-dated flag ---
{
  const items = buildPledgeReviewQueue([row({ id: "p1", activity_date: NOW + 30 * DAY })], [], [], NOW);
  assert.equal(items[0].isFutureDated, true);
}
{
  const items = buildPledgeReviewQueue([row({ id: "p1", activity_date: NOW - 30 * DAY })], [], [], NOW);
  assert.equal(items[0].isFutureDated, false);
}

// --- payment evidence: reliable history (a real linked payment) ---
{
  const items = buildPledgeReviewQueue(
    [row({ id: "p1", paid_cents: 500, balance_cents: 9500 })],
    [],
    [{ pledge_activity_id: "p1", payment_date: NOW - 20 * DAY, applied_cents: 500 }],
    NOW,
  );
  assert.equal(items[0].hasReliableHistory, true);
  assert.equal(items[0].lastPaymentDate, NOW - 20 * DAY);
  assert.equal(items[0].lastPaymentAmountCents, 500);
}

// --- payment evidence: paid_cents > 0 but NO linked audit row -- the
// audit's §5.2 finding. Must never invent a last-payment date. ---
{
  const items = buildPledgeReviewQueue([row({ id: "p1", paid_cents: 500, balance_cents: 9500 })], [], [], NOW);
  assert.equal(items[0].hasReliableHistory, false, "paid_cents>0 with no audit row must be flagged as unreliable, never silently treated as 'no payment'");
  assert.equal(items[0].lastPaymentDate, null);
  assert.equal(items[0].lastPaymentAmountCents, null);
}

// --- payment evidence: never paid at all (no caveat needed) ---
{
  const items = buildPledgeReviewQueue([row({ id: "p1", paid_cents: 0 })], [], [], NOW);
  assert.equal(items[0].hasReliableHistory, true, "zero payments ever is a reliable (if empty) history, not the same caveat as a missing audit row");
}

// --- sort: a payment linked to a DIFFERENT pledge must never leak in ---
{
  const items = buildPledgeReviewQueue(
    [row({ id: "p1", paid_cents: 500, balance_cents: 9500 })],
    [],
    [{ pledge_activity_id: "OTHER-PLEDGE", payment_date: NOW - 5 * DAY, applied_cents: 9999 }],
    NOW,
  );
  assert.equal(items[0].hasReliableHistory, false, "a different pledge's payment must not satisfy this pledge's evidence");
  assert.equal(items[0].lastPaymentDate, null);
}

// --- sort order: partially-paid before unpaid; oldest activityDate first within each group ---
{
  const rows = [
    row({ id: "unpaid-new", donor_id: "d1", paid_cents: 0, activity_date: NOW - 10 * DAY }),
    row({ id: "unpaid-old", donor_id: "d2", paid_cents: 0, activity_date: NOW - 500 * DAY }),
    row({ id: "paid-new", donor_id: "d3", paid_cents: 100, balance_cents: 9900, activity_date: NOW - 5 * DAY }),
    row({ id: "paid-old", donor_id: "d4", paid_cents: 100, balance_cents: 9900, activity_date: NOW - 600 * DAY }),
  ];
  const items = buildPledgeReviewQueue(rows, [], [], NOW);
  assert.deepEqual(items.map((i) => i.pledgeId), ["paid-old", "paid-new", "unpaid-old", "unpaid-new"], "partially-paid group first (oldest-first within it), then unpaid group (oldest-first within it) -- never ordered by the prior A/B/C classification, which does not exist in this module");
}

// --- multiple pledges, same donor, each evaluated independently (no cross-pledge leakage) ---
{
  const rows = [
    row({ id: "p1", donor_id: "same-donor", activity_date: NOW - 10 * DAY }),
    row({ id: "p2", donor_id: "same-donor", activity_date: NOW - 20 * DAY }),
  ];
  const items = buildPledgeReviewQueue(rows, [{ pledge_activity_id: "p1", ended_at: null }], [], NOW);
  assert.equal(items.length, 1, "p1 has an active plan and must be excluded; p2 must still appear independently");
  assert.equal(items[0].pledgeId, "p2");
}

process.stdout.write("Pledge review queue checks passed.\n");
