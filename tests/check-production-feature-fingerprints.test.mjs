import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFingerprints, FEATURE_FINGERPRINTS } from "../scripts/check-production-feature-fingerprints.mjs";

// Regression coverage for the deployment safeguard added after the
// 2026-10-25 incident (docs/AI-HANDOFF.md's "Restore Original Trip
// Planner Calendar Features" entry): the "Add to Google Calendar"
// link + "Use donor address" button were real, Production-verified
// functionality, then silently dropped by a deployment from a branch
// that had never incorporated them -- nothing in the deploy process
// checked that the outgoing build still had what the currently-live
// code had. `evaluateFingerprints` is the exact pure function
// `check-production-feature-fingerprints.mjs`'s CLI entry point calls;
// these are unit tests of that function, never touching this project's
// own real dist/.

async function run() {
  // --- The exact incident, reproduced: a dist/ that has every feature
  // EXCEPT the one that regressed. Must fail closed, naming exactly
  // which feature is missing. ---
  {
    const distWithoutCalendarLink = new Map([
      ["dist/server/index.js", "...scheduleProspectMeeting(...); completeProspectMeeting(...); runScheduledAgendaSend(...);..."],
    ]);
    const result = evaluateFingerprints(distWithoutCalendarLink, FEATURE_FINGERPRINTS);
    assert.equal(result.ok, false);
    assert.ok(result.missing.some((entry) => entry.pattern === "AddToGoogleCalendarLink"));
    assert.ok(result.missing.some((entry) => entry.pattern === "Use donor address"));
  }

  // --- The mirror case: every fingerprint present, across multiple
  // files (matching dist/'s own real client+server split) -- must
  // pass cleanly. ---
  {
    const completeDist = new Map([
      ["dist/client/app.js", "AddToGoogleCalendarLink(...); Use donor address"],
      ["dist/server/index.js", "scheduleProspectMeeting(...); completeProspectMeeting(...); runScheduledAgendaSend(...)"],
    ]);
    const result = evaluateFingerprints(completeDist, FEATURE_FINGERPRINTS);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
  }

  // --- A fingerprint that is present but in NO file at all (e.g. only
  // ever appeared in a comment that got stripped, or a feature removed
  // entirely) must still be caught -- proves the check doesn't merely
  // confirm "dist/ is non-empty." ---
  {
    const distMissingEverything = new Map([["dist/server/index.js", "// nothing relevant here"]]);
    const result = evaluateFingerprints(distMissingEverything, FEATURE_FINGERPRINTS);
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, FEATURE_FINGERPRINTS.length);
  }

  // --- Real CLI spawn, against a real temp dist/ directory -- confirms
  // the exit-code/stdout/stderr contract the deploy script actually
  // depends on, not just the pure function's return value. This run
  // deliberately includes only the fingerprint strings, not any real
  // test file, so the "behavioral check" step (which the CLI runs via
  // the real tests/ directory relative to the script's own location,
  // not the temp dir) is exercised against this project's own real,
  // currently-passing tests -- proving the CLI's happy path end to end. ---
  {
    const scriptPath = fileURLToPath(new URL("../scripts/check-production-feature-fingerprints.mjs", import.meta.url));
    const tempDistDir = mkdtempSync(path.join(tmpdir(), "fingerprint-check-dist-"));
    try {
      mkdirSync(path.join(tempDistDir, "server"), { recursive: true });
      const allFingerprints = FEATURE_FINGERPRINTS.map(({ pattern }) => pattern).join(" ; ");
      writeFileSync(path.join(tempDistDir, "server", "index.js"), `// ${allFingerprints}`);
      const result = spawnSync("node", ["--experimental-strip-types", scriptPath, tempDistDir], { encoding: "utf8" });
      assert.equal(result.status, 0, `expected success; stderr: ${result.stderr}`);
      assert.match(result.stdout, /All 5 feature fingerprints found\./);
      assert.match(result.stdout, /All feature fingerprints present and all behavioral checks passed\./);
    } finally {
      rmSync(tempDistDir, { recursive: true, force: true });
    }
  }

  // --- Real CLI spawn against an EMPTY dist/ -- must fail closed with
  // a specific, actionable message, never silently pass on "nothing to
  // check." ---
  {
    const scriptPath = fileURLToPath(new URL("../scripts/check-production-feature-fingerprints.mjs", import.meta.url));
    const emptyDistDir = mkdtempSync(path.join(tmpdir(), "fingerprint-check-empty-"));
    try {
      const result = spawnSync("node", ["--experimental-strip-types", scriptPath, emptyDistDir], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /No files found under/);
    } finally {
      rmSync(emptyDistDir, { recursive: true, force: true });
    }
  }

  console.log("check-production-feature-fingerprints: ok");
}

await run();
