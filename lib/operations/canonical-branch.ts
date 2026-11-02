// Single source of truth for which branch currently owns the real, live
// D1 schema (the "canonical branch" for every schema/migration
// comparison -- see docs/D1-MIGRATION-SYNC-PROCESS.md). Read by
// scripts/check-migration-sync.mjs (which branch's drizzle/ directory to
// list) and lib/operations/restore-sync-generator.ts (the branch name it
// writes into its own generated doc comment), so the name lives in
// exactly ONE place in this repository rather than being duplicated --
// and able to silently drift -- across multiple files. The one place
// this value CANNOT be read from a shared file is a GitHub Actions
// trigger's own `branches:` filter (`on.push.branches`/`on.pull_request.
// branches`), which GitHub evaluates statically from the YAML before any
// code runs -- .github/workflows/d1-restore-sync-check.yml's own trigger
// still has to repeat this value as a literal, but
// tests/canonical-branch.test.mjs asserts that literal stays equal to
// this constant, so the two can never silently drift apart again the way
// they did between 2026-10-01 and 2026-11-02 (see docs/AI-HANDOFF.md's
// "Fix Stale Branch References and Verify Restore Safeguards" entry for
// the full incident).
//
// Update this ONE value -- and nowhere else in application code --
// whenever schema-owning development moves to a new branch: either a
// rename, or a long-running feature branch becoming the de facto source
// of truth before it is merged back into the previously-canonical
// branch. After changing it, also update the literal in
// d1-restore-sync-check.yml's two `branches:` lists -- the regression
// test above will fail loudly if you forget.
//
// History:
//   feature/independent-cloudflare-sandbox -- original canonical branch.
//   trip-planner-multi-region-manual-prospects -- current (2026-11-02).
//     A normal feature branch cut from the original canonical branch,
//     not yet merged back into it -- but confirmed this round to already
//     be the real source of the schema main's own committed manifest
//     reflects (migrations 0054 and 0055 exist in main's manifest and on
//     this branch, but not on the original canonical branch, which has
//     fallen 31 commits behind), and the branch every recent
//     schema-affecting Production deployment has actually been cut from.
export const CANONICAL_BRANCH = process.env.CANONICAL_BRANCH || "trip-planner-multi-region-manual-prospects";
