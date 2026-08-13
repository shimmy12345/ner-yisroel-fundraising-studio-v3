import type { DonorRecommendation } from "./recommendation-rank.ts";

export type MeetingBriefDonor = {
  id: string;
  displayName: string;
  donorCode: string | null;
  externalId: string | null;
  lastName: string | null;
  primaryFirstName: string | null;
  primaryName: string | null;
  spouseName: string | null;
  email: string | null;
  phone: string | null;
  homePhone: string | null;
  address: string[];
};

export type MeetingBriefGift = {
  id: string;
  occurredAt: number | null;
  paidCents: number;
  balanceCents: number;
  description: string | null;
};

export type MeetingBriefInteraction = {
  id: string;
  type: string;
  occurredAt: number;
  summary: string;
};

export type MeetingBriefReminder = {
  id: string;
  action: string;
  reason: string;
  dueAt: number | null;
};

// Family background, not a logged interaction -- always shown regardless of
// how far away the date is (awareness), distinct from the separate,
// lead-window-gated yahrtzeit_outreach recommendation (action urgency).
export type MeetingBriefYahrtzeit = {
  deceasedNameEnglish: string;
  deceasedNameHebrew: string | null;
  relationship: string;
  hebrewLabel: string;
  nextOccurrenceLabel: string;
};

export type MeetingBrief = {
  donor: MeetingBriefDonor;
  lifetimePaidCents: number;
  recentGift: MeetingBriefGift | null;
  largestGift: MeetingBriefGift | null;
  openPledgeCents: number;
  recentInteractions: MeetingBriefInteraction[];
  openReminders: MeetingBriefReminder[];
  lastMeaningfulContact: MeetingBriefInteraction | null;
  recentDiscussionTopics: string[];
  peopleMentioned: string[];
  discussionTopics: Array<{ title: string; detail: string }>;
  followUpActions: Array<{ title: string; detail: string }>;
  // Already-formatted, uncertainty-stating lines (lib/relationships/
  // historical-context.ts), capped for a compact brief. Must never be
  // confused with lastMeaningfulContact/recentInteractions: this surfaces
  // donor_historical_context rows, which are never a logged interaction.
  unconfirmedHistoricalContext: string[];
  unconfirmedHistoricalContextCount: number;
  // The one canonical, evidence-driven suggestion for this donor --
  // computed by lib/relationships/recommendation-rank.ts from the exact
  // same evidence every other surface (donor profile, homepage/Today,
  // Assistant) reads, so this can never disagree with them. null only
  // when there is genuinely no evidence to suggest anything.
  recommendation: DonorRecommendation | null;
  // Always populated when the donor has any recorded yahrtzeits, regardless
  // of the recommendation's lead window -- family background context is
  // never conditional on urgency the way the suggested action is.
  familyYahrtzeits: MeetingBriefYahrtzeit[];
};

function firstLine(value: string) {
  return value.split("\n")[0]?.trim() || value.trim();
}

export function buildMeetingBrief(
  donor: MeetingBriefDonor,
  gifts: MeetingBriefGift[],
  interactions: MeetingBriefInteraction[],
  reminders: MeetingBriefReminder[],
  unconfirmedHistoricalContext: string[] = [],
  unconfirmedHistoricalContextCount = unconfirmedHistoricalContext.length,
  recommendation: DonorRecommendation | null = null,
  familyYahrtzeits: MeetingBriefYahrtzeit[] = [],
): MeetingBrief {
  const paidGifts = gifts.filter((gift) => gift.paidCents > 0);
  const recentGift = [...paidGifts].sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))[0] ?? null;
  const largestGift = [...paidGifts].sort((a, b) => b.paidCents - a.paidCents)[0] ?? null;
  const recentInteractions = [...interactions].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 5);
  const openReminders = [...reminders].sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)).slice(0, 5);
  const openPledgeCents = gifts.reduce((sum, gift) => sum + Math.max(0, gift.balanceCents), 0);
  const allowedKinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal"]);
  const relationshipSignals = recentInteractions.map((interaction) => {
    const { note, subject } = splitInteractionSummary(interaction.summary);
    const kind = allowedKinds.has(interaction.type as InteractionKind) ? interaction.type as InteractionKind : "note";
    return relationshipSnapshotDetails(note || subject, kind);
  });
  const recentDiscussionTopics = [...new Set(relationshipSignals.flatMap((item) => item.topics))].slice(0, 5);
  const peopleMentioned = [...new Set(relationshipSignals.flatMap((item) => item.people))].slice(0, 8);

  const discussionTopics = [
    recentGift
      ? { title: "Acknowledge recent support", detail: recentGift.description ? `The latest paid giving activity is recorded as “${recentGift.description}.”` : "A recent paid gift is recorded without a designation or note." }
      : { title: "Clarify giving history", detail: "No paid giving is recorded for this household." },
    recentInteractions[0]
      ? { title: "Continue the latest conversation", detail: firstLine(recentInteractions[0].summary) }
      : { title: "Establish relationship context", detail: "No prior interaction is recorded for this household." },
    openReminders[0]
      ? { title: "Address the recorded next step", detail: `${openReminders[0].action}. ${openReminders[0].reason}` }
      : openPledgeCents > 0
        ? { title: "Discuss the open pledge", detail: "The giving record contains an outstanding pledge balance." }
        : { title: "Agree on a next step", detail: "No open reminder or pledge commitment is recorded." },
  ];

  const followUpActions = [
    { title: "Log the meeting outcome", detail: "Capture what happened, decisions made, and any commitments in the donor timeline." },
    openReminders[0]
      ? { title: "Update the open reminder", detail: openReminders[0].action }
      : { title: "Set a dated next action", detail: "Record the agreed follow-up while the meeting is fresh." },
    openPledgeCents > 0
      ? { title: "Record the pledge outcome", detail: "Update the existing pledge only if the donor confirms a change." }
      : { title: "Preserve new relationship context", detail: "Record only facts and preferences the donor actually shared." },
  ];

  return {
    donor,
    lifetimePaidCents: gifts.reduce((sum, gift) => sum + Math.max(0, gift.paidCents), 0),
    recentGift,
    largestGift,
    openPledgeCents,
    recentInteractions,
    openReminders,
    lastMeaningfulContact: recentInteractions[0] ?? null,
    recentDiscussionTopics,
    peopleMentioned,
    discussionTopics,
    followUpActions,
    unconfirmedHistoricalContext,
    unconfirmedHistoricalContextCount,
    recommendation,
    familyYahrtzeits,
  };
}
import { relationshipSnapshotDetails, splitInteractionSummary, type InteractionKind } from "../capture/interaction.ts";
