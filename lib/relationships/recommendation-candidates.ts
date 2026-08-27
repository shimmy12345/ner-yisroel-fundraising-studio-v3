import type { RecommendationEvidence } from "./recommendation-evidence.ts";
import type { GiftSource } from "../giving/acknowledgment.ts";
import { interactionKindLabel, relationshipSnapshotDetails, splitInteractionSummary, type InteractionKind } from "../capture/interaction.ts";
import { askDescriptor, askFollowUpAction } from "../capture/ask.ts";

// Plausible next-action candidates generated from one donor's evidence.
// Each generator only fires on its own precondition, so a candidate simply
// doesn't exist without supporting evidence -- there is nothing generic
// left for the ranker to accidentally prefer. recommendation-rank.ts
// applies hard constraints and then scores whatever survives; it never
// re-reads raw evidence itself.

export type RecommendationCandidateKind =
  | "honor_reminder"
  | "acknowledge_gift"
  | "follow_up_pledge"
  | "open_ask"
  | "continue_conversation"
  | "relationship_opportunity"
  | "solicit"
  | "reconnect_contact_gap"
  | "yahrtzeit_outreach"
  | "birthday_outreach"
  | "anniversary_outreach";

// confirmed: a real interactions/recommendations/giving_activities row.
// narrative: donors.relationship_summary/institutional_memory -- human-
// reviewed, but free text that can go stale, not a database fact.
// unconfirmed_historical: donor_historical_context only -- explicitly
// never verified, per its own schema invariant (status is never 'confirmed').
export type EvidenceCertainty = "confirmed" | "narrative" | "unconfirmed_historical";

export type RecommendationCandidate = {
  kind: RecommendationCandidateKind;
  action: string;
  why: string;
  evidence: string[];
  confidence: "high" | "medium" | "low";
  timing: string | null;
  certainty: EvidenceCertainty;
  // Scoring inputs, each 0-1 -- see recommendation-rank.ts for how these
  // combine. Never a raw confidence label by itself: two candidates can
  // both be "medium confidence" for display purposes while scoring very
  // differently once specificity/recency/urgency are weighed together.
  specificity: number;
  recency: number;
  urgency: number;
  // The date of the fact this candidate is actually based on (epoch
  // seconds), or null when nothing dateable applies (e.g. honor_reminder,
  // reconnect_contact_gap with no prior contact at all). Lets
  // recommendation-rank.ts compare "does this evidence postdate the open
  // pledge" without re-parsing evidence[] strings.
  supportingDate: number | null;
  // Only set for acknowledge_gift -- lets a caller wire a direct one-click
  // "Mark thank-you sent" action to the exact gift this candidate is
  // about, without re-deriving which gift that was.
  giftSource?: GiftSource;
  giftId?: string;
};

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
const dateLabel = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
// Fresher evidence scores closer to 1; anything past `horizonDays` scores 0.
// Deliberately linear and simple -- this is a rule-based system, not a
// learned model, and the exact curve shape isn't a claim worth making.
const recencyScore = (daysAgo: number, horizonDays: number) => clamp01(1 - daysAgo / horizonDays);

function honorReminderCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const reminder = evidence.reminder;
  if (!reminder) return null;
  return {
    kind: "honor_reminder",
    action: reminder.action,
    why: `A reminder is already open for this donor${reminder.isOverdue ? " and is overdue" : ""}.`,
    evidence: [`Open reminder: "${reminder.action}"${reminder.reason ? ` -- ${reminder.reason}` : ""}${reminder.dueAt !== null ? ` (due ${dateLabel(reminder.dueAt)})` : ""}`],
    confidence: "high",
    timing: reminder.dueAt !== null ? `Due ${dateLabel(reminder.dueAt)}` : null,
    certainty: "confirmed",
    specificity: 0.9,
    recency: reminder.isOverdue ? 1 : 0.75,
    urgency: reminder.isOverdue ? 1 : 0.6,
    supportingDate: null,
  };
}

function acknowledgeGiftCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const gift = evidence.giving.mostRecentPaidGift;
  // acknowledged is the explicit gift_acknowledgments state -- never
  // inferred from "some interaction happened after the gift date". A
  // routine thank-you is often sent without logging a full interaction,
  // and an unrelated interaction is not evidence a thank-you was sent.
  if (!gift || gift.acknowledged) return null;
  const daysAgo = Math.max(0, Math.floor((evidence.now - gift.occurredAt) / 86400));
  const descriptionSuffix = gift.description ? ` (${gift.description})` : "";
  return {
    kind: "acknowledge_gift",
    action: `Send a personal thank-you for the recent ${money(gift.amountCents)} ${gift.campaign ? `gift to ${gift.campaign}` : "gift"}.`,
    why: `A paid gift was recorded ${daysAgo === 0 ? "today" : `${daysAgo} day${daysAgo === 1 ? "" : "s"} ago`} and has not been marked acknowledged yet.`,
    evidence: [`${money(gift.amountCents)} paid${gift.campaign ? `, ${gift.campaign}` : ""}, ${dateLabel(gift.occurredAt)}${descriptionSuffix}; no thank-you recorded for this gift.`],
    confidence: "high",
    timing: daysAgo <= 14 ? "Within the next few days, while the gift is recent" : null,
    certainty: "confirmed",
    specificity: 0.9,
    recency: recencyScore(daysAgo, 30),
    urgency: recencyScore(daysAgo, 14),
    supportingDate: gift.occurredAt,
    giftSource: gift.giftSource,
    giftId: gift.giftId,
  };
}

// Payment-plan-aware, but still exactly one kind ("follow_up_pledge") --
// no second recommendation engine, no new candidate kind. A payment plan
// is fundraiser-declared stewardship metadata (see
// lib/relationships/pledge-payment-plan.ts); when one is active and
// currently on track, the fundraiser already knows this pledge is being
// paid as expected, so this candidate is suppressed entirely (returns
// null) rather than nagging about an open balance alone. When the plan
// itself is late, or its final expected date has passed with balance
// remaining, the candidate returns with plan-aware wording instead of
// the default age-based wording -- but the underlying confidence/
// urgency scoring formulas are otherwise unchanged from the no-plan
// case, just driven by the plan's own daysLate/days-past-final instead
// of raw pledge ageDays.
function followUpPledgeCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const pledge = evidence.giving.openPledge;
  if (!pledge) return null;
  const plan = pledge.activePaymentPlan;
  const descriptionSuffix = pledge.description ? ` (${pledge.description})` : "";

  if (plan && plan.isOnTrack) return null;

  if (plan && plan.isLate) {
    return {
      kind: "follow_up_pledge",
      action: `Check in on the ${money(pledge.balanceCents)} pledge payment plan.`,
      // Never asserts the donor failed to pay -- the evidence only
      // proves the expected cycle is overdue; a payment could already be
      // in transit.
      why: `Expected monthly payment is overdue.`,
      evidence: [`${money(pledge.balanceCents)} open balance${pledge.campaign ? `, ${pledge.campaign}` : ""}${descriptionSuffix}, next expected payment was ${plan.nextUnsatisfiedExpectedPaymentAt !== null ? dateLabel(plan.nextUnsatisfiedExpectedPaymentAt) : "unknown"}${plan.latestActualPaymentAt !== null ? `, last payment ${dateLabel(plan.latestActualPaymentAt)}` : ", no payment linked to this pledge yet"}.`],
      confidence: plan.daysLate >= 60 ? "medium" : "low",
      timing: null,
      certainty: "confirmed",
      specificity: 0.7,
      recency: 0.3,
      urgency: clamp01(plan.daysLate / 180),
      supportingDate: plan.nextUnsatisfiedExpectedPaymentAt,
    };
  }

  if (plan && plan.isPlanEndedWithBalance) {
    const daysPastFinal = Math.max(0, Math.floor((evidence.now - plan.finalExpectedPaymentAt) / 86400));
    return {
      kind: "follow_up_pledge",
      action: `Follow up on the remaining ${money(pledge.balanceCents)} after the payment plan end date.`,
      why: `The payment plan's final expected date has passed with balance still open.`,
      evidence: [`${money(pledge.balanceCents)} open balance${pledge.campaign ? `, ${pledge.campaign}` : ""}${descriptionSuffix}, payment plan expected to be complete by ${dateLabel(plan.finalExpectedPaymentAt)}.`],
      confidence: daysPastFinal >= 60 ? "medium" : "low",
      timing: null,
      certainty: "confirmed",
      specificity: 0.7,
      recency: 0.3,
      urgency: clamp01(daysPastFinal / 180),
      supportingDate: plan.finalExpectedPaymentAt,
    };
  }

  // No plan at all, or the plan is completed/inert (not on-track/late/
  // ended-with-balance -- e.g. a plan that was manually ended and left
  // stored, now inert): existing, unmodified age-based behavior.
  const ageDays = pledge.ageDays ?? 0;
  return {
    kind: "follow_up_pledge",
    action: `Follow up on the open ${money(pledge.balanceCents)} pledge${pledge.campaign ? ` to ${pledge.campaign}` : ""}.`,
    why: `No payment activity in ${ageDays} days${evidence.contact.lastCompletedInteraction ? "" : " and no completed interaction on file"}.`,
    evidence: [`${money(pledge.balanceCents)} open balance${pledge.campaign ? `, ${pledge.campaign}` : ""}${descriptionSuffix}, last activity ${pledge.activityDate !== null ? dateLabel(pledge.activityDate) : "unknown"}.`],
    confidence: ageDays >= 60 ? "medium" : "low",
    timing: null,
    certainty: "confirmed",
    specificity: 0.7,
    recency: 0.3,
    urgency: clamp01(ageDays / 180),
    supportingDate: pledge.activityDate,
  };
}

// A pending, structured ask -- a real asks row (confirmed evidence),
// never inferred from free text. Modeled on followUpPledgeCandidate
// above (the closest existing "stale open money-adjacent item"
// precedent), reusing its exact urgency horizon (180 days) and its exact
// confidence cutoff (60 days) verbatim rather than inventing new
// numbers. `recency` deliberately does NOT decay with age the way
// followUpPledgeCandidate's does: a pledge's recency reflects "how long
// since money last moved," which genuinely goes stale, but an ask's own
// fact ("we asked, still pending") stays exactly as true and current
// regardless of age -- there is no decaying "last activity" to measure.
// A constant, high recency (0.7, versus follow_up_pledge's 0.3) is what
// makes this candidate reliably outrank the fuzzy, narrative-only
// solicitCandidate below on a FRESH ask (certainty alone, at 1.0 vs
// solicit's 0.85, is not always enough once solicit's own recency/
// urgency inputs are counted) -- required by design ("a pending
// structured Ask... should normally beat fuzzy solicitation evidence...
// because the structured Ask is confirmed evidence"). This is what lets
// a day-0 ask still win the ranking while `urgency` stays near zero, so
// it never reads as an immediate nag (see confidence/urgency below) --
// winning the ranking and sounding urgent are two different things.
function openAskCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const ask = evidence.openAsk;
  if (!ask) return null;
  // The fundraiser already made an explicit, dated decision (via the
  // existing "Add follow-up" feature -- app/api/asks/[id]/reminder/
  // route.ts, matched here by the same "ask-<askId>-" id-prefix
  // convention Meeting Brief already uses) to revisit this ask on a
  // specific later day. Deferring to it entirely (no candidate at all)
  // mirrors followUpPledgeCandidate's own precedent just above (an
  // on-track payment plan suppresses that candidate rather than nagging
  // about an open balance the fundraiser already has a plan for). An
  // overdue or due-today follow-up is NOT "future" (hasFutureFollowUp is
  // false for both -- see its own doc comment in recommendation-
  // evidence.ts) and falls through to the normal candidate below: those
  // already win the homepage/agenda's own due-date ranking over a
  // generic Suggested Action on their own merit, so no suppression is
  // needed for them.
  if (ask.hasFutureFollowUp) return null;
  const amountLabel = ask.amountCents !== null ? money(ask.amountCents) : null;
  const askedLabel = ask.ageDays === 0 ? "today" : `${ask.ageDays} day${ask.ageDays === 1 ? "" : "s"} ago`;
  // A gift or pledge payment recorded on or after the day the ask was
  // made is real, confirmed evidence in tension with "still pending" --
  // both dates already live in this same evidence object (mostRecentPaidGift
  // drives acknowledge_gift; openPledge.activityDate drives
  // follow_up_pledge), simply never compared against askedAt before now.
  // This never asserts the ask WAS answered (that remains a human
  // judgment, gated behind the existing pending/committed/declined/
  // withdrawn status machine in lib/capture/ask.ts) -- it only stops
  // asserting the opposite (that nothing has happened since) once the
  // evidence itself says otherwise. Scoring inputs are deliberately
  // unchanged from the default case below -- this only changes the
  // wording, never where this candidate ranks.
  const giftAfterAsk = evidence.giving.mostRecentPaidGift !== null && evidence.giving.mostRecentPaidGift.occurredAt > ask.askedAt ? evidence.giving.mostRecentPaidGift : null;
  const pledgeActivityAfterAsk = evidence.giving.openPledge?.activityDate !== null && evidence.giving.openPledge?.activityDate !== undefined && evidence.giving.openPledge.activityDate > ask.askedAt ? evidence.giving.openPledge.activityDate : null;
  if (giftAfterAsk || pledgeActivityAfterAsk) {
    const signals: string[] = [];
    if (giftAfterAsk) signals.push(`a ${money(giftAfterAsk.amountCents)} gift was recorded ${dateLabel(giftAfterAsk.occurredAt)}`);
    if (pledgeActivityAfterAsk) signals.push(`pledge activity was recorded ${dateLabel(pledgeActivityAfterAsk)}`);
    const signalText = signals.join(" and ");
    return {
      kind: "open_ask",
      action: `Confirm whether the ${askDescriptor(ask.amountCents, ask.purpose)} ask is already resolved.`,
      why: `${signalText.charAt(0).toUpperCase()}${signalText.slice(1)}, after this ask was made ${askedLabel} -- verify before following up again.`,
      evidence: [`${amountLabel ? `${amountLabel} ` : ""}${ask.purpose ? `${ask.purpose}, ` : ""}asked ${dateLabel(ask.askedAt)}, still marked pending; ${signalText} since then.`],
      confidence: ask.ageDays >= 60 ? "medium" : "low",
      timing: null,
      certainty: "confirmed",
      specificity: 0.75,
      recency: 0.7,
      urgency: clamp01(ask.ageDays / 180),
      supportingDate: ask.askedAt,
    };
  }
  return {
    kind: "open_ask",
    action: askFollowUpAction(ask.amountCents, ask.purpose),
    why: `An ask was made ${askedLabel} and is still pending.`,
    evidence: [`${amountLabel ? `${amountLabel} ` : ""}${ask.purpose ? `${ask.purpose}, ` : ""}asked ${dateLabel(ask.askedAt)}, still pending.`],
    confidence: ask.ageDays >= 60 ? "medium" : "low",
    timing: null,
    certainty: "confirmed",
    specificity: 0.75,
    recency: 0.7,
    urgency: clamp01(ask.ageDays / 180),
    supportingDate: ask.askedAt,
  };
}

// Exported so lib/workspace/suggestion-candidates.ts can pre-filter donor
// pool inclusion on the exact same window this candidate itself uses,
// never a duplicated magic number that could silently drift out of sync
// -- same rationale as RELATIONSHIP_DATE_LEAD_WINDOW_DAYS above.
export const CONTINUE_CONVERSATION_WINDOW_DAYS = 30;

function continueConversationCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const interaction = evidence.contact.lastCompletedInteraction;
  if (!interaction || interaction.daysAgo > CONTINUE_CONVERSATION_WINDOW_DAYS) return null;
  const kind = interaction.type as InteractionKind;
  const friendlyType = interactionKindLabel(kind) || interaction.type;
  const { subject, note } = splitInteractionSummary(interaction.summary);
  const details = relationshipSnapshotDetails(note || subject, kind);
  // Only surfaces when the note itself names something to follow up on --
  // a bare "texted to check in" with no commitment language is not useful
  // fundraising guidance. Mechanically paraphrasing "the recent {type}
  // about {subject}" just because SOME interaction exists within 30 days
  // produced exactly that (a real, observed live example: "Continue the
  // conversation from the recent text about 'Text message'."). When
  // there's nothing specific, this candidate simply doesn't fire, same as
  // every other candidate here -- callers already have an honest empty
  // state ("No suggested action available" / "None available") for when
  // nothing survives, so no new fallback string is needed.
  if (!details.recommendedNextAction) return null;
  const daysAgoLabel = interaction.daysAgo === 0 ? "today" : `${interaction.daysAgo} day${interaction.daysAgo === 1 ? "" : "s"} ago`;
  const action = details.recommendedNextAction.replace(/^./, (letter) => letter.toUpperCase());
  return {
    kind: "continue_conversation",
    action: /[.!?]$/.test(action) ? action : `${action}.`,
    why: `A specific follow-up was noted in the most recent ${friendlyType.toLowerCase()} (${daysAgoLabel}).`,
    evidence: [`${friendlyType} on ${dateLabel(interaction.occurredAt)}: ${note || subject || "no additional detail recorded"}.`],
    confidence: "medium",
    timing: null,
    certainty: "confirmed",
    specificity: 0.6,
    recency: recencyScore(interaction.daysAgo, 30),
    urgency: 0.35,
    supportingDate: interaction.occurredAt,
  };
}

function relationshipOpportunityCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  // Stage 2 (see docs/AI-HANDOFF.md's "Relationship Snapshot Architecture
  // -- Stage 2"): for a donor with structured Relationship Facts,
  // actionability is decided by fact-level relevance (scoreFact(), via
  // findMostActionableFact()), never by "does any text still sit in the
  // cached narrative columns." A historically-true fact can remain fully
  // intact -- and even keep being shown in the Relationship Snapshot --
  // while no longer being current enough to justify this recommendation.
  if (evidence.factActionability.hasStructuredFacts) {
    const actionable = evidence.factActionability.actionableAnyFact;
    if (!actionable) return null;
    return {
      kind: "relationship_opportunity",
      action: `Reach out and reference: ${actionable.factText}`,
      why: "A specific, currently-relevant fact is on file and no open reminder currently covers this.",
      evidence: [`Recorded relationship fact: "${actionable.factText}"`],
      confidence: "medium",
      timing: null,
      certainty: "narrative",
      specificity: 0.65,
      recency: 0.5,
      urgency: 0.3,
      supportingDate: evidence.now,
    };
  }
  // Legacy path -- UNCHANGED for a donor with zero structured facts yet
  // (Stage 2's fallback: this population is migrated in a later stage).
  const text = evidence.narrative.relationshipSummary || evidence.narrative.institutionalMemory;
  if (!text) return null;
  return {
    kind: "relationship_opportunity",
    // `text` is now always a specific, quoted fact (never a field-label
    // dump -- see actionableRelationshipSnapshot's doc comment), so this
    // stays a plain, direct prompt grounded in that one fact, not internal
    // provenance language.
    action: `Reach out and reference: ${text}`,
    why: "A specific, donor-relevant fact is on file and no open reminder currently covers this.",
    evidence: [`Recorded relationship note: "${text}"`],
    confidence: "medium",
    timing: null,
    certainty: "narrative",
    specificity: 0.65,
    recency: 0.5,
    urgency: 0.3,
    // Narrative text has no stored date of its own -- it reflects the
    // donor's most recently accepted summary, so it's treated as current.
    supportingDate: evidence.now,
  };
}

// "solicit(ed)?" -- not a broader stem match (e.g. "soliciting") -- the
// past-tense form is the one evidenced gap (a real staging narrative,
// "Note context: Solicited for a plaque ($5k)," fell through to
// relationship_opportunity instead of this candidate because \bsolicit\b
// alone doesn't match "Solicited"). Kept deliberately narrow to that one
// evidenced case rather than widening to every inflection speculatively.
const SOLICITATION_PATTERN = /\b(solicit(ed)?|ask (him|her|them) for|pledge (request|ask)|corporate sponsorship|capital campaign ask)\b/i;

function solicitCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  // Stage 2: for a donor with structured Relationship Facts, whether a
  // solicitation is still worth suggesting is decided by fact-level
  // relevance (scoreFact(), via findMostActionableFact()'s solicitation-
  // category check), never by regex-matching whatever text happens to
  // still sit in the cached narrative columns. This is the direct fix
  // for the evidenced Klein/Rovinsky/Pfeiffer failure: their historical
  // "Solicited for..." fact remains stored (and may still be displayed
  // as history) but no longer clears the relevance floor once its Ask
  // resolved and enough time passed, so it correctly stops generating
  // this recommendation -- without deleting or archiving anything.
  if (evidence.factActionability.hasStructuredFacts) {
    const actionable = evidence.factActionability.actionableSolicitationFact;
    if (actionable) {
      return {
        kind: "solicit",
        action: `Make a solicitation ask, following up on: ${actionable.factText}`,
        why: "A specific, currently-relevant solicitation opportunity is on file.",
        evidence: [`Recorded relationship fact: "${actionable.factText}"`],
        confidence: "medium",
        timing: null,
        certainty: "narrative",
        specificity: 0.7,
        recency: 0.5,
        urgency: 0.4,
        supportingDate: evidence.now,
      };
    }
    // No currently-actionable solicitation fact for this donor -- do NOT
    // fall through to regex-matching the cached narrative text below;
    // that text is exactly the stale evidence Stage 2 exists to stop
    // treating as current. The unconfirmed-historical-context channel
    // just below is a structurally separate, always-independent signal
    // (never migrated into facts) and remains unaffected either way.
  } else {
    // Legacy path -- UNCHANGED for a donor with zero structured facts yet.
    const narrativeText = evidence.narrative.relationshipSummary || evidence.narrative.institutionalMemory;
    if (narrativeText && SOLICITATION_PATTERN.test(narrativeText)) {
      return {
        kind: "solicit",
        action: `Make a solicitation ask, following up on: ${narrativeText}`,
        why: "A specific, still-relevant solicitation opportunity is on file.",
        evidence: [`Recorded relationship note: "${narrativeText}"`],
        confidence: "medium",
        timing: null,
        certainty: "narrative",
        specificity: 0.7,
        recency: 0.5,
        urgency: 0.4,
        supportingDate: evidence.now,
      };
    }
  }
  const historicalHit = evidence.historicalContext.find((row) => SOLICITATION_PATTERN.test(row.text));
  if (historicalHit) {
    const sourceLabel = historicalHit.source === "import-monday" ? "Monday.com" : historicalHit.source;
    const dateSuffix = historicalHit.sourceDate !== null ? `, ${dateLabel(historicalHit.sourceDate)}` : "";
    return {
      kind: "solicit",
      action: `Consider a solicitation ask; an imported note references one, but this was never confirmed: "${historicalHit.text}"`,
      why: "An unconfirmed imported note mentions a solicitation opportunity. Completion was never confirmed, so verify before acting on it.",
      evidence: [`Imported context: "${historicalHit.text}" (${sourceLabel}${dateSuffix}). Completion was never confirmed.`],
      confidence: "low",
      timing: null,
      certainty: "unconfirmed_historical",
      specificity: 0.5,
      recency: historicalHit.sourceDate !== null ? recencyScore(Math.floor((evidence.now - historicalHit.sourceDate) / 86400), 180) : 0.2,
      urgency: 0.2,
      supportingDate: historicalHit.sourceDate,
    };
  }
  return null;
}

// Deliberately reads daysSinceSubstantiveContact, not daysSinceLastContact --
// an approved product decision, not an oversight: a role='recipient'
// broadcast touch (one text/email/photo logged once and linked to many
// donors) updates Last Contact display but must never by itself suppress
// this candidate. See lastSubstantiveContactAt's doc comment in
// recommendation-evidence.ts for the full rule. role='participant' and
// every existing single-donor interaction type are unaffected -- they count
// here exactly as they did before this field existed.
function reconnectContactGapCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const days = evidence.contact.daysSinceSubstantiveContact;
  if (days !== null && days < 90) return null;
  return {
    kind: "reconnect_contact_gap",
    action: "Reach out to re-establish contact.",
    why: days === null
      ? "No contact has ever been recorded for this donor."
      : `No contact has been recorded in ${days} days.`,
    evidence: [days === null ? "Last confirmed contact: none recorded." : `Last confirmed contact: ${days} days ago.`],
    confidence: "low",
    timing: null,
    certainty: "confirmed",
    specificity: 0.15,
    recency: 0.1,
    urgency: days === null ? 0.5 : clamp01(days / 365),
    supportingDate: days !== null ? evidence.now - days * 86400 : null,
  };
}

// Awareness (the Yahrtzeits section on the donor profile/Meeting Brief) is
// unconditional -- every recorded yahrtzeit is always shown there,
// regardless of how far away it is. This candidate is the separate "is it
// worth actively suggesting outreach right now" question: it only exists
// at all within a two-week lead window, and its score ramps up smoothly as
// the date approaches (via recency/urgency, same as every other candidate
// here) rather than flipping on at a fixed cutoff. Only the single
// soonest-upcoming yahrtzeit is considered -- consistent with every other
// "most relevant fact" field in this evidence (mostRecentPaidGift,
// openPledge, lastCompletedInteraction all pick one, not a list).
// Exported so lib/workspace/suggestion-candidates.ts and
// lib/workspace/relationship-date-events.ts can pre-filter/gate on the
// exact same window every relationship-date outreach candidate (yahrtzeit,
// birthday, anniversary) uses -- never a duplicated magic number. Shared
// across all three date types deliberately: Coming Up is meant to feel like
// one relationship calendar with one consistent "how far ahead" horizon,
// not a different lead time per type.
export const RELATIONSHIP_DATE_LEAD_WINDOW_DAYS = 14;

function yahrtzeitOutreachCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const soonest = [...evidence.yahrtzeits].sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (!soonest || soonest.daysUntil > RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) return null;
  const englishDate = dateLabel(soonest.nextOccurrenceAt);
  const nameSuffix = soonest.deceasedNameHebrew ? ` (${soonest.deceasedNameHebrew})` : "";
  return {
    kind: "yahrtzeit_outreach",
    action: `Reach out ahead of ${soonest.deceasedNameEnglish}'s yahrtzeit (${soonest.relationship.toLowerCase()}) on ${soonest.hebrewLabel}.`,
    why: soonest.daysUntil === 0 ? "The yahrtzeit is today." : `The yahrtzeit is in ${soonest.daysUntil} day${soonest.daysUntil === 1 ? "" : "s"}, on ${englishDate}.`,
    evidence: [`${soonest.relationship}: ${soonest.deceasedNameEnglish}${nameSuffix} — ${soonest.hebrewLabel}, next occurrence ${englishDate}.${soonest.ambiguous ? ` ${soonest.ambiguityNote}` : ""}`],
    confidence: soonest.ambiguous ? "medium" : "high",
    timing: englishDate,
    certainty: "confirmed",
    specificity: 0.85,
    recency: recencyScore(soonest.daysUntil, 30),
    urgency: recencyScore(soonest.daysUntil, RELATIONSHIP_DATE_LEAD_WINDOW_DAYS),
    supportingDate: soonest.nextOccurrenceAt,
  };
}

// Same awareness-vs-urgency split as yahrtzeitOutreachCandidate above: the
// donor-profile/Meeting Brief "Important Dates" list shows every recorded
// birthday unconditionally; this candidate is the separate "is it worth
// actively suggesting outreach right now" question, gated by the same
// shared lead window and scored the same way.
function birthdayOutreachCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const birthdays = evidence.importantDates.filter((item) => item.type === "birthday");
  const soonest = [...birthdays].sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (!soonest || soonest.daysUntil > RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) return null;
  const englishDate = dateLabel(soonest.nextOccurrenceAt);
  const who = soonest.personName ?? "them";
  const ageNote = soonest.derivedYears !== null ? ` ${who} is turning ${soonest.derivedYears}.` : "";
  return {
    kind: "birthday_outreach",
    action: `Reach out to wish ${who} a happy birthday on ${soonest.label}.`,
    why: (soonest.daysUntil === 0 ? "The birthday is today." : `The birthday is in ${soonest.daysUntil} day${soonest.daysUntil === 1 ? "" : "s"}, on ${englishDate}.`) + ageNote,
    evidence: [`${who}'s birthday is ${soonest.label}, next occurrence ${englishDate}.${ageNote}${soonest.ambiguous ? ` ${soonest.ambiguityNote}` : ""}`],
    confidence: soonest.ambiguous ? "medium" : "high",
    timing: englishDate,
    certainty: "confirmed",
    specificity: 0.85,
    recency: recencyScore(soonest.daysUntil, 30),
    urgency: recencyScore(soonest.daysUntil, RELATIONSHIP_DATE_LEAD_WINDOW_DAYS),
    supportingDate: soonest.nextOccurrenceAt,
  };
}

function anniversaryOutreachCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const anniversaries = evidence.importantDates.filter((item) => item.type === "anniversary");
  const soonest = [...anniversaries].sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (!soonest || soonest.daysUntil > RELATIONSHIP_DATE_LEAD_WINDOW_DAYS) return null;
  const englishDate = dateLabel(soonest.nextOccurrenceAt);
  const yearsNote = soonest.derivedYears !== null ? ` This will be ${soonest.derivedYears} year${soonest.derivedYears === 1 ? "" : "s"} married.` : "";
  return {
    kind: "anniversary_outreach",
    action: `Send a note ahead of their wedding anniversary on ${soonest.label}.`,
    why: (soonest.daysUntil === 0 ? "The anniversary is today." : `The anniversary is in ${soonest.daysUntil} day${soonest.daysUntil === 1 ? "" : "s"}, on ${englishDate}.`) + yearsNote,
    evidence: [`Wedding anniversary: ${soonest.label}, next occurrence ${englishDate}.${yearsNote}${soonest.ambiguous ? ` ${soonest.ambiguityNote}` : ""}`],
    confidence: soonest.ambiguous ? "medium" : "high",
    timing: englishDate,
    certainty: "confirmed",
    specificity: 0.85,
    recency: recencyScore(soonest.daysUntil, 30),
    urgency: recencyScore(soonest.daysUntil, RELATIONSHIP_DATE_LEAD_WINDOW_DAYS),
    supportingDate: soonest.nextOccurrenceAt,
  };
}

export function generateCandidates(evidence: RecommendationEvidence): RecommendationCandidate[] {
  return [
    honorReminderCandidate(evidence),
    acknowledgeGiftCandidate(evidence),
    followUpPledgeCandidate(evidence),
    openAskCandidate(evidence),
    continueConversationCandidate(evidence),
    relationshipOpportunityCandidate(evidence),
    solicitCandidate(evidence),
    reconnectContactGapCandidate(evidence),
    yahrtzeitOutreachCandidate(evidence),
    birthdayOutreachCandidate(evidence),
    anniversaryOutreachCandidate(evidence),
  ].filter((candidate): candidate is RecommendationCandidate => candidate !== null);
}
