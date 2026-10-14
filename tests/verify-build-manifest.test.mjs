import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateManifest, MAX_MANIFEST_AGE_MS } from "../scripts/verify-build-manifest.mjs";

// Regression coverage for the deployment safeguard added after the
// 2026-10-14 "Staging-bundle-on-Production" incident (docs/AI-HANDOFF.md):
// a Staging build left in dist/ got deployed to Production because
// deploy:production-independent never built, only `wrangler deploy`'d.
// `evaluateManifest` is the exact function package.json's
// deploy:*-independent scripts now call (via this file's CLI entry point)
// immediately before `wrangler deploy` -- these are unit tests of that
// pure function, never touching this project's own real dist/.
//
// A second block below spawns the actual CLI (`node
// scripts/verify-build-manifest.mjs <env> <path>`) against a real
// temp-directory manifest file, confirming the exit-code/stdout/stderr
// contract the deploy scripts actually depend on, not just the pure
// function's return value.

async function run() {
  const now = Date.parse("2026-10-14T16:00:00.000Z");

  // --- The exact incident, reproduced: dist/ built for Staging, deploy
  // asks for Production. Must fail closed, and the message must be
  // specific (naming both the actual and expected environment) rather than
  // a generic failure. ---
  const incident = evaluateManifest(
    JSON.stringify({ environment: "staging-independent", builtAt: "2026-10-14T15:59:00.000Z" }),
    "production-independent",
    now,
  );
  assert.equal(incident.ok, false);
  assert.match(incident.error, /was built for "staging-independent"/);
  assert.match(incident.error, /expected "production-independent"/);

  // --- The mirror case: a Production build deployed to Staging must be
  // caught exactly the same way. ---
  const reverseIncident = evaluateManifest(
    JSON.stringify({ environment: "production-independent", builtAt: "2026-10-14T15:59:00.000Z" }),
    "staging-independent",
    now,
  );
  assert.equal(reverseIncident.ok, false);
  assert.match(reverseIncident.error, /was built for "production-independent"/);
  assert.match(reverseIncident.error, /expected "staging-independent"/);

  // --- The correct case: matching environment, fresh timestamp -> ok. ---
  const correct = evaluateManifest(
    JSON.stringify({ environment: "production-independent", builtAt: "2026-10-14T15:59:30.000Z" }),
    "production-independent",
    now,
  );
  assert.equal(correct.ok, true);
  assert.equal(correct.ageMs, 30_000);

  // --- Missing manifest (build never ran, or ran somewhere unexpected)
  // must fail closed, not be treated as "nothing to check". ---
  const missing = evaluateManifest(null, "production-independent", now);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing or unreadable/);

  // --- Malformed JSON (a partially-written file from a crashed build,
  // for instance) must fail closed, never throw past this function. ---
  const malformed = evaluateManifest("{not valid json", "production-independent", now);
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /not valid JSON/);

  // --- A manifest with no environment field at all (any shape this
  // function wasn't specifically written to expect) must fail closed
  // rather than coincidentally matching via undefined === undefined. ---
  const empty = evaluateManifest("{}", "production-independent", now);
  assert.equal(empty.ok, false);
  assert.match(empty.error, /was built for "undefined"/);

  // --- Stale manifest: right environment, but older than the freshness
  // window -- must still fail closed (catches a long-forgotten dist/ the
  // environment check alone would wave through). ---
  const staleBuiltAt = new Date(now - MAX_MANIFEST_AGE_MS - 1000).toISOString();
  const stale = evaluateManifest(
    JSON.stringify({ environment: "production-independent", builtAt: staleBuiltAt }),
    "production-independent",
    now,
  );
  assert.equal(stale.ok, false);
  assert.match(stale.error, /stale or has an invalid timestamp/);

  // --- Exactly at the boundary (not yet stale) still passes -- confirms
  // the check is "older than the window", not "older than or equal to". ---
  const boundaryBuiltAt = new Date(now - MAX_MANIFEST_AGE_MS + 1000).toISOString();
  const boundary = evaluateManifest(
    JSON.stringify({ environment: "production-independent", builtAt: boundaryBuiltAt }),
    "production-independent",
    now,
  );
  assert.equal(boundary.ok, true);

  // --- A future builtAt (clock skew, or a corrupted manifest) must also
  // fail closed, not be treated as "very fresh". ---
  const future = evaluateManifest(
    JSON.stringify({ environment: "production-independent", builtAt: "2026-10-14T16:05:00.000Z" }),
    "production-independent",
    now,
  );
  assert.equal(future.ok, false);
  assert.match(future.error, /stale or has an invalid timestamp/);

  // --- An unparseable builtAt (NaN after Date.parse) must fail closed,
  // not silently compute an ageMs of NaN and let it through. ---
  const badTimestamp = evaluateManifest(
    JSON.stringify({ environment: "production-independent", builtAt: "not-a-real-date" }),
    "production-independent",
    now,
  );
  assert.equal(badTimestamp.ok, false);
  assert.match(badTimestamp.error, /stale or has an invalid timestamp/);

  // --- CLI contract: spawn the actual script exactly as package.json's
  // deploy:*-independent scripts will, against an isolated temp-directory
  // manifest -- never this project's own real dist/. Confirms exit codes
  // and that the incident-reproduction message reaches stderr, which is
  // what makes the failure visible in a real deploy attempt. ---
  const tmpDir = mkdtempSync(path.join(tmpdir(), "verify-build-manifest-test-"));
  try {
    const scriptPath = new URL("../scripts/verify-build-manifest.mjs", import.meta.url);

    const mismatchManifestPath = path.join(tmpDir, "mismatch-manifest.json");
    writeFileSync(mismatchManifestPath, JSON.stringify({ environment: "staging-independent", builtAt: new Date().toISOString() }));
    const mismatchRun = spawnSync(process.execPath, [fileURLToPath(scriptPath), "production-independent", mismatchManifestPath], { encoding: "utf8" });
    assert.equal(mismatchRun.status, 1, "a mismatched environment must exit non-zero, blocking the deploy script's && chain");
    assert.match(mismatchRun.stderr, /was built for "staging-independent"/);

    const okManifestPath = path.join(tmpDir, "ok-manifest.json");
    writeFileSync(okManifestPath, JSON.stringify({ environment: "production-independent", builtAt: new Date().toISOString() }));
    const okRun = spawnSync(process.execPath, [fileURLToPath(scriptPath), "production-independent", okManifestPath], { encoding: "utf8" });
    assert.equal(okRun.status, 0, "a correctly-matching, fresh manifest must exit 0, letting the deploy script's && chain continue");
    assert.match(okRun.stdout, /OK\.$/m);

    const missingArgRun = spawnSync(process.execPath, [fileURLToPath(scriptPath)], { encoding: "utf8" });
    assert.equal(missingArgRun.status, 1, "a missing <expected-environment> argument must fail closed, never silently pass");

    const missingFileRun = spawnSync(process.execPath, [fileURLToPath(scriptPath), "production-independent", path.join(tmpDir, "does-not-exist.json")], { encoding: "utf8" });
    assert.equal(missingFileRun.status, 1, "a missing manifest file must fail closed");
    assert.match(missingFileRun.stderr, /missing or unreadable/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("verify-build-manifest: all assertions passed");
}

await run();
