import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { appearsInGivingTimeline, CONFIRM_PENDING_GIFT_SQL, countsInGivingTotals, pendingGiftMatches } from "../lib/giving/management.ts";

// Entirely fictional, in-memory verification. It never opens the staging D1 database.
const donorId = "fictional-donor-001";
const pendingId = "fictional-pending-001";
const clearGiftId = "fictional-jl-clear-001";
const separateGiftId = "fictional-jl-separate-001";
const ownerId = "fictional-owner-001";
const pendingDate = 1_722_816_000;

const pending = [{
  id: pendingId,
  donor_id: donorId,
  activity_date: pendingDate,
  committed_cents: 50_000,
  description: "Fictional annual support",
  private_note: "Fictional pending note",
  workspace_status: "active",
  category: "pending_gift",
  confirmed_by_activity_id: null,
}];
const incoming = [
  { fingerprint: "fictional-jl-clear", donorId, activityDate: pendingDate + 86_400, committedCents: 50_000 },
  { fingerprint: "fictional-jl-separate", donorId, activityDate: pendingDate + 8 * 86_400, committedCents: 50_000 },
];

const suggestions = pendingGiftMatches(incoming, pending);
assert.deepEqual(suggestions.map((item) => item.fingerprint), ["fictional-jl-clear"], "the clear match requires a merge decision while the similar gift outside the seven-day window remains separate");
assert.equal(pending[0].workspace_status, "active", "recognition alone never mutates or merges the pending gift");
assert.equal(pending[0].confirmed_by_activity_id, null, "no linked gift exists before explicit confirmation");

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
insert.run(pendingId, ownerId, donorId, "Fundraising OS", `pending:${pendingId}`, pendingDate, 50_000, 0, 0, "pending_gift", "live", "active", null, pendingDate);

assert.equal(db.prepare("SELECT COUNT(*) count FROM giving_activities WHERE workspace_status='merged'").get().count, 0, "previewing a match performs no merge");

db.exec("BEGIN");
try {
  insert.run(clearGiftId, ownerId, donorId, "JL Solutions", "fictional-jl-clear", pendingDate + 86_400, 50_000, 50_000, 0, "completed_gift", "live", "active", null, pendingDate + 86_400);
  const confirmation = db.prepare(CONFIRM_PENDING_GIFT_SQL).run(clearGiftId, pendingDate + 86_400, pendingId, ownerId, donorId);
  assert.equal(confirmation.changes, 1, "explicit confirmation links exactly one pending gift");
  insert.run(separateGiftId, ownerId, donorId, "JL Solutions", "fictional-jl-separate", pendingDate + 8 * 86_400, 50_000, 50_000, 0, "completed_gift", "live", "active", null, pendingDate + 8 * 86_400);
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}

const records = db.prepare("SELECT id,workspace_status,category,confirmed_by_activity_id,paid_cents FROM giving_activities ORDER BY activity_date,id").all();
const confirmedPending = records.find((row) => row.id === pendingId);
assert.equal(confirmedPending.workspace_status, "merged");
assert.equal(confirmedPending.confirmed_by_activity_id, clearGiftId, "the pending duplicate is retained for audit but linked to the confirmed JL gift");
assert.equal(records.filter((row) => row.workspace_status === "active" && row.category === "pending_gift").length, 0, "the confirmed pending duplicate leaves the active workspace");
assert.equal(records.find((row) => row.id === separateGiftId).workspace_status, "active", "the non-match remains a separate confirmed gift");

const counted = records.filter(countsInGivingTotals);
assert.deepEqual(counted.map((row) => row.id), [clearGiftId, separateGiftId], "only the two real JL gifts contribute to totals");
assert.equal(counted.reduce((sum, row) => sum + Number(row.paid_cents ?? 0), 0), 100_000, "giving totals contain no pending-gift double count");
assert.deepEqual(records.filter(appearsInGivingTimeline).map((row) => row.id), [clearGiftId, separateGiftId], "the timeline shows each real gift once and hides the merged pending duplicate");

// Six-month safeguards: exact donor identity, bounded date window, and one-claim-only server enforcement.
assert.equal(pendingGiftMatches([{ ...incoming[0], donorId: "fictional-other-donor" }], pending).length, 0, "a gift never crosses donor boundaries");
assert.equal(pendingGiftMatches([{ ...incoming[0], committedCents: 50_001 }], pending).length, 0, "a near amount never silently matches");
const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const importUi = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
assert.match(importRoute, /claimedPendingIds\.has/, "one pending gift cannot be claimed by two incoming rows");
assert.match(importUi, /A possible match is never merged automatically/);
assert.match(importUi, /Choose what to do/, "a first-time user receives an explicit, understandable decision prompt");

process.stdout.write("Pending gift matching integration checks passed.\n");
