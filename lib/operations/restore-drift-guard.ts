import { compareSchemaObjects } from "../data-health/production-baseline.ts";
import type { SchemaObject, SchemaComparison } from "../data-health/production-baseline.ts";

// Generic D1 restore/schema drift detection -- the preventative guard for
// the failure class behind GitHub Actions run 36887668901 (D1 monthly
// restore verification, 2026-10-01): migration 0036 added
// donor_source_attributions on feature/independent-cloudflare-sandbox (the
// branch that owns fundraising-os-staging-db's real schema), but main's
// own, separately and manually synced D1_RESTORE_DATA_ORDER/
// production-baseline/schema-manifest.json were never updated to match,
// so main's restore planner rejected a table its own backed-up database
// already contained. That specific table is now fixed and covered by a
// named regression (tests/d1-restore-order.test.mjs,
// test/d1-restore-order.test.mjs) -- but the underlying drift mechanism
// can recur for any future migration, on any future table. Everything here
// is pure and derived entirely from already-canonical inputs (a branch's
// own generated ddlTopology + its own restore-order list) -- it never
// hardcodes a table name, and introduces no second hand-maintained list.

// Every real foreign-key target table name referenced by one CREATE TABLE
// statement, in source order, deduplicated. Self-references (e.g.
// donors.merged_into_donor_id -> donors.id) are included -- callers that
// care about restore ORDERING (where a self-reference can never be
// violated, since inserting the whole table in one pass trivially
// satisfies "the table precedes itself") filter them out explicitly; this
// function stays a faithful, unopinionated extraction of what the SQL
// actually declares.
export function extractForeignKeyTargets(createTableSql: string): string[] {
  const targets: string[] = [];
  const pattern = /REFERENCES\s+`([A-Za-z0-9_]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(createTableSql)) !== null) targets.push(match[1]);
  return [...new Set(targets)];
}

export type RestoreOrderIssue =
  | { kind: "missing_from_order"; table: string }
  | { kind: "fk_order_violation"; table: string; mustFollow: string };

// The single structural invariant a correct D1_RESTORE_DATA_ORDER must
// satisfy relative to a branch's own CURRENT schema (ddlTopology, as
// produced by scripts/generate-production-baseline.mjs's generateBaseline()
// or read from a committed schema-manifest.json): every real table must
// appear somewhere in the order (or be a named, deliberate exclusion from
// DATA restore while its schema is still created -- see skipDataTables),
// and every table with a real foreign key to another table in this same
// schema must be positioned after that parent table. This is exactly what
// planD1Restore (lib/operations/d1-restore-order.ts) needs to be true to
// restore a real export without throwing "not present in the dependency
// order" or producing a live foreign-key violation -- checked here
// entirely offline, without touching D1 at all.
export function validateRestoreOrderAgainstSchema(
  ddlTopology: readonly SchemaObject[],
  restoreOrder: readonly string[],
  skipDataTables: readonly string[] = [],
): RestoreOrderIssue[] {
  const tables = ddlTopology.filter((object) => object.type === "table");
  const tableNames = new Set(tables.map((table) => table.name));
  const orderIndex = new Map(restoreOrder.map((table, index) => [table, index]));
  const skip = new Set(skipDataTables);
  const issues: RestoreOrderIssue[] = [];

  for (const table of tables) {
    if (!orderIndex.has(table.name) && !skip.has(table.name)) {
      issues.push({ kind: "missing_from_order", table: table.name });
      continue;
    }
    if (!orderIndex.has(table.name)) continue; // skip-only table with no order position is reported above only if truly absent
    const ownIndex = orderIndex.get(table.name)!;
    for (const target of extractForeignKeyTargets(table.sql)) {
      if (target === table.name) continue; // self-reference, never an ordering constraint
      if (!tableNames.has(target)) continue; // references a root (users, etc.) or platform table, checked separately by callers that pass roots in restoreOrder
      const targetIndex = orderIndex.get(target);
      if (targetIndex === undefined || targetIndex >= ownIndex) {
        issues.push({ kind: "fk_order_violation", table: table.name, mustFollow: target });
      }
    }
  }
  return issues;
}

export type MigrationListDiff = { onlyOnFeature: string[]; onlyOnMain: string[] };

// Pure set comparison of two branches' own sourceMigrations lists (each
// already derived from that branch's own drizzle/*.sql directory listing
// or committed manifest) -- never re-reads the filesystem itself.
export function diffMigrationLists(featureMigrations: readonly string[], mainMigrations: readonly string[]): MigrationListDiff {
  const mainSet = new Set(mainMigrations);
  const featureSet = new Set(featureMigrations);
  return {
    onlyOnFeature: featureMigrations.filter((migration) => !mainSet.has(migration)),
    onlyOnMain: mainMigrations.filter((migration) => !featureSet.has(migration)),
  };
}

export type CrossBranchRestoreState = {
  ddlTopology: readonly SchemaObject[];
  sourceMigrations: readonly string[];
  restoreOrder: readonly string[];
  skipDataTables: readonly string[];
};

export type CrossBranchDriftReport = {
  inSync: boolean;
  // A: feature has a table main's restore order doesn't know about.
  missingFromMainOrder: string[];
  // B: main's restore order names a table that isn't a real table on
  // either branch's own schema (a stale/removed entry, or a typo) --
  // checked against FEATURE's current schema since that branch owns the
  // real, live table set.
  staleInMainOrder: string[];
  // C: migration list drift (named, not merely counted, so the exact
  // culprit migration is always visible in the failure message).
  migrationDrift: MigrationListDiff;
  // D/E: structural DDL drift for every table present on both branches
  // (new/changed columns, indexes, or constraints) plus any table whose
  // mere presence differs. See the call site below for why this now
  // literally calls lib/data-health/production-baseline.ts's own
  // compareSchemaObjects rather than a second, parallel implementation.
  schemaComparison: SchemaComparison;
  // F: FK-ordering violations evaluated against FEATURE's current schema
  // (the authoritative source of truth for what foreign keys actually
  // exist today) but MAIN's restore order (the thing being validated) --
  // this is what actually catches "a new FK was added and main's order,
  // even if it still lists the table somewhere, no longer restores it in
  // a safe position."
  restoreOrderIssues: RestoreOrderIssue[];
};

// The single entry point: compares one branch's current, generated,
// authoritative restore/schema state ("feature") against another
// branch's committed, possibly-stale mirror of the same kind of state
// ("main"). Pure -- takes plain data for both sides, performs no git or
// file I/O itself, so it is trivially unit-testable with synthetic
// fixtures and reusable from any caller that has already loaded both
// sides' real data (a CI script reading main's files via `git show`, or a
// test file building both sides by hand).
export function compareCrossBranchRestoreState(feature: CrossBranchRestoreState, main: CrossBranchRestoreState): CrossBranchDriftReport {
  const featureTableNames = new Set(feature.ddlTopology.filter((object) => object.type === "table").map((object) => object.name));
  const mainOrderSet = new Set(main.restoreOrder);
  const mainSkipSet = new Set(main.skipDataTables);

  const missingFromMainOrder = [...featureTableNames].filter((table) => !mainOrderSet.has(table) && !mainSkipSet.has(table)).sort();

  // "Real/canonical" roots are never part of a branch's own ddlTopology
  // (production_schema_baseline, users' own account-configuration peers
  // like onboarding_preferences/backup_alert_state/agenda_send_log/
  // agenda_manual_test_send_log) -- they are deliberately prepended to
  // D1_RESTORE_DATA_ORDER by hand (see lib/operations/d1-restore-order.ts's
  // own header comment) and must never be flagged as "stale" merely for
  // not appearing in ddlTopology.
  const ROOT_ALLOWLIST = new Set(["production_schema_baseline", "users", "onboarding_preferences", "backup_alert_state", "agenda_send_log", "agenda_manual_test_send_log"]);
  const staleInMainOrder = [...mainOrderSet].filter((table) => !featureTableNames.has(table) && !ROOT_ALLOWLIST.has(table)).sort();

  const migrationDrift = diffMigrationLists(feature.sourceMigrations, main.sourceMigrations);
  // main is the "live" side being checked, feature is the "baseline"
  // (the canonical, authoritative schema it must match): a table feature
  // has that main lacks reads as "Missing table: X" (main is missing it);
  // a table main has that feature no longer does reads as "Unexpected
  // table: X" (a stale entry on main). This now calls the REAL
  // compareSchemaObjects (lib/data-health/production-baseline.ts)
  // directly instead of a separate, parallel re-implementation -- see
  // that function's own doc comment for why: an earlier round fixed a
  // false-positive there (order-independent table-column comparison,
  // plus a narrow allowlist for two confirmed-dead trip_prospects
  // columns) but this file's own hand-maintained copy was never
  // updated, so it kept reporting those same two tables as "differing"
  // here even after the real check was fixed (2026-11-02, see
  // docs/AI-HANDOFF.md's "Final Schema and Deployment Safeguard
  // Cleanup" entry). Importing the real function directly, rather than
  // duplicating it, makes that class of drift-between-two-copies
  // structurally impossible going forward. It has no live-D1 or other
  // side effect beyond the same static schema-manifest.json import
  // every other caller of this module already needs.
  const schemaComparison = compareSchemaObjects(main.ddlTopology, feature.ddlTopology);
  const restoreOrderIssues = validateRestoreOrderAgainstSchema(feature.ddlTopology, main.restoreOrder, main.skipDataTables);

  const inSync = missingFromMainOrder.length === 0
    && staleInMainOrder.length === 0
    && migrationDrift.onlyOnFeature.length === 0
    && migrationDrift.onlyOnMain.length === 0
    && schemaComparison.matches
    && restoreOrderIssues.length === 0;

  return { inSync, missingFromMainOrder, staleInMainOrder, migrationDrift, schemaComparison, restoreOrderIssues };
}

// Human-readable report, used by both the CI script and anything that
// wants to print this guard's findings without re-deriving the format.
export function formatDriftReport(report: CrossBranchDriftReport): string {
  if (report.inSync) return "D1 restore/schema state on main is in sync with the canonical schema. No drift detected.";
  const lines: string[] = ["D1 restore metadata on main is out of sync with the canonical schema. Sync main before relying on monthly restore verification.", ""];
  if (report.missingFromMainOrder.length) lines.push(`Tables missing from main's restore order: ${report.missingFromMainOrder.join(", ")}`);
  if (report.staleInMainOrder.length) lines.push(`Tables in main's restore order that no longer exist in the canonical schema: ${report.staleInMainOrder.join(", ")}`);
  if (report.migrationDrift.onlyOnFeature.length) lines.push(`Migrations present on the canonical branch but missing from main's manifest: ${report.migrationDrift.onlyOnFeature.join(", ")}`);
  if (report.migrationDrift.onlyOnMain.length) lines.push(`Migrations present on main's manifest but not on the canonical branch: ${report.migrationDrift.onlyOnMain.join(", ")}`);
  if (!report.schemaComparison.matches) { lines.push("Schema/baseline differences:"); for (const difference of report.schemaComparison.differences) lines.push(`  - ${difference}`); }
  if (report.restoreOrderIssues.length) {
    lines.push("Restore-order foreign-key violations:");
    for (const issue of report.restoreOrderIssues) {
      lines.push(issue.kind === "missing_from_order" ? `  - ${issue.table} is not present in main's restore order at all.` : `  - ${issue.table} must be restored after ${issue.mustFollow} (foreign key), but main's restore order does not guarantee that.`);
    }
  }
  return lines.join("\n");
}
