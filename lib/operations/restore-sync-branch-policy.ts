// Pure branch/PR-safety policy for the automated D1 restore/schema sync
// PR (see docs/D1-MIGRATION-SYNC-PROCESS.md). No git, no GitHub API --
// takes plain facts about the existing automation branch/PR (if any) and
// returns one of three actions. The orchestration script
// (scripts/open-or-update-sync-pr.mjs) is the only place that actually
// calls git/the GitHub API; this module is trivially unit-testable with
// synthetic fixtures (tests/restore-sync-branch-policy.test.mjs).
//
// THE ONE HARD RULE THIS MODULE EXISTS TO ENFORCE: this automation must
// NEVER force-push over, or otherwise rewrite, a branch a human has
// engaged with. "Engaged with" means any review, any comment, or any
// commit not authored by the automation's own identity -- if ANY of
// those exist, the existing branch/PR is left completely untouched
// forever; a fresh, distinctly-named branch/PR is opened instead, with a
// note linking back to the one it does not replace. When no human
// engagement exists, updates still only ever APPEND a new commit on top
// of the branch's current remote tip -- never `git push --force`, never
// an amend/rebase, regardless of how far main's own tip has moved
// (every file this automation touches is always fully regenerated from
// scratch each run, never hand-diffed against the branch's own prior
// content, so there is no merge-conflict concept to reconcile and
// therefore never a reason to rewrite history to "fix" one).
export type SyncBranchFacts = {
  existingBranchExists: boolean;
  existingPrNumber: number | null;
  // True if the existing PR (if any) has ANY review, ANY comment, or ANY
  // commit whose author is not this automation's own identity. Computed
  // by the caller from the GitHub API; this module only ever consumes
  // the boolean, never decides how to compute it.
  hasHumanActivity: boolean;
  // True when the freshly generated patch content is byte-identical to
  // what the existing branch's current tip already contains -- the
  // idempotent "someone (possibly this same automation, in a racing
  // run) already produced this exact outcome" case.
  candidateMatchesExistingBranchHead: boolean;
  rollingBranchName: string;
  freshBranchName: string;
};

export type SyncBranchAction =
  | { action: "noop"; reason: string }
  | { action: "update_existing"; branch: string; prNumber: number | null; reason: string }
  | { action: "create_new"; branch: string; reason: string };

export function decideSyncBranchAction(facts: SyncBranchFacts): SyncBranchAction {
  if (!facts.existingBranchExists) {
    return { action: "create_new", branch: facts.rollingBranchName, reason: "No automated sync branch exists yet -- creating it for the first time." };
  }
  // Checked BEFORE hasHumanActivity, deliberately: when nothing new
  // needs to be pushed, no write happens to the branch at all, so there
  // is nothing for the human-activity rule (below) to protect against --
  // "never touch a reviewed branch" is a rule about WRITES, not about
  // leaving it alone when there was never going to be a write anyway.
  if (facts.candidateMatchesExistingBranchHead) {
    return { action: "noop", reason: "The existing automated sync branch already reflects exactly this patch -- nothing to do (this is the expected outcome when a concurrent/racing run already pushed it, or when a human has already reviewed it as-is)." };
  }
  if (facts.hasHumanActivity) {
    return { action: "create_new", branch: facts.freshBranchName, reason: "The existing automated sync branch/PR has human review activity (a review, a comment, or a human-authored commit) -- it is never touched again. A new, separately-named branch/PR covers the current drift instead." };
  }
  return { action: "update_existing", branch: facts.rollingBranchName, prNumber: facts.existingPrNumber, reason: "The existing automated sync branch has no human activity -- safe to extend with a new commit (never a force-push) reflecting the current drift." };
}
