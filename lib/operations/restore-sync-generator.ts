// Pure, conservative generator for the minimal main-branch restore/
// baseline synchronization patch -- the automation layer behind the
// "D1 restore/schema sync check" workflow's new `prepare-sync` job (see
// docs/AI-HANDOFF.md's "D1 Migration Sync Automation" entry and
// docs/D1-MIGRATION-SYNC-PROCESS.md for the full design and operating
// rules). This module never touches git, the filesystem, or D1 -- it
// takes plain data (the same CrossBranchRestoreState shape
// scripts/check-main-restore-sync.mjs already loads) and plain SQL text,
// and returns a plain decision: either a safe, minimal, fully-verified
// patch plan, or a specific refusal reason. No I/O, trivially
// unit-testable with synthetic fixtures (tests/restore-sync-generator.
// test.mjs), exactly like lib/operations/restore-drift-guard.ts.
//
// CONSERVATIVE BY DESIGN (per explicit product decision): this generator
// only ever attempts migrations/schema shapes it can prove, by
// construction, are pure additions -- new columns/indexes, never a
// removed, renamed, retyped, or reordered column/index, and never a new
// or removed TABLE (restore-order placement for a new table requires
// human judgment about its real FK dependencies and is deliberately left
// to the existing, unchanged manual-sync process -- see
// docs/D1-MIGRATION-SYNC-PROCESS.md). Anything outside this narrow shape
// is refused, never attempted, matching the product's own earlier
// commitment from its own prior narrow-sync rounds (see docs/
// AI-HANDOFF.md's "D1 Monthly Restore Verification Repair" history) that
// a human decides table placement, never automation.
//
// SELF-VERIFYING, not merely a heuristic: after the conservative checks
// below pass, this module builds the CANDIDATE patched main state and
// re-runs it through the EXACT SAME compareCrossBranchRestoreState
// function the authoritative `check` job uses. A plan is only ever
// returned as `safe: true` if that re-run independently confirms
// `inSync: true` -- so even a gap in the conservative checks below could
// never let an actually-incomplete patch through silently; the
// authoritative comparison is the true backstop, the checks above exist
// only to produce specific, readable refusal reasons for the common
// unsafe cases rather than a generic "still drifted" dump.

import type { SchemaObject } from "../data-health/production-baseline.ts";
import { compareCrossBranchRestoreState, diffMigrationLists, formatDriftReport, type CrossBranchRestoreState } from "./restore-drift-guard.ts";

const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

// A migration file's raw SQL containing any of these is never eligible
// for automatic sync -- a DROP/RENAME can look like "add a field +
// remove a field" in a pure DDL-topology diff (exactly what a column
// rename would produce), which the field-subsequence check below cannot
// distinguish from a genuine addition-plus-unrelated-removal. Checked on
// the RAW migration SQL text (not the derived ddlTopology), so it
// catches intent the DDL diff alone cannot.
const DESTRUCTIVE_SQL_PATTERN = /\bDROP\s+COLUMN\b|\bDROP\s+TABLE\b|\bRENAME\b/i;

export function scanForDestructiveKeywords(migrationSqlByFile: Readonly<Record<string, string>>): string | null {
  for (const [file, sql] of Object.entries(migrationSqlByFile)) {
    if (DESTRUCTIVE_SQL_PATTERN.test(sql)) return `Migration ${file} contains a DROP/RENAME statement -- not automated, prepare this sync manually (see docs/D1-MIGRATION-SYNC-PROCESS.md).`;
  }
  return null;
}

// Splits a CREATE TABLE statement's own parenthesized body into its
// top-level comma-separated fields (columns, FOREIGN KEY/CHECK/PRIMARY
// KEY clauses), respecting nested parens (e.g. an inline CHECK(...) or a
// REFERENCES `table`(`col`) clause) so a comma inside one of those never
// splits a field in two. Returns null if the SQL doesn't have the
// expected CREATE TABLE `name` ( ... ) shape at all -- a defensive
// refusal signal, not an exception, since malformed input here should
// fall back to "prepare manually," never a thrown error.
export function tableFieldsFromSql(createTableSql: string): string[] | null {
  const openIndex = createTableSql.indexOf("(");
  const closeIndex = createTableSql.lastIndexOf(")");
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) return null;
  const body = createTableSql.slice(openIndex + 1, closeIndex);
  const fields: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) fields.push(current.trim());
  return fields.length > 0 ? fields : null;
}

// True only when every field in `older` appears, verbatim, somewhere in
// `newer`, in the SAME RELATIVE ORDER (a classic subsequence check) --
// `newer` may freely have additional fields inserted anywhere (that's
// the only kind of change this generator ever auto-syncs). A field whose
// TEXT changed at all (a retyped column, a widened CHECK, a changed
// constraint) will not be found verbatim in `newer`, so the subsequence
// fails and the caller refuses -- this is deliberately exact-text
// matching, never a fuzzy/semantic comparison, so there is no judgment
// call this function could get wrong.
export function isSubsequence(older: readonly string[], newer: readonly string[]): boolean {
  let i = 0;
  for (const field of newer) {
    if (i < older.length && field === older[i]) i++;
  }
  return i === older.length;
}

export type RestoreSyncPlan =
  | { safe: true; alreadySynced: true }
  | { safe: true; alreadySynced: false; migrations: string[]; newMigrationCount: number }
  | { safe: false; reason: string };

// The single entry point. `feature` is this branch's own current,
// generated, authoritative state (same shape scripts/check-main-restore-
// sync.mjs already builds via generateBaseline() + lib/operations/
// d1-restore-order.ts); `main` is origin/main's committed mirror of the
// same shape; `migrationSqlByFile` is the raw SQL text of every
// migration file present on the feature branch but not on main (the
// candidates for this sync), keyed by filename -- the caller is
// responsible for fetching exactly these, never more.
export function planRestoreSyncPatch(
  feature: CrossBranchRestoreState,
  main: CrossBranchRestoreState,
  migrationSqlByFile: Readonly<Record<string, string>>,
): RestoreSyncPlan {
  const migrationDrift = diffMigrationLists(feature.sourceMigrations, main.sourceMigrations);

  if (migrationDrift.onlyOnFeature.length === 0 && migrationDrift.onlyOnMain.length === 0) {
    const report = compareCrossBranchRestoreState(feature, main);
    if (report.inSync) return { safe: true, alreadySynced: true };
    // Migration lists already match but some OTHER drift remains (e.g. a
    // hand-edited restore-order file drifted independently of any
    // migration) -- outside this generator's narrow, migration-driven
    // scope entirely; never attempted.
    return { safe: false, reason: `Migration lists already match, but other drift remains (not migration-driven, outside this generator's scope):\n${formatDriftReport(report)}` };
  }

  if (migrationDrift.onlyOnMain.length > 0) {
    return { safe: false, reason: `main's manifest lists migration(s) absent from the canonical branch: ${migrationDrift.onlyOnMain.join(", ")}. This generator only ever handles main being BEHIND the canonical branch, never AHEAD of or diverged from it -- prepare this sync manually.` };
  }

  const destructiveReason = scanForDestructiveKeywords(migrationSqlByFile);
  if (destructiveReason) return { safe: false, reason: destructiveReason };

  const featureByKey = new Map<string, SchemaObject>(feature.ddlTopology.map((object) => [`${object.type}:${object.name}`, object]));
  const mainByKey = new Map<string, SchemaObject>(main.ddlTopology.map((object) => [`${object.type}:${object.name}`, object]));

  const newTables = [...featureByKey.values()].filter((object) => object.type === "table" && !mainByKey.has(`table:${object.name}`)).map((object) => object.name).sort();
  if (newTables.length > 0) return { safe: false, reason: `New table(s) introduced: ${newTables.join(", ")}. Restore-order placement for a new table requires human judgment about its real foreign-key dependencies and is deliberately not automated -- prepare this sync manually (see docs/D1-MIGRATION-SYNC-PROCESS.md).` };

  for (const [key, mainObject] of mainByKey) {
    const featureObject = featureByKey.get(key);
    const label = mainObject.type === "table" ? "Table" : "Index";
    if (!featureObject) return { safe: false, reason: `${label} removed from the canonical branch: ${mainObject.name}. Not automated -- prepare this sync manually.` };
    if (normalize(mainObject.sql) === normalize(featureObject.sql)) continue;
    if (mainObject.type === "index") return { safe: false, reason: `Index definition changed: ${mainObject.name}. Not automated -- prepare this sync manually.` };

    const mainFields = tableFieldsFromSql(mainObject.sql);
    const featureFields = tableFieldsFromSql(featureObject.sql);
    if (mainFields === null || featureFields === null) return { safe: false, reason: `Could not parse the column list for table ${mainObject.name} -- prepare this sync manually.` };
    if (!isSubsequence(mainFields, featureFields)) return { safe: false, reason: `Table ${mainObject.name} changed in a way that is not a pure column/constraint addition (something may have been removed, renamed, retyped, or reordered). Not automated -- prepare this sync manually.` };
  }

  // Self-verification backstop -- see this module's own header comment.
  // No new/removed table or index exists at this point (checked above),
  // so main's own restoreOrder/skipDataTables never need to change for
  // this generator's narrow scope; only ddlTopology/sourceMigrations
  // move to match the canonical branch.
  const candidateMain: CrossBranchRestoreState = {
    ddlTopology: feature.ddlTopology,
    sourceMigrations: feature.sourceMigrations,
    restoreOrder: main.restoreOrder,
    skipDataTables: main.skipDataTables,
  };
  const verifyReport = compareCrossBranchRestoreState(feature, candidateMain);
  if (!verifyReport.inSync) {
    return { safe: false, reason: `This generator's own conservative checks passed, but the resulting patch does not independently verify as fully synchronized (this is the generator's own safety backstop catching a gap in its rules, not a known failure mode) -- prepare this sync manually:\n${formatDriftReport(verifyReport)}` };
  }

  return { safe: true, alreadySynced: false, migrations: migrationDrift.onlyOnFeature, newMigrationCount: feature.sourceMigrations.length };
}

export type ProductionBaselineTsPatchResult = { ok: true; newText: string } | { ok: false; reason: string };

// Rewrites ONLY the PRODUCTION_BASELINE_VERIFIED assertion line and its
// own immediately-preceding doc-comment block in lib/data-health/
// production-baseline.ts's text -- every other line is returned
// byte-identical. The generated comment is deliberately templated/
// mechanical rather than the richer hand-written prose every prior
// manual sync round used (see docs/AI-HANDOFF.md) -- an accepted,
// documented trade-off for automation; the file remains fully correct
// and traceable (migration names, count, and generation timestamp are
// all present), just less narrative.
export function renderProductionBaselineTsPatch(oldFileText: string, newMigrationCount: number, syncedMigrations: readonly string[], generatedAtIso: string): ProductionBaselineTsPatchResult {
  const assertionPattern = /export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && \/\^\[a-f0-9\]\{64\}\$\/\.test\(PRODUCTION_BASELINE_HASH\) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS\.length === \d+;/;
  const lines = oldFileText.split("\n");
  const assertionLineIndex = lines.findIndex((line) => assertionPattern.test(line));
  if (assertionLineIndex === -1) return { ok: false, reason: "Could not locate the PRODUCTION_BASELINE_VERIFIED assertion line -- file shape has changed since this generator was written; prepare this sync manually." };

  let commentStart = assertionLineIndex;
  while (commentStart > 0 && lines[commentStart - 1].trim().startsWith("//")) commentStart--;

  const newAssertionLine = `export const PRODUCTION_BASELINE_VERIFIED = PRODUCTION_BASELINE_LEVEL === "0019" && /^[a-f0-9]{64}$/.test(PRODUCTION_BASELINE_HASH) && PRODUCTION_BASELINE_SOURCE_MIGRATIONS.length === ${newMigrationCount};`;
  const newComment = [
    `// ${newMigrationCount} as of ${syncedMigrations[syncedMigrations.length - 1]}`,
    syncedMigrations.length > 1 ? `// -- this sync covers ${syncedMigrations.length} migrations in one pass:` : null,
    syncedMigrations.length > 1 ? `// ${syncedMigrations.join(", ")}.` : null,
    `// Automated sync, generated ${generatedAtIso} by scripts/prepare-main-`,
    `// restore-sync-patch.mjs (see docs/D1-MIGRATION-SYNC-PROCESS.md).`,
    `// production-baseline/schema-manifest.json was replaced verbatim from`,
    `// feature/independent-cloudflare-sandbox's own current, verified`,
    `// manifest -- the same sync mechanism used for every prior round (see`,
    `// docs/AI-HANDOFF.md's "D1 Monthly Restore Verification Repair"`,
    `// entries). PRODUCTION_BASELINE_LEVEL stays "0019": that label`,
    `// identifies the single bootstrap file's origin, not its current`,
    `// contents.`,
  ].filter((line): line is string => line !== null);

  const newLines = [...lines.slice(0, commentStart), ...newComment, newAssertionLine, ...lines.slice(assertionLineIndex + 1)];
  return { ok: true, newText: newLines.join("\n") };
}
