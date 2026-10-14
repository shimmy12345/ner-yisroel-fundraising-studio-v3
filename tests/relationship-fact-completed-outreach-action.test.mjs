import assert from "node:assert/strict";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { buildAgenda } from "../lib/agenda/agenda-model.ts";

// Completed Outreach Action Fix (2026-10-14) -- the Daily Fundraising
// Agenda recommended "Reach out and reference: Texted video from first
// day of Zman and thanked him for his support that makes it happen." for
// Mr. & Mrs. Yaakov Zachter, even though the fundraiser had already
// performed that exact outreach. Root cause traced live against real
// Production data: the fact's stored category (`engagement`) is not a
// singular-state category, and its text matched neither COMPLETED_WELL_
// WISH_PATTERN nor COMPLETED_MILESTONE_EVENT_PATTERN (lib/relationships/
// fact-classification.ts's two existing, narrower completed-touch
// patterns), so it fell through to the `durable` default and stayed
// permanently, fully-scored actionable -- no open reminder was ever
// required for it to keep firing. A second, independently-found live
// Production fact ("Spoke with him and gave him a tour of the new
// gym.") had the identical problem with no shared vocabulary at all,
// confirming this was systemic rather than one donor's wording. The fix
// (COMPLETED_OUTREACH_ACTION_PATTERN, same file) generalizes the shape --
// a sentence that OPENS with a past-tense outreach-contact verb is
// always a completed, point-in-time touch -- rather than adding a third
// narrow phrase list. This file proves the fix through the REAL
// recommendation pipeline end to end, exactly as tests/relationship-
// fact-completion-awareness.test.mjs already does for the two earlier
// patterns, never a reimplementation of either.

const NOW = 1760400000; // 2025-10-14T00:00:00Z-ish, consistent with this round's "now"
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

// The exact real Zachter fact shape, re-classified by THIS round's fix
// (lifecycle corrected from the stored `durable` to the now-correct
// `time_bound` -- see scripts/relationship-facts-lifecycle-reclassify.mjs
// for the one-time data correction this requires for the two already-
// written Production rows; a freshly-accepted fact would get `time_bound`
// immediately from classifyRelationshipFact()).
function zachterFact(daysOld) {
  return fact({
    factText: "Texted video from first day of Zman and thanked him for his support that makes it happen.",
    category: "engagement",
    lifecycle: "time_bound",
    sourceInteractionId: null,
    sourceInteractionOccurredAt: daysAgo(daysOld),
  });
}

async function run() {
  // --- 1: a completed outreach move must not be recommended as though
  // it remains undone. Zachter's real fact, ~54 days old (the real gap
  // between the logged touch, 2026-08-21, and the Production report,
  // 2026-10-14) -- well past the 30-day completed-touch window. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(54)], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "Zachter: completed outreach already performed must not be re-suggested");
  }

  // --- 1b: the second, independently-found real Production fact, same
  // shape, different vocabulary, proving the fix is general. ---
  {
    const f = fact({
      factText: "Spoke with him and gave him a tour of the new gym.",
      category: "engagement", lifecycle: "time_bound",
      sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(51),
    });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "a second, differently-worded completed outreach touch must also not be re-suggested");
  }

  // --- 2: a completed move with no open reminder must not automatically
  // trigger a duplicate recommendation. The real Zachter donor has zero
  // reminders/recommendations rows at all (confirmed read-only against
  // Production) -- `openReminder: null` here reproduces that exactly, and
  // confirms the absence of a reminder is not what should make this
  // actionable. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(54)], pendingAskSourceInteractionIds: [], openReminder: null });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "honor_reminder"), undefined, "no reminder exists, so none should be honored");
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "the absence of an open reminder must not, by itself, justify re-surfacing a completed move");
  }

  // --- 3: an actual outstanding follow-up remains eligible -- a
  // genuinely fresh completed-action-shaped fact (5 days old, nowhere
  // near the 30-day window) must still be actionable. The fix is a
  // shorter decay window for an already-stale touch, never a blanket
  // suppression of every sentence that opens with a contact verb. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(5)], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a genuinely recent completed-touch fact must still be actionable");
    assert.match(opportunity.action, /thanked him for his support/);
  }

  // --- 4: a completed interaction may support a genuinely new follow-up
  // when there is a separate, defensible reason. The same donor's old,
  // completed Zman touch must not contaminate a second, genuinely new
  // and unrelated engagement fact. ---
  {
    const freshTravel = fact({ factText: "He's planning a trip to Israel this Sukkos and asked about visiting campus.", category: "engagement", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(3) });
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(54), freshTravel], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a second, genuinely new fact for the same donor must still surface");
    assert.match(opportunity.action, /Sukkos/);
    assert.doesNotMatch(opportunity.action, /thanked him for his support/, "the completed, stale fact must never win over the fresh, unrelated one");
  }

  // --- 5: recommendations remain consistent between the dashboard (Today
  // page / buildDonorRecommendation) and the Daily Fundraising Agenda
  // (buildAgenda), exercised through their own real, unmodified
  // functions -- exactly mirroring tests/relationship-fact-completion-
  // awareness.test.mjs's own Sonnenblick/fresh-donor scenario. ---
  {
    const suppressedDonorEvidence = evidenceFor({
      donorId: "donor-zachter",
      lastSubstantiveContactAt: daysAgo(54),
      relationshipFacts: [zachterFact(54)],
      pendingAskSourceInteractionIds: [],
    });
    assert.equal(buildDonorRecommendation(suppressedDonorEvidence), null, "Today page: a donor whose only fact is a completed, stale outreach touch must get no recommendation at all");

    const freshDonorEvidence = evidenceFor({
      donorId: "donor-fresh",
      relationshipFacts: [fact({ factText: "Called and discussed the new building campaign timeline.", category: "general", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(4) })],
      pendingAskSourceInteractionIds: [],
    });
    const freshRecommendation = buildDonorRecommendation(freshDonorEvidence);
    assert.ok(freshRecommendation, "Today page: a donor with a fresh, uncompleted-in-substance fact must still get a recommendation");
    assert.equal(freshRecommendation.kind, "relationship_opportunity");

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
    assert.ok(agenda.suggested.some((item) => item.donorId === "donor-fresh"), "Daily Agenda: the fresh fact must appear in Suggested");
    assert.ok(agenda.suggested.every((item) => !/zman/i.test(item.headline) && !/zman/i.test(item.context)), "Daily Agenda: no stale Zachter-style recommendation must appear -- there is no priority for the suppressed donor to begin with");
  }

  // --- 6: existing payment-plan and pledge reconciliation protections
  // remain intact. A solicitation-category fact that happens to OPEN
  // with a contact verb ("Called and discussed building naming
  // opportunity.") must keep its own, deliberately longer 90-day window,
  // never the fast 30-day completed-touch window -- the subject matter
  // (an open ask) may still need follow-through even though the call
  // itself is done. 60 days old: past the fast window, well within
  // solicitation's own 90-day window. ---
  {
    const f = fact({ factText: "Called and discussed building naming opportunity.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(60) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    const solicit = generateCandidates(evidence).find((c) => c.kind === "solicit");
    assert.ok(solicit, "a solicitation fact that opens with a contact verb must keep solicitation's own, longer decay window, not the fast completed-touch window");
    assert.match(solicit.action, /naming opportunity/);
  }

  // A real open pledge/payment-plan candidate for the SAME donor must be
  // completely unaffected by a suppressed completed-touch fact sitting
  // alongside it -- mirrors tests/relationship-fact-completion-
  // awareness.test.mjs's own equivalent check for the milestone-event fix.
  {
    const evidence = evidenceFor({
      relationshipFacts: [zachterFact(54)],
      pendingAskSourceInteractionIds: [],
      openPledge: { balanceCents: 180000, campaign: "Annual Campaign", description: null, activityDate: daysAgo(70), activePaymentPlan: null },
    });
    const kinds = candidateKinds(evidence);
    assert.ok(kinds.includes("follow_up_pledge"), "an unrelated open pledge must still generate follow_up_pledge");
    assert.equal(kinds.includes("relationship_opportunity"), false, "the suppressed completed-touch fact must still be suppressed alongside the unrelated pledge candidate");
  }

  console.log("relationship-fact-completed-outreach-action: ok");
}

await run();
