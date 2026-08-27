import { env } from "cloudflare:workers";
import {
  buildMeetingBrief,
  matchAskFollowUps,
  type MeetingBrief,
  type MeetingBriefDonor,
  type MeetingBriefGift,
  type MeetingBriefInteraction,
  type MeetingBriefReminder,
  type MeetingBriefFamilyDate,
  type MeetingBriefAsk,
  type MeetingBriefPledgePlanSummary,
} from "./meeting-brief-model";
import { importedContextLine } from "./historical-context";
import { financialDateLabel } from "../financial-date";
import { buildRecommendationEvidence, resolveOpenPledgeActivityDate } from "./recommendation-evidence";
import { buildDonorRecommendation } from "./recommendation-rank";
import type { GiftAcknowledgmentStatus, GiftSource } from "../giving/acknowledgment";
import { nextYahrtzeitOccurrence, type HebrewMonthName } from "../calendar/hebrew-date.ts";
import { nextGregorianRecurrence, yearsSinceForOccurrence } from "../calendar/gregorian-recurring-date.ts";
import type { ImportantDateType } from "../important-dates/validation.ts";

type DonorRow = {
  id: string;
  display_name: string;
  donor_code: string | null;
  external_id: string | null;
  last_name: string | null;
  primary_first_name: string | null;
  spouse_first_name: string | null;
  primary_title: string | null;
  spouse_title: string | null;
  email: string | null;
  phone: string | null;
  home_phone: string | null;
  address_line_1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  relationship_summary: string | null;
  institutional_memory: string | null;
};

type GivingRow = { id: string; activity_date: number | null; paid_cents: number | null; balance_cents: number | null; description: string | null; item_type: string | null; source_campaign: string | null };
type LegacyGiftRow = { id: string; received_at: number; amount_cents: number; fund: string };
type InteractionRow = { id: string; type: string; occurred_at: number; summary: string; role: string | null; shared_activity_id: string | null; shared_activity_recipient_count: number | null; shared_activity_summary: string | null };
type ReminderRow = { id: string; action: string; reason: string; due_at: number | null };
type HistoricalContextRow = { text: string; source: string; source_date: number | null };
type AcknowledgmentRow = { gift_source: GiftSource; gift_id: string; status: GiftAcknowledgmentStatus };
type YahrtzeitRow = { deceased_name_english: string; deceased_name_hebrew: string | null; relationship: string; hebrew_month: string; hebrew_day: number };
type ImportantDateRow = { type: ImportantDateType; person_name: string | null; relationship: string | null; month: number; day: number; year: number | null };
type AskRow = { id: string; amount_cents: number | null; purpose: string | null; asked_at: number };
type AskReminderRow = { id: string; due_at: number | null };
type PledgePaymentRow = { pledge_activity_id: string; payment_date: number };
type PaymentPlanRow = { pledge_activity_id: string; installment_amount_cents: number | null; expected_day_of_month: number; next_expected_payment_at: number; final_expected_payment_at: number };

function titled(title: string | null, name: string | null) {
  return name ? [title, name].filter(Boolean).join(" ") : null;
}

export async function loadMeetingBrief(userId: string, donorId: string, timezone: string, now = Math.floor(Date.now() / 1000)): Promise<MeetingBrief | null> {
  const donor = await env.DB.prepare(`SELECT id, display_name, donor_code, external_id, last_name, primary_first_name, spouse_first_name, primary_title, spouse_title, email, phone, home_phone, address_line_1, city, state, postal_code, country, relationship_summary, institutional_memory
    FROM donors WHERE id = ? AND owner_user_id = ? AND data_source = 'live' LIMIT 1`).bind(donorId, userId).first<DonorRow>();
  if (!donor) return null;

  const [giving, legacyGifts, interactions, reminders, historicalContextRows, historicalContextCount, acknowledgments, yahrtzeitRows, importantDateRows, openAskRows, openAskReminderRows, pledgePaymentRows, paymentPlanRows] = await Promise.all([
    env.DB.prepare(`SELECT id, activity_date, paid_cents, balance_cents, description, item_type, source_campaign
      FROM giving_activities
      WHERE donor_id = ? AND owner_user_id = ? AND record_origin = 'live'
        AND workspace_status = 'active' AND category NOT IN ('needs_review','nonfinancial_entry','pending_gift')
      ORDER BY activity_date DESC LIMIT 1000`).bind(donorId, userId).all<GivingRow>(),
    env.DB.prepare(`SELECT g.id, g.received_at, g.amount_cents, g.fund
      FROM gifts g JOIN donors d ON d.id = g.donor_id
      WHERE g.donor_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
      ORDER BY g.received_at DESC LIMIT 1000`).bind(donorId, userId).all<LegacyGiftRow>(),
    env.DB.prepare(`SELECT i.id, i.type, i.occurred_at, i.summary, i.role, i.shared_activity_id, sa.recipient_count AS shared_activity_recipient_count, sa.summary AS shared_activity_summary
      FROM interactions i JOIN donors d ON d.id = i.donor_id
      LEFT JOIN shared_activities sa ON sa.id = i.shared_activity_id
      WHERE i.donor_id = ? AND i.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND i.occurred_at <= ? AND i.source NOT LIKE 'cancelled:%' AND i.source NOT LIKE 'archived:%'
        AND (i.source LIKE 'capture-completed:%' OR (i.source NOT LIKE 'capture-scheduled:%' AND i.occurred_at <= i.created_at))
      ORDER BY i.occurred_at DESC LIMIT 5`).bind(donorId, userId, userId, now).all<InteractionRow>(),
    env.DB.prepare(`SELECT r.id, r.action, r.reason, r.due_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE r.donor_id = ? AND r.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND r.status = 'open'
      ORDER BY CASE WHEN r.due_at IS NULL THEN 1 ELSE 0 END, r.due_at LIMIT 5`).bind(donorId, userId, userId).all<ReminderRow>(),
    // Kept completely separate from the interactions query above -- this
    // can only ever land in unconfirmedHistoricalContext below, never in
    // lastMeaningfulContact/recentInteractions, so it can never be
    // surfaced as a real contact.
    env.DB.prepare(`SELECT text, source, source_date FROM donor_historical_context WHERE donor_id = ? AND user_id = ? AND status = 'unconfirmed' ORDER BY created_at DESC LIMIT 3`).bind(donorId, userId).all<HistoricalContextRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM donor_historical_context WHERE donor_id = ? AND user_id = ? AND status = 'unconfirmed'`).bind(donorId, userId).first<{ count: number }>(),
    // Newest row per (gift_source, gift_id) is "current status"; every
    // earlier mark stays in the table, never overwritten.
    env.DB.prepare(`SELECT gift_source, gift_id, status FROM gift_acknowledgments WHERE donor_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 2000`).bind(donorId, userId).all<AcknowledgmentRow>(),
    env.DB.prepare(`SELECT deceased_name_english, deceased_name_hebrew, relationship, hebrew_month, hebrew_day FROM yahrtzeits WHERE donor_id = ? AND user_id = ?`).bind(donorId, userId).all<YahrtzeitRow>(),
    env.DB.prepare(`SELECT type, person_name, relationship, month, day, year FROM important_dates WHERE donor_id = ? AND user_id = ?`).bind(donorId, userId).all<ImportantDateRow>(),
    // Oldest first -- [0] (if any) is the one most-in-need-of-follow-up ask,
    // fed into recommendation evidence below. Only 'pending' asks are
    // "open" -- committed/declined/withdrawn are history, not this brief's
    // concern.
    env.DB.prepare(`SELECT a.id, a.amount_cents, a.purpose, a.asked_at
      FROM asks a JOIN donors d ON d.id = a.donor_id
      WHERE a.donor_id = ? AND a.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND a.status = 'pending'
      ORDER BY a.asked_at ASC`).bind(donorId, userId, userId).all<AskRow>(),
    // Every OPEN reminder whose id carries the "ask-" prefix convention
    // (app/api/asks/route.ts, app/api/asks/[id]/reminder/route.ts) --
    // matched to its own ask below by id prefix, never a real FK
    // (recommendations has no ask_id column, matching every other
    // reminder-link convention in this app). One query for every ask's
    // follow-up state, not N.
    env.DB.prepare(`SELECT r.id, r.due_at
      FROM recommendations r JOIN donors d ON d.id = r.donor_id
      WHERE r.donor_id = ? AND r.user_id = ? AND d.owner_user_id = ? AND d.data_source = 'live'
        AND r.status = 'open' AND r.id LIKE 'ask-%'`).bind(donorId, userId, userId).all<AskReminderRow>(),
    // Every payment actually applied to one of this donor's pledges --
    // feeds openPledge's "last activity" date via
    // resolveOpenPledgeActivityDate (see its doc comment). NOT the same
    // as the pledge's own giving_activities.activity_date, which never
    // moves once a payment is applied to that row.
    env.DB.prepare(`SELECT pledge_activity_id, payment_date
      FROM jl_payment_assignment_audits
      WHERE donor_id = ? AND user_id = ? AND decision_type = 'apply_to_pledge'
        AND applied_cents > 0 AND payment_date IS NOT NULL`).bind(donorId, userId).all<PledgePaymentRow>(),
    // This donor's ACTIVE (ended_at IS NULL) payment plan(s), if any --
    // local stewardship metadata, never a JL fact. Feeds
    // openPledge.activePaymentPlan.
    env.DB.prepare(`SELECT pledge_activity_id, installment_amount_cents, expected_day_of_month, next_expected_payment_at, final_expected_payment_at
      FROM pledge_payment_plans
      WHERE donor_id = ? AND user_id = ? AND ended_at IS NULL`).bind(donorId, userId).all<PaymentPlanRow>(),
  ]);

  const address = [
    donor.address_line_1,
    [donor.city, donor.state, donor.postal_code].filter(Boolean).join(" "),
    donor.country,
  ].filter((line): line is string => Boolean(line));
  const identity: MeetingBriefDonor = {
    id: donor.id,
    displayName: donor.display_name,
    donorCode: donor.donor_code,
    externalId: donor.external_id,
    lastName: donor.last_name,
    primaryFirstName: donor.primary_first_name,
    primaryName: titled(donor.primary_title, donor.primary_first_name),
    spouseName: titled(donor.spouse_title, donor.spouse_first_name),
    email: donor.email,
    phone: donor.phone,
    homePhone: donor.home_phone,
    address,
  };
  const gifts: MeetingBriefGift[] = [
    ...giving.results.map((gift) => ({
      id: gift.id,
      occurredAt: gift.activity_date,
      paidCents: gift.paid_cents ?? 0,
      balanceCents: gift.balance_cents ?? 0,
      description: gift.description || gift.item_type || gift.source_campaign,
    })),
    ...legacyGifts.results.map((gift) => ({
      id: gift.id,
      occurredAt: gift.received_at,
      paidCents: gift.amount_cents,
      balanceCents: 0,
      description: gift.fund || null,
    })),
  ];
  const interactionData: MeetingBriefInteraction[] = interactions.results.map((item) => ({
    id: item.id,
    type: item.type,
    occurredAt: item.occurred_at,
    // Prefer the shared_activities parent's summary when linked -- same
    // single-canonical-copy rule as the unified timeline.
    summary: item.shared_activity_summary ?? item.summary,
    sharedActivityId: item.shared_activity_id,
    role: item.role === "participant" || item.role === "recipient" ? item.role : null,
    recipientCount: item.shared_activity_recipient_count,
  }));
  const reminderData: MeetingBriefReminder[] = reminders.results.map((item) => ({ id: item.id, action: item.action, reason: item.reason, dueAt: item.due_at }));
  const dateLabel = (epoch: number) => new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric", year: "numeric" }).format(new Date(epoch * 1000));
  const unconfirmedHistoricalContext = historicalContextRows.results.map((row) => importedContextLine(row.text, row.source, row.source_date ? dateLabel(row.source_date) : null));

  // Family important dates: always surfaced for awareness (never gated by
  // the separate yahrtzeit_outreach/birthday_outreach/anniversary_outreach
  // recommendations' lead window) -- background context, never a logged
  // interaction. One unified, chronologically-sorted collection across all
  // three types (see MeetingBriefFamilyDate).
  const yahrtzeitEvidenceInput = yahrtzeitRows.results.map((row) => ({ deceasedNameEnglish: row.deceased_name_english, deceasedNameHebrew: row.deceased_name_hebrew, relationship: row.relationship, hebrewMonth: row.hebrew_month as HebrewMonthName, hebrewDay: row.hebrew_day }));
  const importantDateEvidenceInput = importantDateRows.results.map((row) => ({ type: row.type, personName: row.person_name, relationship: row.relationship, month: row.month, day: row.day, year: row.year }));
  const familyImportantDates: MeetingBriefFamilyDate[] = [
    ...yahrtzeitEvidenceInput.map((item) => {
      const occurrence = nextYahrtzeitOccurrence(item.hebrewMonth, item.hebrewDay, timezone, now);
      const entry: MeetingBriefFamilyDate = {
        type: "yahrtzeit",
        deceasedNameEnglish: item.deceasedNameEnglish,
        deceasedNameHebrew: item.deceasedNameHebrew,
        personName: null,
        relationship: item.relationship,
        shortLabel: occurrence.primary.hebrewLabel,
        nextOccurrenceLabel: dateLabel(occurrence.primary.gregorianEpoch),
        ambiguous: occurrence.ambiguous,
        ambiguityNote: occurrence.ambiguityNote,
      };
      return { entry, sortAt: occurrence.primary.gregorianEpoch };
    }),
    ...importantDateEvidenceInput.map((item) => {
      const occurrence = nextGregorianRecurrence(item.month, item.day, timezone, now);
      const entry: MeetingBriefFamilyDate = {
        type: item.type,
        deceasedNameEnglish: null,
        deceasedNameHebrew: null,
        personName: item.personName,
        relationship: item.relationship,
        shortLabel: occurrence.primary.label,
        nextOccurrenceLabel: dateLabel(occurrence.primary.gregorianEpoch),
        ambiguous: occurrence.ambiguous,
        ambiguityNote: occurrence.ambiguityNote,
      };
      return { entry, sortAt: occurrence.primary.gregorianEpoch };
    }),
  ].sort((a, b) => a.sortAt - b.sortAt).map(({ entry }) => entry);

  // Suggested Action: same shared engine as the donor page/homepage/
  // Assistant, built from the exact same rows already fetched above.
  const acknowledgmentByGift = new Set(acknowledgments.results.map((row) => `${row.gift_source}:${row.gift_id}`));
  const paidFromActivities = giving.results.filter((item) => (item.paid_cents ?? 0) > 0 && item.activity_date !== null).map((item) => ({ giftSource: "giving_activity" as GiftSource, giftId: item.id, amountCents: item.paid_cents!, occurredAt: item.activity_date!, campaign: item.source_campaign, description: item.description || item.item_type, acknowledged: acknowledgmentByGift.has(`giving_activity:${item.id}`) }));
  const paidFromLegacy = legacyGifts.results.map((gift) => ({ giftSource: "gift" as GiftSource, giftId: gift.id, amountCents: gift.amount_cents, occurredAt: gift.received_at, campaign: gift.fund as string | null, description: null as string | null, acknowledged: acknowledgmentByGift.has(`gift:${gift.id}`) }));
  const mostRecentPaidGiftForEvidence = [...paidFromActivities, ...paidFromLegacy].sort((a, b) => b.occurredAt - a.occurredAt)[0] ?? null;
  const openPledgeSource = giving.results.find((item) => (item.balance_cents ?? 0) > 0);
  const openPledgePaymentDates = openPledgeSource ? pledgePaymentRows.results.filter((event) => event.pledge_activity_id === openPledgeSource.id).map((event) => event.payment_date) : [];
  const openPledgePlan = openPledgeSource ? paymentPlanRows.results.find((item) => item.pledge_activity_id === openPledgeSource.id) : undefined;
  const openPledgeForEvidence = openPledgeSource
    ? {
        balanceCents: openPledgeSource.balance_cents ?? 0,
        campaign: openPledgeSource.source_campaign,
        description: openPledgeSource.description || openPledgeSource.item_type,
        activityDate: resolveOpenPledgeActivityDate(openPledgeSource.activity_date, openPledgePaymentDates),
        activePaymentPlan: openPledgePlan
          ? { nextExpectedPaymentAt: openPledgePlan.next_expected_payment_at, expectedDayOfMonth: openPledgePlan.expected_day_of_month, finalExpectedPaymentAt: openPledgePlan.final_expected_payment_at, endedAt: null, installmentAmountCents: openPledgePlan.installment_amount_cents, linkedPaymentDates: openPledgePaymentDates }
          : null,
      }
    : null;
  const latestInteraction = interactions.results[0];
  // Same "most recent of the last 5 fetched" precision this whole evidence
  // build already uses for lastContactAt -- not a new approximation. A donor
  // whose last 5 interactions are entirely role='recipient' broadcasts (rare
  // -- would mean no substantive contact logged at all in the visible
  // window) falls back to null here, matching how "never contacted" is
  // already handled everywhere else in this evidence shape.
  const latestSubstantiveInteraction = interactions.results.find((item) => item.role !== "recipient");
  // Computed before evidence so openAskForEvidence can carry each ask's
  // own active-follow-up due date (see recommendation-evidence.ts's
  // activeFollowUpDueAt) -- the same map is reused below for the full
  // openAsks display list, never computed twice.
  const followUpByAsk = matchAskFollowUps(
    openAskRows.results.map((row) => row.id),
    openAskReminderRows.results.map((row) => ({ id: row.id, dueAt: row.due_at })),
  );
  const openAskForEvidence = openAskRows.results[0] ? { id: openAskRows.results[0].id, amountCents: openAskRows.results[0].amount_cents, purpose: openAskRows.results[0].purpose, askedAt: openAskRows.results[0].asked_at, activeFollowUpDueAt: followUpByAsk.get(openAskRows.results[0].id)?.dueAt ?? null } : null;
  const recommendationEvidence = buildRecommendationEvidence({
    donorId,
    mostRecentPaidGift: mostRecentPaidGiftForEvidence,
    openPledge: openPledgeForEvidence,
    lastCompletedInteraction: latestInteraction ? { type: latestInteraction.type, summary: latestInteraction.summary, occurredAt: latestInteraction.occurred_at } : null,
    lastContactAt: latestInteraction?.occurred_at ?? null,
    lastSubstantiveContactAt: latestSubstantiveInteraction?.occurred_at ?? null,
    openReminder: reminders.results[0] ? { action: reminders.results[0].action, reason: reminders.results[0].reason, dueAt: reminders.results[0].due_at } : null,
    openAsk: openAskForEvidence,
    relationshipSummary: donor.relationship_summary,
    institutionalMemory: donor.institutional_memory,
    historicalContext: historicalContextRows.results.map((row) => ({ text: row.text, source: row.source, sourceDate: row.source_date })),
    yahrtzeits: yahrtzeitEvidenceInput,
    importantDates: importantDateEvidenceInput,
  }, now, timezone);
  const recommendation = buildDonorRecommendation(recommendationEvidence);
  const openAsks: MeetingBriefAsk[] = openAskRows.results.map((row) => ({ id: row.id, amountCents: row.amount_cents, purpose: row.purpose, askedAt: row.asked_at, followUpDueAt: followUpByAsk.get(row.id)?.dueAt ?? null }));

  // Same single open pledge already reflected in Suggested Action above --
  // never a second independent read of plan state, never a donor-wide
  // summary across multiple open pledges.
  const activePlan = recommendationEvidence.giving.openPledge?.activePaymentPlan ?? null;
  const openPledgePlanSummary: MeetingBriefPledgePlanSummary | null = activePlan && recommendationEvidence.giving.openPledge
    ? {
        balanceCents: recommendationEvidence.giving.openPledge.balanceCents,
        isOnTrack: activePlan.isOnTrack,
        isLate: activePlan.isLate,
        isPlanEndedWithBalance: activePlan.isPlanEndedWithBalance,
        isCompleted: activePlan.isCompleted,
        // financialDateLabel (UTC-pinned), never the timezone-aware
        // dateLabel above -- this is a financial date-only epoch (UTC
        // midnight, same convention as every other pledge/payment date),
        // not a recurrence date computed in the fundraiser's own
        // timezone like familyDateLine's occurrences. Using dateLabel here
        // would shift the displayed day backward for any fundraiser west
        // of UTC -- the same date-only/timezone bug class already fixed
        // once for open-pledge activity dates.
        nextExpectedLabel: activePlan.nextUnsatisfiedExpectedPaymentAt !== null ? financialDateLabel(activePlan.nextUnsatisfiedExpectedPaymentAt) : null,
      }
    : null;

  return buildMeetingBrief(identity, gifts, interactionData, reminderData, unconfirmedHistoricalContext, historicalContextCount?.count ?? 0, recommendation, familyImportantDates, openAsks, openPledgePlanSummary);
}
