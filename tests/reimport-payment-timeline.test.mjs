import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  ACTIVE_PAYMENT_ASSIGNMENTS_SQL,
  blocksIdenticalImport,
  canForceReprocessBatch,
  hasForceReprocessConfirmation,
} from "../lib/import/import-deduplication.ts";

assert.equal(blocksIdenticalImport("active"), true);
assert.equal(blocksIdenticalImport("completed"), true, "an identical still-active completed batch remains blocked");
assert.equal(blocksIdenticalImport("undone"), false, "an undone file can be imported again");
assert.equal(blocksIdenticalImport("failed"), false);
assert.equal(blocksIdenticalImport("rolled_back"), false);
assert.equal(canForceReprocessBatch("owner-1", "owner-1"), true);
assert.equal(canForceReprocessBatch("owner-1", "owner-2"), false, "force reprocess is owner-admin scoped");
assert.equal(hasForceReprocessConfirmation(true, "FORCE REPROCESS"), true);
assert.equal(hasForceReprocessConfirmation(true, "force"), false);
assert.match(ACTIVE_PAYMENT_ASSIGNMENTS_SQL, /INNER JOIN data_imports/);
assert.match(ACTIVE_PAYMENT_ASSIGNMENTS_SQL, /di\.status IN \('active','completed'\)/);

const importRoute = await readFile(new URL("../app/api/import/route.ts", import.meta.url), "utf8");
const previewRoute = await readFile(new URL("../app/api/import/preview/route.ts", import.meta.url), "utf8");
const rollbackRoute = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0011_reimport_and_payment_timeline.sql", import.meta.url), "utf8");

assert.match(importRoute, /status IN \('active','completed'\)/);
assert.match(importRoute, /duplicateBlocked: true/);
assert.match(importRoute, /hasForceReprocessConfirmation/);
assert.match(importRoute, /canForceReprocessBatch/);
assert.match(importRoute, /ACTIVE_PAYMENT_ASSIGNMENTS_SQL/);
assert.match(previewRoute, /ACTIVE_PAYMENT_ASSIGNMENTS_SQL/);
assert.match(importRoute, /paymentDate: candidateByFingerprint/);
assert.match(importRoute, /remainingBalanceCents: assignment\.nextBalanceCents/);
assert.match(importRoute, /await env\.DB\.batch\(statements\)/, "force reprocessing retains atomic transaction protection");
assert.match(rollbackRoute, /DELETE FROM jl_payment_assignments WHERE user_id = \? AND applied_import_id = \?/);
assert.match(rollbackRoute, /status = 'undone'/);
assert.doesNotMatch(rollbackRoute, /SET status = 'rolled_back'/);

assert.match(donorPage, /Payment applied to pledge/);
assert.match(donorPage, /audit\.payment_date/);
assert.match(donorPage, /batch\.status IN \('active','completed'\)/, "undone payment events must leave the timeline");
assert.match(donorPage, /pledge_activity_id/);
assert.match(donorPage, /remaining_balance_cents/);
assert.match(donorPage, /const paid = countedActivities\.reduce/, "only counted giving records contribute to totals, and payment events remain display-only");
assert.doesNotMatch(donorPage, /paid = .*paymentEvents/, "timeline events must not be summed into giving totals");

assert.match(experience, /ADMIN FALLBACK/);
assert.match(experience, /FORCE REPROCESS/);
assert.match(experience, /row-level donor, date, amount, fingerprint, and payment-assignment check/);
assert.match(experience, /will not bypass transaction-level duplicate protection/);
assert.match(migration, /DROP INDEX `data_imports_user_file_hash_unique`/);
assert.match(migration, /data_imports_user_file_hash_status_idx/);
assert.match(migration, /SET `status` = 'undone' WHERE `status` = 'rolled_back'/);
assert.match(migration, /ADD COLUMN `payment_date` integer/);
assert.match(migration, /ADD COLUMN `remaining_balance_cents` integer/);
assert.doesNotMatch(migration, /payment_date`?\s*=\s*`?created_at/, "legacy audits must not invent an actual payment date");

const database = new DatabaseSync(":memory:");
for (const file of (await readdir(new URL("../drizzle", import.meta.url))).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
  const sql = await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) database.exec(statement);
}
const auditColumns = database.prepare("PRAGMA table_info(jl_payment_assignment_audits)").all().map((column) => column.name);
assert.ok(auditColumns.includes("payment_date"));
assert.ok(auditColumns.includes("remaining_balance_cents"));
const importIndexes = database.prepare("PRAGMA index_list(data_imports)").all().map((index) => index.name);
assert.ok(importIndexes.includes("data_imports_user_file_hash_status_idx"));
assert.ok(!importIndexes.includes("data_imports_user_file_hash_unique"));
database.close();

process.stdout.write("Reimport and payment timeline checks passed.\n");
