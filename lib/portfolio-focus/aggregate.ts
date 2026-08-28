// Portfolio Focus -- aggregation layer. Pure (no D1, no I/O): turns raw
// D1 rows (shapes defined here, populated by lib/portfolio-focus/data.ts)
// into PortfolioFocusDonorInput[] using the SAME audited financial
// reconstruction and the SAME real, unmodified production functions
// every other surface in this codebase uses -- never a second, competing
// financial-truth model (docs/AI-HANDOFF.md "Financial-Data-Model
// Audit"; docs/PORTFOLIO-FOCUS-CALIBRATION-V3.md "Financial model must
// remain canonical").
import { buildRecommendationEvidence, resolveOpenPledgeActivityDate, type RecommendationEvidenceInput } from "../relationships/recommendation-evidence.ts";
import { buildDonorRecommendation } from "../relationships/recommendation-rank.ts";
import { matchAskFollowUps } from "../relationships/meeting-brief-model.ts";
import { evaluatePaymentPlan, type PaymentPlanFields } from "../relationships/pledge-payment-plan.ts";
import { findMostActionableFact, resolveRelationshipSnapshot, type SynthesisFact } from "../relationships/fact-synthesis.ts";
import { nextYahrtzeitOccurrence, type HebrewMonthName } from "../calendar/hebrew-date.ts";
import { nextGregorianRecurrence } from "../calendar/gregorian-recurring-date.ts";
import type { ImportantDateType } from "../important-dates/validation.ts";
import type { PortfolioFocusDonorInput } from "./types.ts";

const DAY = 86400;
const KNOWN_GIVING_CATEGORIES = new Set(["completed_gift", "open_pledge", "partially_paid_pledge"]);

export type RawDonorRow = { id: string; display_name: string; donor_code: string | null; relationship_summary: string | null; institutional_memory: string | null };
export type RawGivingRow = { id: string; donor_id: string; paid_cents: number | null; balance_cents: number | null; activity_date: number | null; category: string; item_type: string | null; description: string | null };
export type RawAskRow = { id: string; donor_id: string; amount_cents: number | null; purpose: string | null; status: string; asked_at: number; source_interaction_id: string | null };
export type RawInteractionRow = { donor_id: string; type: string; occurred_at: number; role: string | null };
export type RawReminderRow = { recommendation_id: string; donor_id: string; action: string; reason: string; due_at: number | null };
export type RawYahrtzeitRow = { donor_id: string; deceased_name_english: string; deceased_name_hebrew: string | null; relationship: string; hebrew_month: HebrewMonthName; hebrew_day: number };
export type RawImportantDateRow = { donor_id: string; type: ImportantDateType; person_name: string | null; relationship: string | null; month: number; day: number; year: number | null };
export type RawPledgePaymentRow = { pledge_activity_id: string; payment_date: number; applied_cents: number };
export type RawPaymentPlanRow = { donor_id: string; pledge_activity_id: string; installment_amount_cents: number | null; expected_day_of_month: number; next_expected_payment_at: number; final_expected_payment_at: number };
export type RawRelationshipFactRow = { donor_id: string; category: string; lifecycle: string; status: string; fact_text: string; source_interaction_id: string | null; source_interaction_occurred_at: number };
export type RawAcknowledgmentRow = { donor_id: string; gift_source: string; gift_id: string; status: string };
export type RawHistoricalContextRow = { donor_id: string };

export type PortfolioFocusRawData = {
  donors: RawDonorRow[];
  giving: RawGivingRow[];
  asks: RawAskRow[];
  interactions: RawInteractionRow[];
  reminders: RawReminderRow[];
  yahrtzeits: RawYahrtzeitRow[];
  importantDates: RawImportantDateRow[];
  pledgePayments: RawPledgePaymentRow[];
  paymentPlans: RawPaymentPlanRow[];
  relationshipFacts: RawRelationshipFactRow[];
  acknowledgments: RawAcknowledgmentRow[];
  historicalContext: RawHistoricalContextRow[];
};

export type PortfolioFocusAggregation = {
  donorInputs: PortfolioFocusDonorInput[];
  // Every completed-gift amount + every pledge's total commitment,
  // portfolio-wide -- the materiality basis every donor's Opportunity/
  // Stewardship draws its portfolio-percentile term from. Built once
  // here, never per-donor.
  financialEventAmounts: number[];
};

function group<T, K extends string>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

// Category-agnostic cash-event reconstruction -- IDENTICAL methodology
// to the audited financial model (docs/AI-HANDOFF.md "Financial-Data-
// Model Audit" / "Portfolio-Level 30-Day Focus Investigation -- CORRECTED
// REDO"): a pledge payment's real date comes from
// jl_payment_assignment_audits, never the pledge row's own activity_date
// (frozen at commitment time); an unaudited remainder is attributed to
// the pledge's own activity_date ONLY when that date is a genuine past
// date (a future-dated row -- confirmed to occur in this data -- must
// never create false recency).
type CashEvent = { cents: number; date: number | null; kind: "gift" | "pledge_payment" | "undated_pledge_cash"; rowId: string };
function cashEventsForDonor(donorGiving: RawGivingRow[], paymentsByPledge: Map<string, { date: number; cents: number }[]>, now: number): CashEvent[] {
  const events: CashEvent[] = [];
  for (const row of donorGiving) {
    if (!KNOWN_GIVING_CATEGORIES.has(row.category)) continue; // fail-safe: an unrecognized category is never silently included
    const paid = row.paid_cents ?? 0;
    if (paid <= 0) continue;
    if (row.category === "completed_gift") {
      events.push({ cents: paid, date: row.activity_date, kind: "gift", rowId: row.id });
    } else {
      const audited = paymentsByPledge.get(row.id) ?? [];
      const auditedSum = audited.reduce((s, a) => s + a.cents, 0);
      for (const a of audited) events.push({ cents: a.cents, date: a.date, kind: "pledge_payment", rowId: row.id });
      const unaudited = paid - auditedSum;
      if (unaudited > 0) {
        if (row.activity_date != null && row.activity_date <= now) events.push({ cents: unaudited, date: row.activity_date, kind: "pledge_payment", rowId: row.id });
        else events.push({ cents: unaudited, date: null, kind: "undated_pledge_cash", rowId: row.id });
      }
    }
  }
  return events.sort((a, b) => (b.date ?? -Infinity) - (a.date ?? -Infinity));
}

export function aggregatePortfolioFocusInputs(raw: PortfolioFocusRawData, now: number, timezone: string): PortfolioFocusAggregation {
  for (const g of raw.giving) if (!KNOWN_GIVING_CATEGORIES.has(g.category)) throw new Error(`Portfolio Focus: unexpected giving_activities category "${g.category}" -- refusing to silently ignore it`);
  for (const g of raw.giving) if (!g.id) throw new Error(`Portfolio Focus: a giving_activities row for donor ${g.donor_id} has no id -- payment-audit join would silently fail`);
  const givingIdSet = new Set(raw.giving.map((g) => g.id));
  for (const p of raw.pledgePayments) if (!givingIdSet.has(p.pledge_activity_id)) throw new Error(`Portfolio Focus: a jl_payment_assignment_audits row references pledge_activity_id "${p.pledge_activity_id}" not present in the giving pull`);

  const givingByDonor = group(raw.giving, (g) => g.donor_id);
  const asksByDonor = group(raw.asks, (a) => a.donor_id);
  const interactionsByDonor = group(raw.interactions, (i) => i.donor_id);
  for (const list of interactionsByDonor.values()) list.sort((a, b) => b.occurred_at - a.occurred_at);
  const remindersByDonor = group(raw.reminders, (r) => r.donor_id);
  const yahrtzeitsByDonor = group(raw.yahrtzeits, (y) => y.donor_id);
  const importantDatesByDonor = group(raw.importantDates, (d) => d.donor_id);
  const paymentsByPledge = new Map<string, { date: number; cents: number }[]>();
  for (const p of raw.pledgePayments) {
    const list = paymentsByPledge.get(p.pledge_activity_id) ?? [];
    list.push({ date: p.payment_date, cents: p.applied_cents });
    paymentsByPledge.set(p.pledge_activity_id, list);
  }
  const paymentPlanByPledge = new Map(raw.paymentPlans.map((p) => [p.pledge_activity_id, p]));
  const factsByDonor = group(raw.relationshipFacts, (f) => f.donor_id);
  const ackByGiftId = new Set(raw.acknowledgments.filter((a) => a.gift_source === "giving_activity").map((a) => a.gift_id));
  const historicalContextDonorIds = new Set(raw.historicalContext.map((h) => h.donor_id));

  // Faithful reproduction of lib/workspace/live-data.ts's recentGiftByDonor:
  // category-agnostic, but requires activity_date within the trailing 30
  // days AND no completed interaction since -- feeds
  // evidence.mostRecentPaidGift (and therefore acknowledge_gift), never
  // the broader lifetime/period cash figures above.
  const contactAtByDonor = new Map<string, number>();
  for (const list of interactionsByDonor.values()) if (list[0]) contactAtByDonor.set(list[0].donor_id, list[0].occurred_at);
  const givingSortedByDateDesc = [...raw.giving].sort((a, b) => (b.activity_date ?? -Infinity) - (a.activity_date ?? -Infinity));
  const recentGiftByDonor = new Map<string, RawGivingRow>();
  for (const item of givingSortedByDateDesc) {
    const recent = item.activity_date != null && item.activity_date <= now && item.activity_date >= now - 30 * DAY;
    const contactedAfterGift = (contactAtByDonor.get(item.donor_id) ?? 0) >= (item.activity_date ?? 0);
    if ((item.paid_cents ?? 0) > 0 && recent && !contactedAfterGift && !recentGiftByDonor.has(item.donor_id)) recentGiftByDonor.set(item.donor_id, item);
  }

  const financialEventAmounts: number[] = [];
  for (const g of raw.giving) {
    if (g.category === "completed_gift" && (g.paid_cents ?? 0) > 0) financialEventAmounts.push(g.paid_cents!);
    else if (g.category === "open_pledge" || g.category === "partially_paid_pledge") financialEventAmounts.push((g.paid_cents ?? 0) + (g.balance_cents ?? 0));
  }

  const donorInputs: PortfolioFocusDonorInput[] = raw.donors.map((donor) => {
    const donorGiving = givingByDonor.get(donor.id) ?? [];
    const cashEvents = cashEventsForDonor(donorGiving, paymentsByPledge, now);
    const lifetimeCents = cashEvents.reduce((sum, e) => sum + e.cents, 0);
    const dated = cashEvents.filter((e) => e.date !== null);
    const last365Cents = dated.filter((e) => e.date! > now - 365 * DAY).reduce((s, e) => s + e.cents, 0);
    const prior365Cents = dated.filter((e) => e.date! <= now - 365 * DAY && e.date! > now - 730 * DAY).reduce((s, e) => s + e.cents, 0);
    const mostRecent = dated[0] ?? null;
    const daysSinceLastGift = mostRecent ? Math.floor((now - mostRecent.date!) / DAY) : null;
    const distinctActivityYears = new Set(dated.map((e) => new Date(e.date! * 1000).getUTCFullYear())).size;

    const commitmentRows = donorGiving.filter((g) => g.category === "open_pledge" || g.category === "partially_paid_pledge");
    const historicalPeakCommitmentCents = commitmentRows.length ? Math.max(...commitmentRows.map((g) => (g.paid_cents ?? 0) + (g.balance_cents ?? 0))) : null;
    const historicalPeakGiftCents = donorGiving.filter((g) => g.category === "completed_gift").reduce((max, g) => Math.max(max, g.paid_cents ?? 0), 0) || null;

    const openPledgeRow = donorGiving.filter((g) => (g.balance_cents ?? 0) > 0).sort((a, b) => (a.activity_date ?? 0) - (b.activity_date ?? 0))[0] ?? null;
    let openPledgeForEvidence: RecommendationEvidenceInput["openPledge"] = null;
    let pledgeAgeDays: number | null = null;
    let pledgeCommitmentAgeDays: number | null = null;
    let pledgePlanOnTrack: boolean | null = null;
    if (openPledgeRow) {
      const linkedPaymentDates = (paymentsByPledge.get(openPledgeRow.id) ?? []).map((p) => p.date);
      const plan = paymentPlanByPledge.get(openPledgeRow.id);
      const activityDate = resolveOpenPledgeActivityDate(openPledgeRow.activity_date, linkedPaymentDates);
      pledgeAgeDays = activityDate !== null ? Math.floor((now - activityDate) / DAY) : null;
      if (openPledgeRow.activity_date != null && openPledgeRow.activity_date <= now) pledgeCommitmentAgeDays = Math.floor((now - openPledgeRow.activity_date) / DAY);
      const activePaymentPlan: (PaymentPlanFields & { installmentAmountCents: number | null; linkedPaymentDates: number[] }) | null = plan
        ? { installmentAmountCents: plan.installment_amount_cents, finalExpectedPaymentAt: plan.final_expected_payment_at, expectedDayOfMonth: plan.expected_day_of_month, nextExpectedPaymentAt: plan.next_expected_payment_at, endedAt: null, linkedPaymentDates }
        : null;
      openPledgeForEvidence = { balanceCents: openPledgeRow.balance_cents ?? 0, campaign: null, description: openPledgeRow.description || openPledgeRow.item_type, activityDate, activePaymentPlan };
      if (activePaymentPlan) {
        const evaluation = evaluatePaymentPlan(activePaymentPlan, linkedPaymentDates, openPledgeRow.balance_cents ?? 0, now);
        pledgePlanOnTrack = !evaluation.isLate;
      }
    }

    const donorAsks = (asksByDonor.get(donor.id) ?? []).sort((a, b) => a.asked_at - b.asked_at);
    const pendingAsks = donorAsks.filter((a) => a.status === "pending");
    const oldestPendingAsk = pendingAsks[0] ?? null;
    let openAskForEvidence: RecommendationEvidenceInput["openAsk"] = null;
    if (oldestPendingAsk) {
      const donorReminders = remindersByDonor.get(donor.id) ?? [];
      const match = matchAskFollowUps([oldestPendingAsk.id], donorReminders.map((r) => ({ id: r.recommendation_id, dueAt: r.due_at })));
      openAskForEvidence = { id: oldestPendingAsk.id, amountCents: oldestPendingAsk.amount_cents, purpose: oldestPendingAsk.purpose, askedAt: oldestPendingAsk.asked_at, activeFollowUpDueAt: match.get(oldestPendingAsk.id)?.dueAt ?? null };
    }
    const pendingAskSourceInteractionIds = pendingAsks.map((a) => a.source_interaction_id).filter((x): x is string => x !== null);

    const donorInteractions = interactionsByDonor.get(donor.id) ?? [];
    const lastCompletedInteraction = donorInteractions[0] ?? null;
    const lastSubstantive = donorInteractions.find((i) => i.role !== "recipient") ?? null;

    const donorReminders = remindersByDonor.get(donor.id) ?? [];
    const openReminder = donorReminders[0] ?? null;

    let upcomingDateDescription: string | null = null;
    for (const y of yahrtzeitsByDonor.get(donor.id) ?? []) {
      const occ = nextYahrtzeitOccurrence(y.hebrew_month, y.hebrew_day, timezone, now);
      const daysUntil = Math.round((occ.primary.gregorianEpoch - now) / DAY);
      if (daysUntil >= 0 && daysUntil <= 30) { upcomingDateDescription = `yahrtzeit in ${daysUntil}d`; break; }
    }
    if (!upcomingDateDescription) {
      for (const d of importantDatesByDonor.get(donor.id) ?? []) {
        const occ = nextGregorianRecurrence(d.month, d.day, timezone, now);
        const daysUntil = Math.round((occ.primary.gregorianEpoch - now) / DAY);
        if (daysUntil >= 0 && daysUntil <= 30) { upcomingDateDescription = `${d.type} in ${daysUntil}d`; break; }
      }
    }

    const relationshipFacts: SynthesisFact[] = (factsByDonor.get(donor.id) ?? []).map((row) => ({
      factText: row.fact_text, category: row.category as SynthesisFact["category"], lifecycle: row.lifecycle as SynthesisFact["lifecycle"],
      status: row.status as SynthesisFact["status"], sourceInteractionId: row.source_interaction_id, sourceInteractionOccurredAt: row.source_interaction_occurred_at,
    }));
    const pinnedFresh = new Set(pendingAskSourceInteractionIds);
    const resolvedSnapshot = resolveRelationshipSnapshot(relationshipFacts, { relationshipSummary: donor.relationship_summary, institutionalMemory: donor.institutional_memory }, now, pinnedFresh);
    const mostActionableEngagement = findMostActionableFact(relationshipFacts, now, pinnedFresh, "engagement");
    const mostActionableSolicitation = findMostActionableFact(relationshipFacts, now, pinnedFresh, "solicitation");

    const recentGiftRow = recentGiftByDonor.get(donor.id) ?? null;
    const evidenceInput: RecommendationEvidenceInput = {
      donorId: donor.id,
      mostRecentPaidGift: recentGiftRow ? { giftSource: "giving_activity", giftId: recentGiftRow.id, amountCents: recentGiftRow.paid_cents ?? 0, occurredAt: recentGiftRow.activity_date!, campaign: null, description: recentGiftRow.description || recentGiftRow.item_type, acknowledged: ackByGiftId.has(recentGiftRow.id) } : null,
      openPledge: openPledgeForEvidence,
      lastCompletedInteraction: lastCompletedInteraction ? { type: lastCompletedInteraction.type, summary: "", occurredAt: lastCompletedInteraction.occurred_at } : null,
      lastContactAt: lastCompletedInteraction?.occurred_at ?? null,
      lastSubstantiveContactAt: lastSubstantive?.occurred_at ?? null,
      openReminder: openReminder ? { action: openReminder.action, reason: openReminder.reason, dueAt: openReminder.due_at } : null,
      openAsk: openAskForEvidence,
      relationshipSummary: donor.relationship_summary,
      institutionalMemory: donor.institutional_memory,
      historicalContext: [],
      yahrtzeits: [], importantDates: [],
      relationshipFacts,
      pendingAskSourceInteractionIds,
    };
    const evidence = buildRecommendationEvidence(evidenceInput, now, timezone);
    const recommendation = buildDonorRecommendation(evidence);

    const input: PortfolioFocusDonorInput = {
      donorId: donor.id, displayName: donor.display_name, donorCode: donor.donor_code,
      lifetimeCents, last365Cents, prior365Cents, distinctActivityYears,
      historicalPeakGiftCents, historicalPeakCommitmentCents,
      mostRecentCashKind: mostRecent ? (mostRecent.kind === "gift" ? "gift" : "pledge_payment") : null,
      mostRecentCashCents: mostRecent ? mostRecent.cents : null,
      daysSinceLastGift,
      openPledgeBalanceCents: openPledgeRow?.balance_cents ?? null,
      openPledgeTotalCents: openPledgeRow ? (openPledgeRow.paid_cents ?? 0) + (openPledgeRow.balance_cents ?? 0) : null,
      openPledgeCategory: (openPledgeRow?.category as "open_pledge" | "partially_paid_pledge" | undefined) ?? null,
      pledgeAgeDays, pledgeCommitmentAgeDays, pledgePlanOnTrack,
      askHistoryCount: donorAsks.length,
      hasOpenReminder: !!openReminder,
      openReminderAction: openReminder?.action ?? null,
      lastInteractionDaysAgo: lastCompletedInteraction ? Math.floor((now - lastCompletedInteraction.occurred_at) / DAY) : null,
      daysSinceSubstantiveContact: lastSubstantive ? Math.floor((now - lastSubstantive.occurred_at) / DAY) : null,
      hasCurrentFact: relationshipFacts.length > 0,
      hasActionableFact: !!(mostActionableEngagement || mostActionableSolicitation),
      hasUnconfirmedHistoricalContext: historicalContextDonorIds.has(donor.id),
      currentSnapshotSummary: resolvedSnapshot.relationshipSummary,
      upcomingDateDescription,
      recommendation: recommendation ? { kind: recommendation.kind, score: recommendation.score, action: recommendation.action } : null,
    };
    return input;
  });

  return { donorInputs, financialEventAmounts };
}
