import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Build target for this app's own independent Cloudflare Production
// Worker (infrastructure provisioned 2026-10-09, see
// docs/PRODUCTION-INFRASTRUCTURE-SETUP.md) -- DISTINCT from
// scripts/build-production.mjs, which remains legacy-ChatGPT-Sites-only
// and must never be reused for this deployment target. Before this
// script existed, there was no way to build an independent Production
// bundle whose own __FUNDRAISING_OS_ENVIRONMENT__ constant was
// distinguishable from legacy production's -- see lib/environment.ts's
// own doc comment, and lib/auth/provider-selection.ts's, for why that
// ambiguity specifically mattered.
const cli = fileURLToPath(new URL("../node_modules/vinext/dist/cli.js", import.meta.url));

// Best-effort only: a missing/unresolvable commit SHA (no .git, git not on
// PATH, shallow clone) must never fail the build — Workspace Health treats
// absent commit metadata as informational, not blocking. Mirrors
// scripts/build-staging.mjs exactly.
const gitCommit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
const commit = gitCommit.status === 0 ? gitCommit.stdout.trim() : undefined;

const result = spawnSync(process.execPath, [cli, "build"], {
  stdio: "inherit",
  env: {
    ...process.env,
    FUNDRAISING_OS_ENVIRONMENT: "production-independent",
    // Same verified 0019+ baseline track legacy production and
    // staging-independent both already build against -- this is a real
    // production-grade environment, not a lesser one.
    FUNDRAISING_OS_SCHEMA_TRACK: "production-baseline",
    FUNDRAISING_OS_COMMIT: process.env.FUNDRAISING_OS_COMMIT || commit || "",
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
