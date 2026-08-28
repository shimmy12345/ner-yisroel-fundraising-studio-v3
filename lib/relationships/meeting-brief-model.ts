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
  // Null for an ordinary single-donor interaction, unchanged from before
  // these existed. When role is set, the UI should say "Sent to N donors"
  // (recipient) or "N participants" (participant) rather than implying a
  // one-on-one conversation -- never list the other donors by name here.
  sharedActivityId: string | null;
  role: "participant" | "recipient" | null;
  recipientCount: number | null;
};

export type MeetingBriefReminder = {
  id: string;
  action: string;
  reason: string;
  dueAt: number | null;
};

// Family background, not a logged interaction -- always shown regardless of
// how far away the date is (awareness), distinct from the separate,
// lead-window-gated yahrtzeit_outreach/birthday_outreach/anniversary_outreach
// recommendations (action urgency). One unified collection across all three
// relationship-date types rather than three parallel arrays -- Meeting
// Brief/Assistant context should read as one coherent family picture -- but
// yahrtzeit-specific facts (deceased name, Hebrew date, relationship,
// recurrence ambiguity) are kept as their own fields rather than flattened
// away: null on a birthday/anniversary row, populated on a yahrtzeit row.
export type MeetingBriefFamilyDate = {
  type: "yahrtzeit" | "birthday" | "anniversary";
  deceasedNameEnglish: string | null;
  deceasedNameHebrew: string | null;
  personName: string | null;
  relationship: string | null;
  // "5 Elul" for yahrtzeit, "Aug 24" for birthday/anniversary -- the
  // recorded date's own short label, independent of which year it next
  // falls in (see nextOccurrenceLabel).
  shortLabel: string;
  nextOccurrenceLabel: string;
  ambiguous: boolean;
  ambiguityNote: string | null;
};

// A fundraiser-recorded, still-PENDING ask -- relationship-layer data, not
// giving_activities/gifts (JL Solutions financial-system-of-record data).
// amountCents/purpose are both nullable: a legitimate ask can have no
// specific figure ("asked him to support the dinner") or no stated purpose.
// followUpDueAt is the due date of this ask's own open reminder (matched
// by the existing "ask-<askId>-" recommendation id convention -- see
// app/api/asks/route.ts/app/api/asks/[id]/reminder/route.ts), null when
// no open follow-up exists for this ask. Never a second, independent
// reminder system -- this is read-only awareness of the same
// `recommendations` row every other reminder surface already uses.
export type MeetingBriefAsk = {
  id: string;
  amountCents: number | null;
  purpose: string | null;
  askedAt: number;
  followUpDueAt: number | null;
};

// Matches each ask to its own earliest-due OPEN follow-up reminder, by
// the established "ask-<askId>-" recommendation id-prefix convention
// (app/api/asks/route.ts, app/api/asks/[id]/reminder/route.ts) -- no real
// FK, since `recommendations` has no ask_id column, matching every other
// reminder-link convention in this app (interactions' own
// "activity-<interactionId>"). Pure and D1-free so both callers (the
// Meeting Brief data loader and the donor page) share one tested
// implementation instead of two copies. Deterministic when an ask
// somehow carries more than one open reminder: the earliest due date
// wins, never an arbitrary first match; a null due date never wins over
// a real one.
export type AskReminderMatch = { id: string; dueAt: number | null };

export function matchAskFollowUps(askIds: readonly string[], openAskReminders: readonly AskReminderMatch[]): Map<string, AskReminderMatch | null> {
  const result = new Map<string, AskReminderMatch | null>();
  for (const askId of askIds) {
    const linked = openAskReminders.filter((reminder) => reminder.id.startsWith(`ask-${askId}-`));
    const earliest = linked.reduce<AskReminderMatch | null>((soonest, reminder) => {
      if (soonest === null) return reminder;
      if (reminder.dueAt === null) return soonest;
      if (soonest.dueAt === null || reminder.dueAt < soonest.dueAt) return reminder;
      return soonest;
    }, null);
    result.set(askId, earliest);
  }
  return result;
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

// One shared line-formatter, mirroring familyDateLine below, so the donor
// page, Meeting Brief, and the Assistant's pre-formatted context lines can
// never phrase the same ask fact differently. Never says "$0" -- a null
// amount degrades to purpose-only or a generic "pending ask" phrase
// instead of a fake zero-dollar figure.
export function askLine(item: MeetingBriefAsk, dateLabel: (epoch: number) => string): string {
  const amountLabel = item.amountCents !== null ? money(item.amountCents) : null;
  const what = amountLabel && item.purpose ? `${amountLabel} for ${item.purpose}` : amountLabel ?? item.purpose ?? "support (amount not specified)";
  return `Open ask: ${what}, pending since ${dateLabel(item.askedAt)}.`;
}

// One shared line-formatter so the donor-profile Meeting Brief page and the
// Assistant's pre-formatted context lines can never phrase the same fact
// differently. Always describes an UPCOMING date -- never implies outreach
// already happened.
export function familyDateLine(item: MeetingBriefFamilyDate): string {
  const ambiguitySuffix = item.ambiguous && item.ambiguityNote ? ` ${item.ambiguityNote}` : "";
  if (item.type === "yahrtzeit") {
    return `${item.relationship}'s yahrtzeit is ${item.shortLabel}; next occurrence ${item.nextOccurrenceLabel}.${ambiguitySuffix}`;
  }
  if (item.type === "birthday") {
    const who = item.personName ? `${item.personName}'s ` : "";
    return `${who}Birthday: ${item.shortLabel}; next occurrence ${item.nextOccurrenceLabel}.${ambiguitySuffix}`;
  }
  return `Wedding anniversary: ${item.shortLabel}; next occurrence ${item.nextOccurrenceLabel}.${ambiguitySuffix}`;
}

// The open pledge's active payment plan, already evaluated (see
// evaluatePaymentPlan in pledge-payment-plan.ts) and its one date field
// already formatted by the caller (which owns the fundraiser's timezone) --
// this model file stays pure, no date-formatting/timezone logic of its own.
export type MeetingBriefPledgePlanSummary = {
  balanceCents: number;
  isOnTrack: boolean;
  isLate: boolean;
  isPlanEndedWithBalance: boolean;
  isCompleted: boolean;
  nextExpectedLabel: string | null;
};

// One shared line-formatter, mirroring askLine/familyDateLine above, so
// this fact is never phrased two different ways across surfaces. Purely
// factual/descriptive ("Being paid monthly," "appears overdue") -- never
// framed as collections language, and never claims the donor failed to pay
// when the evidence only proves the expected cycle is late (see
// docs/PLEDGE-PAYMENT-PLAN-DESIGN.md).
export function pledgePlanLine(plan: MeetingBriefPledgePlanSummary): string {
  const remaining = `Open pledge: ${money(plan.balanceCents)} remaining.`;
  if (plan.isCompleted) return `${remaining} The recorded monthly payment plan appears paid in full.`;
  if (plan.isPlanEndedWithBalance) return `${remaining} The monthly payment plan's final expected date has passed with balance still open.`;
  if (plan.isLate) return `${remaining} Being paid monthly; the expected monthly payment appears overdue.`;
  if (plan.nextExpectedLabel) return `${remaining} Being paid monthly; next expected payment ${plan.nextExpectedLabel}.`;
  return `${remaining} Being paid monthly.`;
}

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
  // Always populated when the donor has any recorded yahrtzeits/birthdays/
  // anniversaries, regardless of the recommendation's lead window -- family
  // background context is never conditional on urgency the way the
  // suggested action is.
  familyImportantDates: MeetingBriefFamilyDate[];
  // Every still-PENDING ask for this donor (oldest first) -- factual,
  // never called an "opportunity." committed/declined/withdrawn asks are
  // history, not this brief's concern.
  openAsks: MeetingBriefAsk[];
  // Relationship Snapshot Architecture Stage 3 -- the donor's CURRENT
  // Relationship Snapshot, resolved via lib/relationships/fact-
  // synthesis.ts's shared resolveRelationshipSnapshot(): live-synthesized
  // from donor_relationship_facts when the donor has any, otherwise the
  // existing cached donors.relationship_summary/institutional_memory
  // byte-for-byte. Attached by loadMeetingBrief() (lib/relationships/
  // meeting-brief.ts), not by buildMeetingBrief() itself, so this pure
  // model function never needs D1-shaped fact rows threaded through its
  // own already-long parameter list. This is the ONE value Assistant
  // must read for relationship context when it has a Meeting Brief for
  // the donor -- never a second, independent resolution.
  relationshipSnapshot: { relationshipSummary: string | null; institutionalMemory: string | null };
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
  familyImportantDates: MeetingBriefFamilyDate[] = [],
  openAsks: MeetingBriefAsk[] = [],
  // Only ever describes the SAME single open pledge already reflected in
  // Suggested Action (openPledgeForEvidence) -- never a donor-wide summary,
  // never a second independent read of plan state. null when that pledge
  // has no active plan, in which case the pre-existing generic
  // "outstanding pledge balance" wording below is unchanged.
  openPledgePlan: MeetingBriefPledgePlanSummary | null = null,
  // Already resolved by the caller via lib/relationships/fact-
  // synthesis.ts's resolveRelationshipSnapshot() (live facts when the
  // donor has any, else the cached columns byte-for-byte) -- this
  // function only threads it through, never resolves it itself, so
  // there is exactly one resolution path for every caller. Defaults to
  // both-null for existing callers/fixtures that predate this field.
  relationshipSnapshot: { relationshipSummary: string | null; institutionalMemory: string | null } = { relationshipSummary: null, institutionalMemory: null },
): MeetingBrief {
  const paidGifts = gifts.filter((gift) => gift.paidCents > 0);
  const recentGift = [...paidGifts].sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0))[0] ?? null;
  const largestGift = [...paidGifts].sort((a, b) => b.paidCents - a.paidCents)[0] ?? null;
  const recentInteractions = [...interactions].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 5);
  const openReminders = [...reminders].sort((a, b) => (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER)).slice(0, 5);
  const openPledgeCents = gifts.reduce((sum, gift) => sum + Math.max(0, gift.balanceCents), 0);
  const allowedKinds = new Set<InteractionKind>(["call", "email", "meeting", "visit", "note", "personal", "text"]);
  const relationshipSignals = recentInteractions.map((interaction) => {
    const { note, subject } = splitInteractionSummary(interaction.summary);
    const kind = allowedKinds.has(interaction.type as InteractionKind) ? interaction.type as InteractionKind : "note";
    return relationshipSnapshotDetails(note || subject, kind);
  });
  // Real quoted facts from the notes themselves, not generic category
  // labels ("Personal update", "Yeshiva") -- see specificFacts' doc
  // comment in lib/capture/interaction.ts. A donor with no specific
  // relationship fact on file simply shows no discussion topics, rather
  // than a manufactured category name.
  const recentDiscussionTopics = [...new Set(relationshipSignals.flatMap((item) => item.specificFacts))].slice(0, 5);
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
      : openPledgePlan
        ? { title: "Discuss the open pledge", detail: pledgePlanLine(openPledgePlan) }
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
    familyImportantDates,
    openAsks,
    relationshipSnapshot,
  };
}
import { relationshipSnapshotDetails, splitInteractionSummary, type InteractionKind } from "../capture/interaction.ts";
