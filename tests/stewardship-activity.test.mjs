import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { extractInteraction, ZMAN_APPRECIATION_PATTERN } from "../lib/capture/interaction.ts";
import { classifyRelationshipFact } from "../lib/relationships/fact-classification.ts";
import { planFactAcceptanceStep } from "../lib/relationships/fact-accept-plan.ts";

// Meaningful Stewardship Activity vs. Durable Relationship Intelligence
// -- the narrow distinction approved for this task (see docs/
// AI-HANDOFF.md). The real-world case: "Texted to welcome sons back to
// Yeshiva for the new zman" is legitimate, personalized donor/parent
// stewardship -- it must save normally and count as real contact -- but
// it teaches no NEW donor-specific fact, so it correctly does not
// propose one. The bug being fixed is purely that the Capture/Outcome
// UI's own wording implied the INTERACTION itself was meaningless when
// nothing was proposed; the underlying extraction/fact-acceptance
// architecture was never wrong and is NOT changed by this task.
//
// Investigation finding (documented here, not just in AI-HANDOFF.md):
// "Last Contact" / engagement recency (lib/relationships/
// meeting-brief.ts's interactions query, and recommendation-evidence.ts's
// lastContactAt/lastSubstantiveContactAt) already treats ANY saved,
// non-cancelled/archived interaction as real contact, completely
// independent of whether it produced a relationship fact -- no code
// change was needed there. The existing role='recipient' exclusion
// (already built for shared/broadcast activities) is the existing
// mechanism that already distinguishes a personalized touch from a mass
// broadcast for "substantive contact" purposes. This test proves both
// of those existing behaviors directly, rather than assuming them.

const root = path.resolve(import.meta.dirname, "..");
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const migrationDirectory = path.join(root, "drizzle");
const migrations = fs.readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();

function freshDatabase() {
  const database = new DatabaseSync(":memory:");
  for (const migration of migrations) database.exec(fs.readFileSync(path.join(migrationDirectory, migration), "utf8"));
  return database;
}

const NOW = Math.floor(Date.parse("2026-08-24T12:00:00Z") / 1000);
const DAY = 86400;

function seed(database) {
  database.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run("u1", "owner@example.test", NOW, NOW);
  database.prepare("INSERT INTO donors (id, owner_user_id, data_source, display_name, created_at, updated_at) VALUES (?, 'u1', 'live', ?, ?, ?)").run("d1", "Donor One", NOW, NOW);
}

// Mirrors lib/relationships/meeting-brief.ts's own interactions query
// literally (that file imports "cloudflare:workers" and can't be
// invoked directly in Node -- same established constraint as every
// other route/data-loader test in this suite), to prove directly
// against real SQLite that this query -- the actual source of "Last
// Contact"/lastCompletedInteraction/recentInteractions -- has no
// dependency on relationship_summary, donor_relationship_facts, or
// acceptance state at all.
function loadRecentInteractions(database, donorId, userId, now) {
  return database.prepare(`SELECT i.id, i.type, i.occurred_at, i.summary, i.role
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      WHERE i.donor_id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND i.occurred_at <= ? AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%'
        AND (i.source LIKE 'capture-completed:%' OR (i.source NOT LIKE 'capture-scheduled:%' AND i.occurred_at <= i.created_at))
      ORDER BY i.occurred_at DESC LIMIT 5`)
    .all(donorId, userId, userId, now);
}

const REAL_WORLD_NOTE = "Texted to welcome sons back to Yeshiva for the new zman";

async function run() {
  const captureExperience = await read("app/capture/CaptureExperience.tsx");
  const outcomeExperience = await read("app/interactions/[id]/outcome/OutcomeExperience.tsx");
  const captureRoute = await read("app/api/interactions/route.ts");
  const meetingBriefLib = await read("lib/relationships/meeting-brief.ts");

  // ================================================================
  // Extraction itself is UNCHANGED and correct: this real-world note
  // extracts no durable-fact proposal -- confirmed directly against the
  // real, unmodified extractInteraction(). This is the CORRECT,
  // intentional behavior this task must not weaken.
  // ================================================================
  const extracted = extractInteraction(REAL_WORLD_NOTE, "text", "");
  assert.equal(extracted.relationshipSummary, null, "this real-world stewardship note must NOT propose a durable relationship fact -- it teaches no new donor-specific knowledge, by design");
  assert.equal(extracted.type, "text");
  assert.equal(extracted.summary, REAL_WORLD_NOTE, "the interaction's own summary/content is preserved regardless of fact-worthiness");

  // ================================================================
  // The Capture/Outcome UI no longer implies the interaction itself is
  // meaningless -- the misleading message is gone, and the new one
  // correctly distinguishes "no NEW relationship fact" from "still
  // recorded as stewardship activity."
  // ================================================================
  assert.doesNotMatch(captureExperience, /No meaningful relationship details detected/, "the old, misleading message must be fully removed from Capture");
  assert.doesNotMatch(outcomeExperience, /No meaningful relationship details detected/, "the old, misleading message must be fully removed from Outcome");
  assert.match(captureExperience, /No new relationship details to save\. This interaction is still recorded as stewardship activity\./, "Capture must show wording that distinguishes the two concepts, never implying the interaction itself was meaningless");
  assert.match(outcomeExperience, /No new relationship details to save\. This interaction is still recorded as stewardship activity\./, "Outcome must show the same corrected wording");
  // Still gated identically to before: no checkbox/acceptance affordance
  // is offered when nothing was extracted (this task changes ONLY the
  // wording, never the underlying null-preview gating).
  assert.match(captureExperience, /preview\.relationshipSummary\s*\?\s*<div className="relationship-snapshot-preview">/, "the opt-in checkbox must still only appear for a real, non-null proposal");
  assert.match(outcomeExperience, /preview\.relationshipSummary !== null \? \(/, "the opt-in checkbox must still only appear for a real, non-null proposal");

  // ================================================================
  // The interaction saves normally regardless of fact-worthiness -- the
  // INSERT INTO interactions statement is unconditional; the fact-
  // acceptance block is a structurally separate, optional concern.
  // ================================================================
  const insertIndex = captureRoute.indexOf("INSERT INTO interactions");
  const acceptGateIndex = captureRoute.indexOf("body.acceptRelationshipSnapshot === true");
  assert.ok(insertIndex >= 0 && acceptGateIndex >= 0 && insertIndex < acceptGateIndex, "the interaction row must be created before, and independent of, the fact-acceptance gate");
  assert.match(captureRoute, /const statements = \[\s*env\.DB\.prepare\("INSERT INTO interactions/, "the interactions INSERT must be the first, unconditional entry in the statements array -- never itself wrapped in a conditional on extracted content");

  // ================================================================
  // Existing engagement/recency architecture already treats this
  // correctly, with NO code change: Meeting Brief's own interactions
  // query (the actual source of Last Contact/lastCompletedInteraction/
  // recentInteractions) has no dependency on relationship_summary,
  // donor_relationship_facts, or acceptance state.
  // ================================================================
  for (const forbidden of ["donor_relationship_facts", "relationship_summary", "acceptRelationshipSnapshot", "institutional_memory"]) {
    const interactionsQueryMatch = meetingBriefLib.match(/FROM interactions i JOIN donors[\s\S]{0,600}?LIMIT 5/);
    assert.ok(interactionsQueryMatch, "Meeting Brief's interactions query must be found in the file, matching the established shape");
    assert.doesNotMatch(interactionsQueryMatch[0], new RegExp(forbidden), `Meeting Brief's interactions query must never filter or join on ${forbidden} -- Last Contact must never depend on whether a fact was extracted or accepted`);
  }

  // Proven directly against real SQLite: an interaction with THIS exact
  // note, and NO relationship fact ever created for it, is still picked
  // up as the donor's most recent (and only) interaction -- i.e., it
  // fully counts toward Last Contact / lastCompletedInteraction.
  {
    const database = freshDatabase();
    seed(database);
    database.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, created_at, updated_at)
      VALUES ('int-steward', 'd1', 'u1', 'text', ?, ?, 'capture:text', ?, ?)`)
      .run(NOW, `\n${REAL_WORLD_NOTE}`, NOW, NOW);

    const recent = loadRecentInteractions(database, "d1", "u1", NOW);
    assert.equal(recent.length, 1, "the stewardship interaction must be found by the exact same query Meeting Brief uses for Last Contact/recentInteractions");
    assert.equal(recent[0].id, "int-steward");
    assert.equal(recent[0].role, null, "a plain single-donor Capture interaction (role null, never 'recipient') is treated as substantive contact -- the existing mechanism that already distinguishes a personalized touch from a mass broadcast");

    const factCount = database.prepare("SELECT COUNT(*) AS n FROM donor_relationship_facts WHERE donor_id = 'd1'").get().n;
    assert.equal(factCount, 0, "no durable relationship fact must exist -- this stewardship touch was never accepted as one and none was auto-created");
  }

  // A broadcast/shared-activity recipient of the exact same interaction
  // (role='recipient') is excluded from SUBSTANTIVE contact -- proving
  // the existing role mechanism is what actually distinguishes
  // "personalized stewardship" from "mass broadcast," not the presence
  // or absence of a relationship fact.
  {
    const database = freshDatabase();
    seed(database);
    database.prepare(`INSERT INTO interactions (id, donor_id, user_id, type, occurred_at, summary, source, role, created_at, updated_at)
      VALUES ('int-broadcast', 'd1', 'u1', 'text', ?, ?, 'capture:text', 'recipient', ?, ?)`)
      .run(NOW, "\nZman is starting soon! Wishing everyone a wonderful start to the new semester.", NOW, NOW);
    const recent = loadRecentInteractions(database, "d1", "u1", NOW);
    assert.equal(recent.length, 1, "a broadcast recipient row is still visible in the raw interaction/timeline query (never hidden)...");
    assert.equal(recent[0].role, "recipient");
    // ...but this is exactly the row lastSubstantiveContactAt's own
    // real-app filter (interactions.results.find(item => item.role !==
    // "recipient")) would correctly exclude -- verified structurally
    // against the actual, unmodified evidence-building code.
    const recommendationEvidence = fs.readFileSync(path.join(root, "lib/relationships/meeting-brief.ts"), "utf8");
    assert.match(recommendationEvidence, /interactions\.results\.find\(\(item\) => item\.role !== "recipient"\)/, "lastSubstantiveContactAt must still exclude broadcast recipients -- the existing, unmodified mechanism for personalized-vs-mass-broadcast");
  }

  // ================================================================
  // Positive control: when genuine, separate donor-specific
  // intelligence IS present in the note AND explicitly accepted, a
  // durable fact IS still created normally -- this task must not have
  // weakened that path at all.
  // ================================================================
  {
    const step = planFactAcceptanceStep(
      { facts: [], relationshipSummary: null, institutionalMemory: null },
      { donorId: "d1", userId: "u1", sourceInteractionId: "int-real-fact", sourceInteractionOccurredAt: NOW, noteText: "His daughter is Danielle.", kind: "call", subject: "", now: NOW, pinnedFresh: new Set() },
    );
    assert.ok(step.intent, "when the note genuinely contains new donor-specific knowledge and is explicitly accepted, a fact must still be proposed and created exactly as before");
    assert.equal(step.intent.newFact.factText, "His daughter is Danielle.");
    assert.equal(step.intent.newFact.category, "family_milestone");
  }

  // Rejection case for the stewardship note itself: even with explicit
  // acceptance requested, planFactAcceptanceStep() must produce nothing
  // for this exact real-world text, since nothing was ever extracted --
  // this is the same architecture the "accept" gate everywhere else in
  // this app already relies on, exercised here with the exact real note.
  {
    const step = planFactAcceptanceStep(
      { facts: [], relationshipSummary: null, institutionalMemory: null },
      { donorId: "d1", userId: "u1", sourceInteractionId: "int-steward", sourceInteractionOccurredAt: NOW, noteText: REAL_WORLD_NOTE, kind: "text", subject: "", now: NOW, pinnedFresh: new Set() },
    );
    assert.equal(step.intent, null, "no fact may be created for this stewardship note, even if acceptance were somehow requested, because nothing was ever extracted from it");
  }

  // ================================================================
  // Mass/broadcast-style Zman messages still do not become durable
  // Relationship Intelligence merely for containing "zman."
  // ================================================================
  const broadcastZman = extractInteraction("Zman is starting soon! Wishing everyone a wonderful start to the new semester.", "text", "");
  assert.equal(broadcastZman.relationshipSummary, null, "a generic, broadcast-style zman message must not propose a durable fact merely for containing the word 'zman'");
  assert.doesNotMatch("Zman is starting soon! Wishing everyone a wonderful start to the new semester.", ZMAN_APPRECIATION_PATTERN, "the narrow appreciation pattern must not match generic zman wording with no thanks/support language");

  // ================================================================
  // Existing Zman-appreciation behavior for genuine support/thanks
  // remains fully intact (Zachter's own real Phase 1 fact text).
  // ================================================================
  const genuineAppreciation = "Texted video from first day of Zman and thanked him for his support that makes it happen.";
  const appreciationExtracted = extractInteraction(genuineAppreciation, "text", "");
  assert.equal(appreciationExtracted.relationshipSummary, genuineAppreciation, "genuine zman-appreciation text (thanking a donor for support) must still propose a fact exactly as before");
  assert.deepEqual(classifyRelationshipFact(appreciationExtracted.relationshipSummary), { category: "engagement", lifecycle: "durable" }, "classification for genuine zman appreciation must be unchanged (matches Zachter's real Phase 1 fact)");

  console.log("stewardship-activity: ok");
}

await run();
