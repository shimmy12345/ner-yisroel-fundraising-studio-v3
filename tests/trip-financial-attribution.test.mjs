import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { summarizeTripFinancials } from "../lib/relationships/trip-financial-attribution.ts";

const record = (overrides) => ({
  attributionId: "attr-1", givingActivityId: "ga-1", donorId: "donor-1", donorDisplayName: "Jane Donor",
  category: "open_pledge", workspaceStatus: "active", committedCents: 0, paidCents: 0, balanceCents: 0, note: null, createdAt: 0,
  resolvedViaImportMatch: false,
  // Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md) --
  // every existing test below that omits these three fields exercises
  // the EXACT same defaults every pre-2026-10-20 attribution has (see
  // drizzle/0050's own header comment) -- an ordinary, already-real
  // category attribution, never a pre-existing-collection one.
  donorConfirmedAt: null, commitmentKind: "new_commitment", reportedCashCollectedCents: null,
  ...overrides,
});

// --- Exact worked examples from the task spec ---

// A $25,000 pledge counts as $25,000 toward the trip goal when confirmed
// and attributed. A subsequent $5,000 payment leaves total raised at
// $25,000 while cash collected increases by $5,000.
{
  const summary = summarizeTripFinancials([
    record({ category: "partially_paid_pledge", committedCents: 25_000_00, paidCents: 5_000_00, balanceCents: 20_000_00 }),
  ], null);
  assert.equal(summary.newPledgesSecuredCents, 25_000_00, "the pledge counts in full, not just what's been paid");
  assert.equal(summary.totalNewCommitmentsCents, 25_000_00);
  assert.equal(summary.cashCollectedCents, 5_000_00, "cash collected reflects only what was actually paid");
  assert.equal(summary.outstandingCommittedBalanceCents, 20_000_00);
}

// An outright $5,000 donation counts as $5,000 raised AND $5,000
// collected (no outstanding balance).
{
  const summary = summarizeTripFinancials([
    record({ category: "completed_gift", committedCents: 5_000_00, paidCents: 5_000_00, balanceCents: 0 }),
  ], null);
  assert.equal(summary.newDonationsSecuredCents, 5_000_00);
  assert.equal(summary.totalNewCommitmentsCents, 5_000_00);
  assert.equal(summary.cashCollectedCents, 5_000_00);
  assert.equal(summary.outstandingCommittedBalanceCents, 0);
}

// Multiple attributed records sum independently -- a pledge and a
// donation together, no cross-contamination between buckets.
{
  const summary = summarizeTripFinancials([
    record({ attributionId: "a", givingActivityId: "g1", category: "open_pledge", committedCents: 10_000_00, paidCents: 0, balanceCents: 10_000_00 }),
    record({ attributionId: "b", givingActivityId: "g2", category: "completed_gift", committedCents: 2_500_00, paidCents: 2_500_00, balanceCents: 0 }),
  ], 20_000_00);
  assert.equal(summary.newPledgesSecuredCents, 10_000_00);
  assert.equal(summary.newDonationsSecuredCents, 2_500_00);
  assert.equal(summary.totalNewCommitmentsCents, 12_500_00);
  assert.equal(summary.cashCollectedCents, 2_500_00);
  assert.equal(summary.pledgeCount, 1);
  assert.equal(summary.donationCount, 1);
}

// Completed pledge (fully paid): counted exactly once, zero outstanding
// balance, no double-counting of the final payment as a second gift.
{
  const summary = summarizeTripFinancials([
    record({ category: "completed_gift", committedCents: 25_000_00, paidCents: 25_000_00, balanceCents: 0 }),
  ], null);
  assert.equal(summary.totalNewCommitmentsCents, 25_000_00, "a pledge that pays off and gets re-categorized completed_gift by the CRM is still counted exactly once");
}

// Pending gift/pledge (not yet JL-confirmed) is tracked separately, never
// added to any confirmed total, regardless of its amount.
{
  const summary = summarizeTripFinancials([
    record({ category: "pending_pledge", workspaceStatus: "active", committedCents: 50_000_00, paidCents: 0, balanceCents: 50_000_00 }),
    record({ attributionId: "b", givingActivityId: "g2", category: "pending_gift", workspaceStatus: "active", committedCents: 1_000_00, paidCents: 0, balanceCents: 0 }),
  ], null);
  assert.equal(summary.totalNewCommitmentsCents, 0, "unconfirmed records must never count toward raised totals");
  assert.equal(summary.cashCollectedCents, 0);
  assert.equal(summary.pendingOpportunitiesCents, 51_000_00);
  assert.equal(summary.pendingCount, 2);
}

// --- Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md):
// the task's own core requirement -- a confirmed pledge or donation
// counts toward trip results immediately, before any JL import. ---

// A donor-confirmed pending_pledge counts in full immediately -- as a
// pledge, with its full committed amount outstanding (nothing paid
// pre-JL by construction) -- labeled "awaiting JL" via awaitingJlCount,
// never silently merged into the ordinary "recorded in JL" figures.
{
  const summary = summarizeTripFinancials([
    record({ category: "pending_pledge", committedCents: 10_000_00, paidCents: 0, balanceCents: 10_000_00, donorConfirmedAt: 1_700_000_000 }),
  ], null);
  assert.equal(summary.newPledgesSecuredCents, 10_000_00, "a donor-confirmed pledge counts immediately, before any JL import");
  assert.equal(summary.totalNewCommitmentsCents, 10_000_00);
  assert.equal(summary.cashCollectedCents, 0, "nothing has been paid against a brand-new pledge yet");
  assert.equal(summary.cashCollectedAwaitingJlCents, 0);
  assert.equal(summary.outstandingBalanceAwaitingJlCents, 10_000_00, "the full amount is outstanding and explicitly marked as awaiting JL, not recorded-in-JL");
  assert.equal(summary.outstandingBalanceRecordedInJlCents, 0);
  assert.equal(summary.outstandingCommittedBalanceCents, 10_000_00);
  assert.equal(summary.pledgeCount, 1);
  assert.equal(summary.awaitingJlCount, 1);
  assert.equal(summary.pendingOpportunitiesCents, 0, "a confirmed entry is no longer a pending opportunity");
  assert.equal(summary.pendingCount, 0);
}

// A donor-confirmed pending_gift counts in full immediately as a
// donation AND as cash collected (awaiting JL) -- a gift has no
// partial-payment concept, so it is reported received in full, with
// zero outstanding balance.
{
  const summary = summarizeTripFinancials([
    record({ category: "pending_gift", committedCents: 2_500_00, paidCents: 0, balanceCents: 0, donorConfirmedAt: 1_700_000_000 }),
  ], null);
  assert.equal(summary.newDonationsSecuredCents, 2_500_00);
  assert.equal(summary.totalNewCommitmentsCents, 2_500_00);
  assert.equal(summary.cashCollectedCents, 2_500_00, "a confirmed gift is reported received in full, even before JL records it");
  assert.equal(summary.cashCollectedAwaitingJlCents, 2_500_00);
  assert.equal(summary.cashCollectedRecordedInJlCents, 0);
  assert.equal(summary.outstandingCommittedBalanceCents, 0);
  assert.equal(summary.donationCount, 1);
  assert.equal(summary.awaitingJlCount, 1);
}

// Mixed: an unconfirmed opportunity and a donor-confirmed one of the
// same category must never be conflated -- only the confirmed one
// counts, the unconfirmed one stays a pending opportunity.
{
  const summary = summarizeTripFinancials([
    record({ attributionId: "a", givingActivityId: "g1", category: "pending_pledge", committedCents: 10_000_00, balanceCents: 10_000_00, donorConfirmedAt: 1_700_000_000 }),
    record({ attributionId: "b", givingActivityId: "g2", category: "pending_pledge", committedCents: 50_000_00, balanceCents: 50_000_00, donorConfirmedAt: null }),
  ], null);
  assert.equal(summary.totalNewCommitmentsCents, 10_000_00, "only the donor-confirmed pledge counts");
  assert.equal(summary.pendingOpportunitiesCents, 50_000_00, "the unconfirmed one stays a pending opportunity, excluded from every confirmed total");
  assert.equal(summary.pendingCount, 1);
  assert.equal(summary.awaitingJlCount, 1);
}

// Collecting on a pledge from BEFORE this trip must never be presented
// as a new commitment secured on this trip -- its own committed/paid/
// balance are entirely ignored for totals; only its own fundraiser-
// reported, trip-scoped cash figure ever counts, and only as cash
// collected (never outstanding, never a new pledge/donation).
{
  const summary = summarizeTripFinancials([
    record({
      category: "open_pledge", committedCents: 25_000_00, paidCents: 20_000_00, balanceCents: 5_000_00,
      commitmentKind: "preexisting_pledge_collection", reportedCashCollectedCents: 2_000_00,
    }),
  ], null);
  assert.equal(summary.newPledgesSecuredCents, 0, "never a new commitment, no matter its own category or amount");
  assert.equal(summary.totalNewCommitmentsCents, 0);
  assert.equal(summary.pledgeCount, 0);
  assert.equal(summary.outstandingCommittedBalanceCents, 0, "the pledge's own JL balance is never this trip's outstanding balance");
  assert.equal(summary.cashCollectedCents, 2_000_00, "only the trip-reported figure counts, never the pledge's lifetime paid_cents (20,000)");
  assert.equal(summary.cashCollectedAwaitingJlCents, 2_000_00);
  assert.equal(summary.preexistingPledgeCollectionCashCents, 2_000_00, "broken out so the UI can show it without implying a new commitment");
}

// Combined worked example: a brand-new donor-confirmed pledge, a
// brand-new real completed gift, and collecting on an old pre-existing
// pledge, all on the same trip -- every bucket sums independently, with
// no cross-contamination.
{
  const summary = summarizeTripFinancials([
    record({ attributionId: "a", givingActivityId: "g1", category: "pending_pledge", committedCents: 10_000_00, balanceCents: 10_000_00, donorConfirmedAt: 1_700_000_000 }),
    record({ attributionId: "b", givingActivityId: "g2", category: "completed_gift", committedCents: 5_000_00, paidCents: 5_000_00, balanceCents: 0 }),
    record({
      attributionId: "c", givingActivityId: "g3", category: "open_pledge", committedCents: 25_000_00, paidCents: 20_000_00, balanceCents: 5_000_00,
      commitmentKind: "preexisting_pledge_collection", reportedCashCollectedCents: 3_000_00,
    }),
  ], null);
  assert.equal(summary.totalNewCommitmentsCents, 15_000_00, "10,000 confirmed pledge + 5,000 real gift -- the 25,000 pre-existing pledge is never counted as new");
  assert.equal(summary.cashCollectedCents, 8_000_00, "5,000 from the real gift + 3,000 reported collected on the old pledge -- never the old pledge's own 20,000 lifetime paid_cents");
  assert.equal(summary.outstandingCommittedBalanceCents, 10_000_00, "only the confirmed pledge's own outstanding balance -- the pre-existing pledge's 5,000 JL balance is excluded entirely");
}

// A hidden/needs_review/merged record attributed to a trip (should not
// normally happen, but the summarizer must never trust workspace_status
// blindly) is excluded from confirmed totals exactly like any other
// non-counted record -- reusing countsInGivingTotals, never a second,
// competing "is this real" check.
{
  const summary = summarizeTripFinancials([
    record({ category: "open_pledge", workspaceStatus: "hidden", committedCents: 10_000_00, paidCents: 0, balanceCents: 10_000_00 }),
  ], null);
  assert.equal(summary.totalNewCommitmentsCents, 0);
  assert.equal(summary.pendingOpportunitiesCents, 10_000_00, "excluded for any reason falls into the same 'not yet confirmed' bucket, never silently dropped");
}

// Goal percentage and remaining-to-goal.
{
  const summary = summarizeTripFinancials([
    record({ category: "open_pledge", committedCents: 7_500_00, paidCents: 0, balanceCents: 7_500_00 }),
  ], 10_000_00);
  assert.equal(summary.percentOfGoal, 0.75);
  assert.equal(summary.amountRemainingToGoalCents, 2_500_00);
}
{
  // Exceeding the goal must never report a negative "remaining."
  const summary = summarizeTripFinancials([record({ category: "completed_gift", committedCents: 15_000_00, paidCents: 15_000_00, balanceCents: 0 })], 10_000_00);
  assert.equal(summary.amountRemainingToGoalCents, 0);
  assert.equal(summary.percentOfGoal, 1.5);
}
{
  // No goal set at all -- percentage must be null, never 0 or a division
  // artifact.
  const summary = summarizeTripFinancials([], null);
  assert.equal(summary.percentOfGoal, null);
  assert.equal(summary.amountRemainingToGoalCents, null);
  assert.equal(summary.totalNewCommitmentsCents, 0);
}

// --- Structural coverage: ownership checks, auth, and "never modify the
// underlying financial transaction" -- the D1-touching code imports
// "cloudflare:workers" and cannot run outside a Workers runtime (same
// established constraint as every other D1-touching module in this
// codebase, see tests/relationship-fact-accept-core.test.mjs's own doc
// comment), so this is read-source verification, matching this
// codebase's existing convention for such code (e.g.
// tests/donation-management.test.mjs, tests/staging-write-guard.test.mjs). ---

const tripsData = await readFile(new URL("../lib/relationships/trips-data.ts", import.meta.url), "utf8");

// Ownership checks: every new financial-attribution function must scope
// by the authenticated owner, never trust a bare id from the request.
assert.match(tripsData, /listEligibleGivingActivitiesForDonor[\s\S]{0,400}owner_user_id = \?/);
assert.match(tripsData, /attributeGivingActivityToTrip[\s\S]{0,600}ownedProspect\(userId, tripId, prospectId\)/, "attribution must go through the same ownedProspect ownership check every other prospect mutation uses");
assert.match(tripsData, /attributeGivingActivityToTrip[\s\S]{0,900}FROM giving_activities WHERE id = \? AND owner_user_id = \? AND donor_id = \?/, "the giving_activity being attributed must belong to both the authenticated owner AND the SAME donor as the trip prospect -- never an arbitrary record");
// Window widened to 1700 (2026-10-15, Pending-Gift Reconciliation Fix, see
// docs/AI-HANDOFF.md) -- the query grew several CASE expressions longer to
// resolve a merged pending_gift to its confirmed donation's own live
// figures at read time; the owner-scoping clause itself is unchanged.
assert.match(tripsData, /listTripFinancialAttributions[\s\S]{0,1700}t\.owner_user_id = \?/, "listing a trip's attributions must be scoped to the trip's own owner");
assert.match(tripsData, /removeTripFinancialAttribution[\s\S]{0,500}trip_id IN \(SELECT id FROM trips WHERE owner_user_id = \?\)/, "removing an attribution must be scoped to the trip's own owner");

// Pending-Gift Reconciliation Fix (2026-10-15, independent review, see
// docs/AI-HANDOFF.md): the merge-resolution LEFT JOIN must stay scoped to
// the SAME owner as the attribution itself -- it must never be able to
// resolve to a giving_activities row outside this workspace.
assert.match(tripsData, /LEFT JOIN giving_activities confirmed ON confirmed\.id = ga\.confirmed_by_activity_id AND confirmed\.owner_user_id = tfa\.user_id/, "the merged-pending-gift resolution join must stay scoped to the attribution's own owner");

// The double-counting guard must be enforced at the actual write path
// (attributeGivingActivityToTrip), never relying on the UI-filtered
// eligibility list alone.
assert.match(tripsData, /attributeGivingActivityToTrip[\s\S]{0,1500}pending\.confirmed_by_activity_id = \?[\s\S]{0,200}already_attributed/, "attributing a confirmed donation that is the resolution target of an already-attributed pending gift must be rejected, exactly like a direct duplicate attribution");

// "Never modify the underlying financial transaction" -- the attribution
// functions must never UPDATE giving_activities' own financial fields.
assert.doesNotMatch(tripsData, /UPDATE giving_activities SET[\s\S]{0,200}(committed_cents|paid_cents|balance_cents)/, "trips-data.ts must never write to a giving_activities row's own financial fields -- attribution only ever links, never edits, the record");

// Auth: both new route files require an authenticated, profile-resolved
// user before touching anything, matching every existing route's own
// convention.
const attributionsRoute = await readFile(new URL("../app/api/trips/[id]/prospects/[prospectId]/attributions/route.ts", import.meta.url), "utf8");
const attributionIdRoute = await readFile(new URL("../app/api/trips/[id]/prospects/[prospectId]/attributions/[attributionId]/route.ts", import.meta.url), "utf8");
for (const route of [attributionsRoute, attributionIdRoute]) {
  assert.match(route, /getChatGPTUser\(\)/);
  assert.match(route, /Authentication required/);
  assert.match(route, /ensureUserProfile\(user\)/);
}

// Pending opportunities tracked separately: the "recorded but not
// attributed" path must never be silently reported as a plain failure --
// the financial record is real even if the link step didn't complete.
assert.match(tripsData, /recorded_but_not_attributed/);
assert.match(attributionsRoute, /recorded_but_not_attributed/);

// The trip attribution routes fall under the EXISTING /api/trips Staging
// write carve-out by construction (same prefix) -- re-confirmed by
// tests/staging-write-guard.test.mjs's own repo-wide route walk, not
// duplicated here.

// --- Donor-confirmation correction (2026-10-20, see docs/AI-HANDOFF.md):
// structural coverage for the new reconciliation/confirmation functions,
// matching this file's own established source-inspection convention. ---

// Ambiguous-match guard: attributing a REAL record must check for
// reconcilable candidates and require an explicit choice -- never
// silently pick one solely by donor and amount.
assert.match(tripsData, /attributeGivingActivityToTrip[\s\S]{0,2500}listReconcilableTripAttributions\(userId, tripId, prospect\.donorId\)/, "attributing a real record must look up reconcilable pending entries for the SAME donor on the SAME trip");
assert.match(tripsData, /reconciliation_choice_required/, "an ambiguous match (candidates exist, none explicitly chosen) must be rejected, never auto-resolved");
assert.doesNotMatch(tripsData, /reconcilesAttributionId \?\? "none"|reconcilesAttributionId \|\| candidates\[0\]/, "never a default/first-candidate auto-pick");

// The insert-and-retire-the-reconciled-entry write must be atomic (one
// D1 batch) -- never two separate writes that could leave both active
// (double-counted) or both removed (the commitment silently disappears).
assert.match(tripsData, /attributeGivingActivityToTrip[\s\S]{0,4500}env\.DB\.batch\(\[[\s\S]{0,600}INSERT INTO trip_financial_attributions[\s\S]{0,600}UPDATE trip_financial_attributions SET removed_at/, "the new attribution and the reconciled (retired) pending entry must be written in the SAME atomic batch");

// A pre-existing pledge collection can only ever be set on an already-
// real (already-JL) category -- a record that does not exist in JL yet
// cannot be "pre-existing."
assert.match(tripsData, /invalid_commitment_kind/);
assert.match(tripsData, /commitmentKind === "preexisting_pledge_collection" && !REAL_COMMITMENT_CATEGORIES\.has\(givingActivity\.category\)/);

// confirmTripAttribution/unconfirmTripAttribution: ownership-scoped,
// idempotent, and restricted to a still-pending (not yet real/JL)
// category -- never applicable to an already-real category, since JL's
// own confirmation already speaks for it, and never recreates the
// attribution or touches giving_activities.
for (const fn of ["confirmTripAttribution", "unconfirmTripAttribution"]) {
  assert.match(tripsData, new RegExp(`${fn}[\\s\\S]{0,800}t\\.owner_user_id = \\?`), `${fn} must be scoped to the trip's own owner`);
  assert.match(tripsData, new RegExp(`${fn}[\\s\\S]{0,1300}not_applicable`), `${fn} must reject an already-real category rather than silently doing nothing`);
}
assert.match(tripsData, /confirmTripAttribution[\s\S]{0,1200}if \(row\.donor_confirmed_at\) return \{ ok: true \};/, "confirming an already-confirmed entry must be a no-op success, never an error");
assert.match(tripsData, /unconfirmTripAttribution[\s\S]{0,1200}if \(!row\.donor_confirmed_at\) return \{ ok: true \};/, "unconfirming an already-unconfirmed entry must be a no-op success, never an error");

// The donor-confirmed flag on a NEW record is only ever set from the
// caller's own explicit `confirmed === true` -- never assumed true by
// default (the task's own "do not assume all existing pending
// opportunities are donor-confirmed" applies equally to new ones).
assert.match(tripsData, /function donorConfirmedFlag\(rawInput: unknown\): boolean \{\s*return \(rawInput as Record<string, unknown> \| null\)\?\.confirmed === true;/, "a new record is only ever donor-confirmed from an explicit `confirmed === true`, never any other truthy value or a default");

// Never modify the underlying financial transaction -- re-asserted after
// this round's additions (reported_cash_collected_cents, donor_confirmed_at,
// commitment_kind are all columns on trip_financial_attributions itself,
// never giving_activities).
assert.doesNotMatch(tripsData, /UPDATE giving_activities SET[\s\S]{0,200}(committed_cents|paid_cents|balance_cents)/, "trips-data.ts must never write to a giving_activities row's own financial fields, even after this round's additions");

// The confirm/unconfirm PATCH route: same auth convention as every
// other trip route, and never touches DELETE's own removal path.
const attributionConfirmRoute = attributionIdRoute;
assert.match(attributionConfirmRoute, /export async function PATCH/);
assert.match(attributionConfirmRoute, /donorConfirmed/);

process.stdout.write("trip-financial-attribution.test.mjs: all assertions passed\n");
