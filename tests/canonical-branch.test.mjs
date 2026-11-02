import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CANONICAL_BRANCH } from "../lib/operations/canonical-branch.ts";

// Fix Stale Branch References and Verify Restore Safeguards (2026-11-02,
// see docs/AI-HANDOFF.md). Root cause of the drift this round fixed: the
// canonical branch name was duplicated as a literal in multiple files
// (scripts/check-migration-sync.mjs's own default,
// .github/workflows/d1-restore-sync-check.yml's two `branches:` triggers)
// with nothing ever checking they agreed -- one got updated when
// development moved to a new branch, the other silently didn't, for over
// a month. lib/operations/canonical-branch.ts is now the single source
// every piece of application code reads from; GitHub Actions' own
// `branches:` trigger filter is the one place that CANNOT read that file
// (GitHub evaluates it statically from the YAML, before any code runs),
// so it still repeats the name as a literal -- this test is what makes
// that one remaining duplication safe: it fails loudly the moment the
// workflow's literal and the shared constant disagree.

const root = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(root, ".github/workflows/d1-restore-sync-check.yml");
const workflowText = fs.readFileSync(workflowPath, "utf8");

// Minimal, purpose-built extraction (no YAML parser is a project
// dependency, and adding one for a single test is out of scope): finds
// every `branches:` key inside the `on:` block (before `jobs:` starts)
// and collects the `- <name>` list immediately indented under it. Exact
// match to this workflow's own stable, simple shape -- not a general
// YAML parser.
function extractOnBranchesLists(text) {
  const onSectionText = text.slice(text.indexOf("\non:"), text.indexOf("\njobs:"));
  const lines = onSectionText.split("\n");
  const lists = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*branches:\s*$/.test(lines[i])) continue;
    const branchIndent = lines[i].match(/^\s*/)[0].length;
    const names = [];
    for (let j = i + 1; j < lines.length; j++) {
      const match = lines[j].match(/^(\s*)-\s*(\S+)\s*$/);
      if (!match || match[1].length <= branchIndent) break;
      names.push(match[2]);
    }
    lists.push(names);
  }
  return lists;
}

{
  const branchesLists = extractOnBranchesLists(workflowText);

  assert.equal(branchesLists.length, 2, `Expected exactly 2 "branches:" lists under on: (push + pull_request); found ${branchesLists.length}. The extraction helper's assumptions about this file's shape may be stale.`);

  for (const [index, names] of branchesLists.entries()) {
    assert.deepEqual(names, [CANONICAL_BRANCH], `.github/workflows/d1-restore-sync-check.yml's "on:" branches: list #${index + 1} is ${JSON.stringify(names)}, which does not match lib/operations/canonical-branch.ts's CANONICAL_BRANCH (${JSON.stringify(CANONICAL_BRANCH)}). Update the workflow's literal to match -- this is the one place that value cannot be read from the shared constant directly.`);
  }
}

// CANONICAL_BRANCH itself must be a real, non-empty, plausible branch
// name -- never silently empty (e.g. an unset/misconfigured override).
assert.equal(typeof CANONICAL_BRANCH, "string");
assert.ok(CANONICAL_BRANCH.length > 0);

process.stdout.write("canonical-branch.test.mjs: all assertions passed\n");
