import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COUNTED_GIVING_SQL, countsInGivingTotals, pendingPledgeInput } from "../lib/giving/management.ts";

// --- Classification: pending_pledge is excluded from totals exactly like
// pending_gift, never counted toward any donor's or trip's confirmed
// totals until a real pledge is attributed. ---

assert.equal(countsInGivingTotals({ workspace_status: "active", category: "pending_pledge" }), false, "unconfirmed pending pledges are excluded from totals");
assert.equal(countsInGivingTotals({ workspace_status: "active", category: "open_pledge" }), true, "a real, confirmed open pledge still counts");
assert.match(COUNTED_GIVING_SQL, /'pending_pledge'/, "the raw SQL exclusion list must also carry pending_pledge, for any caller that filters in SQL rather than in JS");

// --- Input validation mirrors pendingGiftInput's own shape exactly. ---

const input = pendingPledgeInput({ donorId: " donor-1 ", date: "2026-11-01", amount: "$25,000", designation: " Building Fund ", note: "Discussed on the trip" });
assert.deepEqual(input.errors, []);
assert.equal(input.donorId, "donor-1");
assert.equal(input.amountCents, 2_500_000);
assert.equal(input.designation, "Building Fund");
assert.ok(input.activityDate);
assert.ok(pendingPledgeInput({ donorId: "", date: "bad", amount: 0 }).errors.length >= 3);
assert.ok(pendingPledgeInput({ donorId: "donor-1", date: "2026-11-01", amount: -500 }).errors.length >= 1, "a negative amount must be rejected");

// --- Structural coverage: the new route exists and writes the right
// category/balance shape. ---

const pendingPledgeRoute = await readFile(new URL("../app/api/giving/pending-pledge/route.ts", import.meta.url), "utf8");
assert.match(pendingPledgeRoute, /insertPendingPledge/, "the route must call the shared insert helper, not reimplement it inline");

const pendingRecords = await readFile(new URL("../lib/giving/pending-records.ts", import.meta.url), "utf8");
assert.match(pendingRecords, /category.*pending_pledge/s);
assert.match(pendingRecords, /category.*pending_gift/s);
assert.match(pendingRecords, /await env\.DB\.batch/);
assert.match(pendingRecords, /owner_user_id=\?/);
// A pending pledge starts with nothing paid and the full amount still
// outstanding -- matching the shape a real open_pledge row would have at
// creation (paid_cents=0, balance_cents=committed amount) -- never the
// pending_gift convention of balance_cents=0 (which is correct only for
// a gift, which has no pledge-style balance concept at all).
assert.match(pendingRecords, /,0,\?,'Pending pledge'/, "paid_cents must be 0 and balance_cents must be the full pledge amount at creation, matching a real open_pledge row's own shape");

// Pending-Pledge Import Reconciliation (2026-10-21, see docs/AI-HANDOFF.md):
// the live JL import pipeline is NOW wired into pending_pledge matching
// too (lib/giving/management.ts's pendingPledgeMatches/
// CONFIRM_PENDING_PLEDGE_SQL) -- this reverses the deliberate scope limit
// the two assertions immediately above this comment used to encode, as a
// real reconciliation gap: a pledge recorded on a trip before JL import
// could sit labeled "Awaiting JL" forever after its real JL pledge
// imported. The one invariant that must still hold, unchanged from the
// pending_gift path: never auto-merge solely because donor and amount
// match -- every suggested match still requires an explicit decision
// through the review screen before commit.
const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
assert.match(importRoute, /pendingPledgeMatches/, "the live JL import reconciliation pipeline must compute pending-pledge matches");
assert.match(importRoute, /CONFIRM_PENDING_PLEDGE_SQL/, "a merged pending pledge must be confirmed through the same guarded SQL as pending gifts");
assert.match(importRoute, /Review every suggested pending pledge match before importing/, "a suggested pledge match can never be silently skipped -- commit must block until every match has an explicit decision");

const existingPendingGiftRoute = await readFile(new URL("../app/api/giving/pending/route.ts", import.meta.url), "utf8");
assert.doesNotMatch(existingPendingGiftRoute, /pending_pledge/, "the existing pending-gift route must be completely untouched by this feature");

process.stdout.write("pending-pledge.test.mjs: all assertions passed\n");
