import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { MISSING_LEDGER_MIGRATIONS } from "../lib/data-health/model.ts";
import { explainOrphan, ORPHANED_INTERACTION_DETAILS_SQL, ORPHANED_REMINDER_DETAILS_SQL, toHealthIssue } from "../lib/data-health/issues.ts";
import { ORPHANED_INTERACTIONS_SQL, ORPHANED_REMINDERS_SQL } from "../lib/data-health/queries.ts";

const owner = "fictional-owner";
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE donors (id TEXT PRIMARY KEY,owner_user_id TEXT,data_source TEXT,archived_at INTEGER,merged_into_donor_id TEXT,display_name TEXT,last_name TEXT,spouse TEXT,spouse_first_name TEXT,external_id TEXT,donor_code TEXT,email TEXT,phone TEXT,alternate_mobile_phone TEXT,home_phone TEXT);
    CREATE TABLE interactions (id TEXT PRIMARY KEY,donor_id TEXT,user_id TEXT,type TEXT,occurred_at INTEGER,summary TEXT,source TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE recommendations (id TEXT PRIMARY KEY,donor_id TEXT,user_id TEXT,action TEXT,reason TEXT,score INTEGER,status TEXT,due_at INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE data_health_repair_audits (id TEXT PRIMARY KEY,user_id TEXT,record_type TEXT,record_id TEXT,action TEXT,previous_donor_id TEXT,next_donor_id TEXT,previous_state_json TEXT,next_state_json TEXT,reason TEXT,created_at INTEGER);
  `);
  const donor = db.prepare("INSERT INTO donors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  donor.run("active-a", owner, "live", null, null, "Alpha Household", "Alpha", null, null, "JL-A", "JL-A", null, null, null, null);
  donor.run("active-b", owner, "live", null, null, "Beta Household", "Beta", null, null, "JL-B", "JL-B", null, null, null, null);
  donor.run("archived-a", owner, "live", 100, "active-a", "Archived Alpha", "Alpha", null, null, null, null, null, null, null, null);
  db.prepare("INSERT INTO interactions VALUES (?,?,?,?,?,?,?,?,?)").run("interaction-1", "archived-a", owner, "call", 1000, "Fictional follow-up", "capture:call", 1000, 1000);
  db.prepare("INSERT INTO recommendations VALUES (?,?,?,?,?,?,?,?,?,?)").run("reminder-1", "archived-a", owner, "Fictional reminder", "Fictional reason", 90, "open", 1100, 900, 900);
  return db;
}

test("orphan details identify a valid merge redirect without donor names", () => {
  const db = fixture();
  const interaction = db.prepare(ORPHANED_INTERACTION_DETAILS_SQL).get(owner, owner);
  const reminder = db.prepare(ORPHANED_REMINDER_DETAILS_SQL).get(owner, owner);
  const interactionIssue = toHealthIssue("interaction", interaction, owner);
  const reminderIssue = toHealthIssue("reminder", reminder, owner);
  assert.equal(interactionIssue.survivingDonorId, "active-a");
  assert.equal(reminderIssue.survivingDonorId, "active-a");
  assert.match(interactionIssue.likelyCause, /merge/i);
  assert.doesNotMatch(JSON.stringify([interactionIssue, reminderIssue]), /Alpha Household|Archived Alpha/);
});

test("moving and archiving update the original record without duplicates or lost history", () => {
  const db = fixture();
  assert.equal(db.prepare(ORPHANED_INTERACTIONS_SQL).get(owner, owner).count, 1);
  db.prepare("UPDATE interactions SET donor_id=? WHERE id=? AND user_id=? AND donor_id=?").run("active-a", "interaction-1", owner, "archived-a");
  assert.equal(db.prepare(ORPHANED_INTERACTIONS_SQL).get(owner, owner).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM interactions").get().count, 1);
  assert.equal(db.prepare("SELECT donor_id FROM interactions WHERE id='interaction-1'").get().donor_id, "active-a");

  assert.equal(db.prepare(ORPHANED_REMINDERS_SQL).get(owner, owner).count, 1);
  db.prepare("UPDATE recommendations SET status='dismissed' WHERE id=? AND user_id=? AND donor_id=?").run("reminder-1", owner, "archived-a");
  assert.equal(db.prepare(ORPHANED_REMINDERS_SQL).get(owner, owner).count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM recommendations").get().count, 1);
});

test("six-month edge cases keep dismissals link-specific and block unsafe survivor assumptions", () => {
  const db = fixture();
  db.prepare("INSERT INTO data_health_repair_audits VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("audit-1", owner, "interaction", "interaction-1", "dismiss_false_positive", "archived-a", null, "{}", "{}", "confirmed", 1200);
  assert.equal(db.prepare(ORPHANED_INTERACTIONS_SQL).get(owner, owner).count, 0, "the reviewed donor link is dismissed");
  db.prepare("UPDATE interactions SET donor_id='missing-new'").run();
  assert.equal(db.prepare(ORPHANED_INTERACTIONS_SQL).get(owner, owner).count, 1, "a changed donor link is checked again");
  const missing = db.prepare(ORPHANED_INTERACTION_DETAILS_SQL).get(owner, owner);
  assert.equal(explainOrphan(missing, owner).canDismiss, false, "a missing donor must be repaired or archived, not hidden as a false positive");
});

test("repair route and first-time UI enforce ownership, confirmation, audit, and no hard delete", () => {
  const route = read("app/api/health/issues/route.ts");
  const ui = read("app/settings/DataHealthIssueDetails.tsx");
  const dashboard = read("app/settings/DataHealthDashboard.tsx");
  const migration = read("drizzle/0018_data_health_repairs.sql");
  assert.match(route, /getChatGPTUser/); assert.match(route, /owner_user_id=\?/); assert.match(route, /body\?\.confirmed/); assert.match(route, /data_health_repair_audits/); assert.match(route, /loadDataHealth/);
  assert.doesNotMatch(route, /DELETE FROM (interactions|recommendations)/i);
  for (const label of ["Internal record ID", "Current donor ID", "Why it is orphaned", "Likely cause", "Suggested repair", "Move to surviving donor", "Dismiss as false positive"]) assert.match(ui, new RegExp(label));
  assert.match(ui, /DonorAutocomplete/); assert.match(ui, /Confirm:/); assert.match(dashboard, /Inspect details/);
  assert.match(migration, /previous_state_json/); assert.match(migration, /next_state_json/);
  assert.deepEqual(MISSING_LEDGER_MIGRATIONS, ["0014_donor_merge_resolution", "0015_household_import_review_mode", "0016_lightweight_donation_management", "0017_today_relationship_queue", "0018_data_health_repairs"]);
});
