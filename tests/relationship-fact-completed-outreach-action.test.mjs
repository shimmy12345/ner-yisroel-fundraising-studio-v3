import assert from "node:assert/strict";
import { buildRecommendationEvidence } from "../lib/relationships/recommendation-evidence.ts";
import { generateCandidates } from "../lib/relationships/recommendation-candidates.ts";
import { buildDonorRecommendation } from "../lib/relationships/recommendation-rank.ts";
import { buildAgenda } from "../lib/agenda/agenda-model.ts";

// Completed Outreach Action Fix (2026-10-14, two rounds -- see
// docs/AI-HANDOFF.md for both). The Daily Fundraising Agenda recommended
// "Reach out and reference: Texted video from first day of Zman and
// thanked him for his support that makes it happen." for Mr. & Mrs.
// Yaakov Zachter, even though the fundraiser had already performed that
// exact outreach. A second, independently-found live Production fact
// ("Spoke with him and gave him a tour of the new gym.") had the
// identical problem with no shared vocabulary, confirming this was
// systemic.
//
// Round 1 (lib/relationships/fact-classification.ts's
// COMPLETED_OUTREACH_ACTION_PATTERN) generalized the two existing narrow
// completed-touch patterns into a shape-based one and gave it a 30-day
// decay window. The owner reviewed that result and correctly rejected
// it: a completed outreach action could still be recommended during
// those first 30 days, which is exactly what should never happen for an
// action the fundraiser already took, regardless of how recent it is.
//
// Round 2 (lib/relationships/fact-synthesis.ts's scoreFact(), lib/
// relationships/fact-classification.ts's isUnambiguousCompletedOutreach
// Action()) removes the grace window entirely for this class of fact:
// an ACTION report (the fundraiser's own past-tense contact verb leading
// the sentence) scores 0 immediately, at ANY age, checked against the
// fact's own TEXT rather than its stored `lifecycle` -- which also makes
// it self-healing for the two rows already written in Production with
// the stale `durable` value, no data migration required. This is
// deliberately NOT applied to COMPLETED_MILESTONE_EVENT_PATTERN (a bare
// "<relation> had a/an <event>." EVENT report with no named actor, which
// genuinely can be a brand-new, not-yet-addressed milestone) -- that
// pattern keeps its existing, unchanged, age-based treatment, proven in
// tests/relationship-fact-completion-awareness.test.mjs.
//
// This file proves the ACTION-report fix through the REAL recommendation
// pipeline end to end, exactly as tests/relationship-fact-completion-
// awareness.test.mjs already does for the EVENT-report fix, never a
// reimplementation of either.

const NOW = 1760400000;
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

// The exact real Zachter fact shape. `lifecycle` is deliberately left at
// the real, currently-stored (stale, never corrected) `durable` value by
// default -- the whole point of round 2's fix is that it no longer
// matters what lifecycle value is stored.
function zachterFact(daysOld, overrides) {
  return fact({
    factText: "Texted video from first day of Zman and thanked him for his support that makes it happen.",
    category: "engagement",
    lifecycle: "durable",
    sourceInteractionId: null,
    sourceInteractionOccurredAt: daysAgo(daysOld),
    ...overrides,
  });
}

async function run() {
  // --- 1: a completed outreach move must not be recommended as though
  // it remains undone. Zachter's real fact, ~54 days old (the real gap
  // between the logged touch, 2026-08-21, and the Production report,
  // 2026-10-14), stored `lifecycle` left at the real, uncorrected
  // `durable` value -- proving no data migration is needed for this to
  // work. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(54)], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "Zachter: completed outreach already performed must not be re-suggested");
  }

  // --- 1b: the second, independently-found real Production fact, same
  // shape, different vocabulary, proving the fix is general. ---
  {
    const f = fact({
      factText: "Spoke with him and gave him a tour of the new gym.",
      category: "engagement", lifecycle: "durable",
      sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(51),
    });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "a second, differently-worded completed outreach touch must also not be re-suggested");
  }

  // --- 2: a completed move with no open reminder must not automatically
  // trigger a duplicate recommendation. The real Zachter donor has zero
  // reminders/recommendations rows at all (confirmed read-only against
  // Production) -- `openReminder: null` here reproduces that exactly. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(54)], pendingAskSourceInteractionIds: [], openReminder: null });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "honor_reminder"), undefined, "no reminder exists, so none should be honored");
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "the absence of an open reminder must not, by itself, justify re-surfacing a completed move");
  }

  // --- 3: NO grace window -- a completed outreach action must not be
  // recommended even on the day it was performed. This is the exact
  // claim round 1 got wrong (it gave this a 30-day decay window instead
  // of zero) and the owner explicitly asked to be fixed: "My goal is not
  // simply to make completed outreach recommendations disappear after 30
  // days. My goal is to prevent Fundraising OS from recommending work
  // that has already been completed." ---
  {
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(0)], pendingAskSourceInteractionIds: [] });
    assert.equal(generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity"), undefined, "a completed outreach action must not be recommended even on day 0 -- there is no grace window");
  }

  // --- 4: an actual outstanding follow-up remains eligible. A
  // genuinely forward-looking fact -- not phrased as a completed action,
  // no fundraiser contact verb leading the sentence -- must still be
  // actionable. This is the real contrast case: the fix targets the
  // SHAPE of an action report, never every fresh engagement fact. ---
  {
    const f = fact({ factText: "He's planning a trip to Israel this Sukkos and asked about visiting campus.", category: "engagement", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(3) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a genuinely forward-looking, non-action-report fact must still be actionable");
    assert.match(opportunity.action, /Sukkos/);
  }

  // --- 5: a completed interaction may support a genuinely new follow-up
  // when there is a separate, defensible reason. The same donor's old,
  // completed Zman touch must not contaminate a second, genuinely new
  // and unrelated engagement fact for the SAME donor. ---
  {
    const freshTravel = fact({ factText: "He's planning a trip to Israel this Sukkos and asked about visiting campus.", category: "engagement", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(3) });
    const evidence = evidenceFor({ relationshipFacts: [zachterFact(54), freshTravel], pendingAskSourceInteractionIds: [] });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a second, genuinely new fact for the same donor must still surface");
    assert.match(opportunity.action, /Sukkos/);
    assert.doesNotMatch(opportunity.action, /thanked him for his support/, "the completed, action-report fact must never win over the fresh, unrelated one");
  }

  // --- 6: recommendations remain consistent between the dashboard (Today
  // page / buildDonorRecommendation) and the Daily Fundraising Agenda
  // (buildAgenda), exercised through their own real, unmodified
  // functions. The "fresh donor" fixture is deliberately NOT phrased as
  // an action report (it is a topic surfaced in conversation, not a
  // report of a completed touch), so it is unaffected by this fix and
  // still generates a real recommendation -- the contrast that proves
  // this fix is scoped to the action-report shape, not to "any fact
  // mentioning a call." ---
  {
    const suppressedDonorEvidence = evidenceFor({
      donorId: "donor-zachter",
      lastSubstantiveContactAt: daysAgo(54),
      relationshipFacts: [zachterFact(54)],
      pendingAskSourceInteractionIds: [],
    });
    assert.equal(buildDonorRecommendation(suppressedDonorEvidence), null, "Today page: a donor whose only fact is a completed outreach action must get no recommendation at all");

    const freshDonorEvidence = evidenceFor({
      donorId: "donor-fresh",
      relationshipFacts: [fact({ factText: "Interested in a possible pledge for the new beis medrash building.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(4) })],
      pendingAskSourceInteractionIds: [],
    });
    const freshRecommendation = buildDonorRecommendation(freshDonorEvidence);
    assert.ok(freshRecommendation, "Today page: a donor with a genuinely new, non-action-report fact must still get a recommendation");

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

  // --- 7: existing payment-plan and pledge reconciliation protections
  // remain intact. A solicitation-category fact that happens to OPEN
  // with a contact verb ("Called and discussed building naming
  // opportunity.") must stay actionable at an age well past the
  // completed-action class's suppression -- the subject matter (an open
  // ask) may still need follow-through even though the call itself is
  // done, and isUnambiguousCompletedOutreachAction() is only ever wired
  // into the shared scoreFact()/legacy check, never into solicitCandidate
  // at all, so a solicitation fact is never affected by this fix. ---
  {
    const f = fact({ factText: "Called and discussed building naming opportunity.", category: "solicitation", lifecycle: "time_bound", sourceInteractionId: null, sourceInteractionOccurredAt: daysAgo(60) });
    const evidence = evidenceFor({ relationshipFacts: [f], pendingAskSourceInteractionIds: [] });
    const solicit = generateCandidates(evidence).find((c) => c.kind === "solicit");
    assert.ok(solicit, "a solicitation fact that opens with a contact verb must remain governed only by solicitation's own decay window");
    assert.match(solicit.action, /naming opportunity/);
  }

  // A real open pledge/payment-plan candidate for the SAME donor must be
  // completely unaffected by a suppressed completed-action fact sitting
  // alongside it.
  {
    const evidence = evidenceFor({
      relationshipFacts: [zachterFact(54)],
      pendingAskSourceInteractionIds: [],
      openPledge: { balanceCents: 180000, campaign: "Annual Campaign", description: null, activityDate: daysAgo(70), activePaymentPlan: null },
    });
    const kinds = candidateKinds(evidence);
    assert.ok(kinds.includes("follow_up_pledge"), "an unrelated open pledge must still generate follow_up_pledge");
    assert.equal(kinds.includes("relationship_opportunity"), false, "the suppressed completed-action fact must still be suppressed alongside the unrelated pledge candidate");
  }

  // --- 8: the legacy relationship_summary/institutional_memory pathway
  // (donors with zero structured facts) now applies the SAME check,
  // never a reimplementation. A donor whose entire cached narrative is
  // nothing but a completed-action report must not generate
  // relationship_opportunity via the legacy path either. ---
  {
    const evidence = evidenceFor({
      relationshipFacts: [],
      relationshipSummary: "Texted video from first day of Zman and thanked him for his support that makes it happen.",
    });
    assert.equal(evidence.factActionability.hasStructuredFacts, false, "zero fact rows means the legacy path governs");
    assert.equal(candidateKinds(evidence).includes("relationship_opportunity"), false, "a legacy narrative that is entirely a completed-action report must not generate relationship_opportunity");
  }

  // --- 9: the legacy path must NOT silently drop useful context. A
  // narrative mixing a completed-action sentence with a genuine standing
  // fact must still surface, verbatim, exactly as before -- there is no
  // safe way to split "useful" from "stale" below the whole-string level
  // without the structured-facts migration, and the owner explicitly
  // required that real context never be silently lost. ---
  {
    const evidence = evidenceFor({
      relationshipFacts: [],
      relationshipSummary: "Texted video from first day of Zman and thanked him for his support. His daughter is Danielle.",
    });
    const opportunity = generateCandidates(evidence).find((c) => c.kind === "relationship_opportunity");
    assert.ok(opportunity, "a legacy narrative mixing an action report with a standing fact must still generate relationship_opportunity -- the mixed text is preserved, not silently trimmed");
    assert.match(opportunity.action, /Danielle/);
  }

  // --- 10: a legacy narrative that is a genuine, non-action-report fact
  // (no completed-touch sentence at all) is completely unaffected,
  // exactly as before this fix. ---
  {
    const evidence = evidenceFor({ relationshipFacts: [], institutionalMemory: "His daughter is Danielle." });
    assert.ok(candidateKinds(evidence).includes("relationship_opportunity"), "a legacy narrative with no completed-action content at all must be unaffected by this fix");
  }

  console.log("relationship-fact-completed-outreach-action: ok");
}

await run();
