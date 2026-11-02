// Add Archive and Delete Options to Trip Planner (2026-11-02, tightened
// 2026-11-03 -- "Final Safety Fix Before Trip Archive/Delete Production
// Deployment," see docs/AI-HANDOFF.md). Calls the REAL, unmodified
// updateTrip/deleteTrip/getTrip/listTrips exported from
// lib/relationships/trips-data.ts -- not a hand-copied reproduction of
// their SQL -- by intercepting "cloudflare:workers" with this
// codebase's own established shim/adapter (see
// tests/trip-reconciliation-concurrency.test.mjs's own header for why
// this exists). Proves the real write paths' logic (the recorded-
// activity block -- meetings/notes AND financial history, active or
// historical -- the FK-safe delete order, and archiving never touching
// any other row) against SQLite's real transaction/constraint
// semantics, not merely that a hand-typed copy of the intended SQL
// behaves as expected.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

register("./helpers/cloudflare-workers-shim-loader.mjs", import.meta.url);

const { env } = await import("./helpers/cloudflare-workers-shim.mjs");
const { D1SqliteAdapter } = await import("./helpers/d1-sqlite-adapter.mjs");
const { createTrip, updateTrip, deleteTrip, getTrip, listTrips, selectTripProspect, addManualProspect } = await import("../lib/relationships/trips-data.ts");

const migrationDir = path.join(root, "drizzle");
const migrationTexts = readdirSync(migrationDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(migrationDir, name), "utf8"));

const NOW = Math.floor(Date.parse("2026-11-02T14:00:00Z") / 1000);
const USER_ID = "u1";
const DONOR_ID = "d1";

function freshDatabaseWithUserAndDonor() {
  const db = D1SqliteAdapter.fromMigrations(migrationTexts);
  db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(USER_ID, `${USER_ID}@example.test`, NOW, NOW).run();
  db.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, ?, 'live', 'Jane Donor', ?, ?)").bind(DONOR_ID, USER_ID, NOW, NOW).run();
  return db;
}

async function run() {
  // --- 1. Archiving a trip: a plain, reversible flag -- nothing else
  // about the trip changes. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Chicago Trip", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const before = await getTrip(USER_ID, tripId);
    assert.equal(before.archivedAt, null, "a newly-created trip must start unarchived");
    assert.equal(before.status, "planning");

    const ok = await updateTrip(USER_ID, tripId, { archived: true }, NOW + 60);
    assert.equal(ok, true);
    const archived = await getTrip(USER_ID, tripId);
    assert.equal(archived.archivedAt, NOW + 60, "archiving sets archived_at to the real timestamp of the action");
    assert.equal(archived.status, "planning", "archiving must never change the trip's own workflow status");
    assert.equal(archived.name, "Chicago Trip", "archiving must never change any other field");
  }

  // --- 2. Restoring an archived trip. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "NYC Trip", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    await updateTrip(USER_ID, tripId, { archived: true }, NOW);
    assert.equal((await getTrip(USER_ID, tripId)).archivedAt, NOW);

    await updateTrip(USER_ID, tripId, { archived: false }, NOW + 120);
    const restored = await getTrip(USER_ID, tripId);
    assert.equal(restored.archivedAt, null, "restoring clears archived_at back to null");
  }

  // --- 3. Viewing archived trips: listTrips() still returns them (with
  // archivedAt set), so the UI can offer an "Archived" filter -- it is
  // never silently excluded from the one list the server provides. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId: activeId } = await createTrip(USER_ID, { name: "Active Trip", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const { tripId: archivedId } = await createTrip(USER_ID, { name: "Archived Trip", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    await updateTrip(USER_ID, archivedId, { archived: true }, NOW);

    const trips = await listTrips(USER_ID);
    assert.equal(trips.length, 2, "listTrips must still return both trips -- filtering into Active vs. Archived is a UI-level concern, not a server-side hide");
    const active = trips.find((t) => t.id === activeId);
    const archived = trips.find((t) => t.id === archivedId);
    assert.equal(active.archivedAt, null);
    assert.equal(archived.archivedAt, NOW);
  }

  // --- 4. Deleting an EMPTY trip succeeds. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Empty Trip", destinationRegionIds: ["chicago-suburbs"], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const result = await deleteTrip(USER_ID, tripId);
    assert.deepEqual(result, { ok: true });
    assert.equal(await getTrip(USER_ID, tripId), null, "the trip must genuinely be gone");
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_destination_regions WHERE trip_id = ?").get(tripId).n, 0, "its destination-region rows must be gone too -- no orphans left behind");
  }

  // --- A trip containing only prospects added for PLANNING -- selected
  // for outreach, or manually added -- with no real meeting ever
  // recorded against them, remains deletable. Neither selectTripProspect
  // nor addManualProspect ever sets linked_interaction_id. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Trip With Only Planning Prospects", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const selectResult = await selectTripProspect(USER_ID, tripId, DONOR_ID, "America/New_York", NOW);
    assert.equal(selectResult.ok, true);
    const manualResult = await addManualProspect(USER_ID, tripId, { name: "Unlinked Prospect", city: null, regionId: null, phone: null, email: null, notes: null }, NOW);
    assert.equal(manualResult.ok, true);

    const result = await deleteTrip(USER_ID, tripId);
    assert.deepEqual(result, { ok: true }, "a trip with only planning-stage prospects (no recorded meeting, no financial activity) must still be deletable");
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_prospects WHERE trip_id = ?").get(tripId).n, 0, "its prospect rows (including the manually-added, unlinked one) must be gone");
    // The donor record itself is completely unaffected.
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM donors WHERE id = ?").get(DONOR_ID).n, 1);
  }

  // --- 5. Blocked by a RECORDED MEETING: any trip_prospects row whose
  // linked_interaction_id is set (the real, permanent marker a
  // scheduled/completed meeting -- and therefore possibly AI Meeting
  // Notes -- exists), even with zero financial activity at all. This is
  // the owner's own explicit tightening: "no meaningful recorded
  // activity" now includes meetings/notes, not only money. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Trip With a Recorded Meeting", destinationRegionIds: ["chicago-suburbs"], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const selectResult = await selectTripProspect(USER_ID, tripId, DONOR_ID, "America/New_York", NOW);
    assert.equal(selectResult.ok, true);
    // A second, innocuous planning-only prospect on the SAME trip --
    // proves a block is never partial: this row must survive too.
    const manualResult = await addManualProspect(USER_ID, tripId, { name: "Unrelated Planning Prospect", city: null, regionId: null, phone: null, email: null, notes: null }, NOW);
    db.prepare(`INSERT INTO interactions (id, user_id, donor_id, type, occurred_at, summary, source, created_at, updated_at)
        VALUES ('int1', ?, ?, 'meeting', ?, 'AI meeting notes: discussed capital campaign gift', 'capture-completed:1:completed:capture-scheduled:trip:trip:meeting', ?, ?)`)
      .bind(USER_ID, DONOR_ID, NOW, NOW, NOW).run();
    db.prepare(`UPDATE trip_prospects SET status = 'meeting_completed', linked_interaction_id = 'int1' WHERE id = ?`).bind(selectResult.prospectId).run();

    const result = await deleteTrip(USER_ID, tripId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "has_recorded_activity");
    assert.match(result.detail, /meeting/i, "the refusal message must name the recorded meeting as the reason");
    assert.match(result.detail, /Archive/, "the refusal message must point to Archive as the safe alternative");
    // A blocked delete is NEVER partial -- BOTH prospect rows survive,
    // not just the one that triggered the block.
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_prospects WHERE trip_id = ?").get(tripId).n, 2, "a blocked delete must leave every trip_prospects row untouched, including the unrelated planning-only one");
    // The real interaction (and its AI meeting notes text) is untouched.
    const interaction = db.raw().prepare("SELECT summary FROM interactions WHERE id = 'int1'").get();
    assert.equal(interaction.summary, "AI meeting notes: discussed capital campaign gift");
    assert.ok(await getTrip(USER_ID, tripId), "a blocked delete must leave the trip itself fully intact");
    // Every other trip-owned row (destination regions) survives too --
    // a blocked delete truly changes nothing, anywhere.
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_destination_regions WHERE trip_id = ?").get(tripId).n, 1);
  }

  // --- 6. Preventing unsafe deletion of a trip with real financial
  // activity (an active trip_financial_attributions row). ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Trip With a Pledge", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
        VALUES ('ga1', ?, ?, 'jl', 'hh-1', 'ga1', ?, 100000, 0, 100000, 'Pledge', 'open_pledge', 'live', 'active', '{}', ?, ?)`)
      .bind(USER_ID, DONOR_ID, NOW, NOW, NOW).run();
    db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at) VALUES ('attr1', ?, ?, ?, 'ga1', ?)`)
      .bind(USER_ID, tripId, DONOR_ID, NOW).run();

    const result = await deleteTrip(USER_ID, tripId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "has_recorded_activity");
    assert.match(result.detail, /pledge|donation|attribution/i, "the refusal message must name the financial activity as the reason");
    assert.match(result.detail, /Archive/, "the refusal message must point to Archive as the safe alternative");
    // Nothing was touched -- the trip, the attribution, the pledge, and
    // the donor all still exist exactly as they were.
    assert.ok(await getTrip(USER_ID, tripId), "a blocked delete must leave the trip fully intact");
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_financial_attributions WHERE id = 'attr1'").get().n, 1);
    assert.equal(db.raw().prepare("SELECT balance_cents FROM giving_activities WHERE id = 'ga1'").get().balance_cents, 100000);

    // The same trip CAN be archived instead -- archiving has no
    // recorded-activity restriction at all.
    const archiveOk = await updateTrip(USER_ID, tripId, { archived: true }, NOW);
    assert.equal(archiveOk, true);
    assert.equal((await getTrip(USER_ID, tripId)).archivedAt, NOW);
  }

  // --- Also blocked by an active, unmigrated trip_prospect_commitments
  // row (an unlinked prospect's own reported pledge/gift, with no
  // giving_activities row yet to show up in the attribution check). ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Trip With an Unlinked Commitment", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const manualResult = await addManualProspect(USER_ID, tripId, { name: "Prospective Donor", city: null, regionId: null, phone: null, email: null, notes: null }, NOW);
    assert.equal(manualResult.ok, true);
    db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, created_at) VALUES ('c1', ?, ?, ?, 'pending_pledge', 50000, ?)`)
      .bind(USER_ID, tripId, manualResult.prospectId, NOW).run();

    const result = await deleteTrip(USER_ID, tripId);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "has_recorded_activity");
  }

  // --- 7. TIGHTENED RULE: a commitment that was already MIGRATED into a
  // real giving_activities row, whose own resulting attribution was
  // LATER soft-removed/reconciled, now STILL blocks deletion -- this is
  // the owner's own explicit instruction ("a trip's financial history
  // should not disappear because an attribution was subsequently
  // removed or reconciled"), reversing this feature's original
  // "historical financial activity doesn't block" design. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    const { tripId } = await createTrip(USER_ID, { name: "Trip With a Reconciled Commitment", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);
    const manualResult = await addManualProspect(USER_ID, tripId, { name: "Now a Real Donor", city: null, regionId: null, phone: null, email: null, notes: null }, NOW);
    db.prepare(`INSERT INTO giving_activities (id, owner_user_id, donor_id, external_source, external_household_id, source_fingerprint, activity_date, committed_cents, paid_cents, balance_cents, item_type, category, record_origin, workspace_status, source_snapshot, created_at, updated_at)
        VALUES ('ga2', ?, ?, 'Fundraising OS', 'ga2', 'ga2', ?, 50000, 0, 50000, 'Pledge', 'pending_pledge', 'live', 'active', '{}', ?, ?)`)
      .bind(USER_ID, DONOR_ID, NOW, NOW, NOW).run();
    db.prepare(`INSERT INTO trip_financial_attributions (id, user_id, trip_id, donor_id, giving_activity_id, created_at, removed_at, removed_reason) VALUES ('attr2', ?, ?, ?, 'ga2', ?, ?, 'Reconciled with JL-imported record')`)
      .bind(USER_ID, tripId, DONOR_ID, NOW, NOW).run();
    db.prepare(`INSERT INTO trip_prospect_commitments (id, user_id, trip_id, prospect_id, category, committed_cents, created_at, migrated_giving_activity_id, migrated_attribution_id, migrated_at)
        VALUES ('c2', ?, ?, ?, 'pending_pledge', 50000, ?, 'ga2', 'attr2', ?)`)
      .bind(USER_ID, tripId, manualResult.prospectId, NOW, NOW).run();

    const result = await deleteTrip(USER_ID, tripId);
    assert.equal(result.ok, false, "a trip's financial history (even reconciled/soft-removed) must still block permanent deletion");
    assert.equal(result.reason, "has_recorded_activity");
    assert.match(result.detail, /pledge|donation|attribution/i);
    // Nothing was touched, including the historical rows themselves.
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM giving_activities WHERE id = 'ga2'").get().n, 1);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_financial_attributions WHERE id = 'attr2'").get().n, 1);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM trip_prospect_commitments WHERE id = 'c2'").get().n, 1);
    assert.equal(db.raw().prepare("SELECT COUNT(*) AS n FROM donors WHERE id = ?").get(DONOR_ID).n, 1);
  }

  // --- Deleting a trip the user does not own, or that does not exist,
  // is refused as not_found -- never a silent no-op success. ---
  {
    const db = freshDatabaseWithUserAndDonor();
    env.DB = db;
    db.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'u2@example.test', ?, ?)").bind(NOW, NOW).run();
    const { tripId } = await createTrip(USER_ID, { name: "Owned by u1", destinationRegionIds: [], startDate: NOW, endDate: NOW + 7 * 86400, goalCents: null, notes: null }, NOW);

    const resultWrongUser = await deleteTrip("u2", tripId);
    assert.deepEqual(resultWrongUser, { ok: false, reason: "not_found" }, "a different user must never be able to delete someone else's trip");
    assert.ok(await getTrip(USER_ID, tripId), "the real owner's trip must be completely unaffected by another user's attempt");

    const resultMissing = await deleteTrip(USER_ID, "no-such-trip");
    assert.deepEqual(resultMissing, { ok: false, reason: "not_found" });
  }

  console.log("trip-archive-delete.test.mjs: all assertions passed");
}

await run();
