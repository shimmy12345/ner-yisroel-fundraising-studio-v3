import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ALLOWLIST,
  EXPECTED_USER_ID,
  validateEntry,
  planAskCreate,
  applyAsks,
  isOldSolicitedFormat,
  planSummaryCleanup,
  verifyAskForCleanup,
  cleanupSummaries,
  money,
} from "../scripts/ask-historical-backfill.mjs";

// Tests for scripts/ask-historical-backfill.mjs -- the narrow, one-off
// backfill of exactly 3 already-reviewed historical solicitation cases
// (Klein/Pfeiffer/Rovinsky) into real `asks` rows, plus the follow-on
// relationship_summary cleanup. All offline/networkless (no wrangler/D1
// round-trip), using injectable fetch/write functions (applyAsks/
// cleanupSummaries/verifyAskForCleanup all accept them), mirroring
// tests/relationship-summary-apply.test.mjs's pattern for the sibling
// cleanup script.
//
// NOT covered here (deliberately, live-data checks, not unit tests):
// "exactly 3 real staging entries are eligible right now" -- verified by
// hand against a fresh `node scripts/ask-historical-backfill.mjs` dry run
// immediately before the real apply, and documented in docs/AI-HANDOFF.md.

function donorFixture(overrides = {}) {
  return {
    id: "b5e8cc18-49f5-42c9-8511-26371ca3cef6",
    display_name: "Mr. & Mrs. Mayer Simcha Klein",
    owner_user_id: EXPECTED_USER_ID,
    data_source: "live",
    relationship_summary: "Latest discussion topics: Relationship update.\nPeople mentioned: Solicited.\nRecommended next action: Review this note before the next interaction.",
    ...overrides,
  };
}

function interactionFixture(overrides = {}) {
  return {
    id: "monday-interaction-5a79919d",
    donor_id: "b5e8cc18-49f5-42c9-8511-26371ca3cef6",
    user_id: EXPECTED_USER_ID,
    type: "note",
    occurred_at: 1762430400,
    summary: "Solicited for a plaque ($5k)\nImported from Monday.com pipeline export. Source due date: 2025-11-06.",
    source: "import-monday:confirmed",
    ...overrides,
  };
}

const KLEIN = ALLOWLIST[0];
const PFEIFFER = ALLOWLIST[1];
const ROVINSKY = ALLOWLIST[2];

async function run() {
  // --- 1: dry-run's underlying validation finds exactly the 3 approved
  // fixtures, no more, no fewer -- the allowlist itself is exactly 3
  // entries, and each validates eligible against a correctly-matching
  // fresh-state fixture. ---
  {
    assert.equal(ALLOWLIST.length, 3, "the allowlist must contain exactly 3 entries");
    for (const entry of ALLOWLIST) {
      const donor = donorFixture({ id: entry.donorId, display_name: entry.donorName });
      const interaction = interactionFixture({ id: entry.sourceInteractionId, donor_id: entry.donorId, summary: `${entry.expectedNoteFirstLine}\nImported from Monday.com pipeline export.` });
      const result = validateEntry(entry, { donor, interaction, existingAsk: null });
      assert.equal(result.eligible, true, `${entry.donorName} must be eligible against a correctly-matching fixture: ${result.reason}`);
    }
  }

  // --- 2: amount parsing/mapping is deterministic -- the allowlist's own
  // amountCents values are fixed integers, never derived from parsing at
  // apply time, and money() formats them exactly as expected. ---
  {
    assert.equal(KLEIN.amountCents, 500000);
    assert.equal(PFEIFFER.amountCents, 1000000);
    assert.equal(ROVINSKY.amountCents, 500000);
    assert.equal(money(500000), "$5,000");
    assert.equal(money(1000000), "$10,000");
    assert.equal(money(null), "(none)");
    // Determinism: calling validateEntry twice on identical input produces
    // an identical proposedAsk (no hidden randomness in mapping).
    const donor = donorFixture();
    const interaction = interactionFixture();
    const a = validateEntry(KLEIN, { donor, interaction, existingAsk: null });
    const b = validateEntry(KLEIN, { donor, interaction, existingAsk: null });
    assert.deepEqual(a.proposedAsk, b.proposedAsk);
  }

  // --- 3: purpose mapping is deterministic and matches the reviewed case
  // exactly -- Klein/Rovinsky get their reviewed purpose text, Pfeiffer
  // (whose note specifies no purpose) gets null, never an empty string or
  // a guessed value. ---
  {
    assert.equal(KLEIN.purpose, "Plaque");
    assert.equal(ROVINSKY.purpose, "Plaque in memory of his wife");
    assert.equal(PFEIFFER.purpose, null);
  }

  // --- 4: source interaction is required -- an entry whose interaction is
  // missing (not found in D1) is never eligible, regardless of donor state. ---
  {
    const donor = donorFixture();
    const result = validateEntry(KLEIN, { donor, interaction: null, existingAsk: null });
    assert.equal(result.eligible, false);
    assert.match(result.reason, /not found/);
  }

  // --- 5: an existing Ask already referencing this source_interaction_id
  // causes a no-op (ALREADY_APPLIED, not a second write) -- both at the
  // validateEntry layer and end-to-end through applyAsks() with an
  // injected fetchStateFn/writeFn (the writeFn must never be called). ---
  {
    const existingAsk = { id: "existing-ask-1", donor_id: KLEIN.donorId, status: "pending" };
    const donor = donorFixture();
    const interaction = interactionFixture();
    const result = validateEntry(KLEIN, { donor, interaction, existingAsk });
    assert.equal(result.eligible, false);
    assert.equal(result.alreadyBackfilled, true);

    let writeCalls = 0;
    const results = applyAsks([KLEIN], {
      fetchStateFn: () => ({ donor, interaction, existingAsk }),
      writeFn: () => { writeCalls++; return [{ meta: { changes: 1 } }]; },
      fetchAuditCountFn: () => 1,
      log: () => {},
    });
    assert.equal(writeCalls, 0, "an already-backfilled entry must never trigger a write");
    assert.equal(results[0].status, "ALREADY_APPLIED");
    assert.equal(results[0].auditRowPresent, true);
  }

  // --- 6: an unapproved donor/source pair cannot be written -- there is no
  // code path in applyAsks() that accepts entries outside its `entries`
  // parameter, which defaults to (and in production always is) the
  // hardcoded ALLOWLIST. A caller cannot inject an arbitrary donor id
  // without editing this file's own source. Also: a mismatched donor name
  // (wrong donor at the right id, or vice versa) is rejected rather than
  // silently accepted. ---
  {
    assert.deepEqual(Object.keys(KLEIN).sort(), ["amountCents", "donorId", "donorName", "expectedNoteFirstLine", "note", "purpose", "sourceInteractionId"].sort());
    const wrongNameDonor = donorFixture({ display_name: "Someone Else Entirely" });
    const interaction = interactionFixture();
    const result = validateEntry(KLEIN, { donor: wrongNameDonor, interaction, existingAsk: null });
    assert.equal(result.eligible, false);
    assert.match(result.reason, /display_name/);

    const wrongNote = interactionFixture({ summary: "Something unrelated entirely\nImported from Monday.com pipeline export." });
    const result2 = validateEntry(KLEIN, { donor: donorFixture(), interaction: wrongNote, existingAsk: null });
    assert.equal(result2.eligible, false);
    assert.match(result2.reason, /note first line/);
  }

  // --- 7: no reminders/recommendations are ever created -- the generated
  // SQL for a create only ever touches `asks`/`ask_changes`, and the
  // source file contains no INSERT INTO recommendations statement at all. ---
  {
    const interaction = interactionFixture();
    const plan = planAskCreate(KLEIN, interaction);
    assert.match(plan.insertAsk, /^INSERT INTO asks/);
    assert.match(plan.insertAuditRow, /^INSERT INTO ask_changes/);
    assert.doesNotMatch(plan.insertAsk, /recommendations/i);
    assert.doesNotMatch(plan.insertAuditRow, /recommendations/i);
    const source = await readFile(new URL("../scripts/ask-historical-backfill.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /INSERT INTO recommendations/i);
  }

  // --- 8: no giving/JL mutation -- neither the create plan nor the
  // cleanup plan references giving_activities/gifts anywhere. ---
  {
    const interaction = interactionFixture();
    const plan = planAskCreate(KLEIN, interaction);
    assert.doesNotMatch(plan.insertAsk, /giving_activities|gifts/i);
    assert.doesNotMatch(plan.insertAuditRow, /giving_activities|gifts/i);
    const cleanupPlan = planSummaryCleanup(KLEIN.donorId, donorFixture().relationship_summary, true);
    assert.doesNotMatch(cleanupPlan.sql, /giving_activities|gifts/i);
    const source = await readFile(new URL("../scripts/ask-historical-backfill.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /UPDATE\s+giving_activities|UPDATE\s+gifts|INSERT INTO giving_activities|INSERT INTO gifts/i);
  }

  // --- 9: rerun is idempotent -- both guards (WHERE NOT EXISTS on
  // asks.source_interaction_id, and on ask_changes.ask_id+action) are
  // present in the generated SQL, and a simulated D1 response reporting
  // changes:0 (guard matched, nothing inserted) is treated as a fail-
  // closed no-op, not an error requiring intervention or a duplicate. ---
  {
    const interaction = interactionFixture();
    const plan = planAskCreate(KLEIN, interaction);
    assert.match(plan.insertAsk, /WHERE NOT EXISTS \(SELECT 1 FROM asks WHERE source_interaction_id = /);
    assert.match(plan.insertAuditRow, /NOT EXISTS \(SELECT 1 FROM ask_changes ac WHERE ac\.ask_id = a\.id AND ac\.action = 'created'\)/);

    // Full rerun scenario via applyAsks(): first call succeeds (changes:1
    // both times), second call against a state now reporting an existing
    // ask (as a real fresh re-read would show) must not write again.
    const donor = donorFixture();
    let insertCalls = 0;
    const firstRun = applyAsks([KLEIN], {
      fetchStateFn: () => ({ donor, interaction, existingAsk: null }),
      writeFn: () => { insertCalls++; return [{ meta: { changes: 1 } }]; },
      log: () => {},
    });
    assert.equal(firstRun[0].status, "APPLIED");
    assert.equal(insertCalls, 2, "one insert for asks, one for ask_changes");

    const secondRun = applyAsks([KLEIN], {
      fetchStateFn: () => ({ donor, interaction, existingAsk: { id: firstRun[0].askId, donor_id: KLEIN.donorId, status: "pending" } }),
      writeFn: () => { insertCalls++; return [{ meta: { changes: 1 } }]; },
      fetchAuditCountFn: () => 1,
      log: () => {},
    });
    assert.equal(secondRun[0].status, "ALREADY_APPLIED");
    assert.equal(insertCalls, 2, "rerunning after a successful apply must not issue any further writes");
  }

  // --- 10: relationship_summary cleanup only occurs after Ask
  // verification -- planSummaryCleanup(..., askVerified: false) always
  // SKIPs regardless of how broken the current value is, and
  // cleanupSummaries() never calls its writeFn when verifyAskForCleanup
  // reports unverified (no ask found for the source interaction). ---
  {
    const plan = planSummaryCleanup(KLEIN.donorId, donorFixture().relationship_summary, false);
    assert.equal(plan.action, "SKIP");
    assert.match(plan.reason, /not freshly verified/);

    let writeCalls = 0;
    const results = cleanupSummaries([KLEIN], {
      fetchAskFn: () => null, // no ask exists yet for this source interaction
      fetchDonorFn: () => donorFixture(),
      writeFn: () => { writeCalls++; return [{ meta: { changes: 1 } }]; },
      log: () => {},
    });
    assert.equal(writeCalls, 0, "cleanup must never write when the Ask cannot be verified");
    assert.equal(results[0].status, "SKIPPED");
    assert.match(results[0].reason, /Ask not verified/);
  }

  // --- 11: cleanup uses exact-current-value compare-and-swap -- the
  // generated UPDATE is conditioned on the exact observed relationship_summary
  // value (hex-encoded), and a simulated stale-value race (writeFn
  // reporting changes:0) fails closed rather than clearing anyway. ---
  {
    const currentValue = donorFixture().relationship_summary;
    const plan = planSummaryCleanup(KLEIN.donorId, currentValue, true);
    assert.equal(plan.action, "CLEAR");
    assert.match(plan.sql, /^UPDATE donors SET relationship_summary = NULL WHERE id = '[^']*' AND relationship_summary = CAST\(X'[0-9a-f]*' AS TEXT\)$/);

    const existingAsk = { id: "ask-1", donor_id: KLEIN.donorId, amount_cents: KLEIN.amountCents, purpose: KLEIN.purpose };
    const results = cleanupSummaries([KLEIN], {
      fetchAskFn: () => existingAsk,
      fetchAuditCountFn: () => 1,
      fetchDonorFn: () => donorFixture({ relationship_summary: currentValue }),
      writeFn: () => [{ meta: { changes: 0 } }], // simulate a race: value changed since read
      log: () => {},
    });
    assert.equal(results[0].status, "FAILED_CLOSED");
    assert.match(results[0].reason, /changed since this run's read/);
  }

  // --- 12: institutional_memory can never be modified by this script --
  // no generated SQL string references it, and the source file contains
  // no write statement touching it anywhere. ---
  {
    const interaction = interactionFixture();
    const plan = planAskCreate(KLEIN, interaction);
    const cleanupPlan = planSummaryCleanup(KLEIN.donorId, donorFixture().relationship_summary, true);
    assert.doesNotMatch(plan.insertAsk, /institutional_memory/);
    assert.doesNotMatch(plan.insertAuditRow, /institutional_memory/);
    assert.doesNotMatch(cleanupPlan.sql, /institutional_memory/);
    const source = await readFile(new URL("../scripts/ask-historical-backfill.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /UPDATE\s+donors\s+SET[^;]*institutional_memory/is);
  }

  // --- 13: source interaction rows can never be modified -- no generated
  // SQL in this file contains an UPDATE/DELETE against `interactions`; the
  // only statements are INSERT INTO asks/ask_changes and UPDATE donors
  // (relationship_summary only). ---
  {
    const source = await readFile(new URL("../scripts/ask-historical-backfill.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /UPDATE\s+interactions/i);
    assert.doesNotMatch(source, /DELETE\s+FROM\s+interactions/i);
    assert.doesNotMatch(source, /INSERT INTO interactions/i);
  }

  // --- 14: no other donor's relationship_summary can be modified -- the
  // cleanup UPDATE's WHERE clause always includes both `id = <this donor>`
  // AND the exact current value; cleanupSummaries() only ever iterates the
  // 3-entry allowlist (or an explicitly-passed `entries` override for
  // testing), never a broader donor query. ---
  {
    for (const entry of ALLOWLIST) {
      const plan = planSummaryCleanup(entry.donorId, "Latest discussion topics: x.\nPeople mentioned: Solicited.\nRecommended next action: y.", true);
      assert.match(plan.sql, new RegExp(`WHERE id = '${entry.donorId}' AND`));
    }
    // isOldSolicitedFormat correctly distinguishes the reviewed broken
    // format from an already-clean or unrelated value -- so a donor whose
    // summary was independently changed to something else is never touched.
    assert.equal(isOldSolicitedFormat("A real relationship note about seminary plans."), false);
    assert.equal(isOldSolicitedFormat(null), false);
    assert.equal(isOldSolicitedFormat("Latest discussion topics: Event planning.\nPeople mentioned: Messaged.\nRecommended next action: x."), false, "must require the specific 'People mentioned: Solicited.' marker, not just any old-format value");
  }

  console.log("Ask historical-backfill safety checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
