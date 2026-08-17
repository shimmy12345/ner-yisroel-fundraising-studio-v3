// Structured, per-donor evidence for the suggested-action engine. Pure --
// no D1 access. Every caller (donor page, Meeting Brief, Assistant,
// homepage/Today queue) assembles its own RecommendationEvidenceInput from
// whatever it has already queried and calls buildRecommendationEvidence(),
// so the same fields feed the same downstream candidates no matter which
// surface is asking. This is the single place raw facts become evidence;
// lib/relationships/recommendation-candidates.ts and recommendation-rank.ts
// never read a table directly.

import type { GiftSource } from "../giving/acknowledgment.ts";
import { nextYahrtzeitOccurrence, type HebrewMonthName } from "../calendar/hebrew-date.ts";
import { nextGregorianRecurrence, yearsSinceForOccurrence } from "../calendar/gregorian-recurring-date.ts";
import type { ImportantDateType } from "../important-dates/validation.ts";
import { localDayKey } from "../workspace/local-time.ts";

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
  // Family yahrtzeits -- background context, never an interaction, never a
  // confirmed-contact signal. Raw Hebrew month/day only; the current-year
  // Gregorian occurrence is computed here (see below), not stored anywhere,
  // so it advances automatically once a given year's date passes.
  yahrtzeits: Array<{ deceasedNameEnglish: string; deceasedNameHebrew: string | null; relationship: string; hebrewMonth: HebrewMonthName; hebrewDay: number }>;
  // Birthdays/anniversaries -- same "background context, never a contact
  // signal" status as yahrtzeits above, computed the same way: raw
  // Gregorian month/day/year only, the current occurrence recalculated
  // here (see lib/calendar/gregorian-recurring-date.ts), never stored.
  importantDates: Array<{ type: ImportantDateType; personName: string | null; relationship: string | null; month: number; day: number; year: number | null }>;
};

export type YahrtzeitEvidence = {
  deceasedNameEnglish: string;
  deceasedNameHebrew: string | null;
  relationship: string;
  hebrewLabel: string;
  nextOccurrenceAt: number;
  daysUntil: number;
  ambiguous: boolean;
  ambiguityNote: string | null;
};

export type ImportantDateEvidence = {
  type: ImportantDateType;
  personName: string | null;
  relationship: string | null;
  label: string;
  nextOccurrenceAt: number;
  daysUntil: number;
  // Age (birthday) or years married (anniversary), derived from the
  // Gregorian YEAR THE UPCOMING OCCURRENCE FALLS IN -- never from today's
  // calendar year -- so it always matches the specific occurrence being
  // displayed, including when that occurrence has already rolled into next
  // calendar year. Never stored; null when the source year is unknown.
  derivedYears: number | null;
  ambiguous: boolean;
  ambiguityNote: string | null;
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
  yahrtzeits: YahrtzeitEvidence[];
  importantDates: ImportantDateEvidence[];
  now: number;
};

const DAY_SECONDS = 86400;
const daysBetween = (laterEpoch: number, earlierEpoch: number) => Math.max(0, Math.floor((laterEpoch - earlierEpoch) / DAY_SECONDS));

export function buildRecommendationEvidence(input: RecommendationEvidenceInput, now: number, timezone: string): RecommendationEvidence {
  const yahrtzeits: YahrtzeitEvidence[] = input.yahrtzeits.map((item) => {
    const occurrence = nextYahrtzeitOccurrence(item.hebrewMonth, item.hebrewDay, timezone, now);
    return {
      deceasedNameEnglish: item.deceasedNameEnglish,
      deceasedNameHebrew: item.deceasedNameHebrew,
      relationship: item.relationship,
      hebrewLabel: occurrence.primary.hebrewLabel,
      nextOccurrenceAt: occurrence.primary.gregorianEpoch,
      daysUntil: daysBetween(occurrence.primary.gregorianEpoch, now),
      ambiguous: occurrence.ambiguous,
      ambiguityNote: occurrence.ambiguityNote,
    };
  });
  const importantDates: ImportantDateEvidence[] = input.importantDates.map((item) => {
    const occurrence = nextGregorianRecurrence(item.month, item.day, timezone, now);
    return {
      type: item.type,
      personName: item.personName,
      relationship: item.relationship,
      label: occurrence.primary.label,
      nextOccurrenceAt: occurrence.primary.gregorianEpoch,
      daysUntil: daysBetween(occurrence.primary.gregorianEpoch, now),
      derivedYears: item.year !== null ? yearsSinceForOccurrence(occurrence.primary.year, item.year) : null,
      ambiguous: occurrence.ambiguous,
      ambiguityNote: occurrence.ambiguityNote,
    };
  });
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
    // Calendar-day (not raw-instant) comparison, matching
    // lib/relationships/unified-timeline.ts and the already-proven pattern
    // in lib/workspace/live-data.ts / lib/workspace/relationship-queue.ts
    // -- a reminder due today must not read as overdue merely because
    // "now" has passed its stored due_at instant (e.g. a Monday.com-
    // imported date-only value anchored at UTC noon).
    reminder: input.openReminder
      ? { ...input.openReminder, isOverdue: input.openReminder.dueAt !== null && localDayKey(input.openReminder.dueAt, timezone) < localDayKey(now, timezone) }
      : null,
    narrative: { relationshipSummary: input.relationshipSummary, institutionalMemory: input.institutionalMemory },
    historicalContext: input.historicalContext,
    yahrtzeits,
    importantDates,
    now,
  };
}
