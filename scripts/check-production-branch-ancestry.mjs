import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Deployment branch-protection safeguard (2026-11-01 -- see
// docs/AI-HANDOFF.md's "Restore Original Trip Planner Calendar
// Features and Prevent Future Regressions" entry). It exists because
// of a real incident: on 2026-10-25, a deployment shipped a commit
// that was NOT a descendant of the commit then live on Production --
// the two had forked from a common ancestor six days earlier and were
// never reconciled -- silently dropping real, working functionality
// (the "Add to Google Calendar" link) that the live commit had and the
// new one simply never knew about. This check makes that exact
// condition a loud, blocking failure instead of a silent one.
//
// Deliberately requires the current Production commit to be supplied
// explicitly (CLI argument or PRODUCTION_LIVE_COMMIT env var), never
// read from a separate, possibly-stale tracked state file this script
// maintains itself -- the person deploying must state what they
// believe is live, which is exactly the existing "record the pre-
// deploy Worker version as the rollback target" step every Production
// deployment in this project's history already performs by hand (see
// docs/PRODUCTION-FEATURE-BASELINE.md's pre-deployment checklist,
// item 1) -- this script only makes that existing step's git
// consequence mechanical instead of a manual judgment call.
//
// `evaluateAncestry` is pure (takes the already-computed git answer,
// never shells out itself) and exported specifically so
// tests/check-production-branch-ancestry.test.mjs can reproduce every
// outcome without ever touching this project's own real git history.
//
// Usage: node scripts/check-production-branch-ancestry.mjs <current-production-commit> [candidate-commit]
// `candidate-commit` defaults to `git rev-parse HEAD`. Exits 1 (and
// prints a specific, actionable message) if the candidate is not a
// descendant of the current Production commit, or if either commit
// cannot be resolved at all; exits 0 only when the candidate is
// confirmed to be the same commit as, or a real descendant of, what is
// currently live.

export function evaluateAncestry({ productionCommit, candidateCommit, isDescendant, isSameCommit }) {
  if (isSameCommit) {
    return { ok: true, message: `Candidate commit ${candidateCommit} is identical to the current Production commit (${productionCommit}) -- nothing new to check; this deploy would be a no-op or a rebuild of the exact same code.` };
  }
  if (!isDescendant) {
    return {
      ok: false,
      message:
        `Refusing to deploy: ${candidateCommit} is NOT a descendant of the current Production commit (${productionCommit}).\n` +
        `This means the two have diverged -- some work reachable from ${productionCommit} may not be reachable from ${candidateCommit} at all, and deploying anyway could silently drop it, exactly as happened on 2026-10-25 (the "Add to Google Calendar" feature). ` +
        `Review the diff between these two commits explicitly (git diff ${productionCommit}..${candidateCommit} --stat, and git log ${candidateCommit}..${productionCommit} --oneline to see exactly what would be lost) and reconcile before deploying.`,
    };
  }
  return { ok: true, message: `Candidate commit ${candidateCommit} is confirmed to be a descendant of the current Production commit (${productionCommit}). Safe to proceed with this check.` };
}

function resolveCommit(ref, root) {
  try {
    return execFileSync("git", ["rev-parse", "--verify", ref], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function isAncestor(ancestor, descendant, root) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = process.cwd();
  const productionCommitArg = process.argv[2] || process.env.PRODUCTION_LIVE_COMMIT;
  if (!productionCommitArg) {
    console.error("::error::Usage: node scripts/check-production-branch-ancestry.mjs <current-production-commit> [candidate-commit]");
    console.error("::error::The current Production commit must be stated explicitly -- read it from the live Worker's own Data Health page (deployedCommit) or wrangler deployments list, the same way every prior Production deployment in this project has recorded it. Refusing to guess.");
    process.exitCode = 1;
    return;
  }
  const candidateCommitArg = process.argv[3] || "HEAD";

  const productionCommit = resolveCommit(productionCommitArg, root);
  if (!productionCommit) {
    console.error(`::error::Could not resolve "${productionCommitArg}" as a commit in this repository. Refusing to proceed without a real commit to compare against.`);
    process.exitCode = 1;
    return;
  }
  const candidateCommit = resolveCommit(candidateCommitArg, root);
  if (!candidateCommit) {
    console.error(`::error::Could not resolve "${candidateCommitArg}" as a commit in this repository.`);
    process.exitCode = 1;
    return;
  }

  const result = evaluateAncestry({
    productionCommit,
    candidateCommit,
    isSameCommit: productionCommit === candidateCommit,
    isDescendant: productionCommit === candidateCommit || isAncestor(productionCommit, candidateCommit, root),
  });
  console.log(result.message);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
