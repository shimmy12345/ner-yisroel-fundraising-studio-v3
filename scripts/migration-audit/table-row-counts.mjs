// Read-only row-count inventory for the donor-data migration audit
// (docs/PRODUCTION-DONOR-DATA-MIGRATION-AUDIT.md). Prints a per-table
// `SELECT COUNT(*)` for every application table against a given D1
// database, via `wrangler d1 execute --remote`.
//
// SAFE BY CONSTRUCTION, not just by convention: every statement this
// script can ever send is built here, from the fixed TABLE_NAMES list
// below, as exactly `SELECT COUNT(*) FROM "<name>"` -- there is no user-
// input concatenation path, no flag to switch it to write mode, and no
// other statement shape it knows how to produce. It never passes
// `--yes`/`-y` to anything destructive and never calls any wrangler
// subcommand other than `d1 execute --remote --command`.
//
// Usage: node scripts/migration-audit/table-row-counts.mjs <database-name>
// Example: node scripts/migration-audit/table-row-counts.mjs fundraising-os-staging-db
//
// TABLE_NAMES mirrors the 54 real tables confirmed live in both
// Independent Staging and Independent Production on 2026-10-11 (see the
// audit doc's table inventory). If a future migration adds a table, add
// its name here too -- this list is a deliberate, explicit snapshot (same
// "fail loudly, never silently drift" philosophy as this codebase's own
// D1_RESTORE_DATA_ORDER/FUNDRAISING_DATA_TABLES), not something this
// script derives automatically from the live schema.
import { execSync } from "node:child_process";

// Closed allowlist of the only two databases this audit ever concerns --
// deliberately not "any string the caller passes," so this script can
// never be pointed at an unexpected database by a typo or a copy-paste
// mistake.
const ALLOWED_DATABASES = ["fundraising-os-staging-db", "fundraising-os-production-db"];

const TABLE_NAMES = [
  "activity_status_audits", "ask_changes", "asks", "backup_alert_state",
  "data_health_repair_audits", "data_imports", "donation_import_rollback_audits",
  "donor_contact_audits", "donor_historical_context", "donor_merge_audits",
  "donor_rebbeim", "donor_relationship_fact_changes", "donor_relationship_facts",
  "donor_research_finding_sources", "donor_research_findings",
  "donor_research_identity_candidates", "donor_research_pending_evidence",
  "donor_research_runs", "donor_research_sources", "donor_source_attributions",
  "donor_views", "donors", "gift_acknowledgments", "gifts", "giving_activities",
  "giving_activity_import_changes", "giving_activity_management_audits",
  "household_import_changes", "household_import_rollback_audits",
  "import_preview_session_chunks", "import_preview_sessions",
  "important_date_changes", "important_dates", "interactions",
  "jl_payment_assignment_audits", "jl_payment_assignments", "jl_refresh_state",
  "legacy_test_cleanup_audits", "onboarding_preferences",
  "pledge_balance_corrections", "pledge_payment_plan_changes",
  "pledge_payment_plan_reviews", "pledge_payment_plans",
  "production_schema_baseline", "rebbeim", "recommendations",
  "relationship_queue_dismissals", "sample_cleanup_audits", "shared_activities",
  "shared_activity_recipient_audits", "users", "workspace_backup_audits",
  "yahrtzeit_changes", "yahrtzeits",
];

const databaseName = process.argv[2];
if (!ALLOWED_DATABASES.includes(databaseName)) {
  console.error(`Usage: node table-row-counts.mjs <database-name>\nAllowed: ${ALLOWED_DATABASES.join(", ")}`);
  process.exit(1);
}

// Cloudflare's D1 HTTP API occasionally returns a transient error (seen in
// practice: APIError code 10000) under rapid back-to-back calls -- one
// retry after a short pause resolves it every time observed. A table that
// still fails after the retry is recorded as "error", never silently
// dropped or treated as 0, so a real outage is visible in the output
// rather than misread as "this table is empty."
function sleep(ms) {
  execSync(`node -e "setTimeout(()=>{}, ${ms})"`);
}

function countTable(databaseName, table) {
  const sql = `SELECT COUNT(*) as cnt FROM \\"${table}\\"`;
  const out = execSync(
    `npx --yes wrangler@4.92.0 d1 execute ${databaseName} --remote --command "${sql}" --json`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0].results[0].cnt;
}

const counts = {};
const errors = {};
for (const table of TABLE_NAMES) {
  try {
    counts[table] = countTable(databaseName, table);
  } catch (firstError) {
    sleep(1500);
    try {
      counts[table] = countTable(databaseName, table);
    } catch (secondError) {
      errors[table] = secondError.message.slice(0, 300);
      counts[table] = "error";
    }
  }
}

console.log(JSON.stringify(counts, null, 2));
const total = Object.values(counts).filter((v) => typeof v === "number").reduce((a, b) => a + b, 0);
console.error(`\n${Object.keys(counts).length} tables, ${total} total rows summed over non-error tables, database: ${databaseName}`);
if (Object.keys(errors).length > 0) {
  console.error(`\n${Object.keys(errors).length} table(s) failed after retry -- re-run for just these:`);
  for (const [table, message] of Object.entries(errors)) console.error(`  ${table}: ${message}`);
  process.exitCode = 1;
}
