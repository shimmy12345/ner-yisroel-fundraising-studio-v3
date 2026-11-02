import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { D1_RESTORE_DATA_ORDER, parseRestoreStatements, planD1Restore, reorderD1ExportForRestore } from "../lib/operations/d1-restore-order.ts";

// Repair and Verify Backup Restoration (2026-11-02, see docs/AI-HANDOFF.md).
// scripts/verify-remote-restore.mjs -- what BOTH monthly restore-verification
// GitHub Actions workflows (Staging and Production) actually run -- used to
// restore a `wrangler d1 export` file with a single, unordered
// `wrangler d1 execute --remote --file=...` call. A real disposable-database
// test against a real, freshly exported backup failed with exactly "no such
// table: main.users: SQLITE_ERROR": `wrangler d1 export` orders statements by
// each table's position in sqlite_master, not by foreign-key dependency (a
// child row like `donors`, which has a foreign key to `users`, is exported
// before `users` itself), and D1's bulk Import pipeline does not honor
// `PRAGMA defer_foreign_keys=TRUE` across the internal batches it splits a
// large file into. lib/operations/d1-restore-order.ts (ported from main's
// own already-proven fix, commits 92e0bfd/6875786) already contained the
// correct fix -- a dependency-safe restore order plus oversized-statement
// chunking -- but scripts/verify-remote-restore.mjs had never been updated
// to call it, so the fix existed without being wired into the one script
// that actually matters. This file guards specifically against that
// integration gap recurring silently (the pure ordering logic itself is
// already extensively covered by tests/d1-restore-order.test.mjs).

const root = path.resolve(import.meta.dirname, "..");
const scriptPath = path.join(root, "scripts/verify-remote-restore.mjs");
const scriptText = fs.readFileSync(scriptPath, "utf8");

// ---- 1. Static wiring: the script must route through the dependency-safe
// planner, and must never regress to a single raw, unordered restore of
// the whole export file. ----
{
  assert.match(scriptText, /from\s+"\.\.\/lib\/operations\/d1-restore-order\.ts"/, "scripts/verify-remote-restore.mjs must import from lib/operations/d1-restore-order.ts (the dependency-safe restore planner) -- this is the exact wiring that was missing when a real restore failed with a foreign-key ordering error.");
  assert.match(scriptText, /planD1Restore\(/, "scripts/verify-remote-restore.mjs must call planD1Restore() -- restoring an export without first planning a dependency-safe order is the defect this test guards against.");

  // The specific regressed shape: a single wrangler call restoring the
  // ENTIRE backup file directly (--file <the whole decrypted backup path>)
  // with no per-table/per-step breakdown in between. Matching only the
  // narrow, concrete old pattern (not merely "contains --file", which the
  // fixed version also legitimately uses per-step) keeps this a precise
  // regression guard rather than a brittle structural assertion.
  assert.doesNotMatch(
    scriptText,
    /"d1",\s*"execute",\s*scratchDatabaseName,\s*"--remote",\s*"--file",\s*backupPath,\s*"--yes"/,
    "scripts/verify-remote-restore.mjs must never restore the raw backup file directly in one unordered wrangler call -- this exact pattern is what failed against a real export with 'no such table: main.users'.",
  );
}

// ---- 2. Behavioral reproduction of the real failure, using the real
// schema's own users/donors foreign key, through the exact function the
// script now calls (planD1Restore) -- not a synthetic unrelated pair of
// tables. ----
function buildExport(tables, insertsInOrder) {
  const lines = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const table of tables) lines.push(`CREATE TABLE "${table}" (id text);`);
  for (const [table, id] of insertsInOrder) lines.push(`INSERT INTO "${table}" (id) VALUES('${id}');`);
  return lines.join("\n") + "\n";
}

{
  // Mirrors the real `wrangler d1 export` shape that triggered the actual
  // failure: `donors` (a real foreign key to `users.id`) exported and
  // inserted BEFORE `users` -- the opposite of what a naive single-file
  // restore needs.
  const forwardReferenceExport = buildExport(["donors", "users"], [["donors", "donor-1"], ["users", "user-1"]]);

  const plan = planD1Restore(forwardReferenceExport);
  const stepTables = plan.steps.map((step) => step.table);
  assert.ok(stepTables.includes("users") && stepTables.includes("donors"), "planD1Restore must produce restore steps for both users and donors");
  assert.ok(stepTables.indexOf("users") < stepTables.indexOf("donors"), "users must be restored before donors even though the export file itself lists donors first -- this is the exact forward foreign-key reference that caused the real 'no such table: main.users' failure.");

  const reordered = reorderD1ExportForRestore(forwardReferenceExport);
  const parsed = parseRestoreStatements(reordered);
  const usersStatementIndex = reordered.indexOf([...parsed.insertsByTable.get("users")][0]);
  const donorsStatementIndex = reordered.indexOf([...parsed.insertsByTable.get("donors")][0]);
  assert.ok(usersStatementIndex < donorsStatementIndex, "reorderD1ExportForRestore's own output must place the users INSERT before the donors INSERT");
}

// ---- 3. D1_RESTORE_DATA_ORDER must be derived from and cover the real,
// current schema -- not a fixed list that silently stops matching it (same
// property tests/d1-restore-order.test.mjs's Section 6 already proves;
// re-asserted narrowly here as a precondition for this file's own claims
// about the real users/donors relationship). ----
{
  assert.ok(D1_RESTORE_DATA_ORDER.includes("users"), "D1_RESTORE_DATA_ORDER must include users");
  assert.ok(D1_RESTORE_DATA_ORDER.includes("donors"), "D1_RESTORE_DATA_ORDER must include donors");
  assert.ok(D1_RESTORE_DATA_ORDER.indexOf("users") < D1_RESTORE_DATA_ORDER.indexOf("donors"), "users must precede donors in D1_RESTORE_DATA_ORDER (donors.user_id is a real foreign key to users.id)");
}

// ---- 4. Historical Backup Schema Validation follow-up (2026-11-02, GitHub
// Actions run 41466993401): once the fix above let a real run reach
// schema validation, it correctly restored an older Staging backup but
// then failed that check -- it compared the restored schema against
// TODAY's packaged manifest, which already includes a later migration's
// index (migration 0056's trips_owner_archived_idx) that had not yet
// been applied to the real database when that backup was taken. An
// older backup can never match a newer baseline; that is expected, not
// corruption. The comparison must use the backup's OWN embedded schema
// (backupSchemaObjects(), lib/data-health/production-baseline.ts) as its
// authoritative baseline instead. ----
{
  assert.match(scriptText, /backupSchemaObjects\(/, "scripts/verify-remote-restore.mjs must call backupSchemaObjects() -- comparing a restored backup's schema against anything other than that backup's OWN embedded schema is the defect this test guards against.");
  assert.match(scriptText, /compareSchemaObjects\(stagingSchemaObjects\(schemaRows\),\s*backupSchema\)/, "the authoritative schema comparison must pass the backup's own schema as compareSchemaObjects()'s baseline argument, not rely on its default (today's packaged manifest).");
}

// ---- 5. Row counts must be checked against the SOURCE BACKUP's own
// count, not merely "is a valid non-negative integer" -- the prior
// version of this check could never catch a restore that silently
// dropped every row of a table, since zero also passes that assertion.
// ----
{
  assert.match(scriptText, /insertsByTable\.get\(table\)/, "row counts must be computed from the source backup's own parsed INSERT statements per table, not asserted as merely present.");
  assert.doesNotMatch(
    scriptText,
    /assert\.ok\(countResult && Number\.isInteger\(countResult\.count\) && countResult\.count >= 0, `Table "\$\{table\}" did not return a valid row count after restore: \$\{JSON\.stringify\(countResult\)\}`\);\s*\n\s*rowCounts\[table\] = countResult\.count;\s*\n\s*\}\s*\n\s*\n\s*console\.log\(`Restore verification passed\. Row counts/,
    "row-count verification must not regress to only checking that a count is a valid non-negative integer (which a fully-empty, silently-corrupted table would also pass).",
  );
}

process.stdout.write("verify-remote-restore-wiring.test.mjs: all assertions passed\n");
