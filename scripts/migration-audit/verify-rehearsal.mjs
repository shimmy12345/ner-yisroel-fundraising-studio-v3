// Full read-only aggregate verification of a rehearsal database
// against the frozen export's own manifest (built by
// build-rehearsal-restore-files.mjs). Prints only counts/aggregates/
// booleans -- never row content, except the two specific duplicate-
// giving-activity ids and Goldman's acknowledgment id, which are
// internal record ids/status enums, never donor PII (see
// docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md Section 15.1 for why
// these two ids specifically are checked by name).
//
// Usage: node scripts/migration-audit/verify-rehearsal.mjs <database-name> <restoreDir>
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [db, restoreDir] = process.argv.slice(2);
if (!db || !restoreDir) throw new Error("Usage: node verify-rehearsal.mjs <database-name> <restoreDir>");
const repoRoot = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(fs.readFileSync(`${restoreDir}/manifest.json`, "utf8"));

function q(sql) {
  const out = execSync(`npx --yes wrangler@4.92.0 d1 execute ${db} --remote --command "${sql.replace(/"/g, '\\"')}" --json`, { cwd: repoRoot, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const lines = out.split("\n");
  for (let start = 0; start < lines.length; start++) {
    const candidate = lines.slice(start).join("\n").trim();
    if (!candidate.startsWith("[") && !candidate.startsWith("{")) continue;
    try { return JSON.parse(candidate)?.[0]?.results ?? []; } catch {}
  }
  throw new Error("No JSON found in: " + out);
}

const results = { tables: [], mismatches: [] };

console.log("=== Row-count reconciliation: all 48 migration-eligible tables ===");
const expected = new Map();
for (const t of manifest.tables) expected.set(t.table, t.rows);
for (const [table, expectedRows] of expected) {
  const actualRows = q(`SELECT COUNT(*) AS c FROM "${table}";`)[0]?.c ?? -1;
  let status;
  if (table === "production_schema_baseline") status = actualRows === 1 ? "OK (own fresh marker, by design)" : "MISMATCH";
  else if (table === "onboarding_preferences" || table === "backup_alert_state") status = actualRows === 0 ? "OK (excluded by design)" : "MISMATCH";
  else if (table === "import_preview_sessions" || table === "import_preview_session_chunks") status = actualRows === 0 ? "OK (ephemeral, excluded by design)" : "MISMATCH";
  else status = actualRows === expectedRows ? "MATCH" : "MISMATCH";
  console.log(`  ${table}: expected=${expectedRows} actual=${actualRows} -> ${status}`);
  results.tables.push({ table, expectedRows, actualRows, status });
  if (status === "MISMATCH") results.mismatches.push({ table, expectedRows, actualRows });
}

console.log("\n=== Duplicate-record point-check (internal ids only, docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md Section 15.1) ===");
const dup = q(`SELECT id, workspace_status, committed_cents, paid_cents, balance_cents FROM giving_activities WHERE id IN ('1c3f3d51-4a28-42f5-a3ee-105bc245d7f5','5e29f6c5-b599-4227-9ab8-fc50e7415f28') ORDER BY id;`);
console.log(JSON.stringify(dup, null, 2));
results.duplicateRows = dup;

console.log("\n=== Linked acknowledgment point-check ===");
const ack = q(`SELECT id, gift_source, gift_id, status FROM gift_acknowledgments WHERE gift_id IN ('1c3f3d51-4a28-42f5-a3ee-105bc245d7f5','5e29f6c5-b599-4227-9ab8-fc50e7415f28') ORDER BY id;`);
console.log(JSON.stringify(ack, null, 2));
results.acknowledgmentRows = ack;

console.log("\n=== Negative check: neither duplicate reactivated ===");
const reactivated = q(`SELECT COUNT(*) AS c FROM giving_activities WHERE id IN ('1c3f3d51-4a28-42f5-a3ee-105bc245d7f5','5e29f6c5-b599-4227-9ab8-fc50e7415f28') AND workspace_status='active';`)[0]?.c;
console.log(`reactivated_duplicates: ${reactivated} (must be 0)`);
results.reactivatedDuplicates = reactivated;

console.log("\n=== Financial reconciliation (workspace_status='active' AND record_origin='live') ===");
const fin = q(`SELECT COUNT(*) as total_rows, SUM(ga.committed_cents) as sum_committed_cents, SUM(ga.paid_cents) as sum_paid_cents, SUM(ga.balance_cents) as sum_raw_balance_cents, SUM(COALESCE(pbc.corrected_balance_cents, ga.balance_cents)) as sum_corrected_balance_cents FROM giving_activities ga LEFT JOIN pledge_balance_corrections pbc ON pbc.pledge_activity_id = ga.id AND pbc.reversed_at IS NULL WHERE ga.workspace_status = 'active' AND ga.record_origin = 'live';`)[0];
console.log(JSON.stringify(fin, null, 2));
results.financial = fin;

console.log("\n=== Internal consistency: balance_cents != committed_cents - paid_cents ===");
const inconsistent = q(`SELECT COUNT(*) as c FROM giving_activities WHERE balance_cents IS NOT NULL AND committed_cents IS NOT NULL AND paid_cents IS NOT NULL AND balance_cents != (committed_cents - paid_cents);`)[0]?.c;
console.log(`inconsistent_rows: ${inconsistent} (must be 0)`);
results.inconsistentRows = inconsistent;

console.log("\n=== Active pledge_balance_corrections ===");
const corr = q(`SELECT COUNT(*) as active_corrections, SUM(corrected_balance_cents - imported_balance_cents_at_correction) as net_delta_cents FROM pledge_balance_corrections WHERE reversed_at IS NULL;`)[0];
console.log(JSON.stringify(corr, null, 2));
results.corrections = corr;

console.log("\n=== Primary-key uniqueness spot-check (giving_activities, donors) ===");
const dupGa = q(`SELECT COUNT(*) as c FROM (SELECT id FROM giving_activities GROUP BY id HAVING COUNT(*) > 1);`)[0]?.c;
const dupDonors = q(`SELECT COUNT(*) as c FROM (SELECT id FROM donors GROUP BY id HAVING COUNT(*) > 1);`)[0]?.c;
console.log(`duplicate giving_activities ids: ${dupGa} (must be 0)`);
console.log(`duplicate donors ids: ${dupDonors} (must be 0)`);
results.duplicatePkCheck = { givingActivities: dupGa, donors: dupDonors };

console.log("\n=== Ownership/FK integrity: every ownerUserId resolves to the real users row ===");
const badOwnerDonors = q(`SELECT COUNT(*) as c FROM donors WHERE owner_user_id IS NOT NULL AND owner_user_id NOT IN (SELECT id FROM users);`)[0]?.c;
const badOwnerGiving = q(`SELECT COUNT(*) as c FROM giving_activities WHERE owner_user_id IS NOT NULL AND owner_user_id NOT IN (SELECT id FROM users);`)[0]?.c;
console.log(`donors with unresolved owner_user_id: ${badOwnerDonors} (must be 0)`);
console.log(`giving_activities with unresolved owner_user_id: ${badOwnerGiving} (must be 0)`);
results.ownershipCheck = { badOwnerDonors, badOwnerGiving };

console.log("\n=== Application-level (non-FK-enforced) orphan check: gift_acknowledgments.gift_id -> giving_activities.id ===");
const orphanAck = q(`SELECT COUNT(*) as c FROM gift_acknowledgments WHERE gift_source='giving_activity' AND gift_id NOT IN (SELECT id FROM giving_activities);`)[0]?.c;
console.log(`orphaned gift_acknowledgments (giving_activity source): ${orphanAck} (must be 0)`);
results.orphanAcknowledgments = orphanAck;

console.log("\n=== Application-level orphan check: jl_payment_assignments.pledge targets exist ===");
const orphanAssign = q(`SELECT COUNT(*) as c FROM jl_payment_assignments WHERE pledge_activity_id IS NOT NULL AND pledge_activity_id NOT IN (SELECT id FROM giving_activities);`)[0]?.c;
console.log(`orphaned jl_payment_assignments.pledge_activity_id: ${orphanAssign} (must be 0)`);
results.orphanPaymentAssignments = orphanAssign;

console.log("\n=== pledge_payment_plans / pledge_balance_corrections FK targets exist ===");
const orphanPlans = q(`SELECT COUNT(*) as c FROM pledge_payment_plans WHERE pledge_activity_id NOT IN (SELECT id FROM giving_activities);`)[0]?.c;
const orphanCorr = q(`SELECT COUNT(*) as c FROM pledge_balance_corrections WHERE pledge_activity_id NOT IN (SELECT id FROM giving_activities);`)[0]?.c;
console.log(`orphaned pledge_payment_plans: ${orphanPlans} (must be 0)`);
console.log(`orphaned pledge_balance_corrections: ${orphanCorr} (must be 0)`);
results.orphanPlansCorrections = { orphanPlans, orphanCorr };

console.log("\n=== giving_activity_import_changes.import_id -> data_imports.id ===");
const orphanImportChanges = q(`SELECT COUNT(*) as c FROM giving_activity_import_changes WHERE import_id NOT IN (SELECT id FROM data_imports);`)[0]?.c;
console.log(`orphaned giving_activity_import_changes: ${orphanImportChanges} (must be 0)`);
results.orphanImportChanges = orphanImportChanges;

fs.writeFileSync(`${restoreDir}/verification-results.json`, JSON.stringify(results, null, 2), "utf8");
console.log("\nWrote verification-results.json");
console.log(`\nOVERALL row-count mismatches: ${results.mismatches.length}`);
