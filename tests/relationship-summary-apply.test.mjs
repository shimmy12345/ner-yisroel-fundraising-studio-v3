import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classifyDonors,
  planApply,
  executePlan,
  oldActionableRelationshipSnapshot,
} from "../scripts/relationship-summary-cleanup-preview.mjs";
import { actionableRelationshipSnapshot } from "../lib/capture/interaction.ts";

// Tests for the APPLY mode added to
// scripts/relationship-summary-cleanup-preview.mjs on top of the read-only
// preview tool (fe35859). planApply() is pure decision logic (no D1
// access) so it's directly unit-testable; executePlan() is the only I/O,
// and takes an injectable `writeFn` so these tests can simulate D1's
// response (including a stale-value race) without ever touching live data.
//
// NOT covered here (deliberately, to keep `pnpm test` offline/networkless
// like every other test in this repo): "exactly four approved real staging
// records are eligible before execution" is a live-data check, not a unit
// test -- it was verified by hand against a fresh `wrangler d1 execute
// --remote` read immediately before the real apply run (see docs/AI-
// HANDOFF.md), and is additionally re-verified automatically, every time,
// by applyApproved()'s own fetchLiveClassification() call immediately
// before any write (fail-closed if anything drifted).

const EPOCH = 1700000000;
let nextDonorId = 0;

function fixture(relationshipSummary, { note, kind, subject = "Subject" } = {}) {
  const donor = { id: `donor-${nextDonorId++}`, display_name: "Test Donor", relationship_summary: relationshipSummary, institutional_memory: null };
  const interactionsByDonor = new Map();
  if (note !== undefined) {
    interactionsByDonor.set(donor.id, [{ id: "int-0", type: kind, summary: `${subject}\n${note}`, occurred_at: EPOCH }]);
  }
  return { donor, interactionsByDonor };
}

function classifyOne(relationshipSummary, opts) {
  const { donor, interactionsByDonor } = fixture(relationshipSummary, opts);
  const buckets = classifyDonors([donor], interactionsByDonor);
  return { donor, buckets };
}

async function run() {
  const DAVID_NOTE = "David Cohen mentioned that his daughter is starting seminary in Israel this fall.";
  const MIXED_NOTE = "Ran into Sarah Klein at the grocery store, said hello.";

  // --- 1: an allowlisted, currently-SAFE_TO_REGENERATE donor is written,
  // and the resulting `after` is exactly the current extractor's output. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    const plan = planApply([donor.id], [donor], buckets);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, "WRITE");
    let writeFnCalls = 0;
    const results = await executePlan(plan, (sql) => { writeFnCalls++; return [{ meta: { changes: 1 } }]; });
    assert.equal(writeFnCalls, 1);
    assert.equal(results[0].status, "APPLIED");
    assert.equal(results[0].after, actionableRelationshipSnapshot(DAVID_NOTE, "note"));
    assert.equal(results[0].before, value);
  }

  // --- 2: an unapproved donor is never written -- planApply only ever
  // plans for IDs explicitly present in approvedIds, even when other
  // SAFE_TO_REGENERATE donors exist in the same classification. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor: approved } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    const { donor: unapproved, buckets: unapprovedBuckets } = classifyOne(oldActionableRelationshipSnapshot(DAVID_NOTE, "note"), { note: DAVID_NOTE, kind: "note" });
    // combine both donors into one classification pass
    const combinedInteractions = new Map();
    for (const d of [approved, unapproved]) combinedInteractions.set(d.id, [{ id: `int-${d.id}`, type: "note", summary: `Subject\n${DAVID_NOTE}`, occurred_at: EPOCH }]);
    const buckets = classifyDonors([approved, unapproved], combinedInteractions);
    assert.equal(buckets.SAFE_TO_REGENERATE.length, 2, "sanity: both donors are SAFE_TO_REGENERATE candidates");
    const plan = planApply([approved.id], [approved, unapproved], buckets);
    assert.equal(plan.length, 1, "only the explicitly-approved ID appears in the plan at all");
    assert.equal(plan[0].donorId, approved.id);
    void unapprovedBuckets;
  }

  // --- 3: a donor that no longer classifies SAFE_TO_REGENERATE (here:
  // NEEDS_REVIEW, because the source note carries a named person the
  // extractor doesn't recognize as a fact) fails closed -- SKIP, no SQL,
  // no write attempted. ---
  {
    const value = oldActionableRelationshipSnapshot(MIXED_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: MIXED_NOTE, kind: "note" });
    assert.equal(buckets.NEEDS_REVIEW.length, 1, "sanity: this fixture is NEEDS_REVIEW, not SAFE_TO_REGENERATE");
    const plan = planApply([donor.id], [donor], buckets);
    assert.equal(plan[0].action, "SKIP");
    assert.match(plan[0].reason, /NEEDS_REVIEW/);
    let writeFnCalls = 0;
    const results = await executePlan(plan, () => { writeFnCalls++; return [{ meta: { changes: 1 } }]; });
    assert.equal(writeFnCalls, 0, "a SKIP step must never invoke the write function");
    assert.equal(results[0].status, "FAILED_CLOSED");
  }

  // --- 4: a stale relationship_summary (changed between the read and the
  // write -- simulated here via a writeFn reporting 0 rows matched by the
  // conditional UPDATE) fails closed rather than overwriting. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    const plan = planApply([donor.id], [donor], buckets);
    assert.match(plan[0].sql, /AND relationship_summary = /, "the write must be conditioned on the exact observed value");
    const results = await executePlan(plan, () => [{ meta: { changes: 0 } }]);
    assert.equal(results[0].status, "FAILED_CLOSED");
    assert.match(results[0].reason, /changed between this run's read and write/);
    assert.equal(results[0].after, null);
  }

  // --- 5: a donor whose old-format value cannot be traced to any
  // interaction on file (missing/changed source) is never SAFE_TO_REGENERATE
  // in the first place -- classifyDonors routes it to NEEDS_REVIEW, so
  // planApply fails it closed the same way as #3, for a different root
  // cause (no source, not an unrecognized fact). ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, {}); // no interactions on file at all
    assert.equal(buckets.NEEDS_REVIEW.length, 1, "sanity: untraceable old-format value is NEEDS_REVIEW");
    const plan = planApply([donor.id], [donor], buckets);
    assert.equal(plan[0].action, "SKIP");
  }

  // --- 6: the proposed value is always the current extractor's real
  // output, computed inside planApply from the classification -- there is
  // no parameter through which a caller/CLI could inject an arbitrary
  // replacement string (planApply's signature is IDs + fetched data only). ---
  {
    assert.equal(planApply.length, 3, "planApply must only accept (approvedIds, candidates, buckets) -- no text parameter");
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    const plan = planApply([donor.id], [donor], buckets);
    assert.equal(plan[0].proposed, actionableRelationshipSnapshot(DAVID_NOTE, "note"));
  }

  // --- 7: institutional_memory can never be modified -- the generated SQL
  // never references it, and the source file contains no write statement
  // touching it. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    const plan = planApply([donor.id], [donor], buckets);
    assert.doesNotMatch(plan[0].sql, /institutional_memory/);
    const source = await readFile(new URL("../scripts/relationship-summary-cleanup-preview.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /UPDATE\s+donors\s+SET[^;]*institutional_memory/is);
  }

  // --- 8: only relationship_summary is ever assigned by the generated
  // UPDATE -- no other column, table, interactions row, or unrelated donor
  // field appears in the write. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    const plan = planApply([donor.id], [donor], buckets);
    assert.match(plan[0].sql, /^UPDATE donors SET relationship_summary = CAST\(X'[0-9a-f]*' AS TEXT\) WHERE id = '[^']*' AND relationship_summary = CAST\(X'[0-9a-f]*' AS TEXT\)$/);
  }

  // --- 9: rerunning apply after a successful write is idempotent -- once
  // the stored value equals the current extractor's output, classifyDonors
  // puts the donor in ALREADY_GOOD (not SAFE_TO_REGENERATE), so a second
  // planApply for the same ID fails closed instead of re-writing. ---
  {
    const proposed = actionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(proposed, { note: DAVID_NOTE, kind: "note" });
    assert.equal(buckets.ALREADY_GOOD.length, 1, "post-apply value must reclassify as ALREADY_GOOD");
    const plan = planApply([donor.id], [donor], buckets);
    assert.equal(plan[0].action, "SKIP", "re-applying to an already-clean donor must not produce a second write");
  }

  // --- 10: planApply performs no writes at all -- it has no writeFn
  // parameter and is synchronous/pure; only executePlan (given a writeFn)
  // can call one, and only for WRITE steps (already covered by #3's
  // writeFnCalls assertion). Confirmed here by checking planApply is not
  // async and calling it twice yields identical output (no hidden state). ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { donor, buckets } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    assert.equal(planApply.constructor.name, "Function", "planApply must be synchronous (not async) -- it cannot itself await a network write");
    const first = planApply([donor.id], [donor], buckets);
    const second = planApply([donor.id], [donor], buckets);
    assert.deepEqual(first, second);
  }

  // --- 11: (see file header) exactly four approved real staging records
  // being eligible is verified against live D1, not here -- documented,
  // not skipped silently. ---

  // --- 12: the existing relationship-summary classification tests, which
  // this apply-mode code sits directly on top of, remain green. ---
  {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, [new URL("./relationship-summary-cleanup-preview.test.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { encoding: "utf8" });
    assert.equal(result.status, 0, `relationship-summary-cleanup-preview.test.mjs must still pass:\n${result.stdout}\n${result.stderr}`);
  }

  console.log("Relationship-summary apply-mode safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
