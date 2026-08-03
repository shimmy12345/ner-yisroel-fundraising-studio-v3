import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildDonationRollbackPreview } from "../lib/import/donation-rollback.ts";

const changes = [
  { source_fingerprint: "new-gift", change_type: "insert", previous_json: null },
  { source_fingerprint: "pledge-update", change_type: "update", previous_json: JSON.stringify({ paid_cents: 2500, balance_cents: 7500, category: "partially_paid_pledge", source_snapshot: "{\"before\":true}" }) },
];
const current = [
  { source_fingerprint: "new-gift", donor_id: "donor-a", donor_name: "Alpha Household", activity_date: 1785715200, amount_cents: 5000, paid_cents: 5000, balance_cents: 0, category: "completed_gift", description: "New payment", source_snapshot: "{}" },
  { source_fingerprint: "pledge-update", donor_id: "donor-b", donor_name: "Beta Household", activity_date: 1785628800, amount_cents: 10000, paid_cents: 10000, balance_cents: 0, category: "completed_gift", description: "Annual pledge", source_snapshot: "{\"after\":true}" },
];

const preview = buildDonationRollbackPreview(changes, current);
assert.equal(preview.safe, true);
assert.deepEqual(preview.totals, { newGiftsRemoved: 1, pledgeUpdatesRestored: 1, balancesRestored: 1, statusesRestored: 1 });
assert.equal(preview.restoreStates[0].paid_cents, 2500);
assert.equal(preview.restoreStates[0].balance_cents, 7500);
assert.equal(preview.newGifts[0].donorId, "donor-a");

const missingGift = buildDonationRollbackPreview(changes, current.slice(1));
assert.equal(missingGift.safe, false, "rollback must be blocked if a batch-created gift is no longer present");

const incompleteBefore = buildDonationRollbackPreview(
  [{ source_fingerprint: "pledge-update", change_type: "update", previous_json: JSON.stringify({ paid_cents: 0 }) }],
  current.slice(1),
);
assert.equal(incompleteBefore.safe, false, "rollback must be blocked without every required before-value");

const route = await readFile(new URL("../app/api/import/rollback/route.ts", import.meta.url), "utf8");
const page = await readFile(new URL("../app/onboarding/import/page.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../app/onboarding/import/ImportExperience.tsx", import.meta.url), "utf8");
const backupRoute = await readFile(new URL("../app/api/import/backup/route.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../drizzle/0009_donation_import_rollback_audit.sql", import.meta.url), "utf8");
assert.match(route, /Only the most recent completed donation import can be reversed/);
assert.match(route, /backupConfirmed/);
assert.match(route, /workspace_backup_audits/);
assert.match(route, /confirmation !== "UNDO"/);
assert.match(route, /donation_import_rollback_audits/);
assert.match(route, /owner_user_id = \?/);
assert.match(route, /external_source = 'JL Solutions'/);
assert.match(route, /await env\.DB\.batch\(statements\)/);
assert.doesNotMatch(route, /activity_date\s*[<>=]/, "rollback must never identify deletions by date");
assert.match(page, /latestCompletedDonationId/);
assert.match(experience, /Batch ID:/);
assert.match(experience, /UndoDonationImport/);
assert.match(backupRoute, /x-workspace-backup-id/);
assert.match(backupRoute, /givingActivityImportChanges/);
assert.match(migration, /UNIQUE INDEX `donation_import_rollback_audits_import_idx`/);

process.stdout.write("Donation import rollback checks passed.\n");
