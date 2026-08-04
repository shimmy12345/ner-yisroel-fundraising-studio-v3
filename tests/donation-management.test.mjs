import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countsInGivingTotals, pendingGiftInput, pendingGiftMatches } from "../lib/giving/management.ts";

const statuses = ["hidden", "duplicate", "needs_review", "invalid", "merged"];
for (const workspace_status of statuses) {
  assert.equal(countsInGivingTotals({ workspace_status, category: "completed_gift" }), false, `${workspace_status} records are excluded from totals`);
}
assert.equal(countsInGivingTotals({ workspace_status: "active", category: "pending_gift" }), false, "unconfirmed pending gifts are excluded from totals");
assert.equal(countsInGivingTotals({ workspace_status: "active", category: "completed_gift" }), true, "active confirmed gifts count");

const input = pendingGiftInput({ donorId: " donor-1 ", date: "2026-08-04", amount: "$1,250.50", designation: " Annual Fund ", note: "Expected after the meeting" });
assert.deepEqual(input.errors, []);
assert.equal(input.donorId, "donor-1");
assert.equal(input.amountCents, 125050);
assert.equal(input.designation, "Annual Fund");
assert.ok(input.activityDate);
assert.ok(pendingGiftInput({ donorId: "", date: "bad", amount: 0 }).errors.length >= 3);

const imported = [{ fingerprint: "jl-row-1", donorId: "donor-1", activityDate: 1_722_816_000, committedCents: 50_000 }];
const candidates = [
  { id: "pending-near", donor_id: "donor-1", activity_date: 1_722_729_600, committed_cents: 50_000, description: "Annual", private_note: null, workspace_status: "active", category: "pending_gift", confirmed_by_activity_id: null },
  { id: "pending-other-donor", donor_id: "donor-2", activity_date: 1_722_816_000, committed_cents: 50_000, description: null, private_note: null, workspace_status: "active", category: "pending_gift", confirmed_by_activity_id: null },
  { id: "pending-hidden", donor_id: "donor-1", activity_date: 1_722_816_000, committed_cents: 50_000, description: null, private_note: null, workspace_status: "hidden", category: "pending_gift", confirmed_by_activity_id: null },
  { id: "pending-old", donor_id: "donor-1", activity_date: 1_720_000_000, committed_cents: 50_000, description: null, private_note: null, workspace_status: "active", category: "pending_gift", confirmed_by_activity_id: null },
];
assert.deepEqual(pendingGiftMatches(imported, candidates).map((match) => match.candidates.map((candidate) => candidate.id)), [["pending-near"]], "matches are owner-donor/date/amount safe and never include excluded candidates");

const route = await readFile(new URL("../app/api/giving/[id]/route.ts", import.meta.url), "utf8");
const pendingRoute = await readFile(new URL("../app/api/giving/pending/route.ts", import.meta.url), "utf8");
const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
const rollbackRoute = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const controls = await readFile(new URL("../app/donors/[id]/GivingManagement.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0016_lightweight_donation_management.sql", import.meta.url), "utf8");

assert.match(route, /record_origin='live'/);
assert.match(route, /owner_user_id=\?/);
assert.match(route, /expectedUpdatedAt/);
assert.match(route, /giving_activity_management_audits/);
assert.match(route, /jl_payment_assignment_audits SET donor_id/);
assert.match(route, /linked_pending_donor_corrected/);
assert.doesNotMatch(route, /DELETE FROM giving_activities/);
assert.doesNotMatch(route, /SET\s+(activity_date|committed_cents|paid_cents|balance_cents)/);
assert.match(pendingRoute, /category.*pending_gift/s);
assert.match(pendingRoute, /await env\.DB\.batch/);
assert.match(previewRoute, /pendingGiftMatches/);
assert.match(importRoute, /Review every suggested pending gift match/);
assert.match(importRoute, /claimedPendingIds/);
assert.match(importRoute, /workspace_status='merged'/);
assert.match(rollbackRoute, /workspace_status='active', confirmed_by_activity_id=NULL/);
assert.match(rollbackRoute, /giving_activity_management_audits SET undone_at/);
assert.match(donorPage, /countedActivities/);
assert.match(donorPage, /pending · unconfirmed/);
assert.match(controls, /JL date and amounts are read-only/);
assert.match(controls, /Hide from workspace/);
assert.match(controls, /Mark duplicate/);
assert.match(controls, /Correct donor match/);
assert.match(controls, /Save private note/);
assert.match(migration, /CHECK \(`workspace_status` IN/);
assert.match(migration, /giving_activity_management_audits/);

process.stdout.write("Lightweight donation management checks passed.\n");
