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

process.stdout.write("verify-remote-restore-wiring.test.mjs: all assertions passed\n");
