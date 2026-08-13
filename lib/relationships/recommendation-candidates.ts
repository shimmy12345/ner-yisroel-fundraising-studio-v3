import type { RecommendationEvidence } from "./recommendation-evidence.ts";
import type { GiftSource } from "../giving/acknowledgment.ts";

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
  | "continue_conversation"
  | "relationship_opportunity"
  | "solicit"
  | "reconnect_contact_gap"
  | "yahrtzeit_outreach";

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

function followUpPledgeCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const pledge = evidence.giving.openPledge;
  if (!pledge) return null;
  const ageDays = pledge.ageDays ?? 0;
  const descriptionSuffix = pledge.description ? ` (${pledge.description})` : "";
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

function continueConversationCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const interaction = evidence.contact.lastCompletedInteraction;
  if (!interaction || interaction.daysAgo > 30) return null;
  const [subject, ...rest] = interaction.summary.split("\n");
  const note = rest.join(" ").trim();
  return {
    kind: "continue_conversation",
    action: `Continue the conversation from the recent ${interaction.type}${subject ? ` about "${subject}"` : ""}.`,
    why: `The most recent completed interaction was ${interaction.daysAgo === 0 ? "today" : `${interaction.daysAgo} day${interaction.daysAgo === 1 ? "" : "s"} ago`} and may have an open thread worth following up on.`,
    evidence: [`${interaction.type} on ${dateLabel(interaction.occurredAt)}: ${note || subject || "no additional detail recorded"}.`],
    confidence: "medium",
    timing: null,
    certainty: "confirmed",
    specificity: 0.55,
    recency: recencyScore(interaction.daysAgo, 30),
    urgency: 0.35,
    supportingDate: interaction.occurredAt,
  };
}

function relationshipOpportunityCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const text = evidence.narrative.relationshipSummary || evidence.narrative.institutionalMemory;
  if (!text) return null;
  return {
    kind: "relationship_opportunity",
    action: `Reach out and reference what's already known: ${text}`,
    why: "Relationship notes describe a specific, donor-relevant fact and no open reminder currently covers this.",
    evidence: [`relationship_summary/institutional_memory: "${text}"`],
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

const SOLICITATION_PATTERN = /\b(solicit|ask (him|her|them) for|pledge (request|ask)|corporate sponsorship|capital campaign ask)\b/i;

function solicitCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const narrativeText = evidence.narrative.relationshipSummary || evidence.narrative.institutionalMemory;
  if (narrativeText && SOLICITATION_PATTERN.test(narrativeText)) {
    return {
      kind: "solicit",
      action: `Make a solicitation ask, following up on: ${narrativeText}`,
      why: "Relationship notes describe a specific, still-relevant solicitation opportunity.",
      evidence: [`relationship_summary/institutional_memory: "${narrativeText}"`],
      confidence: "medium",
      timing: null,
      certainty: "narrative",
      specificity: 0.7,
      recency: 0.5,
      urgency: 0.4,
      supportingDate: evidence.now,
    };
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

function reconnectContactGapCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const days = evidence.contact.daysSinceLastContact;
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
    supportingDate: evidence.contact.daysSinceLastContact !== null ? evidence.now - evidence.contact.daysSinceLastContact * 86400 : null,
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
const YAHRTZEIT_LEAD_WINDOW_DAYS = 14;

function yahrtzeitOutreachCandidate(evidence: RecommendationEvidence): RecommendationCandidate | null {
  const soonest = [...evidence.yahrtzeits].sort((a, b) => a.daysUntil - b.daysUntil)[0];
  if (!soonest || soonest.daysUntil > YAHRTZEIT_LEAD_WINDOW_DAYS) return null;
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
    urgency: recencyScore(soonest.daysUntil, YAHRTZEIT_LEAD_WINDOW_DAYS),
    supportingDate: soonest.nextOccurrenceAt,
  };
}

export function generateCandidates(evidence: RecommendationEvidence): RecommendationCandidate[] {
  return [
    honorReminderCandidate(evidence),
    acknowledgeGiftCandidate(evidence),
    followUpPledgeCandidate(evidence),
    continueConversationCandidate(evidence),
    relationshipOpportunityCandidate(evidence),
    solicitCandidate(evidence),
    reconnectContactGapCandidate(evidence),
    yahrtzeitOutreachCandidate(evidence),
  ].filter((candidate): candidate is RecommendationCandidate => candidate !== null);
}
