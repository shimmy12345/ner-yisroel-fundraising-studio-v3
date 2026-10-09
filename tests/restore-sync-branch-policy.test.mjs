import assert from "node:assert/strict";
import { decideSyncBranchAction } from "../lib/operations/restore-sync-branch-policy.ts";

// D1 Migration Sync Automation -- branch/PR safety policy (see
// docs/D1-MIGRATION-SYNC-PROCESS.md). Synthetic coverage for every
// combination this automation can face: first run, stale branch,
// concurrent/racing runs, and -- the one hard rule -- never touching a
// branch a human has engaged with.

const BASE = { rollingBranchName: "automated/d1-restore-sync", freshBranchName: "automated/d1-restore-sync-abc1234" };

// 1. First run ever -- no existing branch -- create it.
{
  const action = decideSyncBranchAction({ ...BASE, existingBranchExists: false, existingPrNumber: null, hasHumanActivity: false, candidateMatchesExistingBranchHead: false });
  assert.deepEqual(action, { action: "create_new", branch: "automated/d1-restore-sync", reason: action.reason });
}

// 2. Stale branch (main moved / a new migration landed since the branch
// was last updated), zero human activity -- safe to extend.
{
  const action = decideSyncBranchAction({ ...BASE, existingBranchExists: true, existingPrNumber: 42, hasHumanActivity: false, candidateMatchesExistingBranchHead: false });
  assert.equal(action.action, "update_existing");
  assert.equal(action.branch, "automated/d1-restore-sync");
  assert.equal(action.prNumber, 42);
}

// 3. Concurrent/racing run: another run already pushed the exact same
// outcome -- idempotent no-op, never an error.
{
  const action = decideSyncBranchAction({ ...BASE, existingBranchExists: true, existingPrNumber: 42, hasHumanActivity: false, candidateMatchesExistingBranchHead: true });
  assert.equal(action.action, "noop");
}

// 4. THE hard rule: a human left a review comment on the existing PR --
// even with zero commits from them, the branch is never touched again;
// a fresh, separately-named branch is used instead.
{
  const action = decideSyncBranchAction({ ...BASE, existingBranchExists: true, existingPrNumber: 42, hasHumanActivity: true, candidateMatchesExistingBranchHead: false });
  assert.deepEqual(action, { action: "create_new", branch: "automated/d1-restore-sync-abc1234", reason: action.reason });
  assert.notEqual(action.branch, "automated/d1-restore-sync", "the reviewed branch's own name must never be reused for an update");
}

// 5. Human activity AND the candidate already matches the branch's head
// (e.g. a human reviewed/approved it as-is, no new drift since) --
// idempotency wins here, correctly: when nothing new needs to be
// pushed, NO write happens to the branch at all, so there is nothing
// for the human-activity rule to protect against -- "noop" is safe
// regardless of review activity, since "never touch a reviewed branch"
// is a rule about WRITES, not about reading/inspecting it.
{
  const action = decideSyncBranchAction({ ...BASE, existingBranchExists: true, existingPrNumber: 42, hasHumanActivity: true, candidateMatchesExistingBranchHead: true });
  assert.equal(action.action, "noop");
}

// 6. A fresh branch created for one incident, then ANOTHER migration
// lands before that one is reviewed -- the fresh branch itself becomes
// "existing" on the next run and follows the same rules (never a
// special case): no human activity on it yet -> safe to extend.
{
  const facts = { rollingBranchName: "automated/d1-restore-sync", freshBranchName: "automated/d1-restore-sync-def5678", existingBranchExists: true, existingPrNumber: 43, hasHumanActivity: false, candidateMatchesExistingBranchHead: false };
  const action = decideSyncBranchAction(facts);
  assert.equal(action.action, "update_existing");
}

process.stdout.write("Restore sync branch policy checks passed.\n");
