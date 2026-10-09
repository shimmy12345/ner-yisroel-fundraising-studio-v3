import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { shouldShowPaymentPlanCard } from "../lib/relationships/pledge-payment-plan.ts";

// Completed-Plan Visibility fix (2026-10-09, see docs/AI-HANDOFF.md's
// Rosenbaum (69341) / Katz (68231) investigation): a payment plan's card
// (and its only Edit/End-plan controls, its only renewal-field form) must
// stay reachable for as long as the plan is active, regardless of the
// pledge's own balance.

test("shouldShowPaymentPlanCard: open balance always shows the card, with or without a plan", () => {
  assert.equal(shouldShowPaymentPlanCard(10000, true), true);
  assert.equal(shouldShowPaymentPlanCard(10000, false), true);
});

test("shouldShowPaymentPlanCard: zero/null balance with an active plan still shows the card (the actual bug)", () => {
  assert.equal(shouldShowPaymentPlanCard(0, true), true);
  assert.equal(shouldShowPaymentPlanCard(null, true), true);
});

test("shouldShowPaymentPlanCard: zero balance with no plan at all is correctly excluded (no regression)", () => {
  assert.equal(shouldShowPaymentPlanCard(0, false), false);
  assert.equal(shouldShowPaymentPlanCard(null, false), false);
});

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("donor page: the pledge-card filter uses shouldShowPaymentPlanCard, not balance alone", async () => {
  const page = await read("app/donors/[id]/page.tsx");
  assert.match(
    page,
    /countedActivities\.filter\(\(item\) => shouldShowPaymentPlanCard\(item\.balance_cents, paymentPlans\.some\(\(p\) => p\.pledge_activity_id === item\.id\)\)\)/,
    "openPledgesWithPlans must be filtered through shouldShowPaymentPlanCard(balance, hasActivePlan), never `balance_cents > 0` alone",
  );
});

test("donor page: a completed pledge is shown as paid in full, never as an unpaid $0 balance", async () => {
  const page = await read("app/donors/[id]/page.tsx");
  assert.match(
    page,
    /\(pledge\.balance_cents \?\? 0\) > 0 \? money\(pledge\.balance_cents \?\? 0\) : "Paid in full"/,
    "the per-pledge summary row must render \"Paid in full\" once balance is zero, never a bare $0",
  );
});

test("donor page: the section label is neutral (not \"OPEN PLEDGES\") now that completed-but-active plans can appear in it", async () => {
  const page = await read("app/donors/[id]/page.tsx");
  assert.doesNotMatch(page, /<p className="eyebrow">OPEN PLEDGES<\/p>/, "the eyebrow label must not claim every row is an open pledge");
  assert.match(page, /<p className="eyebrow">PLEDGES<\/p>/);
});

test("payment-plan PATCH route: ended_at is only ever written inside the explicit {ended:true} branch, never auto-derived from balance", async () => {
  const route = await read("app/api/pledge-payment-plans/[id]/route.ts");
  // Exactly one UPDATE statement sets ended_at, and it lives inside the
  // `if (body.ended === true)` block -- this file never reads balance_cents
  // or giving_activities at all, so it structurally cannot auto-end a plan
  // based on the pledge reaching a zero balance.
  const endedAtWrites = route.match(/SET ended_at\s*=/g) ?? [];
  assert.equal(endedAtWrites.length, 1, "exactly one statement should ever set ended_at");
  assert.doesNotMatch(route, /balance_cents/, "the plan-edit/end route must never read balance_cents -- ending must only ever be an explicit fundraiser action");
});
