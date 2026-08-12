// Structured, per-donor evidence for the suggested-action engine. Pure --
// no D1 access. Every caller (donor page, Meeting Brief, Assistant,
// homepage/Today queue) assembles its own RecommendationEvidenceInput from
// whatever it has already queried and calls buildRecommendationEvidence(),
// so the same fields feed the same downstream candidates no matter which
// surface is asking. This is the single place raw facts become evidence;
// lib/relationships/recommendation-candidates.ts and recommendation-rank.ts
// never read a table directly.

import type { GiftSource } from "../giving/acknowledgment.ts";

export type RecommendationEvidenceInput = {
  donorId: string;
  // The most recent PAID gift/activity -- drives acknowledge_gift. Always
  // sourced from giving_activities/gifts (JL financial data), never from
  // donor_historical_context: a Monday "donation note" is deliberately
  // never importable as historical context in the first place, and this
  // field structurally cannot be populated from anything else.
  // `acknowledged` is the explicit gift_acknowledgments state for this
  // exact gift -- the only signal that suppresses acknowledge_gift.
  // Deliberately NOT inferred from "some interaction happened after the
  // gift date": a routine thank-you is often sent without logging a full
  // interaction, and an unrelated interaction is not evidence the gift was
  // acknowledged. If the caller has no acknowledgment lookup available,
  // pass false -- that's the safe default (never silently suppress).
  mostRecentPaidGift: { giftSource: GiftSource; giftId: string; amountCents: number; occurredAt: number; campaign: string | null; description: string | null; acknowledged: boolean } | null;
  // An open (unpaid) pledge balance -- drives follow_up_pledge and gates
  // solicit. Same provenance constraint as above.
  openPledge: { balanceCents: number; campaign: string | null; description: string | null; activityDate: number | null } | null;
  // The donor's most recent COMPLETED interaction (never a scheduled or
  // cancelled one) -- drives continue_conversation and acknowledgedSinceGift.
  lastCompletedInteraction: { type: string; summary: string; occurredAt: number } | null;
  // MAX(occurred_at) across all completed contact, independent of whether
  // the full interaction row was fetched -- drives reconnect_contact_gap.
  lastContactAt: number | null;
  // The donor's open reminder, if any -- a real recommendations row (an
  // explicit fundraiser commitment), never invented here.
  openReminder: { action: string; reason: string; dueAt: number | null } | null;
  // donors.relationship_summary / institutional_memory -- human-reviewed,
  // AI-suggested-then-accepted text. More trustworthy than an imported
  // note, less than a confirmed database row.
  relationshipSummary: string | null;
  institutionalMemory: string | null;
  // Unconfirmed donor_historical_context rows only (status='unconfirmed').
  // Never used to populate mostRecentPaidGift/openPledge/lastCompletedInteraction/
  // openReminder -- see recommendation-candidates.ts for the structural
  // enforcement of "never assume an old planned Monday action happened."
  historicalContext: Array<{ text: string; source: string; sourceDate: number | null }>;
};

export type RecommendationEvidence = {
  donorId: string;
  giving: {
    mostRecentPaidGift: { giftSource: GiftSource; giftId: string; amountCents: number; occurredAt: number; campaign: string | null; description: string | null; acknowledged: boolean } | null;
    openPledge: { balanceCents: number; campaign: string | null; description: string | null; activityDate: number | null; ageDays: number | null } | null;
  };
  contact: {
    lastCompletedInteraction: { type: string; summary: string; occurredAt: number; daysAgo: number } | null;
    daysSinceLastContact: number | null;
  };
  reminder: { action: string; reason: string; dueAt: number | null; isOverdue: boolean } | null;
  narrative: { relationshipSummary: string | null; institutionalMemory: string | null };
  historicalContext: Array<{ text: string; source: string; sourceDate: number | null }>;
  now: number;
};

const DAY_SECONDS = 86400;
const daysBetween = (laterEpoch: number, earlierEpoch: number) => Math.max(0, Math.floor((laterEpoch - earlierEpoch) / DAY_SECONDS));

export function buildRecommendationEvidence(input: RecommendationEvidenceInput, now: number): RecommendationEvidence {
  return {
    donorId: input.donorId,
    giving: {
      mostRecentPaidGift: input.mostRecentPaidGift,
      openPledge: input.openPledge
        ? { ...input.openPledge, ageDays: input.openPledge.activityDate !== null ? daysBetween(now, input.openPledge.activityDate) : null }
        : null,
    },
    contact: {
      lastCompletedInteraction: input.lastCompletedInteraction
        ? { ...input.lastCompletedInteraction, daysAgo: daysBetween(now, input.lastCompletedInteraction.occurredAt) }
        : null,
      daysSinceLastContact: input.lastContactAt !== null ? daysBetween(now, input.lastContactAt) : null,
    },
    reminder: input.openReminder
      ? { ...input.openReminder, isOverdue: input.openReminder.dueAt !== null && input.openReminder.dueAt < now }
      : null,
    narrative: { relationshipSummary: input.relationshipSummary, institutionalMemory: input.institutionalMemory },
    historicalContext: input.historicalContext,
    now,
  };
}
