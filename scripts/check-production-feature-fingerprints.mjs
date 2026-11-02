import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Production Feature Baseline regression guard (2026-11-01 -- see
// docs/AI-HANDOFF.md's "Restore Original Trip Planner Calendar
// Features and Prevent Future Regressions" entry and
// docs/PRODUCTION-FEATURE-BASELINE.md). It exists because of a real
// incident: the "Add to Google Calendar" link and "Use donor address"
// button were built, Production-deployed, and verified working
// (2026-10-19), then silently dropped by a later, unrelated deployment
// (2026-10-25) whose branch had never incorporated them -- nothing in
// the deploy process checked that the OUTGOING code still had what the
// CURRENTLY LIVE code had. This script is that check, made standing and
// automatic instead of the ad-hoc, manual `grep dist/` this project's
// own deployment history already performed by hand every time.
//
// Deliberately two layers, per explicit instruction not to rely on text
// search alone:
//   1. A text fingerprint per baseline feature, grepped across the
//      freshly built dist/ -- cheap, catches "this code isn't in the
//      bundle at all" (exactly the 2026-10-25 failure mode).
//   2. A short list of this project's own existing, real test files --
//      run for real, not merely checked for existence -- so a
//      fingerprint string surviving in dist/ while the actual behavior
//      underneath it is broken (a real regression a text search alone
//      cannot catch) still fails this check.
//
// `evaluateFingerprints` is pure and exported specifically so
// tests/check-production-feature-fingerprints.test.mjs can reproduce
// every failure mode without ever touching this project's own real
// dist/ -- see that file for the regression coverage.
//
// Usage: node scripts/check-production-feature-fingerprints.mjs [distDir]
// `distDir` defaults to this project's own dist/. Exits 1 and prints
// exactly which fingerprint(s) and/or behavioral test(s) failed if even
// one does; exits 0 only when every fingerprint is found AND every
// listed test passes.

// One short, distinctive string per feature this project has
// independently verified working in Production (see
// docs/PRODUCTION-FEATURE-BASELINE.md's "Verified working in
// Production" tier) -- never a feature only "implemented, not
// independently verified," since a fingerprint check this strict would
// otherwise block deploys on features nobody has actually confirmed
// live yet. Add a new entry here the same day a feature is newly
// verified; remove one only with the same care as removing the feature
// itself.
export const FEATURE_FINGERPRINTS = [
  { feature: "Trip Planner: Add to Google Calendar link", pattern: "AddToGoogleCalendarLink" },
  { feature: "Trip Planner: Use donor address button", pattern: "Use donor address" },
  { feature: "Trip Planner: meeting scheduling", pattern: "scheduleProspectMeeting" },
  { feature: "Trip Planner: meeting completion", pattern: "completeProspectMeeting" },
  { feature: "Daily Fundraising Agenda: scheduled send", pattern: "runScheduledAgendaSend" },
  { feature: "Trip Planner: Find prospects defaults to trip regions", pattern: "effectiveRegionFilter" },
  { feature: "Trip Planner: mobile region checkbox layout", pattern: "travel-planning-region-hint" },
];

// Each one run for real (a child process, not merely checked for
// existence on disk) -- pure-logic/source-inspection tests only, the
// same CI-independent kind this project's own test suite already runs
// by default (no CI-only local-D1/workerd harness here, which would
// make this check itself flaky/slow to run on every deploy).
export const BEHAVIORAL_CHECK_TEST_FILES = [
  "tests/trip-calendar-link.test.mjs",
  "tests/trip-calendar-missing-table-regression.test.mjs",
  "tests/d1-restore-order.test.mjs",
  "tests/trip-region-filter.test.mjs",
  "tests/trip-region-mobile-layout.test.mjs",
];

function collectFileContents(rootDir) {
  const contents = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stats = statSync(fullPath);
      if (stats.isDirectory()) walk(fullPath);
      else if (stats.isFile()) {
        try {
          contents.set(fullPath, readFileSync(fullPath, "utf8"));
        } catch {
          // Binary/unreadable files (images, fonts) never carry a text
          // fingerprint -- skip rather than fail the whole check.
        }
      }
    }
  }
  walk(rootDir);
  return contents;
}

// Pure: takes the dist/ file contents already read (so tests never need
// real disk I/O) and the fingerprint list, returns which are missing.
export function evaluateFingerprints(distFileContents, fingerprints) {
  const allContent = [...distFileContents.values()];
  const missing = fingerprints.filter(({ pattern }) => !allContent.some((content) => content.includes(pattern)));
  return { ok: missing.length === 0, missing };
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const distArgIndex = process.argv.findIndex((argument, index) => index >= 2 && !argument.startsWith("--"));
  const distDir = distArgIndex !== -1 ? path.resolve(process.argv[distArgIndex]) : path.join(root, "dist");

  console.log(`Checking Production feature fingerprints against ${distDir} ...`);
  const distFileContents = collectFileContents(distDir);
  if (distFileContents.size === 0) {
    console.error(`::error::No files found under ${distDir} -- run the matching build:*-independent script first.`);
    process.exitCode = 1;
    return;
  }
  const fingerprintResult = evaluateFingerprints(distFileContents, FEATURE_FINGERPRINTS);
  if (!fingerprintResult.ok) {
    console.error("::error::Refusing to deploy -- the following Production-verified feature(s) are missing from the freshly built dist/:");
    for (const { feature, pattern } of fingerprintResult.missing) console.error(`  - ${feature} (expected to find "${pattern}" somewhere in dist/)`);
    console.error("\nThis is exactly the failure mode that dropped the Add-to-Google-Calendar feature on 2026-10-25: the outgoing build silently lacks something the currently-live Production code has. See docs/PRODUCTION-FEATURE-BASELINE.md.");
    process.exitCode = 1;
    return;
  }
  console.log(`All ${FEATURE_FINGERPRINTS.length} feature fingerprints found.`);

  console.log(`Running ${BEHAVIORAL_CHECK_TEST_FILES.length} focused behavioral check(s) (not just text search) ...`);
  for (const testFile of BEHAVIORAL_CHECK_TEST_FILES) {
    try {
      execFileSync("node", ["--experimental-strip-types", testFile], { cwd: root, stdio: "pipe" });
      console.log(`  ok: ${testFile}`);
    } catch (error) {
      console.error(`::error::Refusing to deploy -- behavioral check failed: ${testFile}`);
      console.error(error.stdout?.toString() ?? "");
      console.error(error.stderr?.toString() ?? "");
      process.exitCode = 1;
      return;
    }
  }
  console.log("All feature fingerprints present and all behavioral checks passed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
