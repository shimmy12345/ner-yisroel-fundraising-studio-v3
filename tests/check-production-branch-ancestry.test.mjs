import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateAncestry } from "../scripts/check-production-branch-ancestry.mjs";

// Regression coverage for the deployment branch-protection safeguard
// added after the 2026-10-25 incident (docs/AI-HANDOFF.md's "Restore
// Original Trip Planner Calendar Features" entry): a commit that was
// NOT a descendant of the live Production commit was deployed anyway,
// silently dropping real, working functionality the two branches had
// diverged over six days earlier. `evaluateAncestry` is the exact pure
// function `check-production-branch-ancestry.mjs`'s CLI entry point
// calls; these are unit tests of that function (fed already-computed
// git answers), never touching this project's own real git history.

async function run() {
  // --- The exact incident, reproduced structurally: diverged commits,
  // never reconciled. Must fail closed with a specific, actionable
  // message naming both commits. ---
  {
    const result = evaluateAncestry({
      productionCommit: "354b889e6bb8178abfd639364311d484b5b79f1c",
      candidateCommit: "58a9c60e5fbbccdfef619c01df0ce29bc30f9e53",
      isSameCommit: false,
      isDescendant: false,
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /NOT a descendant/);
    assert.match(result.message, /354b889e6bb8178abfd639364311d484b5b79f1c/);
    assert.match(result.message, /58a9c60e5fbbccdfef619c01df0ce29bc30f9e53/);
  }

  // --- A genuine, safe deploy: the candidate really is a descendant of
  // what's currently live. Must pass. ---
  {
    const result = evaluateAncestry({
      productionCommit: "a0ccb2f610ac5a47991c05ee763d70a756981b7f",
      candidateCommit: "58a9c60e5fbbccdfef619c01df0ce29bc30f9e53",
      isSameCommit: false,
      isDescendant: true,
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /confirmed to be a descendant/);
  }

  // --- Redeploying the exact same commit (e.g. a retry after a
  // transient wrangler failure) must not be treated as a divergence. ---
  {
    const result = evaluateAncestry({
      productionCommit: "abc1234",
      candidateCommit: "abc1234",
      isSameCommit: true,
      isDescendant: true,
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /identical to the current Production commit/);
  }

  // --- Real CLI spawn, against this actual repository's real git
  // history -- confirms the exit-code/stdout/stderr contract the
  // deploy script actually depends on, not just the pure function's
  // return value. Uses this repo's own real, already-known-divergent
  // commits (the actual 2026-10-25 incident) and its own real HEAD
  // (always a genuine descendant of its own ancestor). ---
  {
    const scriptPath = fileURLToPath(new URL("../scripts/check-production-branch-ancestry.mjs", import.meta.url));

    const noArgsResult = spawnSync("node", ["--experimental-strip-types", scriptPath], { encoding: "utf8" });
    assert.notEqual(noArgsResult.status, 0, "must refuse to run at all without an explicit current-Production-commit argument");
    assert.match(noArgsResult.stderr, /must be stated explicitly/);

    const unresolvableResult = spawnSync("node", ["--experimental-strip-types", scriptPath, "not-a-real-commit-sha"], { encoding: "utf8" });
    assert.notEqual(unresolvableResult.status, 0, "must refuse to run with an unresolvable commit");
    assert.match(unresolvableResult.stderr, /Could not resolve/);

    const incidentResult = spawnSync("node", ["--experimental-strip-types", scriptPath, "354b889e6bb8178abfd639364311d484b5b79f1c", "58a9c60e5fbbccdfef619c01df0ce29bc30f9e53"], { encoding: "utf8" });
    assert.notEqual(incidentResult.status, 0, "must fail closed when run against the real, diverged 2026-10-25 commits");
    assert.match(incidentResult.stdout, /NOT a descendant/);
  }

  console.log("check-production-branch-ancestry: ok");
}

await run();
