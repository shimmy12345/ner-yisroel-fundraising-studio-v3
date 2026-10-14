import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Fail-closed pre-deploy check (deployment-safety proposal, 2026-10-14 --
// see docs/AI-HANDOFF.md's "Deployment Safeguard" entry). It exists because
// of a real incident: `deploy:*-independent` scripts only run `wrangler
// deploy` -- they never build -- so an interleaved Staging build (run for
// a Staging test step) left in dist/ silently got deployed to Production
// moments later under wrangler.production.jsonc. dist/ is gitignored, so
// nothing in version control could have caught this; this script is meant
// to run as part of the deploy command itself, immediately after a fresh
// build, so the mistake becomes a loud, blocking failure instead of a
// silent wrong deploy.
//
// NOT WIRED IN YET -- see docs/AI-HANDOFF.md's proposal entry for the
// exact package.json change this is meant to be called from, pending
// review. Calling this script alone does nothing but read dist/ and exit
// non-zero on a mismatch; it has no side effects.
//
// Usage: node scripts/verify-build-manifest.mjs <expected-environment>

const expected = process.argv[2];
if (!expected) {
  console.error("verify-build-manifest: missing required <expected-environment> argument, e.g. \"production-independent\".");
  process.exit(1);
}

// Generous enough for a normal build-then-deploy (builds take well under a
// minute locally); tight enough to still catch a long-forgotten stale
// dist/ that happens to have the right environment value but is otherwise
// out of date, which the environment check alone would not catch.
const MAX_MANIFEST_AGE_MS = 10 * 60 * 1000;

let manifest;
try {
  const raw = readFileSync(fileURLToPath(new URL("../dist/build-manifest.json", import.meta.url)), "utf8");
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`verify-build-manifest: dist/build-manifest.json is missing or unreadable (${error.message}). Refusing to deploy -- run the matching build:*-independent script first.`);
  process.exit(1);
}

if (manifest.environment !== expected) {
  console.error(
    `verify-build-manifest: dist/ was built for "${manifest.environment}", not the expected "${expected}". ` +
      `Refusing to deploy -- this is exactly the mistake behind the 2026-10-14 Production incident (see docs/AI-HANDOFF.md). ` +
      `Run the matching build:*-independent script immediately before deploying.`,
  );
  process.exit(1);
}

const ageMs = Date.now() - Date.parse(manifest.builtAt);
if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_MANIFEST_AGE_MS) {
  console.error(`verify-build-manifest: dist/build-manifest.json is stale or has an invalid timestamp (builtAt: ${manifest.builtAt}). Refusing to deploy -- rebuild immediately before deploying.`);
  process.exit(1);
}

console.log(`verify-build-manifest: dist/ was built for "${expected}" ${Math.round(ageMs / 1000)}s ago. OK.`);
