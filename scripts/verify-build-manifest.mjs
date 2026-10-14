import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fail-closed pre-deploy check (deployment-safety safeguard, 2026-10-14 --
// see docs/AI-HANDOFF.md's "Deployment Safeguard" entries). It exists
// because of a real incident: `deploy:*-independent` scripts only ran
// `wrangler deploy` -- they never built -- so an interleaved Staging build
// (run for a Staging test step) left in dist/ silently got deployed to
// Production moments later under wrangler.production.jsonc. dist/ is
// gitignored, so nothing in version control could have caught this; this
// script runs as part of the deploy command itself, immediately after a
// fresh build, so the mistake becomes a loud, blocking failure instead of
// a silent wrong deploy. Wired into package.json's
// `deploy:staging-independent` and `deploy:production-independent` as
// `build:*-independent && verify-build-manifest.mjs <env> && wrangler
// deploy ...` -- a failed build or a failed verify both stop via `&&`
// before `wrangler deploy` ever runs.
//
// `evaluateManifest` is pure and exported specifically so
// tests/verify-build-manifest.test.mjs can reproduce the exact incident
// (and every other failure mode) without ever touching this project's own
// real dist/ -- see that file for the regression coverage.
//
// Usage: node scripts/verify-build-manifest.mjs <expected-environment> [manifestPath]
// `manifestPath` defaults to this project's own dist/build-manifest.json
// and is only ever overridden by tests.

// Generous enough for a normal build-then-deploy (builds take well under a
// minute locally); tight enough to still catch a long-forgotten stale
// dist/ that happens to have the right environment value but is otherwise
// out of date, which the environment check alone would not catch.
export const MAX_MANIFEST_AGE_MS = 10 * 60 * 1000;

// Pure and independently testable: takes the manifest file's raw contents
// (or null if it could not be read at all) rather than a path, so no
// caller needs real disk I/O to exercise every branch.
export function evaluateManifest(rawManifestJson, expected, now) {
  if (rawManifestJson === null) {
    return {
      ok: false,
      error: "dist/build-manifest.json is missing or unreadable. Refusing to deploy -- run the matching build:*-independent script first.",
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(rawManifestJson);
  } catch (error) {
    return {
      ok: false,
      error: `dist/build-manifest.json is not valid JSON (${error.message}). Refusing to deploy -- run the matching build:*-independent script first.`,
    };
  }

  if (manifest.environment !== expected) {
    return {
      ok: false,
      error:
        `dist/ was built for "${manifest.environment}", not the expected "${expected}". ` +
        `Refusing to deploy -- this is exactly the mistake behind the 2026-10-14 Production incident (see docs/AI-HANDOFF.md). ` +
        `Run the matching build:*-independent script immediately before deploying.`,
    };
  }

  const ageMs = now - Date.parse(manifest.builtAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > MAX_MANIFEST_AGE_MS) {
    return {
      ok: false,
      error: `dist/build-manifest.json is stale or has an invalid timestamp (builtAt: ${manifest.builtAt}). Refusing to deploy -- rebuild immediately before deploying.`,
    };
  }

  return { ok: true, ageMs };
}

// CLI entry point -- only runs when this file is executed directly
// (`node scripts/verify-build-manifest.mjs ...`), never when
// tests/verify-build-manifest.test.mjs imports evaluateManifest above, so
// importing this module for its pure function never has the side effect of
// reading real disk state or calling process.exit().
const isDirectRun = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? "");
if (isDirectRun) {
  const expected = process.argv[2];
  if (!expected) {
    console.error("verify-build-manifest: missing required <expected-environment> argument, e.g. \"production-independent\".");
    process.exit(1);
  }

  const manifestPath = process.argv[3] ?? fileURLToPath(new URL("../dist/build-manifest.json", import.meta.url));
  let raw = null;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    raw = null;
  }

  const result = evaluateManifest(raw, expected, Date.now());
  if (!result.ok) {
    console.error(`verify-build-manifest: ${result.error}`);
    process.exit(1);
  }
  console.log(`verify-build-manifest: dist/ was built for "${expected}" ${Math.round(result.ageMs / 1000)}s ago. OK.`);
}
