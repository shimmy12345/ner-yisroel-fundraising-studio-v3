import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveRelationshipSnapshot, synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";

// Relationship Snapshot Architecture Stage 3 (see docs/AI-HANDOFF.md) --
// proves resolveRelationshipSnapshot() (the ONE shared resolver every
// display/context surface must use) correctly distinguishes "facts
// exist -- live-synthesize, never fall back to stale cache" from "zero
// facts -- the existing cached columns byte-for-byte," using the real
// unmodified synthesizeRelationshipSnapshot() underneath (never a
// second algorithm), plus structural proof that the donor page, Meeting
// Brief, and Assistant actually route through this one resolver instead
// of independently reimplementing fallback logic.

const NOW = 1787858000; // fixed "now", matching Stage 2's own fixed epoch
const DAY = 86400;
const daysAgo = (days) => NOW - days * DAY;

function fact(overrides) {
  return {
    factText: "Fact text.",
    category: "general",
    lifecycle: "durable",
    status: "current",
    sourceInteractionId: null,
    sourceInteractionOccurredAt: NOW,
    ...overrides,
  };
}

async function run() {
  // --- 1: zero-fact donor -- exact legacy fallback, byte-for-byte,
  // regardless of how "stale" or unusual the cached text looks. No
  // cleanup, no rewriting, no normalization. ---
  {
    const cached = { relationshipSummary: null, institutionalMemory: "Call context: Discussed Kollel donation and said to follow up after succos" };
    const resolved = resolveRelationshipSnapshot([], cached, NOW);
    assert.deepEqual({ relationshipSummary: resolved.relationshipSummary, institutionalMemory: resolved.institutionalMemory }, cached, "zero-fact donor must get the cached values back byte-for-byte");
    assert.equal(resolved.source, "cache", "zero-fact donor must be reported as resolved from cache");
  }

  // --- 2: Zachter cache-drift regression -- a donor WITH a real,
  // correctly-migrated fact whose cached institutional_memory is stale
  // (a pre-Phase-2 templated string, "Text Message context: ...",
  // captured before this fact's own creation ever ran synthesis). The
  // resolver must ignore that stale cached text entirely and return the
  // live-synthesized value instead. ---
  {
    const zachterFact = fact({ factText: "Texted video from first day of Zman and thanked him for his support that makes it happen.", category: "engagement", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(6) });
    const staleCached = { relationshipSummary: "Texted video from first day of Zman and thanked him for his support that makes it happen.", institutionalMemory: "Text Message context: Texted video from first day of Zman and thanked him for his support that makes it happen" };
    const resolved = resolveRelationshipSnapshot([zachterFact], staleCached, NOW);
    assert.equal(resolved.source, "facts", "a donor with a real fact row must resolve from facts, not cache");
    assert.equal(resolved.institutionalMemory, "Texted video from first day of Zman and thanked him for his support that makes it happen.", "the live-synthesized value must win");
    assert.doesNotMatch(resolved.institutionalMemory ?? "", /Text Message context/, "the stale cached template prefix must never leak into the resolved current-state text");
    assert.equal(resolved.relationshipSummary, resolved.institutionalMemory, "with a single current fact, both surfaces show the same verbatim text");
  }

  // --- 3/4/5: Klein/Rovinsky/Pfeiffer -- historical fact remains fully
  // intact and IS displayed (the resolver's "facts" path, never blank),
  // while the SAME fact set is separately confirmed to no longer be
  // actionable via Stage 2's own findMostActionableFact() (imported
  // fresh below) -- proving display and actionability are governed by
  // different, correctly-decoupled rules, exactly as approved. ---
  {
    const { findMostActionableFact } = await import("../lib/relationships/fact-synthesis.ts");
    const cases = [
      { name: "Klein", factText: "Solicited for a plaque ($5k)", sourceInteractionId: "monday-interaction-5a79919d", ageDays: 294, cachedMemory: "Note context: Solicited for a plaque ($5k)" },
      { name: "Rovinsky", factText: "Solicited for a plaque in memory of his wife ($5k)", sourceInteractionId: "monday-interaction-6d655cb9", ageDays: 332, cachedMemory: "Note context: Solicited for a plaque in memory of his wife ($5k)" },
      { name: "Pfeiffer", factText: "Solicited for $10k", sourceInteractionId: "monday-interaction-7161c502", ageDays: 346, cachedMemory: "Note context: Solicited for $10k" },
    ];
    for (const { name, factText, sourceInteractionId, ageDays, cachedMemory } of cases) {
      const f = fact({ factText, category: "solicitation", lifecycle: "time_bound", sourceInteractionId, sourceInteractionOccurredAt: daysAgo(ageDays) });
      const cached = { relationshipSummary: null, institutionalMemory: cachedMemory };
      const resolved = resolveRelationshipSnapshot([f], cached, NOW, new Set()); // ask resolved -- not pending, not pinned
      assert.equal(resolved.source, "facts", `${name}: must resolve from the real fact, not the cache`);
      assert.equal(resolved.institutionalMemory, `${factText}.`, `${name}: the historical fact text must still be displayed (never blank while any fact exists)`);
      assert.notEqual(resolved.institutionalMemory, cachedMemory, `${name}: the resolved text must differ from the stale "Note context:"-prefixed cache`);
      assert.equal(f.status, "current", `${name}: the historical fact itself is untouched -- still status:current, never archived or deleted`);
      const actionable = findMostActionableFact([f], NOW, new Set(), "solicitation");
      assert.equal(actionable, null, `${name}: the same fact must NOT be actionable (Stage 2, unchanged) even though it IS displayed (Stage 3)`);
    }
  }

  // --- 6: Nussbaum-shaped positive control -- cached and synthesized
  // output already agree; Stage 3 must not change correct content. ---
  {
    const nussbaumFact = fact({ factText: "sent text to wish happy birthday.", category: "family_milestone", lifecycle: "durable", sourceInteractionId: "af8f3689-9caf-4793-8693-a71e65542549", sourceInteractionOccurredAt: daysAgo(1) });
    const cached = { relationshipSummary: "sent text to wish happy birthday.", institutionalMemory: "sent text to wish happy birthday." };
    const resolved = resolveRelationshipSnapshot([nussbaumFact], cached, NOW);
    assert.equal(resolved.relationshipSummary, cached.relationshipSummary, "positive control: resolved summary must match the already-correct cached value");
    assert.equal(resolved.institutionalMemory, cached.institutionalMemory, "positive control: resolved memory must match the already-correct cached value");
  }

  // --- 7: pending-Ask-linked solicitation fact is pinned in DISPLAY
  // synthesis, even far past its category's decay window. No D1 write,
  // no mutation hook -- purely a different pinnedFresh Set passed in. ---
  {
    const pendingFact = fact({ factText: "Asked about a $5,000 gala sponsorship.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: "int-pending", sourceInteractionOccurredAt: daysAgo(200) });
    const pinned = resolveRelationshipSnapshot([pendingFact], { relationshipSummary: null, institutionalMemory: null }, NOW, new Set(["int-pending"]));
    assert.equal(pinned.institutionalMemory, "Asked about a $5,000 gala sponsorship.", "a pending-ask-linked fact must be pinned fresh and displayed regardless of age");

    // --- 8: the SAME fact, after the ask resolves -- pin removed, purely
    // by passing a different (now-empty) pinnedFresh set. The fact object
    // itself is byte-identical; nothing was written anywhere. ---
    const resolvedAfterAsk = resolveRelationshipSnapshot([pendingFact], { relationshipSummary: null, institutionalMemory: null }, NOW, new Set());
    // Still displayed (never-blank fallback, since it is the donor's sole
    // fact) -- historical text preserved -- but no longer PINNED, which
    // is what a live actionability check (Stage 2) would key off of.
    assert.equal(resolvedAfterAsk.institutionalMemory, "Asked about a $5,000 gala sponsorship.", "the historical fact must remain displayable via the existing fallback rules even once its ask resolves");
  }

  // --- 9: multiple facts -- durable + time-bound + superseded + archived,
  // ranking/capping into relationship_summary vs institutional_memory.
  // Directly delegates to the real synthesizeRelationshipSnapshot() --
  // asserted equal, proving no second synthesis algorithm exists. ---
  {
    const facts = [
      fact({ factText: "His daughter is Danielle.", category: "family_milestone", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(700) }),
      fact({ factText: "Old superseded solicitation.", category: "solicitation", lifecycle: "time_bound", status: "superseded", sourceInteractionOccurredAt: daysAgo(400) }),
      fact({ factText: "Archived note.", category: "general", lifecycle: "durable", status: "archived_with_source", sourceInteractionOccurredAt: daysAgo(2) }),
      fact({ factText: "Planning a trip to Israel this Sukkos.", category: "engagement", lifecycle: "time_bound", sourceInteractionOccurredAt: daysAgo(10) }),
      fact({ factText: "Very close with Rabbi Cohen.", category: "general", lifecycle: "durable", sourceInteractionOccurredAt: daysAgo(1) }),
    ];
    const resolved = resolveRelationshipSnapshot(facts, { relationshipSummary: null, institutionalMemory: null }, NOW);
    const direct = synthesizeRelationshipSnapshot(facts, NOW);
    assert.deepEqual({ relationshipSummary: resolved.relationshipSummary, institutionalMemory: resolved.institutionalMemory }, direct, "the resolver must delegate byte-for-byte to the real synthesizeRelationshipSnapshot() -- never a second formula");
    assert.doesNotMatch(resolved.institutionalMemory ?? "", /superseded solicitation|Archived note/, "superseded/archived facts must never participate in current synthesis");
  }

  // --- 10: a donor whose only fact row is archived (facts.length > 0,
  // but zero CURRENT facts) must NOT silently fall back to the cache --
  // "facts exist" (even non-current ones) means the cache is no longer
  // authoritative, matching Stage 2's own hasStructuredFacts principle
  // extended to display. ---
  {
    const onlyArchived = [fact({ factText: "Solicited for $5,000.", category: "solicitation", lifecycle: "time_bound", status: "archived_with_source", sourceInteractionOccurredAt: daysAgo(5) })];
    const cached = { relationshipSummary: "Note context: Solicited for $5,000", institutionalMemory: "Note context: Solicited for $5,000" };
    const resolved = resolveRelationshipSnapshot(onlyArchived, cached, NOW);
    assert.equal(resolved.source, "facts", "any fact row, even archived, means the cache is no longer authoritative");
    assert.equal(resolved.relationshipSummary, null, "an archived-only fact set must resolve to null, never silently fall back to the cached text");
    assert.equal(resolved.institutionalMemory, null);
  }

  // --- 11: structural proof the shared resolver is actually wired into
  // every required surface, not merely available and unused. ---
  {
    const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
    const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
    const meetingBriefModel = await readFile(new URL("../lib/relationships/meeting-brief-model.ts", import.meta.url), "utf8");
    const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
    const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
    const factSynthesis = await readFile(new URL("../lib/relationships/fact-synthesis.ts", import.meta.url), "utf8");

    assert.match(factSynthesis, /export function resolveRelationshipSnapshot/, "the shared resolver must exist and be exported");
    assert.match(donorPage, /resolveRelationshipSnapshot\(/, "the donor page must call the shared resolver");
    assert.match(donorPage, /sanitizeScheduledRelationshipContext\(resolvedSnapshot\.relationshipSummary, resolvedSnapshot\.institutionalMemory/, "the donor page's displayed Snapshot must come from the resolver's output, not the raw donor row");
    assert.match(meetingBrief, /resolveRelationshipSnapshot\(/, "Meeting Brief's loader must call the shared resolver");
    assert.match(meetingBriefModel, /relationshipSnapshot:/, "MeetingBrief's type/return must carry the resolved snapshot for downstream consumers (Assistant)");
    assert.match(assistantRoute, /primaryMeetingBrief\s*\?\s*primaryMeetingBrief\.relationshipSnapshot/, "Assistant must prefer Meeting Brief's already-resolved live Snapshot");
    assert.doesNotMatch(assistantRoute, /new RuleBasedAIService[\s\S]*resolveRelationshipSnapshot/, "Assistant must never implement its own separate Relationship Intelligence resolution");
    // Workspace/Homepage and Daily Agenda expose no separate Relationship
    // Snapshot display text of their own (confirmed by investigation --
    // their only narrative-column reads feed Stage 2's already fact-aware
    // recommendation evidence, never a standalone Snapshot card) -- so
    // live-data.ts is correctly NOT wired to the Stage 3 resolver.
    assert.doesNotMatch(liveData, /resolveRelationshipSnapshot/, "live-data.ts has no separate Snapshot display surface and must not call the resolver");
  }

  // --- 12: no N+1 / new query introduced -- exact D1 prepared-statement
  // counts for every affected surface, pinned so a future regression
  // (or this round's own change) cannot silently add a query. Donor
  // page (24) and live-data.ts (19) are unchanged from Stage 2's own
  // pinned counts (see tests/today.test.mjs, tests/workspace-brief-
  // instrumentation.test.mjs); meeting-brief.ts and the Assistant route
  // are newly pinned here. ---
  {
    const donorPage = await readFile(new URL("../app/donors/[id]/page.tsx", import.meta.url), "utf8");
    const meetingBrief = await readFile(new URL("../lib/relationships/meeting-brief.ts", import.meta.url), "utf8");
    const assistantRoute = await readFile(new URL("../app/api/assistant/route.ts", import.meta.url), "utf8");
    const liveData = await readFile(new URL("../lib/workspace/live-data.ts", import.meta.url), "utf8");
    assert.equal((donorPage.match(/env\.DB\.prepare\(/g) ?? []).length, 24, "Stage 3 must add zero new queries to the donor page (still the Stage 2 count)");
    assert.equal((meetingBrief.match(/env\.DB\.prepare\(/g) ?? []).length, 15, "Stage 3 must add zero new queries to meeting-brief.ts -- the resolver reuses the already-fetched relationshipFactRows/openAskRows");
    assert.equal((assistantRoute.match(/env\.DB\.prepare\(/g) ?? []).length, 4, "Stage 3 must add zero new queries to the Assistant route -- it reuses Meeting Brief's already-resolved Snapshot instead of a second lookup");
    assert.equal((liveData.match(/env\.DB\.prepare\(/g) ?? []).length, 19, "live-data.ts must be completely untouched by Stage 3");
  }

  console.log("relationship-snapshot-stage3: ok");
}

await run();
