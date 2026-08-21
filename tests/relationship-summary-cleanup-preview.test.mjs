import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  classifyDonors,
  oldActionableRelationshipSnapshot,
  OLD_FORMAT_PREFIX,
} from "../scripts/relationship-summary-cleanup-preview.mjs";
import { actionableRelationshipSnapshot } from "../lib/capture/interaction.ts";

// Tests for the read-only relationship_summary/institutional_memory cleanup
// PREVIEW tool (scripts/relationship-summary-cleanup-preview.mjs). This
// script never writes to D1 -- these tests exercise the pure classification
// core (classifyDonors) against synthetic fixtures, not live staging data,
// so they run offline with no wrangler/D1 round-trip.

const EPOCH = 1700000000; // fixed, arbitrary -- only relative ordering/display matters
let nextDonorId = 0;
let nextInteractionId = 0;

// Builds a {donor, interactionsByDonor} pair whose interaction summary is
// `subject\n${note}`, matching splitInteractionSummary's own convention, so
// candidateTexts() finds `note` as its first candidate.
function fixture(relationshipSummary, { note, kind, subject = "Subject" }) {
  const donor = { id: `donor-${nextDonorId++}`, display_name: "Test Donor", relationship_summary: relationshipSummary, institutional_memory: null };
  const interactionsByDonor = new Map();
  if (note !== undefined) {
    interactionsByDonor.set(donor.id, [
      { id: `int-${nextInteractionId++}`, type: kind, summary: `${subject}\n${note}`, occurred_at: EPOCH },
    ]);
  }
  return { donor, interactionsByDonor };
}

function classifyOne(relationshipSummary, opts) {
  const { donor, interactionsByDonor } = fixture(relationshipSummary, opts);
  const buckets = classifyDonors([donor], interactionsByDonor);
  const [bucketName] = Object.entries(buckets).find(([, items]) => items.some((item) => item.donor.id === donor.id)) ?? [];
  const item = bucketName ? buckets[bucketName].find((i) => i.donor.id === donor.id) : undefined;
  return { bucketName, item, buckets };
}

async function run() {
  const MESSAGED_NOTE = "Messaged about the building fund update.";
  const SOLICITED_CAMPAIGN_NOTE = "Solicited for the annual campaign.";
  // Deliberately NOT "solicited" -- as of 2026-08-21, "solicited" is a
  // real SOLICITATION_FACT_TERMS entry (see interaction.ts), so a note
  // using that word now produces a real fact, no longer exercising the
  // "dollar amount present, no fact signal found" code path this fixture
  // exists to test.
  const DOLLAR_NO_SIGNAL_NOTE = "Mentioned a figure of $5k in passing.";
  const YESHIVA_NOTE = "Visited the Yeshiva today.";
  const DAVID_NOTE = "David Cohen mentioned that his daughter is starting seminary in Israel this fall.";
  const MIXED_NOTE = "Ran into Sarah Klein at the grocery store, said hello.";

  // --- 1: the exact live bug -- old-format "People mentioned: Messaged."
  // (the channel verb misread as a person name) traces to its source note,
  // the current extractor finds nothing worth keeping in that note, and it
  // carries no dollar amount or named entity -- safe to clear. ---
  {
    const value = oldActionableRelationshipSnapshot(MESSAGED_NOTE, "text");
    assert.match(value, /People mentioned: Messaged\./);
    const { bucketName, item } = classifyOne(value, { note: MESSAGED_NOTE, kind: "text" });
    assert.equal(bucketName, "SAFE_TO_CLEAR");
    assert.equal(item.proposed, null);
  }

  // --- 2: old-format "Solicited" junk -- the CRM-status-verb false
  // positive the extractor already excludes from People mentioned (a
  // completely separate system from fact-signal detection -- see
  // lib/capture/interaction.ts's SOLICITATION_FACT_TERMS comment). As of
  // the 2026-08-21 Relationship Intelligence Phase 1 backfill-preview
  // review, "solicited" is now a real evidenced SOLICITATION_FACT_TERMS
  // entry (three real staging donors' text: "Solicited for a plaque
  // ($5k)"/"Solicited for $10k"/etc.), so the CURRENT extractor now finds
  // a genuine specific fact here -- SAFE_TO_REGENERATE, not SAFE_TO_
  // CLEAR. Updated from this test's own prior expectation deliberately,
  // not silently: the old assertion (SAFE_TO_CLEAR, proposed: null) was
  // correct only because "solicited" used to have no fact-signal term at
  // all; that gap is exactly what was fixed. ---
  {
    const value = oldActionableRelationshipSnapshot(SOLICITED_CAMPAIGN_NOTE, "note");
    assert.doesNotMatch(value, /People mentioned:/, "the old generator's own CRM-status-verb exclusion already keeps 'Solicited' out of People mentioned");
    const { bucketName, item } = classifyOne(value, { note: SOLICITED_CAMPAIGN_NOTE, kind: "note" });
    assert.equal(bucketName, "SAFE_TO_REGENERATE");
    assert.equal(item.proposed, "Solicited for the annual campaign.", "the current extractor now correctly finds and preserves this specific solicitation fact, rather than discarding it as boilerplate");
  }

  // --- 3: pure boilerplate snapshot (an "Organizations mentioned: Yeshiva."
  // line the current extractor correctly discards as non-qualifying) with
  // no fact, no dollar amount, no named entity -- also clears cleanly. ---
  {
    const value = oldActionableRelationshipSnapshot(YESHIVA_NOTE, "visit");
    assert.match(value, /Organizations mentioned: Yeshiva\./);
    const { bucketName, item } = classifyOne(value, { note: YESHIVA_NOTE, kind: "visit" });
    assert.equal(bucketName, "SAFE_TO_CLEAR");
    assert.equal(item.proposed, null);
  }

  // --- 4: a meaningful old note -- current extractor finds a real,
  // specific fact -- regenerate using it, not clear it. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    assert.ok(value.startsWith(OLD_FORMAT_PREFIX));
    const { bucketName, item } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    assert.equal(bucketName, "SAFE_TO_REGENERATE");
    assert.equal(item.proposed, actionableRelationshipSnapshot(DAVID_NOTE, "note"));
    assert.equal(item.proposed, DAVID_NOTE);
  }

  // --- 5: mixed/ambiguous content -- current extractor finds no
  // promotable fact, but the source note still contains a named person
  // ("Sarah Klein") its keyword coverage doesn't recognize as a fact
  // signal -- must NOT be silently cleared, needs a human read. ---
  {
    const value = oldActionableRelationshipSnapshot(MIXED_NOTE, "note");
    const { bucketName, item } = classifyOne(value, { note: MIXED_NOTE, kind: "note" });
    assert.equal(bucketName, "NEEDS_REVIEW");
    assert.equal(item.proposed, null);
    assert.match(item.reason, /Sarah Klein/);
  }

  // --- 5b: same needs-review protection for a bare dollar amount
  // ("$5k") the extractor's keyword list doesn't treat as a fact signal. ---
  {
    const value = oldActionableRelationshipSnapshot(DOLLAR_NO_SIGNAL_NOTE, "note");
    const { bucketName, item } = classifyOne(value, { note: DOLLAR_NO_SIGNAL_NOTE, kind: "note" });
    assert.equal(bucketName, "NEEDS_REVIEW");
    assert.equal(item.proposed, null);
    assert.match(item.reason, /dollar amount/);
  }

  // --- 6: manual/provenance-uncertain -- not old-format, and no
  // interaction on file reproduces it under the current extractor either
  // (here: no interactions at all) -- cannot prove provenance, left
  // untouched rather than guessed at. ---
  {
    const value = "Long-time major donor, prefers phone calls over email.";
    const { bucketName, item } = classifyOne(value, {});
    assert.equal(bucketName, "MANUAL_UNCERTAIN");
    assert.equal(item.proposed, null);
  }

  // --- 7: already-good -- not old-format, and traces exactly to what the
  // CURRENT extractor produces from an interaction on file -- already the
  // clean post-fix format, left untouched (no proposed change). ---
  {
    const value = actionableRelationshipSnapshot(DAVID_NOTE, "note");
    const { bucketName, item } = classifyOne(value, { note: DAVID_NOTE, kind: "note" });
    assert.equal(bucketName, "ALREADY_GOOD");
    assert.equal(item.proposed, null);
  }

  // --- 8: the preview is idempotent -- classifying the same input twice
  // (a fresh Map each time, since Maps are consumed by reference but never
  // mutated) produces byte-identical bucket output. ---
  {
    const value = oldActionableRelationshipSnapshot(DAVID_NOTE, "note");
    const donor = { id: "donor-idempotent", display_name: "Idempotent Donor", relationship_summary: value, institutional_memory: null };
    const interactionsByDonor = new Map([[donor.id, [{ id: "int-idempotent", type: "note", summary: `Subject\n${DAVID_NOTE}`, occurred_at: EPOCH }]]]);
    const first = classifyDonors([donor], interactionsByDonor);
    const second = classifyDonors([donor], interactionsByDonor);
    assert.deepEqual(first, second);
  }

  // --- 9: the PREVIEW path performs no writes. `classifyDonors` and
  // `fetchLiveClassification` (which `run()` uses) are never given a
  // writeFn and never build write SQL. A separate, explicitly-gated apply
  // path (planApply/executePlan, added after this preview tool -- see
  // tests/relationship-summary-apply.test.mjs) does contain exactly one
  // write statement; this test pins it to a single, tightly-scoped,
  // conditional UPDATE of `donors.relationship_summary` only -- never an
  // INSERT/DELETE, never unconditional, never touching another column. ---
  {
    const source = await readFile(new URL("../scripts/relationship-summary-cleanup-preview.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(INSERT INTO|DELETE FROM)\b/i, "the script must never contain an INSERT or DELETE");
    const updateStatements = [...source.matchAll(/UPDATE\s+donors\s+SET[^`]*?(?=`|\n\s*\);)/gis)];
    assert.equal(updateStatements.length, 1, "expected exactly one UPDATE statement in the whole file (the gated apply-mode write)");
    const [update] = updateStatements;
    assert.match(update[0], /^UPDATE donors SET relationship_summary = /, "the only write must set relationship_summary, and nothing else, first");
    assert.doesNotMatch(update[0], /,\s*\w+\s*=/, "the write must assign exactly one column -- no comma-separated second assignment");
    assert.doesNotMatch(update[0], /institutional_memory/, "the write must never touch institutional_memory");
    assert.match(update[0], /WHERE id = .* AND relationship_summary = /, "the write must be conditional on both id and the exact previously-observed value (compare-and-swap), never an unconditional bulk UPDATE");
    const wranglerCalls = [...source.matchAll(/wranglerJson\(\s*\n?\s*`?"?(SELECT[^)]*)/gi)];
    assert.ok(wranglerCalls.length >= 2, "expected at least the donors and interactions SELECT queries");
  }

  // --- 10: regeneration reuses the CURRENT production extractor -- the
  // script imports it directly from lib/capture/interaction.ts rather than
  // reimplementing it; only a clearly-labeled LEGACY block (used solely for
  // tracing old-format provenance, never for proposed values) is local. ---
  {
    const source = await readFile(new URL("../scripts/relationship-summary-cleanup-preview.mjs", import.meta.url), "utf8");
    assert.match(source, /import\s*\{[^}]*actionableRelationshipSnapshot[^}]*\}\s*from\s*"\.\.\/lib\/capture\/interaction\.ts"/s, "must import the real production extractor, not reimplement it");
  }

  // --- 11: institutional_memory is audited separately and never touched
  // by this classification -- a donor with old-format-looking
  // institutional_memory but a clean relationship_summary is classified
  // purely on relationship_summary, and no bucket item ever exposes or
  // proposes a change to institutional_memory. ---
  {
    const cleanValue = actionableRelationshipSnapshot(DAVID_NOTE, "note");
    const donor = {
      id: "donor-im-separate", display_name: "IM Separate Donor",
      relationship_summary: cleanValue,
      institutional_memory: oldActionableRelationshipSnapshot(MESSAGED_NOTE, "text"), // old-junk-shaped, but a DIFFERENT field
    };
    const interactionsByDonor = new Map([[donor.id, [{ id: "int-im-separate", type: "note", summary: `Subject\n${DAVID_NOTE}`, occurred_at: EPOCH }]]]);
    const buckets = classifyDonors([donor], interactionsByDonor);
    const item = Object.values(buckets).flat().find((i) => i.donor.id === donor.id);
    assert.equal(item.value, cleanValue, "classification must operate on relationship_summary, not institutional_memory");
    for (const bucketItems of Object.values(buckets)) {
      for (const bucketItem of bucketItems) {
        assert.notEqual(bucketItem.value, donor.institutional_memory);
        assert.notEqual(bucketItem.proposed, donor.institutional_memory);
      }
    }
  }

  // --- 12: the existing relationship-intelligence quality tests -- which
  // guard the same extractor this preview tool reuses -- remain green. ---
  {
    const result = spawnSync(process.execPath, [new URL("./relationship-quality.test.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { encoding: "utf8" });
    assert.equal(result.status, 0, `relationship-quality.test.mjs must still pass:\n${result.stdout}\n${result.stderr}`);
  }

  console.log("Relationship-summary cleanup preview classification checks passed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
