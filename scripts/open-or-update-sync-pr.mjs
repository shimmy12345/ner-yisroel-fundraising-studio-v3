// D1 Migration Sync Automation -- the branch/PR orchestration layer (see
// docs/D1-MIGRATION-SYNC-PROCESS.md). Calls scripts/prepare-main-
// restore-sync-patch.mjs's own planning logic, then -- ONLY for a safe,
// non-already-synced plan -- decides what to do with the automated sync
// branch/PR via the pure lib/operations/restore-sync-branch-policy.ts
// policy, and (only when --apply is passed) carries it out.
//
// SAFE BY DEFAULT: without --apply, this script performs every read-only
// step (fetch main, compute the plan, look up the existing branch/PR,
// fetch its reviews/comments/commits to detect human activity, decide
// the action) and prints exactly what it WOULD do -- it never pushes a
// branch, never calls a GitHub write endpoint, in dry-run mode. This is
// the mode used for local/manual verification and for the documented
// preflight step; only the CI workflow's own trusted job ever passes
// --apply.
//
// NEVER FORCE-PUSHES, EVER -- see lib/operations/restore-sync-branch-
// policy.ts's own header comment for the full reasoning. This script's
// only two git write operations are `git push origin <branch>:<branch>`
// (a plain, non-force push -- either creating a brand-new branch ref or
// fast-forwarding one this automation already owns and no human has
// touched) and, on the GitHub API, POST or PATCH against /pulls -- never
// a merge, never a repository-settings call, never a D1/database call of
// any kind.
//
// Usage: node scripts/open-or-update-sync-pr.mjs [--apply]
// Requires GITHUB_TOKEN (the workflow's own job-scoped token in CI) and
// GITHUB_REPOSITORY ("owner/repo") in the environment when --apply is
// passed, or when reading PR/review state for a real repo in dry-run.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decideSyncBranchAction } from "../lib/operations/restore-sync-branch-policy.ts";

const root = path.resolve(import.meta.dirname, "..");
const APPLY = process.argv.includes("--apply");
const REPO = process.env.GITHUB_REPOSITORY || "shimmy12345/ner-yisroel-fundraising-studio-v3";
const TOKEN = process.env.GITHUB_TOKEN || "";
const ROLLING_BRANCH = "automated/d1-restore-sync";
// A distinct, unambiguous git identity for every commit this automation
// makes -- never shared with any human contributor's own identity, so
// "is this commit from the automation, or from a human" is a simple,
// exact comparison, never a heuristic.
const BOT_NAME = "D1 Restore Sync Bot";
const BOT_EMAIL = "d1-restore-sync-bot@users.noreply.github.com";

function git(args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...options });
}

async function githubApi(method, apiPath, body) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      ...(TOKEN ? { Authorization: `token ${TOKEN}` } : {}),
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { status: response.status, json };
}

async function findOpenPrForBranch(branch) {
  const [owner] = REPO.split("/");
  const { status, json } = await githubApi("GET", `/repos/${REPO}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`);
  if (status !== 200 || !Array.isArray(json) || json.length === 0) return null;
  return json[0];
}

async function hasHumanActivityOnPr(prNumber) {
  const [reviews, issueComments, reviewComments, commits] = await Promise.all([
    githubApi("GET", `/repos/${REPO}/pulls/${prNumber}/reviews`),
    githubApi("GET", `/repos/${REPO}/issues/${prNumber}/comments`),
    githubApi("GET", `/repos/${REPO}/pulls/${prNumber}/comments`),
    githubApi("GET", `/repos/${REPO}/pulls/${prNumber}/commits`),
  ]);
  if (Array.isArray(reviews.json) && reviews.json.length > 0) return true;
  if (Array.isArray(issueComments.json) && issueComments.json.length > 0) return true;
  if (Array.isArray(reviewComments.json) && reviewComments.json.length > 0) return true;
  if (Array.isArray(commits.json)) {
    for (const commit of commits.json) {
      const authorEmail = commit?.commit?.author?.email;
      const authorName = commit?.commit?.author?.name;
      if (authorEmail !== BOT_EMAIL || authorName !== BOT_NAME) return true;
    }
  }
  return false;
}

async function remoteBranchExists(branch) {
  try {
    git(["ls-remote", "--exit-code", "--heads", "origin", branch]);
    return true;
  } catch {
    return false;
  }
}

function remoteBranchFileContents(branch, relativePath) {
  try {
    return git(["show", `origin/${branch}:${relativePath}`]);
  } catch {
    return null;
  }
}

async function main() {
  const patchDir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-sync-pr-patch-"));
  const planOutput = execFileSync("node", ["scripts/prepare-main-restore-sync-patch.mjs", "--out-dir", patchDir], { cwd: root, encoding: "utf8" });
  const plan = JSON.parse(planOutput);

  if (!plan.safe) {
    console.log(JSON.stringify({ outcome: "refused", reason: plan.reason }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (plan.alreadySynced) {
    console.log(JSON.stringify({ outcome: "already_synced" }, null, 2));
    return;
  }

  const existingBranchExists = await remoteBranchExists(ROLLING_BRANCH);
  // Only fetch locally (needed to resolve origin/<branch> for the file-
  // content comparison below) once we know the branch is actually there
  // -- fetching a branch that doesn't exist yet is an expected, normal
  // "first run ever" state, never an error.
  if (existingBranchExists) git(["fetch", "origin", ROLLING_BRANCH], { stdio: "ignore" });
  const existingPr = existingBranchExists ? await findOpenPrForBranch(ROLLING_BRANCH) : null;
  const hasHumanActivity = existingPr ? await hasHumanActivityOnPr(existingPr.number) : false;

  const generatedProductionBaselineTs = fs.readFileSync(path.join(patchDir, "lib/data-health/production-baseline.ts"), "utf8");
  const generatedManifest = fs.readFileSync(path.join(patchDir, "production-baseline/schema-manifest.json"), "utf8");
  const candidateMatchesExistingBranchHead = existingBranchExists
    && remoteBranchFileContents(ROLLING_BRANCH, "lib/data-health/production-baseline.ts") === generatedProductionBaselineTs
    && remoteBranchFileContents(ROLLING_BRANCH, "production-baseline/schema-manifest.json") === generatedManifest;

  const shortSha = plan.mainSha.slice(0, 7);
  const freshBranch = `${ROLLING_BRANCH}-${shortSha}`;
  const action = decideSyncBranchAction({
    existingBranchExists,
    existingPrNumber: existingPr?.number ?? null,
    hasHumanActivity,
    candidateMatchesExistingBranchHead,
    rollingBranchName: ROLLING_BRANCH,
    freshBranchName: freshBranch,
  });

  console.log(JSON.stringify({
    outcome: action.action,
    branch: "branch" in action ? action.branch : undefined,
    reason: action.reason,
    migrations: plan.migrations,
    existingPrNumber: existingPr?.number ?? null,
    hasHumanActivity,
    apply: APPLY,
  }, null, 2));

  if (action.action === "noop" || !APPLY) {
    fs.rmSync(patchDir, { recursive: true, force: true });
    return;
  }

  // From here on: real git writes (plain push, never --force) and real
  // GitHub API writes (create/update a PR) -- but ONLY after the
  // candidate patch independently validates against a real checkout of
  // main: its own npm test, its own npm run build, AND a fresh re-run of
  // the existing, unmodified scripts/check-main-restore-sync.mjs
  // (pointed at this local candidate branch) confirming `inSync: true`.
  // Any of these failing is treated exactly like a generator-level
  // refusal -- the branch is never pushed, no PR is touched. Only
  // reached with --apply.
  const targetBranch = action.branch;
  const baseRef = action.action === "update_existing" ? `origin/${targetBranch}` : "origin/main";
  git(["fetch", "origin", action.action === "update_existing" ? targetBranch : "main"]);

  const workBranchLocalName = `__d1-sync-work-${Date.now()}`;
  git(["worktree", "add", "-B", workBranchLocalName, path.join(os.tmpdir(), workBranchLocalName), baseRef]);
  const workDir = path.join(os.tmpdir(), workBranchLocalName);
  let validationError = null;
  try {
    fs.mkdirSync(path.join(workDir, "lib/data-health"), { recursive: true });
    fs.mkdirSync(path.join(workDir, "production-baseline"), { recursive: true });
    fs.writeFileSync(path.join(workDir, "lib/data-health/production-baseline.ts"), generatedProductionBaselineTs);
    fs.writeFileSync(path.join(workDir, "production-baseline/schema-manifest.json"), generatedManifest);
    git(["add", "lib/data-health/production-baseline.ts", "production-baseline/schema-manifest.json"], { cwd: workDir });
    const commitMessage = `Sync restore/baseline tracking for ${plan.migrations.join(", ")}\n\nAutomated by scripts/open-or-update-sync-pr.mjs (see docs/D1-MIGRATION-SYNC-PROCESS.md). Never merged automatically -- requires human review.`;
    git(["-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "commit", "-m", commitMessage], { cwd: workDir });

    try {
      // On Windows, npm is a `.cmd` shim that Node's child_process
      // cannot spawn directly (neither "npm" nor the explicit "npm.cmd"
      // -- both fail, with ENOENT and EINVAL respectively) without shell
      // interpretation; this is a documented Node/Windows limitation,
      // not specific to this script. `shell: true` is used ONLY on
      // win32, and only here, where every argument is a static,
      // hardcoded literal (never attacker- or caller-controlled), so the
      // usual shell-injection/escaping concern that option carries does
      // not apply. The GitHub Actions runner itself is Linux
      // (ubuntu-latest), where plain "npm" (no shell) always resolves
      // correctly -- this branch exists purely for local Windows
      // development/verification and never changes the real CI job's
      // own behavior.
      const npmOptions = { cwd: workDir, stdio: "pipe", shell: process.platform === "win32" };
      execFileSync("npm", ["install", "--no-audit", "--no-fund"], npmOptions);
      execFileSync("npm", ["test"], npmOptions);
      execFileSync("npm", ["run", "build"], npmOptions);
    } catch (error) {
      validationError = `main's own npm test/build failed against the candidate patch: ${error.message}`;
    }
    if (!validationError) {
      try {
        execFileSync("node", ["scripts/check-main-restore-sync.mjs"], { cwd: root, encoding: "utf8", env: { ...process.env, MAIN_REF: workBranchLocalName } });
      } catch (error) {
        validationError = `Final re-verification against the candidate branch did not report in-sync: ${error.stdout || error.message}`;
      }
    }

    if (!validationError) {
      try {
        // Plain push, never --force -- see this file's own header comment.
        git(["push", "origin", `HEAD:refs/heads/${targetBranch}`], { cwd: workDir });
      } catch {
        // Rejected (non-fast-forward): a concurrent run most likely won
        // this exact race and already pushed. Re-fetch and compare --
        // if the branch's new tip already carries our own identical
        // generated content, this is the expected, benign outcome (see
        // lib/operations/restore-sync-branch-policy.ts's own "noop"
        // case), never an error. If it genuinely differs, something
        // else changed the branch concurrently in an unexpected way --
        // refuse rather than guess, exactly like any other unsafe case.
        git(["fetch", "origin", targetBranch], { stdio: "ignore" });
        const raceWinnerMatches = remoteBranchFileContents(targetBranch, "lib/data-health/production-baseline.ts") === generatedProductionBaselineTs
          && remoteBranchFileContents(targetBranch, "production-baseline/schema-manifest.json") === generatedManifest;
        if (!raceWinnerMatches) {
          validationError = `Push to ${targetBranch} was rejected (non-fast-forward) and the branch's current content does not match this run's own generated patch -- a concurrent, non-identical change landed; prepare this sync manually rather than risk overwriting it.`;
        }
      }
    }
  } finally {
    git(["worktree", "remove", workDir, "--force"]);
  }

  if (validationError) {
    console.log(JSON.stringify({ outcome: "refused", reason: validationError }, null, 2));
    process.exitCode = 1;
    fs.rmSync(patchDir, { recursive: true, force: true });
    return;
  }

  const prTitle = `D1 restore/schema sync: ${plan.migrations.join(", ")}`;
  const prBody = [
    "Automated synchronization of main's restore/schema baseline tracking, prepared by scripts/open-or-update-sync-pr.mjs.",
    "",
    `Migrations synced: ${plan.migrations.map((m) => `\`${m}\``).join(", ")}`,
    "",
    "This PR only touches `lib/data-health/production-baseline.ts` and `production-baseline/schema-manifest.json` -- never application code, never D1 data. It is never merged automatically; please review and merge manually.",
    action.action === "create_new" && existingPr
      ? `\n**This supersedes #${existingPr.number}**, which already has review activity and was deliberately left untouched -- carry over any still-relevant comments from it before closing it, then merge this one instead.`
      : null,
    "",
    "See docs/D1-MIGRATION-SYNC-PROCESS.md for the full design.",
  ].filter((line) => line !== null).join("\n");

  if (action.action === "create_new") {
    await githubApi("POST", `/repos/${REPO}/pulls`, { title: prTitle, head: targetBranch, base: "main", body: prBody });
  } else if (existingPr) {
    await githubApi("PATCH", `/repos/${REPO}/pulls/${existingPr.number}`, { title: prTitle, body: prBody });
  }

  fs.rmSync(patchDir, { recursive: true, force: true });
}

await main();
