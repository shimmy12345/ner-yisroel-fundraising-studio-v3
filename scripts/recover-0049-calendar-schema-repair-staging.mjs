// ============================================================================
// DRAFT -- PREPARED, NOT RUN. PENDING SEPARATE, EXPLICIT OWNER AUTHORIZATION.
// ============================================================================
// Recovers Staging's calendar_event_links/calendar_event_link_history
// tables from a backup file previously exported by
// scripts/apply-0049-calendar-schema-repair-staging.mjs (or any
// `wrangler d1 export` of Staging). Use this ONLY in the genuinely
// uncertain scenario that script's own error reporting describes: the
// repair batch itself failed with something that does not look like a
// clean, reported rejection, AND read-only inspection of Staging
// afterward shows the two calendar tables in a state that is neither
// clearly the original schema nor clearly the correct repaired result.
//
// Never use this to "undo" a repair that already succeeded and was
// already verified -- D1's own batch atomicity means a cleanly reported
// rejection already left Staging untouched (no recovery needed at all),
// and a failure in a verification step AFTER a successful batch is a
// separate problem that restoring a backup does not fix and would
// actively make worse (it would discard the already-verified repair).
//
// WHY "import this file into the existing database" is not a real
// recovery procedure on its own: a plain `wrangler d1 execute --file
// <backup>` replay of a full export's CREATE TABLE statements fails
// outright with "table already exists" against tables that are still
// there in ANY state. This script instead builds an explicit DROP-then-
// recreate batch (lib/operations/calendar-schema-repair-recovery.ts),
// using the SAME never-drop-a-still-referenced-table ordering the
// repair migration itself proved safe on real D1 (see that module's own
// header), applied as a SINGLE db.batch() for atomicity.
//
// Usage (after separate authorization):
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
//     node scripts/recover-0049-calendar-schema-repair-staging.mjs -- <backup.sql>
// ============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCalendarTablesRecoveryStatements, CALENDAR_EVENT_LINKS_TABLE, CALENDAR_EVENT_LINK_HISTORY_TABLE } from "../lib/operations/calendar-schema-repair-recovery.ts";
import { connectAndValidateStagingTarget } from "./lib/staging-repair-connect.mjs";

const backupArgument = process.argv.slice(2).find((argument) => argument !== "--");
const backupPath = backupArgument ? path.resolve(backupArgument) : null;
if (!backupPath || !fs.existsSync(backupPath)) throw new Error("Usage: node scripts/recover-0049-calendar-schema-repair-staging.mjs -- <backup.sql>");

async function main() {
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN must be set.");
  assert.ok(process.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID must be set.");

  const backupSqlText = fs.readFileSync(backupPath, "utf8");
  console.log(`Parsing recovery statements for ${CALENDAR_EVENT_LINKS_TABLE}/${CALENDAR_EVENT_LINK_HISTORY_TABLE} out of ${backupPath}...`);
  const statements = buildCalendarTablesRecoveryStatements(backupSqlText);
  console.log(`Parsed ${statements.length} statements.`);

  const { db, dispose } = await connectAndValidateStagingTarget();
  try {
    console.log("Applying the recovery batch (single db.batch() call) against the REAL remote Staging D1 binding...");
    await db.batch(statements.map((statement) => db.prepare(statement)));
    console.log("Recovery batch applied.");

    const links = (await db.prepare("SELECT COUNT(*) AS n FROM calendar_event_links").all())?.results?.[0]?.n;
    const history = (await db.prepare("SELECT COUNT(*) AS n FROM calendar_event_link_history").all())?.results?.[0]?.n;
    console.log(`Recovered: ${links} link row(s), ${history} history row(s) -- confirm these match the backup file before considering recovery complete.`);
  } finally {
    await dispose();
  }
}

// Forced exit, same reasoning and same bug as
// scripts/apply-0049-calendar-schema-repair-staging.mjs's own main()
// call site: connectAndValidateStagingTarget() (shared by both scripts)
// can leave an orphaned local process running after a failed
// getPlatformProxy() remote-session startup, even once this script has
// already caught and reported the error -- only once main() has FULLY
// settled.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nRECOVERY ABORTED:", error.message);
    console.error(
      "This recovery batch is a single db.batch() call, same atomicity guarantee as the repair migration itself: a clean, reported rejection means nothing changed. If this instead failed with a network/timeout-shaped error, whether it committed is genuinely uncertain -- re-run the read-only inspection queries from scripts/apply-0049-calendar-schema-repair-staging.mjs's own failure guidance before any further action, never assume either outcome.",
    );
    process.exit(1);
  });
