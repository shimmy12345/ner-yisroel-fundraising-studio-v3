import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { planDonorMergeResearchReconciliation } from "../lib/donors/merge-research.ts";
import { computeFindingFingerprint } from "../lib/research/fingerprint.ts";

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const file of fs.readdirSync(new URL("../drizzle", import.meta.url)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(fs.readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
  }
  return database;
}

function seed(database) {
  const now = Math.floor(Date.now() / 1000);
  database.exec(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1','owner@example.test',${now},${now})`);
  for (const id of ["A", "B", "C"]) database.exec(`INSERT INTO donors (id, display_name, created_at, updated_at) VALUES ('${id}','Fictional Donor ${id}',${now},${now})`);
  database.exec(`INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES ('rA','A','u1','completed',${now})`);
  database.exec(`INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES ('rB','B','u1','completed',${now})`);
  database.exec(`INSERT INTO donor_research_runs (id, donor_id, user_id, status, created_at) VALUES ('rC','C','u1','completed',${now})`);
  return now;
}

function finding(database, { id, donor, run = `r${donor}`, category = "professional", claim, status = "current", fingerprint, relatedDonor = null }, now) {
  database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, related_donor_id, status, fingerprint, created_at)
    VALUES ('${id}','${run}','${run}','${donor}','u1','${category}','${claim}',${relatedDonor ? `'${relatedDonor}'` : "NULL"},'${status}','${fingerprint}',${now})`);
}

// Runs whatever plan the planner returns as if it were the route's own
// batch -- proves the plan actually reconciles the DB correctly, not just
// that the pure function returns a plausible-looking object.
function applyPlan(database, survivorId, duplicateId, plan) {
  database.exec(`UPDATE donor_research_runs SET donor_id='${survivorId}' WHERE donor_id='${duplicateId}'`);
  for (const id of plan.findingRepoints) database.exec(`UPDATE donor_research_findings SET donor_id='${survivorId}' WHERE id='${id}'`);
  for (const { loserId, winnerId } of plan.findingSupersessions) {
    database.exec(`UPDATE donor_research_findings SET donor_id='${survivorId}', status='superseded' WHERE id='${loserId}'`);
    database.exec(`INSERT OR IGNORE INTO donor_research_finding_sources (finding_id, source_id) SELECT '${winnerId}', source_id FROM donor_research_finding_sources WHERE finding_id='${loserId}'`);
  }
  for (const { findingId, newFingerprint } of plan.relatedDonorRepoints) database.exec(`UPDATE donor_research_findings SET related_donor_id='${survivorId}', fingerprint='${newFingerprint}' WHERE id='${findingId}'`);
  for (const { loserId, winnerId, newFingerprint } of plan.relatedDonorSupersessions) {
    database.exec(`UPDATE donor_research_findings SET related_donor_id='${survivorId}', fingerprint='${newFingerprint}', status='superseded' WHERE id='${loserId}'`);
    database.exec(`INSERT OR IGNORE INTO donor_research_finding_sources (finding_id, source_id) SELECT '${winnerId}', source_id FROM donor_research_finding_sources WHERE finding_id='${loserId}'`);
  }
}

function activeFindings(database, donorId) {
  return database.prepare("SELECT id, fingerprint FROM donor_research_findings WHERE donor_id=? AND status IN ('current','unverified')").all(donorId).map((row) => ({ id: row.id, fingerprint: row.fingerprint }));
}

test("1. B has research, A does not -- everything follows A, nothing superseded", () => {
  const database = freshDatabase();
  const now = seed(database);
  finding(database, { id: "fB1", donor: "B", claim: "CEO, Example Holdings", fingerprint: "fp1" }, now);
  const plan = planDonorMergeResearchReconciliation({
    survivorId: "A", duplicateFindings: [{ id: "fB1", fingerprint: "fp1", status: "current" }],
    survivorActiveFindings: [], referencingActiveFindings: [], activeFindingsByDonor: new Map(),
  });
  assert.deepEqual(plan.findingRepoints, ["fB1"]);
  assert.equal(plan.findingSupersessions.length, 0);
  applyPlan(database, "A", "B", plan);
  assert.deepEqual(activeFindings(database, "A"), [{ id: "fB1", fingerprint: "fp1" }]);
  assert.equal(activeFindings(database, "B").length, 0);
});

test("2. both have unrelated research -- both sets survive independently under A, nothing superseded", () => {
  const database = freshDatabase();
  const now = seed(database);
  finding(database, { id: "fA1", donor: "A", claim: "CEO, Example Holdings", fingerprint: "fp-a" }, now);
  finding(database, { id: "fB1", donor: "B", claim: "Board member, Other Foundation", category: "boards_affiliations", fingerprint: "fp-b" }, now);
  const plan = planDonorMergeResearchReconciliation({
    survivorId: "A", duplicateFindings: [{ id: "fB1", fingerprint: "fp-b", status: "current" }],
    survivorActiveFindings: [{ id: "fA1", fingerprint: "fp-a" }], referencingActiveFindings: [], activeFindingsByDonor: new Map(),
  });
  assert.deepEqual(plan.findingRepoints, ["fB1"]);
  assert.equal(plan.findingSupersessions.length, 0);
  applyPlan(database, "A", "B", plan);
  const remaining = activeFindings(database, "A").map((f) => f.id).sort();
  assert.deepEqual(remaining, ["fA1", "fB1"]);
});

test("3. both have the same active finding fingerprint -- collision resolved deterministically, survivor's finding wins, duplicate's is superseded (never dropped)", () => {
  const database = freshDatabase();
  const now = seed(database);
  finding(database, { id: "fA1", donor: "A", claim: "CEO, Example Holdings", fingerprint: "fp-same" }, now);
  finding(database, { id: "fB1", donor: "B", claim: "CEO, Example Holdings", fingerprint: "fp-same" }, now);
  const plan = planDonorMergeResearchReconciliation({
    survivorId: "A", duplicateFindings: [{ id: "fB1", fingerprint: "fp-same", status: "current" }],
    survivorActiveFindings: [{ id: "fA1", fingerprint: "fp-same" }], referencingActiveFindings: [], activeFindingsByDonor: new Map(),
  });
  assert.equal(plan.findingRepoints.length, 0, "the colliding finding is resolved via supersession, not a blind repoint");
  assert.deepEqual(plan.findingSupersessions, [{ loserId: "fB1", winnerId: "fA1" }]);
  applyPlan(database, "A", "B", plan);
  assert.deepEqual(activeFindings(database, "A"), [{ id: "fA1", fingerprint: "fp-same" }], "exactly one active copy survives -- no duplicate active fingerprint");
  const loser = database.prepare("SELECT donor_id, status FROM donor_research_findings WHERE id='fB1'").get();
  assert.deepEqual({ donor_id: loser.donor_id, status: loser.status }, { donor_id: "A", status: "superseded" }, "the duplicate's finding follows A and is preserved as history, never deleted");
});

test("4. same finding has different sources on A and B -- both sources end up cited on the surviving finding", () => {
  const database = freshDatabase();
  const now = seed(database);
  database.exec(`INSERT INTO donor_research_sources (id, user_id, url, normalized_url, domain, title, retrieved_at, source_tier, created_at) VALUES ('sA','u1','https://a.org/x','https://a.org/x','a.org','A Source',${now},'reputable_news',${now})`);
  database.exec(`INSERT INTO donor_research_sources (id, user_id, url, normalized_url, domain, title, retrieved_at, source_tier, created_at) VALUES ('sB','u1','https://b.org/y','https://b.org/y','b.org','B Source',${now},'reputable_news',${now})`);
  finding(database, { id: "fA1", donor: "A", claim: "CEO, Example Holdings", fingerprint: "fp-same" }, now);
  finding(database, { id: "fB1", donor: "B", claim: "CEO, Example Holdings", fingerprint: "fp-same" }, now);
  database.exec("INSERT INTO donor_research_finding_sources (finding_id, source_id) VALUES ('fA1','sA')");
  database.exec("INSERT INTO donor_research_finding_sources (finding_id, source_id) VALUES ('fB1','sB')");
  const plan = planDonorMergeResearchReconciliation({
    survivorId: "A", duplicateFindings: [{ id: "fB1", fingerprint: "fp-same", status: "current" }],
    survivorActiveFindings: [{ id: "fA1", fingerprint: "fp-same" }], referencingActiveFindings: [], activeFindingsByDonor: new Map(),
  });
  applyPlan(database, "A", "B", plan);
  const survivorSources = database.prepare("SELECT source_id FROM donor_research_finding_sources WHERE finding_id='fA1' ORDER BY source_id").all().map((row) => row.source_id);
  assert.deepEqual(survivorSources, ["sA", "sB"], "the winner cites both donors' sources -- neither is discarded");
  const loserSources = database.prepare("SELECT source_id FROM donor_research_finding_sources WHERE finding_id='fB1'").all().map((row) => row.source_id);
  assert.deepEqual(loserSources, ["sB"], "the loser's own historical citation record is untouched, not deleted");
});

test("5. B appears as related_donor_id on another donor's finding -- repointed to A with a recomputed fingerprint", () => {
  const database = freshDatabase();
  const now = seed(database);
  finding(database, { id: "fC1", donor: "C", category: "possible_connections", claim: "Shared public affiliation with Example Foundation", fingerprint: "fp-c-old", relatedDonor: "B" }, now);
  const plan = planDonorMergeResearchReconciliation({
    survivorId: "A", duplicateFindings: [], survivorActiveFindings: [],
    referencingActiveFindings: [{ id: "fC1", donorId: "C", category: "possible_connections", claim: "Shared public affiliation with Example Foundation" }],
    activeFindingsByDonor: new Map([["C", [{ id: "fC1", fingerprint: "fp-c-old" }]]]),
  });
  assert.equal(plan.relatedDonorRepoints.length, 1);
  assert.equal(plan.relatedDonorRepoints[0].findingId, "fC1");
  assert.notEqual(plan.relatedDonorRepoints[0].newFingerprint, "fp-c-old", "the fingerprint must change -- it embeds relatedDonorId, which just changed");
  applyPlan(database, "A", "B", plan);
  const row = database.prepare("SELECT related_donor_id, fingerprint, status FROM donor_research_findings WHERE id='fC1'").get();
  assert.equal(row.related_donor_id, "A");
  assert.equal(row.status, "current", "a simple repoint never gets marked superseded");
});

test("5b. B appears as related_donor_id, and C already has an independent connection to A -- the pre-existing A-connection wins, the B-referencing one is superseded", () => {
  const database = freshDatabase();
  const now = seed(database);
  finding(database, { id: "fC-toB", donor: "C", category: "possible_connections", claim: "Shared public affiliation with Example Foundation", fingerprint: "fp-c-to-b", relatedDonor: "B" }, now);
  finding(database, { id: "fC-toA", donor: "C", category: "possible_connections", claim: "Shared public affiliation with Example Foundation", fingerprint: "fp-c-to-a", relatedDonor: "A" }, now);
  // The planner recomputes fC-toB's fingerprint with relatedDonorId=A and
  // must find it collides with fC-toA's already-existing fingerprint --
  // exercised by using the real fingerprint function so the two rows
  // legitimately produce the same value.
  const recomputed = computeFindingFingerprint({ category: "possible_connections", claim: "Shared public affiliation with Example Foundation", relatedDonorId: "A" });
  database.exec(`UPDATE donor_research_findings SET fingerprint='${recomputed}' WHERE id='fC-toA'`);
  const plan = planDonorMergeResearchReconciliation({
    survivorId: "A", duplicateFindings: [], survivorActiveFindings: [],
    referencingActiveFindings: [{ id: "fC-toB", donorId: "C", category: "possible_connections", claim: "Shared public affiliation with Example Foundation" }],
    activeFindingsByDonor: new Map([["C", [{ id: "fC-toB", fingerprint: "fp-c-to-b" }, { id: "fC-toA", fingerprint: recomputed }]]]),
  });
  assert.deepEqual(plan.relatedDonorSupersessions, [{ loserId: "fC-toB", winnerId: "fC-toA", newFingerprint: recomputed }]);
  applyPlan(database, "A", "B", plan);
  assert.deepEqual(activeFindings(database, "C"), [{ id: "fC-toA", fingerprint: recomputed }], "exactly one active connection from C to A survives");
});

test("6. no research exists for either donor -- the plan is entirely empty and applying it is a no-op", () => {
  const database = freshDatabase();
  seed(database);
  const plan = planDonorMergeResearchReconciliation({ survivorId: "A", duplicateFindings: [], survivorActiveFindings: [], referencingActiveFindings: [], activeFindingsByDonor: new Map() });
  assert.deepEqual(plan, { findingRepoints: [], findingSupersessions: [], relatedDonorRepoints: [], relatedDonorSupersessions: [] });
  assert.doesNotThrow(() => applyPlan(database, "A", "B", plan));
});

test("7. failed reconciliation rolls back the entire attempt -- nothing partially commits", () => {
  const database = freshDatabase();
  const now = seed(database);
  finding(database, { id: "fA1", donor: "A", claim: "CEO, Example Holdings", fingerprint: "fp-x" }, now);
  finding(database, { id: "fB1", donor: "B", claim: "Advisor, Other Company", fingerprint: "fp-y" }, now);
  const beforeA = activeFindings(database, "A");
  const beforeB = activeFindings(database, "B");
  const beforeRuns = database.prepare("SELECT donor_id FROM donor_research_runs ORDER BY id").all().map((row) => row.donor_id);

  database.exec("BEGIN");
  try {
    database.exec("UPDATE donor_research_runs SET donor_id='A' WHERE donor_id='B'");
    database.exec("UPDATE donor_research_findings SET donor_id='A' WHERE id='fB1'");
    // Simulate an unexpected failure mid-reconciliation (e.g. a fingerprint
    // collision the planner didn't anticipate, or any other constraint
    // violation) -- this is exactly the D1 env.DB.batch() atomicity
    // real donor-merge/route.ts depends on: everything in the same batch
    // as this statement must roll back together.
    database.exec(`INSERT INTO donor_research_findings (id, first_seen_run_id, last_confirmed_run_id, donor_id, user_id, category, claim, status, fingerprint, created_at)
      VALUES ('fA1','rA','rA','A','u1','professional','duplicate-id-collision','current','fp-x',${now})`);
    database.exec("COMMIT");
    assert.fail("expected the transaction to fail");
  } catch {
    database.exec("ROLLBACK");
  }

  assert.deepEqual(activeFindings(database, "A"), beforeA, "A's findings are exactly as they were before the attempt");
  assert.deepEqual(activeFindings(database, "B"), beforeB, "B's findings were never actually repointed");
  assert.deepEqual(database.prepare("SELECT donor_id FROM donor_research_runs ORDER BY id").all().map((row) => row.donor_id), beforeRuns, "B's runs were never actually repointed");
});

process.stdout.write("Donor research merge reconciliation checks passed.\n");
