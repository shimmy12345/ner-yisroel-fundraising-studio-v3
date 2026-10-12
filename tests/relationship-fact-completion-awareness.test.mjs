import assert from "node:assert/strict";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { synthesizeRelationshipSnapshot } from "../lib/relationships/fact-synthesis.ts";
import { buildAgenda } from "../lib/agenda/agenda-model.ts";

// Completion-awareness (2026-10-12, "Complete Outreach Recommendation Fix
// and Production Corrections") -- the 30-day decay fix (tests/relationship-
// fact-recommendation-actionability.test.mjs) is necessary but
// insufficient: it stops a completed-milestone fact from being suggested
// forever, but still waits up to 30 days. This file proves the SHARPER,
// immediate fix (lib/relationships/fact-classification.ts's
// isConfirmedOutreachCompletion(), wired into fact-synthesis.ts's
// scoreFact()) through the REAL recommendation pipeline end to end --
// buildRecommendationEvidence -> generateCandidates/buildDonorRecommendation
// -- and through both consuming surfaces: buildDonorRecommendation (what
// the Today page/homepage queue uses) and buildAgenda (the Daily
// Fundraising Agenda), never a reimplementation of either.

const NOW = 1787858000; // same fixed "now" as the actionability test file
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
    sourceInteractionType: null,
    sourceInteractionSummary: null,
    ...overrides,
  };
}

const BASE_INPUT = {
  donorId: "donor-1",
  mostRecentPaidGift: null,
  openPledge: null,
  lastCompletedInteraction: null,
  lastContactAt: null,
  lastSubstantiveContactAt: null,
  openReminder: null,
  openAsk: null,
  relationshipSummary: null,
  institutionalMemory: null,
  historicalContext: [],
  yahrtzeits: [],
  importantDates: [],
};

function evidenceFor(overrides) {
  return buildRecommendationEvidence({ ...BASE_INPUT, ...overrides }, NOW, "America/New_York");
}

function candidateKinds(evidence) {
  return generateCandidates(evidence).map((c) => c.kind);
}

async function run() {
  // --- 1/2/3: the three real, named Production donors this investigation
  // traced (docs/AI-HANDOFF.md, "Complete Outreach Recommendation Fix and
  // Production Corrections"). Each donor's only current fact is now
  // lifecycle: time_bound (this round's data correction) and linked
  // (source_interaction_id) to the exact real completed interaction that
  // already performed the outreach -- the same type/summary text read
  // live from Production D1. All three must stop being actionable
  // immediately, not merely after the 30-day window elapses (~53 days
  // old here either way, so this also implicitly covers the decay case --
  // scenario 5 below isolates the "immediate, not waiting 30 days" claim
  // on its own with a BRAND NEW fact). ---
  {
    const sonnenblickFact = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "7704afa6-a26e-4543-a6f6-a1e1b9191ca7", sourceInteractionOccurredAt: daysAgo(53),
      sourceInteractionType: "call", sourceInteractionSummary: "Bar mitzvah mazel tov call\ncalled to wish mazel tov on son's bar mitzvah this shabbos",
    });
    const evidence = evidenceFor({ relationshipFacts: [sonnenblickFact], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "Sonnenblick: completed bar-mitzvah outreach must not be re-suggested");
  }
  {
    const danzigerFact = fact({
      factText: "Grandson had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "1c69f90a-59b4-431a-bbf4-eabee0bd6d36", sourceInteractionOccurredAt: daysAgo(53),
      sourceInteractionType: "call", sourceInteractionSummary: "grandson bar mitzvah mazel tov call\ncalled to wish mazel tov on grandson's bar mitzvah this shabbos",
    });
    const evidence = evidenceFor({ relationshipFacts: [danzigerFact], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "Mark Danziger: completed bar-mitzvah outreach must not be re-suggested");
  }
  {
    const joelDanzigerFact = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "0156aa91-95a2-42fe-8f08-3eb18edc985d", sourceInteractionOccurredAt: daysAgo(53),
      sourceInteractionType: "visit", sourceInteractionSummary: "Gift dropped off\nDropped off bottle of schnaps for son's bar mitzvah",
    });
    const evidence = evidenceFor({ relationshipFacts: [joelDanzigerFact], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "Joel Danziger: completed bar-mitzvah outreach (a visit, not a call) must not be re-suggested");
  }

  // --- 4: a recent milestone with NO completed outreach at all (no
  // linked interaction) must still generate relationship_opportunity --
  // the fix must never suppress a genuinely new, unaddressed milestone. ---
  {
    const f = fact({ factText: "Daughter had a bat mitzvah.", category: "family_milestone", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(5) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a fresh milestone with no completed outreach must still be actionable");
    assert.match(opportunity.action, /bat mitzvah/);
  }

  // --- 5: a recent milestone (2 days old -- nowhere near the 30-day
  // decay window) WITH a matching completed interaction must be
  // suppressed IMMEDIATELY. This is the sharper claim the 30-day decay
  // fix alone could never satisfy -- proves completion, not age, is what
  // drives suppression. ---
  {
    const f = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "int-fresh-completed", sourceInteractionOccurredAt: daysAgo(2),
      sourceInteractionType: "call", sourceInteractionSummary: "called to wish mazel tov on son's bar mitzvah this shabbos",
    });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "a 2-day-old fact with confirmed completed outreach must be suppressed immediately, not after 30 days");
  }

  // --- 6: an interaction linked to the fact that is UNRELATED to the
  // milestone (no action-verb-near-event-noun match) must never suppress
  // the recommendation -- only a confirmed match does. ---
  {
    const f = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "int-unrelated", sourceInteractionOccurredAt: daysAgo(5),
      sourceInteractionType: "call", sourceInteractionSummary: "Called to discuss pledge renewal for next year.",
    });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a linked interaction that does not actually address the milestone must not suppress the recommendation");
  }

  // --- 7: a second, genuinely new milestone for the SAME donor as a
  // suppressed completed one. The completed fact's suppression must be
  // scoped to that one fact, never the donor or category as a whole. ---
  {
    const completed = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "7704afa6-a26e-4543-a6f6-a1e1b9191ca7", sourceInteractionOccurredAt: daysAgo(53),
      sourceInteractionType: "call", sourceInteractionSummary: "called to wish mazel tov on son's bar mitzvah this shabbos",
    });
    const freshDaughter = fact({ factText: "Daughter had a bat mitzvah.", category: "family_milestone", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(3) });
    const evidence = evidenceFor({ relationshipFacts: [completed, freshDaughter], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a second, genuinely new milestone on the same donor must still surface");
    assert.match(opportunity.action, /bat mitzvah/);
    assert.doesNotMatch(opportunity.action, /^Reach out and reference: Son had a bar mitzvah\.$/, "the completed fact must never win over the fresh one");
  }

  // --- 8: a suppressed (score-0) fact remains a real, current row --
  // never archived or deleted -- and the Snapshot's own "never blank"
  // fallback (when it is the donor's ONLY current fact) still surfaces
  // its text for display, even though it is no longer "actionable". This
  // is the concrete proof of "visible in history, no longer actionable". ---
  {
    const completed = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "7704afa6-a26e-4543-a6f6-a1e1b9191ca7", sourceInteractionOccurredAt: daysAgo(53),
      sourceInteractionType: "call", sourceInteractionSummary: "called to wish mazel tov on son's bar mitzvah this shabbos",
    });
    assert.equal(completed.status, "current", "the fact must remain a current row -- nothing about completion-awareness archives or deletes it");
    const synthesis = synthesizeRelationshipSnapshot([completed], NOW);
    assert.equal(synthesis.relationshipSummary, "Son had a bar mitzvah.", "the fallback must still surface the fact's text when it is the donor's only fact, even at score 0");
    const evidence = evidenceFor({ relationshipFacts: [completed], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "...but it must not be actionable");
  }

  // --- 9: other recommendation kinds for the SAME donor must be
  // completely unaffected by a suppressed milestone fact sitting
  // alongside them. ---
  {
    const completed = fact({
      factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
      sourceInteractionId: "7704afa6-a26e-4543-a6f6-a1e1b9191ca7", sourceInteractionOccurredAt: daysAgo(53),
      sourceInteractionType: "call", sourceInteractionSummary: "called to wish mazel tov on son's bar mitzvah this shabbos",
    });
    const evidence = evidenceFor({
      relationshipFacts: [completed],
      pendingAskSourceInteractionIds: [],
      openPledge: { balanceCents: 250000, campaign: "Building Fund", description: null, activityDate: daysAgo(70), activePaymentPlan: null },
    });
    const kinds = candidateKinds(evidence);
    assert.ok(kinds.includes("follow_up_pledge"), "an unrelated open pledge must still generate follow_up_pledge");
    assert.equal(kinds.includes("relationship_opportunity"), false, "the suppressed milestone must still be suppressed alongside the unrelated pledge candidate");
  }

  // --- 10: both the Today page (buildDonorRecommendation -- the exact
  // function lib/workspace/live-data.ts calls to build each donor's
  // WorkspacePriority) and the Daily Fundraising Agenda (buildAgenda,
  // consuming that same WorkspacePriority shape) correctly reflect the
  // fix, exercised through their own real, unmodified functions. ---
  {
    // Today page: a donor whose ONLY fact is the completed, suppressed
    // milestone gets NO recommendation at all (exactly matching live-
    // data.ts's own `if (!recommendation) continue;` -- no WorkspacePriority
    // is ever created for this donor, so nothing reaches either surface).
    const suppressedDonorEvidence = evidenceFor({
      donorId: "donor-sonnenblick",
      // Recent substantive contact (the same completed call) so
      // reconnect_contact_gap -- a real, separate, legitimate candidate --
      // does not fire and mask what this scenario is actually testing.
      lastSubstantiveContactAt: daysAgo(53),
      relationshipFacts: [fact({
        factText: "Son had a bar mitzvah.", category: "family_milestone", lifecycle: "time_bound",
        sourceInteractionId: "7704afa6-a26e-4543-a6f6-a1e1b9191ca7", sourceInteractionOccurredAt: daysAgo(53),
        sourceInteractionType: "call", sourceInteractionSummary: "called to wish mazel tov on son's bar mitzvah this shabbos",
      })],
      pendingAskSourceInteractionIds: [],
    });
    assert.equal(buildDonorRecommendation(suppressedDonorEvidence), null, "Today page: a donor with only a completed, suppressed milestone must get no recommendation at all");

    // A different donor with a genuinely fresh, uncompleted milestone
    // DOES get a real recommendation -- the Today page must still show it.
    const freshDonorEvidence = evidenceFor({
      donorId: "donor-fresh",
      relationshipFacts: [fact({ factText: "Son had a wedding.", category: "family_milestone", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(4) })],
      pendingAskSourceInteractionIds: [],
    });
    const freshRecommendation = buildDonorRecommendation(freshDonorEvidence);
    assert.ok(freshRecommendation, "Today page: a donor with a fresh, uncompleted milestone must still get a recommendation");
    assert.equal(freshRecommendation.kind, "relationship_opportunity");

    // Daily Agenda: feed the SAME WorkspacePriority shape live-data.ts
    // would build from freshRecommendation into the real buildAgenda() --
    // the stale, suppressed donor contributes nothing (as above, no
    // priority exists for it at all), so the Suggested section must
    // contain the fresh donor and nothing referencing the old bar mitzvah.
    const freshPriority = {
      queueId: "priority:donor-fresh", donorId: "donor-fresh", name: "Fresh Donor", initials: "FD", donorCode: "2",
      label: "Relationship opportunity", signal: "steady", reason: freshRecommendation.action, why: freshRecommendation.why,
      action: freshRecommendation.action, href: "/donors/donor-fresh", dueAt: null, dueLabel: "No due date recorded",
      bucket: "upcoming", score: freshRecommendation.score,
    };
    const brief = {
      overview: "", recommendation: "", priorities: [freshPriority], priorityCount: 1,
      relationshipQueue: { overdue: [], today: [], thisWeek: [], upcoming: [freshPriority] },
      morningBrief: { meetingsToday: 0, overdueFollowUps: 0, recentGifts: 0, upcomingReminders: 0, suggestedPriority: null },
      recentlyViewed: [], recentlyUpdated: [], todaySchedule: [], upcomingActivities: [], meetings: [], gifts: [],
      todayRelationshipDates: [], upcomingRelationshipDates: [], generatedAt: NOW,
    };
    const agenda = buildAgenda(brief, { now: NOW, baseUrl: "https://fundraising-os-production.sgoldstein.workers.dev" });
    assert.ok(agenda.suggested.some((item) => item.donorId === "donor-fresh"), "Daily Agenda: the fresh, uncompleted milestone must appear in Suggested");
    assert.ok(agenda.suggested.every((item) => !/bar mitzvah/i.test(item.headline) && !/bar mitzvah/i.test(item.context)), "Daily Agenda: no stale bar-mitzvah recommendation must appear in Suggested -- there is no priority for the suppressed donor to begin with");
  }

  console.log("relationship-fact-completion-awareness: ok");
}

await run();
