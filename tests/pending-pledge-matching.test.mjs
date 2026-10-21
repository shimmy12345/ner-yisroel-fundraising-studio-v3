import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { appearsInGivingTimeline, CONFIRM_PENDING_PLEDGE_SQL, countsInGivingTotals, pendingPledgeMatches } from "../lib/giving/management.ts";

// Entirely fictional, in-memory verification. It never opens the staging D1 database.
// Pending-Pledge Import Reconciliation (2026-10-21, see docs/AI-HANDOFF.md)
// -- mirrors tests/pending-gift-matching.test.mjs's own structure exactly,
// for the pledge-side counterpart, plus the pledge-specific cases the
// task itself calls out: multiple pledges for the same donor (ambiguous
// match requiring an explicit choice), and a partially-paid real pledge
// still matching its own pending entry by committed amount.
const donorId = "fictional-donor-pledge-001";
const pendingId = "fictional-pending-pledge-001";
const clearPledgeId = "fictional-jl-pledge-clear-001";
const separatePledgeId = "fictional-jl-pledge-separate-001";
const ownerId = "fictional-owner-pledge-001";
const pendingDate = 1_722_816_000;

const pending = [{
  id: pendingId,
  donor_id: donorId,
  activity_date: pendingDate,
  committed_cents: 1_500_000,
  description: "Fictional capital campaign pledge",
  private_note: "Fictional pending pledge note",
  workspace_status: "active",
  category: "pending_pledge",
  confirmed_by_activity_id: null,
}];
const incoming = [
  { fingerprint: "fictional-jl-pledge-clear", donorId, activityDate: pendingDate + 86_400, committedCents: 1_500_000, category: "open_pledge" },
  { fingerprint: "fictional-jl-pledge-separate", donorId, activityDate: pendingDate + 20 * 86_400, committedCents: 1_500_000, category: "open_pledge" },
  // A brand-new GIFT (not a pledge) must never resolve a pending PLEDGE,
  // even with an identical donor/amount/date -- the category filter on
  // the imported side (not present on pendingGiftMatches, deliberately
  // added here) is what guards this.
  { fingerprint: "fictional-jl-gift-same-amount", donorId, activityDate: pendingDate + 86_400, committedCents: 1_500_000, category: "completed_gift" },
];

const suggestions = pendingPledgeMatches(incoming, pending);
assert.deepEqual(suggestions.map((item) => item.fingerprint), ["fictional-jl-pledge-clear"], "the clear pledge match requires a merge decision; the similar pledge outside the seven-day window and the same-amount GIFT both remain separate");
assert.equal(pending[0].workspace_status, "active", "recognition alone never mutates or merges the pending pledge");
assert.equal(pending[0].confirmed_by_activity_id, null, "no linked pledge exists before explicit confirmation");

// --- Multiple pending pledges for the SAME donor: an ambiguous match
// must surface every candidate, never silently pick one by amount alone. ---
{
  const secondPendingId = "fictional-pending-pledge-002";
  const twoPending = [
    pending[0],
    { ...pending[0], id: secondPendingId, activity_date: pendingDate + 2 * 86_400 },
  ];
  const ambiguousMatch = pendingPledgeMatches([incoming[0]], twoPending);
  assert.equal(ambiguousMatch.length, 1);
  assert.equal(ambiguousMatch[0].candidates.length, 2, "two distinct pending pledges for the same donor at the same amount must both surface as candidates, requiring an explicit choice");
  assert.deepEqual(ambiguousMatch[0].candidates.map((c) => c.id).sort(), [pendingId, secondPendingId].sort());
}

// --- A partially-paid real pledge (balance_cents/paid_cents already
// drifted) must still match its own pending entry by committed_cents,
// which never changes across the pledge's lifetime. ---
{
  const partiallyPaid = { fingerprint: "fictional-jl-pledge-partial", donorId, activityDate: pendingDate + 86_400, committedCents: 1_500_000, category: "partially_paid_pledge" };
  const partialMatch = pendingPledgeMatches([partiallyPaid], pending);
  assert.equal(partialMatch.length, 1, "a partially-paid real pledge still matches by its stable committed amount");
  assert.equal(partialMatch[0].candidates[0].id, pendingId);
}

const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE giving_activities (
  id TEXT PRIMARY KEY NOT NULL,
  owner_user_id TEXT NOT NULL,
  donor_id TEXT NOT NULL,
  external_source TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  activity_date INTEGER,
  committed_cents INTEGER,
  paid_cents INTEGER,
  balance_cents INTEGER,
  category TEXT NOT NULL,
  record_origin TEXT NOT NULL,
  workspace_status TEXT NOT NULL DEFAULT 'active',
  confirmed_by_activity_id TEXT,
  updated_at INTEGER NOT NULL
)`);
const insert = db.prepare(`INSERT INTO giving_activities
  (id,owner_user_id,donor_id,external_source,source_fingerprint,activity_date,committed_cents,paid_cents,balance_cents,category,record_origin,workspace_status,confirmed_by_activity_id,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
insert.run(pendingId, ownerId, donorId, "Fundraising OS", `pending:${pendingId}`, pendingDate, 1_500_000, 0, 1_500_000, "pending_pledge", "live", "active", null, pendingDate);

assert.equal(db.prepare("SELECT COUNT(*) count FROM giving_activities WHERE workspace_status='merged'").get().count, 0, "previewing a match performs no merge");

db.exec("BEGIN");
try {
  // The real JL pledge imports with an initial payment already applied
  // (paid 300,000 of 1,500,000) -- committed_cents is what must match,
  // never paid_cents/balance_cents.
  insert.run(clearPledgeId, ownerId, donorId, "JL Solutions", "fictional-jl-pledge-clear", pendingDate + 86_400, 1_500_000, 300_000, 1_200_000, "partially_paid_pledge", "live", "active", null, pendingDate + 86_400);
  const confirmation = db.prepare(CONFIRM_PENDING_PLEDGE_SQL).run(clearPledgeId, pendingDate + 86_400, pendingId, ownerId, donorId);
  assert.equal(confirmation.changes, 1, "explicit confirmation links exactly one pending pledge");
  insert.run(separatePledgeId, ownerId, donorId, "JL Solutions", "fictional-jl-pledge-separate", pendingDate + 20 * 86_400, 1_500_000, 0, 1_500_000, "open_pledge", "live", "active", null, pendingDate + 20 * 86_400);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const records = db.prepare("SELECT id,workspace_status,category,confirmed_by_activity_id,committed_cents,paid_cents,balance_cents FROM giving_activities ORDER BY activity_date,id").all();
const confirmedPending = records.find((row) => row.id === pendingId);
assert.equal(confirmedPending.workspace_status, "merged");
assert.equal(confirmedPending.confirmed_by_activity_id, clearPledgeId, "the pending pledge is retained for audit but linked to the confirmed JL pledge");
assert.equal(records.filter((row) => row.workspace_status === "active" && row.category === "pending_pledge").length, 0, "the confirmed pending pledge leaves the active workspace");
assert.equal(records.find((row) => row.id === separatePledgeId).workspace_status, "active", "the non-match remains a separate, real open pledge");

// Once reconciled, the trip/donor-facing figures must be the IMPORTED
// pledge's own actual committed/paid/balance amounts -- never the
// pending snapshot's zero-paid placeholder. (lib/relationships/trips-data.ts's
// listTripFinancialAttributions resolves this live via the same
// confirmed_by_activity_id link, exercised end to end on Staging.)
const resolved = records.find((row) => row.id === clearPledgeId);
assert.equal(resolved.committed_cents, 1_500_000);
assert.equal(resolved.paid_cents, 300_000, "the real pledge's own partial payment is the authoritative paid amount after reconciliation");
assert.equal(resolved.balance_cents, 1_200_000, "the real pledge's own outstanding balance is authoritative -- never re-derived or invented by reconciliation");

const counted = records.filter(countsInGivingTotals);
assert.deepEqual(counted.map((row) => row.id), [clearPledgeId, separatePledgeId], "only the two real JL pledges contribute to totals");
assert.equal(counted.reduce((sum, row) => sum + Number(row.committed_cents ?? 0), 0), 3_000_000, "the commitment counts exactly once per pledge -- no double count from the now-merged pending duplicate");
assert.deepEqual(records.filter(appearsInGivingTimeline).map((row) => row.id), [clearPledgeId, separatePledgeId], "the timeline shows each real pledge once and hides the merged pending duplicate");

// Repeated/competing confirmation: a retry (or a second decision
// claiming the same pending id) must never re-merge or double-claim --
// the SQL's own guard (confirmed_by_activity_id IS NULL) is what the
// server's claimedPendingPledgeIds Set backs up at the request level.
{
  const retry = db.prepare(CONFIRM_PENDING_PLEDGE_SQL).run("some-other-activity-id", pendingDate + 86_400, pendingId, ownerId, donorId);
  assert.equal(retry.changes, 0, "a pending pledge already confirmed can never be re-confirmed against a different activity");
}

// Six-month safeguards: exact donor identity, bounded date window, and one-claim-only server enforcement.
assert.equal(pendingPledgeMatches([{ ...incoming[0], donorId: "fictional-other-donor" }], pending).length, 0, "a pledge never crosses donor boundaries");
assert.equal(pendingPledgeMatches([{ ...incoming[0], committedCents: 1_500_001 }], pending).length, 0, "a near amount never silently matches");
const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const importUi = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
assert.match(importRoute, /claimedPendingPledgeIds\.has/, "one pending pledge cannot be claimed by two incoming rows");
assert.match(importRoute, /Review every suggested pending pledge match before importing/);
assert.match(importUi, /PENDING PLEDGE MATCHES/, "a first-time user sees a dedicated pending-pledge review panel, not pledges silently folded into the gift panel");

process.stdout.write("Pending pledge matching integration checks passed.\n");
