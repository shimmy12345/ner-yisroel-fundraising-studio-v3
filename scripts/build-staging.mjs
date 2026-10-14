import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));

// Best-effort only: a missing/unresolvable commit SHA (no .git, git not on
// PATH, shallow clone) must never fail the build — Workspace Health treats
// absent commit metadata as informational, not blocking.
const gitCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const commit = gitCommit.status === 0 ? gitCommit.stdout.trim() : undefined;

const result = spawnSync(process.execPath, [cli, "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    FUNDRAISING_OS_ENVIRONMENT: "staging-independent",
    FUNDRAISING_OS_SCHEMA_TRACK: "production-baseline",
    FUNDRAISING_OS_COMMIT: process.env.FUNDRAISING_OS_COMMIT || commit || "",
  },
});

if (result.error) throw result.error;

// Deployment-safety proposal (2026-10-14, docs/AI-HANDOFF.md) -- inert on
// its own: nothing reads this file yet. Only written on a genuinely
// successful build, so a failed build never leaves behind a manifest that
// could make a stale/broken dist/ look freshly verified. Mirrors
// scripts/build-production-independent.mjs exactly.
if (result.status === 0) {
  writeFileSync(
    fileURLToPath(new URL("../dist/build-manifest.json", import.meta.url)),
    JSON.stringify({ environment: "staging-independent", builtAt: new Date().toISOString() }, null, 2),
  );
}

process.exit(result.status ?? 1);
