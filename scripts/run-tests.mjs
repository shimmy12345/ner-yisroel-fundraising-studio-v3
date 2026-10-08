// Test runner for `pnpm test` (2026-10-08). Replaces the previous
// package.json script, which chained every test file with `&&`:
// `node tests/a.test.mjs && node tests/b.test.mjs && ...`. That meant
// ONE test file throwing an uncaught exception (rather than failing
// cleanly) silently aborted the whole chain -- every file listed after
// it never ran at all, with no indication in the output that anything
// was skipped. Found via `tests/backup-watchdog-scheduled.test.mjs`
// going from passing to deterministically failing (a real, unrelated
// latent bug -- see status-worker/src/index.ts's own fix comment) and
// quietly hiding 9 other test files, including coverage for the pledge-
// review UI and Payment-Plan Intelligence, behind it every single run.
//
// This runs every file in TEST_FILES sequentially (preserving the exact
// order the old chained script used -- test files are independent, pure-
// function/mocked-I-O unit tests throughout this codebase, but keeping
// the proven order is strictly lower-risk than switching to directory
// order), in its own child process via spawnSync with inherited stdio
// (so output streams live, exactly as before). A file that fails -- exit
// code non-zero OR an uncaught exception -- is recorded and execution
// CONTINUES to every remaining file, never stopping the run. Exits 1 if
// any file failed, 0 only if every file passed; prints a summary tally
// either way so a failure is always visible, never silent.
//
// Self-check (warn, not fail): after running, compares TEST_FILES
// against a fresh directory listing of tests/*.test.mjs so a file added
// to one but not the other is flagged immediately, rather than quietly
// drifting the way the old hardcoded `&&` chain itself could (and did).

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

const TEST_FILES = [
  "tests/foundation.test.mjs",
  "tests/local-time.test.mjs",
  "tests/reminder-timezone.test.mjs",
  "tests/capture.test.mjs",
  "tests/assistant.test.mjs",
  "tests/import.test.mjs",
  "tests/donations.test.mjs",
  "tests/import-review.test.mjs",
  "tests/import-upload-detection.test.mjs",
  "tests/import-cross-import-duplicates.test.mjs",
  "tests/import-rejected-rows.test.mjs",
  "tests/import-commit-reliability.test.mjs",
  "tests/import-date-review.test.mjs",
  "tests/import-review-draft.test.mjs",
  "tests/import-full-workflow-scale.test.mjs",
  "tests/import-post-import-disposition.test.mjs",
  "tests/import-campaign-preservation.test.mjs",
  "tests/financial-date.test.mjs",
  "tests/donor-identity.test.mjs",
  "tests/incremental-refresh.test.mjs",
  "tests/suggested-donation-range.test.mjs",
  "tests/payment-assignment.test.mjs",
  "tests/giving-import-source-attribution.test.mjs",
  "tests/payment-decision-shape.test.mjs",
  "tests/jl-codes.test.mjs",
  "tests/household-import-template.test.mjs",
  "tests/payment-duplicate-match.test.mjs",
  "tests/payment-multi-pledge-allocation.test.mjs",
  "tests/payment-skip-duplicate.test.mjs",
  "tests/donation-rollback.test.mjs",
  "tests/reimport-payment-timeline.test.mjs",
  "tests/personalization.test.mjs",
  "tests/giving-integrity.test.mjs",
  "tests/meeting-brief.test.mjs",
  "tests/today.test.mjs",
  "tests/relationship-queue.test.mjs",
  "tests/activity-editing.test.mjs",
  "tests/activity-outcome.test.mjs",
  "tests/donor-contact-management.test.mjs",
  "tests/household-refresh-integrity.test.mjs",
  "tests/household-review-mode.test.mjs",
  "tests/donor-merge.test.mjs",
  "tests/donor-research-pipeline.test.mjs",
  "tests/donor-research-constraints.test.mjs",
  "tests/donor-research-merge.test.mjs",
  "tests/donor-research-safety.test.mjs",
  "tests/donor-research-ux.test.mjs",
  "tests/donation-management.test.mjs",
  "tests/pending-gift-matching.test.mjs",
  "tests/unified-relationship-timeline.test.mjs",
  "tests/timeline-pagination.test.mjs",
  "tests/usability-pass.test.mjs",
  "tests/mobile-search-names.test.mjs",
  "tests/donor-navigation.test.mjs",
  "tests/donor-search-reset.test.mjs",
  "tests/data-health.test.mjs",
  "tests/data-health-timestamp-formatting.test.mjs",
  "tests/data-health-repair.test.mjs",
  "tests/legacy-test-cleanup.test.mjs",
  "tests/remote-migration-diagnostic.test.mjs",
  "tests/production-baseline.test.mjs",
  "tests/d1-backup-rows.test.mjs",
  "tests/d1-restore-order.test.mjs",
  "tests/restore-drift-guard.test.mjs",
  "tests/production-backup-readiness.test.mjs",
  "tests/production-readiness-diagnostics.test.mjs",
  "tests/workspace-health-semantics.test.mjs",
  "tests/import-center-pending-reviews.test.mjs",
  "tests/auth-provider.test.mjs",
  "tests/cloudflare-access-auth.test.mjs",
  "tests/morning-brief-api.test.mjs",
  "tests/staging-reset.test.mjs",
  "tests/logger.test.mjs",
  "tests/monday-import.test.mjs",
  "tests/monday-import-safety.test.mjs",
  "tests/monday-historical-context.test.mjs",
  "tests/monday-workbook-column-layout.test.mjs",
  "tests/recommendation-engine.test.mjs",
  "tests/gift-acknowledgment-safety.test.mjs",
  "tests/yahrtzeit-recurrence.test.mjs",
  "tests/yahrtzeit-import-safety.test.mjs",
  "tests/yahrtzeit-import-exceptions.test.mjs",
  "tests/suggestion-candidates.test.mjs",
  "tests/relationship-date-events.test.mjs",
  "tests/gregorian-recurring-date.test.mjs",
  "tests/important-dates-validation.test.mjs",
  "tests/important-dates-events.test.mjs",
  "tests/important-dates-safety.test.mjs",
  "tests/dob-workbook.test.mjs",
  "tests/dob-pipeline.test.mjs",
  "tests/dob-import-real-regression.test.mjs",
  "tests/dob-import-safety.test.mjs",
  "tests/dob-import-confirm.test.mjs",
  "tests/rebbeim-directory.test.mjs",
  "tests/rebbeim-import.test.mjs",
  "tests/rebbeim-relationships.test.mjs",
  "tests/status-worker.test.mjs",
  "tests/backup-automation.test.mjs",
  "tests/backup-identity-metadata.test.mjs",
  "tests/nav-link-prefetch.test.mjs",
  "tests/shared-activity-ux.test.mjs",
  "tests/text-message-type.test.mjs",
  "tests/mobile-ux-fixes.test.mjs",
  "tests/donor-directory-picker.test.mjs",
  "tests/shared-activity-response.test.mjs",
  "tests/shared-activity-ownership-chunking.test.mjs",
  "tests/relationship-quality.test.mjs",
  "tests/relationship-summary-cleanup-preview.test.mjs",
  "tests/relationship-summary-apply.test.mjs",
  "tests/asks.test.mjs",
  "tests/workspace-brief-instrumentation.test.mjs",
  "tests/ask-historical-backfill.test.mjs",
  "tests/relationship-date-today-bucket.test.mjs",
  "tests/pledge-payment-recency.test.mjs",
  "tests/pledge-payment-plan.test.mjs",
  "tests/pledge-payment-plan-timezone.test.mjs",
  "tests/pledge-payment-plan-layout.test.mjs",
  "tests/relationship-snapshot-family-terms.test.mjs",
  "tests/relationship-context-audit.test.mjs",
  "tests/relationship-snapshot-yahrtzeit-zman.test.mjs",
  "tests/outcome-route-relationship-write-removed.test.mjs",
  "tests/outcome-relationship-snapshot-accept.test.mjs",
  "tests/people-extraction-false-positives.test.mjs",
  "tests/relationship-facts-schema.test.mjs",
  "tests/relationship-fact-classification.test.mjs",
  "tests/relationship-facts-backfill-preview.test.mjs",
  "tests/relationship-facts-historical-migration-gate.test.mjs",
  "tests/relationship-fact-synthesis.test.mjs",
  "tests/relationship-fact-accept-core.test.mjs",
  "tests/relationship-fact-accept-wiring.test.mjs",
  "tests/relationship-fact-monday-supersession-race.test.mjs",
  "tests/relationship-fact-edit-donor-reassignment.test.mjs",
  "tests/relationship-fact-outcome-cancel-invalidation.test.mjs",
  "tests/ask-followup-and-meeting-brief.test.mjs",
  "tests/stewardship-activity.test.mjs",
  "tests/agenda-timezone.test.mjs",
  "tests/agenda-mime-message.test.mjs",
  "tests/agenda-model.test.mjs",
  "tests/agenda-render.test.mjs",
  "tests/agenda-safety.test.mjs",
  "tests/relationship-fact-recommendation-actionability.test.mjs",
  "tests/relationship-snapshot-stage3.test.mjs",
  "tests/portfolio-focus-materiality.test.mjs",
  "tests/portfolio-focus-components.test.mjs",
  "tests/portfolio-focus-regression.test.mjs",
  "tests/portfolio-focus-today-view.test.mjs",
  "tests/portfolio-focus-dedicated-view.test.mjs",
  "tests/portfolio-focus-route.test.mjs",
  "tests/fundraising-intelligence.test.mjs",
  "tests/fundraising-intelligence-ui.test.mjs",
  "tests/backup-watchdog.test.mjs",
  "tests/backup-watchdog-github-dispatch.test.mjs",
  "tests/backup-watchdog-scheduled.test.mjs",
  "tests/backup-watchdog-security.test.mjs",
  "tests/backup-alert-decision.test.mjs",
  "tests/backup-alert-email.test.mjs",
  "tests/backup-alert-safety.test.mjs",
  "tests/backup-alert-security.test.mjs",
  "tests/pledge-review.test.mjs",
  "tests/pledge-payment-plan-reviews.test.mjs",
  "tests/portfolio-focus-payment-plan-bugfix.test.mjs",
  "tests/payment-plan-intelligence.test.mjs",
  "tests/relationship-facts-lifecycle-reclassify.test.mjs",
];

function runOne(file) {
  const result = spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit" });
  if (result.error) return { file, ok: false, detail: result.error.message };
  if (result.signal) return { file, ok: false, detail: `terminated by signal ${result.signal}` };
  if (result.status !== 0) return { file, ok: false, detail: `exit code ${result.status}` };
  return { file, ok: true };
}

function checkDrift() {
  const onDisk = new Set(readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).map((f) => `tests/${f}`));
  const listed = new Set(TEST_FILES);
  const missingFromDisk = TEST_FILES.filter((f) => !onDisk.has(f));
  const missingFromList = [...onDisk].filter((f) => !listed.has(f));
  return { missingFromDisk, missingFromList };
}

function main() {
  const results = TEST_FILES.map(runOne);
  const failed = results.filter((r) => !r.ok);

  console.log("");
  console.log(`Test files run: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log("FAILED:");
    for (const f of failed) console.log(`  ${f.file} (${f.detail})`);
  }

  const drift = checkDrift();
  if (drift.missingFromDisk.length > 0) {
    console.log(`\nWARNING: listed in scripts/run-tests.mjs but no longer on disk: ${drift.missingFromDisk.join(", ")}`);
  }
  if (drift.missingFromList.length > 0) {
    console.log(`\nWARNING: present in tests/ but not listed in scripts/run-tests.mjs (never run by 'pnpm test'): ${drift.missingFromList.join(", ")}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main();
